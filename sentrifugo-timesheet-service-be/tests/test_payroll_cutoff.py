"""Monthly payroll cutoff for timesheet saving and submission.

The cutoff closes *days*: on the 25th, the 25th and everything before it are settled
and only the 26th onward may still be filled. The boundary usually falls mid-week, so
a straddling week is half closed — its earlier days are frozen while its later ones
still accept time. A project manager can reopen a month for their own project.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.common.cutoff import (
    clamp_cutoff_day,
    current_cutoff_boundary,
    is_day_locked,
    is_period_locked,
)
from src.exceptions import PastSubmissionLocked
from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate

from .conftest import make_query_mock, make_settings, make_timesheet

_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_P2 = PydanticObjectId("507f1f77bcf86cd799439012")


class TestCutoffBoundary:
    def test_boundary_is_this_month_once_the_day_arrives(self):
        assert current_cutoff_boundary(date(2026, 8, 25), 25) == date(2026, 8, 25)
        assert current_cutoff_boundary(date(2026, 8, 31), 25) == date(2026, 8, 25)

    def test_boundary_is_last_month_before_the_day(self):
        assert current_cutoff_boundary(date(2026, 8, 24), 25) == date(2026, 7, 25)
        assert current_cutoff_boundary(date(2026, 8, 1), 25) == date(2026, 7, 25)

    def test_rolls_across_the_year(self):
        assert current_cutoff_boundary(date(2026, 1, 3), 25) == date(2025, 12, 25)

    def test_day_beyond_month_length_clamps(self):
        assert clamp_cutoff_day(2026, 2, 31) == 28
        assert current_cutoff_boundary(date(2026, 2, 28), 31) == date(2026, 2, 28)

    def test_week_ending_before_the_boundary_is_locked(self):
        # week Aug 17-23 against a boundary of Aug 25
        assert is_period_locked(date(2026, 8, 23), date(2026, 8, 26), 25) is True

    def test_a_week_with_any_open_day_is_still_submittable(self):
        # week Aug 24-30 straddles the cutoff, so it holds live post-cutoff work
        assert is_period_locked(date(2026, 8, 30), date(2026, 8, 26), 25) is False

    def test_nothing_locks_before_the_first_cutoff_passes(self):
        assert is_period_locked(date(2026, 8, 23), date(2026, 8, 24), 25) is False


class TestDayLock:
    """The cutoff day itself is closed — only the day after it is still open."""

    def test_the_cutoff_day_is_closed(self):
        assert is_day_locked(date(2026, 8, 25), date(2026, 8, 25), 25) is True

    def test_the_day_after_the_cutoff_is_open(self):
        assert is_day_locked(date(2026, 8, 26), date(2026, 8, 26), 25) is False

    def test_a_straddling_week_is_closed_on_one_side_only(self):
        """Mon 24 – Sun 30, evaluated on the 25th: the split runs through the week."""
        today = date(2026, 8, 25)
        locked = [is_day_locked(date(2026, 8, d), today, 25) for d in range(24, 31)]

        assert locked == [True, True, False, False, False, False, False]

    def test_earlier_days_stay_open_until_the_cutoff_arrives(self):
        assert is_day_locked(date(2026, 8, 24), date(2026, 8, 24), 25) is False


def make_ts(week_start="2026-08-17", week_end="2026-08-23"):
    ts = make_timesheet()
    ts.week_start_date = datetime.fromisoformat(week_start)
    ts.week_end_date = datetime.fromisoformat(week_end)
    return ts


def cutoff_settings(**overrides):
    return make_settings(
        past_submission_cutoff_enabled=True, past_submission_cutoff_day=25, **overrides,
    )


NOW = datetime(2026, 8, 26, tzinfo=timezone.utc)


def stored(project_id=_P1, task_id="507f1f77bcf86cd7994390a1", day="2026-08-17", hours=8.0):
    e = MagicMock()
    e.project_id = project_id
    e.task_id = PydanticObjectId(task_id)
    e.entry_date = datetime.fromisoformat(day)
    e.hours = hours
    return e


def payload(*rows):
    return TimesheetEntryBulkSave(entries=[
        TimesheetEntryCreate(project_id=str(p), task_id=t, entry_date=d, hours=h)
        for p, t, d, h in rows
    ])


_T1 = "507f1f77bcf86cd7994390a1"


async def check_save(existing, body, ts=None, overrides=(), projects=()):
    from src.timesheets import service

    with patch("src.timesheets.service.TimesheetEntry.find",
               MagicMock(return_value=make_query_mock(existing))), \
         patch("src.past_submissions.service.PastSubmissionOverride.find",
               MagicMock(return_value=make_query_mock(list(overrides)))), \
         patch("src.timesheets.service.Project.find",
               MagicMock(return_value=make_query_mock(list(projects)))):
        await service._assert_period_open(
            ts or make_ts("2026-08-24", "2026-08-30"), cutoff_settings(), NOW, body=body,
        )


async def check_submit(existing, ts=None, overrides=(), projects=()):
    from src.timesheets import service

    with patch("src.timesheets.service.TimesheetEntry.find",
               MagicMock(return_value=make_query_mock(existing))), \
         patch("src.past_submissions.service.PastSubmissionOverride.find",
               MagicMock(return_value=make_query_mock(list(overrides)))), \
         patch("src.timesheets.service.Project.find",
               MagicMock(return_value=make_query_mock(list(projects)))):
        await service._assert_period_open(ts or make_ts(), cutoff_settings(), NOW)


class TestSubmission:
    @pytest.mark.asyncio
    async def test_passes_when_the_rule_is_disabled(self):
        from src.timesheets import service

        settings = make_settings(past_submission_cutoff_enabled=False)
        await service._assert_period_open(make_ts(), settings, NOW)

    @pytest.mark.asyncio
    async def test_a_week_with_an_open_day_can_still_be_submitted(self):
        """Mon 24 – Sun 30 against a boundary of Aug 25: the 26th onward is live work,
        so the ordinary end-of-week submission is not blocked."""
        await check_submit([], ts=make_ts("2026-08-24", "2026-08-30"))

    @pytest.mark.asyncio
    async def test_blocks_a_fully_closed_week(self):
        project = MagicMock()
        project.name = "Ingredients Warehouse"
        with pytest.raises(PastSubmissionLocked) as exc:
            await check_submit([stored()], projects=[project])

        assert exc.value.code == "TSM-035"
        assert "Aug 25, 2026" in exc.value.message
        assert "Ingredients Warehouse" in exc.value.message

    @pytest.mark.asyncio
    async def test_an_override_reopens_the_project(self):
        await check_submit([stored()], overrides=[MagicMock(project_ids=[_P1], year=2026, month=8)])

    @pytest.mark.asyncio
    async def test_one_open_project_does_not_unlock_the_others(self):
        other = MagicMock()
        other.name = "Warehouse Two"
        with pytest.raises(PastSubmissionLocked) as exc:
            await check_submit(
                [stored(_P1), stored(_P2)],
                overrides=[MagicMock(project_ids=[_P1], year=2026, month=8)],
                projects=[other],
            )

        assert "Warehouse Two" in exc.value.message

    @pytest.mark.asyncio
    async def test_override_is_keyed_to_the_weeks_start_month(self):
        """A week starting in July is reopened by a July override, not August."""
        from src.timesheets import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([stored(day="2026-07-27")]))), \
             patch("src.past_submissions.service.PastSubmissionOverride.find", find), \
             patch("src.timesheets.service.Project.find",
                   MagicMock(return_value=make_query_mock([]))):
            with pytest.raises(PastSubmissionLocked):
                await service._assert_period_open(
                    make_ts("2026-07-27", "2026-08-02"), cutoff_settings(), NOW,
                )

        filt = find.call_args.args[0]
        assert (filt["year"], filt["month"]) == (2026, 7)


class TestSavingAcrossTheBoundary:
    """The straddling week, evaluated on Aug 26 with a boundary of Aug 25."""

    @pytest.mark.asyncio
    async def test_filling_a_day_after_the_cutoff_is_allowed(self):
        await check_save([], payload((_P1, _T1, "2026-08-27", 8.0)))

    @pytest.mark.asyncio
    async def test_filling_a_day_on_the_cutoff_is_blocked(self):
        """The 25th itself is settled."""
        project = MagicMock()
        project.name = "Ingredients Warehouse"
        with pytest.raises(PastSubmissionLocked):
            await check_save([], payload((_P1, _T1, "2026-08-25", 8.0)), projects=[project])

    @pytest.mark.asyncio
    async def test_filling_a_day_before_the_cutoff_is_blocked(self):
        project = MagicMock()
        project.name = "Ingredients Warehouse"
        with pytest.raises(PastSubmissionLocked):
            await check_save([], payload((_P1, _T1, "2026-08-24", 8.0)), projects=[project])

    @pytest.mark.asyncio
    async def test_restating_an_unchanged_closed_day_is_allowed(self):
        """Saving replaces the week and the grid posts every day, so an untouched
        closed day arrives in every payload. That must not block the save."""
        await check_save(
            [stored(day="2026-08-24", hours=8.0)],
            payload((_P1, _T1, "2026-08-24", 8.0), (_P1, _T1, "2026-08-27", 6.0)),
        )

    @pytest.mark.asyncio
    async def test_changing_the_hours_on_a_closed_day_is_blocked(self):
        project = MagicMock()
        project.name = "Ingredients Warehouse"
        with pytest.raises(PastSubmissionLocked):
            await check_save(
                [stored(day="2026-08-24", hours=8.0)],
                payload((_P1, _T1, "2026-08-24", 9.0)),
                projects=[project],
            )

    @pytest.mark.asyncio
    async def test_dropping_a_closed_day_is_blocked(self):
        project = MagicMock()
        project.name = "Ingredients Warehouse"
        with pytest.raises(PastSubmissionLocked):
            await check_save(
                [stored(day="2026-08-24", hours=8.0)], payload(), projects=[project],
            )

    @pytest.mark.asyncio
    async def test_a_zero_hour_row_on_a_closed_day_is_ignored(self):
        """The grid's placeholder for an empty day reserves nothing."""
        await check_save([], payload((_P1, _T1, "2026-08-24", 0.0)))

    @pytest.mark.asyncio
    async def test_an_override_reopens_the_closed_side(self):
        await check_save(
            [], payload((_P1, _T1, "2026-08-24", 8.0)),
            overrides=[MagicMock(project_ids=[_P1], year=2026, month=8)],
        )

    @pytest.mark.asyncio
    async def test_an_entirely_open_week_is_never_consulted(self):
        """Nothing closed in the payload means no override lookup at all."""
        from src.timesheets import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.past_submissions.service.PastSubmissionOverride.find", find):
            await service._assert_period_open(
                make_ts("2026-08-24", "2026-08-30"), cutoff_settings(), NOW,
                body=payload((_P1, _T1, "2026-08-28", 8.0)),
            )

        find.assert_not_called()

    @pytest.mark.asyncio
    async def test_closed_week_with_no_entries_is_still_blocked(self):
        from src.timesheets import service

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))):
            with pytest.raises(PastSubmissionLocked):
                await service._assert_period_open(make_ts(), cutoff_settings(), NOW)
