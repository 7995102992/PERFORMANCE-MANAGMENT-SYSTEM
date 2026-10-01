"""Scope ClientProjectHead email uniqueness to the client instead of the organisation.

A project head may now serve several clients (one row per client, sharing one IAM
login). The old index made the email unique per organisation, so adding the same
person to a second client failed with "email already exists".

This drops the legacy unique index `organisation_id_1_email_1`. Beanie recreates the
replacement indexes on the next app start:
    (organisation_id, client_id)
    (organisation_id, email)                       — non-unique lookup
    (organisation_id, client_id, email)  UNIQUE    — cph_org_client_email_unique

Dry-run by default:
    python scripts/migrate_cph_email_unique_per_client.py
Apply:
    python scripts/migrate_cph_email_unique_per_client.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402

LEGACY_INDEX = "organisation_id_1_email_1"
# Left behind by an abandoned "client_ids array" approach; the field no longer exists.
STRAY_INDEX = "organisation_id_1_client_ids_1"
COLLECTION = "client_project_heads"


async def migrate(db) -> str:
    """Drop the organisation-wide *unique* email index, and the stray one beside it.

    Called at startup and by `main`.

    The uniqueness is the whole test, not the name. The current model declares a
    plain lookup index on the same two fields, which Mongo auto-names
    ``organisation_id_1_email_1`` — identical to the retired unique one. Dropping by
    name alone deletes the live index that Beanie recreates on the next boot, so the
    two would take turns undoing each other forever.

    Safe when it does fire: the replacement key (org, client_id, email) is weaker
    than the one being dropped, so no existing row can collide under it.
    """
    from src.migrations import drop_index_if_present

    indexes = {ix["name"]: ix async for ix in db[COLLECTION].list_indexes()}
    legacy = indexes.get(LEGACY_INDEX)

    outcomes = []
    if legacy and legacy.get("unique"):
        outcomes.append(await drop_index_if_present(db, COLLECTION, LEGACY_INDEX))
    else:
        outcomes.append(f"{COLLECTION}.{LEGACY_INDEX} is not the unique legacy index")

    # Nothing declares the stray, so name is enough there.
    outcomes.append(await drop_index_if_present(db, COLLECTION, STRAY_INDEX))
    return "; ".join(outcomes)


async def main(apply: bool) -> None:
    # Raw motor client — Beanie's init_db can't run until the legacy index is gone.
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    col = client[settings.MONGO_DB_NAME][COLLECTION]

    indexes = {ix["name"]: ix async for ix in col.list_indexes()}
    print(f"Indexes on {COLLECTION}:")
    for name, ix in indexes.items():
        print(f"  {name}: key={dict(ix['key'])} unique={ix.get('unique', False)}")

    legacy = indexes.get(LEGACY_INDEX)
    stray = indexes.get(STRAY_INDEX)
    if not legacy or not legacy.get("unique"):
        if stray and apply:
            await col.drop_index(STRAY_INDEX)
            print(f"\nDropped stray `{STRAY_INDEX}`.")
        else:
            print(f"\n`{LEGACY_INDEX}` is already non-unique — nothing to migrate.")
        return

    # Safety: the new unique key is (org, client_id, email). Existing rows were unique
    # per (org, email), which is strictly stronger, so no collisions are possible.
    dupes = await col.aggregate([
        {"$match": {"deleted_on": None}},
        {"$group": {
            "_id": {"o": "$organisation_id", "c": "$client_id", "e": "$email"},
            "n": {"$sum": 1},
        }},
        {"$match": {"n": {"$gt": 1}}},
    ]).to_list(length=None)
    if dupes:
        print(f"\nABORT: {len(dupes)} duplicate (org, client, email) group(s) exist; "
              "the new unique index cannot be built. Resolve these first:")
        for d in dupes:
            print(f"  {d['_id']} -> {d['n']} rows")
        return
    print("\nNo (org, client, email) duplicates — safe to swap the index.")

    if not apply:
        print(f"\nDRY RUN — would drop unique index `{LEGACY_INDEX}`. "
              "Re-run with --apply to commit.")
        return

    await col.drop_index(LEGACY_INDEX)
    print(f"\nDropped `{LEGACY_INDEX}`.")
    if stray:
        await col.drop_index(STRAY_INDEX)
        print(f"Dropped stray `{STRAY_INDEX}`.")
    print("Restart the app — Beanie will create the per-client unique index.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="commit changes (default: dry run)")
    asyncio.run(main(ap.parse_args().apply))
