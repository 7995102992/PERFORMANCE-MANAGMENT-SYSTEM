from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_activity, emit_audit
from src.bulk_utils import assert_no_cross_scope_assignment, find_cross_scope_conflicts
from src.employee_enrichment import apply_details, enrich_user_details
from src.employment_status import filter_active_user_ids, get_inactive_status_ids
from src.exceptions import DomainException
from src.logger import logger
from src.messaging import email_events
from src.models import audit_fields_create
from src.utils import to_oid

COLLECTION = "holiday_plan_employees"
SCOPE_NAME_COLLECTION = "holiday_plans"
SCOPE_LABEL = "holiday plan"


async def _notify_added_employees(
    db: AsyncIOMotorDatabase,
    user_oids: list,
    plan_name: str,
    plan_id: str,
) -> None:
    """Send holiday plan assignment emails to newly added employees."""
    if not user_oids:
        return
    user_id_match = list(user_oids) + [str(x) for x in user_oids]
    emp_docs = await db["employees"].find(
        {"user_id": {"$in": user_id_match}, "is_deleted": {"$ne": True}}
    ).to_list(length=None)
    for emp in emp_docs:
        if emp.get("work_email"):
            logger.info(
                "Triggering holiday_plan_employee_added email",
                to=emp["work_email"],
                employee_name=emp.get("name", ""),
                plan_name=plan_name,
                plan_id=plan_id,
                tenant_id=str(emp.get("organisation_id", "")),
            )
            await email_events.publish_holiday_plan_employee_added(
                employee_email=emp["work_email"],
                employee_name=emp.get("name", ""),
                plan_name=plan_name,
                plan_id=plan_id,
                tenant_id=str(emp.get("organisation_id", "")),
            )


def _assert_plan_active(plan: dict) -> None:
    """Reject mutations on an inactive holiday plan.

    Reads of the employee list are still permitted — only state-changing
    operations (sync / add / by-department flavours) call this guard.
    """
    if plan.get("is_active") is False:
        logger.warning(
            "Mutation rejected on inactive plan",
            plan_id=plan.get("_id"),
        )
        raise DomainException(
            message="Cannot mutate plan employees: the holiday plan is inactive.",
            code="INACTIVE_PLAN",
            status_code=status.HTTP_409_CONFLICT,
        )


async def sync_employees(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    user_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Sync the membership of a holiday plan.

    ``current_user_org_id`` (from the authenticated session) is the canonical
    tenant guard. When supplied, the plan must belong to that org; otherwise
    the caller sees a 404 — they can never reach into another tenant's data.
    """
    plan_oid = to_oid(plan_id)
    plan = await _get_plan(db, plan_id, expected_org_id=current_user_org_id)
    _assert_plan_active(plan)
    org_id = plan["org_id"]
    # Canonical comparison form is ObjectId. Accept ObjectId or str on input
    # and normalize both sides of the diff so set membership works correctly.
    desired_oids = {to_oid(uid) for uid in user_ids if uid}

    existing_docs = await db[COLLECTION].find(
        {"plan_id": plan_oid, "deleted_on": None}
    ).to_list(length=None)
    existing_oids = {to_oid(doc["user_id"]) for doc in existing_docs}

    # Activeness is driven by employment status. Never (re)assign a deactivated
    # employee, and never PURGE one that's already assigned (keep-but-hide): bound
    # additions to active employees, and compute removals against only the active
    # members so an unrelated sync can't silently drop an inactive-but-assigned row.
    desired_active = await filter_active_user_ids(db, list(desired_oids))
    active_existing = await filter_active_user_ids(db, list(existing_oids))

    to_add = desired_active - existing_oids
    to_remove = active_existing - desired_active

    # Cross-scope rule: each employee may belong to only one holiday plan.
    # Reject the sync if any user we're about to ADD is already in another plan.
    await assert_no_cross_scope_assignment(
        db,
        collection=COLLECTION,
        scope_field="plan_id",
        scope_value=plan_oid,
        user_oids=list(to_add),
        scope_name_collection=SCOPE_NAME_COLLECTION,
        scope_label=SCOPE_LABEL,
        org_id=org_id,
    )

    added = 0
    removed = 0

    if to_remove:
        # Match either storage form (ObjectId canonical, str legacy fallback)
        remove_match = list(to_remove) + [str(x) for x in to_remove]
        result = await db[COLLECTION].delete_many(
            {"plan_id": plan_oid, "user_id": {"$in": remove_match}, "deleted_on": None},
        )
        removed = result.deleted_count

    if to_add:
        docs = [
            {"plan_id": plan_oid, "org_id": org_id, "user_id": oid, **audit_fields_create(user_id)}
            for oid in to_add
        ]
        await db[COLLECTION].insert_many(docs)
        added = len(docs)
        logger.info(
            "Triggering holiday_plan_employee_added emails",
            plan_id=plan_id,
            plan_name=plan.get("name", ""),
            new_employee_count=added,
        )
        await _notify_added_employees(db, list(to_add), plan.get("name", ""), plan_id)

    logger.info("Holiday plan employees synced", plan_id=plan_id, added=added, removed=removed)
    _sync_action = "holiday_plan_employee.synced"
    _sync_resource = f"holiday_plan:{plan_id}"
    _sync_details = {"added": added, "removed": removed}
    await emit_activity(
        action=_sync_action,
        resource=_sync_resource,
        actor_id=user_id,
        organisation_id=org_id,
        details=_sync_details,
    )
    await emit_audit(
        action=_sync_action,
        resource=_sync_resource,
        actor_id=user_id,
        organisation_id=org_id,
        details=_sync_details,
    )
    return {"added": added, "removed": removed, "total": len(desired_active)}


async def add_employees(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    user_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Add employees to plan without removing existing ones.

    ``current_user_org_id`` (from the authenticated session) tenant-scopes
    the plan lookup — passing a plan_id from another org yields 404.
    """
    plan_oid = to_oid(plan_id)
    plan = await _get_plan(db, plan_id, expected_org_id=current_user_org_id)
    _assert_plan_active(plan)
    org_id = plan["org_id"]
    # Canonical comparison form is ObjectId. Normalize both sides so duplicate
    # detection works whether existing rows are stored as ObjectId (canonical)
    # or as str (legacy fallback).
    desired_oids = [to_oid(uid) for uid in user_ids if uid]

    existing_docs = await db[COLLECTION].find(
        {"plan_id": plan_oid, "deleted_on": None}
    ).to_list(length=None)
    existing_set = {to_oid(doc["user_id"]) for doc in existing_docs}

    to_add = [oid for oid in desired_oids if oid not in existing_set]
    skipped = len(desired_oids) - len(to_add)

    # Never assign a deactivated employee (activeness = employment status). Drop
    # inactive ids and count them as skipped, before the cross-scope check.
    if to_add:
        active_add = await filter_active_user_ids(db, to_add)
        inactive_count = len(to_add) - len(active_add)
        if inactive_count:
            to_add = [oid for oid in to_add if oid in active_add]
            skipped += inactive_count

    # Cross-scope rule: filter out users already assigned to another plan
    # instead of failing the entire batch. Conflicting users are counted as
    # skipped so the caller knows how many were excluded.
    if to_add:
        conflicting = await find_cross_scope_conflicts(
            db,
            collection=COLLECTION,
            scope_field="plan_id",
            scope_value=plan_oid,
            user_oids=to_add,
            scope_name_collection=SCOPE_NAME_COLLECTION,
            scope_label=SCOPE_LABEL,
            org_id=org_id,
        )
        if conflicting:
            to_add = [oid for oid in to_add if oid not in conflicting]
            skipped += len(conflicting)

    added = 0
    if to_add:
        docs = [
            {"plan_id": plan_oid, "org_id": org_id, "user_id": oid, **audit_fields_create(user_id)}
            for oid in to_add
        ]
        await db[COLLECTION].insert_many(docs)
        added = len(docs)
        logger.info(
            "Triggering holiday_plan_employee_added emails",
            plan_id=plan_id,
            plan_name=plan.get("name", ""),
            new_employee_count=added,
        )
        await _notify_added_employees(db, to_add, plan.get("name", ""), plan_id)

    logger.info("Bulk add holiday plan employees", plan_id=plan_id, added=added, skipped=skipped)
    _add_action = "holiday_plan_employee.added"
    _add_resource = f"holiday_plan:{plan_id}"
    _add_details = {"added": added, "skipped": skipped}
    await emit_activity(
        action=_add_action,
        resource=_add_resource,
        actor_id=user_id,
        organisation_id=org_id,
        details=_add_details,
    )
    await emit_audit(
        action=_add_action,
        resource=_add_resource,
        actor_id=user_id,
        organisation_id=org_id,
        details=_add_details,
    )
    return {"added": added, "skipped": skipped, "total": len(existing_set) + added}


async def _get_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    *,
    expected_org_id=None,
) -> dict:
    """Resolve a plan (with ``org_id`` and ``is_active``). If
    ``expected_org_id`` is given, the plan must belong to that org —
    otherwise 404 (prevents cross-tenant IDOR)."""
    query: dict = {"_id": to_oid(plan_id), "deleted_on": None}
    if expected_org_id:
        query["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    plan = await db["holiday_plans"].find_one(
        query, {"org_id": 1, "is_active": 1, "name": 1, "business_unit_ids": 1}
    )
    if not plan:
        raise DomainException(
            message="Holiday plan not found",
            code="PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return plan


async def _resolve_user_ids_by_departments(
    db: AsyncIOMotorDatabase,
    department_ids: list[str],
    organisation_id,
    business_unit_ids: list | None = None,
) -> list[str]:
    """Look up active employee user_ids for the given departments within the given org.

    When ``business_unit_ids`` is provided, employees are additionally restricted
    to those BUs. This matters when a department is shared across BUs: pulling by
    department alone would also grab employees who sit under a BU outside this
    plan's scope, so we constrain to the plan's own BUs.

    Accepts both ObjectId and string forms for department_id / organisation_id /
    business_unit_id on the employees collection — legacy / partially-migrated
    docs may have either shape.
    """
    if not department_ids:
        return []
    dept_oids = [to_oid(d) for d in department_ids]
    dept_match: list = list(dept_oids) + [str(d) for d in department_ids]
    org_match = [organisation_id, str(organisation_id)] if organisation_id else []
    query: dict = {
        "department_id": {"$in": dept_match},
        "is_deleted": {"$ne": True},
        "employment_status": {"$nin": list(await get_inactive_status_ids(db))},
    }
    if business_unit_ids:
        bu_oids = [to_oid(b) for b in business_unit_ids if b]
        query["business_unit_id"] = {"$in": list(bu_oids) + [str(b) for b in bu_oids]}
    if org_match:
        query["organisation_id"] = {"$in": org_match}
    cursor = db["employees"].find(query, {"user_id": 1})
    docs = await cursor.to_list(length=None)
    return [str(d["user_id"]) for d in docs if d.get("user_id")]


async def sync_employees_by_departments(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    department_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Replace plan's employee set with everyone in the given departments."""
    plan = await _get_plan(db, plan_id, expected_org_id=current_user_org_id)
    _assert_plan_active(plan)
    org_id = plan["org_id"]
    user_ids = await _resolve_user_ids_by_departments(
        db, department_ids, org_id, plan.get("business_unit_ids")
    )
    return await sync_employees(db, plan_id, user_ids, user_id, current_user_org_id=current_user_org_id)


async def add_employees_by_departments(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    department_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Additively assign employees from the given departments to the plan."""
    plan = await _get_plan(db, plan_id, expected_org_id=current_user_org_id)
    _assert_plan_active(plan)
    org_id = plan["org_id"]
    user_ids = await _resolve_user_ids_by_departments(
        db, department_ids, org_id, plan.get("business_unit_ids")
    )
    if not user_ids:
        return {"added": 0, "skipped": 0, "total": 0}
    return await add_employees(db, plan_id, user_ids, user_id, current_user_org_id=current_user_org_id)


async def list_employees(
    db: AsyncIOMotorDatabase,
    plan_id: str,
) -> list[dict]:
    docs = await db[COLLECTION].find(
        {"plan_id": to_oid(plan_id), "deleted_on": None}
    ).sort("created_on", -1).to_list(length=None)
    if not docs:
        return docs
    # Keep-but-hide: an employee assigned while active and later deactivated/exited
    # keeps their assignment row (history is preserved), but must NOT surface in the
    # member list or inflate its count. Filter to currently-active employees by their
    # employment status — the single source of truth for "active".
    active = await filter_active_user_ids(db, [doc["user_id"] for doc in docs])
    docs = [doc for doc in docs if to_oid(doc["user_id"]) in active]
    # Enrich with name/dept/etc from the LMS mirror so the FE renders directly
    # from this response instead of fetching the whole org from IAM and joining.
    details = await enrich_user_details(db, [doc["user_id"] for doc in docs])
    return [apply_details(doc, details) for doc in docs]


async def cross_plan_assignments(db: AsyncIOMotorDatabase, plan_id: str) -> dict:
    """Members of OTHER active holiday plans in the same org+year, as
    ``{items: [{user_id, scope_name}]}``. Replaces the FE's N per-plan fetches
    (one call instead of one-per-other-plan) that power the 'already on plan X'
    warning."""
    plan = await db[SCOPE_NAME_COLLECTION].find_one({"_id": to_oid(plan_id)})
    if not plan:
        return {"items": []}
    query = {
        "org_id": plan.get("org_id"),
        "is_active": True,
        "deleted_on": None,
        "_id": {"$ne": to_oid(plan_id)},
    }
    if plan.get("year") is not None:
        query["year"] = plan.get("year")
    other_plans = await db[SCOPE_NAME_COLLECTION].find(
        query, {"name": 1}
    ).to_list(length=None)
    if not other_plans:
        return {"items": []}
    name_by_id = {p["_id"]: p.get("name") for p in other_plans}
    rows = await db[COLLECTION].find(
        {"plan_id": {"$in": list(name_by_id)}, "deleted_on": None},
        {"user_id": 1, "plan_id": 1},
    ).to_list(length=None)
    if not rows:
        return {"items": []}
    active = await filter_active_user_ids(db, [r["user_id"] for r in rows])
    items = [
        {"user_id": str(r["user_id"]), "scope_name": name_by_id.get(r["plan_id"])}
        for r in rows
        if to_oid(r["user_id"]) in active
    ]
    return {"items": items}
