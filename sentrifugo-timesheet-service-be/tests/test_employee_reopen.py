"""Reopening a closed month for one employee.

Reopen used to be a project-level control with its own screen. It is now a decision
about one person's late month, taken from the employee-month view: the manager who
approves them grants it, and it lifts the cutoff only on that manager's own projects.
A manager can invite late time onto work they are accountable for; they cannot
reopen someone else's books by reopening their own.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.exceptions import Forbidden, PastSubmissionLocked, TimesheetNotFound

from .conftest import make_query_mock, make_settings, make_user

_EMP = "507f1f77bcf86cd7994390e1"
_OTHER = "507f1f77bcf86cd7994390e2"
_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_P2 = PydanticObjectId("507f1f77bcf86cd799439012")
_MGR = "507f1f77bcf86cd7994390b1"


_ORG = PydanticObjectId("507f1f77bcf86cd7994390c1")


def mgr(admin=False):
    """A manager. Admin flags are explicit: a MagicMock's auto-attributes are truthy,
    and `is_admin` would otherwise short-circuit every authorisation check."""
    return make_user(id=_MGR, organisation_id=_ORG,
                     is_org_admin=admin, is_super_admin=False)


def body(year=2026, month=8, reason="Late invoice from the client"):
    b = MagicMock()
    b.year, b.month, b.reason = year, month, reason
    return b


def patched(*, team=(_EMP,), scope=({str(_P1)}, {}), existing=None, admin=False):
    return [
        patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=list(team))),
        patch("src.approvals.service._get_manager_visible_scope", AsyncMock(return_value=scope)),
        patch("src.past_submissions.service.PastSubmissionOverride.find_one",
              AsyncMock(return_value=existing)),
        patch("src.past_submissions.service.resolve_user_names",
              AsyncMock(return_value={})),
        patch("src.past_submissions.service.emit_activity", AsyncMock()),
        patch("src.past_submissions.service.emit_audit", AsyncMock()),
    ]


class TestWhoMayReopen:
    @pytest.mark.asyncio
    async def test_the_approving_manager_may(self):
        from contextlib import ExitStack

        from src.past_submissions import service

        with ExitStack() as stack:
            for p in patched():
                stack.enter_context(p)
            uid, scope = await service._assert_may_reopen_for(_EMP, mgr())

        assert str(uid) == _EMP
        assert scope == [_P1]

    @pytest.mark.asyncio
    async def test_someone_elses_employee_is_refused(self):
        from contextlib import ExitStack

        from src.past_submissions import service

        with ExitStack() as stack:
            for p in patched(team=[_OTHER]):
                stack.enter_context(p)
            with pytest.raises(Forbidden):
                await service._assert_may_reopen_for(_EMP, mgr())

    @pytest.mark.asyncio
    async def test_a_manager_with_no_projects_is_refused(self):
        """Nothing to reopen for — better a clear refusal than an empty grant."""
        from contextlib import ExitStack

        from src.past_submissions import service

        with ExitStack() as stack:
            for p in patched(scope=(set(), {})):
                stack.enter_context(p)
            with pytest.raises(Forbidden):
                await service._assert_may_reopen_for(_EMP, mgr())

    @pytest.mark.asyncio
    async def test_an_admin_grants_unrestricted(self):
        from src.past_submissions import service

        uid, scope = await service._assert_may_reopen_for(
            _EMP, mgr(admin=True),
        )

        assert str(uid) == _EMP
        assert scope == []

    @pytest.mark.asyncio
    async def test_an_unusable_id_is_not_found(self):
        from src.past_submissions import service

        with pytest.raises(TimesheetNotFound):
            await service._assert_may_reopen_for("not-an-id", mgr())


class TestGranting:
    @pytest.mark.asyncio
    async def test_it_snapshots_the_granters_projects(self):
        """A fixed decision, not one that widens when the manager picks up more work."""
        from contextlib import ExitStack

        from src.past_submissions import service

        made = MagicMock()
        made.id = PydanticObjectId("507f1f77bcf86cd7994390f1")
        made.organisation_id = _ORG
        made.user_id = PydanticObjectId(_EMP)
        made.year, made.month = 2026, 8
        made.project_ids = [_P1, _P2]
        made.reason = None
        made.created_by = _MGR
        made.created_on = None
        made.insert = AsyncMock()

        klass = MagicMock(return_value=made)
        klass.find_one = AsyncMock(return_value=None)

        with ExitStack() as stack:
            for p in patched(scope=({str(_P1), str(_P2)}, {})):
                stack.enter_context(p)
            stack.enter_context(
                patch("src.past_submissions.service.PastSubmissionOverride", klass))
            out = await service.open_month(_EMP, body(), mgr())

        assert set(klass.call_args.kwargs["project_ids"]) == {_P1, _P2}
        assert set(out["project_ids"]) == {str(_P1), str(_P2)}
        assert out["user_id"] == _EMP
        assert (out["year"], out["month"]) == (2026, 8)
        made.insert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_regranting_refreshes_the_snapshot(self):
        """Re-reopening extends a manager's own exemption to newly acquired projects."""
        from contextlib import ExitStack

        from src.past_submissions import service

        existing = MagicMock()
        existing.id = PydanticObjectId("507f1f77bcf86cd7994390f1")
        existing.organisation_id = "org1"
        existing.user_id = PydanticObjectId(_EMP)
        existing.year, existing.month = 2026, 8
        existing.project_ids = [_P1]
        existing.reason = "old"
        existing.created_by = _MGR
        existing.created_on = None
        existing.save = AsyncMock()

        with ExitStack() as stack:
            for p in patched(scope=({str(_P1), str(_P2)}, {}), existing=existing):
                stack.enter_context(p)
            out = await service.open_month(_EMP, body(), mgr())

        assert set(out["project_ids"]) == {str(_P1), str(_P2)}
        existing.save.assert_awaited_once()


class TestExpiry:
    """A reopened month is an exception to payroll, and an exception nobody closes
    stops being one — so the window shuts itself after a week.
    """

    @pytest.mark.asyncio
    async def test_a_grant_expires_a_week_out(self):
        from contextlib import ExitStack

        from src.past_submissions import service

        made = MagicMock()
        made.id = PydanticObjectId("507f1f77bcf86cd7994390f1")
        made.organisation_id = _ORG
        made.user_id = PydanticObjectId(_EMP)
        made.year, made.month = 2026, 8
        made.project_ids = [_P1]
        made.expires_at = None
        made.reason = None
        made.created_by = _MGR
        made.created_on = None
        made.insert = AsyncMock()

        klass = MagicMock(return_value=made)
        klass.find_one = AsyncMock(return_value=None)

        before = utcnow()
        with ExitStack() as stack:
            for p in patched():
                stack.enter_context(p)
            stack.enter_context(
                patch("src.past_submissions.service.PastSubmissionOverride", klass))
            await service.open_month(_EMP, body(), mgr())

        granted = klass.call_args.kwargs["expires_at"]
        assert service.REOPEN_WINDOW == timedelta(days=7)
        assert before + service.REOPEN_WINDOW <= granted <= utcnow() + service.REOPEN_WINDOW

    @pytest.mark.asyncio
    async def test_reopening_again_refreshes_the_window(self):
        """A manager whose employee needs longer simply reopens; no second grant."""
        from contextlib import ExitStack

        from src.past_submissions import service

        existing = MagicMock()
        existing.id = PydanticObjectId("507f1f77bcf86cd7994390f1")
        existing.organisation_id = _ORG
        existing.user_id = PydanticObjectId(_EMP)
        existing.year, existing.month = 2026, 8
        existing.project_ids = [_P1]
        existing.expires_at = utcnow() - timedelta(days=3)  # already lapsed
        existing.reason = "old"
        existing.created_by = _MGR
        existing.created_on = None
        existing.save = AsyncMock()

        with ExitStack() as stack:
            for p in patched(existing=existing):
                stack.enter_context(p)
            out = await service.open_month(_EMP, body(), mgr())

        assert existing.expires_at > utcnow()
        assert out["expires_at"] == existing.expires_at
        existing.save.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_the_live_lookup_excludes_lapsed_grants(self):
        from src.past_submissions import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.past_submissions.service.PastSubmissionOverride.find", find):
            await service.reopened_project_ids(_EMP, 2026, 8)

        assert "$gt" in find.call_args.args[0]["expires_at"]

    @pytest.mark.asyncio
    async def test_the_listing_excludes_lapsed_grants(self):
        """A lapsed grant beside a live one would read as "still open"."""
        from contextlib import ExitStack

        from src.past_submissions import service

        find = MagicMock(return_value=make_query_mock([]))
        with ExitStack() as stack:
            for p in patched():
                stack.enter_context(p)
            stack.enter_context(
                patch("src.past_submissions.service.PastSubmissionOverride.find", find))
            await service.list_overrides(_EMP, mgr())

        assert "$gt" in find.call_args.args[0]["expires_at"]


class TestWhatItUnlocks:
    async def reopened(self, docs):
        from src.past_submissions import service

        with patch("src.past_submissions.service.PastSubmissionOverride.find",
                   MagicMock(return_value=make_query_mock(docs))):
            return await service.reopened_project_ids(_EMP, 2026, 8)

    @pytest.mark.asyncio
    async def test_nothing_reopened_reads_as_none(self):
        assert await self.reopened([]) is None

    @pytest.mark.asyncio
    async def test_only_the_granters_projects_are_unlocked(self):
        out = await self.reopened([MagicMock(project_ids=[_P1])])

        assert str(_P1) in out
        assert str(_P2) not in out

    @pytest.mark.asyncio
    async def test_two_managers_grants_are_unioned(self):
        """Each opened their own projects; the employee may refile both."""
        out = await self.reopened([MagicMock(project_ids=[_P1]), MagicMock(project_ids=[_P2])])

        assert {str(_P1), str(_P2)} <= out

    @pytest.mark.asyncio
    async def test_an_admin_grant_covers_everything(self):
        out = await self.reopened([MagicMock(project_ids=[])])

        assert "any-project-at-all" in out


class TestItIsOneEmployeeOnly:
    """Reopening for one person must not open the month for their colleagues.

    The grant is keyed to the employee, and the cutoff check looks it up by the
    *timesheet's own owner* — so a colleague on the very same project, in the very
    same month, is still blocked.
    """

    @pytest.mark.asyncio
    async def test_the_cutoff_asks_about_the_timesheets_owner(self):
        from src.timesheets import service

        doc = MagicMock()
        doc.id = PydanticObjectId("507f1f77bcf86cd799439031")
        doc.user_id = PydanticObjectId(_EMP)
        doc.week_start_date = datetime(2026, 8, 3)
        doc.week_end_date = datetime(2026, 8, 9)

        lookup = AsyncMock(return_value=None)
        with patch("src.past_submissions.service.reopened_project_ids", lookup), \
             patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([
                       MagicMock(project_id=_P1, entry_date=datetime(2026, 8, 3), hours=8.0),
                   ]))), \
             patch("src.timesheets.service.Project.find",
                   MagicMock(return_value=make_query_mock([]))):
            with pytest.raises(PastSubmissionLocked):
                await service._assert_period_open(
                    doc,
                    make_settings(past_submission_cutoff_enabled=True,
                                  past_submission_cutoff_day=25),
                    datetime(2026, 9, 26, tzinfo=timezone.utc),
                )

        assert lookup.await_args.args[0] == PydanticObjectId(_EMP)

    @pytest.mark.asyncio
    async def test_a_colleagues_grant_does_not_match(self):
        """The query is filtered by user id, so another employee's row is invisible."""
        from src.past_submissions import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.past_submissions.service.PastSubmissionOverride.find", find):
            await service.reopened_project_ids(PydanticObjectId(_EMP), 2026, 8)

        assert find.call_args.args[0]["user_id"] == PydanticObjectId(_EMP)


class TestClosing:
    @pytest.mark.asyncio
    async def test_it_removes_only_the_callers_own_grant(self):
        """Closing yours must not revoke another manager's."""
        from contextlib import ExitStack

        from src.past_submissions import service

        find_one = AsyncMock(return_value=None)
        with ExitStack() as stack:
            for p in patched():
                stack.enter_context(p)
            stack.enter_context(
                patch("src.past_submissions.service.PastSubmissionOverride.find_one", find_one))
            await service.close_month(_EMP, 2026, 8, mgr())

        assert find_one.await_args.args[0]["created_by"] == _MGR
