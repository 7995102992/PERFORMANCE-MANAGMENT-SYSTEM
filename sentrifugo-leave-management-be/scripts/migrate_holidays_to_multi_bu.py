"""Migrate holiday documents from a singular ``business_unit_id`` to the
plural ``business_unit_ids`` list.

Usage:
    python -m scripts.migrate_holidays_to_multi_bu

Semantics:
    - For every holiday where ``business_unit_ids`` is missing/empty AND the
      legacy ``business_unit_id`` is set, set ``business_unit_ids`` to
      ``[business_unit_id]`` and ``$unset`` the legacy field.
    - Idempotent — already-migrated documents are skipped.
    - Holidays with neither field (or both empty/missing) are logged as
      anomalies but NOT modified — let an operator decide what to do.
"""

import asyncio

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

COLLECTION = "holidays"


def _as_oid(value):
    """Idempotent — ObjectId in, ObjectId out; 24-hex string in, ObjectId out."""
    if isinstance(value, ObjectId):
        return value
    return ObjectId(value)


async def main() -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    migrated = 0
    already_migrated = 0
    anomalies = 0

    cursor = db[COLLECTION].find({})
    async for doc in cursor:
        bu_ids = doc.get("business_unit_ids")
        legacy_bu = doc.get("business_unit_id")

        has_plural = isinstance(bu_ids, list) and len(bu_ids) > 0

        if has_plural:
            already_migrated += 1
            continue

        if legacy_bu is None:
            anomalies += 1
            print(
                f"  ANOMALY holiday _id={doc.get('_id')} "
                f"name={doc.get('name')!r} — no business unit on either field"
            )
            continue

        # Normalize the legacy value to ObjectId so the canonical storage
        # is ObjectId regardless of how the legacy field was written.
        bu_oid = _as_oid(legacy_bu)
        await db[COLLECTION].update_one(
            {"_id": doc["_id"]},
            {
                "$set": {"business_unit_ids": [bu_oid]},
                "$unset": {"business_unit_id": ""},
            },
        )
        migrated += 1
        print(f"  MIGRATE holiday _id={doc['_id']} -> business_unit_ids=[{bu_oid}]")

    print()
    print(
        f"Migrated: {migrated}, Already migrated: {already_migrated}, "
        f"Anomalies (no BU at all): {anomalies}"
    )
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
