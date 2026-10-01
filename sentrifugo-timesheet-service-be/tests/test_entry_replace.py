"""Tests for replace-on-save and the submit-time assignment check.

Reported scenario: a manager rejects a timesheet, reassigns the employee's task,
the employee refills the week with the new task — and both the old and the new
entries showed up for approval, double-counting the hours.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import EntriesNoLongerAssigned
from src.models import StatusEnum

from .conftest import make_query_mock, make_settings, make_timesheet, make_user

_PROJECT = "507f1f77bcf86cd799439011"
_TASK_OLD = "507f1f77bcf86cd7994390a1"
_TASK_NEW = "507f1f77bcf86cd7994390a2"
_DAY = "2026-08-03"


def make_stored_entry(task_id, day=_DAY, hours=8.0):
    e = MagicMock()
    e.id = f"entry-{task_id}"
    e.project_id = PydanticObjectId(_PROJECT)
    e.task_id = PydanticObjectId(task_id)
    e.entry_date = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    e.hours = hours
    e.deleted_on = None
    e.save = AsyncMock()
    return e


def make_entry_class(stored, existing=None):
    """Stand-in for the TimesheetEntry document class: queries return `stored`,
    constructing one yields an insertable doc."""
    new_entry = MagicMock(id="new-entry")
    new_entry.insert = AsyncMock()
    cls = MagicMock()
    cls.find = MagicMock(return_value=make_query_mock(stored))
    cls.find_one = AsyncMock(return_value=existing)
    cls.return_value = new_entry
    return cls


def make_assignment(task_id=None):
    ra = MagicMock()
    ra.project_id = PydanticObjectId(_PROJECT)
    ra.task_id = PydanticObjectId(task_id) if task_id else None
    ra.status = StatusEnum.ACTIVE
    ra.deleted_on = None
    return ra


class TestSaveEntriesReplacesTheWeek:
    @pytest.mark.asyncio
    async def test_entry_absent_from_payload_is_removed(self):
        from src.timesheets import service
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate

        stale = make_stored_entry(_TASK_OLD)
        kept = make_stored_entry(_TASK_NEW)
        body = TimesheetEntryBulkSave(entries=[TimesheetEntryCreate(
            project_id=_PROJECT, task_id=_TASK_NEW, entry_date=_DAY, hours=8.0,
        )])

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=make_timesheet())), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=None)), \
             patch("src.timesheets.service.hidden_project_ids", AsyncMock(return_value=[])), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.Project.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.TimesheetEntry.find_one", AsyncMock(return_value=kept)), \
             patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([stale, kept]))), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))), \
             patch("src.timesheets.service._ts_to_out", MagicMock(return_value={})), \
             patch("src.timesheets.service._entry_to_out", MagicMock(return_value={})), \
             patch("src.timesheets.service.emit_activity", AsyncMock()):
            await service.save_entries("ts1", body, make_user())

        assert stale.deleted_on is not None      # the swapped-out task is gone
        assert kept.deleted_on is None           # the submitted one survives
        assert kept.hours == 8.0

    @pytest.mark.asyncio
    async def test_daily_cap_ignores_rows_the_save_removes(self):
        """Replacing 8h of task A with 8h of task B is 8h for the day, not 16h."""
        from src.timesheets import service
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate

        stale = make_stored_entry(_TASK_OLD)
        settings = make_settings(
            daily_restrictions_enabled=True,
            max_hours_per_day=8.0,
            deduct_leave_daily=False,
            daily_time_entry_enabled=False,
            allow_future_entries=True,
            allow_past_entries_days=3650,
            restrict_time_off_entries=False,
        )
        body = TimesheetEntryBulkSave(entries=[TimesheetEntryCreate(
            project_id=_PROJECT, task_id=_TASK_NEW, entry_date=_DAY, hours=8.0,
        )])

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=make_timesheet())), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service.hidden_project_ids", AsyncMock(return_value=[])), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.Project.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.TimesheetEntry", make_entry_class(stored=[stale])), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))), \
             patch("src.timesheets.service._ts_to_out", MagicMock(return_value={})), \
             patch("src.timesheets.service._entry_to_out", MagicMock(return_value={})), \
             patch("src.timesheets.service.emit_activity", AsyncMock()):
            # No DailyHoursExceeded: the stale 8h is on its way out.
            await service.save_entries("ts1", body, make_user())

        assert stale.deleted_on is not None


class TestSubmitBlocksUnassignedEntries:
    @pytest.mark.asyncio
    async def test_blocks_when_the_task_was_reassigned_away(self):
        from src.timesheets import service

        doc = make_timesheet()
        orphan = make_stored_entry(_TASK_OLD)
        task_doc = MagicMock(id=PydanticObjectId(_TASK_OLD))
        task_doc.name = "Fight Master"

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([orphan]))), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   MagicMock(return_value=make_query_mock([make_assignment(_TASK_NEW)]))), \
             patch("src.timesheets.service.Task.find", MagicMock(return_value=make_query_mock([task_doc]))):
            with pytest.raises(EntriesNoLongerAssigned) as exc:
                await service._assert_entries_still_assignable(doc, "u1", "org1")

        assert exc.value.code == "TSM-034"
        assert "Fight Master" in exc.value.message
        assert "Aug 03, 2026" in exc.value.message

    @pytest.mark.asyncio
    async def test_project_level_assignment_covers_every_task(self):
        from src.timesheets import service

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([make_stored_entry(_TASK_OLD)]))), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   MagicMock(return_value=make_query_mock([make_assignment(None)]))):
            await service._assert_entries_still_assignable(make_timesheet(), "u1", "org1")

    @pytest.mark.asyncio
    async def test_passes_when_every_entry_is_still_assigned(self):
        from src.timesheets import service

        with patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([make_stored_entry(_TASK_NEW)]))), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   MagicMock(return_value=make_query_mock([make_assignment(_TASK_NEW)]))):
            await service._assert_entries_still_assignable(make_timesheet(), "u1", "org1")
