import uuid

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.logger import logger
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update
from src.utils import to_oid
from src.work_calendar.service import (
    CALENDAR_COLLECTION,
    SHIFT_ASSIGNMENT_COLLECTION,
    _assert_calendar_active,
)
from src.work_calendar.shifts_schemas import ShiftCreate, ShiftUpdate

SHIFT_COLLECTION = "work_calendar_shifts"


async def _get_calendar_or_raise(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    *,
    expected_org_id=None,
) -> dict:
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


async def _get_shift_or_raise(
    db: AsyncIOMotorDatabase,
    shift_id: str,
    *,
    expected_org_id=None,
) -> dict:
    query: dict = {"_id": shift_id, "deleted_on": None}
    if expected_org_id:
        query["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    doc = await db[SHIFT_COLLECTION].find_one(query)
    if not doc:
        raise DomainException(
            message="Shift not found",
            code="SHIFT_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def create_shift(
    db: AsyncIOMotorDatabase,
    payload: ShiftCreate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    calendar = await _get_calendar_or_raise(db, payload.calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(calendar)

    existing = await db[SHIFT_COLLECTION].find_one(
        {"calendar_id": payload.calendar_id, "name": payload.name, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"A shift named '{payload.name}' already exists for this calendar",
            code="DUPLICATE_SHIFT",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "_id": str(uuid.uuid4()),
        **payload.model_dump(mode="json"),
        "org_id": calendar["org_id"],
        **audit_fields_create(user_id),
    }
    await db[SHIFT_COLLECTION].insert_one(doc)
    logger.info("Shift created", shift_id=doc["_id"], calendar_id=payload.calendar_id)
    await emit_audit(
        action="shift.created",
        resource=f"shift:{doc['_id']}",
        actor_id=user_id,
        organisation_id=str(calendar["org_id"]),
        details={"name": payload.name, "calendar_id": payload.calendar_id},
    )
    return doc


async def get_shift(
    db: AsyncIOMotorDatabase,
    shift_id: str,
    *,
    expected_org_id=None,
) -> dict:
    return await _get_shift_or_raise(db, shift_id, expected_org_id=expected_org_id)


async def list_shifts_by_calendar(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    *,
    expected_org_id=None,
) -> list[dict]:
    await _get_calendar_or_raise(db, calendar_id, expected_org_id=expected_org_id)
    cursor = db[SHIFT_COLLECTION].find(
        {"calendar_id": calendar_id, "deleted_on": None}
    ).sort("created_on", 1)
    return await cursor.to_list(length=None)


async def update_shift(
    db: AsyncIOMotorDatabase,
    shift_id: str,
    payload: ShiftUpdate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    existing = await _get_shift_or_raise(db, shift_id, expected_org_id=current_user_org_id)
    # Guard: cannot mutate shifts on an inactive calendar.
    calendar = await _get_calendar_or_raise(
        db, existing["calendar_id"], expected_org_id=current_user_org_id
    )
    _assert_calendar_active(calendar)
    update_data = payload.model_dump(mode="json", exclude_none=True)
    if not update_data:
        return existing

    if "name" in update_data and update_data["name"] != existing["name"]:
        clash = await db[SHIFT_COLLECTION].find_one(
            {
                "calendar_id": existing["calendar_id"],
                "name": update_data["name"],
                "deleted_on": None,
                "_id": {"$ne": shift_id},
            }
        )
        if clash:
            raise DomainException(
                message=f"A shift named '{update_data['name']}' already exists for this calendar",
                code="DUPLICATE_SHIFT",
                status_code=status.HTTP_409_CONFLICT,
            )

    merged_start = update_data.get("start_time", existing["start_time"])
    merged_end = update_data.get("end_time", existing["end_time"])
    if merged_start == merged_end:
        raise DomainException(
            message="start_time and end_time must differ",
            code="INVALID_SHIFT_TIMES",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[SHIFT_COLLECTION].update_one({"_id": shift_id}, {"$set": update_data})
    logger.info("Shift updated", shift_id=shift_id)
    await emit_audit(
        action="shift.updated",
        resource=f"shift:{shift_id}",
        actor_id=user_id,
        organisation_id=str(calendar["org_id"]),
        changed_fields=changed_fields,
    )
    return await _get_shift_or_raise(db, shift_id)


async def delete_shift(
    db: AsyncIOMotorDatabase,
    shift_id: str,
    user_id: str,
    *,
    current_user_org_id=None,
) -> None:
    existing = await _get_shift_or_raise(db, shift_id, expected_org_id=current_user_org_id)
    # Guard: cannot delete shifts on an inactive calendar.
    calendar = await _get_calendar_or_raise(
        db, existing["calendar_id"], expected_org_id=current_user_org_id
    )
    _assert_calendar_active(calendar)

    delete_set = audit_fields_delete(user_id)
    await db[SHIFT_COLLECTION].update_one({"_id": shift_id}, {"$set": delete_set})

    # Cascade: hard-delete every shift assignment that referenced this shift.
    # The FE confirm dialog at WorkCalendarForm.tsx:1266 already tells the user
    # this will happen — make BE deliver. Match by shift_id string (assignments
    # store the shift's str _id).
    cascade_result = await db[SHIFT_ASSIGNMENT_COLLECTION].delete_many(
        {"shift_id": shift_id, "deleted_on": None},
    )
    if cascade_result.deleted_count:
        logger.info(
            "Cascade-deleted shift assignments",
            shift_id=shift_id,
            calendar_id=str(existing.get("calendar_id")),
            removed=cascade_result.deleted_count,
        )

    logger.info("Shift soft-deleted", shift_id=shift_id)
    await emit_audit(
        action="shift.deleted",
        resource=f"shift:{shift_id}",
        actor_id=user_id,
        organisation_id=str(calendar["org_id"]),
        details={"name": existing.get("name", ""), "calendar_id": str(existing.get("calendar_id"))},
    )
