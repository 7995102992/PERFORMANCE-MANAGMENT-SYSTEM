from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import OperationFailure
from src.utils import to_oid

from src.audit import emit_audit
from src.employment_status import filter_active_user_ids
from src.exceptions import DomainException
from src.holiday_plans.schemas import (
    HolidayPlanCreate,
    HolidayPlanScopeUpdate,
    HolidayPlanUpdate,
)
from src.logger import logger
from src.messaging import email_events
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update

COLLECTION = "holiday_plans"

_LOOKUP_PIPELINE = [
    {"$lookup": {
        "from": "business_units",
        "localField": "business_unit_ids",
        "foreignField": "_id",
        "as": "_bu_docs",
    }},
    {"$lookup": {
        "from": "departments",
        "localField": "department_ids",
        "foreignField": "_id",
        "as": "_dept_docs",
    }},
    # Secondary join for each dept's PRIMARY BU. A dept's primary may sit
    # outside the plan's BU list (e.g. a dept on BU1 attached to a plan via
    # BU2 — `_bu_docs` won't contain BU1), so we can't reuse `_bu_docs`.
    {"$lookup": {
        "from": "business_units",
        "localField": "_dept_docs.business_unit_id",
        "foreignField": "_id",
        "as": "_dept_primary_bus",
    }},
    {"$addFields": {
        "business_units": {
            "$map": {
                "input": "$_bu_docs",
                "as": "bu",
                "in": {"id": {"$toString": "$$bu._id"}, "name": "$$bu.name"},
            }
        },
        "departments": {
            "$map": {
                "input": "$_dept_docs",
                "as": "dept",
                "in": {
                    "id": {"$toString": "$$dept._id"},
                    "name": "$$dept.name",
                    "business_unit_id": {
                        "$cond": [
                            {"$ifNull": ["$$dept.business_unit_id", False]},
                            {"$toString": "$$dept.business_unit_id"},
                            None,
                        ]
                    },
                    "business_unit_name": {
                        "$let": {
                            "vars": {
                                "primary": {
                                    "$arrayElemAt": [
                                        {"$filter": {
                                            "input": "$_dept_primary_bus",
                                            "as": "b",
                                            "cond": {"$eq": ["$$b._id", "$$dept.business_unit_id"]},
                                        }},
                                        0,
                                    ]
                                }
                            },
                            "in": "$$primary.name",
                        }
                    },
                    "business_unit_ids": {
                        "$map": {
                            "input": {"$ifNull": ["$$dept.business_unit_ids", []]},
                            "as": "bid",
                            "in": {"$toString": "$$bid"},
                        }
                    },
                },
            }
        },
    }},
    {"$project": {"_bu_docs": 0, "_dept_docs": 0, "_dept_primary_bus": 0, "business_unit_ids": 0, "department_ids": 0}},
]


async def _validate_business_unit_ids(
    db: AsyncIOMotorDatabase, org_id: str, bu_ids: list[str]
) -> list:
    if not bu_ids:
        return []
    bu_object_ids = [to_oid(bu_id) for bu_id in bu_ids]
    count = await db["business_units"].count_documents(
        {"_id": {"$in": bu_object_ids}, "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
    )
    if count != len(bu_object_ids):
        raise DomainException(
            message="One or more business unit IDs are invalid",
            code="INVALID_BUSINESS_UNIT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    return bu_object_ids


async def _validate_department_ids(
    db: AsyncIOMotorDatabase, org_id: str, dept_ids: list[str]
) -> list:
    if not dept_ids:
        return []
    dept_object_ids = [to_oid(dept_id) for dept_id in dept_ids]
    count = await db["departments"].count_documents(
        {"_id": {"$in": dept_object_ids}, "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
    )
    if count != len(dept_ids):
        raise DomainException(
            message="One or more department IDs are invalid",
            code="INVALID_DEPARTMENT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    return dept_object_ids


async def _validate_bu_dept_consistency(
    db: AsyncIOMotorDatabase, bu_oids: list, dept_oids: list
) -> None:
    """Two-way BU <-> Dept consistency for a plan's scope:

    1. Every submitted dept must map to at least one submitted BU — no dept may
       sit under a BU that wasn't selected (orphan dept).
    2. Every submitted BU must have at least one submitted dept linked to it — a
       BU with no department is a useless selection (nothing rolls up under it),
       so reject it (orphan BU).
    """
    bu_oid_strs = {str(b) for b in bu_oids}
    covered_bu_strs: set[str] = set()
    orphan_depts: list[str] = []
    if dept_oids:
        cursor = db["departments"].find(
            {"_id": {"$in": list(dept_oids)}, "is_deleted": {"$ne": True}},
            {"_id": 1, "name": 1, "business_unit_ids": 1},
        )
        async for dept in cursor:
            dept_bu_strs = {str(b) for b in (dept.get("business_unit_ids") or [])}
            matched = dept_bu_strs & bu_oid_strs
            if not matched:
                orphan_depts.append(dept.get("name") or str(dept["_id"]))
            covered_bu_strs |= matched

    # 1. Orphan dept — only meaningful when BUs were actually submitted.
    if bu_oids and orphan_depts:
        raise DomainException(
            message=f"Department(s) {', '.join(orphan_depts)} are not linked to any of the selected business units",
            code="BU_DEPT_MISMATCH",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # 2. Orphan BU — a selected BU with no covering dept among the selected depts.
    uncovered_strs = bu_oid_strs - covered_bu_strs
    if uncovered_strs:
        bu_docs = await db["business_units"].find(
            {"_id": {"$in": [to_oid(b) for b in uncovered_strs]}},
            {"_id": 1, "name": 1},
        ).to_list(length=None)
        names = [d.get("name") or str(d["_id"]) for d in bu_docs] or list(uncovered_strs)
        raise DomainException(
            message=f"Business unit(s) {', '.join(names)} have no department selected. Select at least one department for each business unit.",
            code="BU_WITHOUT_DEPT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def create_holiday_plan(
    db: AsyncIOMotorDatabase, payload: HolidayPlanCreate, org_id: str, user_id: str
) -> dict:
    existing = await db[COLLECTION].find_one(
        {"org_id": to_oid(org_id), "year": payload.year, "name": payload.name, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"A holiday plan with name '{payload.name}' already exists for year {payload.year}",
            code="DUPLICATE_PLAN",
            status_code=status.HTTP_409_CONFLICT,
        )
    business_unit_ids = await _validate_business_unit_ids(db, org_id, payload.business_unit_ids)
    department_ids = await _validate_department_ids(db, org_id, payload.department_ids)
    await _validate_bu_dept_consistency(db, business_unit_ids, department_ids)
    doc = {
        **payload.model_dump(),
        "org_id": to_oid(org_id),
        "is_active": True,
        "business_unit_ids": business_unit_ids,
        "department_ids": department_ids,
        **audit_fields_create(user_id),
    }
    await db[COLLECTION].insert_one(doc)
    logger.info("Holiday plan created", plan_id=doc["_id"], name=payload.name)
    await emit_audit(
        action="holiday_plan.created",
        resource=f"holiday_plan:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"name": payload.name, "year": payload.year},
    )
    result = await get_holiday_plan(db, str(doc["_id"]), expected_org_id=org_id)

    creator_emp = await db["employees"].find_one({"user_id": to_oid(user_id), "is_deleted": {"$ne": True}})
    if creator_emp and creator_emp.get("work_email"):
        logger.info(
            "Triggering holiday_plan_created email",
            to=creator_emp["work_email"],
            creator_name=creator_emp.get("name", ""),
            plan_name=payload.name,
            year=payload.year,
            plan_id=str(doc["_id"]),
            tenant_id=str(creator_emp.get("organisation_id", "")),
        )
        await email_events.publish_holiday_plan_created(
            creator_email=creator_emp["work_email"],
            creator_name=creator_emp.get("name", ""),
            plan_name=payload.name,
            year=payload.year,
            plan_id=str(doc["_id"]),
            tenant_id=str(creator_emp.get("organisation_id", "")),
        )

    return result


async def get_holiday_plans(
    db: AsyncIOMotorDatabase, org_id: str, year: int | None = None
) -> list[dict]:
    query: dict = {"org_id": to_oid(org_id), "deleted_on": None}
    if year is not None:
        query["year"] = year
    cursor = db[COLLECTION].find(query, {"_id": 1, "name": 1, "is_active": 1}).sort("created_on", -1)
    return await cursor.to_list(None)


async def get_holiday_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    *,
    expected_org_id=None,
) -> dict:
    """Return plan detail. When ``expected_org_id`` is supplied the plan must
    belong to that org — otherwise 404 (prevents cross-tenant IDOR)."""
    match: dict = {"_id": to_oid(plan_id), "deleted_on": None}
    if expected_org_id:
        match["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    pipeline = [{"$match": match}, *_LOOKUP_PIPELINE]
    results = await db[COLLECTION].aggregate(pipeline).to_list(1)
    if not results:
        raise DomainException(
            message="Holiday plan not found",
            code="PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return results[0]


async def update_holiday_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    payload: HolidayPlanUpdate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    existing = await get_holiday_plan(db, plan_id, expected_org_id=current_user_org_id)

    update_data = payload.model_dump(exclude_none=True)
    if not update_data:
        return existing

    # Block deactivation while employees are still assigned. Mirrors the FE check;
    # also stops direct API callers that bypass the UI from leaving stranded users.
    was_active = existing.get("is_active", True)
    if update_data.get("is_active") is False and was_active:
        emp_count = await db["holiday_plan_employees"].count_documents(
            {"plan_id": to_oid(plan_id), "deleted_on": None}
        )
        if emp_count > 0:
            raise DomainException(
                message=f"Cannot deactivate — {emp_count} employee(s) still assigned. Unassign them first.",
                code="ACTIVE_EMPLOYEE_DEPENDENCY",
                status_code=status.HTTP_409_CONFLICT,
            )

    org_id = existing["org_id"]
    # Reject empty BU/dept on update — a plan with no scope is meaningless and
    # would cascade-unlink every assigned employee. FE blocks this; the BE check
    # closes the gap for direct API callers.
    if "business_unit_ids" in update_data and not update_data["business_unit_ids"]:
        raise DomainException(
            message="At least one business unit is required",
            code="EMPTY_BUSINESS_UNIT_SCOPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if "department_ids" in update_data and not update_data["department_ids"]:
        raise DomainException(
            message="At least one department is required",
            code="EMPTY_DEPARTMENT_SCOPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if "business_unit_ids" in update_data:
        update_data["business_unit_ids"] = await _validate_business_unit_ids(db, org_id, update_data["business_unit_ids"])
    if "department_ids" in update_data:
        update_data["department_ids"] = await _validate_department_ids(db, org_id, update_data["department_ids"])

    # Cross-check: every effective dept must map to at least one effective BU.
    # Either side of the pair may come from the payload or the existing plan.
    if "business_unit_ids" in update_data or "department_ids" in update_data:
        effective_bu_oids = (
            update_data["business_unit_ids"]
            if "business_unit_ids" in update_data
            else [to_oid(b["id"]) for b in existing.get("business_units", [])]
        )
        effective_dept_oids = (
            update_data["department_ids"]
            if "department_ids" in update_data
            else [to_oid(d["id"]) for d in existing.get("departments", [])]
        )
        await _validate_bu_dept_consistency(db, effective_bu_oids, effective_dept_oids)

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": update_data})
    logger.info("Holiday plan updated", plan_id=plan_id)
    await emit_audit(
        action="holiday_plan.updated",
        resource=f"holiday_plan:{plan_id}",
        actor_id=user_id,
        organisation_id=org_id,
        changed_fields=changed_fields,
    )
    result = await get_holiday_plan(db, plan_id, expected_org_id=current_user_org_id)

    updater_emp = await db["employees"].find_one({"user_id": to_oid(user_id), "is_deleted": {"$ne": True}})
    if updater_emp and updater_emp.get("work_email"):
        logger.info(
            "Triggering holiday_plan_updated email",
            to=updater_emp["work_email"],
            updater_name=updater_emp.get("name", ""),
            plan_name=result.get("name", ""),
            year=result.get("year", 0),
            plan_id=plan_id,
            tenant_id=str(updater_emp.get("organisation_id", "")),
        )
        await email_events.publish_holiday_plan_updated(
            updater_email=updater_emp["work_email"],
            updater_name=updater_emp.get("name", ""),
            plan_name=result.get("name", ""),
            year=result.get("year", 0),
            plan_id=plan_id,
            tenant_id=str(updater_emp.get("organisation_id", "")),
        )

    return result


async def update_holiday_plan_scope(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    payload: HolidayPlanScopeUpdate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Apply a BU/dept scope edit to the plan, its holidays, and its employee
    assignments in ONE transaction (atomic all-or-nothing).

    The FE resolves the cascade (which holidays to extend/trim, the final employee
    membership) behind its confirmation dialog and posts the result here, so the
    three writes can never end up half-applied — and a direct API caller gets the
    full cascade too, unlike calling the plain plan-update endpoint. Falls back to
    sequential (non-transactional) execution on a standalone Mongo, logging that a
    mid-flight failure can leave partial updates (same posture as sync_holidays_scope).
    """
    existing = await get_holiday_plan(db, plan_id, expected_org_id=current_user_org_id)
    org_id = existing["org_id"]
    plan_oid = to_oid(plan_id)

    # ── Validate the new scope (same rules as update_holiday_plan) ──
    if not payload.business_unit_ids:
        raise DomainException(message="At least one business unit is required", code="EMPTY_BUSINESS_UNIT_SCOPE", status_code=status.HTTP_400_BAD_REQUEST)
    if not payload.department_ids:
        raise DomainException(message="At least one department is required", code="EMPTY_DEPARTMENT_SCOPE", status_code=status.HTTP_400_BAD_REQUEST)
    bu_oids = await _validate_business_unit_ids(db, org_id, payload.business_unit_ids)
    dept_oids = await _validate_department_ids(db, org_id, payload.department_ids)
    await _validate_bu_dept_consistency(db, bu_oids, dept_oids)
    # Deactivation guard — never strand assigned employees.
    if payload.is_active is False and existing.get("is_active", True):
        emp_count = await db["holiday_plan_employees"].count_documents({"plan_id": plan_oid, "deleted_on": None})
        if emp_count > 0:
            raise DomainException(message=f"Cannot deactivate — {emp_count} employee(s) still assigned. Unassign them first.", code="ACTIVE_EMPLOYEE_DEPENDENCY", status_code=status.HTTP_409_CONFLICT)

    audit = audit_fields_update(user_id)
    plan_set: dict = {"business_unit_ids": bu_oids, "department_ids": dept_oids, **audit}
    if payload.name is not None:
        plan_set["name"] = payload.name
    if payload.is_active is not None:
        plan_set["is_active"] = payload.is_active
    if payload.reminder_settings is not None:
        plan_set["reminder_settings"] = payload.reminder_settings.model_dump()
    if payload.notify_employees is not None:
        plan_set["notify_employees"] = payload.notify_employees
    if payload.reprocess_leaves is not None:
        plan_set["reprocess_leaves"] = payload.reprocess_leaves

    ext_dept = [to_oid(d) for d in payload.holiday_extend_dept_ids]
    trim_dept = {to_oid(d) for d in payload.holiday_trim_dept_ids}
    ext_bu = [to_oid(b) for b in payload.holiday_extend_bu_ids]
    trim_bu = {to_oid(b) for b in payload.holiday_trim_bu_ids}
    # ``None`` => leave employee assignments untouched; a list (even empty) =>
    # reconcile membership to exactly that set.
    reconcile_members = payload.member_user_ids is not None
    desired_members = {to_oid(u) for u in (payload.member_user_ids or []) if u}

    counts = {"extended": 0, "trimmed": 0, "orphaned": 0, "bu_extended": 0, "bu_trimmed": 0, "bu_orphaned": 0, "employees_added": 0, "employees_removed": 0, "employees_skipped": 0}
    added_user_oids: list = []

    async def _run(session) -> None:
        # 1) Plan scope + meta.
        await db[COLLECTION].update_one({"_id": plan_oid}, {"$set": plan_set}, session=session)

        # 2) Re-scope every holiday in the plan: extend (added) then trim (removed)
        #    on both axes; skip (and count as orphaned) any holiday that trimming
        #    would leave with no departments / no business units.
        if ext_dept or trim_dept or ext_bu or trim_bu:
            cursor = db["holidays"].find({"plan_id": plan_oid, "deleted_on": None}, session=session)
            async for h in cursor:
                cur_dept = [to_oid(d) for d in (h.get("applicable_department_ids") or [])]
                after = list(cur_dept)
                for d in ext_dept:
                    if d not in after:
                        after.append(d)
                did_ext = len(after) != len(cur_dept)
                after_trim = [d for d in after if d not in trim_dept] if trim_dept else after
                did_trim = len(after_trim) != len(after)
                dept_orphan = did_trim and not after_trim and bool(cur_dept)
                apply_dept = (did_ext or did_trim) and not dept_orphan

                cur_bu = [to_oid(b) for b in (h.get("business_unit_ids") or ([h["business_unit_id"]] if h.get("business_unit_id") else []))]
                bu_after = list(cur_bu)
                for b in ext_bu:
                    if b not in bu_after:
                        bu_after.append(b)
                bu_did_ext = len(bu_after) != len(cur_bu)
                bu_after_trim = [b for b in bu_after if b not in trim_bu] if trim_bu else bu_after
                bu_did_trim = len(bu_after_trim) != len(bu_after)
                bu_orphan = bu_did_trim and not bu_after_trim and bool(cur_bu)
                apply_bu = (bu_did_ext or bu_did_trim) and not bu_orphan

                set_doc: dict = {}
                if apply_dept:
                    set_doc["applicable_department_ids"] = after_trim
                if apply_bu:
                    set_doc["business_unit_ids"] = bu_after_trim
                if set_doc:
                    set_doc.update(audit)
                    await db["holidays"].update_one({"_id": h["_id"]}, {"$set": set_doc}, session=session)
                if apply_dept and did_ext:
                    counts["extended"] += 1
                if apply_dept and did_trim:
                    counts["trimmed"] += 1
                if dept_orphan:
                    counts["orphaned"] += 1
                if apply_bu and bu_did_ext:
                    counts["bu_extended"] += 1
                if apply_bu and bu_did_trim:
                    counts["bu_trimmed"] += 1
                if bu_orphan:
                    counts["bu_orphaned"] += 1

        # 3) Reconcile employee membership to the final desired set — but only when
        #    the caller actually sent a membership list. ``member_user_ids=None``
        #    leaves assignments untouched (pure rename / admin declined auto-assign).
        if not reconcile_members:
            return
        existing_docs = await db["holiday_plan_employees"].find({"plan_id": plan_oid, "deleted_on": None}, session=session).to_list(length=None)
        existing_oids = {to_oid(d["user_id"]) for d in existing_docs}
        # Activeness = employment status: never assign a deactivated employee, and
        # keep (don't purge) inactive members already on the plan (keep-but-hide).
        desired_active = await filter_active_user_ids(db, list(desired_members))
        active_existing = await filter_active_user_ids(db, list(existing_oids))
        to_remove = active_existing - desired_active
        to_add = desired_active - existing_oids
        if to_remove:
            rm = list(to_remove) + [str(x) for x in to_remove]
            res = await db["holiday_plan_employees"].delete_many({"plan_id": plan_oid, "user_id": {"$in": rm}, "deleted_on": None}, session=session)
            counts["employees_removed"] = res.deleted_count
        if to_add:
            # One holiday plan per employee: skip anyone already assigned to a
            # DIFFERENT plan (mirrors add_employees' cross-scope rule), counting them
            # as skipped rather than failing the whole edit.
            add_match = list(to_add) + [str(x) for x in to_add]
            conflicts = await db["holiday_plan_employees"].find(
                {"user_id": {"$in": add_match}, "plan_id": {"$ne": plan_oid}, "deleted_on": None},
                {"user_id": 1},
                session=session,
            ).to_list(length=None)
            conflict_oids = {to_oid(c["user_id"]) for c in conflicts}
            final_add = [oid for oid in to_add if oid not in conflict_oids]
            counts["employees_skipped"] = len(to_add) - len(final_add)
            if final_add:
                docs = [{"plan_id": plan_oid, "org_id": org_id, "user_id": oid, **audit_fields_create(user_id)} for oid in final_add]
                await db["holiday_plan_employees"].insert_many(docs, session=session)
                counts["employees_added"] = len(final_add)
                added_user_oids.extend(final_add)

    transactional = True
    try:
        async with await db.client.start_session() as session:
            async with session.start_transaction():
                await _run(session)
    except OperationFailure as exc:
        if exc.code in (20, 263) or "replica set" in str(exc).lower():
            logger.warning("Mongo standalone — holiday plan scope update ran non-transactionally; a mid-flight failure can leave partial updates.", plan_id=plan_id)
            transactional = False
            await _run(None)
        else:
            raise

    # ── Post-commit side effects (audit + new-member emails) ──
    await emit_audit(action="holiday_plan.scope_updated", resource=f"holiday_plan:{plan_id}", actor_id=user_id, organisation_id=str(org_id), details=counts)
    if added_user_oids:
        try:
            from src.holiday_plan_employees.service import _notify_added_employees
            await _notify_added_employees(db, added_user_oids, existing.get("name", ""), plan_id)
        except Exception as exc:
            logger.warning("New-member notification failed after scope update", plan_id=plan_id, error=str(exc))
    logger.info("Holiday plan scope updated", plan_id=plan_id, transactional=transactional, **counts)
    return {**counts, "transactional": transactional}


async def delete_holiday_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    user_id: str,
    *,
    current_user_org_id=None,
) -> None:
    existing = await get_holiday_plan(db, plan_id, expected_org_id=current_user_org_id)

    dependencies = []
    emp_count = await db["holiday_plan_employees"].count_documents(
        {"plan_id": to_oid(plan_id), "deleted_on": None}
    )
    if emp_count > 0:
        dependencies.append({"type": "employees", "count": emp_count})
    holiday_count = await db["holidays"].count_documents(
        {"plan_id": to_oid(plan_id), "deleted_on": None}
    )
    if holiday_count > 0:
        dependencies.append({"type": "holidays", "count": holiday_count})
    if dependencies:
        raise DomainException(
            message="Cannot delete this holiday plan. Active dependencies exist.",
            code="DEPENDENCY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "Cannot delete this holiday plan. Active dependencies exist.", "dependencies": dependencies},
        )

    delete_set = audit_fields_delete(user_id)
    await db[COLLECTION].update_one({"_id": to_oid(plan_id)}, {"$set": delete_set})
    logger.info("Holiday plan soft-deleted", plan_id=plan_id)
    await emit_audit(
        action="holiday_plan.deleted",
        resource=f"holiday_plan:{plan_id}",
        actor_id=user_id,
        organisation_id=existing.get("org_id"),
    )
