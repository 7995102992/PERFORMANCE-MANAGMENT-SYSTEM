"""Wipe ONE ORGANISATION's leave balances — the counters the app actually reads.

The exact complement of ``wipe_leave_ledgers.py``: that script clears the audit
trail and preserves balances, this one clears balances and preserves the audit
trail. Read the pairing note below before running either.

DELETED (scoped to --org-id):
    employee_leave_balances          materialized balance ($inc counter)
    leave_employee_balance_tracker   the mirror every read path uses
    leave_balance_holds              ONLY with --include-holds (see below)

PRESERVED — never touched by this script:
    leave_credit_ledger              accrual/credit audit rows
    leave_entitlement_ledger         year-end payout/encash/expiry rows
    leave_year_end_execution         one record per year-end run
    leave_requests                   the requests themselves

Rows are deleted, not zeroed. Both stores are upserted on the next write
(``_write_credit`` / ``tracker_upsert_balance``), so a missing row and a zero row
behave identically — a deleted row is simply recreated on the next credit.

READ THIS BEFORE RUNNING — the pairing trap
-------------------------------------------
Balances are NOT derived from the ledger, so wiping one does NOT rebuild the
other. The credit ledger is the idempotency record ``_already_credited`` reads:

    balances wiped, ledger kept  -> accrual sees "already credited" for every
                                    period and re-credits NOTHING. Balances stay
                                    at zero permanently. Almost never what you want.
    ledger wiped, balances kept  -> accrual re-credits on top of balances that
                                    already include it. Double-credit.
    both wiped                   -> clean slate; accrual rebuilds from scratch.

So this script is normally run WITH ``wipe_leave_ledgers.py``, not instead of it.
It counts the surviving credit-ledger rows for the org and warns you when they
would block the refill.

Holds are excluded by default: a hold is hours reserved by a still-PENDING
request, and deleting it silently frees hours the request is still going to
consume. Clear them only if you are wiping the requests too.

Usage:
    # Dry run — report what WOULD be deleted (default):
    python -m scripts.wipe_leave_balances --org-id 6a481cbeefd9f278b3708209

    # Apply (the DB name must match what you pass to --confirm-db):
    python -m scripts.wipe_leave_balances --org-id 6a481cbeefd9f278b3708209 \
        --apply --confirm-db sentrifugo_qa
"""

import argparse
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient

from src.balance_tracker import TRACKER_COLLECTION
from src.config import settings
from src.leave_balance_processor.processor import (
    BALANCE_COL,
    EMPLOYEES_COL,
    LEDGER_COL as CREDIT_LEDGER_COL,
)
from src.leave_balance_processor.schemas import CreditTransactionType
from src.leave_holds.service import HOLDS_COLLECTION
from src.utils import to_oid

PRESERVED = [CREDIT_LEDGER_COL, "leave_entitlement_ledger", "leave_year_end_execution"]

CREDIT_TYPES = [
    CreditTransactionType.GRANT_CREDIT.value,
    CreditTransactionType.ACCRUAL_CREDIT.value,
]


async def _org_scope(db, org_id: str) -> tuple[list, list]:
    """Every employee_id and user_id belonging to one organisation.

    The tracker and holds collections carry no org field — they are keyed by
    user_id — so the only way to scope them to an org is through the employee
    documents. Soft-deleted employees are INCLUDED: their balance rows are just
    as stale as anyone else's and would otherwise survive the wipe.

    user_ids are collected in both ObjectId and string form. Writers store them
    via to_oid(), but a legacy string-typed row would silently escape an
    ObjectId-only filter, and a balance row that survives a wipe is worse than
    one deleted twice.
    """
    employees = await db[EMPLOYEES_COL].find(
        {"organisation_id": to_oid(org_id)}, {"_id": 1, "user_id": 1}
    ).to_list(length=None)

    employee_ids = [e["_id"] for e in employees]
    user_ids: list = []
    for e in employees:
        uid = e.get("user_id")
        if uid:
            user_ids.extend([to_oid(str(uid)), str(uid)])
    return employee_ids, user_ids


async def _sum_hours(db, collection: str, flt: dict, field: str) -> float:
    rows = await db[collection].aggregate([
        {"$match": flt},
        {"$group": {"_id": None, "total": {"$sum": f"${field}"}}},
    ]).to_list(length=1)
    return float(rows[0]["total"]) if rows else 0.0


async def wipe(
    org_id: str, apply: bool, confirm_db: str | None, include_holds: bool
) -> None:
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

    org_oid = to_oid(org_id)
    employee_ids, user_ids = await _org_scope(db, org_id)

    print(f"{'APPLYING' if apply else 'DRY RUN'} — database: {db_name}")
    print(f"Scope: organisation {org_id} — {len(employee_ids):,} employee(s), "
          f"{len(user_ids) // 2:,} with a user_id\n")

    if not employee_ids:
        print("  !!  No employees found for that organisation_id.")
        print("      Nothing here is scoped to it — check the id before going further.\n")

    # employee_leave_balances carries org_id, but match on employee_id as well:
    # the two agree by construction (_build_employee_filter resolves a plan's
    # org_id against employees.organisation_id), and the $or catches a row whose
    # org_id was never stamped.
    targets: list[tuple[str, dict]] = [
        (BALANCE_COL, {"$or": [{"org_id": org_oid}, {"employee_id": {"$in": employee_ids}}]}),
        (TRACKER_COLLECTION, {"user_id": {"$in": user_ids}}),
    ]
    if include_holds:
        targets.append((HOLDS_COLLECTION, {"user_id": {"$in": user_ids}}))

    total = 0
    for name, flt in targets:
        n = await db[name].count_documents(flt)
        total += n
        print(f"  {name:<32} {n:>10,} row(s) to delete")

    balance_hours = await _sum_hours(db, BALANCE_COL, targets[0][1], "balance")
    tracker_hours = await _sum_hours(db, TRACKER_COLLECTION, targets[1][1], "balance_hours")
    print(f"\n  Hours being destroyed: {balance_hours:,.2f}h in {BALANCE_COL}, "
          f"{tracker_hours:,.2f}h in {TRACKER_COLLECTION}")
    if abs(balance_hours - tracker_hours) > 0.01:
        print("  !!  The two stores disagree — they are separate writes and can drift.")

    print("\n  Preserved (untouched):")
    for name in PRESERVED:
        n = await db[name].count_documents({})
        print(f"  {name:<32} {n:>10,} row(s) kept")
    if not include_holds:
        n = await db[HOLDS_COLLECTION].count_documents({"user_id": {"$in": user_ids}})
        print(f"  {HOLDS_COLLECTION:<32} {n:>10,} row(s) kept  (--include-holds to clear)")

    # The pairing trap: surviving credit rows are what _already_credited reads,
    # so they will suppress the re-credit that is supposed to refill these balances.
    surviving = await db[CREDIT_LEDGER_COL].count_documents(
        {"org_id": org_oid, "transaction_type": {"$in": CREDIT_TYPES}}
    )
    if surviving:
        print(f"\n  !!  {surviving:,} credit row(s) for this org remain in "
              f"{CREDIT_LEDGER_COL}.")
        print("      _already_credited will treat those periods as done, so the next")
        print("      accrual run will NOT refill the balances you are about to delete.")
        print("      Run wipe_leave_ledgers.py too if you want accrual to rebuild them.")

    if not apply:
        print(f"\nDry run only — nothing deleted. {total:,} row(s) would be removed.")
        print(f"Re-run with --apply --confirm-db {db_name} to delete them.")
        client.close()
        return

    print()
    deleted = 0
    for name, flt in targets:
        result = await db[name].delete_many(flt)
        deleted += result.deleted_count
        print(f"  deleted {result.deleted_count:>10,} from {name}")

    print(f"\nDone. Removed {deleted:,} row(s) for organisation {org_id}.")
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--org-id",
        required=True,
        metavar="OID",
        help="organisation_id to wipe (required — this script is never global)",
    )
    parser.add_argument("--apply", action="store_true", help="Delete (default is dry run)")
    parser.add_argument(
        "--confirm-db",
        metavar="NAME",
        help="Name of the target database; must match the connected DB to --apply",
    )
    parser.add_argument(
        "--include-holds",
        action="store_true",
        help=f"Also clear {HOLDS_COLLECTION} (hours reserved by PENDING requests — off by default)",
    )
    args = parser.parse_args()
    asyncio.run(wipe(args.org_id, args.apply, args.confirm_db, args.include_holds))
