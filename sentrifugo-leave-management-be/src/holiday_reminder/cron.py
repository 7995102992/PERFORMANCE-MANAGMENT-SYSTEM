"""
Holiday reminder cron.

Production : wakes up once per day at 9 AM IST (3:30 AM UTC).
Development: polls every 15 minutes for quick testing.

On startup the processor runs once immediately to send any reminders that were
due while the service was down.

For each holiday with reminder.enabled=True, if the holiday date falls within
the next `reminder.days_before` days (inclusive), an email is sent to every
employee assigned to that holiday's plan. Idempotency keys on the publish
function prevent duplicate sends for the same holiday+date+employee.
"""

import asyncio
from datetime import date as date_type, datetime, timedelta, timezone

from src.config import settings
from src.database import get_db
from src.logger import logger
from src.messaging import email_events

_DEV_POLL_SECONDS = 15 * 60


_IST = timezone(timedelta(hours=5, minutes=30))


def _seconds_until_9am_ist() -> float:
    now = datetime.now(_IST)
    target = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _run_once() -> None:
    try:
        db = get_db()
        today = datetime.now(timezone.utc).date()

        holidays = await db["holidays"].find(
            {
                "deleted_on": None,
                "reminder.enabled": True,
            }
        ).to_list(length=None)

        if not holidays:
            logger.debug("Holiday reminder cron: no holidays with reminders enabled")
            return

        plan_cache: dict = {}
        plan_employees_cache: dict = {}
        total_sent = 0

        for holiday in holidays:
            holiday_date_str = holiday.get("date")
            if not holiday_date_str:
                continue

            if isinstance(holiday_date_str, str):
                try:
                    holiday_date = date_type.fromisoformat(holiday_date_str)
                except ValueError:
                    continue
            elif isinstance(holiday_date_str, date_type):
                holiday_date = holiday_date_str
            else:
                continue

            days_before = holiday.get("reminder", {}).get("days_before", 2)
            days_until = (holiday_date - today).days

            if days_until != days_before:
                continue

            plan_id = holiday.get("plan_id")
            if not plan_id:
                continue

            plan_id_str = str(plan_id)
            if plan_id_str not in plan_cache:
                plan = await db["holiday_plans"].find_one(
                    {"_id": plan_id, "deleted_on": None, "is_active": True}
                )
                plan_cache[plan_id_str] = plan

            plan = plan_cache[plan_id_str]
            if not plan:
                continue

            if plan_id_str not in plan_employees_cache:
                member_docs = await db["holiday_plan_employees"].find(
                    {"plan_id": plan_id, "deleted_on": None}
                ).to_list(length=None)
                user_ids = [d["user_id"] for d in member_docs]

                if user_ids:
                    emp_docs = await db["employees"].find(
                        {"user_id": {"$in": user_ids}, "is_deleted": {"$ne": True}}
                    ).to_list(length=None)
                else:
                    emp_docs = []

                plan_employees_cache[plan_id_str] = emp_docs

            employees = plan_employees_cache[plan_id_str]
            recipients = [e for e in employees if e.get("work_email")]

            holiday_name = holiday.get("name", "")
            plan_name = plan.get("name", "")

            for emp in recipients:
                await email_events.publish_holiday_reminder(
                    employee_email=emp["work_email"],
                    employee_name=emp.get("name", ""),
                    holiday_name=holiday_name,
                    holiday_date=holiday_date.isoformat(),
                    plan_name=plan_name,
                    tenant_id=str(emp.get("organisation_id", "")),
                )
                total_sent += 1

        if total_sent:
            logger.info("Holiday reminder cron: queued reminders", count=total_sent)

    except Exception as exc:
        logger.error("Holiday reminder cron run failed", error=str(exc))


async def run_holiday_reminder_cron() -> None:
    """Background task: check for upcoming holidays and send reminder emails."""
    is_dev = settings.ENVIRONMENT == "development"
    logger.info(
        "Holiday reminder cron started",
        mode="development" if is_dev else "production",
        poll_seconds=_DEV_POLL_SECONDS if is_dev else "daily-at-9am-ist",
    )
    await _run_once()
    while True:
        if is_dev:
            await asyncio.sleep(_DEV_POLL_SECONDS)
        else:
            wait = _seconds_until_9am_ist()
            logger.info("Holiday reminder cron: sleeping until 9 AM IST", seconds=int(wait))
            await asyncio.sleep(wait)
        await _run_once()
