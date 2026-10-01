import asyncio

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_activity, emit_audit
from src.bulk_utils import assert_no_cross_scope_assignment, find_cross_scope_conflicts
from src.employee_enrichment import apply_details, enrich_user_details
from src.employment_status import filter_active_user_ids, get_inactive_status_ids
from src.exceptions import DomainException
from src.logger import logger
from src.messaging import email_events
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update
from src.work_calendar.schemas import (
    WorkCalendarCreate,
    WorkCalendarUpdate,
)
from src.utils import to_oid

CALENDAR_COLLECTION = "work_calendars"
BU_MAP_COLLECTION = "calendar_business_unit_map"
DEPT_MAP_COLLECTION = "calendar_department_map"
EMP_MAP_COLLECTION = "work_calendar_employees"
# Mirrored from shift_assignment_service.SHIFT_ASSIGNMENT_COLLECTION. Inlined
# here to avoid a circular import (that module imports CALENDAR_COLLECTION /
# EMP_MAP_COLLECTION from this one).
SHIFT_ASSIGNMENT_COLLECTION = "work_calendar_shift_assignments"
SCOPE_LABEL = "work calendar"


async def _get_calendar_or_raise(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    *,
    expected_org_id=None,
) -> dict:
    """Fetch a calendar. If ``expected_org_id`` is given, the calendar must
    belong to that org — otherwise 404 (prevents cross-tenant IDOR)."""
    query: dict = {"_id": to_oid(calendar_id), "deleted_on": None}
    if expected_org_id:
        query["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    doc = await db[CALENDAR_COLLECTION].find_one(query)
    if not doc:
        raise DomainException(
            message="Work calendar not found",
            code="CALENDAR_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


def _assert_calendar_active(calendar: dict) -> None:
    """Block mutations on inactive calendars. Reads remain allowed.

    Raises DomainException(409, INACTIVE_CALENDAR) when ``is_active`` is False.
    Call this immediately after ``_get_calendar_or_raise`` in any service
    entrypoint that mutates calendar-scoped state (employees, shifts,
    shift-assignments).
    """
    if calendar.get("is_active") is False:
        raise DomainException(
            message="This work calendar is inactive. Re-activate it before making changes.",
            code="INACTIVE_CALENDAR",
            status_code=status.HTTP_409_CONFLICT,
        )


_DETAIL_LOOKUP = [
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
    # outside the calendar's BU list (e.g. a dept on BU1 attached to a
    # calendar via BU2 — `_bu_docs` won't contain BU1), so we can't reuse it.
    {"$lookup": {
        "from": "business_units",
        "localField": "_dept_docs.business_unit_id",
        "foreignField": "_id",
        "as": "_dept_primary_bus",
    }},
    {"$lookup": {
        "from": EMP_MAP_COLLECTION,
        "localField": "_id",
        "foreignField": "work_calendar_id",
        "pipeline": [{"$match": {"deleted_on": None}}],
        "as": "_emp_docs",
    }},
    {"$addFields": {
        "business_units": {
            "$map": {"input": "$_bu_docs", "as": "bu", "in": {"id": {"$toString": "$$bu._id"}, "name": "$$bu.name"}}
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
        "employee_count": {"$size": "$_emp_docs"},
    }},
    {"$project": {"_bu_docs": 0, "_dept_docs": 0, "_dept_primary_bus": 0, "_emp_docs": 0}},
]


async def _get_calendar_detail(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    *,
    expected_org_id=None,
) -> dict:
    match: dict = {"_id": to_oid(calendar_id), "deleted_on": None}
    if expected_org_id:
        match["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    pipeline = [
        {"$match": match},
        *_DETAIL_LOOKUP,
    ]
    results = await db[CALENDAR_COLLECTION].aggregate(pipeline).to_list(1)
    if not results:
        raise DomainException(
            message="Work calendar not found",
            code="CALENDAR_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    doc = results[0]
    doc["_id"] = str(doc["_id"])
    doc["org_id"] = str(doc["org_id"])
    doc.pop("business_unit_ids", None)
    doc.pop("department_ids", None)
    return doc


async def _validate_business_unit_ids(
    db: AsyncIOMotorDatabase, org_id: str, bu_ids: list[str]
) -> None:
    unique_ids = list(set(bu_ids))
    if not unique_ids:
        return
    bu_oids = [to_oid(bid) for bid in unique_ids]
    count = await db["business_units"].count_documents(
        {"_id": {"$in": bu_oids}, "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
    )
    if count != len(unique_ids):
        raise DomainException(
            message="One or more business unit IDs are invalid",
            code="INVALID_BUSINESS_UNIT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def _validate_department_ids(
    db: AsyncIOMotorDatabase, org_id: str, dept_ids: list[str]
) -> None:
    unique_ids = list(set(dept_ids))
    if not unique_ids:
        return
    department_ids = [to_oid(dept_id) for dept_id in unique_ids]
    count = await db["departments"].count_documents(
        {"_id": {"$in": department_ids}, "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
    )
    if count != len(unique_ids):
        raise DomainException(
            message="One or more department IDs are invalid",
            code="INVALID_DEPARTMENT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def _validate_bu_dept_consistency(
    db: AsyncIOMotorDatabase, bu_oids: list, dept_oids: list
) -> None:
    """Two-way BU <-> Dept consistency for a calendar's scope:

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


async def _unset_other_defaults(
    db: AsyncIOMotorDatabase, org_id: str, except_id: str | None = None
) -> None:
    query: dict = {"org_id": to_oid(org_id), "is_default": True, "deleted_on": None}
    if except_id:
        query["_id"] = {"$ne": to_oid(except_id)}
    await db[CALENDAR_COLLECTION].update_many(query, {"$set": {"is_default": False}})


async def create_calendar(
    db: AsyncIOMotorDatabase,
    payload: WorkCalendarCreate,
    org_id: str,
    user_id: str,
) -> dict:
    existing = await db[CALENDAR_COLLECTION].find_one(
        {"org_id": to_oid(org_id), "name": payload.name, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"A work calendar named '{payload.name}' already exists",
            code="DUPLICATE_CALENDAR",
            status_code=status.HTTP_409_CONFLICT,
        )

    if payload.is_default:
        await _unset_other_defaults(db, org_id)

    dumped = payload.model_dump(mode="json")
    dumped["business_unit_ids"] = [to_oid(bid) for bid in payload.business_unit_ids]
    dumped["department_ids"] = [to_oid(did) for did in payload.department_ids]

    await _validate_bu_dept_consistency(
        db, dumped["business_unit_ids"], dumped["department_ids"]
    )

    doc = {
        "org_id": to_oid(org_id),
        **dumped,
        **audit_fields_create(user_id),
    }
    await db[CALENDAR_COLLECTION].insert_one(doc)
    logger.info("Work calendar created", calendar_id=doc["_id"], name=payload.name)
    result = await _get_calendar_detail(db, str(doc["_id"]))

    creator_emp = await db["employees"].find_one({"user_id": to_oid(user_id), "is_deleted": {"$ne": True}})
    if creator_emp and creator_emp.get("work_email"):
        logger.info(
            "Triggering work_calendar_created email",
            to=creator_emp["work_email"],
            creator_name=creator_emp.get("name", ""),
            calendar_name=payload.name,
            calendar_id=str(doc["_id"]),
            tenant_id=str(creator_emp.get("organisation_id", "")),
        )
        await email_events.publish_work_calendar_created(
            creator_email=creator_emp["work_email"],
            creator_name=creator_emp.get("name", ""),
            calendar_name=payload.name,
            calendar_id=str(doc["_id"]),
            tenant_id=str(creator_emp.get("organisation_id", "")),
        )

    new_id = str(doc["_id"])
    await emit_audit(
        action="work_calendar.created",
        resource=f"work_calendar:{new_id}",
        actor_id=user_id,
        organisation_id=str(org_id),
        details={"name": payload.name},
    )

    return result


async def list_calendars(db: AsyncIOMotorDatabase, org_id: str) -> list[dict]:
    pipeline = [
        {"$match": {"org_id": to_oid(org_id), "deleted_on": None}},
        {
            "$lookup": {
                "from": EMP_MAP_COLLECTION,
                "localField": "_id",
                "foreignField": "work_calendar_id",
                "pipeline": [{"$match": {"deleted_on": None}}],
                "as": "_emp_docs",
            }
        },
        {"$addFields": {"employee_count": {"$size": "$_emp_docs"}}},
        {"$project": {"_emp_docs": 0}},
        { "$addFields": {"_id": { "$toString": "$_id" }}},
        {"$sort": {"created_on": -1}},
    ]
    return await db[CALENDAR_COLLECTION].aggregate(pipeline).to_list(length=None)


async def get_calendar(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    *,
    expected_org_id=None,
) -> dict:
    return await _get_calendar_detail(db, calendar_id, expected_org_id=expected_org_id)


async def update_calendar(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    payload: WorkCalendarUpdate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    existing = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    # exclude_unset (not exclude_none) so an FE-supplied ``statutory_config: null``
    # actually clears the stored block — exclude_none would silently drop it
    # and toggling Off would never persist.
    update_data = payload.model_dump(mode="json", exclude_unset=True)
    if not update_data:
        return await _get_calendar_detail(db, calendar_id, expected_org_id=current_user_org_id)

    # Block deactivation while employees or shifts are still attached. Mirrors
    # the FE check; also stops direct API callers that bypass the UI from
    # leaving stranded assignments.
    was_active = existing.get("is_active", True)
    if update_data.get("is_active") is False and was_active:
        emp_count = await db[EMP_MAP_COLLECTION].count_documents(
            {"work_calendar_id": to_oid(calendar_id), "deleted_on": None}
        )
        shift_count = await db["work_calendar_shifts"].count_documents(
            {"calendar_id": calendar_id, "deleted_on": None}
        )
        if emp_count > 0 or shift_count > 0:
            parts: list[str] = []
            if emp_count > 0:
                parts.append(f"{emp_count} employee(s)")
            if shift_count > 0:
                parts.append(f"{shift_count} shift(s)")
            raise DomainException(
                message=f"Cannot deactivate — {' and '.join(parts)} still assigned. Unassign them first.",
                code="ACTIVE_DEPENDENCY",
                status_code=status.HTTP_409_CONFLICT,
            )

    if update_data.get("is_default"):
        await _unset_other_defaults(db, existing["org_id"], except_id=calendar_id)

    # Reject empty BU/dept on update — a calendar with no scope is meaningless
    # and would cascade-unlink every assigned employee and shift assignment.
    # FE blocks this; the BE check closes the gap for direct API callers.
    if "business_unit_ids" in update_data and update_data["business_unit_ids"] is not None and not update_data["business_unit_ids"]:
        raise DomainException(
            message="At least one business unit is required",
            code="EMPTY_BUSINESS_UNIT_SCOPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if "department_ids" in update_data and update_data["department_ids"] is not None and not update_data["department_ids"]:
        raise DomainException(
            message="At least one department is required",
            code="EMPTY_DEPARTMENT_SCOPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if "business_unit_ids" in update_data and update_data["business_unit_ids"] is not None:
        update_data["business_unit_ids"] = [to_oid(bid) for bid in update_data["business_unit_ids"]]
    if "department_ids" in update_data and update_data["department_ids"] is not None:
        update_data["department_ids"] = [to_oid(did) for did in update_data["department_ids"]]

    # Cross-check: every effective dept must map to at least one effective BU.
    # Either side of the pair may come from the payload or the existing calendar.
    bu_in_payload = "business_unit_ids" in update_data and update_data["business_unit_ids"] is not None
    dept_in_payload = "department_ids" in update_data and update_data["department_ids"] is not None
    if bu_in_payload or dept_in_payload:
        effective_bu_oids = (
            update_data["business_unit_ids"]
            if bu_in_payload
            else list(existing.get("business_unit_ids") or [])
        )
        effective_dept_oids = (
            update_data["department_ids"]
            if dept_in_payload
            else list(existing.get("department_ids") or [])
        )
        await _validate_bu_dept_consistency(db, effective_bu_oids, effective_dept_oids)

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[CALENDAR_COLLECTION].update_one({"_id": to_oid(calendar_id)}, {"$set": update_data})
    logger.info("Work calendar updated", calendar_id=calendar_id)
    await emit_audit(
        action="work_calendar.updated",
        resource=f"work_calendar:{calendar_id}",
        actor_id=user_id,
        organisation_id=str(existing["org_id"]),
        changed_fields=changed_fields,
    )
    result = await _get_calendar_detail(db, calendar_id, expected_org_id=current_user_org_id)

    updater_emp = await db["employees"].find_one({"user_id": to_oid(user_id), "is_deleted": {"$ne": True}})
    if updater_emp and updater_emp.get("work_email"):
        logger.info(
            "Triggering work_calendar_updated email",
            to=updater_emp["work_email"],
            updater_name=updater_emp.get("name", ""),
            calendar_name=result.get("name", ""),
            calendar_id=calendar_id,
            tenant_id=str(updater_emp.get("organisation_id", "")),
        )
        await email_events.publish_work_calendar_updated(
            updater_email=updater_emp["work_email"],
            updater_name=updater_emp.get("name", ""),
            calendar_name=result.get("name", ""),
            calendar_id=calendar_id,
            tenant_id=str(updater_emp.get("organisation_id", "")),
        )

    return result


async def delete_calendar(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    user_id: str,
    *,
    current_user_org_id=None,
) -> None:
    existing = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)

    dependencies = []
    emp_count = await db[EMP_MAP_COLLECTION].count_documents(
        {"work_calendar_id": to_oid(calendar_id), "deleted_on": None}
    )
    if emp_count > 0:
        dependencies.append({"type": "employees", "count": emp_count})
    shift_count = await db["work_calendar_shifts"].count_documents(
        {"calendar_id": calendar_id, "deleted_on": None}
    )
    if shift_count > 0:
        dependencies.append({"type": "shifts", "count": shift_count})
    if dependencies:
        raise DomainException(
            message="Cannot delete this work calendar. Active dependencies exist.",
            code="DEPENDENCY_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "Cannot delete this work calendar. Active dependencies exist.", "dependencies": dependencies},
        )

    delete_set = audit_fields_delete(user_id)
    await db[CALENDAR_COLLECTION].update_one({"_id": to_oid(calendar_id)}, {"$set": delete_set})
    logger.info("Work calendar soft-deleted", calendar_id=calendar_id)
    await emit_audit(
        action="work_calendar.deleted",
        resource=f"work_calendar:{calendar_id}",
        actor_id=user_id,
        organisation_id=str(existing["org_id"]),
        details={"name": existing.get("name", "")},
    )


async def list_calendar_employees(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    *,
    expected_org_id=None,
) -> list[dict]:
    """List active employees in the calendar. ``expected_org_id`` enforces
    tenant scoping at the calendar lookup — cross-tenant gets a 404."""
    await _get_calendar_or_raise(db, calendar_id, expected_org_id=expected_org_id)
    docs = await db[EMP_MAP_COLLECTION].find(
        {"work_calendar_id": to_oid(calendar_id), "deleted_on": None}
    ).sort("created_on", -1).to_list(length=None)
    if not docs:
        return docs
    # Keep-but-hide: an employee assigned while active and later deactivated/exited
    # keeps their assignment row, but must NOT surface here or inflate the count.
    # Filter to currently-active employees by their employment status.
    active = await filter_active_user_ids(db, [doc["user_id"] for doc in docs])
    docs = [doc for doc in docs if to_oid(doc["user_id"]) in active]
    # Enrich with name/dept/etc from the LMS mirror so the FE renders directly
    # from this response instead of fetching the whole org from IAM and joining.
    details = await enrich_user_details(db, [doc["user_id"] for doc in docs])
    return [apply_details(doc, details) for doc in docs]


async def cross_calendar_assignments(db: AsyncIOMotorDatabase, calendar_id: str) -> dict:
    """Members of OTHER active work calendars in the same org, as
    ``{items: [{user_id, scope_name}]}``. Replaces the FE's N per-calendar
    fetches (one call instead of one-per-other-calendar) that power the
    'already on calendar X' warning."""
    calendar = await db[CALENDAR_COLLECTION].find_one({"_id": to_oid(calendar_id)})
    if not calendar:
        return {"items": []}
    other = await db[CALENDAR_COLLECTION].find(
        {
            "org_id": calendar.get("org_id"),
            "is_active": True,
            "deleted_on": None,
            "_id": {"$ne": to_oid(calendar_id)},
        },
        {"name": 1},
    ).to_list(length=None)
    if not other:
        return {"items": []}
    name_by_id = {c["_id"]: c.get("name") for c in other}
    rows = await db[EMP_MAP_COLLECTION].find(
        {"work_calendar_id": {"$in": list(name_by_id)}, "deleted_on": None},
        {"user_id": 1, "work_calendar_id": 1},
    ).to_list(length=None)
    if not rows:
        return {"items": []}
    active = await filter_active_user_ids(db, [r["user_id"] for r in rows])
    items = [
        {"user_id": str(r["user_id"]), "scope_name": name_by_id.get(r["work_calendar_id"])}
        for r in rows
        if to_oid(r["user_id"]) in active
    ]
    return {"items": items}


async def _cascade_delete_shift_assignments_for_users(
    db: AsyncIOMotorDatabase,
    calendar_oid,
    user_oids: list,
    _actor_user_id: str,
) -> int:
    """Hard-delete every active shift assignment in ``calendar_oid`` whose
    user appears in ``user_oids``. Matches either ObjectId or legacy str
    storage form. Returns the number of rows deleted."""
    if not user_oids:
        return 0
    remove_match = list(user_oids) + [str(x) for x in user_oids]
    result = await db[SHIFT_ASSIGNMENT_COLLECTION].delete_many(
        {
            "calendar_id": calendar_oid,
            "user_id": {"$in": remove_match},
            "deleted_on": None,
        },
    )
    deleted = result.deleted_count
    if deleted:
        logger.info(
            "Cascade-deleted shift assignments",
            calendar_id=str(calendar_oid),
            user_ids=[str(u) for u in user_oids],
            removed=deleted,
        )
    return deleted


async def sync_calendar_employees(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    user_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """``current_user_org_id`` from the authenticated session is the tenant
    guard — passing a calendar_id from another org yields 404."""
    calendar = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(calendar)
    org_id = calendar["org_id"]

    cal_oid = to_oid(calendar_id)
    existing_docs = await db[EMP_MAP_COLLECTION].find(
        {"work_calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    # Canonical user_id form is ObjectId. Accept ObjectId or str on input and
    # normalize both sides of the diff so set membership doesn't silently flip
    # types and re-insert everyone as the other shape.
    existing_user_ids = {to_oid(doc["user_id"]) for doc in existing_docs}

    desired = {to_oid(uid) for uid in user_ids if uid}
    # Activeness = employment status: never (re)assign a deactivated employee, and
    # never PURGE one already assigned (keep-but-hide). Bound additions to active
    # employees and compute removals against only the active members.
    desired_active = await filter_active_user_ids(db, list(desired))
    active_existing = await filter_active_user_ids(db, list(existing_user_ids))
    to_add = desired_active - existing_user_ids
    to_remove = active_existing - desired_active

    # Cross-scope rule: an employee may belong to only one work calendar.
    # Reject the sync if any user we're about to ADD is already in another calendar.
    await assert_no_cross_scope_assignment(
        db,
        collection=EMP_MAP_COLLECTION,
        scope_field="work_calendar_id",
        scope_value=cal_oid,
        user_oids=list(to_add),
        scope_name_collection=CALENDAR_COLLECTION,
        scope_label=SCOPE_LABEL,
        org_id=org_id,
    )

    added = 0
    removed = 0

    if to_remove:
        # Match either storage form when deleting (ObjectId canonical, str legacy)
        remove_match = list(to_remove) + [str(x) for x in to_remove]
        result = await db[EMP_MAP_COLLECTION].delete_many(
            {"work_calendar_id": cal_oid, "user_id": {"$in": remove_match}, "deleted_on": None},
        )
        removed = result.deleted_count
        # Cascade: removing an employee from a calendar must also kill any
        # shift assignment they had within that calendar. The FE confirm
        # dialog already promises this — make BE deliver.
        await _cascade_delete_shift_assignments_for_users(
            db, cal_oid, list(to_remove), user_id
        )

    if to_add:
        docs = [
            {"work_calendar_id": cal_oid, "org_id": org_id, "user_id": uid, **audit_fields_create(user_id)}
            for uid in to_add
        ]
        await db[EMP_MAP_COLLECTION].insert_many(docs)
        added = len(docs)

        # Best-effort emails, fanned out concurrently. The employee rows are
        # already inserted above — a broker/email failure must never fail or
        # stall the assignment save.
        try:
            calendar_name = calendar.get("name", "")
            emp_docs = await db["employees"].find(
                {"user_id": {"$in": list(to_add)}, "is_deleted": {"$ne": True}}
            ).to_list(length=None)
            publishes = [
                email_events.publish_work_calendar_employee_added(
                    employee_email=emp["work_email"],
                    employee_name=emp.get("name", ""),
                    calendar_name=calendar_name,
                    calendar_id=calendar_id,
                    tenant_id=str(emp.get("organisation_id", "")),
                )
                for emp in emp_docs
                if emp.get("work_email")
            ]
            if publishes:
                await asyncio.gather(*publishes)
        except Exception:
            logger.warning(
                "Failed to publish work calendar employee emails (employees saved)",
                calendar_id=calendar_id,
                exc_info=True,
            )

    logger.info("Work calendar employees synced", calendar_id=calendar_id, added=added, removed=removed)
    _audit_kwargs = {
        "action": "work_calendar_employee.synced",
        "resource": f"work_calendar:{calendar_id}",
        "actor_id": user_id,
        "organisation_id": str(org_id),
        "details": {"added": added, "removed": removed, "total": len(desired_active)},
    }
    await emit_activity(**_audit_kwargs)
    await emit_audit(**_audit_kwargs)
    return {"added": added, "removed": removed, "total": len(desired_active)}


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
    calendar's scope, so we constrain to the calendar's own BUs.

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


async def sync_calendar_employees_by_departments(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    department_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Replace calendar's employee set with everyone in the given departments."""
    cal = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(cal)
    user_ids = await _resolve_user_ids_by_departments(
        db, department_ids, cal["org_id"], cal.get("business_unit_ids")
    )
    return await sync_calendar_employees(
        db, calendar_id, user_ids, user_id, current_user_org_id=current_user_org_id
    )


async def add_calendar_employees(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    user_ids: list[str],
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """Add employees to calendar without removing existing ones.

    ``current_user_org_id`` (from session) is the tenant guard."""
    calendar = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(calendar)
    org_id = calendar["org_id"]

    cal_oid = to_oid(calendar_id)
    # Canonical comparison form is ObjectId. Normalize both sides so duplicate
    # detection works whether existing rows are stored as ObjectId or str.
    desired_oids = [to_oid(uid) for uid in user_ids if uid]

    existing_docs = await db[EMP_MAP_COLLECTION].find(
        {"work_calendar_id": cal_oid, "deleted_on": None}
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

    # Cross-scope rule: filter out users already assigned to another calendar
    # instead of failing the entire batch. Conflicting users are counted as
    # skipped so the caller knows how many were excluded.
    if to_add:
        conflicting = await find_cross_scope_conflicts(
            db,
            collection=EMP_MAP_COLLECTION,
            scope_field="work_calendar_id",
            scope_value=cal_oid,
            user_oids=to_add,
            scope_name_collection=CALENDAR_COLLECTION,
            scope_label=SCOPE_LABEL,
            org_id=org_id,
        )
        if conflicting:
            to_add = [oid for oid in to_add if oid not in conflicting]
            skipped += len(conflicting)

    added = 0
    if to_add:
        docs = [
            {"work_calendar_id": cal_oid, "org_id": org_id, "user_id": oid, **audit_fields_create(user_id)}
            for oid in to_add
        ]
        await db[EMP_MAP_COLLECTION].insert_many(docs)
        added = len(docs)

        calendar_name = calendar.get("name", "")
        emp_docs = await db["employees"].find(
            {"user_id": {"$in": to_add}, "is_deleted": {"$ne": True}}
        ).to_list(length=None)
        for emp in emp_docs:
            if emp.get("work_email"):
                logger.info(
                    "Triggering work_calendar_employee_added email",
                    to=emp["work_email"],
                    employee_name=emp.get("name", ""),
                    calendar_name=calendar_name,
                    calendar_id=calendar_id,
                    tenant_id=str(emp.get("organisation_id", "")),
                )
                await email_events.publish_work_calendar_employee_added(
                    employee_email=emp["work_email"],
                    employee_name=emp.get("name", ""),
                    calendar_name=calendar_name,
                    calendar_id=calendar_id,
                    tenant_id=str(emp.get("organisation_id", "")),
                )

    logger.info("Bulk add work calendar employees", calendar_id=calendar_id, added=added, skipped=skipped)
    _audit_kwargs = {
        "action": "work_calendar_employee.added",
        "resource": f"work_calendar:{calendar_id}",
        "actor_id": user_id,
        "organisation_id": str(org_id),
        "details": {"added": added, "skipped": skipped, "total": len(existing_set) + added},
    }
    await emit_activity(**_audit_kwargs)
    await emit_audit(**_audit_kwargs)
    return {"added": added, "skipped": skipped, "total": len(existing_set) + added}


async def get_employee_work_calendar(
    db: AsyncIOMotorDatabase,
    employee_id: str,
    org_id: str,
) -> dict | None:
    """Resolve the work calendar assigned to an employee.

    Resolution order:
      1. Direct assignment in work_calendar_employees
      2. Org default calendar (is_default=True)
      3. First active calendar in the org
    Returns None if no calendar is found.
    """
    org_oid = to_oid(org_id)
    emp_oid = to_oid(employee_id)

    assignment = await db[EMP_MAP_COLLECTION].find_one(
        {"user_id": {"$in": [emp_oid, str(employee_id)]}, "deleted_on": None}
    )
    if assignment:
        cal = await db[CALENDAR_COLLECTION].find_one(
            {"_id": assignment["work_calendar_id"], "is_active": True, "deleted_on": None}
        )
        if cal:
            return {
                "calendar_id": str(cal["_id"]),
                "calendar_name": cal.get("name", ""),
                "weekend_matrix": cal.get("weekend_matrix", {}),
                "week_config": cal.get("week_config", {}),
                "start_date": cal.get("start_date"),
                "end_date": cal.get("end_date"),
            }

    default_cal = await db[CALENDAR_COLLECTION].find_one(
        {"org_id": org_oid, "is_default": True, "is_active": True, "deleted_on": None}
    )
    if not default_cal:
        default_cal = await db[CALENDAR_COLLECTION].find_one(
            {"org_id": org_oid, "is_active": True, "deleted_on": None},
            sort=[("created_on", -1)],
        )
    if default_cal:
        return {
            "calendar_id": str(default_cal["_id"]),
            "calendar_name": default_cal.get("name", ""),
            "weekend_matrix": default_cal.get("weekend_matrix", {}),
            "week_config": default_cal.get("week_config", {}),
            "start_date": default_cal.get("start_date"),
            "end_date": default_cal.get("end_date"),
        }

    return None


