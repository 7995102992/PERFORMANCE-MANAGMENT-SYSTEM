"""Export leave request history for a fixed set of leave-type codes to CSV.

Pulls every (non-deleted) leave request whose leave type code is one of
WEEKLY_OFF, OPTIONAL_HOLIDAY_2, OPTIONAL_HOLIDAY_1, OFFICIAL_WORK and writes:

    leave_type_code, emp_code, emp_name, dates, reason,
    approval_status, approved_by, approved_on

"approved_by"/"approved_on" reflect the most recent APPROVED entry in
leave_request_activity for that request (the approval that finalized it, for
multi-level flows); both are blank for requests that were never approved.

Usage:
    python -m scripts.export_leave_history_by_type
    python -m scripts.export_leave_history_by_type --output leave_history.csv
    python -m scripts.export_leave_history_by_type --codes WEEKLY_OFF,OFFICIAL_WORK
"""

import argparse
import asyncio
import csv

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

REQUESTS_COLLECTION = "leave_requests"
ACTIVITY_COLLECTION = "leave_request_activity"

DEFAULT_CODES = [
    "WEEKLY_OFF",
    "OPTIONAL_HOLIDAY_2",
    "OPTIONAL_HOLIDAY_1",
    "OFFICIAL_WORK",
]

FIELDNAMES = [
    "leave_type_code",
    "emp_code",
    "emp_name",
    "dates",
    "reason",
    "approval_status",
    "approved_by",
    "approved_on",
]


def _format_dates(start_date, end_date) -> str:
    if start_date == end_date:
        return str(start_date)
    return f"{start_date} to {end_date}"


def _person_name(person: dict | None) -> str:
    if not person:
        return ""
    first = (person.get("first_name") or "").strip()
    last = (person.get("last_name") or "").strip()
    if first or last:
        return f"{first} {last}".strip()
    return person.get("full_name") or person.get("name") or ""


async def export(output_path: str, codes: list[str]) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    leave_types = await db["leave_types"].find(
        {"code": {"$in": codes}, "deleted_on": None}
    ).to_list(length=None)
    if not leave_types:
        print(f"No leave types found for codes: {codes}")
        return

    code_by_id = {lt["_id"]: lt["code"] for lt in leave_types}
    missing = set(codes) - set(code_by_id.values())
    if missing:
        print(f"WARNING: no leave type found for code(s): {sorted(missing)}")

    requests = await db[REQUESTS_COLLECTION].find({
        "leave_type_id": {"$in": list(code_by_id.keys())},
        "deleted_on": None,
    }).sort("start_date", 1).to_list(length=None)

    print(f"Found {len(requests)} leave request(s) across {len(code_by_id)} leave type(s).")

    # Preload employees/users for name + emp_code lookups.
    user_ids = {r["user_id"] for r in requests}
    employees = await db["employees"].find(
        {"user_id": {"$in": list(user_ids)}},
        {"user_id": 1, "emp_code": 1, "first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
    ).to_list(length=None)
    employee_by_user_id = {e["user_id"]: e for e in employees}

    users_missing = [uid for uid in user_ids if uid not in employee_by_user_id]
    users = {}
    if users_missing:
        for u in await db["users"].find(
            {"_id": {"$in": users_missing}},
            {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
        ).to_list(length=None):
            users[u["_id"]] = u

    # Preload the latest APPROVED activity per request.
    request_ids = [r["_id"] for r in requests]
    approvals = await db[ACTIVITY_COLLECTION].find(
        {"leave_request_id": {"$in": request_ids}, "action": "APPROVED"}
    ).sort("timestamp", 1).to_list(length=None)
    latest_approval_by_request = {}
    for act in approvals:
        latest_approval_by_request[act["leave_request_id"]] = act  # last write wins (sorted ascending)

    approver_ids = {a["actor_id"] for a in approvals}
    approver_employees = await db["employees"].find(
        {"user_id": {"$in": list(approver_ids)}},
        {"user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
    ).to_list(length=None)
    approver_by_user_id = {e["user_id"]: e for e in approver_employees}
    approvers_missing = [uid for uid in approver_ids if uid not in approver_by_user_id]
    approver_users = {}
    if approvers_missing:
        for u in await db["users"].find(
            {"_id": {"$in": approvers_missing}},
            {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
        ).to_list(length=None):
            approver_users[u["_id"]] = u

    rows = []
    for r in requests:
        emp = employee_by_user_id.get(r["user_id"])
        emp_name = _person_name(emp) or _person_name(users.get(r["user_id"]))
        emp_code = (emp or {}).get("emp_code") or ""

        approval = latest_approval_by_request.get(r["_id"])
        approved_by = ""
        approved_on = ""
        if approval:
            approver = approver_by_user_id.get(approval["actor_id"]) or approver_users.get(approval["actor_id"])
            approved_by = _person_name(approver)
            approved_on = approval["timestamp"].isoformat()

        rows.append({
            "leave_type_code": code_by_id.get(r["leave_type_id"], ""),
            "emp_code": emp_code,
            "emp_name": emp_name,
            "dates": _format_dates(r["start_date"], r["end_date"]),
            "reason": r.get("reason") or "",
            "approval_status": r.get("status") or "",
            "approved_by": approved_by,
            "approved_on": approved_on,
        })

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} row(s) to {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", default="leave_history_export.csv",
        help="Output CSV path (default: leave_history_export.csv)",
    )
    parser.add_argument(
        "--codes", default=",".join(DEFAULT_CODES),
        help=f"Comma-separated leave type codes (default: {','.join(DEFAULT_CODES)})",
    )
    args = parser.parse_args()
    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    asyncio.run(export(args.output, codes))


if __name__ == "__main__":
    main()
