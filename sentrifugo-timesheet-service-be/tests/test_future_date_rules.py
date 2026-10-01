"""Future-date rules on entry saving.

Two settings cap entries at today. They shared one exception whose message named
only the first of them, so a block caused by allow_future_entries reported "Daily
entry mode is enabled" — which is not why it fired. The zero-hour placeholders the
grid posts for every day of the week are also exempt: reserving a future day without
logging time against it is not what either rule guards.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.exceptions import FutureDateEntryNotAllowed
from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate

from .conftest import make_query_mock, make_settings, make_timesheet, make_user

_P1 = "507f1f77bcf86cd799439011"
_T1 = "507f1f77bcf86cd7994390a1"

_TOMORROW = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")
_YESTERDAY = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")


def payload(day, hours):
    return TimesheetEntryBulkSave(entries=[
        TimesheetEntryCreate(project_id=_P1, task_id=_T1, entry_date=day, hours=hours)
    ])


async def save(settings, body):
    from src.timesheets import service

    entry = MagicMock()
    entry.insert = AsyncMock()
    te = MagicMock(find=MagicMock(return_value=make_query_mock([])),
                   find_one=AsyncMock(return_value=None), return_value=entry)

    with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=make_timesheet())), \
         patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
         patch("src.timesheets.service.hidden_project_ids", AsyncMock(return_value=[])), \
         patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
         patch("src.timesheets.service.Project.find", MagicMock(return_value=make_query_mock([]))), \
         patch("src.timesheets.service.TimesheetEntry", te), \
         patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(0.0, 0.0, 0.0))), \
         patch("src.timesheets.service._ts_to_out", MagicMock(return_value={})), \
         patch("src.timesheets.service._entry_to_out", MagicMock(return_value={})), \
         patch("src.timesheets.service.emit_activity", AsyncMock()):
        return await service.save_entries("ts1", body, make_user())


class TestFutureDateMessage:
    @pytest.mark.asyncio
    async def test_allow_future_entries_off_reports_its_own_reason(self):
        settings = make_settings(daily_time_entry_enabled=False, allow_future_entries=False,
                                  daily_restrictions_enabled=False, restrict_time_off_entries=False)

        with pytest.raises(FutureDateEntryNotAllowed) as exc:
            await save(settings, payload(_TOMORROW, 8.0))

        assert exc.value.code == "TSM-022"
        assert "Daily entry mode" not in exc.value.message
        assert "future dates is turned off" in exc.value.message

    @pytest.mark.asyncio
    async def test_daily_entry_mode_reports_daily_entry_mode(self):
        settings = make_settings(daily_time_entry_enabled=True, allow_future_entries=False,
                                  daily_restrictions_enabled=False, restrict_time_off_entries=False)

        with pytest.raises(FutureDateEntryNotAllowed) as exc:
            await save(settings, payload(_TOMORROW, 8.0))

        assert "Daily entry mode is on" in exc.value.message


class TestZeroHourPlaceholders:
    @pytest.mark.asyncio
    async def test_a_zero_hour_future_day_is_allowed(self):
        """The grid posts a row per day of the week — future ones carry no hours."""
        settings = make_settings(daily_time_entry_enabled=False, allow_future_entries=False,
                                  daily_restrictions_enabled=False, restrict_time_off_entries=False)

        await save(settings, payload(_TOMORROW, 0))

    @pytest.mark.asyncio
    async def test_past_days_with_hours_are_unaffected(self):
        settings = make_settings(daily_time_entry_enabled=True, allow_future_entries=False,
                                  daily_restrictions_enabled=False, restrict_time_off_entries=False)

        await save(settings, payload(_YESTERDAY, 8.0))
