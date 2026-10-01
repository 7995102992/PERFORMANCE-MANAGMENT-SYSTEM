"""Unit tests for src/approvals/service.py"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from src.exceptions import TimesheetNotApprovable, TimesheetNotFound
from src.models import ApprovalActionEnum, ApproverRoleEnum, TimesheetStatusEnum
from src.approvals import service as approvals_service
from src.approvals.schemas import ApprovalAction, BulkApprovalAction, BulkRejectionAction, RejectionAction
from src.common.pagination import PageParams

from .conftest import make_query_mock, make_timesheet, make_user


def _make_approval_record(**kwargs):
    defaults = dict(
        id="ar1",
        organisation_id="org1",
        weekly_timesheet_id="ts1",
        approver_id="mgr1",
        approver_role=ApproverRoleEnum.MANAGER,
        approval_level=1,
        action=ApprovalActionEnum.APPROVED,
        comments=None,
        acted_at=datetime.now(timezone.utc),
    )
    defaults.update(kwargs)
    rec = MagicMock()
    rec.insert = AsyncMock()
    for k, v in defaults.items():
        setattr(rec, k, v)
    return rec


# ---------------------------------------------------------------------------
# approve_timesheet — L1 manager
# ---------------------------------------------------------------------------

class TestApproveTimesheetL1:
    @pytest.mark.asyncio
    async def test_l1_approve_moves_to_l1_approved(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        settings = MagicMock(approval_required=True)
        record = _make_approval_record()
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetSettings.find_one", AsyncMock(return_value=settings)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.approve_timesheet("ts1", body, user, role="manager")

        assert ts.timesheet_status == TimesheetStatusEnum.L1_APPROVED
        assert ts.save.called

    @pytest.mark.asyncio
    async def test_l1_approve_skips_l2_when_not_required(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        settings = MagicMock(approval_required=False)
        record = _make_approval_record()
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetSettings.find_one", AsyncMock(return_value=settings)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.approve_timesheet("ts1", body, user, role="manager")

        assert ts.timesheet_status == TimesheetStatusEnum.CLIENT_APPROVED

    @pytest.mark.asyncio
    async def test_approve_resubmitted_timesheet(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.RESUBMITTED)
        settings = MagicMock(approval_required=True)
        record = _make_approval_record()
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetSettings.find_one", AsyncMock(return_value=settings)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.approve_timesheet("ts1", body, user, role="manager")

        assert ts.timesheet_status == TimesheetStatusEnum.L1_APPROVED

    @pytest.mark.asyncio
    async def test_draft_cannot_be_approved(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT)
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)):
            with pytest.raises(TimesheetNotApprovable):
                await approvals_service.approve_timesheet("ts1", body, user, role="manager")

    @pytest.mark.asyncio
    async def test_no_settings_defaults_to_client_approval_required(self):
        """When settings doc is None, approval_required defaults to True so status stays L1_APPROVED."""
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        record = _make_approval_record()
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetSettings.find_one", AsyncMock(return_value=None)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.approve_timesheet("ts1", body, user, role="manager")

        assert ts.timesheet_status == TimesheetStatusEnum.L1_APPROVED

    @pytest.mark.asyncio
    async def test_approve_with_comment(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        settings = MagicMock(approval_required=True)
        record = _make_approval_record()
        body = ApprovalAction(comments="Looks good")

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetSettings.find_one", AsyncMock(return_value=settings)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            result = await approvals_service.approve_timesheet("ts1", body, user, role="manager")

        assert result is not None


# ---------------------------------------------------------------------------
# approve_timesheet — L2 client
# ---------------------------------------------------------------------------

class TestApproveTimesheetL2:
    @pytest.mark.asyncio
    async def test_client_approve_moves_to_client_approved(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED)
        record = _make_approval_record(approver_role=ApproverRoleEnum.CLIENT)
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.approve_timesheet("ts1", body, user, role="client")

        assert ts.timesheet_status == TimesheetStatusEnum.CLIENT_APPROVED

    @pytest.mark.asyncio
    async def test_client_cannot_approve_non_l1_approved(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        body = ApprovalAction()

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)):
            with pytest.raises(TimesheetNotApprovable):
                await approvals_service.approve_timesheet("ts1", body, user, role="client")


# ---------------------------------------------------------------------------
# reject_timesheet
# ---------------------------------------------------------------------------

class TestRejectTimesheet:
    @pytest.mark.asyncio
    async def test_rejection_action_requires_comment(self):
        """RejectionAction Pydantic model enforces min_length=1."""
        with pytest.raises(ValidationError):
            RejectionAction(comments="")

    @pytest.mark.asyncio
    async def test_l1_reject_moves_to_l1_rejected(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        record = _make_approval_record(action=ApprovalActionEnum.REJECTED)
        body = RejectionAction(comments="Missing details")

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_rejected", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.reject_timesheet("ts1", body, user, role="manager")

        assert ts.timesheet_status == TimesheetStatusEnum.L1_REJECTED
        assert ts.save.called

    @pytest.mark.asyncio
    async def test_l1_reject_resubmitted_timesheet(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.RESUBMITTED)
        record = _make_approval_record(action=ApprovalActionEnum.REJECTED)
        body = RejectionAction(comments="Still not good enough")

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_rejected", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.reject_timesheet("ts1", body, user, role="manager")

        assert ts.timesheet_status == TimesheetStatusEnum.L1_REJECTED

    @pytest.mark.asyncio
    async def test_client_reject_moves_to_client_rejected(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED)
        record = _make_approval_record(action=ApprovalActionEnum.REJECTED, approver_role=ApproverRoleEnum.CLIENT)
        body = RejectionAction(comments="Wrong project code")

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_rejected", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await approvals_service.reject_timesheet("ts1", body, user, role="client")

        assert ts.timesheet_status == TimesheetStatusEnum.CLIENT_REJECTED

    @pytest.mark.asyncio
    async def test_manager_cannot_reject_draft(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT)
        body = RejectionAction(comments="Invalid state")

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)):
            with pytest.raises(TimesheetNotApprovable):
                await approvals_service.reject_timesheet("ts1", body, user, role="manager")


# ---------------------------------------------------------------------------
# bulk_approve / bulk_reject
# ---------------------------------------------------------------------------

class TestBulkOperations:
    @pytest.mark.asyncio
    async def test_bulk_approve_calls_approve_for_each(self):
        user = make_user()
        ts1 = make_timesheet(id="ts1", timesheet_status=TimesheetStatusEnum.SUBMITTED)
        ts2 = make_timesheet(id="ts2", timesheet_status=TimesheetStatusEnum.SUBMITTED)
        settings = MagicMock(approval_required=True)
        record = _make_approval_record()
        body = BulkApprovalAction(timesheet_ids=["ts1", "ts2"])

        with patch("src.approvals.service._load_for_approval", AsyncMock(side_effect=[ts1, ts2])), \
             patch("src.approvals.service.TimesheetSettings.find_one", AsyncMock(return_value=settings)), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_approved", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            results = await approvals_service.bulk_approve(body, user, role="manager")

        assert len(results) == 2
        assert ts1.timesheet_status == TimesheetStatusEnum.L1_APPROVED
        assert ts2.timesheet_status == TimesheetStatusEnum.L1_APPROVED

    @pytest.mark.asyncio
    async def test_bulk_reject_requires_non_empty_comment(self):
        with pytest.raises(ValidationError):
            BulkRejectionAction(timesheet_ids=["ts1"], comments="")

    @pytest.mark.asyncio
    async def test_bulk_reject_success(self):
        user = make_user()
        ts1 = make_timesheet(id="ts1", timesheet_status=TimesheetStatusEnum.SUBMITTED)
        ts2 = make_timesheet(id="ts2", timesheet_status=TimesheetStatusEnum.SUBMITTED)
        record = _make_approval_record(action=ApprovalActionEnum.REJECTED)
        body = BulkRejectionAction(timesheet_ids=["ts1", "ts2"], comments="Not enough detail")

        with patch("src.approvals.service._load_for_approval", AsyncMock(side_effect=[ts1, ts2])), \
             patch("src.approvals.service.ApprovalRecord", return_value=record), \
             patch("src.approvals.service.emit_activity", AsyncMock()), \
             patch("src.approvals.service.notify_timesheet_rejected", AsyncMock()), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=make_query_mock([])):
            results = await approvals_service.bulk_reject(body, user, role="manager")

        assert len(results) == 2
        assert ts1.timesheet_status == TimesheetStatusEnum.L1_REJECTED
        assert ts2.timesheet_status == TimesheetStatusEnum.L1_REJECTED


# ---------------------------------------------------------------------------
# get_dashboard
# ---------------------------------------------------------------------------

class TestGetDashboard:
    @pytest.mark.asyncio
    async def test_no_team_returns_zeros(self):
        user = make_user()
        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=[])):
            result = await approvals_service.get_dashboard(user)

        assert result["total"] == 0
        assert result["submitted"] == 0

    @pytest.mark.asyncio
    async def test_counts_by_status(self):
        user = make_user()
        ts_submitted = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        ts_approved = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED)
        ts_draft = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT)

        q = MagicMock()
        q.to_list = AsyncMock(return_value=[ts_submitted, ts_approved, ts_draft])

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u2", "u3"])), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=q):
            result = await approvals_service.get_dashboard(user)

        assert result["total"] == 3
        assert result["submitted"] == 1
        assert result["l1_approved"] == 1
        assert result["not_submitted"] == 1

    @pytest.mark.asyncio
    async def test_with_month_year_filter(self):
        user = make_user()
        q = MagicMock()
        q.to_list = AsyncMock(return_value=[])

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u2"])), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=q):
            result = await approvals_service.get_dashboard(user, month=5, year=2026)

        assert result["total"] == 0


# ---------------------------------------------------------------------------
# list_team_timesheets
# ---------------------------------------------------------------------------

class TestListTeamTimesheets:
    @pytest.mark.asyncio
    async def test_empty_team(self):
        user = make_user()
        p = PageParams(page=1, page_size=25)

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=[])), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={})), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=make_query_mock([], count=0)):
            result = await approvals_service.list_team_timesheets(user, p)

        assert result["items"] == []
        assert result["total"] == 0

    @pytest.mark.asyncio
    async def test_returns_paginated_items(self):
        user = make_user()
        p = PageParams(page=1, page_size=25)
        ts1 = make_timesheet(user_id="u2")
        ts2 = make_timesheet(id="ts2", user_id="u3")

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u2", "u3"])), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"u2": "Alice", "u3": "Bob"})), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=make_query_mock([ts1, ts2], count=2)):
            result = await approvals_service.list_team_timesheets(user, p)

        assert result["total"] == 2
        assert len(result["items"]) == 2

    @pytest.mark.asyncio
    async def test_filter_by_user_id(self):
        user = make_user()
        p = PageParams(page=1, page_size=25)
        ts1 = make_timesheet(user_id="u2")

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u2", "u3"])), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"u2": "Alice"})), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=make_query_mock([ts1], count=1)):
            result = await approvals_service.list_team_timesheets(user, p, user_id="u2")

        assert result["total"] == 1


# ---------------------------------------------------------------------------
# get_timesheet_detail
# ---------------------------------------------------------------------------

class TestGetTimesheetDetail:
    @pytest.mark.asyncio
    async def test_returns_detail_with_timeline(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED, submitted_at=datetime.now(timezone.utc))

        entry = MagicMock()
        entry.project_id = "p1"
        entry.task_id = "t1"
        entry.entry_date = datetime(2026, 5, 4, tzinfo=timezone.utc)  # Monday
        entry.hours = 8.0
        entry.id = "e1"
        entry.weekly_timesheet_id = "ts1"
        entry.notes = None
        entry.is_billable = True
        entry.created_on = datetime(2026, 5, 4, tzinfo=timezone.utc)
        entry.modified_on = datetime(2026, 5, 4, tzinfo=timezone.utc)

        entries_query = MagicMock()
        entries_query.sort = MagicMock(return_value=entries_query)
        entries_query.to_list = AsyncMock(return_value=[entry])

        ar_query = MagicMock()
        ar_query.sort = MagicMock(return_value=ar_query)
        ar_query.to_list = AsyncMock(return_value=[])

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entries_query), \
             patch("src.approvals.service.ApprovalRecord.find", return_value=ar_query), \
             patch("src.approvals.service.Project.find", return_value=make_query_mock([])), \
             patch("src.approvals.service.Task.find", return_value=make_query_mock([])), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={})):
            result = await approvals_service.get_timesheet_detail("ts1", user)

        assert "weekly_timeline" in result
        assert len(result["weekly_timeline"]) == 1
        assert result["weekly_timeline"][0]["mon"] == 8.0

    @pytest.mark.asyncio
    async def test_approval_history_includes_submission(self):
        user = make_user()
        submitted_at = datetime(2026, 5, 9, tzinfo=timezone.utc)
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED, submitted_at=submitted_at)

        entries_query = MagicMock()
        entries_query.sort = MagicMock(return_value=entries_query)
        entries_query.to_list = AsyncMock(return_value=[])

        ar_query = MagicMock()
        ar_query.sort = MagicMock(return_value=ar_query)
        ar_query.to_list = AsyncMock(return_value=[])

        with patch("src.approvals.service._load_for_approval", AsyncMock(return_value=ts)), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entries_query), \
             patch("src.approvals.service.ApprovalRecord.find", return_value=ar_query), \
             patch("src.approvals.service.Project.find", return_value=make_query_mock([])), \
             patch("src.approvals.service.Task.find", return_value=make_query_mock([])), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={})):
            result = await approvals_service.get_timesheet_detail("ts1", user)

        assert result["approval_history"][0]["action"] == "submitted"
        assert result["approval_history"][0]["acted_at"] == submitted_at


# ---------------------------------------------------------------------------
# get_employee_detail
# ---------------------------------------------------------------------------

class TestGetEmployeeDetail:
    @pytest.mark.asyncio
    async def test_not_in_team_raises_not_found(self):
        user = make_user()
        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u3"])):
            with pytest.raises(TimesheetNotFound):
                await approvals_service.get_employee_detail("u_other", user)

    @pytest.mark.asyncio
    async def test_returns_status_counts(self):
        user = make_user()
        ts1 = make_timesheet(user_id="u2", timesheet_status=TimesheetStatusEnum.SUBMITTED)
        ts2 = make_timesheet(id="ts2", user_id="u2", timesheet_status=TimesheetStatusEnum.L1_APPROVED)
        ts3 = make_timesheet(id="ts3", user_id="u2", timesheet_status=TimesheetStatusEnum.CLIENT_APPROVED)
        ts4 = make_timesheet(id="ts4", user_id="u2", timesheet_status=TimesheetStatusEnum.DRAFT)

        q = MagicMock()
        q.to_list = AsyncMock(return_value=[ts1, ts2, ts3, ts4])

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u2"])), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=q), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"u2": "Alice"})):
            result = await approvals_service.get_employee_detail("u2", user)

        assert result["user_id"] == "u2"
        assert result["user_name"] == "Alice"
        assert result["total_submitted"] == 1
        assert result["approved"] == 1
        assert result["client_approved"] == 1
        assert result["not_submitted"] == 1


# ---------------------------------------------------------------------------
# list_employee_timesheets
# ---------------------------------------------------------------------------

class TestListEmployeeTimesheets:
    @pytest.mark.asyncio
    async def test_not_in_team_raises(self):
        user = make_user()
        p = PageParams()
        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=[])):
            with pytest.raises(TimesheetNotFound):
                await approvals_service.list_employee_timesheets("u2", user, p)

    @pytest.mark.asyncio
    async def test_returns_paginated_items(self):
        user = make_user()
        p = PageParams()
        ts1 = make_timesheet(user_id="u2")

        with patch("src.approvals.service._get_team_user_ids", AsyncMock(return_value=["u2"])), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"u2": "Alice"})), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=make_query_mock([ts1], count=1)):
            result = await approvals_service.list_employee_timesheets("u2", user, p)

        assert result["total"] == 1
        assert len(result["items"]) == 1


# ---------------------------------------------------------------------------
# get_client_dashboard
# ---------------------------------------------------------------------------

class TestGetClientDashboard:
    @pytest.mark.asyncio
    async def test_no_projects_returns_zeros(self):
        user = make_user()
        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=[])):
            result = await approvals_service.get_client_dashboard(user)

        assert result["total"] == 0
        assert result["pending"] == 0

    @pytest.mark.asyncio
    async def test_counts_pending_and_approved(self):
        user = make_user()
        ts_pending = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED)
        ts_approved = make_timesheet(id="ts2", timesheet_status=TimesheetStatusEnum.CLIENT_APPROVED)

        entry = MagicMock()
        entry.weekly_timesheet_id = "ts1"

        entry_q = MagicMock()
        entry_q.to_list = AsyncMock(return_value=[entry])

        ts_q = MagicMock()
        ts_q.to_list = AsyncMock(return_value=[ts_pending, ts_approved])

        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=["p1"])), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entry_q), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=ts_q):
            result = await approvals_service.get_client_dashboard(user)

        assert result["total"] == 2
        assert result["pending"] == 1
        assert result["approved"] == 1


# ---------------------------------------------------------------------------
# list_client_timesheets
# ---------------------------------------------------------------------------

class TestListClientTimesheets:
    @pytest.mark.asyncio
    async def test_no_projects_returns_empty(self):
        user = make_user()
        p = PageParams()
        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=[])):
            result = await approvals_service.list_client_timesheets(user, p)

        assert result["items"] == []
        assert result["total"] == 0

    @pytest.mark.asyncio
    async def test_returns_items_with_project_name(self):
        user = make_user()
        p = PageParams()
        ts1 = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED, user_id="u2")

        entry = MagicMock()
        entry.weekly_timesheet_id = "ts1"
        entry.project_id = "p1"

        entry_q = MagicMock()
        entry_q.to_list = AsyncMock(return_value=[entry])

        proj = MagicMock()
        proj.id = "p1"
        proj.name = "Alpha Project"

        ts_q = MagicMock()
        ts_q.sort = MagicMock(return_value=ts_q)
        ts_q.to_list = AsyncMock(return_value=[ts1])

        proj_q = MagicMock()
        proj_q.to_list = AsyncMock(return_value=[proj])

        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=["p1"])), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entry_q), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=ts_q), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"u2": "Alice"})), \
             patch("src.approvals.service.Project.find", return_value=proj_q):
            result = await approvals_service.list_client_timesheets(user, p)

        assert result["total"] == 1
        assert result["items"][0]["project_name"] == "Alpha Project"


# ---------------------------------------------------------------------------
# export_client_timesheets
# ---------------------------------------------------------------------------

class TestExportClientTimesheets:
    @pytest.mark.asyncio
    async def test_no_projects_returns_empty_list(self):
        user = make_user()
        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=[])):
            result = await approvals_service.export_client_timesheets(user)

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_list_of_summaries(self):
        user = make_user()
        ts1 = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED, user_id="u2")

        entry = MagicMock()
        entry.weekly_timesheet_id = "ts1"
        entry.project_id = "p1"

        entry_q = MagicMock()
        entry_q.to_list = AsyncMock(return_value=[entry])

        proj = MagicMock()
        proj.id = "p1"
        proj.name = "Alpha Project"

        ts_q = MagicMock()
        ts_q.sort = MagicMock(return_value=ts_q)
        ts_q.to_list = AsyncMock(return_value=[ts1])

        proj_q = MagicMock()
        proj_q.to_list = AsyncMock(return_value=[proj])

        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=["p1"])), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entry_q), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=ts_q), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"u2": "Alice"})), \
             patch("src.approvals.service.Project.find", return_value=proj_q):
            result = await approvals_service.export_client_timesheets(user)

        assert len(result) == 1
        assert result[0]["project_name"] == "Alpha Project"


# ---------------------------------------------------------------------------
# get_client_activity_history
# ---------------------------------------------------------------------------

class TestGetClientActivityHistory:
    @pytest.mark.asyncio
    async def test_no_projects_returns_empty_with_summary(self):
        user = make_user()
        p = PageParams()
        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=[])):
            result = await approvals_service.get_client_activity_history(user, p)

        assert result["items"] == []
        assert result["total"] == 0
        assert result["summary"]["total_reviews"] == 0

    @pytest.mark.asyncio
    async def test_returns_activity_records(self):
        user = make_user()
        p = PageParams()
        ts1 = make_timesheet(user_id="u2", timesheet_status=TimesheetStatusEnum.CLIENT_APPROVED)

        entry = MagicMock()
        entry.weekly_timesheet_id = "ts1"
        entry.project_id = "p1"

        entry_q = MagicMock()
        entry_q.to_list = AsyncMock(return_value=[entry])

        ar = MagicMock()
        ar.id = "ar1"
        ar.weekly_timesheet_id = "ts1"
        ar.approver_id = "mgr1"
        ar.approver_role = ApproverRoleEnum.MANAGER
        ar.action = ApprovalActionEnum.APPROVED
        ar.comments = None
        ar.acted_at = datetime(2026, 5, 10, tzinfo=timezone.utc)

        ar_q = MagicMock()
        ar_q.sort = MagicMock(return_value=ar_q)
        ar_q.to_list = AsyncMock(return_value=[ar])

        ts_q = MagicMock()
        ts_q.to_list = AsyncMock(return_value=[ts1])

        proj = MagicMock()
        proj.id = "p1"
        proj.name = "Alpha"

        proj_q = MagicMock()
        proj_q.to_list = AsyncMock(return_value=[proj])

        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=["p1"])), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entry_q), \
             patch("src.approvals.service.ApprovalRecord.find", return_value=ar_q), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=ts_q), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"mgr1": "Manager", "u2": "Employee"})), \
             patch("src.approvals.service.Project.find", return_value=proj_q):
            result = await approvals_service.get_client_activity_history(user, p)

        assert result["total"] == 1
        assert result["items"][0]["action"] == ApprovalActionEnum.APPROVED


# ---------------------------------------------------------------------------
# export_activity_history
# ---------------------------------------------------------------------------

class TestExportActivityHistory:
    @pytest.mark.asyncio
    async def test_no_projects_returns_empty_list(self):
        user = make_user()
        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=[])):
            result = await approvals_service.export_activity_history(user)

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_list_of_approval_records(self):
        user = make_user()
        ts1 = make_timesheet(user_id="u2", total_hours=40.0)

        entry = MagicMock()
        entry.weekly_timesheet_id = "ts1"
        entry.project_id = "p1"

        entry_q = MagicMock()
        entry_q.to_list = AsyncMock(return_value=[entry])

        ar = MagicMock()
        ar.id = "ar1"
        ar.weekly_timesheet_id = "ts1"
        ar.approver_id = "mgr1"
        ar.approver_role = ApproverRoleEnum.MANAGER
        ar.action = ApprovalActionEnum.APPROVED
        ar.comments = None
        ar.acted_at = datetime(2026, 5, 10, tzinfo=timezone.utc)

        ar_q = MagicMock()
        ar_q.sort = MagicMock(return_value=ar_q)
        ar_q.to_list = AsyncMock(return_value=[ar])

        ts_q = MagicMock()
        ts_q.to_list = AsyncMock(return_value=[ts1])

        proj = MagicMock()
        proj.id = "p1"
        proj.name = "Alpha"

        proj_q = MagicMock()
        proj_q.to_list = AsyncMock(return_value=[proj])

        with patch("src.approvals.service._get_client_project_ids", AsyncMock(return_value=["p1"])), \
             patch("src.approvals.service.TimesheetEntry.find", return_value=entry_q), \
             patch("src.approvals.service.ApprovalRecord.find", return_value=ar_q), \
             patch("src.approvals.service.WeeklyTimesheet.find", return_value=ts_q), \
             patch("src.approvals.service.resolve_user_names", AsyncMock(return_value={"mgr1": "Manager", "u2": "Employee"})), \
             patch("src.approvals.service.Project.find", return_value=proj_q):
            result = await approvals_service.export_activity_history(user)

        assert len(result) == 1
        assert result[0]["hours"] == 40.0
