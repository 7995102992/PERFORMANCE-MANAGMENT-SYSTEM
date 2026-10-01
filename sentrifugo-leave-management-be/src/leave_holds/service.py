"""Leave balance holds.

When an employee submits a balance-deducting (non-LOP) leave request, the
requested hours are *reserved* — held — until the request is finally approved
(hold converts to a real debit) or rejected/cancelled (hold released). This
prevents over-application: the available balance everyone validates against is

    available = balance_hours (tracker) - Σ(ACTIVE holds)

Holds are tracked here, one row per request_id, so the immutable
leave_entitlement_ledger stays free of transient reservations. All amounts are
in hours, mirroring duration_hours / balance_hours.
"""
from datetime import datetime, timezone
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.utils import to_oid

HOLDS_COLLECTION = "leave_balance_holds"

STATUS_ACTIVE = "ACTIVE"
STATUS_CONVERTED = "CONVERTED"
STATUS_RELEASED = "RELEASED"


async def create_hold(
    db: AsyncIOMotorDatabase,
    request_doc: dict,
    actor_id: str,
    now: Optional[datetime] = None,
) -> None:
    """Create (or re-activate) an ACTIVE hold for a leave request.

    Idempotent on request_id — re-submitting the same request updates the
    existing row rather than creating a duplicate.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    request_id = str(request_doc["_id"])
    hours = float(request_doc.get("duration_hours", 0.0) or 0.0)
    await db[HOLDS_COLLECTION].update_one(
        {"request_id": request_id},
        {
            "$set": {
                "user_id": request_doc["user_id"],
                "leave_type_id": request_doc["leave_type_id"],
                "leave_plan_id": request_doc.get("leave_plan_id"),
                "hours": hours,
                "status": STATUS_ACTIVE,
                "updated_on": now,
                "updated_by": actor_id,
            },
            "$setOnInsert": {
                "request_id": request_id,
                "created_on": now,
                "created_by": actor_id,
            },
        },
        upsert=True,
    )
    # Balance-affecting reservation — compliance audit only (the user-facing
    # event is the leave_request lifecycle, already on the activity stream).
    leave_plan_id = request_doc.get("leave_plan_id")
    await emit_audit(
        action="leave_balance_hold.created",
        resource=f"leave_balance_hold:{request_id}",
        actor_id=actor_id,
        details={
            "user_id": str(request_doc.get("user_id")),
            "leave_type_id": str(request_doc.get("leave_type_id")),
            "leave_plan_id": str(leave_plan_id) if leave_plan_id is not None else None,
            "hours": hours,
        },
    )


async def update_hold_hours(
    db: AsyncIOMotorDatabase,
    request_id: str,
    hours: float,
    actor_id: str,
    now: Optional[datetime] = None,
) -> None:
    """Adjust the held hours for an ACTIVE hold (used when a pending request is edited)."""
    if now is None:
        now = datetime.now(timezone.utc)
    result = await db[HOLDS_COLLECTION].update_one(
        {"request_id": str(request_id), "status": STATUS_ACTIVE},
        {"$set": {"hours": float(hours or 0.0), "updated_on": now, "updated_by": actor_id}},
    )
    if result.modified_count:
        await emit_audit(
            action="leave_balance_hold.updated",
            resource=f"leave_balance_hold:{request_id}",
            actor_id=actor_id,
            details={"hours": float(hours or 0.0)},
            changed_fields=["hours"],
        )


async def _set_status(
    db: AsyncIOMotorDatabase, request_id: str, status: str, actor_id: str, now: Optional[datetime]
) -> int:
    """Transition an ACTIVE hold to ``status``. Returns the number of rows
    modified (0 if there was no active hold to transition)."""
    if now is None:
        now = datetime.now(timezone.utc)
    result = await db[HOLDS_COLLECTION].update_one(
        {"request_id": str(request_id), "status": STATUS_ACTIVE},
        {"$set": {"status": status, "updated_on": now, "updated_by": actor_id}},
    )
    return result.modified_count


async def convert_hold(
    db: AsyncIOMotorDatabase, request_id: str, actor_id: str, now: Optional[datetime] = None
) -> None:
    """Mark a hold CONVERTED — the reservation became a real debit on approval."""
    if await _set_status(db, request_id, STATUS_CONVERTED, actor_id, now):
        await emit_audit(
            action="leave_balance_hold.converted",
            resource=f"leave_balance_hold:{request_id}",
            actor_id=actor_id,
            details={"status": STATUS_CONVERTED},
        )


async def release_hold(
    db: AsyncIOMotorDatabase, request_id: str, actor_id: str, now: Optional[datetime] = None
) -> None:
    """Mark a hold RELEASED — the reservation is returned (reject / cancel)."""
    if await _set_status(db, request_id, STATUS_RELEASED, actor_id, now):
        await emit_audit(
            action="leave_balance_hold.released",
            resource=f"leave_balance_hold:{request_id}",
            actor_id=actor_id,
            details={"status": STATUS_RELEASED},
        )


async def get_active_hold_hours(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: str,
    exclude_request_id: Optional[str] = None,
) -> float:
    """Sum of ACTIVE held hours for a user + leave type.

    ``exclude_request_id`` lets an edit/estimate ignore the request's own hold
    so it doesn't count against its own availability.
    """
    match: dict = {
        "user_id": to_oid(user_id),
        "leave_type_id": to_oid(leave_type_id),
        "status": STATUS_ACTIVE,
    }
    if exclude_request_id:
        match["request_id"] = {"$ne": str(exclude_request_id)}
    cursor = db[HOLDS_COLLECTION].aggregate([
        {"$match": match},
        {"$group": {"_id": None, "total": {"$sum": "$hours"}}},
    ])
    rows = await cursor.to_list(length=1)
    return float(rows[0]["total"]) if rows else 0.0


async def get_active_hold_hours_bulk(
    db: AsyncIOMotorDatabase, user_id: str
) -> dict[str, float]:
    """Return {leave_type_id_str: active_held_hours} for all of a user's leave types."""
    cursor = db[HOLDS_COLLECTION].aggregate([
        {"$match": {"user_id": to_oid(user_id), "status": STATUS_ACTIVE}},
        {"$group": {"_id": "$leave_type_id", "total": {"$sum": "$hours"}}},
    ])
    rows = await cursor.to_list(length=None)
    return {str(r["_id"]): float(r["total"]) for r in rows if r.get("_id") is not None}
