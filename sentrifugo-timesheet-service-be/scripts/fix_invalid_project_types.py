"""Repair `project_type` values that are outside `ProjectTypeEnum`.

Four seeded projects carry a vocabulary the model has never defined —
`fixed_bid`, `retainer` and `internal`. `Project.project_type` is typed as the
enum, so Beanie cannot hydrate those documents, and because a `find` is
validated as a unit, one of them fails the **whole** query rather than one row.
That emptied `GET /my-timesheets/assigned-projects` for the 74 users assigned to
at least one of them, and with it the expense form's client/project pickers,
which read the same route.

`lenient_enum` in `src/models.py` now stops that from being an outage — an
unrecognised value reads as the field's fallback and logs a warning. This script
is the other half: leniency keeps the page up, it does not make `retainer` a real
project type, and a project silently reported as Time & Materials in every
billing export is still wrong.

The mapping is by meaning, not by proximity:

    fixed_bid  -> fixed_fee           a fixed-price engagement
    retainer   -> time_and_materials  ongoing support, billed as worked
    internal   -> non_billable        both rows already carry is_internal=True,
                                      so the type was duplicating the flag

Only documents still holding an invalid value are touched, so a second run is a
no-op rather than a second edit.

Dry-run by default:
    python scripts/fix_invalid_project_types.py
Apply:
    python scripts/fix_invalid_project_types.py --apply
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402
from src.models import ProjectTypeEnum  # noqa: E402

COLLECTION = "projects"

# Read off the enum rather than restated, so adding a member cannot leave this
# script quietly "repairing" a value that has since become legal.
VALID = [member.value for member in ProjectTypeEnum]

REPAIRS: dict[str, str] = {
    "fixed_bid": ProjectTypeEnum.FIXED_FEE.value,
    "retainer": ProjectTypeEnum.TIME_AND_MATERIALS.value,
    "internal": ProjectTypeEnum.NON_BILLABLE.value,
}


async def main(apply: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    col = client[settings.MONGO_DB_NAME][COLLECTION]

    broken = await col.find(
        {"project_type": {"$nin": VALID}},
        {"name": 1, "project_type": 1, "is_internal": 1, "organisation_id": 1},
    ).to_list(length=None)

    if not broken:
        print("No project carries an invalid project_type - nothing to do.")
        return

    print(f"{len(broken)} project(s) with an invalid project_type:\n")
    unmapped = []
    for doc in broken:
        stored = doc.get("project_type")
        target = REPAIRS.get(stored)
        arrow = f"-> {target}" if target else "-> NO MAPPING"
        if not target:
            unmapped.append(stored)
        print(f"  {doc['_id']}  {doc.get('name', '?'):<28} {stored!r:<22} {arrow}")

    if unmapped:
        # Guessing at a value nobody wrote a mapping for is how the next
        # `retainer` gets silently booked as billable.
        print(
            f"\nABORT: no mapping for {sorted(set(unmapped))}. "
            "Add it to REPAIRS once somebody has decided what it means."
        )
        return

    if not apply:
        print("\nDRY RUN - re-run with --apply to commit.")
        return

    total = 0
    for stored, target in REPAIRS.items():
        result = await col.update_many({"project_type": stored}, {"$set": {"project_type": target}})
        if result.modified_count:
            print(f"\n{stored} -> {target}: {result.modified_count} updated")
        total += result.modified_count

    remaining = await col.count_documents({"project_type": {"$nin": VALID}})
    print(f"\n{total} document(s) updated; {remaining} still invalid.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="commit the changes")
    asyncio.run(main(parser.parse_args().apply))
