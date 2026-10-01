"""Wipe the leave ledgers and year-end artifacts, leaving balances intact.

Clears the ledger history so a box that accrued under the old accelerated
``DEV:`` period keys can be re-run with real calendar period keys.

Dev mode has since been removed from the accrual path, so nothing writes ``DEV:``
keys any more — but rows written before that removal are still in the ledger, and
``--only-dev`` is how you clear exactly those and keep real credits.

DELETED:
    leave_credit_ledger        accrual/credit rows (the DEV: period keys)
    leave_entitlement_ledger   entitlement rows (year-end payout/encash/expiry)
    leave_year_end_execution   one record per year-end run
    payroll_events             ONLY with --include-payroll-events (see below)

PRESERVED — never touched by this script:
    employee_leave_balances          materialized balance ($inc counter)
    leave_employee_balance_tracker   the mirror the read paths actually use
    leave_balance_holds              hours reserved by PENDING requests

READ THIS BEFORE RUNNING
------------------------
Balances are NOT derived from the ledger. ``_write_credit`` inserts the ledger
row and separately ``$inc``s employee_leave_balances and the tracker. Keeping
balances while deleting ledger rows therefore destroys the idempotency records
that ``_already_credited`` relies on: the next credit run finds no ledger row
for a period and credits it again ON TOP of the balance that is already there.

That is the intended trade-off here (balances intact was the requirement), but
it means the next credit run tops up balances that already contain those hours.

The engine is forward-only, so the damage is now bounded: a run credits only the
periods anchored in ITS OWN month, not every period of the leave year. The one
exception is STATUTORY leave, which stays due from the leave year's opening month
onward so that mid-year joiners still receive it — wipe the ledger and the next
run re-posts every employee's statutory grant on top of their existing balance.
That is exactly how the 2026-08-08 incident happened. Plan for it: keep the
accrual cron stopped, re-seed the ledger, or accept the top-up.

``payroll_events`` is a handoff collection the payroll service consumes, so it
is excluded by default — clearing it reaches outside this microservice.

Usage:
    # Dry run — report what WOULD be deleted (default):
    python -m scripts.wipe_leave_ledgers

    # Apply (the DB name must match what you pass to --confirm-db):
    python -m scripts.wipe_leave_ledgers --apply --confirm-db sentrifugo_qa

    # Only remove dev-mode accrual rows, keep real calendar-key credits:
    python -m scripts.wipe_leave_ledgers --only-dev --apply --confirm-db sentrifugo_qa
"""

import argparse
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient

from src.balance_tracker import TRACKER_COLLECTION
from src.config import settings
from src.entitlements.service import LEDGER_COLLECTION as ENTITLEMENT_LEDGER_COL
from src.leave_balance_processor.processor import BALANCE_COL, LEDGER_COL as CREDIT_LEDGER_COL
from src.leave_holds.service import HOLDS_COLLECTION
from src.year_end_processing.execution_service import (
    EXECUTION_COLLECTION,
    PAYROLL_EVENTS_COLLECTION,
)

# Legacy dev-mode period keys, written as "DEV:<FREQ>:<slot>" by the accelerated
# accrual path that has since been removed.
DEV_KEY_PREFIX = "DEV:"

PRESERVED = [BALANCE_COL, TRACKER_COLLECTION, HOLDS_COLLECTION]


def _targets(only_dev: bool, include_payroll: bool) -> list[tuple[str, dict]]:
    """(collection, delete_filter) pairs. An empty filter means "everything"."""
    # --only-dev is meaningful for the credit ledger alone: it is the only one of
    # these collections carrying a period_key.
    credit_filter = (
        {"period_key": {"$regex": f"^{DEV_KEY_PREFIX}"}} if only_dev else {}
    )
    targets = [
        (CREDIT_LEDGER_COL, credit_filter),
        (ENTITLEMENT_LEDGER_COL, {}),
        (EXECUTION_COLLECTION, {}),
    ]
    if include_payroll:
        targets.append((PAYROLL_EVENTS_COLLECTION, {}))
    return targets


async def wipe(apply: bool, confirm_db: str | None, only_dev: bool, include_payroll: bool) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    db_name = db.name

    if apply and confirm_db != db_name:
        print(f"ERROR: refusing to delete from database {db_name!r}.")
        print(f"       --apply requires --confirm-db {db_name}")
        client.close()
        return

    targets = _targets(only_dev, include_payroll)

    print(f"{'APPLYING' if apply else 'DRY RUN'} — database: {db_name}")
    if only_dev:
        print(f"Scope: {CREDIT_LEDGER_COL} limited to period_key starting {DEV_KEY_PREFIX!r}\n")
    else:
        print("Scope: all rows in the target collections\n")

    total = 0
    counts: list[tuple[str, int]] = []
    for name, flt in targets:
        n = await db[name].count_documents(flt)
        counts.append((name, n))
        total += n
        print(f"  {name:<32} {n:>10,} row(s) to delete")

    print("\n  Preserved (untouched):")
    for name in PRESERVED:
        n = await db[name].count_documents({})
        print(f"  {name:<32} {n:>10,} row(s) kept")

    if not apply:
        print(f"\nDry run only — nothing deleted. {total:,} row(s) would be removed.")
        print("Re-run with --apply --confirm-db " + db_name + " to delete them.")
        client.close()
        return

    print()
    deleted = 0
    for name, flt in targets:
        result = await db[name].delete_many(flt)
        deleted += result.deleted_count
        print(f"  deleted {result.deleted_count:>10,} from {name}")

    print(f"\nDone. Removed {deleted:,} row(s).")
    print(
        "\nBalances were left intact, so the ledger no longer guards against "
        "re-crediting.\nThe next accrual run will top up every due period of the "
        "current leave year."
    )
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--apply", action="store_true", help="Delete (default is dry run)")
    parser.add_argument(
        "--confirm-db",
        metavar="NAME",
        help="Name of the target database; must match the connected DB to --apply",
    )
    parser.add_argument(
        "--only-dev",
        action="store_true",
        help=f"Restrict credit-ledger deletion to period_key starting {DEV_KEY_PREFIX!r}",
    )
    parser.add_argument(
        "--include-payroll-events",
        action="store_true",
        help="Also clear payroll_events (consumed by the payroll service — off by default)",
    )
    args = parser.parse_args()
    asyncio.run(
        wipe(args.apply, args.confirm_db, args.only_dev, args.include_payroll_events)
    )
