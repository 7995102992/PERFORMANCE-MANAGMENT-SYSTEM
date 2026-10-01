"""Leave credit cron.

Credits leave, and nothing else. Expiry and stale-request cleanup are not run
here — end-of-cycle expiry is the year-end processor's job.

Schedule: the 1st of every calendar month, 00:00 UTC. The loop itself ticks
daily and returns immediately on any other day; that is the same shape as
``src/year_end_processing/cron.py`` and it avoids parking a single
``asyncio.sleep`` for a month at a time, which a container restart would reset.

Forward only. A run credits the accrual periods anchored in ITS OWN month and
never reaches back — a month that was not run stays uncredited until an operator
runs ``scripts/run_monthly_credit.py --date``. There is deliberately no run at
startup: booting on the 9th does not credit the month.

Once per month. The first process to claim ``leave_credit_cron_runs`` for the
month does the work; every other replica exits gracefully. The claim is released
if the run raises, so a crash does not cost the month.
"""

import asyncio
from datetime import date, datetime, timedelta, timezone

from pymongo.errors import DuplicateKeyError

from src.database import get_db
from src.leave_balance_processor.processor import run_daily_credit_processing
from src.logger import logger

CRON_RUNS_COL = "leave_credit_cron_runs"


def _seconds_until_midnight() -> float:
    now = datetime.now(timezone.utc)
    next_midnight = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return (next_midnight - now).total_seconds()


def _is_credit_day(run_date: date) -> bool:
    """Credits post on the 1st of the calendar month."""
    return run_date.day == 1


def _month_key(run_date: date) -> str:
    return f"{run_date.year:04d}-{run_date.month:02d}"


async def _claim_month(db, month_key: str, run_date: date) -> bool:
    """Take this month's run for ourselves. False when someone already has it.

    The claim is the ``_id`` of a single document, so the insert is atomic across
    replicas without needing an extra index — two processes waking at the same
    instant cannot both win.
    """
    try:
        await db[CRON_RUNS_COL].insert_one({
            "_id": month_key,
            "run_date": str(run_date),
            "status": "running",
            "claimed_at": datetime.now(timezone.utc),
        })
        return True
    except DuplicateKeyError:
        return False


async def _run_once() -> None:
    run_date = datetime.now(timezone.utc).date()
    if not _is_credit_day(run_date):
        return

    db = get_db()
    month_key = _month_key(run_date)

    if not await _claim_month(db, month_key, run_date):
        logger.info(
            "Leave credit cron: month already credited, nothing to do",
            month=month_key,
        )
        return

    try:
        result = await run_daily_credit_processing(db, run_date)
    except Exception as exc:
        # Release the claim so the month can be retried rather than being lost.
        await db[CRON_RUNS_COL].delete_one({"_id": month_key})
        logger.error(
            "Leave credit cron run failed; month claim released",
            month=month_key,
            error=str(exc),
        )
        return

    # Store the counts only — `results` carries a row per plan and can be large.
    await db[CRON_RUNS_COL].update_one(
        {"_id": month_key},
        {"$set": {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc),
            "total_plans": result.get("total_plans"),
            "processed": result.get("processed"),
            "skipped": result.get("skipped"),
            "errors": result.get("errors"),
        }},
    )
    logger.info(
        "Leave credit cron run complete",
        month=month_key,
        total_plans=result.get("total_plans"),
        processed=result.get("processed"),
        skipped=result.get("skipped"),
        errors=result.get("errors"),
    )


async def run_leave_balance_cron() -> None:
    """Background task: credit leave on the 1st of each month, 00:00 UTC."""
    logger.info("Leave credit cron started", schedule="monthly-on-the-1st")
    while True:
        wait = _seconds_until_midnight()
        await asyncio.sleep(wait)
        try:
            await _run_once()
        except Exception as exc:
            # Never let a failure kill the loop.
            logger.error("Leave credit cron tick failed", error=str(exc))
