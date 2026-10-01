"""Collapse the user account-status column to active/inactive.

StatusEnum used to carry the employee LIFECYCLE (notice_period, exit) on the
account row, duplicating employee.employment_status and free to drift from it.
It is now just active/inactive, so existing rows must be migrated:

  notice_period -> active     (still working, always had full access)
  exit          -> inactive   (cannot log in — same as before)

Also repairs rows where the exit flow wrote an EMPLOYMENT_STATUSES master-data
key into the account column ("absconded" / "terminated" / "retired" / ...).
Those are not account statuses at all and now fail StatusEnum validation on read.
Any status outside {active, inactive} that isn't notice_period is treated as a
terminal employment state -> inactive.

The employment lifecycle is NOT lost — it lives on employee.employment_status.

Usage:
    python -m scripts.migrate_user_status --dry-run
    python -m scripts.migrate_user_status
"""
from __future__ import annotations

import argparse
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

TO_ACTIVE = ["notice_period"]
KEEP = {"active", "inactive"}


async def main(dry_run: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    users = db["users"]

    present = await users.distinct("status")
    print(f"statuses currently in the users collection: {sorted(map(str, present))}\n")

    # notice_period -> active
    n_active = await users.count_documents({"status": {"$in": TO_ACTIVE}})
    print(f"notice_period -> active : {n_active} user(s)")

    # anything else unknown (exit, absconded, terminated, ...) -> inactive
    unknown = [s for s in present if s not in KEEP and s not in TO_ACTIVE]
    n_inactive = 0
    if unknown:
        n_inactive = await users.count_documents({"status": {"$in": unknown}})
        print(f"{unknown} -> inactive : {n_inactive} user(s)")
    else:
        print("no exit/lifecycle statuses to demote -> inactive : 0 user(s)")

    if dry_run:
        print("\n[dry-run] No changes made.")
        client.close()
        return

    if n_active:
        r = await users.update_many({"status": {"$in": TO_ACTIVE}}, {"$set": {"status": "active"}})
        print(f"\nUpdated {r.modified_count} user(s) -> active")
    if n_inactive:
        r = await users.update_many({"status": {"$in": unknown}}, {"$set": {"status": "inactive"}})
        print(f"Updated {r.modified_count} user(s) -> inactive")

    left = await users.distinct("status")
    bad = [s for s in left if s not in KEEP]
    print(f"\nStatuses now present: {sorted(map(str, left))}")
    print("OK — only active/inactive remain." if not bad else f"WARNING — still invalid: {bad}")
    client.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    asyncio.run(main(dry_run=args.dry_run))
