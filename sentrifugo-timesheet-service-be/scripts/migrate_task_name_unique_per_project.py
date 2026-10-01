"""Scope task-name uniqueness to the owning project.

A task added to a project now belongs to that project, so two projects may each
have their own task of the same name. Global and frequent tasks stay shared at
organisation level and keep an organisation-wide unique name.

The old index made the name unique per organisation, which blocked the second
project from adding its own "Design". This drops that legacy index; Beanie
recreates the replacements on the next app start:

    task_org_name_shared_unique   (organisation_id, name_lc)  UNIQUE
                                  where {deleted_on: null, project_id: null}
    task_project_name_unique      (project_id, name_lc)       UNIQUE
                                  where {deleted_on: null, project_id: {$type: objectId}}

Existing tasks have no `project_id` and stay shared, so nothing that is currently
linked to a project changes behaviour.

Dry-run by default:
    python scripts/migrate_task_name_unique_per_project.py
Apply:
    python scripts/migrate_task_name_unique_per_project.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402

LEGACY_INDEX = "organisation_id_1_name_lc_1"
NEW_SHARED_INDEX = "task_org_name_shared_unique"
COLLECTION = "tasks"


async def _duplicate_owned_names(col) -> list[dict]:
    """(project, name) groups that already hold more than one live task.

    The replacement unique index cannot be built over these, so a migration must stop
    rather than half-apply.
    """
    return await col.aggregate([
        {"$match": {"deleted_on": None, "project_id": {"$ne": None}}},
        {"$group": {"_id": {"p": "$project_id", "n": "$name_lc"}, "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ]).to_list(length=None)


async def migrate(db) -> str:
    """Drop the organisation-wide task-name index. Called at startup and by `main`."""
    from src.migrations import drop_index_if_present

    col = db[COLLECTION]
    dupes = await _duplicate_owned_names(col)
    if dupes:
        raise RuntimeError(
            f"{len(dupes)} duplicate (project, name) group(s); resolve before migrating"
        )
    return await drop_index_if_present(db, COLLECTION, LEGACY_INDEX)


async def main(apply: bool) -> None:
    # Raw motor client — Beanie's init_db cannot run while the legacy index conflicts
    # with the replacement (same key, different partial filter).
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    col = client[settings.MONGO_DB_NAME][COLLECTION]

    indexes = {ix["name"]: ix async for ix in col.list_indexes()}
    print(f"Indexes on {COLLECTION}:")
    for name, ix in indexes.items():
        print(f"  {name}: key={dict(ix['key'])} unique={ix.get('unique', False)} "
              f"partial={ix.get('partialFilterExpression')}")

    if NEW_SHARED_INDEX in indexes:
        print(f"\n`{NEW_SHARED_INDEX}` is in place.")

    legacy = indexes.get(LEGACY_INDEX)
    if not legacy:
        print(f"\n`{LEGACY_INDEX}` not present — nothing to drop. "
              "Start the app and Beanie will create the new indexes.")
        return
    # The legacy index keeps names unique per organisation regardless of the owning
    # project, so it must go even once the replacements exist.

    # Safety: every existing task is shared (no project_id), and the shared index is
    # the same key with the same effective scope, so no collision can appear.
    owned = await col.count_documents({"project_id": {"$ne": None}})
    if owned:
        print(f"\n{owned} task(s) already carry a project_id — checking for duplicates.")
        dupes = await _duplicate_owned_names(col)
        if dupes:
            print(f"ABORT: {len(dupes)} duplicate (project, name) group(s); "
                  "the new unique index cannot be built. Resolve these first:")
            for d in dupes:
                print(f"  {d['_id']} -> {d['n']} rows")
            return

    if not apply:
        print(f"\nDRY RUN — would drop unique index `{LEGACY_INDEX}`. "
              "Re-run with --apply to commit.")
        return

    await col.drop_index(LEGACY_INDEX)
    print(f"\nDropped `{LEGACY_INDEX}`.")
    print("Restart the app — Beanie will create the shared and per-project unique indexes.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="commit the change (default is dry-run)")
    asyncio.run(main(ap.parse_args().apply))
