"""Drop the index shapes left behind when reopen moved to per-employee.

Reopening a closed month used to be a per-project control, keyed on
``(project_id, year, month)``. It is now granted per employee by the manager who
approves them, and covers that manager's own projects — so the key is
``(user_id, year, month, created_by)``.

Beanie creates the indexes a model declares but never drops the ones it stopped
declaring, so both retired shapes outlive the deploy and keep enforcing the old
rules:

    pso_project_period_unique   (project_id, year, month)
        Sees ``project_id: null`` on every new row and rejects the second reopen of
        any month with E11000.

    pso_user_period_unique      (user_id, year, month)
        An interim shape allowing only one grant per employee-month, so the second
        manager to reopen their own projects collided with the first.

Runs automatically at startup via ``src.migrations``. Dry-run by default here:

    python -m scripts.migrate_reopen_per_employee
    python -m scripts.migrate_reopen_per_employee --apply
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402
from src.migrations import drop_index_if_present  # noqa: E402

COLLECTION = "past_submission_overrides"
RETIRED_INDEXES = ["pso_project_period_unique", "pso_user_period_unique"]


async def migrate(db) -> str:
    """Drop both retired index shapes. Absent is success — the desired state."""
    outcomes = [
        await drop_index_if_present(db, COLLECTION, name) for name in RETIRED_INDEXES
    ]
    return "; ".join(outcomes)


async def main(apply: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    db = client[settings.MONGO_DB_NAME]

    present = {ix["name"] async for ix in db[COLLECTION].list_indexes()}
    stale = [n for n in RETIRED_INDEXES if n in present]
    print(f"{COLLECTION}: {len(stale)} retired index(es) present: {stale or '—'}")

    if not stale:
        print("Nothing to do.")
    elif not apply:
        print("\nDRY RUN — re-run with --apply to drop them.")
    else:
        print("\n" + await migrate(db))

    client.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="drop them (default: dry run)")
    asyncio.run(main(ap.parse_args().apply))
