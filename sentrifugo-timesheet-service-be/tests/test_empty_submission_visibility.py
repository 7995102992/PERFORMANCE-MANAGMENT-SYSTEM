"""A submitted week with nothing logged must still reach an approver.

Approval records are keyed by project and derived from the week's entries, so a
timesheet submitted with no entries produced no records at all — invisible to
every manager while sitting in "submitted". It now falls back to the employee's
live project assignments.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.models import StatusEnum

from .conftest import make_query_mock, make_timesheet

_P1 = "507f1f77bcf86cd799439011"
_P2 = "507f1f77bcf86cd799439012"


def make_entry_doc(project_id):
    return MagicMock(project_id=PydanticObjectId(project_id))


def make_assignment(project_id, task_id=None):
    ra = MagicMock()
    ra.project_id = PydanticObjectId(project_id)
    ra.task_id = PydanticObjectId(task_id) if task_id else None
    ra.status = StatusEnum.ACTIVE
    ra.deleted_on = None
    return ra


class TestSubmissionProjectIds:
    @pytest.mark.asyncio
    async def test_uses_the_projects_of_the_weeks_entries(self):
        from src.timesheets import service

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([make_entry_doc(_P1)]))), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   MagicMock(return_value=make_query_mock([make_assignment(_P2)]))) as ra_find:
            ids = await service._submission_project_ids(make_timesheet())

        assert [str(i) for i in ids] == [_P1]
        ra_find.assert_not_called()  # no need to look at assignments

    @pytest.mark.asyncio
    async def test_falls_back_to_live_assignments_when_the_week_is_empty(self):
        from src.timesheets import service

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   MagicMock(return_value=make_query_mock([
                       make_assignment(_P1), make_assignment(_P1, "507f1f77bcf86cd7994390a1"),
                       make_assignment(_P2),
                   ]))):
            ids = await service._submission_project_ids(make_timesheet())

        # de-duplicated across the employee's project- and task-level rows
        assert {str(i) for i in ids} == {_P1, _P2}

    @pytest.mark.asyncio
    async def test_only_live_assignments_count(self):
        from src.timesheets import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.ResourceAssignment.find", find):
            await service._submission_project_ids(make_timesheet())

        filt = find.call_args.args[0]
        assert filt["deleted_on"] is None
        assert filt["status"] == "active"

    @pytest.mark.asyncio
    async def test_unassigned_employee_yields_no_projects(self):
        from src.timesheets import service

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   MagicMock(return_value=make_query_mock([]))):
            assert await service._submission_project_ids(make_timesheet()) == []
