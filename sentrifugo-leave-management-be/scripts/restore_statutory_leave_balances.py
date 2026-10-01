"""Restore the company-granted STATUTORY leave balances that the 2026-08-08
``reverse_leave_credits`` run zeroed.

WHAT HAPPENED
-------------
``reverse_leave_credits --mode adjust`` swept every credit written on
2026-08-08. That sweep was aimed at the accrual types, but it caught the
statutory grants as collateral: for each of the 7 statutory types on
"Annual Leave Policy-2026" all 121 employees now sit at

    leave_credit_ledger              GRANT_CREDIT +X  and  ADJUSTMENT -X   (net 0)
    employee_leave_balances          balance = total_credited = total_debited = 0
    leave_employee_balance_tracker   balance_hours = 0      <- THE READ PATH

The accrual cron cannot put these back. ``--mode adjust`` kept the original
GRANT_CREDIT rows, so ``_already_credited`` still returns True for
``{year}:ANNUAL`` and the engine skips them forever. Only a deliberate restore
moves them.

WHAT THIS SCRIPT DOES
---------------------
Per employee, per statutory leave type, per leave year:

    target_balance = granted_hours - hours_taken_this_leave_year

* ``granted_hours`` is read from the surviving GRANT_CREDIT / ACCRUAL_CREDIT
  rows in ``leave_credit_ledger`` for ``{leave_year}:ANNUAL`` — the exact amount
  the company actually granted this employee. It is NOT recomputed from
  ``max_statutory_days``, so an employee granted a non-standard amount keeps it,
  and an employee who was never granted the type gets nothing conjured for them.
* ``hours_taken_this_leave_year`` is the sum of ``duration_hours`` over that
  employee's APPROVED, non-loss-of-pay, non-deleted requests of that type whose
  ``start_date`` falls inside the leave year. Requests are attributed to the
  leave year they START in — matching the app, which debits the whole request at
  approval against the balance standing at that moment. A maternity request
  running past the year end is therefore charged in full to the year it opened.
* Types with ``deduct_from_leave_balance: false`` never consume balance, so their
  taken total is forced to 0 and the full grant is restored.
* An employee who took none of a type gets the full grant back — the same
  formula, with taken = 0.
* The target is floored at zero. Taking more than was granted is reported as a
  shortfall, never written as a negative balance.

WHY THE TAKEN LEAVE IS NOT ALREADY DEDUCTED
-------------------------------------------
Every current-year statutory request in this database carries
``import_batch = import_sagarsoft_leave_history_2026``: HR inserted them
already-APPROVED, bypassing the approval path. ``leave_entitlement_ledger`` holds
zero rows for statutory types, which confirms no debit was ever recorded for
them. So the grant sitting in the credit ledger is gross, and this script is what
nets the consumption out of it for the first time.

WRITES (three per restored row, mirroring how the app moves balance)
--------------------------------------------------------------------
    leave_entitlement_ledger        a CREDIT row for the restored grant, and a
                                    DEBIT row for the leave consumed. Two rows,
                                    not one net row, so reports that add admin
                                    credits and debits separately stay truthful.
                                    The CREDIT row is also the idempotency
                                    record: it carries RESTORE_TAG, and a
                                    (user, type, leave year) that already has one
                                    is skipped, so re-running is safe.
    leave_employee_balance_tracker  $inc balance_hours to land exactly on target
                                    (via src.balance_tracker.upsert_balance)
    employee_leave_balances         balance / total_credited / total_debited set
                                    to the restored figures

GUARD
-----
A row is only written when its tracker balance is currently 0 — the expected
post-reversal state. Anything else means something moved that balance since the
sweep, and blindly overwriting it would destroy that movement. Such rows are
reported and skipped unless --force is passed (which still lands on target).

NOT TOUCHED
-----------
    leave_credit_ledger     the GRANT_CREDIT / ADJUSTMENT pair is left intact. It
                            is the audit record of the grant and of the wrongful
                            reversal; the restore is recorded in
                            leave_entitlement_ledger instead, so the two ledgers
                            together net to the right number and no history is
                            rewritten. It also means the accrual cron still sees
                            {year}:ANNUAL as credited and will not double-grant.
    leave_balance_holds     no statutory request is PENDING, so none exist. Held
                            hours are subtracted at read time and are unaffected
                            by a gross-balance restore either way.
    leave_requests          statuses are left exactly as they are.
    non-statutory types     Annual / Earned / Wellness etc. are out of scope —
                            see scripts/repair_wellness_double_deduction.py.

KNOWN ANOMALY THIS SCRIPT REPORTS BUT WILL NOT FIX
--------------------------------------------------
Leave taken against a statutory type the employee holds no grant for (e.g.
"Maternity Leave Above 2 Kids", which is not on the plan's leave_type_ids yet has
an approved 2026 request). There is no entitlement to restore, so inventing a
balance would be a policy decision, not a data fix. Listed under "no grant".

Usage:
    # report only, writes nothing — always run this first
    python -m scripts.restore_statutory_leave_balances

    # narrow the sweep while checking
    python -m scripts.restore_statutory_leave_balances --leave-type <id> --employee <id>

    # apply, recording who authorised it
    python -m scripts.restore_statutory_leave_balances \
        --apply --actor <user_id> --confirm-db sentrifugo_lms
"""

import argparse
import asyncio
import json
import uuid
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

from src.balance_tracker import TRACKER_COLLECTION, upsert_balance
from src.config import settings
from src.leave_balance_processor.processor import BALANCE_COL, LEDGER_COL
from src.utils import to_oid

LEAVE_TYPES_COL = "leave_types"
PLANS_COL = "leave_plans"
REQUESTS_COL = "leave_requests"
EMPLOYEES_COL = "employees"
ENTITLEMENT_LEDGER_COL = "leave_entitlement_ledger"

# The credits a statutory grant can be made of. Statutory types always post as a
# single GRANT_CREDIT on {year}:ANNUAL; ACCRUAL_CREDIT is accepted so a type
# mis-configured as periodic still totals correctly.
CREDIT_TXN_TYPES = ["GRANT_CREDIT", "ACCRUAL_CREDIT"]

# Marks our restoring ledger rows, so a re-run recognises its own work.
RESTORE_TAG = "statutory-balance-restore-2026-08"

HOURS_PER_DAY = 8.0
TOLERANCE = 1e-6


def _leave_year(today: date, start_month: int) -> int:
    """Same rule as processor._leave_year: the year the current cycle opened in."""
    return today.year if today.month >= start_month else today.year - 1


def _leave_year_window(leave_year: int, start_month: int) -> tuple[str, str]:
    """[start, end) as YYYY-MM-DD strings — leave_requests.start_date is stored as
    a string, so a lexicographic range is an exact date range."""
    return (
        date(leave_year, start_month, 1).isoformat(),
        date(leave_year + 1, start_month, 1).isoformat(),
    )


def _fmt(hours: float) -> str:
    return f"{hours:,.1f}h ({hours / HOURS_PER_DAY:,.2f}d)"


async def _statutory_types(db, only_types) -> dict:
    query: dict = {"is_statutory_leave": True, "deleted_on": None}
    if only_types:
        query["_id"] = {"$in": [to_oid(t) for t in only_types]}
    docs = await db[LEAVE_TYPES_COL].find(query).to_list(length=None)
    return {str(d["_id"]): d for d in docs}


async def _plan_start_months(db) -> dict:
    """calendar_start_month per plan — the leave-year boundary the grant was
    posted against. Defaults to January when a plan does not declare one."""
    docs = await db[PLANS_COL].find({}, {"calendar_start_month": 1}).to_list(length=None)
    return {str(d["_id"]): int(d.get("calendar_start_month") or 1) for d in docs}


async def _consumed_requests(db, type_oids: list) -> dict:
    """Every consuming request of these types, grouped by (user, type).

    APPROVED only — PENDING reserves via leave_balance_holds (subtracted at read
    time, not from the stored balance) and CANCELLED/REJECTED never charged.
    Loss-of-pay requests are unpaid and never debit, matching the approval path.
    Fetched in one sweep and windowed in memory: each plan can open its leave
    year in a different month, so the date filter is applied per row later.
    """
    out: dict = defaultdict(list)
    async for row in db[REQUESTS_COL].find(
        {
            "leave_type_id": {"$in": type_oids},
            "status": "APPROVED",
            "deleted_on": None,
            "loss_of_pay": {"$ne": True},
        },
        {"user_id": 1, "leave_type_id": 1, "start_date": 1, "duration_hours": 1},
    ):
        out[(row.get("user_id"), row["leave_type_id"])].append(row)
    return out


def _window_slice(rows: list, window) -> tuple[float, list]:
    """The rows starting inside [window_start, window_end), and their hours."""
    start, end = window
    inside = [r for r in rows if start <= str(r.get("start_date"))[:10] < end]
    return sum(float(r.get("duration_hours") or 0.0) for r in inside), inside


async def _restored_keys(db, type_oids: list) -> set:
    """(user_id, leave_type_id, leave_year) tuples this script has already
    restored — read from its own CREDIT rows, so a re-run is a no-op."""
    keys: set = set()
    async for row in db[ENTITLEMENT_LEDGER_COL].find(
        {"leave_type_id": {"$in": type_oids}, "note": {"$regex": RESTORE_TAG}},
        {"user_id": 1, "leave_type_id": 1, "note": 1},
    ):
        note = row.get("note") or ""
        marker = note.split(f"{RESTORE_TAG}:", 1)[-1][:4]
        if marker.isdigit():
            keys.add((row.get("user_id"), row["leave_type_id"], int(marker)))
    return keys


async def _build_plan(db, args) -> tuple[list, list, list]:
    """Returns (rows to restore, skipped rows, taken-with-no-grant anomalies)."""
    types = await _statutory_types(db, args.leave_type)
    if not types:
        return [], [], []

    start_months = await _plan_start_months(db)
    today = date.today()
    type_oids = [to_oid(t) for t in types]

    employees = await db[EMPLOYEES_COL].find(
        {}, {"_id": 1, "user_id": 1, "emp_code": 1, "name": 1}
    ).to_list(length=None)
    emp_by_id = {e["_id"]: e for e in employees}
    emp_by_user = {e["user_id"]: e for e in employees if e.get("user_id")}

    # Everything the per-row decision needs, pulled in three sweeps rather than
    # three queries per employee-type — this runs over ~850 balance rows.
    consumed = await _consumed_requests(db, type_oids)
    restored = await _restored_keys(db, type_oids)
    tracker_by_key = {
        (t.get("user_id"), t.get("leave_type_id")): t
        async for t in db[TRACKER_COLLECTION].find({"leave_type_id": {"$in": type_oids}})
    }

    # ── Grants, grouped the way the credit ledger keys them: employee+plan+type ──
    credit_filter: dict = {
        "leave_type_id": {"$in": type_oids},
        "transaction_type": {"$in": CREDIT_TXN_TYPES},
    }
    if args.org:
        credit_filter["org_id"] = to_oid(args.org)
    if args.plan:
        credit_filter["leave_plan_id"] = to_oid(args.plan)
    if args.employee:
        credit_filter["employee_id"] = {"$in": [to_oid(e) for e in args.employee]}

    granted: dict = defaultdict(float)
    async for row in db[LEDGER_COL].find(credit_filter):
        start_month = start_months.get(str(row.get("leave_plan_id")), 1)
        leave_year = args.leave_year or _leave_year(today, start_month)
        if row.get("period_key") != f"{leave_year}:ANNUAL":
            continue
        key = (row["employee_id"], row["leave_plan_id"], row["leave_type_id"], leave_year)
        granted[key] += float(row.get("amount") or 0.0)

    planned: list = []
    skipped: list = []
    granted_users: set = set()

    for (emp_id, plan_oid, lt_oid, leave_year), grant in granted.items():
        lt = types[str(lt_oid)]
        employee = emp_by_id.get(emp_id) or {}
        user_id = employee.get("user_id")
        label = {
            "emp_code": employee.get("emp_code", "?"),
            "name": employee.get("name", ""),
            "leave_type": lt.get("code") or lt.get("name", ""),
        }

        if not user_id:
            skipped.append({**label, "reason": "employee has no user_id"})
            continue
        granted_users.add((user_id, lt_oid, leave_year))

        if grant <= 0:
            skipped.append({**label, "reason": f"grant is {grant}h — nothing to restore"})
            continue

        if (user_id, lt_oid, leave_year) in restored:
            skipped.append({**label, "reason": f"already restored for {leave_year}"})
            continue

        window = _leave_year_window(leave_year, start_months.get(str(plan_oid), 1))
        taken, taken_rows = _window_slice(consumed.get((user_id, lt_oid), []), window)
        # A type that does not deduct from balance cannot consume the grant, so
        # the full entitlement is restored however much of it was used.
        if not lt.get("deduct_from_leave_balance", lt.get("deduct_from_balance", True)):
            taken, taken_rows = 0.0, []

        target = max(0.0, grant - taken)

        tracker = tracker_by_key.get((user_id, lt_oid))
        current = float((tracker or {}).get("balance_hours") or 0.0)

        if abs(current) > TOLERANCE and not args.force:
            skipped.append({
                **label,
                "reason": f"tracker is {current}h, expected 0 — balance moved since the sweep",
            })
            continue

        planned.append({
            **label,
            "employee_id": emp_id,
            "user_id": user_id,
            "leave_plan_id": plan_oid,
            "leave_type_id": lt_oid,
            "leave_year": leave_year,
            "window": window,
            "grant": grant,
            "taken": taken,
            "shortfall": max(0.0, taken - grant),
            "current": current,
            "target": target,
            "delta": target - current,
            "request_ids": [str(r["_id"]) for r in taken_rows],
        })

    # ── Leave taken against a type the employee holds no grant for ───────────
    # No plan to read a boundary from here, so the anomaly scan uses the calendar
    # year. It only decides what gets LISTED — nothing is written from it.
    # Skipped entirely under a scope filter: granted_users then holds only the
    # narrowed slice, so every grant outside it would masquerade as an anomaly.
    anomaly_year = args.leave_year or _leave_year(today, 1)
    anomaly_window = _leave_year_window(anomaly_year, 1)
    anomalies: list = []
    scoped = bool(args.org or args.plan or args.employee or args.leave_type)
    for (user_id, lt_oid), rows in ({} if scoped else consumed).items():
        if (user_id, lt_oid, anomaly_year) in granted_users:
            continue
        _, inside = _window_slice(rows, anomaly_window)
        employee = emp_by_user.get(user_id) or {}
        lt = types[str(lt_oid)]
        for req in inside:
            anomalies.append({
                "emp_code": employee.get("emp_code", "?"),
                "name": employee.get("name", ""),
                "leave_type": lt.get("code") or lt.get("name", ""),
                "start_date": str(req.get("start_date"))[:10],
                "hours": float(req.get("duration_hours") or 0.0),
                "request_id": str(req["_id"]),
            })

    planned.sort(key=lambda p: (p["emp_code"], p["leave_type"]))
    skipped.sort(key=lambda s: (s["emp_code"], s["leave_type"]))
    anomalies.sort(key=lambda a: (a["emp_code"], a["leave_type"]))
    return planned, skipped, anomalies


def _print_plan(planned: list, skipped: list, anomalies: list) -> None:
    used = [p for p in planned if p["taken"] > 0]
    if planned:
        print("=== plan (only rows where leave was taken are listed in full) ===")
        print(
            f"  {'EMP':10} {'NAME':22} {'TYPE':12} {'GRANT':>9} {'TAKEN':>9} "
            f"{'NOW':>7} {'TARGET':>9} {'DAYS':>7}"
        )
        for p in used:
            note = ""
            if p["shortfall"]:
                note = f"   <-- took {p['shortfall']:.1f}h more than granted, floored at 0"
            print(
                f"  {p['emp_code']:10} {p['name'][:22]:22} {p['leave_type'][:12]:12} "
                f"{p['grant']:>9.1f} {p['taken']:>9.1f} {p['current']:>7.1f} "
                f"{p['target']:>9.1f} {p['target'] / HOURS_PER_DAY:>7.2f}{note}"
            )
        untouched = len(planned) - len(used)
        if untouched:
            print(f"  ... and {untouched} row(s) with no leave taken — full grant restored")

    by_type: dict = defaultdict(lambda: [0, 0.0])
    for p in planned:
        by_type[p["leave_type"]][0] += 1
        by_type[p["leave_type"]][1] += p["delta"]
    if by_type:
        print("\n=== hours to credit back, by leave type ===")
        for code, (rows, hours) in sorted(by_type.items(), key=lambda kv: -kv[1][1]):
            print(f"  {code:14} {rows:>4} row(s)  {_fmt(hours)}")

    total = sum(p["delta"] for p in planned)
    employees = len({p["employee_id"] for p in planned})
    print(
        f"\n  {len(planned)} balance row(s) across {employees} employee(s); "
        f"{_fmt(total)} to credit back; {len(skipped)} skipped"
    )

    if skipped:
        print("\n=== skipped ===")
        for s in skipped:
            print(
                f"  {s['emp_code']:10} {s['name'][:22]:22} "
                f"{s['leave_type'][:12]:12} {s['reason']}"
            )

    if anomalies:
        print(
            f"\n=== {len(anomalies)} approved request(s) against a type with NO grant "
            "— NOT restored ===\n"
            "    There is no entitlement to restore here. Granting one is a policy\n"
            "    call for HR, not a data fix."
        )
        for a in anomalies:
            print(
                f"  {a['emp_code']:10} {a['name'][:22]:22} {a['leave_type'][:12]:12} "
                f"{a['start_date']} {a['hours']:>7.1f}h  id={a['request_id']}"
            )


async def _apply(db, planned: list, actor_id: str) -> None:
    stamp = datetime.now(timezone.utc)

    backup_path = Path(
        f"statutory_balance_restore_backup_{stamp.strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    backup_path.write_text(
        json.dumps(
            [
                {
                    "employee_id": str(p["employee_id"]),
                    "user_id": str(p["user_id"]),
                    "emp_code": p["emp_code"],
                    "name": p["name"],
                    "leave_type_id": str(p["leave_type_id"]),
                    "leave_type": p["leave_type"],
                    "leave_plan_id": str(p["leave_plan_id"]),
                    "leave_year": p["leave_year"],
                    "granted_hours": p["grant"],
                    "taken_hours": p["taken"],
                    "balance_before": p["current"],
                    "balance_after": p["target"],
                    "request_ids": p["request_ids"],
                }
                for p in planned
            ],
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nbackup written: {backup_path.resolve()}")

    print("\n=== applying ===")
    ok = failed = 0
    for p in planned:
        year = p["leave_year"]
        # The CREDIT row restores the grant the sweep reversed and doubles as the
        # idempotency record — _already_restored matches on RESTORE_TAG:year.
        await db[ENTITLEMENT_LEDGER_COL].insert_one({
            "_id": str(uuid.uuid4()),
            "user_id": p["user_id"],
            "leave_type_id": p["leave_type_id"],
            "transaction_type": "CREDIT",
            "amount": p["grant"],
            "reference_id": None,
            "note": (
                f"[{RESTORE_TAG}:{year}] restore of the statutory {p['leave_type']} "
                f"grant for leave year {year}, reversed in error by the 2026-08-08 "
                f"accrual sweep"
            ),
            "created_on": stamp,
            "created_by": to_oid(actor_id),
        })
        # The consumption HR's import never recorded. Written separately from the
        # credit so reports that sum admin credits and debits apart stay honest.
        if p["taken"] > 0:
            await db[ENTITLEMENT_LEDGER_COL].insert_one({
                "_id": str(uuid.uuid4()),
                "user_id": p["user_id"],
                "leave_type_id": p["leave_type_id"],
                "transaction_type": "DEBIT",
                "amount": p["taken"],
                "reference_id": None,
                "note": (
                    f"[{RESTORE_TAG}:{year}] {p['leave_type']} consumed in leave year "
                    f"{year} ({p['window'][0]}..{p['window'][1]}); the imported "
                    f"requests were inserted already-approved and never debited"
                ),
                "created_on": stamp,
                "created_by": to_oid(actor_id),
            })

        await upsert_balance(
            db,
            str(p["user_id"]),
            str(p["leave_type_id"]),
            str(p["leave_plan_id"]) if p["leave_plan_id"] else None,
            p["delta"],
            actor_id,
            stamp,
        )

        # The analytics surfaces (cfo/employee/hr/manager/md dashboards,
        # quarterly_scores) read this collection, not the tracker. total_debited is
        # capped at the grant so credited - debited always equals the stored balance.
        await db[BALANCE_COL].update_one(
            {
                "employee_id": p["employee_id"],
                "leave_plan_id": p["leave_plan_id"],
                "leave_type_id": p["leave_type_id"],
            },
            {
                "$set": {
                    "balance": p["target"],
                    "total_credited": p["grant"],
                    "total_debited": min(p["taken"], p["grant"]),
                    "last_updated_on": stamp,
                }
            },
        )

        tracker = await db[TRACKER_COLLECTION].find_one(
            {"user_id": p["user_id"], "leave_type_id": p["leave_type_id"]}
        )
        actual = float((tracker or {}).get("balance_hours") or 0.0)
        good = abs(actual - p["target"]) < TOLERANCE
        ok, failed = (ok + 1, failed) if good else (ok, failed + 1)
        if not good or p["taken"] > 0:
            print(
                f"  {p['emp_code']:10} {p['name'][:22]:22} {p['leave_type'][:12]:12} "
                f"{p['current']:>8.1f}h -> {actual:>8.1f}h "
                f"(expected {p['target']:.1f}h) {'OK' if good else 'UNEXPECTED'}"
            )

    total = sum(p["delta"] for p in planned)
    print(
        f"\nDone. Restored {_fmt(total)} across {len(planned)} balance row(s). "
        f"{ok} verified, {failed} unexpected."
    )


async def restore(args) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    if args.apply and args.confirm_db != db.name:
        print(f"ERROR: refusing to modify database {db.name!r}.")
        print(f"       --apply requires --confirm-db {db.name}")
        client.close()
        return

    print(f"database : {db.name}")
    print(f"mode     : {'APPLY (writes)' if args.apply else 'DRY RUN (no writes)'}")
    print(f"tag      : {RESTORE_TAG}\n")

    planned, skipped, anomalies = await _build_plan(db, args)
    _print_plan(planned, skipped, anomalies)

    if not planned:
        print("\nNothing to restore.")
        client.close()
        return

    if not args.apply:
        print(
            "\nDRY RUN — nothing was written. Re-run with "
            f"--apply --actor <user_id> --confirm-db {db.name}."
        )
        client.close()
        return

    await _apply(db, planned, args.actor)
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--apply", action="store_true", help="write the restore (default is a dry run)"
    )
    parser.add_argument(
        "--actor", help="user_id recorded as created_by/updated_by; required with --apply"
    )
    parser.add_argument(
        "--confirm-db",
        help="database name, must match the connection; required with --apply",
    )
    parser.add_argument(
        "--leave-year",
        type=int,
        help="leave year to restore (default: the year the current cycle opened in)",
    )
    parser.add_argument(
        "--leave-type",
        action="append",
        help="restrict to this statutory leave type id (repeatable)",
    )
    parser.add_argument(
        "--employee", action="append", help="restrict to this employee id (repeatable)"
    )
    parser.add_argument("--org", help="restrict to this org id")
    parser.add_argument("--plan", help="restrict to this leave plan id")
    parser.add_argument(
        "--force",
        action="store_true",
        help="restore even when the tracker balance is not 0 (guard off) — it still "
        "lands on grant minus taken, overwriting whatever moved it",
    )
    args = parser.parse_args()

    if args.apply and not args.actor:
        parser.error("--apply requires --actor <user_id> so the change is attributable")
    if args.apply and not args.confirm_db:
        parser.error("--apply requires --confirm-db <database name>")

    asyncio.run(restore(args))
