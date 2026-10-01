"""Backfill ``count_calendar_days`` on existing Maternity / Paternity leave types.

These leave types must include weekends and public holidays in the booked
duration. The duration engine keys off the ``count_calendar_days`` flag, so any
leave type that existed before the flag was introduced needs it set to True.

Matching is by NAME (regex ``maternity|paternity``, case-insensitive) rather
than code — codes such as "PL" are org-defined and ambiguous (Paternity vs
Privilege Leave), whereas the display name is reliable. Adjust ``NAME_REGEX``
if your orgs name these types differently.

Usage:
    # Dry run — list what WOULD be updated, change nothing (default):
    python -m scripts.backfill_calendar_day_leaves

    # Apply the update:
    python -m scripts.backfill_calendar_day_leaves --apply

Idempotent: re-running only touches docs that don't already have the flag set.
"""

import argparse
import asyncio
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

COLLECTION = "leave_types"
NAME_REGEX = r"maternity|paternity"


async def backfill(apply: bool) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    # Only docs that aren't already flagged, so the run is idempotent and the
    # dry-run count reflects real pending changes.
    query = {
        "name": {"$regex": NAME_REGEX, "$options": "i"},
        "deleted_on": None,
        "count_calendar_days": {"$ne": True},
    }

    matches = await db[COLLECTION].find(
        query, {"_id": 1, "org_id": 1, "name": 1, "code": 1, "is_custom": 1}
    ).to_list(length=None)

    if not matches:
        print("No matching leave types need updating. Nothing to do.")
        client.close()
        return

    print(f"{'APPLYING' if apply else 'DRY RUN'} — {len(matches)} leave type(s) matched:\n")
    for d in matches:
        scope = "SYSTEM" if d.get("org_id") is None else f"org={d.get('org_id')}"
        kind = "custom" if d.get("is_custom", True) else "system-type"
        print(f"  [{d.get('code')}] {d.get('name')}  ({scope}, {kind})  _id={d['_id']}")

    if not apply:
        print("\nDry run only — no changes written. Re-run with --apply to update.")
        client.close()
        return

    result = await db[COLLECTION].update_many(
        query,
        {"$set": {"count_calendar_days": True, "updated_on": datetime.now(timezone.utc), "updated_by": "backfill_script"}},
    )
    print(f"\nDone. Modified {result.modified_count} leave type(s).")
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write the update (default is dry run)")
    args = parser.parse_args()
    asyncio.run(backfill(args.apply))
