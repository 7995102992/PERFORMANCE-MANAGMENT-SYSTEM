from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

_PROD_INTERVAL_SECONDS = 1_800   # 30 minutes
_DEV_INTERVAL_SECONDS = 900      # 15 minutes

_WINDOW_MINUTES = 90


def _parse_trigger_time(time_str: str) -> tuple[int, int]:
    parts = time_str.split(":")
    return int(parts[0]), int(parts[1])


def _matches_window(local: datetime, enabled_weekdays: set[int], trigger_hour: int = 9, trigger_minute: int = 0) -> bool:
    if local.weekday() not in enabled_weekdays:
        return False
    minutes_now = local.hour * 60 + local.minute
    trigger_min = trigger_hour * 60 + trigger_minute
    return trigger_min <= minutes_now < trigger_min + _WINDOW_MINUTES


async def _run_once() -> None:
    try:
        from ..models import TimesheetSettings, WEEKDAY_NAMES
        from ..notifications.service import notify_employee_fill_reminder
        from ..common.user_resolver import fetch_org_employee_user_ids, fetch_user_bu_timezones

        now_utc = datetime.now(timezone.utc)

        eligible = await TimesheetSettings.find({
            "employee_reminder_enabled": True,
            "project_id": None,
            "deleted_on": None,
        }).to_list()
        if not eligible:
            return

        logger.info("employee_reminder_cron tick eligible_orgs=%d", len(eligible))

        for s in eligible:
            org_id = s.organisation_id

            # Enabled weekday indices (Mon=0 .. Sun=6) from the per-day config
            day_map = s.employee_reminder_days or {}
            enabled_weekdays = {
                WEEKDAY_NAMES.index(d)
                for d, on in day_map.items()
                if on and d in WEEKDAY_NAMES
            }
            if not enabled_weekdays:
                continue

            trigger_hour, trigger_minute = _parse_trigger_time(
                getattr(s, "employee_reminder_time", None) or "09:00"
            )

            user_ids = await fetch_org_employee_user_ids(org_id)
            if not user_ids:
                continue

            user_tz = await fetch_user_bu_timezones(user_ids)

            # Group employees by their BU timezone
            tz_groups: dict = {}  # tzinfo -> list[user_id]
            for uid in user_ids:
                tz = user_tz.get(uid) or timezone.utc
                tz_groups.setdefault(tz, []).append(uid)

            for tz, group_uids in tz_groups.items():
                local = now_utc.astimezone(tz)
                if not _matches_window(local, enabled_weekdays, trigger_hour, trigger_minute):
                    continue

                # Current local week (Monday..Sunday) for display
                local_date = local.date()
                week_monday = local_date - timedelta(days=local.weekday())
                week_sunday = week_monday + timedelta(days=6)
                period_key = f"{str(tz)}:{local_date.isoformat()}"

                logger.info(
                    "employee_reminder_cron triggering org=%s day=%s tz=%s local=%s recipients=%d",
                    org_id, local.strftime("%A"), str(tz), local.isoformat(), len(group_uids),
                )
                try:
                    await notify_employee_fill_reminder(
                        org_id,
                        group_uids,
                        week_start=week_monday.isoformat(),
                        week_end=week_sunday.isoformat(),
                        period_key=period_key,
                    )
                except Exception:
                    logger.exception("employee_reminder_cron failed org=%s tz=%s", org_id, str(tz))

    except Exception:
        logger.exception("employee_reminder_cron _run_once failed")


async def run_employee_reminder_cron() -> None:
    from ..config import settings as cfg

    interval = _DEV_INTERVAL_SECONDS if cfg.ENVIRONMENT == "development" else _PROD_INTERVAL_SECONDS
    logger.info("employee_reminder_cron started interval=%ds", interval)
    await _run_once()
    while True:
        await asyncio.sleep(interval)
        await _run_once()
