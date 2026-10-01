"""Backfill manager NAMES into existing L1/L2 journey timeline titles.

Existing l1/l2 assigned/changed rows only carry the manager's user id in metadata
(l{1,2}_manager_id). This resolves the name from that id and rewrites the title to
include it (and stores l{1,2}_manager_name in metadata). Idempotent — safe to re-run.

    python -m scripts.backfill_journey_manager_names --dry-run
    python -m scripts.backfill_journey_manager_names
"""
from __future__ import annotations
import argparse
import asyncio
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient
from src.config import settings

# event_type -> (metadata level prefix, title template)
LEVELS = {
    "l1_assigned": ("l1", "L1 Manager Assigned: {name}"),
    "l2_assigned": ("l2", "L2 Manager Assigned: {name}"),
    "l1_changed":  ("l1", "L1 Manager changed to {name}"),
    "l2_changed":  ("l2", "L2 Manager changed to {name}"),
}


def _full_name(u: dict) -> str | None:
    if not u:
        return None
    return f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip() or None


async def main(dry_run: bool) -> None:
    db = AsyncIOMotorClient(settings.MONGODB_URL).get_default_database()
    rows = await db["journey_timeline"].find({"event_type": {"$in": list(LEVELS)}}).to_list(length=100000)
    name_cache: dict[str, str | None] = {}
    scanned = updated = no_id = no_user = 0

    for r in rows:
        scanned += 1
        level, tmpl = LEVELS[r["event_type"]]
        meta = r.get("metadata") or {}
        mid = meta.get(f"{level}_manager_id")
        if not mid:
            no_id += 1
            continue
        if str(mid) not in name_cache:
            try:
                u = await db["users"].find_one({"_id": ObjectId(str(mid))})
            except Exception:
                u = None
            name_cache[str(mid)] = _full_name(u)
        name = name_cache[str(mid)]
        if not name:
            no_user += 1
            continue
        new_title = tmpl.format(name=name)
        if r.get("title") == new_title and meta.get(f"{level}_manager_name") == name:
            continue  # already backfilled
        updated += 1
        if not dry_run:
            await db["journey_timeline"].update_one(
                {"_id": r["_id"]},
                {"$set": {"title": new_title, f"metadata.{level}_manager_name": name}},
            )

    verb = "would update" if dry_run else "updated"
    print(f"scanned={scanned}  {verb}={updated}  skipped(no manager_id)={no_id}  skipped(user not found)={no_user}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    asyncio.run(main(ap.parse_args().dry_run))
