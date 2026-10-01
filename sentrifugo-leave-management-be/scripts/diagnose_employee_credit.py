"""Explain why one employee did or didn't get credited by the accrual run.

Read-only. Walks the same gates ``process_leave_plan`` / ``_credit_employee``
apply, in order, and reports where this employee falls out — plus what the three
balance stores actually hold for them.

The stores are separate writes in ``_write_credit``, and they can disagree:

    leave_credit_ledger            keyed by employee_id   (idempotency record)
    employee_leave_balances        keyed by employee_id   ($inc counter)
    leave_employee_balance_tracker keyed by USER_id       (what the UI reads)

The tracker mirror is skipped when the employee doc has no ``user_id``
(processor.py:695), so a credit can be written and still be invisible in the
app. That is the first thing this script checks.

It also reports the last few accrual cycles for the employee's org, so you can
tell "the run never fired" apart from "the run fired and skipped this one".

Usage:
    python -m scripts.diagnose_employee_credit 6a4f8dd527261dbcc33a4078
"""

import argparse
import asyncio
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from src.balance_tracker import TRACKER_COLLECTION
from src.config import settings
from src.employment_status import EMPLOYMENT_STATUSES_COLLECTION, get_inactive_status_ids
from src.leave_balance_processor.schemas import CreditTransactionType
from src.leave_balance_processor.processor import (
    BALANCE_COL,
    EMPLOYEES_COL,
    ENTITLEMENT_COL,
    LEDGER_COL,
    PLANS_COL,
    _build_employee_filter,
    _leave_year,
    _probation_check,
    _probation_period_key,
)
from src.utils import to_oid


def _line(ok: bool | None, text: str) -> str:
    mark = {True: "  OK  ", False: "  !!  ", None: "  --  "}[ok]
    return f"{mark} {text}"


def _utc(dt: datetime) -> datetime:
    """Mongo hands back naive UTC (the client is not tz_aware) — make it aware."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


CREDIT_TYPES = [
    CreditTransactionType.GRANT_CREDIT.value,
    CreditTransactionType.ACCRUAL_CREDIT.value,
]


async def _recent_cycles(db, org_id, limit: int = 3) -> list[dict]:
    """The last ``limit`` accrual cycles, most recent first.

    A "cycle" is reconstructed from the ledger rows themselves. Every credit a run
    writes is stamped with that run's wall-clock ``created_on``, and production
    credits on the 1st of each month at 00:00 UTC — so a UTC day of ``created_on``
    is the closest stand-in for a run that the data supports. Expect roughly one
    cycle per month, on the 1st.

    It is an approximation, not an identity: manual invocations of
    ``scripts/run_monthly_credit.py`` land whenever they land, so a day can bundle
    several runs. That is why the start–end window is printed — a cycle stamped
    00:00:11–13:14:21 was plainly not one scheduled pass.

    A cycle on any day other than the 1st therefore means someone ran the manual
    script, or the holiday reprocess hook fired (holidays/router.py).

    The cron does record its own runs, but only at month granularity, in
    ``leave_credit_cron_runs`` (``_id`` = "YYYY-MM") — useful for "did the month
    run at all", useless for reconstructing what a run credited.

    Grouped on created_on, NOT effective_date: effective_date is the period's own
    anchor, so it says which period was credited, not when the run happened.
    """
    match: dict = {"transaction_type": {"$in": CREDIT_TYPES}}
    if org_id:
        match["org_id"] = to_oid(str(org_id))

    return await db[LEDGER_COL].aggregate([
        {"$match": match},
        # Two-stage group: count distinct employees without ever holding the
        # whole employee list in one document.
        {"$group": {
            "_id": {
                "day": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_on"}},
                "employee_id": "$employee_id",
            },
            "rows": {"$sum": 1},
            "hours": {"$sum": "$amount"},
            "started": {"$min": "$created_on"},
            "finished": {"$max": "$created_on"},
            "plans": {"$addToSet": "$leave_plan_id"},
            "period_keys": {"$addToSet": "$period_key"},
        }},
        {"$group": {
            "_id": "$_id.day",
            "employees": {"$sum": 1},
            "rows": {"$sum": "$rows"},
            "hours": {"$sum": "$hours"},
            "started": {"$min": "$started"},
            "finished": {"$max": "$finished"},
            "plans": {"$addToSet": "$plans"},
            "period_keys": {"$addToSet": "$period_keys"},
        }},
        {"$sort": {"_id": -1}},
        {"$limit": limit},
    ]).to_list(length=None)


async def diagnose(employee_id: str) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    print(f"database: {db.name}\nemployee_id: {employee_id}\n")

    emp = await db[EMPLOYEES_COL].find_one({"_id": to_oid(employee_id)})
    if not emp:
        print(_line(False, "No employee document with that _id — nothing can credit it."))
        client.close()
        return

    # ── The employee document ────────────────────────────────────────────────
    print("EMPLOYEE DOCUMENT")
    user_id = emp.get("user_id")
    print(_line(bool(user_id), f"user_id: {user_id!r}"))
    if not user_id:
        print(
            "         ^ credits are written to the ledger and employee_leave_balances,\n"
            "           but tracker_upsert_balance is SKIPPED. The app reads the\n"
            "           tracker, so the balance will look unchanged."
        )
    print(_line(None, f"organisation_id: {emp.get('organisation_id')!r}"))
    print(_line(None, f"business_unit_id: {emp.get('business_unit_id')!r}"))
    print(_line(None, f"department_id:   {emp.get('department_id')!r}"))
    print(_line(not emp.get("is_deleted"), f"is_deleted: {emp.get('is_deleted')!r}"))
    joining = emp.get("date_of_joining") or emp.get("joining_date")
    print(_line(bool(joining), f"date_of_joining: {joining!r}"))

    status_oid = emp.get("employment_status")
    inactive = await get_inactive_status_ids(db)
    is_inactive = status_oid in inactive
    print(_line(not is_inactive, f"employment_status: {status_oid!r}"))
    if is_inactive:
        print("         ^ flagged is_active:false — excluded from accrual (processor.py:1415)")

    # ── Plan scope ───────────────────────────────────────────────────────────
    print("\nPLAN SCOPE  (does any active plan's assignment cover this employee?)")
    plans = await db[PLANS_COL].find({"is_active": True, "deleted_on": None}).to_list(length=None)
    if not plans:
        print(_line(False, "No active leave plans at all."))
    covered_by = []
    for plan in plans:
        plan_id = str(plan["_id"])
        org_id = str(plan.get("org_id", ""))
        scope = await _build_employee_filter(db, plan_id, org_id)
        if scope is None:
            print(_line(False, f"plan {plan_id} — no active assignments"))
            continue
        match = await db[EMPLOYEES_COL].count_documents(
            {**scope, "_id": to_oid(employee_id)}
        )
        print(_line(bool(match), f"plan {plan_id} {plan.get('name', '')} — "
                                 f"{'covered' if match else 'NOT covered'}"))
        if match:
            covered_by.append(plan_id)

    if not covered_by:
        print("         ^ no plan covers this employee, so no credit can be written.")

    # ── Probation ────────────────────────────────────────────────────────────
    # Whether a probationer credits at all depends on the PLAN's probation config,
    # not just on the employee's status. Run the real _probation_check so this
    # reports what the processor would actually decide.
    print("\nPROBATION")
    status_doc = await db[EMPLOYMENT_STATUSES_COLLECTION].find_one({"_id": status_oid})
    status_name = f"{status_doc.get('key')!r}/{status_doc.get('value')!r}" if status_doc else "?"
    # The processor resolves probation statuses from IAM master data by name-match;
    # the local employment_statuses replica is the same data, synced.
    is_probation = bool(
        status_doc
        and ("probation" in (status_doc.get("key") or "").lower()
             or "probation" in (status_doc.get("value") or "").lower())
    )
    print(_line(None, f"employment status: {status_name}"))
    print(_line(None, f"classified as probation: {is_probation}"))

    run_date = datetime.now(timezone.utc).date()

    for plan_id in covered_by:
        plan = await db[PLANS_COL].find_one({"_id": to_oid(plan_id)})
        calendar_start_month = int((plan or {}).get("calendar_start_month") or 1)
        leave_year = _leave_year(run_date, calendar_start_month)

        ent_doc = await db[ENTITLEMENT_COL].find_one(
            {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
        ) or {}
        entitlement = ent_doc.get("entitlement", {})
        probation_cfg = entitlement.get("probation", {}) or {}
        cycle_start_day = int(
            (entitlement.get("distribution", {}) or {}).get("policy_cycle_start_day") or 1
        )

        print(f"\n  plan {plan_id}")
        print(_line(None, f"  probation.enabled: {probation_cfg.get('enabled')!r}"))
        print(_line(None, f"  probation.credit_mode: {probation_cfg.get('credit_mode')!r}"))
        print(_line(None, f"  probation.probation_leave_type_id: "
                          f"{probation_cfg.get('probation_leave_type_id')!r}"))
        print(_line(None, f"  probation.credit_start: {probation_cfg.get('credit_start')!r}"))
        print(_line(None, f"  band_rules: {probation_cfg.get('band_rules')!r}"))
        print(_line(None, f"  cycle_start_day: {cycle_start_day}  (today is day {run_date.day})"))

        # Does the plan resolve a probation period key at all? (mirrors the gate
        # added in process_leave_plan)
        tiered = (
            bool(probation_cfg.get("enabled"))
            and probation_cfg.get("credit_mode") == "tiered_by_duration"
            and bool(probation_cfg.get("probation_leave_type_id"))
        )
        prod_key = _probation_period_key(leave_year, run_date)
        print(_line(tiered, f"  tiered band path active: {tiered}"))
        if tiered:
            print(_line(None, f"  period key: {prod_key}"))
        else:
            print("         ^ NOT tiered — probationers credit at the normal rate\n"
                  "           through the regular leave types, so nothing is due in a\n"
                  "           month where no regular type fires.")

        should_credit, amount_override = _probation_check(
            emp, probation_cfg, run_date, calendar_start_month, cycle_start_day,
            is_probation,
        )
        print(_line(should_credit, f"  _probation_check -> should_credit={should_credit}, "
                                   f"amount_override={amount_override}"))
        if not should_credit:
            print("         ^ skipped entirely: today is not the band's posting day")

        if tiered:
            existing = await db[LEDGER_COL].find_one({
                "employee_id": to_oid(employee_id),
                "leave_plan_id": to_oid(plan_id),
                "period_key": prod_key,
            })
            print(_line(not existing, f"  ledger row for {prod_key}: "
                                      f"{'ALREADY CREDITED' if existing else 'none yet'}"))

    # ── The accrual run itself ───────────────────────────────────────────────
    # Separates "the cron never fired" from "the cron fired and skipped this
    # employee" — the two look identical from the employee's ledger alone.
    org_id = emp.get("organisation_id")
    cycle_scope = f"org {org_id}" if org_id else "ALL ORGS (employee has no organisation_id)"
    print(f"\nRECENT CREDIT CYCLES  ({cycle_scope}, grouped by UTC day of ledger write)")
    cycles = await _recent_cycles(db, org_id)
    if not cycles:
        print(_line(False, "no credit has ever been written in this scope"))
    for i, c in enumerate(cycles):
        cycle_plans = {str(p) for sub in c["plans"] for p in sub}
        keys = sorted({str(k) for sub in c["period_keys"] for k in sub})
        label = "LAST CYCLE" if i == 0 else "prior"
        print(f"        {label:<11} {c['_id']}  "
              f"{c['started']:%H:%M:%S}–{c['finished']:%H:%M:%S} UTC")
        print(f"                    {c['employees']} employees credited, "
              f"{c['rows']} ledger rows, {round(c['hours'], 2)}h total, "
              f"{len(cycle_plans)} plan(s)")
        print(f"                    periods: {', '.join(keys) if keys else '—'}")

    if cycles:
        last = cycles[0]
        day_start = datetime.strptime(last["_id"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        mine = await db[LEDGER_COL].count_documents({
            "employee_id": to_oid(employee_id),
            "transaction_type": {"$in": CREDIT_TYPES},
            "created_on": {"$gte": day_start, "$lt": day_start + timedelta(days=1)},
        })
        print(_line(bool(mine), f"this employee in the last cycle: "
                                f"{f'{mine} row(s)' if mine else 'NOT credited'}"))
        days_ago = (datetime.now(timezone.utc) - _utc(last["finished"])).days
        print(_line(None, f"last cycle ran {days_ago} day(s) ago"))

    # ── What the three stores hold ───────────────────────────────────────────
    print("\nLEDGER  (leave_credit_ledger)")
    rows = await db[LEDGER_COL].find(
        {"employee_id": to_oid(employee_id)}
    ).sort("created_on", -1).limit(20).to_list(length=None)
    if not rows:
        print(_line(False, "no ledger rows for this employee"))
    for r in rows:
        print(f"        {str(r.get('period_key')):<28} {r.get('transaction_type'):<16} "
              f"{r.get('amount')!s:>8}h  plan={r.get('leave_plan_id')} "
              f"type={r.get('leave_type_id')}  {r.get('created_on')}")
    total_rows = await db[LEDGER_COL].count_documents({"employee_id": to_oid(employee_id)})
    if total_rows > len(rows):
        print(f"        … {total_rows - len(rows)} more (showing 20 most recent)")

    print("\nBALANCE COUNTER  (employee_leave_balances — keyed by employee_id)")
    bals = await db[BALANCE_COL].find({"employee_id": to_oid(employee_id)}).to_list(length=None)
    if not bals:
        print(_line(False, "no rows"))
    for b in bals:
        print(f"        type={b.get('leave_type_id')}  balance={b.get('balance')}  "
              f"credited={b.get('total_credited')}  debited={b.get('total_debited')}  "
              f"last_key={b.get('last_credit_period_key')}")

    print("\nTRACKER  (leave_employee_balance_tracker — keyed by user_id — THIS IS WHAT THE APP READS)")
    if not user_id:
        print(_line(False, "employee has no user_id, so no tracker row can exist"))
    else:
        tracked = await db[TRACKER_COLLECTION].find(
            {"user_id": to_oid(str(user_id))}
        ).to_list(length=None)
        if not tracked:
            print(_line(False, f"no tracker rows for user_id {user_id}"))
            if bals:
                print("         ^ MISMATCH: the counter has credits but the tracker does not.")
        for t in tracked:
            print(f"        type={t.get('leave_type_id')}  balance_hours={t.get('balance_hours')}  "
                  f"updated_on={t.get('updated_on')}")

    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("employee_id", help="The employees._id to diagnose")
    args = parser.parse_args()
    asyncio.run(diagnose(args.employee_id))
