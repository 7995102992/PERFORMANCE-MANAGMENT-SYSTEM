"""A reopened month waives the punctuality rules, and only those.

Reopening says "file this late". Leaving the lateness rules in force would then
refuse the very submission the manager authorised — the employee gets an open month
they still cannot submit into, which is not an exception at all.

What the timesheet must *contain* is untouched: reopening forgives being late, not
being wrong.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import (
    DailyDeadlineMissed,
    MinDailyHoursNotMet,
    PastDueTimesheetsBlocked,
    SubmissionDeadlinePassed,
)

from .conftest import make_query_mock, make_settings, make_timesheet

_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_EMP = PydanticObjectId("507f1f77bcf86cd7994390e1")

# Monday 28 Sep. The cutoff boundary is Fri 25 Sep, so the week of 17–23 Aug is long
# closed; the weekly submission deadline (Fri 18:00 + 24h) has also passed.
NOW = datetime(2026, 9, 28, 12, tzinfo=timezone.utc)


def closed_week():
    ts = make_timesheet()
    ts.id = PydanticObjectId("507f1f77bcf86cd799439031")
    ts.user_id = _EMP
    ts.week_start_date = datetime(2026, 8, 17)
    ts.week_end_date = datetime(2026, 8, 23)
    return ts


def open_week():
    ts = closed_week()
    ts.week_start_date = datetime(2026, 9, 21)
    ts.week_end_date = datetime(2026, 9, 27)
    return ts


def settings(**over):
    base = dict(past_submission_cutoff_enabled=True, past_submission_cutoff_day=25,
                submission_compliance_type="weekly", submission_deadline_hours=24,
                submission_day="friday", submission_time="18:00",
                allow_past_due_submission=True, daily_restrictions_enabled=False,
                min_hours_per_day=0.0)
    base.update(over)
    return make_settings(**base)


async def waived(doc, *, grant=True, cfg=None):
    from src.timesheets import service

    reopened = {str(_P1)} if grant else None
    with patch("src.past_submissions.service.reopened_project_ids",
               AsyncMock(return_value=reopened)):
        return await service._deadlines_waived_by_reopen(doc, cfg or settings(), NOW)


class TestWhenItApplies:
    @pytest.mark.asyncio
    async def test_a_closed_week_with_a_live_grant_is_waived(self):
        assert await waived(closed_week()) is True

    @pytest.mark.asyncio
    async def test_a_closed_week_without_a_grant_is_not(self):
        assert await waived(closed_week(), grant=False) is False

    @pytest.mark.asyncio
    async def test_a_week_the_cutoff_has_not_closed_is_not(self):
        """A grant on a current month must not become a way to duck that week's own
        deadline — the waiver only follows an actual cutoff lock."""
        assert await waived(open_week()) is False

    @pytest.mark.asyncio
    async def test_nothing_is_waived_when_the_cutoff_is_off(self):
        assert await waived(closed_week(),
                            cfg=settings(past_submission_cutoff_enabled=False)) is False

    @pytest.mark.asyncio
    async def test_it_asks_about_the_weeks_own_month_and_owner(self):
        from src.timesheets import service

        lookup = AsyncMock(return_value=None)
        with patch("src.past_submissions.service.reopened_project_ids", lookup):
            await service._deadlines_waived_by_reopen(closed_week(), settings(), NOW)

        assert lookup.await_args.args == (_EMP, 2026, 8)


async def validate(cfg, *, waive, entries=(), older_drafts=0):
    from src.timesheets import service

    find = MagicMock(return_value=make_query_mock(list(entries), count=older_drafts))
    with patch("src.timesheets.service.TimesheetEntry.find", find), \
         patch("src.timesheets.service.WeeklyTimesheet.find",
               MagicMock(return_value=make_query_mock([], count=older_drafts))), \
         patch("src.timesheets.service.ResourceAssignment.find",
               MagicMock(return_value=make_query_mock([]))):
        await service._validate_submission_rules(
            closed_week(), cfg, _EMP, NOW, waive_deadlines=waive,
        )


class TestWhatIsWaived:
    @pytest.mark.asyncio
    async def test_the_weekly_deadline_blocks_without_a_reopen(self):
        with pytest.raises(SubmissionDeadlinePassed):
            await validate(settings(), waive=False)

    @pytest.mark.asyncio
    async def test_the_weekly_deadline_is_waived_with_one(self):
        await validate(settings(), waive=True)

    @pytest.mark.asyncio
    async def test_past_due_blocking_is_waived(self):
        """An older week may itself be closed and unreopened, so enforcing
        submit-oldest-first would deadlock the week that was authorised."""
        cfg = settings(allow_past_due_submission=False)
        with pytest.raises(PastDueTimesheetsBlocked):
            await validate(cfg, waive=False, older_drafts=1)

        await validate(cfg, waive=True, older_drafts=1)

    @pytest.mark.asyncio
    async def test_the_daily_deadline_is_waived(self):
        entry = MagicMock()
        entry.entry_date = datetime(2026, 8, 17)
        entry.hours = 8.0
        entry.modified_on = datetime(2026, 8, 30)  # filed long after the daily deadline
        entry.created_on = datetime(2026, 8, 30)
        entry.project_id = _P1
        entry.task_id = PydanticObjectId("507f1f77bcf86cd7994390a1")

        week = [entry]
        for i in range(1, 7):
            e = MagicMock()
            e.entry_date = datetime(2026, 8, 17 + i)
            e.hours = 8.0
            e.modified_on = e.created_on = datetime(2026, 8, 17 + i)
            e.project_id = _P1
            e.task_id = entry.task_id
            week.append(e)

        cfg = settings(submission_compliance_type="daily")
        with pytest.raises(DailyDeadlineMissed):
            await validate(cfg, waive=False, entries=week)

        await validate(cfg, waive=True, entries=week)


class TestWhatIsNotWaived:
    @pytest.mark.asyncio
    async def test_minimum_daily_hours_still_applies(self):
        """Reopening forgives being late, not filing an empty week."""
        cfg = settings(daily_restrictions_enabled=True, min_hours_per_day=8.0)

        with pytest.raises(MinDailyHoursNotMet):
            await validate(cfg, waive=True)
