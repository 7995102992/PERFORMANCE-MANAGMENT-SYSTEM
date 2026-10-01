"""Give legacy single-project tasks their owning project.

Tasks created before project ownership existed are all shared (`project_id: null`).
A shared task's name must stay unique across the organisation, so a second project
cannot add its own task of the same name while the first project's task is still
shared — it fails with "Task with this name already exists".

This assigns `project_id` to every ordinary task that is linked to exactly one
project, turning it into a project-owned task. Left alone:

  * global / frequent tasks      — shared by definition
  * tasks linked to 2+ projects  — genuinely shared; splitting them would need
                                   duplicates, and timesheet entries reference the
                                   single task id
  * tasks linked to no project   — nothing to own them yet

Timesheet entries, resource assignments and project-task links all reference the
task by id, so none of them are affected.

Dry-run by default:
    python scripts/backfill_task_project_owner.py
Apply:
    python scripts/backfill_task_project_owner.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402


async def _plan(db) -> tuple[list[tuple], int, int]:
    """(task, project_id) pairs to convert, plus the counts left alone.

    A task belongs to a project only when exactly one project links it. Anything
    linked to several is genuinely shared, and splitting it would need duplicates that
    existing timesheet entries could not follow.
    """
    candidates = await db.tasks.find({
        "project_id": None,
        "deleted_on": None,
        "is_global": {"$ne": True},
        "is_frequent": {"$ne": True},
    }).to_list(length=None)

    convert: list[tuple] = []
    skipped_multi = skipped_unlinked = 0
    for task in candidates:
        links = await db.project_tasks.find(
            {"task_id": task["_id"], "deleted_on": None}
        ).to_list(length=None)
        project_ids = {link["project_id"] for link in links}
        if len(project_ids) == 1:
            convert.append((task, next(iter(project_ids))))
        elif len(project_ids) > 1:
            skipped_multi += 1
        else:
            skipped_unlinked += 1
    return convert, skipped_multi, skipped_unlinked


def _name_clashes(convert: list[tuple]) -> list[tuple]:
    """Conversions that would put two live tasks of one name in a single project."""
    seen: set[tuple] = set()
    clashes = []
    for task, project_id in convert:
        key = (project_id, task["name_lc"])
        if key in seen:
            clashes.append((task["name"], project_id))
        seen.add(key)
    return clashes


async def migrate(db) -> str:
    """Convert single-project shared tasks to project-owned. Startup and `main`.

    Raises rather than half-applying when a conversion would clash, since the
    replacement unique index would reject it anyway.
    """
    convert, _multi, _unlinked = await _plan(db)
    if not convert:
        return "no shared tasks to convert"

    clashes = _name_clashes(convert)
    if clashes:
        raise RuntimeError(
            f"{len(clashes)} task-name clash(es) inside a project; resolve before migrating"
        )

    for task, project_id in convert:
        await db.tasks.update_one(
            {"_id": task["_id"]}, {"$set": {"project_id": project_id}},
        )
    return f"converted {len(convert)} task(s) to project-owned"


async def main(apply: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    db = client[settings.MONGO_DB_NAME]

    convert, skipped_multi, skipped_unlinked = await _plan(db)
    print(f"  convert to project-owned : {len(convert)}")
    print(f"  left shared (2+ projects): {skipped_multi}")
    print(f"  left shared (no project) : {skipped_unlinked}")

    clashes = _name_clashes(convert)
    if clashes:
        print(f"\nABORT: {len(clashes)} name clash(es) inside a single project:")
        for name, project_id in clashes:
            print(f"  '{name}' in project {project_id}")
        client.close()
        return

    for task, project_id in convert[:20]:
        print(f"    '{task['name']}' -> project {project_id}")
    if len(convert) > 20:
        print(f"    … and {len(convert) - 20} more")

    if not apply:
        print("\nDRY RUN — re-run with --apply to commit.")
    else:
        # Delegate the write, so the command line and startup apply the same thing.
        print("\n" + await migrate(db))

    client.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="commit the change (default is dry-run)")
    asyncio.run(main(ap.parse_args().apply))
