"""Oversight of the reporting line, as a separate read-only view.

A senior manager holds no assignment and no headship on their reports' projects, so
those timesheets are invisible in the normal Team Timesheets list. `scope=reporting`
opens the projects headed by their direct L1/L2 reports.

Deliberately a second view rather than a widening of the first: seeing a team is not
the same right as approving its work, and merging them would have quietly granted
the second along with the first.
"""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from .conftest import make_query_mock, make_user

_MGR = "senior1"
_HEAD = PydanticObjectId("507f1f77bcf86cd7994390b1")
_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_P2 = PydanticObjectId("507f1f77bcf86cd799439012")


def make_project(pid=_P1, heads=(_HEAD,)):
    p = MagicMock()
    p.id = pid
    p.project_head_ids = list(heads)
    return p


def make_ra(user_id, project_id=_P1):
    a = MagicMock()
    a.user_id = user_id
    a.project_id = project_id
    a.task_id = None
    return a


async def reporting_scope(reportees, projects, assignments, *, hidden=()):
    from src.approvals import service

    with patch("src.approvals.service.fetch_reportee_user_ids",
               AsyncMock(return_value=list(reportees))), \
         patch("src.approvals.service.Project.find",
               MagicMock(return_value=make_query_mock(projects))), \
         patch("src.approvals.service.ResourceAssignment.find",
               MagicMock(return_value=make_query_mock(assignments))), \
         patch("src.approvals.service.hidden_project_ids",
               AsyncMock(return_value=list(hidden))), \
         patch("src.approvals.service._filter_users_to_login_scope",
               AsyncMock(side_effect=lambda _u, ids: ids)):
        return await service._reporting_line_scope(make_user(id=_MGR))


class TestReportingLineScope:
    @pytest.mark.asyncio
    async def test_it_opens_projects_headed_by_a_report(self):
        team, projects = await reporting_scope(
            [_HEAD], [make_project()], [make_ra("emp1"), make_ra("emp2")],
        )

        assert set(team) == {"emp1", "emp2"}
        assert projects == {str(_P1)}

    @pytest.mark.asyncio
    async def test_nobody_reporting_to_you_means_nothing_to_see(self):
        assert await reporting_scope([], [make_project()], [make_ra("emp1")]) == ([], set())

    @pytest.mark.asyncio
    async def test_a_report_who_heads_nothing_yields_nothing(self):
        assert await reporting_scope([_HEAD], [], [make_ra("emp1")]) == ([], set())

    @pytest.mark.asyncio
    async def test_the_project_query_asks_for_the_reportees_headships(self):
        from src.approvals import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.approvals.service.fetch_reportee_user_ids",
                   AsyncMock(return_value=[_HEAD])), \
             patch("src.approvals.service.Project.find", find):
            await service._reporting_line_scope(make_user(id=_MGR))

        assert find.call_args.args[0]["project_head_ids"] == {"$in": [_HEAD]}

    @pytest.mark.asyncio
    async def test_business_unit_hidden_projects_are_dropped(self):
        """The reporting line does not override department scoping."""
        team, projects = await reporting_scope(
            [_HEAD], [make_project()], [make_ra("emp1")], hidden=[_P1],
        )

        assert (team, projects) == ([], set())

    @pytest.mark.asyncio
    async def test_the_viewer_is_not_their_own_reportee(self):
        from src.approvals import service

        ra_find = MagicMock(return_value=make_query_mock([]))
        with patch("src.approvals.service.fetch_reportee_user_ids",
                   AsyncMock(return_value=[_HEAD])), \
             patch("src.approvals.service.Project.find",
                   MagicMock(return_value=make_query_mock([make_project()]))), \
             patch("src.approvals.service.ResourceAssignment.find", ra_find), \
             patch("src.approvals.service.hidden_project_ids", AsyncMock(return_value=[])), \
             patch("src.approvals.service._filter_users_to_login_scope",
                   AsyncMock(side_effect=lambda _u, ids: ids)):
            await service._reporting_line_scope(make_user(id=_MGR))

        assert ra_find.call_args.args[0]["user_id"] == {"$ne": _MGR}


class TestListScopeSwitch:
    async def run(self, scope):
        from src.approvals import service

        p = MagicMock(page=1, page_size=20)
        own = AsyncMock(return_value=[])
        reporting = AsyncMock(return_value=([], set()))
        with patch("src.approvals.service._get_team_user_ids", own), \
             patch("src.approvals.service._reporting_line_scope", reporting):
            page = await service.list_team_timesheets(make_user(), p, scope=scope)
        return page, own, reporting

    @pytest.mark.asyncio
    async def test_own_is_the_default_path(self):
        page, own, reporting = await self.run("own")

        own.assert_awaited_once()
        reporting.assert_not_awaited()
        assert page["read_only"] is False

    @pytest.mark.asyncio
    async def test_reporting_uses_the_reporting_line_and_is_read_only(self):
        page, own, reporting = await self.run("reporting")

        reporting.assert_awaited_once()
        own.assert_not_awaited()
        assert page["read_only"] is True

    @pytest.mark.asyncio
    async def test_read_only_is_reported_even_on_an_empty_page(self):
        """The UI decides whether to render action buttons before it sees any rows."""
        page, _, _ = await self.run("reporting")

        assert page == {"items": [], "total": 0, "page": 1, "page_size": 20,
                        "read_only": True}


class TestNoMissingWeeksInReportingView:
    """An unfiled week is something to chase, and chasing it belongs to the manager
    who can act on it — so the reporting view lists filed weeks only.
    """

    async def run(self, scope):
        from src.approvals import service

        p = MagicMock(page=1, page_size=20)
        missing = AsyncMock(return_value=[])
        with patch("src.approvals.service._get_team_user_ids",
                   AsyncMock(return_value=["emp1"])), \
             patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=(["emp1"], {str(_P1)}))), \
             patch("src.approvals.service.resolve_user_names",
                   AsyncMock(return_value={"emp1": "Gopal"})), \
             patch("src.approvals.service.resolve_emp_codes", AsyncMock(return_value={})), \
             patch("src.approvals.service.WeeklyTimesheet.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service._get_manager_visible_scope",
                   AsyncMock(return_value=({str(_P1)}, {}))), \
             patch("src.approvals.service._scoped_tpa_statuses_by_week",
                   AsyncMock(return_value={})), \
             patch("src.approvals.service._missing_weeks", missing), \
             patch("src.approvals.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))):
            await service.list_team_timesheets(make_user(), p, scope=scope)
        return missing

    @pytest.mark.asyncio
    async def test_the_reporting_view_never_fills_gaps(self):
        assert (await self.run("reporting")).await_count == 0

    @pytest.mark.asyncio
    async def test_the_own_view_still_does(self):
        assert (await self.run("own")).await_count == 1


class TestWeekDetail:
    """Opening a row from the reporting list must render, not come back empty."""

    async def detail(self, *, approver_projects, reporting_projects):
        from src.approvals import service

        doc = MagicMock()
        doc.id = PydanticObjectId("507f1f77bcf86cd799439031")
        doc.user_id = "emp1"
        doc.organisation_id = "org1"
        doc.submitted_at = None
        doc.notes = None
        doc.timesheet_status = MagicMock(value="submitted")
        doc.week_start_date = datetime(2026, 8, 17)
        doc.week_end_date = datetime(2026, 8, 23)

        entry = MagicMock()
        entry.project_id = _P1
        entry.task_id = PydanticObjectId("507f1f77bcf86cd7994390a1")
        entry.entry_date = datetime(2026, 8, 17)
        entry.hours = 8.0

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=doc)), \
             patch("src.approvals.service._assert_employee_in_login_scope", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([entry]))), \
             patch("src.approvals.service._get_manager_visible_scope",
                   AsyncMock(return_value=(approver_projects, {}))), \
             patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=([], reporting_projects))), \
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
                   AsyncMock(return_value=([], []))):
            return await service.get_timesheet_detail("507f1f77bcf86cd799439031",
                                                      make_user(id=_MGR))

    @pytest.mark.asyncio
    async def test_a_watcher_sees_the_entries_read_only(self):
        out = await self.detail(approver_projects=set(), reporting_projects={str(_P1)})

        assert out["read_only"] is True
        assert len(out["entries"]) == 1

    @pytest.mark.asyncio
    async def test_an_approver_keeps_their_own_view(self):
        """The two scopes can overlap; the one carrying actions has to win."""
        out = await self.detail(approver_projects={str(_P1)}, reporting_projects={str(_P1)})

        assert out["read_only"] is False
        assert len(out["entries"]) == 1

    @pytest.mark.asyncio
    async def test_a_stranger_sees_nothing_and_cannot_act(self):
        """`read_only` says "you cannot act here" — no claim at all counts too."""
        out = await self.detail(approver_projects=set(), reporting_projects=set())

        assert out["read_only"] is True
        assert out["entries"] == []


class TestPerWeekReadOnly:
    """The tab strip needs a flag per week, because a week can differ from its
    neighbours: consecutive weeks routinely touch different projects, and a viewer
    can approve one project while only watching another.
    """

    async def weeks(self, week_projects, approver_projects, *, team=("emp1",)):
        from src.approvals import service

        items, entries = [], []
        for i, pid in enumerate(week_projects):
            ts = MagicMock()
            ts.id = PydanticObjectId(f"507f1f77bcf86cd7994390{i:02d}")
            ts.user_id = "emp1"
            ts.week_start_date = datetime(2026, 8, 3 + 7 * i)
            ts.week_end_date = datetime(2026, 8, 9 + 7 * i)
            ts.timesheet_status = MagicMock(value="submitted")
            ts.total_hours = 40.0
            ts.submitted_at = None
            items.append(ts)
            e = MagicMock()
            e.weekly_timesheet_id = ts.id
            e.project_id = pid
            e.task_id = PydanticObjectId("507f1f77bcf86cd7994390a1")
            e.hours = 40.0
            entries.append(e)

        p = MagicMock(page=1, page_size=20)
        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=list(team))), \
             patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=(["emp1"], {str(_P2)}))), \
             patch("src.approvals.service.WeeklyTimesheet.find",
                   MagicMock(return_value=make_query_mock(items, count=len(items)))), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={})), \
             patch("src.approvals.service._get_manager_visible_scope",
                   AsyncMock(return_value=(approver_projects, {}))), \
             patch("src.approvals.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock(entries))):
            page = await service.list_employee_timesheets("emp1", make_user(id=_MGR), p)
        return [i["read_only"] for i in page["items"]]

    @pytest.mark.asyncio
    async def test_weeks_in_the_same_strip_can_differ(self):
        """The reason this cannot be one flag on the month."""
        flags = await self.weeks([_P1, _P2], approver_projects={str(_P1)})

        assert flags == [False, True]

    @pytest.mark.asyncio
    async def test_a_week_you_approve_is_actionable(self):
        assert await self.weeks([_P1], approver_projects={str(_P1)}) == [False]

    @pytest.mark.asyncio
    async def test_a_week_you_only_watch_is_not(self):
        assert await self.weeks([_P2], approver_projects={str(_P1)}) == [True]

    @pytest.mark.asyncio
    async def test_a_week_you_have_no_claim_on_is_not_either(self):
        """Different reason, same answer: do not offer the buttons."""
        other = PydanticObjectId("507f1f77bcf86cd7994390ff")
        assert await self.weeks([other], approver_projects={str(_P1)}) == [True]

    @pytest.mark.asyncio
    async def test_a_watched_employee_can_open_the_strip_at_all(self):
        """Previously a 404 — the tab strip could not load from the reporting list."""
        flags = await self.weeks([_P2], approver_projects=set(), team=())

        assert flags == [True]

    @pytest.mark.asyncio
    async def test_an_unrelated_employee_is_still_hidden(self):
        from src.exceptions import TimesheetNotFound
        from src.approvals import service

        p = MagicMock(page=1, page_size=20)
        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=[])), \
             patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=([], set()))):
            with pytest.raises(TimesheetNotFound):
                await service.list_employee_timesheets("emp1", make_user(id=_MGR), p)


class TestMonthDetail:
    async def monthly(self, *, team, watched):
        from src.approvals import service

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=team)), \
             patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=(watched, {str(_P1)}))), \
             patch("src.approvals.service.WeeklyTimesheet.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service._get_manager_visible_scope",
                   AsyncMock(return_value=({str(_P1)}, {}))), \
             patch("src.approvals.service._scoped_tpa_statuses_by_week",
                   AsyncMock(return_value={})), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={})), \
             patch("src.approvals.service.resolve_emp_codes", AsyncMock(return_value={})):
            return await service.get_monthly_timesheet_detail(
                "emp1", make_user(id=_MGR), month=8, year=2026,
            )

    @pytest.mark.asyncio
    async def test_a_watched_employee_opens_read_only(self):
        """The month row's download icons go through here — a 404 would break them."""
        out = await self.monthly(team=[], watched=["emp1"])

        assert out["read_only"] is True

    @pytest.mark.asyncio
    async def test_an_approvers_own_employee_is_not_read_only(self):
        out = await self.monthly(team=["emp1"], watched=[])

        assert out["read_only"] is False

    @pytest.mark.asyncio
    async def test_an_unrelated_employee_is_still_hidden(self):
        from src.exceptions import TimesheetNotFound

        with pytest.raises(TimesheetNotFound):
            await self.monthly(team=[], watched=[])


class TestReadOnlyIsEnforcedNotJustAdvertised:
    @pytest.mark.asyncio
    async def test_approving_a_reporting_line_timesheet_is_refused(self):
        """`read_only` is a UI hint. The real guarantee is that approval resolves the
        actor's own approver scope, which the reporting line never enters — so a
        crafted POST is refused the same way the hidden button would have been.
        """
        from src.approvals import service
        from src.exceptions import TimesheetNotApprovable
        from src.approvals.schemas import ApprovalAction

        doc = MagicMock(id=PydanticObjectId("507f1f77bcf86cd799439031"), user_id="emp1")
        tpa = MagicMock(project_id=_P2, status=MagicMock(value="submitted"))

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=doc)), \
             patch("src.approvals.service._assert_employee_in_login_scope", AsyncMock()), \
             patch("src.approvals.service._get_manager_visible_scope",
                   AsyncMock(return_value=(set(), {}))), \
             patch("src.approvals.service.TimesheetProjectApproval.find",
                   MagicMock(return_value=make_query_mock([tpa]))):
            with pytest.raises(TimesheetNotApprovable):
                await service.approve_timesheet(
                    "507f1f77bcf86cd799439031", ApprovalAction(comments=None),
                    make_user(id=_MGR), role="manager",
                )

    @pytest.mark.asyncio
    async def test_the_reporting_view_never_touches_approver_scope(self):
        """If it did, watching a team would start conferring the right to approve it."""
        from src.approvals import service

        p = MagicMock(page=1, page_size=20)
        approver_scope = AsyncMock(return_value=({str(_P1)}, {}))
        with patch("src.approvals.service._reporting_line_scope",
                   AsyncMock(return_value=([], set()))), \
             patch("src.approvals.service._get_manager_visible_scope", approver_scope):
            await service.list_team_timesheets(make_user(), p, scope="reporting")

        approver_scope.assert_not_awaited()
