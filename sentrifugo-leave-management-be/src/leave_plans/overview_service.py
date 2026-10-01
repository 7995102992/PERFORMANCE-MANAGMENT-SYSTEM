from collections import defaultdict

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.clients.iam_master_data import fetch_employment_statuses, fetch_employment_types
from src.employment_type import ELIGIBLE_EMPLOYMENT_TYPE_KEYS
from src.exceptions import DomainException
from src.logger import logger
from src.utils import to_oid


async def get_leave_plan_overview(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    *,
    bu_filter: list[str] | None = None,
    dept_filter: list[str] | None = None,
    status_filter: list[str] | None = None,
    include_employees: bool = False,
) -> dict:
    plan = await db["leave_plans"].find_one({"_id": to_oid(plan_id), "deleted_on": None})
    if not plan:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Source of truth is now the plan document itself — BUs, depts and leave
    # types are stored inline on `leave_plans`, not in the legacy
    # `leave_plan_assignments` / `leave_plan_type_mapping` collections.
    bu_ids = list(plan.get("business_unit_ids") or [])
    dept_ids = list(plan.get("department_ids") or [])

    if bu_filter:
        bu_filter_oids = {to_oid(bid) for bid in bu_filter}
        bu_ids = [bid for bid in bu_ids if bid in bu_filter_oids]
    if dept_filter:
        dept_filter_oids = {to_oid(did) for did in dept_filter}
        dept_ids = [did for did in dept_ids if did in dept_filter_oids]

    # Resolve employment-status ids → human-readable keys. Source of truth is
    # IAM's master_data API; the LMS-local `employment_statuses` collection
    # (populated by RabbitMQ domain events) is a fallback for when IAM is
    # unreachable. Employee.employment_status is stored as a string id, so
    # keys are normalised to strings on both sides.
    plan_org_id = str(plan.get("org_id")) if plan.get("org_id") is not None else None
    iam_statuses = await fetch_employment_statuses(organisation_id=plan_org_id)
    status_id_to_key: dict[str, str] = {
        sid: (info.get("key") or "unknown") for sid, info in iam_statuses.items()
    }
    # Human-readable label per status key (e.g. "permanent" → "Permanent").
    status_key_to_label: dict[str, str] = {}
    for _info in iam_statuses.values():
        _k = _info.get("key")
        if _k:
            status_key_to_label[_k] = (
                _info.get("value")
                or _info.get("label")
                or _info.get("name")
                or _k.replace("-", " ").replace("_", " ").title()
            )
    # Employment-status ids flagged inactive in IAM (exit / terminated / retired
    # / absconded). Used to drop leavers from the employee queries up front so
    # they never spawn a (possibly "Unknown") BU/Dept node in the tree.
    inactive_status_oids = [
        to_oid(sid)
        for sid, info in iam_statuses.items()
        if info.get("is_active", True) is False
    ]

    # Resolve employment-type ids and pre-compute the set of eligible ObjectIds.
    # Only employees whose employment_type key is in ELIGIBLE_EMPLOYMENT_TYPE_KEYS
    # (currently {"full-time"}) participate in leave allocation rollups. If the
    # type lookup is completely empty — Valkey, IAM HTTP and local Mongo all
    # failed — we fail open (no filter) rather than silently exclude everyone.
    iam_types = await fetch_employment_types(organisation_id=plan_org_id)
    if iam_types:
        eligible_type_oids: set | None = {
            to_oid(tid)
            for tid, info in iam_types.items()
            if info.get("key") in ELIGIBLE_EMPLOYMENT_TYPE_KEYS
        }
    else:
        logger.warning(
            "Could not fetch employment_types — skipping type-based eligibility filter",
            plan_id=plan_id,
        )
        eligible_type_oids = None

    bu_docs = {}
    if bu_ids:
        cursor = db["business_units"].find({"_id": {"$in": bu_ids}})
        async for doc in cursor:
            bu_docs[str(doc["_id"])] = doc

    dept_docs = {}
    if dept_ids:
        cursor = db["departments"].find({"_id": {"$in": dept_ids}})
        async for doc in cursor:
            dept_docs[str(doc["_id"])] = doc

    # The BU → Dept tree is derived from the employees that actually sit in
    # those depts, NOT from the departments' own BU links: a dept can be linked
    # to multiple BUs, so walking top-down (BU → dept → emps) would count every
    # employee of a shared dept once per linked BU. Each employee's own
    # (bu, dept) stamp becomes a node exactly once, splitting shared depts
    # across BUs correctly.
    bu_dept_map: dict[str, set] = defaultdict(set)
    employee_counts: dict[tuple[str, str], dict] = {}

    if dept_ids:
        and_clauses: list[dict] = []
        match_stage: dict = {
            "department_id": {"$in": dept_ids},
            "is_deleted": {"$ne": True},
        }
        # Restrict to the plan's own BUs. An employee whose dept is on the plan
        # but whose BU isn't one the plan selected (or who has no BU at all) is
        # out of scope for this plan and must not appear — that was the source of
        # the "Unknown" buckets. When the plan has no BUs we skip the restriction
        # rather than match zero employees.
        if bu_ids:
            match_stage["business_unit_id"] = {"$in": bu_ids}
        # Drop leavers (exit / terminated / retired / absconded) up front so a
        # dept staffed only by inactive employees never lingers in the tree.
        # Unknown / unset statuses are left to the display-layer filter below.
        if inactive_status_oids:
            match_stage["employment_status"] = {"$nin": inactive_status_oids}
        if eligible_type_oids:
            # Legacy employees joined before IAM started syncing employment_type
            # — their field is null or missing. Treat those as full-time so the
            # rollout doesn't silently drop the existing workforce. Once IAM
            # backfills, the $in branch starts matching real ids.
            and_clauses.append({
                "$or": [
                    {"employment_type": {"$in": list(eligible_type_oids)}},
                    {"employment_type": None},
                    {"employment_type": {"$exists": False}},
                ]
            })
        if and_clauses:
            match_stage["$and"] = and_clauses

        pipeline = [
            {"$match": match_stage},
            {
                "$group": {
                    "_id": {
                        "business_unit_id": "$business_unit_id",
                        "department_id": "$department_id",
                        "employment_status": "$employment_status",
                    },
                    "count": {"$sum": 1},
                }
            },
        ]
        agg_results = await db["employees"].aggregate(pipeline).to_list(length=None)

        for result in agg_results:
            bu_id_val = result["_id"].get("business_unit_id")
            dept_id_val = str(result["_id"]["department_id"])
            bu_id_str = str(bu_id_val) if bu_id_val else "unassigned"
            status_raw = result["_id"].get("employment_status")
            status_key = (
                status_id_to_key.get(str(status_raw), "unknown") if status_raw else "unknown"
            )
            count = result["count"]

            bu_dept_map[bu_id_str].add(dept_id_val)
            key = (bu_id_str, dept_id_val)
            if key not in employee_counts:
                employee_counts[key] = {"total": 0, "by_status": defaultdict(int)}
            employee_counts[key]["total"] += count
            employee_counts[key]["by_status"][status_key] += count

    # Ensure every dept selected on the plan appears in the tree, even if no
    # eligible employee currently sits in it. With no employee stamps to place
    # it by, fall back to the dept doc's own BU link (primary business_unit_id
    # first, then any linked BU the plan selected) — an empty dept contributes
    # zero to every rollup, so this can't double-count shared depts. Only a
    # dept with no plan-selected BU link at all lands in the synthetic
    # "unassigned" bucket.
    plan_bu_strs = {str(b) for b in bu_ids}
    referenced_depts = {d for depts in bu_dept_map.values() for d in depts}
    for dept_oid in dept_ids:
        dept_str = str(dept_oid)
        if dept_str in referenced_depts:
            continue
        dept_doc = dept_docs.get(dept_str) or {}
        linked_bus = [dept_doc.get("business_unit_id")] + list(
            dept_doc.get("business_unit_ids") or []
        )
        home_bu = next(
            (str(b) for b in linked_bus if b is not None and str(b) in plan_bu_strs),
            None,
        )
        bu_dept_map[home_bu or "unassigned"].add(dept_str)

    # Prefer the embedded grant_policy on the plan doc (new schema). Fall back
    # to the legacy leave_grant_policy collection so plans saved through the
    # older flow still render.
    grant_policy = None
    embedded_gp = plan.get("grant_policy") or None
    if embedded_gp:
        allocation = embedded_gp.get("allocation") or {}
        grant_policy = {
            "allocation_amount": allocation.get("amount"),
            "allocation_unit": allocation.get("unit"),
        }
    else:
        grant_policy_doc = await db["leave_grant_policy"].find_one(
            {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
        )
        if grant_policy_doc:
            allocation = grant_policy_doc.get("allocation") or {}
            grant_policy = {
                "allocation_amount": allocation.get("amount"),
                "allocation_unit": allocation.get("unit"),
            }

    entitlement_doc = await db["leave_entitlement_configurations"].find_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
    )
    distribution = None
    probation_config = None
    notice_period_config = None
    posting_cycle_map: dict[str, dict] = {}

    if entitlement_doc:
        ent = entitlement_doc.get("entitlement") or {}

        dist_config = ent.get("distribution") or {}
        if dist_config:
            distribution = {
                "mode": dist_config.get("mode"),
                "accrual_frequency": dist_config.get("accrual_frequency"),
            }

            distribution_mode = dist_config.get("mode", "all_at_once")
            accrual_frequency = dist_config.get("accrual_frequency")
            freq_divisors = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}

            for rule in dist_config.get("posting_cycles", []):
                lt_key = str(rule.get("leave_type_id", ""))
                if not lt_key:
                    continue
                # Each leave type accrues on its own frequency (falls back to the
                # plan-level value for legacy plans). For all_at_once the value is
                # already the annual amount, so the multiplier is 1.
                rule_freq = rule.get("accrual_frequency") or accrual_frequency
                freq_multiplier = (
                    1
                    if distribution_mode == "all_at_once"
                    else freq_divisors.get(rule_freq, 1)
                )
                posting_cycle_map[lt_key] = {
                    "annual": float(rule.get("value") or 0) * freq_multiplier,
                    "unit": rule.get("unit", "DAYS"),
                }

        prob_config = ent.get("probation") or {}
        if prob_config:
            probation_config = {
                "enabled": prob_config.get("enabled", False),
                "credit_mode": prob_config.get("credit_mode"),
                "probation_duration_months": prob_config.get("probation_duration_months"),
                "band_rules": prob_config.get("band_rules", []),
            }

        notice_config = ent.get("notice_period_leave") or {}
        if notice_config:
            notice_period_config = {
                "mode": notice_config.get("mode"),
            }

    # Prefer the embedded leave_type_ids on the plan doc, fall back to the
    # legacy leave_plan_type_mapping collection.
    leave_type_ids = list(plan.get("leave_type_ids") or [])
    if not leave_type_ids:
        type_mappings = await db["leave_plan_type_mapping"].find(
            {"leave_plan_id": to_oid(plan_id)}
        ).to_list(length=None)
        leave_type_ids = [m["leave_type_id"] for m in type_mappings]

    leave_types = []
    if leave_type_ids:
        lt_docs = await db["leave_types"].find(
            {"_id": {"$in": leave_type_ids}, "deleted_on": None}
        ).to_list(length=None)
        lt_map = {str(doc["_id"]): doc["name"] for doc in lt_docs}
        lt_doc_map = {str(doc["_id"]): doc for doc in lt_docs}

        def _lt_annual(doc: dict):
            """Annual leaves this type allocates, in its own unit. The leave type
            owns its allocation now (accrual.annual_count); statutory types use
            max_statutory_days. Returns None when neither is configured."""
            acc = doc.get("accrual") or {}
            cnt = acc.get("annual_count")
            if cnt is not None:
                return float(cnt)
            if doc.get("is_statutory_leave") and doc.get("max_statutory_days") is not None:
                return float(doc["max_statutory_days"])
            return None

        def _lt_row(lt_id) -> dict:
            doc = lt_doc_map[str(lt_id)]
            acc = doc.get("accrual") or {}
            return {
                "id": str(lt_id),
                "name": lt_map[str(lt_id)],
                "unit": doc.get("unit", "DAYS"),
                "is_statutory": bool(doc.get("is_statutory_leave", False)),
                "is_paid": bool(doc.get("is_paid_leave", True)),
                "annual_allocated": _lt_annual(doc),
                "accrual_frequency": acc.get("accrual_frequency"),
                "carry_forward": bool(acc.get("carry_forward")),
                "carry_forward_count": acc.get("carry_forward_count"),
                "encashable": bool(acc.get("encashable")),
                "encash_percentage": acc.get("encash_percentage"),
            }

        leave_types = [
            _lt_row(lt_id)
            for lt_id in leave_type_ids
            if str(lt_id) in lt_map
        ]

        # The leave type now owns its allocation — annual_count is the annual
        # amount in the type's own unit. It takes precedence over the legacy
        # plan posting cycles built above.
        for doc in lt_docs:
            acc = doc.get("accrual") or {}
            cnt = acc.get("annual_count")
            if cnt is not None:
                posting_cycle_map[str(doc["_id"])] = {
                    "annual": float(cnt),
                    "unit": doc.get("unit", "DAYS"),
                }

        # Strip statutory leave types from allocation totals
        statutory_lt_ids = {
            str(doc["_id"]) for doc in lt_docs if doc.get("is_statutory_leave", False)
        }
        for lt_id in statutory_lt_ids:
            posting_cycle_map.pop(lt_id, None)
    else:
        statutory_lt_ids = set()

    non_statutory_count = sum(1 for lt in leave_types if lt["id"] not in statutory_lt_ids)

    grant_annual = float(grant_policy["allocation_amount"]) if grant_policy and grant_policy.get("allocation_amount") is not None else None
    grant_unit = grant_policy.get("allocation_unit", "DAYS") if grant_policy else "DAYS"

    def _per_employee_total() -> float:
        return sum(
            pc["annual"] for pc in posting_cycle_map.values()
        ) if posting_cycle_map else (grant_annual or 0.0) * non_statutory_count
    base_per_employee_annual = (
        sum(pc["annual"] for pc in posting_cycle_map.values())
        if posting_cycle_map
        else (grant_annual or 0.0) * len(leave_types)
    )

    # Map IAM status key -> is_active flag so we can zero out leaving statuses
    # (absconded / exit / retired / terminated) without hard-coding them here.
    status_active_flag: dict[str, bool] = {}
    for info in iam_statuses.values():
        key = info.get("key")
        if key:
            status_active_flag[key] = bool(info.get("is_active", True))
    # Treat unresolvable status ids ("unknown") the same as a leaving status:
    # hidden from headcounts, the FE dropdown, the export column, and any
    # allocation rollups — stale data should not surface in the admin UI.
    status_active_flag["unknown"] = False

    def _probation_annual() -> float:
        """Yearly allocation an employee in probation receives. Mirrors the
        processor's logic so the overview reflects what credits will actually
        post.

        Each band only fires while the employee is inside its month range, so
        its annual contribution is weighted by (band_months / 12). Any months
        outside the probation window accrue at the base (non-probation) rate.
        """
        if not probation_config or not probation_config.get("enabled"):
            return base_per_employee_annual
        credit_mode = probation_config.get("credit_mode")
        if credit_mode == "same_for_all":
            return base_per_employee_annual

        # tiered_by_duration: weight each band by its own duration, capped at
        # the configured probation_duration_months. Months past probation
        # revert to the base accrual.
        bands = probation_config.get("band_rules") or []
        if not bands:
            return 0.0

        probation_months_raw = probation_config.get("probation_duration_months")
        try:
            probation_months = int(probation_months_raw) if probation_months_raw is not None else 12
        except (TypeError, ValueError):
            probation_months = 12
        probation_months = max(0, min(probation_months, 12))

        # Mirror the engine EXACTLY (processor._probation_check): it fires once per
        # integer months_in_service and credits the FIRST band whose half-open range
        # [from_month, to_month) covers that month. Walk each month of the probation
        # window and attribute it to its first matching band, so adjacent/overlapping
        # bands credit each month exactly once and the projection equals what the
        # cron actually posts (P4, matching the P2 half-open engine fix).
        probation_total = 0.0
        for m in range(0, probation_months):
            for band in bands:
                try:
                    from_m = int(band.get("from_month") or 0)
                    to_m = int(band.get("to_month") or 0)
                except (TypeError, ValueError):
                    continue
                if from_m <= m < to_m:
                    probation_total += float(band.get("credit_amount") or 0)
                    break

        # Post-probation months accrue at the regular rate.
        post_probation_months = 12 - probation_months
        post_probation_total = base_per_employee_annual * (post_probation_months / 12.0)

        return probation_total + post_probation_total

    def _per_employee_allocation_for_status(status_key: str) -> float:
        """Apply leave-plan rules to derive the allocation for one employee in
        the given status. Falls back to the base allocation for statuses with
        no special rule."""
        # Leaving statuses (is_active=false in IAM master_data) receive no new
        # credits — covers absconded / exit / retired / terminated, plus the
        # synthetic "unknown" bucket for stale status ids.
        if status_active_flag.get(status_key) is False:
            return 0.0
        if status_key == "probation":
            return _probation_annual()
        return base_per_employee_annual

    business_units_result = []
    total_employees = 0
    # Plan-wide headcount by employment status (active statuses only — inactive
    # ones are already filtered out of the employee match upstream).
    status_totals: dict[str, int] = defaultdict(int)
    # A dept can show up under multiple BUs when its employees are split
    # across BUs, so dedupe across buckets when counting departments.
    distinct_dept_ids: set[str] = set()
    grand_total_allocated = 0.0
    grand_allocated_by_type: dict[str, float] = defaultdict(float)

    for bu_id_str, dept_id_strs in bu_dept_map.items():
        bu_doc = bu_docs.get(bu_id_str)
        if bu_doc:
            bu_name = bu_doc["name"]
        elif bu_id_str == "unassigned":
            bu_name = "Unassigned"
        else:
            bu_name = "Unknown"

        departments_result = []
        bu_total = 0
        bu_by_status: dict[str, int] = defaultdict(int)
        bu_total_allocated = 0.0
        bu_allocated_by_type: dict[str, float] = defaultdict(float)

        for dept_id_str in dept_id_strs:
            dept_doc = dept_docs.get(dept_id_str)
            dept_name = dept_doc["name"] if dept_doc else "Unknown"

            dept_counts = employee_counts.get(
                (bu_id_str, dept_id_str), {"total": 0, "by_status": {}}
            )
            dept_by_status_raw = dept_counts.get("by_status", {})
            dept_by_status = {
                s: c for s, c in dept_by_status_raw.items()
                if status_active_flag.get(s) is not False
                and (not status_filter or s in status_filter)
            }
            dept_active_total = sum(dept_by_status.values())

            bu_total += dept_active_total
            for s_key, s_count in dept_by_status.items():
                bu_by_status[s_key] += s_count
                status_totals[s_key] += s_count

            dept_allocated_by_type = {
                s: _per_employee_allocation_for_status(s) * c
                for s, c in dept_by_status.items()
            }
            dept_total_allocated = sum(dept_allocated_by_type.values())

            bu_total_allocated += dept_total_allocated
            grand_total_allocated += dept_total_allocated
            for s, v in dept_allocated_by_type.items():
                bu_allocated_by_type[s] += v

            departments_result.append({
                "id": dept_id_str,
                "name": dept_name,
                "employee_counts": {
                    "total": dept_active_total,
                    "by_status": dict(dept_by_status),
                },
                "total_leaves_allocated": dept_total_allocated,
                "leaves_allocated_by_employee_type": dept_allocated_by_type,
            })

        total_employees += bu_total
        distinct_dept_ids.update(dept_id_strs)
        for s, v in bu_allocated_by_type.items():
            grand_allocated_by_type[s] += v

        business_units_result.append({
            "id": bu_id_str,
            "name": bu_name,
            "departments": departments_result,
            "employee_counts": {
                "total": bu_total,
                "by_status": dict(bu_by_status),
            },
            "total_leaves_allocated": bu_total_allocated,
            "leaves_allocated_by_employee_type": dict(bu_allocated_by_type),
        })

    employees_breakdown: list[dict] = []
    if include_employees and dept_ids:
        non_statutory_lts = [lt for lt in leave_types if lt["id"] not in statutory_lt_ids]

        def _per_employee_breakdown_by_lt(status_key: str) -> dict[str, float]:
            """Per-leave-type annual allocation for one employee, keyed by lt_id.

            Sum across leave types equals _per_employee_allocation_for_status,
            so per-row totals reconcile with the BU/Dept rollup.
            """
            if status_active_flag.get(status_key) is False:
                return {lt["id"]: 0.0 for lt in leave_types}
            if status_key == "probation":
                total = _probation_annual()
                per_lt = (total / len(non_statutory_lts)) if non_statutory_lts else 0.0
                return {
                    lt["id"]: 0.0 if lt["id"] in statutory_lt_ids else per_lt
                    for lt in leave_types
                }
            out: dict[str, float] = {}
            for lt in leave_types:
                if lt["id"] in statutory_lt_ids:
                    out[lt["id"]] = 0.0
                elif lt["id"] in posting_cycle_map:
                    out[lt["id"]] = float(posting_cycle_map[lt["id"]]["annual"])
                else:
                    out[lt["id"]] = float(grant_annual or 0.0)
            return out

        emp_and_clauses: list[dict] = []
        emp_match: dict = {
            "department_id": {"$in": dept_ids},
            "is_deleted": {"$ne": True},
        }
        # Mirror the rollup scope so the employee sheet stays consistent with the
        # BU/Dept tree: restrict to the plan's BUs and drop leavers up front.
        # Unknown/unset statuses are still skipped per-row below.
        if bu_ids:
            emp_match["business_unit_id"] = {"$in": bu_ids}
        if inactive_status_oids:
            emp_match["employment_status"] = {"$nin": inactive_status_oids}
        if eligible_type_oids:
            # Same legacy-data fallback as the rollup match_stage: include
            # employees with eligible employment_type OR null / missing field.
            emp_and_clauses.append({
                "$or": [
                    {"employment_type": {"$in": list(eligible_type_oids)}},
                    {"employment_type": None},
                    {"employment_type": {"$exists": False}},
                ]
            })
        if emp_and_clauses:
            emp_match["$and"] = emp_and_clauses

        emp_projection = {
            "_id": 1,
            "emp_code": 1,
            "name": 1,
            "first_name": 1,
            "last_name": 1,
            "work_email": 1,
            "department_id": 1,
            "business_unit_id": 1,
            "employment_status": 1,
            "date_of_joining": 1,
            "joining_date": 1,
        }
        emp_cursor = db["employees"].find(emp_match, emp_projection)

        async for emp in emp_cursor:
            status_raw = emp.get("employment_status")
            status_key = (
                status_id_to_key.get(str(status_raw), "unknown") if status_raw else "unknown"
            )
            # Match the rollup: drop inactive (terminated/exit/retired/absconded)
            # and unknown employees so the employee sheet stays consistent with
            # the BU/Dept totals.
            if status_active_flag.get(status_key) is False:
                continue
            if status_filter and status_key not in status_filter:
                continue

            dept_id_str = (
                str(emp.get("department_id")) if emp.get("department_id") else None
            )
            bu_id_str = (
                str(emp.get("business_unit_id")) if emp.get("business_unit_id") else None
            )
            dept_name = (
                dept_docs[dept_id_str]["name"]
                if dept_id_str and dept_id_str in dept_docs
                else "—"
            )
            bu_name = (
                bu_docs[bu_id_str]["name"]
                if bu_id_str and bu_id_str in bu_docs
                else "Unassigned"
            )

            joining = emp.get("date_of_joining") or emp.get("joining_date")
            joining_str = (
                joining.date().isoformat()
                if hasattr(joining, "date")
                else (joining.isoformat() if hasattr(joining, "isoformat") else (str(joining) if joining else None))
            )

            full_name = (
                emp.get("name")
                or f"{emp.get('first_name', '') or ''} {emp.get('last_name', '') or ''}".strip()
                or "—"
            )

            alloc_by_lt_id = _per_employee_breakdown_by_lt(status_key)
            allocation_by_leave_type = {
                lt["name"]: alloc_by_lt_id.get(lt["id"], 0.0) for lt in leave_types
            }
            total_days = sum(alloc_by_lt_id.values())

            employees_breakdown.append({
                "emp_code": emp.get("emp_code") or "",
                "name": full_name,
                "email": emp.get("work_email") or "",
                "date_of_joining": joining_str,
                "business_unit_name": bu_name,
                "department_name": dept_name,
                "status_key": status_key,
                "total_days_allocated": total_days,
                "allocation_by_leave_type": allocation_by_leave_type,
            })

        employees_breakdown.sort(
            key=lambda e: (e["business_unit_name"], e["department_name"], e["name"])
        )

    response = {
        "plan_id": str(plan["_id"]),
        "plan_name": plan.get("name"),
        "calendar_start_month": plan.get("calendar_start_month"),
        "grant_policy": grant_policy,
        "distribution": distribution,
        "probation_config": probation_config,
        "notice_period_config": notice_period_config,
        "leave_types": leave_types,
        "business_units": business_units_result,
        "employment_status_counts": [
            {
                "key": s,
                "label": status_key_to_label.get(s, s.replace("-", " ").replace("_", " ").title()),
                "count": c,
            }
            for s, c in sorted(status_totals.items(), key=lambda kv: (-kv[1], kv[0]))
            if s != "unknown"
        ],
        "totals": {
            "total_employees": total_employees,
            "total_departments": len(distinct_dept_ids),
            # Synthetic buckets ("unassigned") are display-only — never count
            # them as business units.
            "total_business_units": sum(
                1 for bu in business_units_result if bu["id"] != "unassigned"
            ),
            "total_leaves_allocated": grand_total_allocated,
            "leaves_allocated_by_employee_type": dict(grand_allocated_by_type),
        },
    }
    if include_employees:
        response["employees"] = employees_breakdown
    return response
