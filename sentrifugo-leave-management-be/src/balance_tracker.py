from datetime import datetime, timezone
from typing import Optional

from src.utils import to_oid
from motor.motor_asyncio import AsyncIOMotorDatabase

TRACKER_COLLECTION = "leave_employee_balance_tracker"


async def upsert_balance(
    db: AsyncIOMotorDatabase,
    user_id_key: str,
    leave_type_id: str,
    leave_plan_id: Optional[str],
    delta_hours: float,
    actor_id: str,
    now: Optional[datetime] = None,
) -> None:
    if now is None:
        now = datetime.now(timezone.utc)
    set_fields: dict = {"updated_on": now, "updated_by": actor_id}
    if leave_plan_id is not None:
        set_fields["leave_plan_id"] = leave_plan_id
    await db[TRACKER_COLLECTION].update_one(
        {"user_id": to_oid(user_id_key), "leave_type_id": to_oid(leave_type_id)},
        {
            "$inc": {"balance_hours": delta_hours},
            "$set": set_fields,
            "$setOnInsert": {
                "user_id": to_oid(user_id_key),
                "leave_type_id": to_oid(leave_type_id),
                "created_on": now,
                "created_by": actor_id,
            },
        },
        upsert=True,
    )


async def get_balance_from_tracker(
    db: AsyncIOMotorDatabase,
    user_id_key: str,
    leave_type_id: str,
) -> Optional[float]:
    doc = await db[TRACKER_COLLECTION].find_one(
        {"user_id": to_oid(user_id_key), "leave_type_id": to_oid(leave_type_id)}
    )
    if not doc:
        return None
    return max(doc.get("balance_hours", 0.0), 0.0)


async def get_raw_balance_unclamped(
    db: AsyncIOMotorDatabase,
    user_id_key: str,
    leave_type_id: str,
) -> float:
    """The true tracker balance WITHOUT clamping to zero — so a negative balance
    (e.g. from an 'extra leave' buffer that went past zero) is reflected. Used by
    the extra-leave sufficiency check so the buffer can't be reused indefinitely."""
    doc = await db[TRACKER_COLLECTION].find_one(
        {"user_id": to_oid(user_id_key), "leave_type_id": to_oid(leave_type_id)}
    )
    return (doc.get("balance_hours", 0.0) if doc else 0.0) or 0.0


async def get_available_balance(
    db: AsyncIOMotorDatabase,
    user_id_key: str,
    leave_type_id: str,
    exclude_request_id: Optional[str] = None,
) -> float:
    """Spendable balance = credited/approved balance minus ACTIVE holds.

    This is what validation and balance surfaces should use: a pending request
    reserves (holds) its hours immediately, so they are not available to other
    requests until the hold is released or converted on approval.
    """
    from src.leave_holds.service import get_active_hold_hours

    raw = await get_balance_from_tracker(db, user_id_key, leave_type_id) or 0.0
    held = await get_active_hold_hours(db, user_id_key, leave_type_id, exclude_request_id)
    return raw - held
