"""Backfill ACTIVE balance holds for existing PENDING leave requests.

The balance-hold feature reserves a request's hours (in leave_balance_holds)
from submission until approval/rejection. Requests created before the feature
shipped have no hold, so their reserved balance wouldn't be reflected in
``available``. This script creates an ACTIVE hold for every currently-PENDING,
balance-deducting, non-LOP request that doesn't already have one, and ensures
the collection's indexes exist.

Usage:
    # Dry run — report what WOULD be created (default):
    python -m scripts.backfill_leave_balance_holds

    # Apply:
    python -m scripts.backfill_leave_balance_holds --apply

Idempotent: holds are keyed by request_id (unique), so re-running is safe.
"""

import argparse
import asyncio
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, IndexModel

from src.config import settings
from src.leave_holds.service import HOLDS_COLLECTION, STATUS_ACTIVE

REQUESTS_COLLECTION = "leave_requests"


async def _ensure_indexes(db) -> None:
    await db[HOLDS_COLLECTION].create_indexes([
        IndexModel([("request_id", ASCENDING)], unique=True, name="uniq_request_id"),
        IndexModel(
            [("user_id", ASCENDING), ("leave_type_id", ASCENDING), ("status", ASCENDING)],
            name="user_type_status",
        ),
    ])


async def backfill(apply: bool) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    if apply:
        await _ensure_indexes(db)
        print("Indexes ensured on", HOLDS_COLLECTION)

    # Leave types that deduct from balance — only these reserve.
    deducting = await db["leave_types"].find(
        {"deleted_on": None}, {"_id": 1, "deduct_from_balance": 1}
    ).to_list(length=None)
    deducting_ids = {lt["_id"] for lt in deducting if lt.get("deduct_from_balance", True)}

    pending = await db[REQUESTS_COLLECTION].find({
        "status": "PENDING",
        "deleted_on": None,
        "loss_of_pay": {"$ne": True},
    }).to_list(length=None)

    # Which requests already have a hold?
    existing = await db[HOLDS_COLLECTION].find({}, {"request_id": 1}).to_list(length=None)
    held_ids = {h["request_id"] for h in existing}

    to_create = [
        r for r in pending
        if r.get("leave_type_id") in deducting_ids and str(r["_id"]) not in held_ids
    ]

    print(f"{'APPLYING' if apply else 'DRY RUN'} — {len(to_create)} pending request(s) need a hold:\n")
    for r in to_create[:50]:
        print(f"  request_id={r['_id']}  user={r.get('user_id')}  hours={r.get('duration_hours')}")
    if len(to_create) > 50:
        print(f"  … and {len(to_create) - 50} more")

    if not apply:
        print("\nDry run only — no holds written. Re-run with --apply to create them.")
        client.close()
        return

    now = datetime.now(timezone.utc)
    created = 0
    for r in to_create:
        await db[HOLDS_COLLECTION].update_one(
            {"request_id": str(r["_id"])},
            {
                "$set": {
                    "user_id": r["user_id"],
                    "leave_type_id": r["leave_type_id"],
                    "leave_plan_id": r.get("leave_plan_id"),
                    "hours": float(r.get("duration_hours", 0.0) or 0.0),
                    "status": STATUS_ACTIVE,
                    "updated_on": now,
                    "updated_by": "backfill_script",
                },
                "$setOnInsert": {
                    "request_id": str(r["_id"]),
                    "created_on": now,
                    "created_by": "backfill_script",
                },
            },
            upsert=True,
        )
        created += 1

    print(f"\nDone. Created/ensured {created} hold(s).")
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write the holds (default is dry run)")
    args = parser.parse_args()
    asyncio.run(backfill(args.apply))
