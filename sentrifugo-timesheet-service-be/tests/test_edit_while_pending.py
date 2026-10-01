"""Editing a submitted timesheet up until the first approval decision.

An employee who left a day at 0 can still correct it while the week is waiting to be
reviewed. The moment any project on that week is approved or rejected the whole
timesheet freezes, and only a rejection reopens it.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import TimesheetNotEditable
from src.models import ProjectApprovalStatusEnum, TimesheetStatusEnum

from .conftest import make_query_mock, make_timesheet

_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_P2 = PydanticObjectId("507f1f77bcf86cd799439012")


def make_tpa(project_id=_P1, status=ProjectApprovalStatusEnum.SUBMITTED):
    tpa = MagicMock()
    tpa.project_id = project_id
    tpa.status = status
    tpa.deleted_on = None
    tpa.save = AsyncMock()
    return tpa


class TestAssertEditable:
    @pytest.mark.asyncio
    async def test_draft_is_editable(self):
        from src.timesheets import service

        await service._assert_editable(make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT))

    @pytest.mark.asyncio
    async def test_rejected_is_editable(self):
        from src.timesheets import service

        await service._assert_editable(
            make_timesheet(timesheet_status=TimesheetStatusEnum.L1_REJECTED)
        )

    @pytest.mark.asyncio
    async def test_submitted_is_editable_while_nobody_has_acted(self):
        from src.timesheets import service

        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        with patch("src.timesheets.service.TimesheetProjectApproval.find",
                   MagicMock(return_value=make_query_mock(count=0))):
            await service._assert_editable(ts)

    @pytest.mark.asyncio
    async def test_submitted_freezes_once_a_project_is_acted_on(self):
        from src.timesheets import service

        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        find = MagicMock(return_value=make_query_mock(count=1))
        with patch("src.timesheets.service.TimesheetProjectApproval.find", find):
            with pytest.raises(TimesheetNotEditable):
                await service._assert_editable(ts)

        acted = find.call_args.args[0]["status"]["$in"]
        assert set(acted) == {"l1_approved", "l1_rejected", "client_approved", "client_rejected"}

    @pytest.mark.asyncio
    async def test_approved_is_never_editable(self):
        from src.timesheets import service

        for status in (TimesheetStatusEnum.L1_APPROVED, TimesheetStatusEnum.CLIENT_APPROVED):
            with pytest.raises(TimesheetNotEditable):
                await service._assert_editable(make_timesheet(timesheet_status=status))


class TestSyncPendingProjectApprovals:
    @pytest.mark.asyncio
    async def test_a_newly_added_project_gets_an_approval_record(self):
        from src.timesheets import service

        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        created = MagicMock()
        created.insert = AsyncMock()
        tpa_cls = MagicMock(return_value=created,
                            find=MagicMock(return_value=make_query_mock([make_tpa(_P1)])))

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([
                       MagicMock(project_id=_P1), MagicMock(project_id=_P2)]))), \
             patch("src.timesheets.service.TimesheetProjectApproval", tpa_cls):
            await service._sync_pending_project_approvals(ts, MagicMock())

        assert tpa_cls.call_args.kwargs["project_id"] == _P2
        assert tpa_cls.call_args.kwargs["status"] == ProjectApprovalStatusEnum.SUBMITTED
        created.insert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_a_project_emptied_out_loses_its_pending_record(self):
        from src.timesheets import service

        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        stale = make_tpa(_P2)
        tpa_cls = MagicMock(find=MagicMock(return_value=make_query_mock([make_tpa(_P1), stale])))

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([MagicMock(project_id=_P1)]))), \
             patch("src.timesheets.service.TimesheetProjectApproval", tpa_cls):
            await service._sync_pending_project_approvals(ts, MagicMock())

        assert stale.deleted_on is not None
        stale.save.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_an_acted_on_record_is_never_touched(self):
        from src.timesheets import service

        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        approved = make_tpa(_P2, status=ProjectApprovalStatusEnum.L1_APPROVED)
        tpa_cls = MagicMock(find=MagicMock(return_value=make_query_mock([approved])))

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.TimesheetProjectApproval", tpa_cls):
            await service._sync_pending_project_approvals(ts, MagicMock())

        assert approved.deleted_on is None
        approved.save.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_resubmitted_week_creates_resubmitted_records(self):
        from src.timesheets import service

        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.RESUBMITTED)
        created = MagicMock()
        created.insert = AsyncMock()
        tpa_cls = MagicMock(return_value=created, find=MagicMock(return_value=make_query_mock([])))

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([MagicMock(project_id=_P1)]))), \
             patch("src.timesheets.service.TimesheetProjectApproval", tpa_cls):
            await service._sync_pending_project_approvals(ts, MagicMock())

        assert tpa_cls.call_args.kwargs["status"] == ProjectApprovalStatusEnum.RESUBMITTED

    @pytest.mark.asyncio
    async def test_draft_needs_no_sync(self):
        from src.timesheets import service

        find = MagicMock()
        with patch("src.timesheets.service.TimesheetEntry.find", find):
            await service._sync_pending_project_approvals(
                make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT), MagicMock(),
            )
        find.assert_not_called()
