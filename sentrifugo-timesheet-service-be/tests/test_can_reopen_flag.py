"""`can_reopen` on the approval detail responses.

The reopen button used to be shown to anyone holding manage_timesheet, which meant
offering it for months that were never closed and to managers whose POST would have
been refused. The flag answers both halves — is anything closed, and would this
caller be allowed — from the same function the POST goes through, so the button and
the endpoint cannot disagree.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import Forbidden

from .conftest import make_settings, make_user

_EMP = "507f1f77bcf86cd7994390e1"
_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_MGR = "507f1f77bcf86cd7994390b1"
_ORG = PydanticObjectId("507f1f77bcf86cd7994390c1")


def mgr():
    return make_user(id=_MGR, organisation_id=_ORG,
                     is_org_admin=False, is_super_admin=False)


def cutoff_settings(enabled=True, day=25):
    return make_settings(past_submission_cutoff_enabled=enabled,
                         past_submission_cutoff_day=day)


async def flag(*, year=2026, month=7, permitted=True, settings=None, now=None):
    from src.past_submissions import service

    allow = AsyncMock(return_value=(PydanticObjectId(_EMP), [_P1]))
    if not permitted:
        allow = AsyncMock(side_effect=Forbidden("nope"))

    with patch("src.past_submissions.service._assert_may_reopen_for", allow), \
         patch("src.settings.service.get_effective_settings",
               AsyncMock(return_value=cutoff_settings() if settings is None else settings)), \
         patch("src.past_submissions.service.utcnow",
               MagicMock(return_value=now or datetime(2026, 8, 26))):
        return await service.can_reopen_month(mgr(), _EMP, year, month)


class TestBothHalvesMustHold:
    @pytest.mark.asyncio
    async def test_true_when_closed_and_permitted(self):
        assert await flag(year=2026, month=7) is True

    @pytest.mark.asyncio
    async def test_false_when_the_caller_would_be_refused(self):
        """Not their employee, or no projects to grant against — the POST's two 403s."""
        assert await flag(year=2026, month=7, permitted=False) is False

    @pytest.mark.asyncio
    async def test_false_when_the_cutoff_is_switched_off(self):
        """Nothing is closed, so there is nothing to reopen."""
        assert await flag(settings=cutoff_settings(enabled=False)) is False

    @pytest.mark.asyncio
    async def test_false_when_there_are_no_settings_at_all(self):
        assert await flag(settings=False) is False

    @pytest.mark.asyncio
    async def test_false_for_a_month_the_cutoff_has_not_reached(self):
        """On 26 Aug the boundary is 25 Aug; September is entirely in the future."""
        assert await flag(year=2026, month=9) is False

    @pytest.mark.asyncio
    async def test_true_once_any_day_of_the_month_is_settled(self):
        """August's 1st is behind the 25 Aug boundary, so August has closed days."""
        assert await flag(year=2026, month=8) is True

    @pytest.mark.asyncio
    async def test_it_asks_the_same_gate_the_post_uses(self):
        """If these ever diverged, the button would lie about a 403."""
        from src.past_submissions import service

        allow = AsyncMock(return_value=(PydanticObjectId(_EMP), [_P1]))
        with patch("src.past_submissions.service._assert_may_reopen_for", allow), \
             patch("src.settings.service.get_effective_settings",
                   AsyncMock(return_value=cutoff_settings())), \
             patch("src.past_submissions.service.utcnow",
                   MagicMock(return_value=datetime(2026, 8, 26))):
            await service.can_reopen_month(mgr(), _EMP, 2026, 7)

        allow.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_an_existing_grant_does_not_flip_it(self):
        """`can_reopen` is entitlement, not current state — the listing says whether
        a month is already open, and conflating them would hide the difference."""
        from src.past_submissions import service

        find = MagicMock()
        with patch("src.past_submissions.service._assert_may_reopen_for",
                   AsyncMock(return_value=(PydanticObjectId(_EMP), [_P1]))), \
             patch("src.settings.service.get_effective_settings",
                   AsyncMock(return_value=cutoff_settings())), \
             patch("src.past_submissions.service.PastSubmissionOverride.find", find), \
             patch("src.past_submissions.service.utcnow",
                   MagicMock(return_value=datetime(2026, 8, 26))):
            assert await service.can_reopen_month(mgr(), _EMP, 2026, 7) is True

        find.assert_not_called()


class TestPeriodIsNamed:
    """A week belongs to the month it starts in, which is not always the month the
    dashboard has selected. Each response says which month its flag is about, so the
    two can be seen to differ instead of quietly disagreeing.
    """

    async def detail(self, week_start):
        from src.approvals import service

        doc = MagicMock()
        doc.id = PydanticObjectId("507f1f77bcf86cd799439031")
        doc.user_id = _EMP
        doc.organisation_id = _ORG
        doc.submitted_at = None
        doc.notes = None
        doc.timesheet_status = MagicMock(value="submitted")
        doc.week_start_date = week_start
        doc.week_end_date = week_start + timedelta(days=6)

        from .conftest import make_query_mock

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=doc)), \
             patch("src.approvals.service._assert_employee_in_login_scope", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service._get_manager_visible_scope",
                   AsyncMock(return_value=({str(_P1)}, {}))), \
             patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=([], set()))), \
             patch("src.approvals.service.ApprovalRecord.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service.Project.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service.Task.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service.TimesheetProjectApproval.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={})), \
             patch("src.approvals.service.resolve_emp_codes", AsyncMock(return_value={})), \
             patch("src.approvals.service.fetch_work_calendars", AsyncMock(return_value={})), \
             patch("src.approvals.service._fetch_leave_calendar",
                   AsyncMock(return_value=([], []))), \
             patch("src.past_submissions.service.can_reopen_month",
                   AsyncMock(return_value=True)):
            return await service.get_timesheet_detail(
                "507f1f77bcf86cd799439031", mgr(),
            )

    @pytest.mark.asyncio
    async def test_the_week_detail_names_the_weeks_own_month(self):
        out = await self.detail(datetime(2026, 8, 17))

        assert out["reopen_period"] == {"year": 2026, "month": 8}
        assert out["can_reopen"] is True

    @pytest.mark.asyncio
    async def test_a_straddling_week_belongs_to_the_month_it_starts_in(self):
        """Mon 27 Jul – Sun 2 Aug is a July week, even opened from an August view."""
        out = await self.detail(datetime(2026, 7, 27))

        assert out["reopen_period"] == {"year": 2026, "month": 7}
