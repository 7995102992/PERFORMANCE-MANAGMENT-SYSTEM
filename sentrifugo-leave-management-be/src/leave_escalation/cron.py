"""Leave escalation cron.

Production : wakes up once per day at midnight UTC.
Development: polls every 15 minutes for quick testing.

On startup it runs once immediately to catch requests that breached their
approval SLA while the service was down. Scans pending leave requests and
emails HR when one has been waiting past its plan's skip_if_no_action_days
(see ``run_escalation_processing``).
"""
import asyncio
from datetime import datetime, timedelta, timezone

from src.config import settings
from src.database import get_db
from src.leave_escalation.service import run_escalation_processing
from src.logger import logger

_DEV_POLL_SECONDS = 15 * 60


def _seconds_until_midnight() -> float:
    now = datetime.now(timezone.utc)
    next_midnight = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return (next_midnight - now).total_seconds()


async def _run_once() -> None:
    try:
        db = get_db()
        await run_escalation_processing(db, datetime.now(timezone.utc))
    except Exception as exc:
        logger.error("Leave escalation cron run failed", error=str(exc))


async def run_leave_escalation_cron() -> None:
    """Background task: escalate overdue pending leave requests to HR."""
    is_dev = settings.ENVIRONMENT == "development"
    logger.info(
        "Leave escalation cron started",
        mode="development" if is_dev else "production",
        poll_seconds=_DEV_POLL_SECONDS if is_dev else "daily-at-midnight",
    )
    await _run_once()
    while True:
        if is_dev:
            await asyncio.sleep(_DEV_POLL_SECONDS)
        else:
            wait = _seconds_until_midnight()
            logger.info("Leave escalation cron: sleeping until midnight UTC", seconds=int(wait))
            await asyncio.sleep(wait)
        await _run_once()
