from datetime import date, datetime, timedelta, timezone

from bson import ObjectId
from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.clients.iam_master_data import fetch_employment_statuses
from src.employment_status import deactivated_user_ids
from src.exceptions import DomainException
from src.leave_requests.service import (
    REQUESTS_COLLECTION,
    approve_leave_request,
    cancel_approved_leave_request,
    enrich_aging,
    get_leave_request,
    get_leave_request_detail,
    reject_leave_request,
)
from src.leave_plan_assignments.service import resolve_employee_plan
from src.leave_requests.schemas import ApprovalActionPayload, CancellationActionPayload
from src.utils import to_oid


# Same conversion the dashboard / balance processor use.
HOURS_PER_DAY = 8.0


def _first_last(doc: dict) -> str:
    """First + last name from an employee or user doc, blank when absent.

    Callers must try the employee mirror before the users doc: the users
    replica only stores account-lifecycle fields for most records, and a
    name-less users doc shadowing the employee record is what surfaces raw
    ObjectIds / emails in the UI.
    """
    first = (doc.get("first_name") or "").strip()
    last = (doc.get("last_name") or "").strip()
    return f"{first} {last}".strip()


# Projection every display-name lookup needs. emp_code is the last human-readable
# identifier before the raw id, so it must be selected wherever _display_name runs.
NAME_FIELDS = {
    "user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1,
    "name": 1, "work_email": 1, "emp_code": 1,
}


def _display_name(emp: dict, user: dict, uid: str) -> str:
    """Best human-readable label for an employee, in descending preference.

    Employee mirror first, then the users replica, then email, then the employee
    code. A raw ObjectId is the last resort and means the record carries no
    name, no email and no code — surfacing "CEN-28" beats surfacing
    "6a66f753e4dec9733eb3fbd0" on a manager's screen.
    """
    return (
        _first_last(emp) or _first_last(user)
        or emp.get("full_name") or emp.get("name")
        or user.get("full_name") or user.get("name")
        or emp.get("work_email") or user.get("email")
        or emp.get("emp_code")
        or uid
    )


async def _manager_refs(db: AsyncIOMotorDatabase, manager_user_id: str) -> list[ObjectId]:
    """Return all ObjectIds that could identify this manager in the employees collection.

    l1_manager_id / l2_manager_id may store either the manager's user_id ObjectId
    or their employee document _id. We return both so callers can match either.
    """
    mgr_oid = ObjectId(manager_user_id)
    refs = [mgr_oid]
    emp = await db["employees"].find_one(
        {"user_id": mgr_oid, "is_deleted": {"$ne": True}},
        {"_id": 1},
    )
    if emp and emp["_id"] != mgr_oid:
        refs.append(emp["_id"])
    return refs


async def _get_managed_user_ids(db: AsyncIOMotorDatabase, manager_user_id: str) -> list[ObjectId]:
    """Return user_id ObjectIds of all employees reporting to manager_user_id.

    Includes inactive employees on purpose so a manager can still act on
    pending leave requests filed by someone who has since been
    terminated / put on exit. Use ``_active_managed_roster`` for
    headcount / availability / calendar surfaces where ex-employees
    should not appear.
    """
    refs = await _manager_refs(db, manager_user_id)
    cursor = db["employees"].find(
        {
            "$or": [
                {"l1_manager_id": {"$in": refs}},
                {"l2_manager_id": {"$in": refs}},
            ],
            "is_deleted": {"$ne": True},
        },
        {"user_id": 1},
    )
    docs = await cursor.to_list(length=None)
    return [doc["user_id"] for doc in docs if "user_id" in doc]


async def _managed_levels_map(
    db: AsyncIOMotorDatabase, manager_user_id: str
) -> dict[str, set[int]]:
    """Map ``str(user_id)`` -> the approval levels this manager occupies for
    that employee: ``{1}`` when L1, ``{2}`` when L2, ``{1, 2}`` when both
    (small teams where the same person fills both slots).

    Leave-request surfaces need the level, not just membership: a plan whose
    approval policy configures a single level never routes to L2, so an L2-only
    manager must not see or act on its requests. See ``_plan_max_levels``.
    """
    refs = await _manager_refs(db, manager_user_id)
    ref_strs = {str(r) for r in refs}
    cursor = db["employees"].find(
        {
            "$or": [
                {"l1_manager_id": {"$in": refs}},
                {"l2_manager_id": {"$in": refs}},
            ],
            "is_deleted": {"$ne": True},
        },
        {"user_id": 1, "l1_manager_id": 1, "l2_manager_id": 1},
    )
    levels: dict[str, set[int]] = {}
    for doc in await cursor.to_list(length=None):
        uid = doc.get("user_id")
        if not uid:
            continue
        at: set[int] = set()
        if str(doc.get("l1_manager_id")) in ref_strs:
            at.add(1)
        if str(doc.get("l2_manager_id")) in ref_strs:
            at.add(2)
        if at:
            levels.setdefault(str(uid), set()).update(at)
    return levels


async def _plan_max_levels(db: AsyncIOMotorDatabase, plan_ids) -> dict[str, int]:
    """Map ``str(leave_plan_id)`` -> the highest approval level the plan configures.

    Plans with no approval policy — or a policy that declares no levels — default
    to 1. That mirrors ``_get_all_approvers_info``, which only emails the L2
    manager when the policy actually declares a second level; without the same
    default here an L2 would see requests they were never notified about.

    leave_requests may store leave_plan_id as an ObjectId or as its string form,
    while leave_approval_policies always stores an ObjectId — hence the keying
    by ``str(...)`` on both sides.
    """
    oid_by_key: dict[str, ObjectId] = {}
    for pid in plan_ids:
        key = str(pid) if pid else ""
        if not key or key in oid_by_key:
            continue
        try:
            oid = to_oid(pid)
        except Exception:
            continue
        if oid is not None:
            oid_by_key[key] = oid
    if not oid_by_key:
        return {}
    policies = await db["leave_approval_policies"].find(
        {"leave_plan_id": {"$in": list(set(oid_by_key.values()))}},
        {"leave_plan_id": 1, "approval_levels": 1},
    ).to_list(length=None)
    max_by_oid = {
        str(p["leave_plan_id"]): max(
            (lvl.get("level", 0) for lvl in (p.get("approval_levels") or [])),
            default=1,
        )
        or 1
        for p in policies
    }
    return {key: max_by_oid.get(str(oid), 1) for key, oid in oid_by_key.items()}


def _level_allows(levels: set[int] | None, plan_max_level: int) -> bool:
    """True when a manager sitting at ``levels`` is part of the plan's approval
    chain. L1 always is; L2 only once the plan configures a second level."""
    if not levels:
        return False
    if 1 in levels:
        return True
    return plan_max_level >= 2


async def _restrict_roster_to_approval_chain(
    db: AsyncIOMotorDatabase,
    user_ids: list,
    levels_by_user: dict[str, set[int]],
    org_id: str | None,
) -> list:
    """Drop employees the caller only reaches as L2 when their leave plan
    configures a single approval level.

    The team surfaces mirror the approval chain: if no plan of theirs ever routes
    to you, they are not your concern, and leaving them on the roster while
    hiding their leave would report them as *available* on a day they are out.

    Plan resolution reuses ``resolve_employee_plan`` (scope priority
    DEPARTMENT > BU > ORG) and is cached per (department, business unit) — every
    employee in the same scope resolves to the same plan, so a team of any size
    costs a handful of lookups. An unresolvable plan counts as single-level,
    matching the default in ``_plan_max_levels``.
    """
    l2_only = [uid for uid in user_ids if levels_by_user.get(str(uid)) == {2}]
    if not l2_only:
        return user_ids
    if not org_id:
        # Plan resolution is org-scoped; with no org we cannot show the plan
        # routes to L2, so apply the same default an unconfigured plan gets.
        dropped = {str(uid) for uid in l2_only}
        return [uid for uid in user_ids if str(uid) not in dropped]

    emp_docs = await db["employees"].find(
        {"user_id": {"$in": [to_oid(uid) for uid in l2_only]}},
        {"user_id": 1, "department_id": 1, "business_unit_id": 1},
    ).to_list(length=None)
    scope_by_user = {
        str(e["user_id"]): (e.get("department_id"), e.get("business_unit_id"))
        for e in emp_docs
        if e.get("user_id")
    }

    plan_by_scope: dict[tuple, object] = {}
    max_level_by_plan: dict[str, int] = {}
    dropped: set[str] = set()
    for uid in l2_only:
        scope = scope_by_user.get(str(uid), (None, None))
        if scope not in plan_by_scope:
            resolved = await resolve_employee_plan(
                db,
                str(uid),
                org_id,
                department_id=str(scope[0]) if scope[0] else None,
                business_unit_id=str(scope[1]) if scope[1] else None,
            )
            plan_by_scope[scope] = resolved.get("leave_plan_id") if resolved else None
        plan_id = plan_by_scope[scope]
        plan_key = str(plan_id) if plan_id else ""
        if plan_key and plan_key not in max_level_by_plan:
            max_level_by_plan.update(await _plan_max_levels(db, [plan_id]))
        if max_level_by_plan.get(plan_key, 1) < 2:
            dropped.add(str(uid))
    return [uid for uid in user_ids if str(uid) not in dropped]


async def _active_managed_roster(
    db: AsyncIOMotorDatabase, manager_user_id: str, *, org_id: str | None = None
) -> tuple[list[ObjectId], dict[str, set[int]]]:
    """Return ``(user_ids, levels_by_user)`` for the caller's current team.

    Like ``_get_managed_user_ids`` but drops employees whose employment_status is
    marked inactive in IAM (absconded / exit / retired / terminated), and — per
    ``_restrict_roster_to_approval_chain`` — employees reachable only as L2 whose
    leave plan configures a single approval level. Intended for team-view
    surfaces where the user expects "current team" semantics. If IAM is
    unreachable the inactive set is empty and we fall through to the unfiltered
    list.
    """
    refs = await _manager_refs(db, manager_user_id)
    ref_strs = {str(r) for r in refs}
    iam_statuses = await fetch_employment_statuses(organisation_id=org_id)
    inactive_status_ids = [
        sid for sid, info in iam_statuses.items()
        if info.get("is_active") is False
    ]
    query: dict = {
        "$or": [
            {"l1_manager_id": {"$in": refs}},
            {"l2_manager_id": {"$in": refs}},
        ],
        "is_deleted": {"$ne": True},
    }
    if inactive_status_ids:
        # The replica stores employment_status as ObjectId while IAM returns
        # string ids — match both forms (mirrors filter_active_user_ids).
        query["employment_status"] = {
            "$nin": [to_oid(sid) for sid in inactive_status_ids] + inactive_status_ids
        }
    cursor = db["employees"].find(
        query, {"user_id": 1, "l1_manager_id": 1, "l2_manager_id": 1}
    )
    docs = await cursor.to_list(length=None)
    user_ids = [doc["user_id"] for doc in docs if "user_id" in doc]
    levels_by_user: dict[str, set[int]] = {}
    for doc in docs:
        uid = doc.get("user_id")
        if not uid:
            continue
        at: set[int] = set()
        if str(doc.get("l1_manager_id")) in ref_strs:
            at.add(1)
        if str(doc.get("l2_manager_id")) in ref_strs:
            at.add(2)
        if at:
            levels_by_user.setdefault(str(uid), set()).update(at)
    # Also honour the USER-account lifecycle (soft-deleted / exit-stamped) —
    # an ended user must not count as team even if the employee record is stale.
    dead = await deactivated_user_ids(db, user_ids)
    user_ids = [u for u in user_ids if to_oid(u) not in dead]
    user_ids = await _restrict_roster_to_approval_chain(
        db, user_ids, levels_by_user, org_id
    )
    return user_ids, levels_by_user



async def _request_plan_hr_flag(
    db: AsyncIOMotorDatabase, request_doc: dict, capability: str
) -> bool:
    """Return the request's plan-level HR toggle for the given capability.

    ``capability`` is "act" (allow_hr_to_act) or "view" (allow_hr_to_view).
    """
    plan_id = request_doc.get("leave_plan_id")
    if not plan_id:
        return False
    field = "allow_hr_to_act" if capability == "act" else "allow_hr_to_view"
    policy = await db["leave_approval_policies"].find_one({"leave_plan_id": to_oid(plan_id)})
    return bool(policy and policy.get(field))


async def _hr_plan_id_variants(
    db: AsyncIOMotorDatabase, org_id: str | None, capability: str
) -> list:
    """Return leave_plan_id values (both ObjectId and str forms) for plans in
    ``org_id`` whose approval policy enables the HR capability.

    Both forms are returned because leave_requests may store leave_plan_id as a
    string while approval policies store it as an ObjectId.
    """
    if not org_id:
        return []
    field = "allow_hr_to_act" if capability == "act" else "allow_hr_to_view"
    plans = await db["leave_plans"].find(
        {"org_id": to_oid(org_id), "deleted_on": None}, {"_id": 1}
    ).to_list(length=None)
    plan_oids = [p["_id"] for p in plans]
    if not plan_oids:
        return []
    policies = await db["leave_approval_policies"].find(
        {"leave_plan_id": {"$in": plan_oids}, field: True}, {"leave_plan_id": 1}
    ).to_list(length=None)
    variants: list = []
    for p in policies:
        pid = p["leave_plan_id"]
        variants.extend([pid, str(pid)])
    return variants


async def _filter_to_approval_chain(
    db: AsyncIOMotorDatabase,
    docs: list[dict],
    levels_by_user: dict[str, set[int]],
    hr_plan_variants: list,
) -> list[dict]:
    """Drop requests whose approval chain the caller is not part of.

    A manager reaches an employee's request as that employee's L1 or L2. Whether
    L2 is actually in the loop is a per-plan decision (``approval_levels`` on the
    plan's approval policy), so the filter runs per request rather than per
    employee — the same manager may be an in-loop L2 on a two-level plan and out
    of the loop on a single-level one.

    Requests pulled in by the HR plan-level toggle are kept as-is: that grant is
    plan-flag driven and independent of the reporting chain.
    """
    if not docs:
        return docs
    hr_variant_keys = {str(v) for v in hr_plan_variants}
    plan_max = await _plan_max_levels(db, {d.get("leave_plan_id") for d in docs})
    kept = []
    for doc in docs:
        plan_key = str(doc.get("leave_plan_id") or "")
        if _level_allows(levels_by_user.get(str(doc.get("user_id") or "")), plan_max.get(plan_key, 1)):
            kept.append(doc)
        elif plan_key in hr_variant_keys:
            kept.append(doc)
    return kept


async def _enrich_request_display_fields(
    db: AsyncIOMotorDatabase, docs: list[dict]
) -> None:
    """Stamp employee_first/last/name/email and leave_type_name onto request docs.

    The manager list surfaces render these directly — without them the FE falls
    back to showing raw ObjectIds.
    """
    if not docs:
        return

    user_ids = list({d["user_id"] for d in docs if d.get("user_id")})
    emp_docs = await db["employees"].find(
        {"user_id": {"$in": user_ids}},
        {
            "user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1,
            "name": 1, "work_email": 1, "email": 1,
            "emp_code": 1, "designation_id": 1,
        },
    ).to_list(length=None)
    emp_map = {str(e["user_id"]): e for e in emp_docs}

    # Designation names from the LMS mirror — the FE's journey-based lookup
    # misses L2 reports (the journey walks only the L1 graph), so the listing
    # carries them itself.
    desg_ids = list({e["designation_id"] for e in emp_docs if e.get("designation_id")})
    desg_docs = await db["designations"].find(
        {"_id": {"$in": desg_ids}}, {"name": 1}
    ).to_list(length=None) if desg_ids else []
    desg_name_map = {str(d["_id"]): d.get("name") for d in desg_docs}

    user_docs = await db["users"].find(
        {"_id": {"$in": user_ids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1, "avatar_url": 1},
    ).to_list(length=None)
    user_map = {str(u["_id"]): u for u in user_docs}

    lt_ids = list({d["leave_type_id"] for d in docs if d.get("leave_type_id")})
    lt_docs = await db["leave_types"].find(
        {"_id": {"$in": lt_ids}},
        {"name": 1, "accrual.annual_count": 1, "deduct_from_balance": 1},
    ).to_list(length=None)
    lt_name_map = {str(lt["_id"]): lt.get("name", "") for lt in lt_docs}
    lt_annual_map = {
        str(lt["_id"]): (lt.get("accrual") or {}).get("annual_count")
        for lt in lt_docs
    }
    lt_deducting = {
        str(lt["_id"]): lt.get("deduct_from_balance", True) for lt in lt_docs
    }

    # Remaining balance per (user, leave type) for the Balance column — the
    # tracker is the live source the balance endpoints read too.
    tracker_docs = await db["leave_employee_balance_tracker"].find(
        {"user_id": {"$in": user_ids}},
        {"user_id": 1, "leave_type_id": 1, "balance_hours": 1},
    ).to_list(length=None)
    balance_map = {
        (str(t["user_id"]), str(t["leave_type_id"])): t.get("balance_hours", 0.0)
        for t in tracker_docs
    }

    # The employee's own credited total per type ("X of Y left" denominator).
    # The leave type's accrual.annual_count is a master-data figure that
    # ignores proration / plan grants / carry-forward — an employee granted 8
    # days would otherwise read "4 of 12 left". Summed across plans, same as
    # the employee dashboard's "Entitled".
    # employee_leave_balances is keyed by the employees-mirror _id (see the
    # balance processor), not the user id the requests carry — map back
    # through emp_docs; accept either id so older rows still resolve.
    emp_id_to_uid = {
        str(e["_id"]): str(e["user_id"]) for e in emp_docs if e.get("user_id")
    }
    balance_owner_ids = [to_oid(u) for u in user_ids] + [e["_id"] for e in emp_docs]
    entitled_docs = await db["employee_leave_balances"].find(
        {"employee_id": {"$in": balance_owner_ids}},
        {"employee_id": 1, "leave_type_id": 1, "total_credited": 1},
    ).to_list(length=None)
    entitled_map: dict[tuple[str, str], float] = {}
    for b in entitled_docs:
        owner = str(b["employee_id"])
        key = (emp_id_to_uid.get(owner, owner), str(b["leave_type_id"]))
        entitled_map[key] = entitled_map.get(key, 0.0) + (b.get("total_credited") or 0.0)

    for req in docs:
        uid = str(req.get("user_id") or "")
        emp = emp_map.get(uid) or {}
        user = user_map.get(uid) or {}
        src = emp if _first_last(emp) else (user if _first_last(user) else (emp or user))
        first = (src.get("first_name") or "").strip() or None
        last = (src.get("last_name") or "").strip() or None
        full = (
            " ".join(p for p in (first, last) if p)
            or emp.get("full_name") or emp.get("name")
            or user.get("full_name") or user.get("name")
        )
        req["employee_first_name"] = first
        req["employee_last_name"] = last
        req["employee_email"] = emp.get("work_email") or emp.get("email") or user.get("email")
        # No name on record → fall back to the email so consumers never render
        # a placeholder or a raw id.
        req["employee_name"] = full or req["employee_email"]
        req["employee_emp_code"] = emp.get("emp_code") or None
        req["employee_designation"] = (
            desg_name_map.get(str(emp.get("designation_id") or "")) or None
        )
        # Profile photo lives on the IAM user (replicated via user.updated).
        req["employee_avatar_url"] = user.get("avatar_url") or None
        lt_id = str(req.get("leave_type_id") or "")
        req["leave_type_name"] = lt_name_map.get(lt_id) or None
        # Balance only makes sense for balance-deducting types; LOP and
        # unrestricted types show nothing.
        if lt_deducting.get(lt_id, True) and not req.get("loss_of_pay"):
            bal_hours = balance_map.get((uid, lt_id))
            req["employee_balance_days"] = (
                round(max(bal_hours, 0.0) / HOURS_PER_DAY, 1)
                if bal_hours is not None
                else None
            )
            req["leave_type_annual_days"] = lt_annual_map.get(lt_id)
            entitled_hours = entitled_map.get((uid, lt_id))
            req["employee_entitled_days"] = (
                round(entitled_hours / HOURS_PER_DAY, 1)
                if entitled_hours
                else None
            )
        else:
            req["employee_balance_days"] = None
            req["leave_type_annual_days"] = None
            req["employee_entitled_days"] = None


async def _assert_manager_access(
    db: AsyncIOMotorDatabase,
    request_id: str,
    manager_user_id: str,
    *,
    is_hr: bool = False,
    capability: str = "view",
) -> dict:
    """Fetch the leave request and raise 403 unless the caller may access it.

    Access is granted when the request belongs to an employee whose approval
    chain the caller is part of *for that request's plan* — L1 always, L2 only
    when the plan's approval policy configures a second level — or, for an
    HR-permission holder, when the request's plan enables the relevant HR
    toggle (allow_hr_to_act for "act", allow_hr_to_view for "view").
    """
    doc = await get_leave_request(db, request_id)
    levels_by_user = await _managed_levels_map(db, manager_user_id)
    caller_levels = levels_by_user.get(str(doc.get("user_id") or ""))
    if caller_levels:
        plan_id = doc.get("leave_plan_id")
        plan_max = (await _plan_max_levels(db, [plan_id])).get(str(plan_id), 1)
        if _level_allows(caller_levels, plan_max):
            return doc
    if is_hr and await _request_plan_hr_flag(db, doc, capability):
        return doc
    raise DomainException(
        message="Access denied: this employee does not report to you",
        code="FORBIDDEN",
        status_code=status.HTTP_403_FORBIDDEN,
    )


async def _assert_level_access(
    db: AsyncIOMotorDatabase, request: dict, manager_user_id: str
) -> None:
    """No-op kept for backward compatibility with existing call sites.

    Used to gate L2 out of AND-policy approvals while ``current_level == 1``,
    forcing sequential L1 → L2 review. AND policies now let both managers
    act in any order — duplicate-approval prevention has moved into
    ``approve_leave_request`` (via ``approval_state.approved_by``), and
    chain-membership is already validated upstream by ``_assert_manager_access``.
    """
    return


async def list_managed_leave_requests(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    status_filter: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    *,
    is_hr: bool = False,
    org_id: str | None = None,
    skip: int = 0,
    limit: int | None = None,
) -> list[dict]:
    levels_by_user = await _managed_levels_map(db, manager_user_id)
    managed_ids = [to_oid(uid) for uid in levels_by_user]

    # HR with view permission additionally sees requests under any plan in their
    # org that enables allow_hr_to_view.
    or_clauses: list[dict] = []
    hr_plan_variants: list = []
    if managed_ids:
        or_clauses.append({"user_id": {"$in": managed_ids}})
    if is_hr:
        hr_plan_variants = await _hr_plan_id_variants(db, org_id, "view")
        if hr_plan_variants:
            or_clauses.append({"leave_plan_id": {"$in": hr_plan_variants}})
    if not or_clauses:
        return []

    query: dict = {"$or": or_clauses, "deleted_on": None}
    if status_filter:
        query["status"] = status_filter
    if from_date:
        query["end_date"] = {"$gte": from_date}
    if to_date:
        query["start_date"] = {"$lte": to_date}
    cursor = db[REQUESTS_COLLECTION].find(query).sort("start_date", -1).skip(skip)
    if limit is not None:
        cursor = cursor.limit(limit)
    docs = await cursor.to_list(length=None)
    docs = await _filter_to_approval_chain(
        db, docs, levels_by_user, hr_plan_variants if is_hr else []
    )
    await enrich_aging(db, docs)
    await _enrich_request_display_fields(db, docs)
    return docs


async def get_managed_status_counts(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    *,
    is_hr: bool = False,
    org_id: str | None = None,
) -> dict:
    """Exact per-status counts over the same scope as the manager listing —
    the stat cards were previously derived from a 100-row sample and had to
    render "N+" once the org outgrew it."""
    managed_ids = await _get_managed_user_ids(db, manager_user_id)

    or_clauses: list[dict] = []
    if managed_ids:
        or_clauses.append({"user_id": {"$in": managed_ids}})
    if is_hr:
        hr_plan_variants = await _hr_plan_id_variants(db, org_id, "view")
        if hr_plan_variants:
            or_clauses.append({"leave_plan_id": {"$in": hr_plan_variants}})

    counts = {"all": 0, "pending": 0, "approved": 0, "rejected": 0, "cancelled": 0}
    if not or_clauses:
        return counts

    groups = await db[REQUESTS_COLLECTION].aggregate([
        {"$match": {"$or": or_clauses, "deleted_on": None}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]).to_list(length=None)
    by_status = {g["_id"]: g["n"] for g in groups}
    counts["pending"] = by_status.get("PENDING", 0)
    counts["approved"] = by_status.get("APPROVED", 0)
    counts["rejected"] = by_status.get("REJECTED", 0)
    counts["cancelled"] = by_status.get("CANCELLED", 0)
    counts["all"] = sum(by_status.values())
    return counts


async def list_pending_approvals(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    *,
    is_hr: bool = False,
    org_id: str | None = None,
) -> list[dict]:
    """Return PENDING leave requests from managed employees that this manager can act on.

    Both OR and AND policies surface the request to every configured
    approver in parallel from submission time. The only manager who is
    filtered out is one who has already approved this specific request —
    tracked via ``approval_state.approved_by``. Under AND, the state
    machine in ``approve_leave_request`` still requires every level to
    approve before finalizing; surfacing it to both inboxes just lets
    them act in any order.

    An HR-permission holder additionally sees pending requests under any plan
    in their org that enables allow_hr_to_act.
    """
    levels_by_user = await _managed_levels_map(db, manager_user_id)
    managed_ids = [to_oid(uid) for uid in levels_by_user]

    or_clauses: list[dict] = []
    hr_plan_variants: list = []
    if managed_ids:
        or_clauses.append({"user_id": {"$in": managed_ids}})
    if is_hr:
        hr_plan_variants = await _hr_plan_id_variants(db, org_id, "act")
        if hr_plan_variants:
            or_clauses.append({"leave_plan_id": {"$in": hr_plan_variants}})
    if not or_clauses:
        return []

    all_pending = await db[REQUESTS_COLLECTION].find(
        {"$or": or_clauses, "status": "PENDING", "deleted_on": None}
    ).sort("created_on", -1).to_list(length=None)

    all_pending = await _filter_to_approval_chain(
        db, all_pending, levels_by_user, hr_plan_variants if is_hr else []
    )
    if not all_pending:
        return []

    mgr_refs = await _manager_refs(db, manager_user_id)
    mgr_ref_strs = {str(r) for r in mgr_refs}

    actionable = []
    for req in all_pending:
        # Hide requests this manager has already approved. Without this,
        # AND policies would keep showing the request to L1 after L1 has
        # acted (waiting on L2), and vice-versa.
        approved_by = req.get("approval_state", {}).get("approved_by") or []
        if any(str(b) in mgr_ref_strs for b in approved_by):
            continue
        actionable.append(req)

    await _enrich_request_display_fields(db, actionable)
    await enrich_aging(db, actionable)
    return actionable


async def get_managed_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    manager_user_id: str,
    *,
    is_hr: bool = False,
) -> dict:
    await _assert_manager_access(
        db, request_id, manager_user_id, is_hr=is_hr, capability="view"
    )
    return await get_leave_request_detail(db, request_id)


async def approve_managed_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    manager_user_id: str,
    payload: ApprovalActionPayload,
    *,
    is_hr: bool = False,
) -> dict:
    doc = await _assert_manager_access(
        db, request_id, manager_user_id, is_hr=is_hr, capability="act"
    )
    await _assert_level_access(db, doc, manager_user_id)
    return await approve_leave_request(db, request_id, manager_user_id, payload)


async def reject_managed_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    manager_user_id: str,
    payload: ApprovalActionPayload,
    *,
    is_hr: bool = False,
) -> dict:
    await _assert_manager_access(
        db, request_id, manager_user_id, is_hr=is_hr, capability="act"
    )
    return await reject_leave_request(db, request_id, manager_user_id, payload)


async def cancel_managed_leave_request(
    db: AsyncIOMotorDatabase,
    request_id: str,
    manager_user_id: str,
    payload: CancellationActionPayload,
    *,
    is_hr: bool = False,
) -> dict:
    await _assert_manager_access(
        db, request_id, manager_user_id, is_hr=is_hr, capability="act"
    )
    return await cancel_approved_leave_request(db, request_id, manager_user_id, payload)


async def get_team_availability(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    start_date: date,
    end_date: date,
    *,
    org_id: str | None = None,
) -> dict:
    managed_ids, levels_by_user = await _active_managed_roster(
        db, manager_user_id, org_id=org_id
    )
    if not managed_ids:
        return {
            "start_date": start_date,
            "end_date": end_date,
            "total_team_size": 0,
            "daily_availability": [],
            "team_members": [],
        }

    # Bulk-fetch employee name data, then enrich from users collection
    employees = await db["employees"].find(
        {"user_id": {"$in": managed_ids}, "is_deleted": {"$ne": True}},
        NAME_FIELDS,
    ).to_list(length=None)

    user_oids = [e["user_id"] for e in employees if e.get("user_id")]
    users = await db["users"].find(
        {"_id": {"$in": user_oids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1},
    ).to_list(length=None)
    user_name_map = {str(u["_id"]): u for u in users}

    emp_map: dict[str, str] = {}
    for emp in employees:
        uid = str(emp["user_id"])
        emp_map[uid] = _display_name(emp, user_name_map.get(uid) or {}, uid)

    # Ensure every managed user appears even if not in employees collection
    for oid in managed_ids:
        uid = str(oid)
        emp_map.setdefault(uid, uid)

    # Query leaves that overlap with the requested date range
    range_start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
    range_end = datetime(end_date.year, end_date.month, end_date.day, tzinfo=timezone.utc) + timedelta(days=1)

    leave_docs = await db[REQUESTS_COLLECTION].find({
        "user_id": {"$in": managed_ids},
        "status": {"$in": ["APPROVED", "PENDING"]},
        "start_datetime": {"$lt": range_end},
        "end_datetime": {"$gte": range_start},
        "deleted_on": None,
    }).to_list(length=None)
    # The roster is filtered by each employee's CURRENT plan; a historic request
    # may sit under a plan that never routed to L2, so filter per request too.
    leave_docs = await _filter_to_approval_chain(db, leave_docs, levels_by_user, [])

    # Bulk-fetch leave type names
    lt_oids = list({doc["leave_type_id"] for doc in leave_docs if doc.get("leave_type_id")})
    lt_docs = await db["leave_types"].find({"_id": {"$in": lt_oids}}).to_list(length=None)
    lt_name_map = {str(lt["_id"]): lt.get("name", "") for lt in lt_docs}

    # Build per-employee leave list
    emp_leaves: dict[str, list[dict]] = {uid: [] for uid in emp_map}
    for doc in leave_docs:
        uid = str(doc["user_id"])
        lt_id = str(doc.get("leave_type_id", ""))
        emp_leaves.setdefault(uid, []).append({
            "request_id": str(doc["_id"]),
            "leave_type_id": lt_id,
            "leave_type_name": lt_name_map.get(lt_id, ""),
            "start_date": doc.get("start_date", ""),
            "end_date": doc.get("end_date", ""),
            "duration_mode": doc.get("duration_mode", ""),
            "duration_days": doc.get("duration_days", 0),
            "status": doc["status"],
        })

    team_members = [
        {"user_id": uid, "name": name, "leaves_in_range": emp_leaves.get(uid, [])}
        for uid, name in emp_map.items()
    ]

    # Build daily breakdown
    # start_date / end_date in leave docs are ISO strings — string comparison works for YYYY-MM-DD
    daily_availability = []
    current_day = start_date
    while current_day <= end_date:
        day_str = current_day.isoformat()
        on_leave_today = []
        seen_users: set[str] = set()

        for doc in leave_docs:
            doc_start = doc.get("start_date", "")
            doc_end = doc.get("end_date", "")
            if not (doc_start and doc_end):
                continue
            if doc_start <= day_str <= doc_end:
                uid = str(doc["user_id"])
                seen_users.add(uid)
                lt_id = str(doc.get("leave_type_id", ""))
                on_leave_today.append({
                    "user_id": uid,
                    "employee_name": emp_map.get(uid, uid),
                    "leave_type_name": lt_name_map.get(lt_id, ""),
                    "request_id": str(doc["_id"]),
                    "duration_mode": doc.get("duration_mode", ""),
                    "status": doc["status"],
                })

        daily_availability.append({
            "date": current_day,
            "available_count": len(emp_map) - len(seen_users),
            "on_leave_count": len(seen_users),
            "on_leave": on_leave_today,
        })
        current_day += timedelta(days=1)

    return {
        "start_date": start_date,
        "end_date": end_date,
        "total_team_size": len(emp_map),
        "daily_availability": daily_availability,
        "team_members": team_members,
    }


async def get_team_leave_summary(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    status_filter: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    org_id: str | None = None,
) -> dict:
    managed_ids, levels_by_user = await _active_managed_roster(
        db, manager_user_id, org_id=org_id
    )
    if not managed_ids:
        return {"total_employees": 0, "employees_with_leaves": 0, "summary_by_type": [], "by_employee": []}

    statuses = [status_filter] if status_filter else ["APPROVED"]
    query: dict = {
        "user_id": {"$in": managed_ids},
        "status": {"$in": statuses},
        "deleted_on": None,
    }
    if from_date:
        query["end_date"] = {"$gte": from_date}
    if to_date:
        query["start_date"] = {"$lte": to_date}

    leave_docs = await db[REQUESTS_COLLECTION].find(query).to_list(length=None)
    leave_docs = await _filter_to_approval_chain(db, leave_docs, levels_by_user, [])

    # Fetch employee names
    employees = await db["employees"].find(
        {"user_id": {"$in": managed_ids}, "is_deleted": {"$ne": True}},
        NAME_FIELDS,
    ).to_list(length=None)
    user_oids = [e["user_id"] for e in employees if e.get("user_id")]
    users = await db["users"].find(
        {"_id": {"$in": user_oids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1},
    ).to_list(length=None)
    user_name_map = {str(u["_id"]): u for u in users}

    emp_name_map: dict[str, str] = {}
    for emp in employees:
        uid = str(emp["user_id"])
        emp_name_map[uid] = _display_name(emp, user_name_map.get(uid) or {}, uid)

    # Fetch leave type names
    lt_oids = list({doc["leave_type_id"] for doc in leave_docs if doc.get("leave_type_id")})
    lt_docs = await db["leave_types"].find({"_id": {"$in": lt_oids}}).to_list(length=None)
    lt_map = {lt["_id"]: lt for lt in lt_docs}

    # Aggregate by type and by employee
    type_agg: dict = {}
    emp_agg: dict = {}

    for doc in leave_docs:
        uid = str(doc["user_id"])
        lt_oid = doc.get("leave_type_id")
        lt_id = str(lt_oid) if lt_oid else "unknown"
        lt = lt_map.get(lt_oid) if lt_oid else None
        lt_name = lt.get("name", lt_id) if lt else lt_id
        hours = doc.get("duration_hours", 0.0) or 0.0

        if lt_id not in type_agg:
            type_agg[lt_id] = {"leave_type_id": lt_id, "leave_type_name": lt_name, "total_requests": 0, "total_hours": 0.0, "user_ids": set()}
        type_agg[lt_id]["total_requests"] += 1
        type_agg[lt_id]["total_hours"] += hours
        type_agg[lt_id]["user_ids"].add(uid)

        if uid not in emp_agg:
            emp_agg[uid] = {
                "user_id": uid,
                "employee_name": emp_name_map.get(uid, uid),
                "total_requests": 0,
                "total_hours": 0.0,
                "by_type": {},
            }
        emp_agg[uid]["total_requests"] += 1
        emp_agg[uid]["total_hours"] += hours
        if lt_id not in emp_agg[uid]["by_type"]:
            emp_agg[uid]["by_type"][lt_id] = {"leave_type_id": lt_id, "leave_type_name": lt_name, "total_requests": 0, "total_hours": 0.0}
        emp_agg[uid]["by_type"][lt_id]["total_requests"] += 1
        emp_agg[uid]["by_type"][lt_id]["total_hours"] += hours

    summary_by_type = sorted(
        [
            {
                **{k: v for k, v in entry.items() if k != "user_ids"},
                "employee_count": len(entry["user_ids"]),
                "total_days": round(entry["total_hours"] / 8.0, 2),
            }
            for entry in type_agg.values()
        ],
        key=lambda x: -x["total_hours"],
    )

    by_employee = sorted(
        [
            {
                "user_id": uid,
                "employee_name": data["employee_name"],
                "total_requests": data["total_requests"],
                "total_hours": data["total_hours"],
                "total_days": round(data["total_hours"] / 8.0, 2),
                "by_type": sorted(
                    [{**v, "total_days": round(v["total_hours"] / 8.0, 2)} for v in data["by_type"].values()],
                    key=lambda x: -x["total_hours"],
                ),
            }
            for uid, data in emp_agg.items()
        ],
        key=lambda x: -x["total_hours"],
    )

    return {
        "total_employees": len(managed_ids),
        "employees_with_leaves": len(emp_agg),
        "summary_by_type": summary_by_type,
        "by_employee": by_employee,
    }


async def get_team_calendar(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    from_date: date,
    to_date: date,
    statuses: list[str] | None = None,
    org_id: str | None = None,
) -> dict:
    managed_ids, levels_by_user = await _active_managed_roster(
        db, manager_user_id, org_id=org_id
    )
    if not managed_ids:
        return {"from_date": from_date, "to_date": to_date, "team_members": [], "holidays": []}

    # Resolve employee names
    employees = await db["employees"].find(
        {"user_id": {"$in": managed_ids}, "is_deleted": {"$ne": True}},
        NAME_FIELDS,
    ).to_list(length=None)
    user_oids = [e["user_id"] for e in employees if e.get("user_id")]
    users = await db["users"].find(
        {"_id": {"$in": user_oids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1},
    ).to_list(length=None)
    user_name_map = {str(u["_id"]): u for u in users}

    emp_map: dict[str, str] = {}
    for emp in employees:
        uid = str(emp["user_id"])
        emp_map[uid] = _display_name(emp, user_name_map.get(uid) or {}, uid)
    for oid in managed_ids:
        emp_map.setdefault(str(oid), str(oid))

    # Fetch leave requests overlapping the date range
    active_statuses = statuses or ["APPROVED", "PENDING"]
    from_str = from_date.isoformat()
    to_str = to_date.isoformat()
    leave_docs = await db[REQUESTS_COLLECTION].find({
        "user_id": {"$in": managed_ids},
        "status": {"$in": active_statuses},
        "start_date": {"$lte": to_str},
        "end_date": {"$gte": from_str},
        "deleted_on": None,
    }).sort("start_date", 1).to_list(length=None)
    leave_docs = await _filter_to_approval_chain(db, leave_docs, levels_by_user, [])

    # Fetch leave type names
    lt_oids = list({doc["leave_type_id"] for doc in leave_docs if doc.get("leave_type_id")})
    lt_docs = await db["leave_types"].find({"_id": {"$in": lt_oids}}).to_list(length=None)
    lt_name_map = {str(lt["_id"]): lt.get("name", "") for lt in lt_docs}

    # Group events per employee
    emp_events: dict[str, list] = {uid: [] for uid in emp_map}
    for doc in leave_docs:
        uid = str(doc["user_id"])
        lt_id = str(doc.get("leave_type_id", ""))
        emp_events.setdefault(uid, []).append({
            "request_id": str(doc["_id"]),
            "leave_type_id": lt_id,
            "leave_type_name": lt_name_map.get(lt_id, ""),
            "start_date": doc.get("start_date", ""),
            "end_date": doc.get("end_date", ""),
            "duration_days": doc.get("duration_days", 0.0),
            "duration_mode": doc.get("duration_mode", "FULL_DAYS"),
            "half_day_period": doc.get("half_day_period"),
            "start_session": doc.get("start_session"),
            "end_session": doc.get("end_session"),
            "status": doc["status"],
            "reason": doc.get("reason"),
        })

    team_members = sorted(
        [{"user_id": uid, "employee_name": name, "events": emp_events.get(uid, [])} for uid, name in emp_map.items()],
        key=lambda m: m["employee_name"],
    )

    # Fetch holidays for the manager's org covering the date range years
    holidays: list[dict] = []
    mgr_emp = await db["employees"].find_one(
        {"user_id": ObjectId(manager_user_id), "is_deleted": {"$ne": True}},
        {"organisation_id": 1},
    )
    if mgr_emp and mgr_emp.get("organisation_id"):
        org_id = mgr_emp["organisation_id"]
        years = list({from_date.year, to_date.year})

        # Restrict to the plans this team is actually assigned to. Reading every
        # plan in the org returned the same public holiday once per plan — an org
        # running one holiday plan per business unit produced three identical
        # "Independence Day" entries for a single team.
        team_ids = list(managed_ids) + [to_oid(manager_user_id)]
        assigned_plan_ids = await db["holiday_plan_employees"].distinct(
            "plan_id", {"user_id": {"$in": team_ids}, "deleted_on": None}
        )
        plan_query: dict = {
            "org_id": org_id,
            "is_active": True,
            "deleted_on": None,
            "year": {"$in": years},
        }
        if assigned_plan_ids:
            plan_query["_id"] = {"$in": [to_oid(p) for p in assigned_plan_ids]}
        holiday_plans = await db["holiday_plans"].find(plan_query).to_list(length=None)

        if holiday_plans:
            plan_ids = [p["_id"] for p in holiday_plans]
            holiday_docs = await db["holidays"].find({
                "plan_id": {"$in": plan_ids},
                "date": {"$gte": from_str, "$lte": to_str},
                "deleted_on": None,
            }).sort("date", 1).to_list(length=None)

            # `type` was always blank: holidays carry a classification_id, not a
            # `type` field. Resolve the classification so the calendar can label
            # and colour the day.
            cls_ids = list({h["classification_id"] for h in holiday_docs if h.get("classification_id")})
            cls_docs = await db["holiday_classifications"].find(
                {"_id": {"$in": cls_ids}}, {"name": 1, "color": 1}
            ).to_list(length=None)
            cls_map = {str(c["_id"]): c for c in cls_docs}

            # Two teams can still share a plan, and a plan can hold the same date
            # twice; collapse on (date, name) so each day appears once.
            seen: set[tuple[str, str]] = set()
            for h in holiday_docs:
                day = h.get("date", "")
                name = h.get("name", "") or ""
                key = (day, name.strip().lower())
                if key in seen:
                    continue
                seen.add(key)
                cls = cls_map.get(str(h.get("classification_id"))) or {}
                holidays.append({
                    "name": name,
                    "date": day,
                    "type": cls.get("name", ""),
                    "color": cls.get("color", ""),
                })

    return {
        "from_date": from_date,
        "to_date": to_date,
        "team_members": team_members,
        "holidays": holidays,
    }
