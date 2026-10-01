"""Clear a project's logged time.

Removes every timesheet entry booked against one project, along with that project's
approval records and the approval history scoped to it, then repairs the weekly
timesheets left behind:

  * each affected week's total / billable / non-billable hours are recalculated from
    whatever entries remain (a week can span several projects, so it is not deleted);
  * a week left with no live entries at all is returned to draft and stripped of its
    remaining approval records, since a submitted week with nothing in it is
    invisible to approvers and cannot be edited.

Entries are soft-deleted by default, matching the rest of the service. ``--hard``
removes the documents outright — irreversible, intended for resetting a test
environment.

Approved weeks are skipped unless ``--include-approved`` is given: clearing time that
has already been signed off is almost never what you want.

Dry-run by default:
    python scripts/clear_project_timesheets.py <project_id>
Apply:
    python scripts/clear_project_timesheets.py <project_id> --apply
    python scripts/clear_project_timesheets.py <project_id> --apply --hard
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bson import ObjectId  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402

APPROVED_STATUSES = {"l1_approved", "client_approved"}


async def main(project_id: str, apply: bool, hard: bool, include_approved: bool) -> None:
    if not ObjectId.is_valid(project_id):
        print(f"'{project_id}' is not a valid project id")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    db = client[settings.MONGO_DB_NAME]
    proj_oid = ObjectId(project_id)

    project = await db.projects.find_one({"_id": proj_oid})
    if not project:
        print("PROJECT NOT FOUND")
        return
    print(f"Project: {project.get('name')} ({project_id})")

    entries = await db.timesheet_entries.find(
        {"project_id": proj_oid, "deleted_on": None}
    ).to_list(length=None)
    if not entries:
        print("No live entries booked against this project — nothing to clear.")
        return

    ts_ids = {e["weekly_timesheet_id"] for e in entries}
    weeks = await db.weekly_timesheets.find({"_id": {"$in": list(ts_ids)}}).to_list(length=None)
    week_by_id = {w["_id"]: w for w in weeks}

    by_status: dict[str, int] = {}
    for w in weeks:
        status = w.get("timesheet_status", "unknown")
        by_status[status] = by_status.get(status, 0) + 1

    total_hours = sum(e.get("hours", 0) for e in entries)
    print(f"\n{len(entries)} entries, {total_hours}h, across {len(weeks)} weekly timesheets")
    for status, count in sorted(by_status.items()):
        print(f"  {status}: {count}")

    # Approved weeks are excluded unless explicitly included.
    approved_ids = {
        w["_id"] for w in weeks if w.get("timesheet_status") in APPROVED_STATUSES
    }
    if approved_ids and not include_approved:
        entries = [e for e in entries if e["weekly_timesheet_id"] not in approved_ids]
        print(f"\nSkipping {len(approved_ids)} approved week(s) — pass --include-approved to clear them.")
        if not entries:
            print("Nothing left to clear.")
            return

    affected_ts_ids = {e["weekly_timesheet_id"] for e in entries}
    print(f"\nWould {'delete' if hard else 'soft-delete'} {len(entries)} entries "
          f"across {len(affected_ts_ids)} weekly timesheets.")
    for ts_id in list(affected_ts_ids)[:10]:
        week = week_by_id.get(ts_id, {})
        print(f"    {ts_id}  week={week.get('week_start_date')}  status={week.get('timesheet_status')}")
    if len(affected_ts_ids) > 10:
        print(f"    … and {len(affected_ts_ids) - 10} more")

    if not apply:
        print("\nDRY RUN — re-run with --apply to commit.")
        return

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    entry_ids = [e["_id"] for e in entries]

    ts_id_list = list(affected_ts_ids)
    # Approval history scoped to this project goes with it — otherwise a cleared week
    # still shows who approved or rejected work that no longer exists.
    history_filter = {
        "weekly_timesheet_id": {"$in": ts_id_list},
        "scope_project_ids": proj_oid,
    }

    if hard:
        result = await db.timesheet_entries.delete_many({"_id": {"$in": entry_ids}})
        print(f"\nDeleted {result.deleted_count} entries.")
        await db.timesheet_project_approvals.delete_many(
            {"project_id": proj_oid, "weekly_timesheet_id": {"$in": ts_id_list}}
        )
        history = await db.approval_records.delete_many(history_filter)
        print(f"Deleted {history.deleted_count} approval history records.")
    else:
        result = await db.timesheet_entries.update_many(
            {"_id": {"$in": entry_ids}},
            {"$set": {"deleted_on": now, "modified_on": now}},
        )
        print(f"\nSoft-deleted {result.modified_count} entries.")
        await db.timesheet_project_approvals.update_many(
            {"project_id": proj_oid, "weekly_timesheet_id": {"$in": ts_id_list},
             "deleted_on": None},
            {"$set": {"deleted_on": now, "modified_on": now}},
        )
        history = await db.approval_records.update_many(
            {**history_filter, "deleted_on": None},
            {"$set": {"deleted_on": now, "modified_on": now}},
        )
        print(f"Soft-deleted {history.modified_count} approval history records.")

    # Repair each affected week from whatever survives.
    emptied = 0
    for ts_id in affected_ts_ids:
        remaining = await db.timesheet_entries.find(
            {"weekly_timesheet_id": ts_id, "deleted_on": None}
        ).to_list(length=None)
        total = sum(e.get("hours", 0) for e in remaining)
        billable = sum(e.get("hours", 0) for e in remaining if e.get("is_billable"))

        update = {
            "total_hours": total,
            "billable_hours": billable,
            "non_billable_hours": total - billable,
            "modified_on": now,
        }
        if not remaining:
            # A submitted week with no entries reaches no approver and cannot be
            # edited — put it back where the employee can fill it again, and drop the
            # rest of its history so the reset week starts clean.
            update |= {
                "timesheet_status": "draft",
                "submitted_at": None,
                "shortage_hours": 0.0,
                "penalty_hours": 0.0,
            }
            emptied += 1
            if hard:
                await db.approval_records.delete_many({"weekly_timesheet_id": ts_id})
                await db.timesheet_project_approvals.delete_many({"weekly_timesheet_id": ts_id})
            else:
                for collection in (db.approval_records, db.timesheet_project_approvals):
                    await collection.update_many(
                        {"weekly_timesheet_id": ts_id, "deleted_on": None},
                        {"$set": {"deleted_on": now, "modified_on": now}},
                    )
        await db.weekly_timesheets.update_one({"_id": ts_id}, {"$set": update})

    print(f"Recalculated {len(affected_ts_ids)} weekly timesheets "
          f"({emptied} left empty and returned to draft).")
    client.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("project_id", help="project whose logged time should be cleared")
    ap.add_argument("--apply", action="store_true", help="commit the change (default is dry-run)")
    ap.add_argument("--hard", action="store_true", help="delete documents instead of soft-deleting")
    ap.add_argument("--include-approved", action="store_true",
                    help="also clear weeks that have already been approved")
    args = ap.parse_args()
    asyncio.run(main(args.project_id, args.apply, args.hard, args.include_approved))
