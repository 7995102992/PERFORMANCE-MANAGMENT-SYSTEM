from __future__ import annotations

import asyncio
import calendar
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Run sub-hourly so the 18:30-local window is observed in every timezone.
_PROD_INTERVAL_SECONDS = 1_800   # 30 minutes
_DEV_INTERVAL_SECONDS = 900      # 15 minutes

# Trigger hour/minute in each Business Unit's local timezone.
_TRIGGER_HOUR = 18
_TRIGGER_MINUTE = 30
# Fire on the first tick at/after 18:30 within this window; the date-stamped
# email idempotency key ensures only one send per recipient per local day.
_WINDOW_MINUTES = 90  # 18:30 .. 20:00 local


def _matches_window(local: datetime, schedule: str) -> bool:
    """True when `local` is on the schedule day AND within the 18:30 window."""
    is_friday = local.weekday() == 4
    last_day = calendar.monthrange(local.year, local.month)[1]
    is_month_end = local.day == last_day
    if schedule == "weekend" and not is_friday:
        return False
    if schedule == "month_end" and not is_month_end:
        return False
    minutes_now = local.hour * 60 + local.minute
    trigger_min = _TRIGGER_HOUR * 60 + _TRIGGER_MINUTE
    return trigger_min <= minutes_now < trigger_min + _WINDOW_MINUTES


async def _run_once() -> None:
    try:
        from bson import ObjectId
        from ..models import TimesheetSettings, TimesheetProjectApproval, ProjectApprovalStatusEnum, WeeklyTimesheet
        from ..notifications.service import notify_client_approval_schedule_reminder
        from ..common.user_resolver import fetch_user_bu_timezones

        now_utc = datetime.now(timezone.utc)

        eligible = await TimesheetSettings.find({
            "client_notify_on_schedule_enabled": True,
            "project_id": None,
            "deleted_on": None,
        }).to_list()
        if not eligible:
            return

        logger.info("client_approval_cron tick eligible_orgs=%d", len(eligible))

        for s in eligible:
            schedule = s.client_notify_schedule  # "weekend" | "month_end"
            org_id = s.organisation_id

            # Pending (L1-approved, awaiting client) work for the org
            pending_tpa = await TimesheetProjectApproval.find({
                "organisation_id": org_id,
                "status": ProjectApprovalStatusEnum.L1_APPROVED.value,
                "deleted_on": None,
            }).to_list()
            if not pending_tpa:
                continue

            ts_ids = list({tpa.weekly_timesheet_id for tpa in pending_tpa})
            timesheets = await WeeklyTimesheet.find({
                "_id": {"$in": ts_ids},
                "deleted_on": None,
            }).to_list()
            if not timesheets:
                continue

            # Resolve each timesheet's employee -> Business Unit timezone
            user_ids = list({ts.user_id for ts in timesheets})
            user_tz = await fetch_user_bu_timezones(user_ids)

            # Group timesheet ids by their employee's BU timezone
            tz_groups: dict = {}  # tzinfo -> set[str ts ids]
            for ts in timesheets:
                tz = user_tz.get(ts.user_id) or timezone.utc
                tz_groups.setdefault(tz, set()).add(str(ts.id))

            # Fire each timezone group only when it's 18:30 local on the schedule day
            for tz, ts_id_set in tz_groups.items():
                local = now_utc.astimezone(tz)
                if not _matches_window(local, schedule):
                    continue
                period_key = f"{str(tz)}:{local.strftime('%Y-%m-%d')}"
                logger.info(
                    "client_approval_cron triggering org=%s schedule=%s tz=%s local=%s timesheets=%d",
                    org_id, schedule, str(tz), local.isoformat(), len(ts_id_set),
                )
                try:
                    await notify_client_approval_schedule_reminder(
                        org_id, period_key=period_key, restrict_ts_ids=ts_id_set,
                    )
                except Exception:
                    logger.exception("client_approval_cron failed org=%s tz=%s", org_id, str(tz))

    except Exception:
        logger.exception("client_approval_cron _run_once failed")


async def run_client_approval_reminder_cron() -> None:
    from ..config import settings as cfg

    interval = _DEV_INTERVAL_SECONDS if cfg.ENVIRONMENT == "development" else _PROD_INTERVAL_SECONDS
    logger.info("client_approval_cron started interval=%ds", interval)
    await _run_once()
    while True:
        await asyncio.sleep(interval)
        await _run_once()
