"""
Year-end processing cron.

Fires on the first day of each plan's new leave year (run_date.month ==
calendar_start_month and run_date.day == 1), then sleeps until the next
midnight UTC. This is the behaviour in every environment: there is no
accelerated dev mode and no synthetic slot-based year, so year-end can only
close a real leave year.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional

from src.database import get_db
from src.logger import logger
from src.utils import to_oid
from src.year_end_processing.execution_service import run_year_end_execution
from src.year_end_processing.schemas import NegativeBalanceRule, PayoutCarryConfig, ProcessingType

CONFIG_COLLECTION = "leave_plan_year_end_processing"
PLANS_COLLECTION = "leave_plans"

SYSTEM_USER = "system"


def _seconds_until_midnight() -> float:
    now = datetime.now(timezone.utc)
    next_midnight = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return (next_midnight - now).total_seconds()


def _leave_year(run_date, calendar_start_month: int) -> int:
    if run_date.month >= calendar_start_month:
        return run_date.year
    return run_date.year - 1


def _closing_year(run_date, calendar_start_month: int) -> int:
    """The leave year that just ended (one year behind the new leave year)."""
    return _leave_year(run_date, calendar_start_month) - 1


def _is_year_end_day(run_date, calendar_start_month: int) -> bool:
    return run_date.month == calendar_start_month and run_date.day == 1


async def _process_plan(db, plan: dict, closing_year: int) -> None:
    plan_id = str(plan["_id"])

    # Year-end behaviour is now defined on each leave type (carry-forward count +
    # encashment). The plan-level config is only a legacy fallback, so process
    # every active plan and let the engine derive carry/payout/expire per type.
    config = await db[CONFIG_COLLECTION].find_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
    ) or {}

    processing_type = ProcessingType(
        config.get("processing_type") or ProcessingType.CARRY_FORWARD_ALL.value
    )
    negative_balance_rule = NegativeBalanceRule(
        config.get("negative_balance_rule") or NegativeBalanceRule.RESET_TO_ZERO.value
    )

    raw_pcc = config.get("payout_carry_config")
    payout_carry_config: Optional[PayoutCarryConfig] = (
        PayoutCarryConfig(**raw_pcc) if raw_pcc else None
    )

    logger.info(
        "Running year-end processing for plan",
        leave_plan_id=plan_id,
        year=closing_year,
        processing_type=processing_type,
    )

    try:
        result = await run_year_end_execution(
            db=db,
            leave_plan_id=plan_id,
            year=closing_year,
            processing_type=processing_type,
            payout_carry_config=payout_carry_config,
            negative_balance_rule=negative_balance_rule,
            dry_run=False,
            user_id=SYSTEM_USER,
        )
        logger.info(
            "Year-end processing complete for plan",
            leave_plan_id=plan_id,
            **result,
        )
    except Exception as exc:
        logger.error(
            "Year-end processing failed for plan",
            leave_plan_id=plan_id,
            year=closing_year,
            error=str(exc),
        )


async def _run_once() -> None:
    try:
        db = get_db()
        now = datetime.now(timezone.utc)
        run_date = now.date()

        plans = await db[PLANS_COLLECTION].find(
            {"status": "active", "deleted_on": None},
            {"_id": 1, "calendar_start_month": 1},
        ).to_list(length=None)

        for plan in plans:
            calendar_start_month = plan.get("calendar_start_month", 1)

            if not _is_year_end_day(run_date, calendar_start_month):
                continue
            closing_year = _closing_year(run_date, calendar_start_month)

            await _process_plan(db, plan, closing_year)

    except Exception as exc:
        logger.error("Year-end processing cron run failed", error=str(exc))


async def run_year_end_cron() -> None:
    """Background task: run year-end processing once a day at midnight UTC."""
    logger.info("Year-end processing cron started", schedule="daily-at-midnight")

    await _run_once()

    while True:
        wait = _seconds_until_midnight()
        logger.info(
            "Year-end processing cron: sleeping until midnight UTC",
            seconds=int(wait),
        )
        await asyncio.sleep(wait)

        await _run_once()
