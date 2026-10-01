"""Create ONE sample work calendar + shift in the LMS and apply it to everyone.

  - Calendar : Mon–Fri working (Sat/Sun off), company-wide (all BUs + depts), default.
  - Shift    : 'Morning Shift' 09:30–18:30 (60-min break).
  - Assign   : the calendar AND the shift to every ACTIVE employee.

Writes into the LMS DB (sentrifugo_lms) in the exact shapes the LMS services use.
Dev/migration tool (prod creates these via the LMS API). Idempotent; every doc is
tagged import_batch=MARKER for a clean --revert.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.lms_work_calendar              # DRY RUN (counts only)
    python -m scripts.lms_work_calendar --commit     # write into the LMS DB
    python -m scripts.lms_work_calendar --revert      # delete this import's data
"""

import argparse
import asyncio
import uuid
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient
from src.config import settings
from scripts.datafile import read_rows, find_file

ORG_ID = ObjectId("6a3e05a5c0470e0bdd9ce9a9")
MIGRATION_USER = ObjectId("6a3e05a5c0470e0bdd9ce9aa")
LMS_DB = "sentrifugo_lms"
MARKER = "work_calendar_migration"
# Employee export (.csv OR .xlsx) — overridable with --emp-file
EMP_XLSX = Path(r"C:\Users\avirn\OneDrive\Desktop\Sentrifugo 2.0\old data sentrifugo\employees_data_export.2026-06-26.xlsx")

CAL_NAME = "General Work Calendar"
CAL_START, CAL_END = "2018-01-01", "2030-12-31"
SHIFT_NAME = "Morning Shift"
SHIFT_START, SHIFT_END, SHIFT_BREAK = "09:30", "18:30", 60
# Mon..Sun per week-of-month: 1 = WORKING day, 0 = off (matches the LMS resolver
# and existing FE calendars). Mon–Fri working, Sat/Sun off.
WEEKEND_MATRIX = {str(w): [1, 1, 1, 1, 1, 0, 0] for w in range(1, 6)}
NOW = datetime.now(timezone.utc)


def audit() -> dict:
    return {"created_on": NOW, "created_by": MIGRATION_USER, "updated_on": None,
            "updated_by": None, "deleted_on": None, "deleted_by": None,
            "correlation_id": str(uuid.uuid4()), "import_batch": MARKER}


def read_employees() -> list[dict]:
    return read_rows(EMP_XLSX, sheet="Data")


def is_active(r: dict) -> bool:
    return str(r.get("EmployeeStatus")) == "1" and not r.get("DateOfLeaving")


async def main():
    global EMP_XLSX, ORG_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="write into the LMS DB (default: dry run)")
    ap.add_argument("--revert", action="store_true", help="delete this import's LMS data, then exit")
    ap.add_argument("--emp-file", help="employee export (.csv/.xlsx); overrides --data-dir")
    ap.add_argument("--data-dir", help="folder holding the export files (file picked by name)")
    ap.add_argument("--org-id", help="organisation id (default: the built-in one)")
    args = ap.parse_args()
    if args.emp_file:
        EMP_XLSX = Path(args.emp_file)
    elif args.data_dir:
        EMP_XLSX = find_file(args.data_dir, ["employee"])
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    lms = client[LMS_DB]

    if args.revert:
        out = {}
        for col in ("work_calendar_shift_assignments", "work_calendar_employees",
                    "work_calendar_shifts", "work_calendars"):
            out[col] = (await lms[col].delete_many({"import_batch": MARKER})).deleted_count
        print("Reverted (LMS):", out)
        client.close()
        return

    # Active employees -> their LMS user_id (match by email)
    lms_by_email = {}
    async for e in lms["employees"].find({"organisation_id": ORG_ID}):
        em = (e.get("work_email") or "").strip().lower()
        if em and e.get("user_id"):
            lms_by_email[em] = e["user_id"]

    active_uids, unmatched = [], 0
    for r in read_employees():
        if not is_active(r):
            continue
        em = str(r.get("EmailAddress") or "").strip().lower()
        uid = lms_by_email.get(em)
        if uid:
            active_uids.append(uid)
        else:
            unmatched += 1
    active_uids = list({str(u): u for u in active_uids}.values())  # dedupe

    all_bus = [b["_id"] async for b in lms["business_units"].find({"org_id": ORG_ID})]
    all_depts = [d["_id"] async for d in lms["departments"].find({"org_id": ORG_ID})]

    print(f"Calendar: '{CAL_NAME}' {CAL_START}..{CAL_END}, Mon–Fri, scope = {len(all_bus)} BUs + {len(all_depts)} depts")
    print(f"Shift:    '{SHIFT_NAME}' {SHIFT_START}-{SHIFT_END} (break {SHIFT_BREAK}m)")
    print(f"Assign to ACTIVE employees: {len(active_uids)} (unmatched active in LMS: {unmatched})")

    if not args.commit:
        print("\nDRY RUN — no writes. Re-run with --commit.")
        client.close()
        return

    # clean prior
    for col in ("work_calendar_shift_assignments", "work_calendar_employees",
                "work_calendar_shifts", "work_calendars"):
        await lms[col].delete_many({"import_batch": MARKER})

    # 1. calendar
    cal = {
        "org_id": ORG_ID, "name": CAL_NAME, "year_type": "CUSTOM",
        "start_date": CAL_START, "end_date": CAL_END, "is_active": True, "is_default": True,
        "business_unit_ids": all_bus, "department_ids": all_depts,
        "week_config": {"week_start_day": "MONDAY", "work_week_start": "MONDAY",
                        "work_week_end": "FRIDAY", "allow_half_day": True},
        "weekend_matrix": WEEKEND_MATRIX, "statutory_config": None, **audit(),
    }
    await lms["work_calendars"].insert_one(cal)
    cal_oid = cal["_id"]

    # 2. shift (its _id is a string uuid; calendar_id stored as string)
    shift = {
        "_id": str(uuid.uuid4()), "calendar_id": str(cal_oid),
        "name": SHIFT_NAME, "start_time": SHIFT_START, "end_time": SHIFT_END,
        "break_minutes": SHIFT_BREAK, "org_id": ORG_ID, **audit(),
    }
    await lms["work_calendar_shifts"].insert_one(shift)
    shift_id = shift["_id"]

    # 3. calendar -> employees
    if active_uids:
        await lms["work_calendar_employees"].insert_many(
            [{"work_calendar_id": cal_oid, "org_id": ORG_ID, "user_id": u, **audit()} for u in active_uids])

    # 4. shift -> employees
    if active_uids:
        await lms["work_calendar_shift_assignments"].insert_many(
            [{"calendar_id": cal_oid, "org_id": ORG_ID, "user_id": u, "shift_id": shift_id, **audit()}
             for u in active_uids])

    print(f"\nCOMMITTED to LMS: 1 calendar, 1 shift, {len(active_uids)} calendar-assignments, "
          f"{len(active_uids)} shift-assignments.")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
