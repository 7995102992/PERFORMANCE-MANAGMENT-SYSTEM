"""Manually credit leave for a given month, one leave type at a time.

The cron credits on the 1st of each month and is FORWARD ONLY: it posts the
accrual periods anchored in its own month and never reaches back. A month the
cron missed — an outage over the 1st, a plan enabled late, a config fixed after
the fact — stays uncredited. **This script is how you credit it.**

It runs the same engine with the same rules, so there is no special "backfill
mode" to reason about: pick a month with --date and the periods anchored in that
month post, pro-rated and banded exactly as the cron would have done.

How a run goes:

  1. It lists the leave types that have a period anchored in the chosen month,
     by name, and asks which ones to credit.
  2. It prints a per-plan summary for that selection: the period key, the
     nominal per-employee amount, how many eligible employees are in scope, and
     how many of them already hold a ledger row for that key.
  3. It asks for confirmation, and only then writes.

Differences from the cron, and that is the whole list:

  * --date chooses the month; the cron always works on today's month.
  * You choose the leave types; the cron always credits every type.
  * It ignores the cron's once-a-month claim (``leave_credit_cron_runs``), which
    it neither reads nor writes, so a manual run and the cron never block
    each other.
  * --with-maintenance opts into credit expiry and stale-pending cleanup. The
    cron does not run either of them any more — end-of-cycle expiry belongs to
    the year-end processor — so this flag is the only thing left that invokes
    them. It is NOT restricted by the leave-type selection.

Idempotent: ``_already_credited`` plus the ``uniq_credit_period`` unique index
mean re-running for the same month never double-credits — as long as the ledger
rows are still there. After scripts/wipe_leave_ledgers.py they are not, and a
run WILL credit on top of existing balances.

Usage:
    # Interactive: pick leave types, review the summary, confirm:
    python -m scripts.run_monthly_credit --apply

    # A specific month (any date inside it; the day is ignored):
    python -m scripts.run_monthly_credit --date 2026-07-15 --apply

    # Review only — same prompt and summary, then stop without writing:
    python -m scripts.run_monthly_credit

    # Non-interactive (CI / no TTY): name the types and pre-confirm.
    python -m scripts.run_monthly_credit --apply --yes \
        --leave-types "Casual Leave,Sick Leave"
    python -m scripts.run_monthly_credit --apply --yes --leave-types ALL
"""

import argparse
import asyncio
import sys
from datetime import date, datetime, timezone

import src.leave_balance_processor.processor as processor
from src.config import settings
from src.database import close_db, get_db, init_db

ENTITLEMENT_COL = processor.ENTITLEMENT_COL
LEDGER_COL = processor.LEDGER_COL
PLANS_COL = processor.PLANS_COL
HOURS_PER_DAY = processor.HOURS_PER_DAY


def _fmt_hours(hours) -> str:
    if hours is None:
        return "?"
    return f"{hours:,.2f}h ({hours / HOURS_PER_DAY:,.2f}d)"


async def _collect_due(db, run_date: date) -> list[dict]:
    """One row per (plan, leave type) that has a period anchored in run_date's month.

    Mirrors the decisions ``process_leave_plan`` makes — same period resolution,
    same statutory rule, same eligibility filter — so the numbers shown are the
    numbers the engine will act on. Types with nothing anchored here are omitted:
    selecting them could not credit anything.
    """
    plans = await db[PLANS_COL].find(
        {"is_active": True, "deleted_on": None}
    ).to_list(length=None)

    rows: list[dict] = []
    for plan in plans:
        plan_id = str(plan["_id"])
        org_id = str(plan.get("org_id", ""))
        calendar_start_month = int(plan.get("calendar_start_month") or 1)
        leave_year = processor._leave_year(run_date, calendar_start_month)

        entitlement_doc = await db[ENTITLEMENT_COL].find_one(
            {"leave_plan_id": processor.to_oid(plan_id), "deleted_on": None}
        ) or {}
        distribution = entitlement_doc.get("entitlement", {}).get("distribution", {})
        plan_freq = distribution.get("accrual_frequency")
        cycle_start_day = int(distribution.get("policy_cycle_start_day") or 1)

        lt_ids = await processor._get_leave_type_ids(db, plan_id, plan)
        if not lt_ids:
            continue
        lt_docs = await db["leave_types"].find(
            {"_id": {"$in": [processor.to_oid(lt) for lt in lt_ids]}},
            {"_id": 1, "name": 1, "is_statutory_leave": 1, "unit": 1,
             "accrual": 1, "max_statutory_days": 1},
        ).to_list(length=None)

        # Employees the engine would actually touch on this plan.
        emp_filter, _ = await processor.build_creditable_employee_filter(
            db, plan_id, org_id
        )
        if emp_filter is None:
            continue
        in_scope = await db[processor.EMPLOYEES_COL].count_documents(emp_filter)

        # Statutory fires once a year and stays due from the leave year's opening
        # month onward, so mid-year joiners still receive it.
        import calendar as _cal
        stat_anchor = date(
            leave_year, calendar_start_month,
            min(cycle_start_day, _cal.monthrange(leave_year, calendar_start_month)[1]),
        )
        statutory_due = run_date >= stat_anchor

        for meta in lt_docs:
            lt_id = str(meta["_id"])
            name = meta.get("name") or f"<unnamed {lt_id}>"
            unit = meta.get("unit", "DAYS")
            acc = meta.get("accrual") or {}
            statutory = bool(meta.get("is_statutory_leave"))

            if statutory:
                if not statutory_due:
                    continue
                period_key = f"{leave_year}:ANNUAL"
                cnt = meta.get("max_statutory_days")
                if cnt is None:
                    cnt = acc.get("annual_count")
                per_employee = (
                    processor._to_hours(float(cnt), unit) if cnt is not None else None
                )
                cadence = "statutory / annual"
            else:
                freq = acc.get("accrual_frequency") or plan_freq
                eff_mode = (
                    "all_at_once" if (not freq or freq == "yearly") else "step_by_step"
                )
                periods = processor._due_periods(
                    run_date, eff_mode,
                    None if eff_mode == "all_at_once" else freq,
                    calendar_start_month, cycle_start_day, leave_year,
                )
                if not periods:
                    continue
                period_key = periods[0][0]
                annual = acc.get("annual_count")
                per_employee = (
                    processor._to_hours(float(annual), unit)
                    / processor._FREQ_DIVISORS.get(freq or "yearly", 1)
                    if annual is not None else None
                )
                cadence = freq or "yearly"

            # How many of those employees already hold this period — the run is
            # idempotent, so these are the ones it will pass over.
            already = len(await db[LEDGER_COL].distinct("employee_id", {
                "leave_plan_id": processor.to_oid(plan_id),
                "leave_type_id": processor.to_oid(lt_id),
                "period_key": period_key,
            }))

            rows.append({
                "plan_id": plan_id,
                "plan_name": plan.get("name", ""),
                "leave_type_id": lt_id,
                "leave_type_name": name,
                "period_key": period_key,
                "cadence": cadence,
                "per_employee_hours": per_employee,
                "in_scope": in_scope,
                "already": already,
            })

    return rows


def _print_choices(by_name: dict[str, list[dict]]) -> list[str]:
    """List the selectable leave types. Returns the names in menu order."""
    names = sorted(by_name)
    print("Leave types with a period anchored in this month:\n")
    print(f"  {'#':>3}  {'Leave type':<32} {'cadence':<20} {'to credit':>10}")
    print(f"  {'':>3}  {'-' * 32} {'-' * 20} {'-' * 10}")
    for i, name in enumerate(names, start=1):
        rows = by_name[name]
        pending = sum(max(r["in_scope"] - r["already"], 0) for r in rows)
        cadences = sorted({r["cadence"] for r in rows})
        plans_note = f" ({len(rows)} plans)" if len(rows) > 1 else ""
        print(
            f"  {i:>3}. {name[:32]:<32} {','.join(cadences)[:20]:<20} "
            f"{pending:>7} emp{plans_note}"
        )
    return names


def _resolve_selection(raw: str, names: list[str]) -> tuple[list[str], list[str]]:
    """Parse one answer into ``(chosen names, unrecognised tokens)``.

    Accepts menu numbers and names in the same comma-separated answer, matches
    names case-insensitively, and drops repeats while keeping the order typed.
    Pure, so the prompt loop above it stays trivial.
    """
    chosen, unknown = [], []
    lookup = {n.lower(): n for n in names}
    for token in (t.strip() for t in raw.split(",")):
        if not token:
            continue
        if token.isdigit():
            idx = int(token)
            if 1 <= idx <= len(names):
                chosen.append(names[idx - 1])
            else:
                unknown.append(token)
        elif token.lower() in lookup:
            chosen.append(lookup[token.lower()])
        else:
            unknown.append(token)
    # dict.fromkeys keeps the first occurrence and drops repeats
    return list(dict.fromkeys(chosen)), unknown


def _prompt_for_types(names: list[str]) -> list[str]:
    """Ask which leave types to credit. Accepts numbers, names, 'all', or 'q'."""
    print("\nSelect leave types: numbers (1,3), names, 'all', or 'q' to quit.")
    while True:
        raw = input("Credit which leave types? ").strip()
        if not raw:
            continue
        if raw.lower() in {"q", "quit", "exit"}:
            return []
        if raw.lower() == "all":
            return list(names)

        chosen, unknown = _resolve_selection(raw, names)
        if unknown:
            print(f"  Not recognised: {', '.join(unknown)}. Try again.")
            continue
        if not chosen:
            print("  Nothing selected. Try again.")
            continue
        return chosen


def _print_summary(rows: list[dict], run_date: date) -> int:
    """Per-plan breakdown of the selection. Returns the total employees to credit."""
    print(f"\nAbout to credit — {run_date:%B %Y}\n")
    header = (
        f"  {'Leave type':<26} {'Plan':<24} {'Period key':<16} "
        f"{'Per employee':>18} {'Credit':>8} {'Skip':>6}"
    )
    print(header)
    print("  " + "-" * (len(header) - 2))

    total_to_credit = 0
    total_hours = 0.0
    unknown_amount = False
    for r in sorted(rows, key=lambda x: (x["leave_type_name"], x["plan_name"])):
        to_credit = max(r["in_scope"] - r["already"], 0)
        total_to_credit += to_credit
        if r["per_employee_hours"] is None:
            unknown_amount = True
        else:
            total_hours += r["per_employee_hours"] * to_credit
        print(
            f"  {r['leave_type_name'][:26]:<26} {(r['plan_name'] or r['plan_id'])[:24]:<24} "
            f"{r['period_key']:<16} {_fmt_hours(r['per_employee_hours']):>18} "
            f"{to_credit:>8} {r['already']:>6}"
        )

    print(
        f"\n  {total_to_credit} employee-credit(s) to write, "
        f"~{_fmt_hours(total_hours)} total."
    )
    if unknown_amount:
        print(
            "  WARNING: at least one type has no annual_count configured (shown as ?).\n"
            "  Its hours are missing from that total, and the engine will fall back to\n"
            "  the plan-level allocation — check the config before writing."
        )
    print(
        "  'Skip' already hold a ledger row for that period key and will be passed\n"
        "  over — the run is idempotent."
    )
    print(
        "  Per-employee amounts are NOMINAL: probation banding, mid-year joining and\n"
        "  rounding are applied per employee, so the real total will differ."
    )
    return total_to_credit


async def main(
    apply: bool,
    run_date: date,
    with_maintenance: bool,
    leave_types_arg: str | None,
    assume_yes: bool,
) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    interactive = sys.stdin.isatty()
    if not interactive and leave_types_arg is None:
        print(
            "ERROR: no TTY to prompt on. Pass --leave-types \"Name,Name\" (or ALL), "
            "and --yes to skip the confirmation."
        )
        return

    init_db()
    db = get_db()

    print(f"{'APPLYING' if apply else 'REVIEW ONLY'} — database: {db.name}")
    print(
        f"run_date: {run_date}   crediting: {run_date:%B %Y}"
        f"   (the day component only selects the month)"
    )
    print("scope: forward-only, this month\n")

    rows = await _collect_due(db, run_date)
    if not rows:
        print("Nothing is anchored in this month — no leave type can be credited.")
        await close_db()
        return

    by_name: dict[str, list[dict]] = {}
    for r in rows:
        by_name.setdefault(r["leave_type_name"], []).append(r)

    if leave_types_arg is not None:
        if leave_types_arg.strip().lower() == "all":
            selected = sorted(by_name)
        else:
            wanted = [t.strip() for t in leave_types_arg.split(",") if t.strip()]
            lookup = {n.lower(): n for n in by_name}
            selected = [lookup[w.lower()] for w in wanted if w.lower() in lookup]
            missing = [w for w in wanted if w.lower() not in lookup]
            if missing:
                print(
                    f"ERROR: not due this month (or unknown): {', '.join(missing)}\n"
                    f"       Available: {', '.join(sorted(by_name))}"
                )
                await close_db()
                return
        print(f"Leave types from --leave-types: {', '.join(selected)}\n")
    else:
        names = _print_choices(by_name)
        selected = _prompt_for_types(names)
        if not selected:
            print("Nothing selected — aborted.")
            await close_db()
            return

    chosen_rows = [r for n in selected for r in by_name[n]]
    to_credit = _print_summary(chosen_rows, run_date)

    if not apply:
        print("\nReview only — nothing credited. Re-run with --apply to write.")
        await close_db()
        return

    if to_credit == 0:
        print("\nEvery selected employee already holds these periods — nothing to do.")
        await close_db()
        return

    if not assume_yes:
        answer = input(f"\nWrite these credits to {db.name}? [y/N] ").strip().lower()
        if answer not in {"y", "yes"}:
            print("Aborted — nothing written.")
            await close_db()
            return

    only_ids = {r["leave_type_id"] for r in chosen_rows}
    result = await processor.run_daily_credit_processing(db, run_date, only_ids)
    print(
        f"\nCredit processing complete — "
        f"{result['processed']} plan(s) processed, "
        f"{result['skipped']} skipped, {result['errors']} error(s)."
    )
    for r in result["results"]:
        if r.get("error"):
            print(f"  ERROR  plan {r.get('plan_id')}: {r['error']}")
        elif r.get("skipped"):
            print(f"  skipped plan {r.get('plan_id')}: {r.get('reason')}")

    if with_maintenance:
        # Not restricted by the leave-type selection — both jobs are org-wide.
        expiry = await processor.run_credit_expiry(db)
        print(f"\nCredit expiry: {expiry}")
        cleanup = await processor.run_stale_pending_cleanup(db)
        print(f"Stale pending cleanup: {cleanup}")

    await close_db()


def _parse_date(raw: str) -> date:
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD, got {raw!r}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Write the credits (default reviews and stops)",
    )
    parser.add_argument(
        "--date",
        type=_parse_date,
        default=datetime.now(timezone.utc).date(),
        metavar="YYYY-MM-DD",
        help=(
            "Any date inside the month to credit; the day is ignored and only the "
            "month is used (default: today, UTC)"
        ),
    )
    parser.add_argument(
        "--leave-types",
        metavar="NAMES",
        help=(
            "Comma-separated leave type names, or ALL. Skips the prompt — required "
            "when there is no TTY."
        ),
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="Skip the final confirmation. Only meaningful with --apply.",
    )
    parser.add_argument(
        "--with-maintenance",
        action="store_true",
        help=(
            "Also run credit expiry and stale-pending cleanup. The cron no longer "
            "runs either, so this is the only thing that invokes them."
        ),
    )
    args = parser.parse_args()
    asyncio.run(
        main(args.apply, args.date, args.with_maintenance, args.leave_types, args.yes)
    )
