"""Repair the Wellness Leave double-deduction caused by the 2026-08-11 HR import.

WHAT HAPPENED
-------------
1. 2026-08-08 20:13  ``reverse_leave_credits`` zeroed employee_leave_balances and
   the tracker for 2114 ledger rows (242 of them Wellness Leave).
2. 2026-08-11 07:58  an ad-hoc DB write (stamped ``import_batch`` /
   ``import_added_hours``) pushed HR's spreadsheet balances straight into
   ``leave_employee_balance_tracker``. Nothing in src/ or scripts/ writes
   ``import_batch`` — this bypassed the ledger, employee_leave_balances and the
   hold system entirely. Those numbers ALREADY had July's leave netted out.
3. 2026-08-11 09:23 onwards  managers began approving still-PENDING July-dated
   requests. Each approval ran the debit at src/leave_requests/service.py:1904
   and subtracted hours HR had already subtracted — deducting the same leave twice.

WHAT THIS SCRIPT DOES
---------------------
Credits back, per employee, exactly the hours that were debited twice: every
Wellness Leave request that is APPROVED, is NOT loss-of-pay, starts before
2026-08-01, and whose approval landed AFTER the import timestamp.

The refund is derived from the approval records themselves, NOT from
(import_added_hours - balance_hours). That distinction matters: SIL-0954 has a
legitimate 2026-08-10 approval that also moved the balance after the import, and
a delta-based repair would wrongly revert it.

Every candidate must independently satisfy

    balance_hours + refund == import_added_hours

before it is written. A row that fails this guard is reported and skipped (state
drifted since the last dry run) unless --force is passed.

Two writes per repaired request, mirroring how the app itself moves balances:

    leave_employee_balance_tracker   $inc balance_hours  (via src.balance_tracker.upsert_balance)
    leave_entitlement_ledger         a compensating CREDIT row, reference_id = the request id

The ledger row is also the idempotency record: a request that already has a
compensating row carrying REPAIR_TAG is skipped, so re-running is safe.

NOT TOUCHED
-----------
    employee_leave_balances   still all-zero for Wellness across 121 rows. Six
                              analytics modules read it (cfo/employee/hr/manager/
                              md dashboards, quarterly_scores) and will keep
                              reporting 0 until that is back-filled separately.
                              Deliberately out of scope here: incrementing 7 of
                              121 zero rows would produce a partial, misleading
                              state. It also cannot be fixed by re-running the
                              accrual — last_credit_period_key is already 2026:H2,
                              so the engine will skip it.
    leave_credit_ledger       484 Wellness accrual rows still assert credits that
                              employee_leave_balances says never happened.
    leave_balance_holds       none of the affected July requests has a hold; they
                              predate the backfill.
    leave_requests            statuses are left exactly as they are.

STILL PENDING (reported, never modified)
----------------------------------------
July-dated PENDING Wellness requests are live landmines: HR already netted those
days out, so approving one repeats the double-deduction. This script lists them
and stops there — clearing them is an authority decision, not a data fix. Fix the
approval path (a sufficiency re-check + zero floor at service.py:1904, since
validation.py:1196 only guards request creation) before releasing the freeze.

Usage:
    # report only, writes nothing — always run this first
    python -m scripts.repair_wellness_double_deduction

    # apply, recording who authorised it
    python -m scripts.repair_wellness_double_deduction --apply --actor <user_id>
"""

import argparse
import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from src.balance_tracker import TRACKER_COLLECTION, upsert_balance
from src.config import settings
from src.utils import to_oid

WELLNESS_LEAVE_TYPE_ID = ObjectId("6a58c5c8fd90e1e41995ca91")
REQUESTS_COL = "leave_requests"
ENTITLEMENT_LEDGER_COL = "leave_entitlement_ledger"
EMPLOYEES_COL = "employees"

# The ad-hoc HR import ran at 2026-08-11 07:58 UTC. Anything that moved a balance
# after this point moved a balance HR had already finalised.
IMPORT_TS = datetime(2026, 8, 11, 8, 30, tzinfo=timezone.utc)

# Leave starting before this date was inside the period HR had already netted out.
HR_CUTOFF_DATE = "2026-08-01"

# Marks our compensating ledger rows, so a re-run recognises its own work.
REPAIR_TAG = "wellness-double-deduction-repair-2026-08"

HOURS_PER_DAY = 8.0
TOLERANCE = 1e-6


def _start_date(request: dict) -> str:
    return str(request.get("start_date"))[:10]


async def _load_candidates(db) -> list[dict]:
    """Requests debited twice: July-dated Wellness leave approved after the import."""
    employees = {
        e.get("user_id"): e async for e in db[EMPLOYEES_COL].find({}) if e.get("user_id")
    }

    candidates: list[dict] = []
    async for request in db[REQUESTS_COL].find(
        {"leave_type_id": WELLNESS_LEAVE_TYPE_ID, "status": "APPROVED"}
    ):
        updated_on = request.get("updated_on")
        if not updated_on:
            continue
        if updated_on.tzinfo is None:
            updated_on = updated_on.replace(tzinfo=timezone.utc)
        if updated_on <= IMPORT_TS:
            continue
        if _start_date(request) >= HR_CUTOFF_DATE:
            continue
        if request.get("loss_of_pay"):
            continue

        employee = employees.get(request["user_id"]) or {}
        candidates.append(
            {
                "request_id": request["_id"],
                "user_id": request["user_id"],
                "emp_code": employee.get("emp_code", "?"),
                "name": employee.get("name", ""),
                "start_date": _start_date(request),
                "hours": float(request.get("duration_hours") or 0.0),
                "leave_plan_id": request.get("leave_plan_id"),
                "approved_on": updated_on,
            }
        )

    candidates.sort(key=lambda c: (c["emp_code"], c["start_date"]))
    return candidates


async def _already_repaired(db, request_id) -> bool:
    return await db[ENTITLEMENT_LEDGER_COL].find_one(
        {"reference_id": str(request_id), "note": {"$regex": REPAIR_TAG}}
    ) is not None


async def _print_balance_table(db, entries: list[dict], heading: str) -> None:
    """Re-read the tracker and print where each affected employee actually stands.

    Deliberately re-queries rather than trusting the in-memory plan, so this
    reflects the database as it is right now — including any change made by
    something other than this script.
    """
    print(f"\n=== {heading} ===")
    print(
        f"  {'EMP':10} {'NAME':22} {'BEFORE':>9} {'AFTER':>9} {'AFTER':>7}  {'HR SAYS':>9}"
    )
    print(f"  {'':10} {'':22} {'(hours)':>9} {'(hours)':>9} {'(days)':>7}  {'(hours)':>9}")
    for entry in entries:
        tracker = await db[TRACKER_COLLECTION].find_one(
            {
                "user_id": to_oid(str(entry["user_id"])),
                "leave_type_id": WELLNESS_LEAVE_TYPE_ID,
            }
        )
        actual = float(tracker.get("balance_hours") or 0.0) if tracker else 0.0
        flag = "" if abs(actual - entry["imported"]) < TOLERANCE else "   <-- CHECK"
        print(
            f"  {entry['emp_code']:10} {entry['name'][:22]:22} "
            f"{entry['balance_before']:>9.1f} {actual:>9.1f} "
            f"{actual / HOURS_PER_DAY:>7.2f}  {entry['imported']:>9.1f}{flag}"
        )


async def _report_pending_landmines(db) -> list[dict]:
    employees = {
        e.get("user_id"): e async for e in db[EMPLOYEES_COL].find({}) if e.get("user_id")
    }
    landmines = []
    async for request in db[REQUESTS_COL].find(
        {"leave_type_id": WELLNESS_LEAVE_TYPE_ID, "status": "PENDING"}
    ):
        if _start_date(request) >= HR_CUTOFF_DATE:
            continue
        employee = employees.get(request["user_id"]) or {}
        landmines.append(
            {
                "request_id": str(request["_id"]),
                "emp_code": employee.get("emp_code", "?"),
                "name": employee.get("name", ""),
                "start_date": _start_date(request),
                "hours": float(request.get("duration_hours") or 0.0),
            }
        )
    landmines.sort(key=lambda c: c["emp_code"])
    return landmines


async def repair(apply: bool, actor_id: str, force: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    print(f"database : {db.name}")
    print(f"mode     : {'APPLY (writes)' if apply else 'DRY RUN (no writes)'}")
    print(f"import ts: {IMPORT_TS.isoformat()}   hr cutoff: {HR_CUTOFF_DATE}\n")

    candidates = await _load_candidates(db)
    if not candidates:
        print("No double-deducted requests found. Nothing to repair.")
        client.close()
        return

    # Group by employee: the guard compares one tracker row against the sum of
    # that employee's wrongly-debited requests.
    by_user: dict[ObjectId, list[dict]] = {}
    for candidate in candidates:
        by_user.setdefault(candidate["user_id"], []).append(candidate)

    planned: list[dict] = []
    skipped: list[dict] = []

    print("=== plan ===")
    for user_id, items in sorted(by_user.items(), key=lambda kv: kv[1][0]["emp_code"]):
        tracker = await db[TRACKER_COLLECTION].find_one(
            {"user_id": to_oid(str(user_id)), "leave_type_id": WELLNESS_LEAVE_TYPE_ID}
        )
        emp_code = items[0]["emp_code"]
        name = items[0]["name"]

        if not tracker:
            skipped.append({"emp_code": emp_code, "reason": "no tracker row"})
            print(f"  SKIP {emp_code:10} {name[:22]:22} no tracker row")
            continue

        balance = float(tracker.get("balance_hours") or 0.0)
        imported = float(tracker.get("import_added_hours") or 0.0)

        pending_items = []
        for item in items:
            if await _already_repaired(db, item["request_id"]):
                print(
                    f"  DONE {emp_code:10} {name[:22]:22} {item['start_date']} "
                    f"{item['hours']:>5}h  already repaired, skipping"
                )
                continue
            pending_items.append(item)

        if not pending_items:
            continue

        refund = sum(item["hours"] for item in pending_items)
        expected = balance + refund
        reconciles = abs(expected - imported) < TOLERANCE

        status = "OK" if reconciles else f"MISMATCH (import says {imported}h)"
        print(
            f"  {'FIX ' if reconciles or force else 'SKIP'} {emp_code:10} {name[:22]:22} "
            f"{balance:>7.1f}h + {refund:>5.1f}h -> {expected:>7.1f}h   {status}"
        )
        for item in pending_items:
            print(
                f"       request {item['request_id']} start={item['start_date']} "
                f"{item['hours']}h approved={item['approved_on'].isoformat()}"
            )

        if not reconciles and not force:
            skipped.append(
                {
                    "emp_code": emp_code,
                    "reason": f"guard failed: {balance} + {refund} != {imported}",
                }
            )
            continue

        planned.append(
            {
                "user_id": user_id,
                "emp_code": emp_code,
                "name": name,
                "balance_before": balance,
                "imported": imported,
                "refund": refund,
                "balance_after": expected,
                "items": pending_items,
            }
        )

    total_refund = sum(p["refund"] for p in planned)
    print(
        f"\n  {len(planned)} employee(s), {total_refund}h = {total_refund / HOURS_PER_DAY} "
        f"days to credit back; {len(skipped)} skipped"
    )
    for entry in skipped:
        print(f"    skipped {entry['emp_code']}: {entry['reason']}")

    landmines = await _report_pending_landmines(db)
    if landmines:
        print(
            f"\n=== {len(landmines)} July-dated PENDING request(s) — NOT modified ===\n"
            "    HR already netted these days out. Approving one repeats the\n"
            "    double-deduction. Resolve these before lifting any approval freeze."
        )
        for landmine in landmines:
            print(
                f"  {landmine['emp_code']:10} {landmine['name'][:22]:22} "
                f"{landmine['start_date']} {landmine['hours']}h  id={landmine['request_id']}"
            )

    if not apply:
        if planned:
            await _print_balance_table(
                db, planned, "current balances (unchanged — dry run)"
            )
        print("\nDRY RUN — nothing was written. Re-run with --apply --actor <user_id>.")
        client.close()
        return

    if not planned:
        print("\nNothing to apply.")
        client.close()
        return

    stamp = datetime.now(timezone.utc)
    backup_path = Path(
        f"wellness_double_deduction_backup_{stamp.strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    backup_path.write_text(
        json.dumps(
            [
                {
                    "user_id": str(p["user_id"]),
                    "emp_code": p["emp_code"],
                    "name": p["name"],
                    "balance_before": p["balance_before"],
                    "import_added_hours": p["imported"],
                    "refund_hours": p["refund"],
                    "balance_after": p["balance_after"],
                    "request_ids": [str(i["request_id"]) for i in p["items"]],
                }
                for p in planned
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nbackup written: {backup_path.resolve()}")

    print("\n=== applying ===")
    for entry in planned:
        for item in entry["items"]:
            # Compensating CREDIT pairs with the DEBIT that service.py wrote on
            # approval, and doubles as this script's idempotency record.
            await db[ENTITLEMENT_LEDGER_COL].insert_one(
                {
                    "_id": str(uuid.uuid4()),
                    "user_id": entry["user_id"],
                    "leave_type_id": WELLNESS_LEAVE_TYPE_ID,
                    "transaction_type": "CREDIT",
                    "amount": item["hours"],
                    "reference_id": str(item["request_id"]),
                    "note": (
                        f"[{REPAIR_TAG}] reversal of duplicate debit for leave "
                        f"starting {item['start_date']}; HR import of "
                        f"{IMPORT_TS.date()} had already netted this leave out"
                    ),
                    "created_on": stamp,
                    "created_by": to_oid(actor_id),
                }
            )
            await upsert_balance(
                db,
                str(entry["user_id"]),
                str(WELLNESS_LEAVE_TYPE_ID),
                item["leave_plan_id"],
                item["hours"],
                actor_id,
                stamp,
            )

        tracker = await db[TRACKER_COLLECTION].find_one(
            {"user_id": to_oid(str(entry["user_id"])), "leave_type_id": WELLNESS_LEAVE_TYPE_ID}
        )
        actual = float(tracker.get("balance_hours") or 0.0)
        verdict = "OK" if abs(actual - entry["balance_after"]) < TOLERANCE else "UNEXPECTED"
        print(
            f"  {entry['emp_code']:10} {entry['name'][:22]:22} "
            f"{entry['balance_before']:>7.1f}h -> {actual:>7.1f}h "
            f"(expected {entry['balance_after']:.1f}h) {verdict}"
        )

    await _print_balance_table(db, planned, "current balances after repair")

    print(
        f"\nDone. Credited back {total_refund}h "
        f"({total_refund / HOURS_PER_DAY} days) to {len(planned)} employee(s)."
    )
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--apply", action="store_true", help="write the repair (default is a dry run)"
    )
    parser.add_argument(
        "--actor", help="user_id recorded as created_by/updated_by; required with --apply"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="repair even if balance + refund != import_added_hours (guard off)",
    )
    args = parser.parse_args()

    if args.apply and not args.actor:
        parser.error("--apply requires --actor <user_id> so the change is attributable")

    asyncio.run(repair(apply=args.apply, actor_id=args.actor, force=args.force))
