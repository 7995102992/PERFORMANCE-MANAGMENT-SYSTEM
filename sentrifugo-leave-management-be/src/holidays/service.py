from datetime import date as date_type

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import OperationFailure
from src.utils import to_oid
from src.audit import emit_audit
from src.exceptions import DomainException
from src.holidays.schemas import HolidayCreate, HolidayUpdate
from src.logger import logger
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update

COLLECTION = "holidays"

_CLASSIFICATION_LOOKUP = [
    {"$lookup": {
        "from": "holiday_classifications",
        "localField": "classification_id",
        "foreignField": "_id",
        "as": "_cls",
    }},
    {"$addFields": {
        "classification": {"$arrayElemAt": ["$_cls", 0]},
        # Back-compat: lift legacy singular ``business_unit_id`` onto the
        # plural list whenever the new field is missing or empty so callers
        # can read a uniform shape during/after the migration window.
        "business_unit_ids": {
            "$cond": [
                {"$gt": [{"$size": {"$ifNull": ["$business_unit_ids", []]}}, 0]},
                "$business_unit_ids",
                {
                    "$cond": [
                        {"$ifNull": ["$business_unit_id", False]},
                        ["$business_unit_id"],
                        [],
                    ]
                },
            ]
        },
    }},
    {"$project": {"_cls": 0}},
]


def _coerce_business_unit_ids(holiday: dict) -> dict:
    """In-Python back-compat: ensure ``business_unit_ids`` is populated from
    the legacy singular field when reading a raw cursor doc (not via the
    aggregation pipeline above), and that every entry is an ObjectId."""
    if not holiday:
        return holiday
    bu_ids = holiday.get("business_unit_ids")
    if not bu_ids and holiday.get("business_unit_id") is not None:
        bu_ids = [holiday["business_unit_id"]]
    # Normalize to ObjectId. ``to_oid`` is idempotent on ObjectIds and accepts
    # 24-hex strings, so this safely handles any legacy mixed-type docs.
    if bu_ids:
        holiday["business_unit_ids"] = [to_oid(b) for b in bu_ids]
    return holiday


async def _validate_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    *,
    expected_org_id=None,
) -> dict:
    """Resolve the plan. When ``expected_org_id`` is given, the plan must
    belong to that org or we 404 (prevents cross-tenant access)."""
    query: dict = {"_id": to_oid(plan_id), "deleted_on": None}
    if expected_org_id:
        query["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    plan = await db["holiday_plans"].find_one(query)
    if not plan:
        raise DomainException(
            message="Holiday plan not found",
            code="PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return plan


def _assert_plan_active(plan: dict) -> None:
    """Reject mutations on an inactive holiday plan.

    Reads are still permitted — only state-changing operations (create / update
    / delete / bulk import / scope sync) should call this guard.
    """
    if plan.get("is_active") is False:
        logger.warning(
            "Mutation rejected on inactive plan",
            plan_id=plan.get("_id"),
        )
        raise DomainException(
            message="Cannot mutate holidays: the holiday plan is inactive.",
            code="INACTIVE_PLAN",
            status_code=status.HTTP_409_CONFLICT,
        )


def _assert_holiday_within_plan_scope(
    plan: dict,
    bu_ids: list,
    dept_ids: list,
) -> None:
    """Ensure every BU / dept on a holiday is inside the plan's own scope.

    The plan defines which BUs and depts are valid for its holidays; the
    holiday itself can only narrow that set, never extend it.

    ``bu_ids`` / ``dept_ids`` may be raw strings or ObjectIds. ``to_oid`` is
    idempotent on ObjectIds and accepts 24-hex strings, so it safely
    normalises both sides of the comparison.
    """
    plan_bu_set = {str(to_oid(b)) for b in (plan.get("business_unit_ids") or [])}
    plan_dept_set = {str(to_oid(d)) for d in (plan.get("department_ids") or [])}

    if bu_ids:
        out_of_scope = [str(to_oid(b)) for b in bu_ids if str(to_oid(b)) not in plan_bu_set]
        if out_of_scope:
            raise DomainException(
                message=(
                    "One or more business unit IDs are outside the plan's scope. "
                    "Holidays can only target business units already on the plan."
                ),
                code="HOLIDAY_BU_OUT_OF_PLAN_SCOPE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    if dept_ids:
        out_of_scope = [str(to_oid(d)) for d in dept_ids if str(to_oid(d)) not in plan_dept_set]
        if out_of_scope:
            raise DomainException(
                message=(
                    "One or more department IDs are outside the plan's scope. "
                    "Holidays can only target departments already on the plan."
                ),
                code="HOLIDAY_DEPT_OUT_OF_PLAN_SCOPE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )


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
) -> None:
    if not dept_ids:
        return
    department_oids = [to_oid(dept_id) for dept_id in dept_ids]
    count = await db["departments"].count_documents(
        {"_id": {"$in": department_oids}, "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
    )
    if count != len(dept_ids):
        raise DomainException(
            message="One or more department IDs are invalid",
            code="INVALID_DEPARTMENT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def _validate_classification_id(
    db: AsyncIOMotorDatabase, classification_id: str
) -> None:
    exists = await db["holiday_classifications"].find_one(
        {"_id": to_oid(classification_id), "deleted_on": None}
    )
    if not exists:
        raise DomainException(
            message="Classification not found",
            code="INVALID_CLASSIFICATION",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def _get_holiday_with_lookup(
    db: AsyncIOMotorDatabase,
    holiday_id: str,
    *,
    expected_org_id=None,
) -> dict:
    match: dict = {"_id": to_oid(holiday_id), "deleted_on": None}
    if expected_org_id:
        match["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    pipeline = [
        {"$match": match},
        *_CLASSIFICATION_LOOKUP,
    ]
    results = await db[COLLECTION].aggregate(pipeline).to_list(1)
    if not results:
        raise DomainException(
            message="Holiday not found",
            code="HOLIDAY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return results[0]


async def create_holiday(
    db: AsyncIOMotorDatabase, payload: HolidayCreate, org_id: str, user_id: str
) -> dict:
    plan = await _validate_plan(db, payload.plan_id)
    _assert_plan_active(plan)

    if payload.date.year != plan["year"]:
        raise DomainException(
            message=f"Holiday date must be within plan year {plan['year']}",
            code="INVALID_HOLIDAY_DATE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    existing = await db[COLLECTION].find_one(
        {"plan_id": to_oid(payload.plan_id), "date": payload.date.isoformat(), "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"A holiday already exists on {payload.date} for this plan",
            code="DUPLICATE_HOLIDAY",
            status_code=status.HTTP_409_CONFLICT,
        )

    business_unit_oids = await _validate_business_unit_ids(db, org_id, payload.business_unit_ids)
    await _validate_department_ids(db, org_id, payload.applicable_department_ids)
    await _validate_classification_id(db, payload.classification_id)
    _assert_holiday_within_plan_scope(
        plan,
        payload.business_unit_ids,
        payload.applicable_department_ids,
    )

    doc = {
        **payload.model_dump(mode="json"),
        "classification_id": to_oid(payload.classification_id),
        "business_unit_ids": business_unit_oids,
        "applicable_department_ids": [to_oid(d) for d in payload.applicable_department_ids],
        "plan_id": to_oid(payload.plan_id),
        "org_id": to_oid(org_id),
        **audit_fields_create(user_id),
    }
    await db[COLLECTION].insert_one(doc)
    logger.info("Holiday created", holiday_id=doc["_id"], name=payload.name)
    await emit_audit(
        action="holiday.created",
        resource=f"holiday:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"name": payload.name},
    )
    return await _get_holiday_with_lookup(db, str(doc["_id"]))


async def bulk_import_holidays(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    holidays: list,
    org_id: str,
    user_id: str,
) -> dict:
    plan = await _validate_plan(db, plan_id, expected_org_id=org_id)
    _assert_plan_active(plan)
    plan_oid = to_oid(plan_id)

    existing_dates = set()
    cursor = db[COLLECTION].find(
        {"plan_id": plan_oid, "deleted_on": None},
        {"date": 1},
    )
    async for doc in cursor:
        existing_dates.add(doc["date"])

    imported = 0
    skipped_dates = []

    for h in holidays:
        date_iso = h.date.isoformat()
        if date_iso in existing_dates:
            skipped_dates.append(date_iso)
            continue
        if h.date.year != plan["year"]:
            skipped_dates.append(date_iso)
            continue

        business_unit_oids = await _validate_business_unit_ids(db, org_id, h.business_unit_ids)
        await _validate_department_ids(db, org_id, h.applicable_department_ids)
        _assert_holiday_within_plan_scope(
            plan,
            h.business_unit_ids,
            h.applicable_department_ids,
        )
        doc = {
            "name": h.name,
            "date": date_iso,
            "classification_id": to_oid(h.classification_id),
            "business_unit_ids": business_unit_oids,
            "applicable_department_ids": [to_oid(d) for d in h.applicable_department_ids],
            "plan_id": plan_oid,
            "org_id": to_oid(org_id),
            "reminder": {"enabled": False, "days_before": 2},
            **audit_fields_create(user_id),
        }
        await db[COLLECTION].insert_one(doc)
        existing_dates.add(date_iso)
        imported += 1

    logger.info("Bulk holiday import", plan_id=plan_id, imported=imported, skipped=len(skipped_dates))
    await emit_audit(
        action="holiday.imported",
        resource=f"holiday_plan:{plan_id}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"count": imported},
    )
    return {"imported": imported, "skipped": len(skipped_dates), "skipped_dates": skipped_dates}


async def get_holidays_by_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    page: int,
    page_size: int,
    *,
    expected_org_id=None,
) -> tuple[list[dict], int]:
    await _validate_plan(db, plan_id, expected_org_id=expected_org_id)
    query = {"plan_id": to_oid(plan_id), "deleted_on": None}
    total = await db[COLLECTION].count_documents(query)
    pipeline = [
        {"$match": query},
        {"$sort": {"date": 1}},
        {"$skip": (page - 1) * page_size},
        {"$limit": page_size},
        *_CLASSIFICATION_LOOKUP,
    ]
    items = await db[COLLECTION].aggregate(pipeline).to_list(length=page_size)
    return items, total


async def get_holidays_by_date_range(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    org_id: str,
    from_date: "date_type",
    to_date: "date_type"
) -> list[dict]:
    if from_date > to_date:
        raise DomainException(
            message="from_date must not be after to_date",
            code="INVALID_DATE_RANGE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    pipeline = [
        {"$match": {
            "org_id": to_oid(org_id),
            "deleted_on": None,
            "plan_id": to_oid(plan_id),
            "date": {"$gte": from_date.isoformat(), "$lte": to_date.isoformat()},
        }},
        {"$sort": {"date": 1}},
        *_CLASSIFICATION_LOOKUP,
    ]
    return await db[COLLECTION].aggregate(pipeline).to_list(length=None)


async def get_holiday(db: AsyncIOMotorDatabase, holiday_id: str) -> dict:
    return await _get_holiday_with_lookup(db, holiday_id)


async def update_holiday(
    db: AsyncIOMotorDatabase,
    holiday_id: str,
    payload: HolidayUpdate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    existing = await _get_holiday_with_lookup(db, holiday_id, expected_org_id=current_user_org_id)

    # exclude_unset (not exclude_none): callers must be able to clear nullable
    # fields like ``description`` by explicitly sending ``null``. Using
    # exclude_none would silently drop those nulls and never persist the clear.
    update_data = payload.model_dump(exclude_unset=True, mode="json")
    if not update_data:
        return existing

    plan = await _validate_plan(db, existing["plan_id"], expected_org_id=current_user_org_id)
    _assert_plan_active(plan)
    org_id = plan["org_id"]

    # Note: we use ``exclude_unset`` above so callers can clear nullable scalars
    # like ``description`` by sending ``null``. The non-nullable / list / FK
    # fields below treat an explicit ``null`` as "not provided" so the previous
    # ``exclude_none`` semantics are preserved for them.
    if update_data.get("date") is not None and "date" in update_data:
        new_date = date_type.fromisoformat(update_data["date"]) if isinstance(update_data["date"], str) else update_data["date"]
        if new_date.year != plan["year"]:
            raise DomainException(
                message=f"Holiday date must be within plan year {plan['year']}",
                code="INVALID_HOLIDAY_DATE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
    elif "date" in update_data and update_data["date"] is None:
        update_data.pop("date")

    if "classification_id" in update_data:
        if update_data["classification_id"] is None:
            update_data.pop("classification_id")
        else:
            await _validate_classification_id(db, update_data["classification_id"])
            update_data["classification_id"] = to_oid(update_data["classification_id"])
    if "business_unit_ids" in update_data:
        if update_data["business_unit_ids"] is None:
            update_data.pop("business_unit_ids")
        else:
            if len(update_data["business_unit_ids"]) < 1:
                raise DomainException(
                    message="At least one business unit ID is required",
                    code="INVALID_BUSINESS_UNIT",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            update_data["business_unit_ids"] = await _validate_business_unit_ids(
                db, org_id, update_data["business_unit_ids"]
            )
    if "applicable_department_ids" in update_data:
        if update_data["applicable_department_ids"] is None:
            update_data.pop("applicable_department_ids")
        else:
            if len(update_data["applicable_department_ids"]) < 1:
                raise DomainException(
                    message="At least one department ID is required",
                    code="INVALID_DEPARTMENT",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            await _validate_department_ids(db, org_id, update_data["applicable_department_ids"])
            update_data["applicable_department_ids"] = [to_oid(d) for d in update_data["applicable_department_ids"]]

    # Plan-scope check on whichever axes are being changed. Use the post-update
    # value when present, else fall back to the existing stored value so a
    # partial update doesn't escape the scope check on the unchanged axis.
    if "business_unit_ids" in update_data or "applicable_department_ids" in update_data:
        effective_bus = (
            update_data["business_unit_ids"]
            if "business_unit_ids" in update_data
            else existing.get("business_unit_ids") or []
        )
        effective_depts = (
            update_data["applicable_department_ids"]
            if "applicable_department_ids" in update_data
            else existing.get("applicable_department_ids") or []
        )
        _assert_holiday_within_plan_scope(plan, effective_bus, effective_depts)

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[COLLECTION].update_one({"_id": to_oid(holiday_id)}, {"$set": update_data})
    logger.info("Holiday updated", holiday_id=holiday_id)
    await emit_audit(
        action="holiday.updated",
        resource=f"holiday:{holiday_id}",
        actor_id=user_id,
        organisation_id=org_id,
        changed_fields=changed_fields,
    )
    return await _get_holiday_with_lookup(db, holiday_id)


async def delete_holiday(
    db: AsyncIOMotorDatabase,
    holiday_id: str,
    user_id: str,
    *,
    current_user_org_id=None,
) -> None:
    existing = await _get_holiday_with_lookup(db, holiday_id, expected_org_id=current_user_org_id)
    plan = await _validate_plan(db, existing["plan_id"], expected_org_id=current_user_org_id)
    _assert_plan_active(plan)
    await db[COLLECTION].update_one(
        {"_id": to_oid(holiday_id)}, {"$set": audit_fields_delete(user_id)}
    )
    logger.info("Holiday soft-deleted", holiday_id=holiday_id)
    await emit_audit(
        action="holiday.deleted",
        resource=f"holiday:{holiday_id}",
        actor_id=user_id,
        organisation_id=plan["org_id"],
    )


async def sync_holidays_scope(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    extend: list[str],
    trim: list[str],
    *,
    bu_extend: list[str] | None = None,
    bu_trim: list[str] | None = None,
    org_id: str,
    user_id: str,
) -> dict:
    """Bulk-update ``applicable_department_ids`` and/or ``business_unit_ids``
    on every holiday in a plan.

    Semantics (applied per axis — dept and BU mirror each other):
      1. For each holiday, apply ``extend`` (append new IDs, dedup).
      2. Then apply ``trim`` (remove listed IDs).
      3. If trimming would leave the axis empty and the original list was
         non-empty, **skip the update entirely** for that axis on that holiday
         and count it as ``orphaned`` / ``bu_orphaned``. This avoids silently
         turning a real holiday into one with no applicable employees.
      4. Extend IDs must already be in the plan's ``department_ids`` /
         ``business_unit_ids`` — the plan defines scope, you can't extend a
         holiday beyond it.

    Both axes are evaluated and persisted in the same write per holiday inside
    a single transaction so a mid-flight failure rolls back every prior update.

    Returns counts of how many holidays were touched in each direction for
    each axis.
    """
    bu_extend = bu_extend or []
    bu_trim = bu_trim or []

    plan = await _validate_plan(db, plan_id, expected_org_id=org_id)
    _assert_plan_active(plan)
    plan_oid = to_oid(plan_id)

    plan_dept_oids = {str(d) for d in plan.get("department_ids", [])}
    plan_bu_oids = {str(b) for b in plan.get("business_unit_ids", [])}

    if extend:
        # Each extended dept must be a valid org dept AND inside the plan's scope.
        await _validate_department_ids(db, org_id, extend)
        out_of_scope = [d for d in extend if d not in plan_dept_oids]
        if out_of_scope:
            raise DomainException(
                message="Cannot extend holidays to a department that is not in the plan",
                code="EXTEND_OUT_OF_PLAN_SCOPE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    if trim:
        # Validate IDs exist for this org so a typo doesn't silently no-op.
        await _validate_department_ids(db, org_id, trim)

    if bu_extend:
        # Each extended BU must be a valid org BU AND inside the plan's scope.
        await _validate_business_unit_ids(db, org_id, bu_extend)
        bu_out_of_scope = [b for b in bu_extend if b not in plan_bu_oids]
        if bu_out_of_scope:
            raise DomainException(
                message="Cannot extend holidays to a business unit that is not in the plan",
                code="EXTEND_OUT_OF_PLAN_BU_SCOPE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    if bu_trim:
        await _validate_business_unit_ids(db, org_id, bu_trim)

    extend_oids = [to_oid(d) for d in extend]
    trim_oid_set = {to_oid(d) for d in trim}
    bu_extend_oids = [to_oid(b) for b in bu_extend]
    bu_trim_oid_set = {to_oid(b) for b in bu_trim}
    audit = audit_fields_update(user_id)

    async def _apply(session) -> dict:
        """Iterate plan holidays and apply extend/trim across both axes under
        an optional transaction. Passing ``session=None`` runs non-transactionally."""
        extended_count = 0
        trimmed_count = 0
        orphaned_count = 0
        bu_extended_count = 0
        bu_trimmed_count = 0
        bu_orphaned_count = 0
        cursor = db[COLLECTION].find(
            {"plan_id": plan_oid, "deleted_on": None},
            session=session,
        )
        async for holiday in cursor:
            holiday = _coerce_business_unit_ids(holiday)

            # ---- Dept axis ----
            # Defensive coerce: ``to_oid`` is idempotent on ObjectIds and
            # accepts 24-hex strings, so legacy/mixed-type storage compares
            # consistently against ``extend_oids`` / ``trim_oid_set``.
            current_dept: list = [
                to_oid(d) for d in (holiday.get("applicable_department_ids") or [])
            ]
            after_extend = list(current_dept)
            for d in extend_oids:
                if d not in after_extend:
                    after_extend.append(d)
            did_extend = len(after_extend) != len(current_dept)

            if trim_oid_set:
                after_trim = [d for d in after_extend if d not in trim_oid_set]
            else:
                after_trim = after_extend
            did_trim = len(after_trim) != len(after_extend)

            dept_orphaned = did_trim and not after_trim and bool(current_dept)
            apply_dept_change = (did_extend or did_trim) and not dept_orphaned

            # ---- BU axis ----
            # ``_coerce_business_unit_ids`` already normalized the field to a
            # list of ObjectIds (and lifted the legacy singular if present).
            current_bu: list = list(holiday.get("business_unit_ids") or [])
            bu_after_extend = list(current_bu)
            for b in bu_extend_oids:
                if b not in bu_after_extend:
                    bu_after_extend.append(b)
            bu_did_extend = len(bu_after_extend) != len(current_bu)

            if bu_trim_oid_set:
                bu_after_trim = [b for b in bu_after_extend if b not in bu_trim_oid_set]
            else:
                bu_after_trim = bu_after_extend
            bu_did_trim = len(bu_after_trim) != len(bu_after_extend)

            bu_orphaned = bu_did_trim and not bu_after_trim and bool(current_bu)
            apply_bu_change = (bu_did_extend or bu_did_trim) and not bu_orphaned

            # Build a single $set so both axes commit together per holiday.
            set_doc: dict = {}
            if apply_dept_change:
                set_doc["applicable_department_ids"] = after_trim
            if apply_bu_change:
                set_doc["business_unit_ids"] = bu_after_trim

            if set_doc:
                set_doc.update(audit)
                await db[COLLECTION].update_one(
                    {"_id": holiday["_id"]},
                    {"$set": set_doc},
                    session=session,
                )

            if apply_dept_change:
                if did_extend:
                    extended_count += 1
                if did_trim:
                    trimmed_count += 1
            if dept_orphaned:
                orphaned_count += 1

            if apply_bu_change:
                if bu_did_extend:
                    bu_extended_count += 1
                if bu_did_trim:
                    bu_trimmed_count += 1
            if bu_orphaned:
                bu_orphaned_count += 1

        return {
            "extended": extended_count,
            "trimmed": trimmed_count,
            "orphaned": orphaned_count,
            "bu_extended": bu_extended_count,
            "bu_trimmed": bu_trimmed_count,
            "bu_orphaned": bu_orphaned_count,
        }

    # Wrap in a transaction so a mid-flight failure rolls back every prior
    # update in this call. Falls back to non-transactional mode on standalone
    # Mongo (no replica set) since transactions require RS / mongos.
    try:
        async with await db.client.start_session() as session:
            async with session.start_transaction():
                result = await _apply(session)
    except OperationFailure as e:
        # 20 = "Transaction numbers are only allowed on a replica set member or mongos"
        # 263 = "Transaction not supported"
        if e.code in (20, 263) or "replica set" in str(e).lower():
            logger.warning(
                "Mongo does not support transactions — running sync non-transactionally. "
                "A mid-flight failure can leave partial updates. Configure a replica set to enable rollback.",
                plan_id=plan_id,
            )
            result = await _apply(session=None)
        else:
            raise

    logger.info(
        "Holiday scope sync",
        plan_id=plan_id,
        **result,
    )
    await emit_audit(
        action="holiday.scope_synced",
        resource=f"holiday_plan:{plan_id}",
        actor_id=user_id,
        organisation_id=org_id,
        details=result,
    )
    return result
