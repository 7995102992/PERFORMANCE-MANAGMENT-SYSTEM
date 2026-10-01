"""Missing weeks, and the coarse status filter, on Team Timesheets.

A week nobody filed leaves no document, so a query over stored timesheets cannot
see it — yet that gap is exactly what a manager chasing time is looking for. Those
weeks are synthesised at read time as `not_submitted`, bounded on both sides: only
weeks that have ended, and only back to when the employee joined the manager's work.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.approvals.service import (
    NOT_SUBMITTED,
    STATUS_FILTER_GROUPS,
    _monday_of,
    _past_weeks_between,
)

from .conftest import make_query_mock, make_user

_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_U1 = "u1"

_THIS_MONDAY = _monday_of(datetime.now(timezone.utc))


def wk(n):
    """Monday of the week `n` weeks before the current one."""
    return _THIS_MONDAY - timedelta(weeks=n)


def make_ts(monday, status="submitted", ts_id="ts1"):
    t = MagicMock()
    t.id = ts_id
    t.user_id = _U1
    t.week_start_date = monday
    t.week_end_date = monday + timedelta(days=6)
    t.submitted_at = monday + timedelta(days=6)
    t.timesheet_status = MagicMock(value=status)
    return t


def make_ra(start_date=None):
    a = MagicMock()
    a.user_id = _U1
    a.project_id = _P1
    a.start_date = start_date
    return a


class TestPastWeeksOnly:
    def test_the_current_week_is_never_included(self):
        """A week still being worked has not been missed."""
        weeks = _past_weeks_between(wk(3), _THIS_MONDAY + timedelta(days=30))

        assert _THIS_MONDAY not in weeks

    def test_future_weeks_are_never_included(self):
        weeks = _past_weeks_between(wk(1), _THIS_MONDAY + timedelta(weeks=8))

        assert all(w < _THIS_MONDAY for w in weeks)

    def test_it_returns_the_ended_weeks_in_the_period(self):
        weeks = _past_weeks_between(wk(3), _THIS_MONDAY)

        assert weeks == [wk(3), wk(2), wk(1)]

    def test_a_week_belongs_to_the_month_it_starts_in(self):
        """The reported bug: asking for August returned a July row, because the week
        of Jul 27 – Aug 2 overlaps August but is bucketed by its start date. Weeks
        are selected by start date, matching the stored-timesheet query.
        """
        from src.approvals.service import _month_range

        start, end = _month_range(2026, 8)
        weeks = _past_weeks_between(start, end)

        assert all(w.month == 8 for w in weeks), [str(w.date()) for w in weeks]
        assert datetime(2026, 7, 27) not in weeks

    def test_a_period_starting_mid_week_skips_that_week(self):
        """Aug 1 2026 is a Saturday — the week containing it started in July."""
        from src.approvals.service import _month_range

        start, _ = _month_range(2026, 8)
        weeks = _past_weeks_between(start, datetime(2026, 8, 31))

        assert weeks[0] == datetime(2026, 8, 3)


async def run_list(weeks, assignments, *, status_filter="all", tpa=None):
    from src.approvals import service

    tpa_map = tpa if tpa is not None else {str(w.id): ["submitted"] for w in weeks}
    p = MagicMock(page=1, page_size=50)

    with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=[_U1])), \
         patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={_U1: "Gopal"})), \
         patch("src.approvals.service.resolve_emp_codes", AsyncMock(return_value={})), \
         patch("src.approvals.service.WeeklyTimesheet.find",
               MagicMock(return_value=make_query_mock(weeks))), \
         patch("src.approvals.service._get_manager_visible_scope",
               AsyncMock(return_value=({str(_P1)}, {}))), \
         patch("src.approvals.service._scoped_tpa_statuses_by_week",
               AsyncMock(return_value=tpa_map)), \
         patch("src.approvals.service.ResourceAssignment.find",
               MagicMock(return_value=make_query_mock(assignments))), \
         patch("src.approvals.service.TimesheetEntry.find",
               MagicMock(return_value=make_query_mock([]))):
        return await service.list_team_timesheets(
            make_user(), p, status_filter=status_filter,
        )


def all_weeks(page):
    return [w for item in page["items"] for w in item["weeks"]]


class TestMissingWeeks:
    @pytest.mark.asyncio
    async def test_a_week_with_no_timesheet_shows_as_not_submitted(self):
        page = await run_list([], [make_ra(start_date=wk(3))])
        rows = all_weeks(page)

        assert rows, "expected synthesised weeks"
        assert {r["timesheet_status"] for r in rows} == {NOT_SUBMITTED}
        assert all(r["id"] is None for r in rows)
        assert all(r["total_hours"] == 0.0 for r in rows)

    @pytest.mark.asyncio
    async def test_a_submitted_week_is_not_also_reported_missing(self):
        submitted = make_ts(wk(2))
        page = await run_list([submitted], [make_ra(start_date=wk(4))])
        rows = {r["week_start_date"]: r["timesheet_status"] for r in all_weeks(page)}

        assert rows[wk(2)] == "submitted"
        assert rows[wk(1)] == NOT_SUBMITTED

    @pytest.mark.asyncio
    async def test_weeks_before_the_employee_joined_are_not_reported(self):
        """Nobody owes time for weeks predating their assignment."""
        page = await run_list([], [make_ra(start_date=wk(2))])
        starts = {r["week_start_date"] for r in all_weeks(page)}

        assert wk(1) in starts
        assert wk(5) not in starts

    @pytest.mark.asyncio
    async def test_an_assignment_without_a_start_date_covers_the_window(self):
        page = await run_list([], [make_ra(start_date=None)])

        assert len(all_weeks(page)) > 1

    @pytest.mark.asyncio
    async def test_someone_not_on_this_managers_projects_is_skipped(self):
        page = await run_list([], [])

        assert page["items"] == []

    @pytest.mark.asyncio
    async def test_the_current_week_never_appears_as_missing(self):
        page = await run_list([], [make_ra(start_date=wk(4))])
        starts = {r["week_start_date"] for r in all_weeks(page)}

        assert _THIS_MONDAY not in starts

    @pytest.mark.asyncio
    async def test_a_missing_week_drives_the_month_rollup(self):
        """Unfiled time outranks decided weeks — it is the one nobody can act on."""
        page = await run_list([make_ts(wk(1), "client_approved")],
                              [make_ra(start_date=wk(3))],
                              tpa={"ts1": ["client_approved"]})

        assert page["items"][0]["timesheet_status"] == NOT_SUBMITTED
        assert page["items"][0]["status_counts"][NOT_SUBMITTED] >= 1


class TestStatusFilter:
    def test_the_groups_cover_every_actionable_status(self):
        covered = set().union(*STATUS_FILTER_GROUPS.values())

        assert covered == {
            "submitted", "resubmitted", "l1_approved", "client_approved",
            "l1_rejected", "client_rejected", NOT_SUBMITTED,
        }

    @pytest.mark.asyncio
    async def test_all_is_the_default_and_keeps_everything(self):
        page = await run_list([make_ts(wk(1))], [make_ra(start_date=wk(2))])
        statuses = {r["timesheet_status"] for r in all_weeks(page)}

        assert "submitted" in statuses
        assert NOT_SUBMITTED in statuses

    @pytest.mark.asyncio
    async def test_pending_keeps_only_awaiting_action(self):
        weeks = [make_ts(wk(1), "submitted", "ts1"),
                 make_ts(wk(2), "client_approved", "ts2")]
        page = await run_list(weeks, [make_ra(start_date=wk(2))],
                              status_filter="pending",
                              tpa={"ts1": ["submitted"], "ts2": ["client_approved"]})
        statuses = {r["timesheet_status"] for r in all_weeks(page)}

        assert statuses == {"submitted"}

    @pytest.mark.asyncio
    async def test_approved_covers_both_levels(self):
        weeks = [make_ts(wk(1), "l1_approved", "ts1"),
                 make_ts(wk(2), "client_approved", "ts2"),
                 make_ts(wk(3), "submitted", "ts3")]
        page = await run_list(weeks, [make_ra(start_date=wk(3))],
                              status_filter="approved",
                              tpa={"ts1": ["l1_approved"], "ts2": ["client_approved"],
                                   "ts3": ["submitted"]})
        statuses = {r["timesheet_status"] for r in all_weeks(page)}

        assert statuses == {"l1_approved", "client_approved"}

    @pytest.mark.asyncio
    async def test_rejected_covers_both_levels(self):
        weeks = [make_ts(wk(1), "l1_rejected", "ts1"),
                 make_ts(wk(2), "client_rejected", "ts2"),
                 make_ts(wk(3), "submitted", "ts3")]
        page = await run_list(weeks, [make_ra(start_date=wk(3))],
                              status_filter="rejected",
                              tpa={"ts1": ["l1_rejected"], "ts2": ["client_rejected"],
                                   "ts3": ["submitted"]})
        statuses = {r["timesheet_status"] for r in all_weeks(page)}

        assert statuses == {"l1_rejected", "client_rejected"}

    @pytest.mark.asyncio
    async def test_a_narrow_filter_drops_the_missing_weeks(self):
        """`not_submitted` is its own bucket, not silently folded into pending."""
        page = await run_list([make_ts(wk(1))], [make_ra(start_date=wk(4))],
                              status_filter="pending")
        statuses = {r["timesheet_status"] for r in all_weeks(page)}

        assert NOT_SUBMITTED not in statuses

    @pytest.mark.asyncio
    async def test_not_submitted_can_be_asked_for_on_its_own(self):
        page = await run_list([make_ts(wk(1))], [make_ra(start_date=wk(4))],
                              status_filter="not_submitted")
        statuses = {r["timesheet_status"] for r in all_weeks(page)}

        assert statuses == {NOT_SUBMITTED}

    @pytest.mark.asyncio
    async def test_a_filtered_out_week_is_not_then_reported_missing(self):
        """The week exists; hiding it must not turn it into a gap."""
        page = await run_list([make_ts(wk(1), "client_approved", "ts1")],
                              [make_ra(start_date=wk(1))],
                              status_filter="not_submitted",
                              tpa={"ts1": ["client_approved"]})
        starts = {r["week_start_date"] for r in all_weeks(page)}

        assert wk(1) not in starts
