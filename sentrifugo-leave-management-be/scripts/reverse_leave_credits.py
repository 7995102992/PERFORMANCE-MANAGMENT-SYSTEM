"""Reverse accrual credits selected by period key (and optional narrower scope).

This is the exact inverse of ``_write_credit`` in
``src/leave_balance_processor/processor.py``. That function does three writes per
credit, so an undo must touch all three:

    leave_credit_ledger              the audit row  (+ idempotency record)
    employee_leave_balances          $inc balance / total_credited   (per employee+plan+type)
    leave_employee_balance_tracker   $inc balance_hours              (per user+type — THE READ PATH)

Reversing the ledger alone leaves the balances the app actually serves untouched,
which is why this script always moves all three together.

TWO MODES
---------
--mode adjust   (default, audit-preserving)
    Keeps the original GRANT_CREDIT / ACCRUAL_CREDIT rows and inserts a
    compensating row per original with a NEGATIVE amount and
    transaction_type=ADJUSTMENT, reusing the same period_key.

    * The unique index (employee, plan, type, period_key, transaction_type)
      permits this because transaction_type differs.
    * ADJUSTMENT is summed as credit everywhere that matters — run_credit_expiry's
      "alive" total (processor.py) and dashboard/service.py — so the negative row
      correctly lowers those totals rather than being ignored.
    * The originals survive, so ``_already_credited`` still returns True and the
      accrual cron will NOT re-credit these periods.

--mode delete   (destructive, re-openable)
    Deletes the original rows outright.

    * This destroys the idempotency record. The engine is forward-only, so a
      re-credit only happens for periods anchored in the month a run actually
      fires (the 1st) — plus STATUTORY leave, which stays due from the leave
      year's opening month onward and so re-posts on the very next run. Only use
      this when you intend to re-credit after fixing the plan config.
    * ``last_credit_period_key`` on employee_leave_balances is recomputed from the
      newest surviving ledger row for that employee+plan+type (unset if none).

NOT TOUCHED by either mode
--------------------------
    leave_balance_holds            hours reserved by PENDING requests
    leave_entitlement_ledger       manual admin credits/debits
    payroll_events                 consumed by the payroll service

The ``leave.allocated`` journey event already published to IAM cannot be recalled;
its idempotency key is per leave-year, so a later re-credit will not re-emit it.

CLAMPING
--------
A balance is not allowed to go below zero by default: if an employee already spent
part of a credit being reversed, the decrement is clamped and the shortfall is
reported per account. Pass --allow-negative to subtract the full amount and let the
balance go negative instead.

The clamp reads the current value and then decrements, so run this with the accrual
cron and ideally live traffic quiesced — a concurrent debit between the read and the
write would be missed by the clamp.

Usage:
    # What would be reversed (dry run is the default):
    python -m scripts.reverse_leave_credits --period-key 2026:ANNUAL

    # A whole bad run, all keys written on one UTC day:
    python -m scripts.reverse_leave_credits --credited-on 2026-08-08

    # Several keys, one plan, audit-preserving, for real:
    python -m scripts.reverse_leave_credits \
        --period-key 2026:ANNUAL --period-key 2026:H1 --period-key 2026:H2 \
        --plan 6a4e2bca7173c2d8b1230748 \
        --apply --confirm-db sentrifugo_lms

    # Wipe the rows so the cron can re-credit them after a config fix:
    python -m scripts.reverse_leave_credits --credited-on 2026-08-08 \
        --mode delete --apply --confirm-db sentrifugo_lms
"""

import argparse
import asyncio
import json
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from src.balance_tracker import TRACKER_COLLECTION
from src.config import settings
from src.leave_balance_processor.processor import BALANCE_COL, LEDGER_COL
from src.leave_balance_processor.schemas import CreditTransactionType
from src.utils import to_oid

EMPLOYEES_COL = "employees"
SYSTEM_USER = "SYSTEM"

# Only accrual-generated credit is reversible here. DEBIT / REVERSAL / EXPIRY_LAPSE
# belong to the leave-request and expiry flows and must not be swept up by a
# period-key filter.
DEFAULT_TXN_TYPES = [
    CreditTransactionType.GRANT_CREDIT.value,
    CreditTransactionType.ACCRUAL_CREDIT.value,
]


def _build_filter(args) -> dict:
    flt: dict = {}

    keys = list(args.period_key or [])
    if keys and args.period_key_regex:
        raise SystemExit("ERROR: use either --period-key or --period-key-regex, not both.")
    if keys:
        flt["period_key"] = keys[0] if len(keys) == 1 else {"$in": keys}
    elif args.period_key_regex:
        flt["period_key"] = {"$regex": args.period_key_regex}

    if args.credited_on:
        try:
            day = datetime.strptime(args.credited_on, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            raise SystemExit("ERROR: --credited-on must be YYYY-MM-DD (UTC).")
        flt["created_on"] = {"$gte": day, "$lt": day + timedelta(days=1)}

    if args.org:
        flt["org_id"] = to_oid(args.org)
    if args.plan:
        flt["leave_plan_id"] = to_oid(args.plan)
    if args.employee:
        emp_oids = [to_oid(e) for e in args.employee]
        flt["employee_id"] = emp_oids[0] if len(emp_oids) == 1 else {"$in": emp_oids}
    if args.leave_type:
        lt_oids = [to_oid(t) for t in args.leave_type]
        flt["leave_type_id"] = lt_oids[0] if len(lt_oids) == 1 else {"$in": lt_oids}

    flt["transaction_type"] = {"$in": args.transaction_type}
    return flt


def _fmt_hours(h: float) -> str:
    return f"{h:,.1f}h ({h / 8:,.2f}d)"


async def reverse(args) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    # A bare --apply with no selector would reverse every accrual credit ever
    # written. Require something that narrows the sweep.
    if not (args.period_key or args.period_key_regex or args.credited_on):
        raise SystemExit(
            "ERROR: one of --period-key / --period-key-regex / --credited-on is required."
        )

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    db_name = db.name

    if args.apply and args.confirm_db != db_name:
        print(f"ERROR: refusing to modify database {db_name!r}.")
        print(f"       --apply requires --confirm-db {db_name}")
        client.close()
        return

    flt = _build_filter(args)
    rows = await db[LEDGER_COL].find(flt).to_list(length=None)

    print(f"{'APPLYING' if args.apply else 'DRY RUN'} — database: {db_name}  mode: {args.mode}")
    print(f"filter: {json.dumps(flt, default=str)}\n")

    if not rows:
        print("No matching ledger rows. Nothing to do.")
        client.close()
        return

    # ── Aggregate the impact ─────────────────────────────────────────────────
    # Counter is keyed by employee+plan+type; the tracker is keyed by user+type
    # across plans, so the two need separate roll-ups.
    per_counter: dict[tuple, float] = defaultdict(float)
    per_key: dict[str, float] = defaultdict(float)
    employees: set = set()
    total_hours = 0.0

    for r in rows:
        amt = float(r.get("amount") or 0.0)
        total_hours += amt
        per_key[r.get("period_key") or "<none>"] += amt
        employees.add(r["employee_id"])
        per_counter[(r["employee_id"], r["leave_plan_id"], r["leave_type_id"])] += amt

    emp_docs = await db[EMPLOYEES_COL].find(
        {"_id": {"$in": list(employees)}}, {"_id": 1, "user_id": 1}
    ).to_list(length=None)
    user_by_emp = {d["_id"]: d.get("user_id") for d in emp_docs}

    per_tracker: dict[tuple, float] = defaultdict(float)
    missing_user: set = set()
    for (emp_id, _plan_id, lt_id), amt in per_counter.items():
        uid = user_by_emp.get(emp_id)
        if uid is None:
            missing_user.add(emp_id)
            continue
        per_tracker[(uid, lt_id)] += amt

    print(f"  ledger rows matched : {len(rows):,}")
    print(f"  employees affected  : {len(employees):,}")
    print(f"  total to reverse    : {_fmt_hours(total_hours)}\n")
    print("  by period key:")
    for k, v in sorted(per_key.items(), key=lambda kv: -kv[1]):
        print(f"    {k:<28} {_fmt_hours(v):>22}")

    if missing_user:
        print(
            f"\n  WARNING: {len(missing_user)} employee(s) have no user_id — their counter "
            "will be\n           adjusted but the tracker (the read path) cannot be."
        )

    # ── Preview the clamp against current balances ───────────────────────────
    shortfalls: list[str] = []
    for (uid, lt_id), amt in per_tracker.items():
        doc = await db[TRACKER_COLLECTION].find_one(
            {"user_id": to_oid(uid), "leave_type_id": to_oid(lt_id)}, {"balance_hours": 1}
        )
        cur = float((doc or {}).get("balance_hours") or 0.0)
        if cur < amt:
            shortfalls.append(
                f"    user={uid} type={lt_id}  tracker={cur:,.1f}h  reversing={amt:,.1f}h"
                f"  -> {'0.0h (clamped)' if not args.allow_negative else f'{cur - amt:,.1f}h'}"
            )
    if shortfalls:
        verb = "would go negative" if args.allow_negative else "will be clamped at 0"
        print(f"\n  {len(shortfalls)} tracker account(s) {verb} "
              "(credit already spent, or credited outside this ledger):")
        for line in shortfalls[:20]:
            print(line)
        if len(shortfalls) > 20:
            print(f"    ... and {len(shortfalls) - 20} more")

    if not args.apply:
        print(f"\nDry run only — nothing written. Re-run with --apply --confirm-db {db_name}")
        client.close()
        return

    # ── Backup before touching anything ──────────────────────────────────────
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = args.backup or f"reverse_leave_credits_{db_name}_{stamp}.json"
    with open(backup_path, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, default=str, indent=2)
    print(f"\n  backup written: {backup_path}  ({len(rows):,} row(s))")

    now = datetime.now(timezone.utc)

    # ── 1. Counters (employee_leave_balances) ────────────────────────────────
    counters_touched = 0
    for (emp_id, plan_id, lt_id), amt in per_counter.items():
        key = {"employee_id": emp_id, "leave_plan_id": plan_id, "leave_type_id": lt_id}
        doc = await db[BALANCE_COL].find_one(key, {"balance": 1})
        cur = float((doc or {}).get("balance") or 0.0)
        delta = amt if args.allow_negative else min(amt, max(cur, 0.0))
        if delta <= 0 and not args.allow_negative:
            continue
        await db[BALANCE_COL].update_one(
            key,
            {
                "$inc": {"balance": -delta, "total_credited": -delta},
                "$set": {"last_updated_on": now},
            },
        )
        counters_touched += 1
    print(f"  employee_leave_balances : {counters_touched:,} account(s) decremented")

    # ── 2. Tracker (what the app reads) ──────────────────────────────────────
    trackers_touched = 0
    for (uid, lt_id), amt in per_tracker.items():
        key = {"user_id": to_oid(uid), "leave_type_id": to_oid(lt_id)}
        doc = await db[TRACKER_COLLECTION].find_one(key, {"balance_hours": 1})
        cur = float((doc or {}).get("balance_hours") or 0.0)
        delta = amt if args.allow_negative else min(amt, max(cur, 0.0))
        if delta <= 0 and not args.allow_negative:
            continue
        await db[TRACKER_COLLECTION].update_one(
            key,
            {"$inc": {"balance_hours": -delta},
             "$set": {"updated_on": now, "updated_by": SYSTEM_USER}},
        )
        trackers_touched += 1
    print(f"  balance tracker         : {trackers_touched:,} account(s) decremented")

    # ── 3. Ledger ────────────────────────────────────────────────────────────
    if args.mode == "adjust":
        note = args.note or "Reversal of accrual credit (scripts/reverse_leave_credits)"
        docs = [{
            "_id": str(uuid.uuid4()),
            "employee_id": r["employee_id"],
            "org_id": r.get("org_id"),
            "leave_plan_id": r["leave_plan_id"],
            "leave_type_id": r["leave_type_id"],
            "transaction_type": CreditTransactionType.ADJUSTMENT.value,
            "amount": -float(r.get("amount") or 0.0),
            "effective_date": r.get("effective_date"),
            "period_year": r.get("period_year"),
            "period_month": r.get("period_month"),
            "period_quarter": r.get("period_quarter"),
            "period_half": r.get("period_half"),
            "period_key": r.get("period_key"),
            # Never expires: the negative must keep counting against the "alive"
            # total in run_credit_expiry for as long as the credit it cancels.
            "expires_at": None,
            "reference_id": str(r["_id"]),
            "note": f"{note} — reverses {r.get('transaction_type')} {r.get('period_key')}",
            "metadata": {"reversal_of": str(r["_id"]), "reversed_on": now.isoformat()},
            "created_on": now,
            "created_by": SYSTEM_USER,
        } for r in rows]
        await db[LEDGER_COL].insert_many(docs)
        print(f"  leave_credit_ledger     : {len(docs):,} ADJUSTMENT row(s) inserted "
              "(originals kept)")
        print("\nDone. Originals remain, so the accrual cron will NOT re-credit these periods.")
    else:
        result = await db[LEDGER_COL].delete_many({"_id": {"$in": [r["_id"] for r in rows]}})
        print(f"  leave_credit_ledger     : {result.deleted_count:,} row(s) deleted")

        # last_credit_period_key now points at a row that no longer exists.
        fixed = 0
        for (emp_id, plan_id, lt_id) in per_counter:
            newest = await db[LEDGER_COL].find_one(
                {"employee_id": emp_id, "leave_plan_id": plan_id, "leave_type_id": lt_id,
                 "transaction_type": {"$in": DEFAULT_TXN_TYPES}},
                {"period_key": 1},
                sort=[("created_on", -1)],
            )
            key = {"employee_id": emp_id, "leave_plan_id": plan_id, "leave_type_id": lt_id}
            if newest:
                await db[BALANCE_COL].update_one(
                    key, {"$set": {"last_credit_period_key": newest.get("period_key")}}
                )
            else:
                await db[BALANCE_COL].update_one(key, {"$unset": {"last_credit_period_key": ""}})
            fixed += 1
        print(f"  last_credit_period_key  : {fixed:,} account(s) recomputed")
        print(
            "\nDone. The idempotency records are GONE. The engine is forward-only, so "
            "the next\naccrual run re-credits only the periods anchored in the month it "
            "fires — but\nSTATUTORY leave re-posts immediately, since it stays due from "
            "the leave year's\nopening month onward. Fix the plan config first, or keep "
            "the service stopped."
        )

    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--period-key", action="append", metavar="KEY",
                        help="Exact period key, e.g. 2026:ANNUAL. Repeatable.")
    parser.add_argument("--period-key-regex", metavar="RE",
                        help="Regex over period_key, e.g. '^2026:PROB:'")
    parser.add_argument("--credited-on", metavar="YYYY-MM-DD",
                        help="Only rows written on this UTC day (one accrual run)")
    parser.add_argument("--org", metavar="OID", help="Restrict to one organisation")
    parser.add_argument("--plan", metavar="OID", help="Restrict to one leave plan")
    parser.add_argument("--employee", action="append", metavar="OID",
                        help="Restrict to one employee. Repeatable.")
    parser.add_argument("--leave-type", action="append", metavar="OID",
                        help="Restrict to one leave type. Repeatable.")
    parser.add_argument("--transaction-type", action="append", metavar="TYPE",
                        default=None,
                        help=f"Override the reversible types (default: {', '.join(DEFAULT_TXN_TYPES)})")
    parser.add_argument("--mode", choices=("adjust", "delete"), default="adjust",
                        help="adjust = compensating negative rows (default); "
                             "delete = remove the originals")
    parser.add_argument("--allow-negative", action="store_true",
                        help="Subtract in full even if a balance goes below zero")
    parser.add_argument("--note", metavar="TEXT", help="Note stored on the adjustment rows")
    parser.add_argument("--backup", metavar="PATH", help="Where to write the JSON backup")
    parser.add_argument("--apply", action="store_true", help="Write (default is dry run)")
    parser.add_argument("--confirm-db", metavar="NAME",
                        help="Target database name; must match the connected DB to --apply")
    args = parser.parse_args()
    if not args.transaction_type:
        args.transaction_type = DEFAULT_TXN_TYPES
    asyncio.run(reverse(args))
