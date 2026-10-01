"""Unit tests for src/timesheets/service.py"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.exceptions import (
    AttachmentNotFound,
    AttachmentsNotAllowed,
    DailyHoursExceeded,
    EmployeeNotAssignedToProject,
    FutureDateEntryNotAllowed,
    MinDailyHoursNotMet,
    PastDueTimesheetsBlocked,
    PastSubmissionLocked,
    SubmissionDeadlinePassed,
    TimesheetAlreadyExists,
    TimesheetNotEditable,
    TimesheetNotFound,
    TimesheetNotSubmittable,
    TimeOffEntriesRestricted,
    WeeklyHoursExceeded,
)
from src.models import TimesheetAttachment, TimesheetStatusEnum
from src.timesheets import service
from src.common.pagination import PageParams

from .conftest import make_entry, make_query_mock, make_settings, make_timesheet, make_user


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utcnow():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# _compute_shortage_and_penalty
# ---------------------------------------------------------------------------

class TestComputeShortageAndPenalty:
    def test_no_shortage(self):
        s = make_settings(standard_hours_per_day=8, shortage_penalty_enabled=True, penalty_percentage=10)
        shortage, penalty = service._compute_shortage_and_penalty(40.0, 0.0, s)
        assert shortage == 0.0
        assert penalty == 0.0

    def test_shortage_penalty_disabled(self):
        s = make_settings(standard_hours_per_day=8, shortage_penalty_enabled=False, penalty_percentage=10)
        shortage, penalty = service._compute_shortage_and_penalty(30.0, 0.0, s)
        assert shortage == 10.0
        assert penalty == 0.0

    def test_shortage_penalty_enabled(self):
        s = make_settings(standard_hours_per_day=8, shortage_penalty_enabled=True, penalty_percentage=10)
        shortage, penalty = service._compute_shortage_and_penalty(30.0, 0.0, s)
        assert shortage == 10.0
        assert abs(penalty - 1.0) < 0.001  # 10 * 10% = 1.0

    def test_leave_deduction_eliminates_shortage(self):
        s = make_settings(standard_hours_per_day=8, shortage_penalty_enabled=True, penalty_percentage=10)
        shortage, penalty = service._compute_shortage_and_penalty(30.0, 10.0, s)  # 30 worked + 10 leave = 40
        assert shortage == 0.0
        assert penalty == 0.0

    def test_partial_leave_reduces_shortage(self):
        s = make_settings(standard_hours_per_day=8, shortage_penalty_enabled=True, penalty_percentage=20)
        shortage, penalty = service._compute_shortage_and_penalty(30.0, 5.0, s)  # 35 effective, expect 40
        assert shortage == 5.0
        assert abs(penalty - 1.0) < 0.001  # 5 * 20% = 1.0


# ---------------------------------------------------------------------------
# create_timesheet
# ---------------------------------------------------------------------------

class TestCreateTimesheet:
    @pytest.mark.asyncio
    async def test_non_monday_raises(self):
        user = make_user()
        from src.timesheets.schemas import TimesheetCreate
        body = TimesheetCreate(week_start_date="2026-05-05")  # Tuesday
        with pytest.raises(Exception, match="Monday"):
            await service.create_timesheet(body, user)

    @pytest.mark.asyncio
    async def test_duplicate_raises(self):
        user = make_user()
        from src.timesheets.schemas import TimesheetCreate
        body = TimesheetCreate(week_start_date="2026-05-04")  # Monday
        existing = make_timesheet()
        with patch("src.timesheets.service.WeeklyTimesheet.find_one", AsyncMock(return_value=existing)):
            with pytest.raises(TimesheetAlreadyExists):
                await service.create_timesheet(body, user)

    @pytest.mark.asyncio
    async def test_success(self):
        user = make_user()
        from src.timesheets.schemas import TimesheetCreate
        body = TimesheetCreate(week_start_date="2026-05-04")
        new_ts = make_timesheet()
        MockWT = MagicMock()
        MockWT.find_one = AsyncMock(return_value=None)
        MockWT.return_value = new_ts
        with patch("src.timesheets.service.WeeklyTimesheet", MockWT):
            with patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
                result = await service.create_timesheet(body, user)
        assert result["user_id"] == "u1"


# ---------------------------------------------------------------------------
# save_entries — daily restrictions
# ---------------------------------------------------------------------------

class TestSaveEntriesDailyRestrictions:
    def _make_body(self, entry_date="2026-05-04", hours=8.0):
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate
        return TimesheetEntryBulkSave(entries=[
            TimesheetEntryCreate(project_id="p1", task_id="task1", entry_date=entry_date, hours=hours)
        ])

    @pytest.mark.asyncio
    async def test_exceeds_max_hours_per_day(self):
        user = make_user()
        ts = make_timesheet()
        settings = make_settings(daily_restrictions_enabled=True, max_hours_per_day=8.0)
        body = self._make_body(hours=9.0)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
            with pytest.raises(DailyHoursExceeded):
                await service.save_entries("ts1", body, user)

    @pytest.mark.asyncio
    async def test_within_max_hours_per_day_ok(self):
        user = make_user()
        ts = make_timesheet(total_hours=8.0, billable_hours=8.0, non_billable_hours=0.0)
        settings = make_settings(daily_restrictions_enabled=True, max_hours_per_day=10.0)
        body = self._make_body(hours=8.0)

        entry = make_entry()
        MockTE = MagicMock()
        MockTE.find = MagicMock(return_value=make_query_mock([]))
        MockTE.find_one = AsyncMock(return_value=None)
        MockTE.return_value = entry
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.TimesheetEntry", MockTE), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))):
            result = await service.save_entries("ts1", body, user)
        assert result is not None

    @pytest.mark.asyncio
    async def test_deduct_leave_daily_lowers_effective_total(self):
        """With 4h leave, 9h logged should not exceed 8h cap (effective = 9 - 4 = 5)."""
        user = make_user()
        ts = make_timesheet()
        settings = make_settings(daily_restrictions_enabled=True, max_hours_per_day=8.0, deduct_leave_daily=True)
        body = self._make_body(hours=9.0)

        entry = make_entry()
        MockTE = MagicMock()
        MockTE.find = MagicMock(return_value=make_query_mock([]))
        MockTE.find_one = AsyncMock(return_value=None)
        MockTE.return_value = entry
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={"2026-05-04": 4.0})), \
             patch("src.timesheets.service.TimesheetEntry", MockTE), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(9.0, 9.0, 0.0))):
            result = await service.save_entries("ts1", body, user)
        assert result is not None


# ---------------------------------------------------------------------------
# save_entries — entry date validation
# ---------------------------------------------------------------------------

class TestSaveEntriesDateValidation:
    def _make_body(self, entry_date: str):
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate
        return TimesheetEntryBulkSave(entries=[
            TimesheetEntryCreate(project_id="p1", task_id="task1", entry_date=entry_date, hours=8.0)
        ])

    @pytest.mark.asyncio
    async def test_daily_mode_blocks_future_dates(self):
        user = make_user()
        ts = make_timesheet()
        future = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d")
        settings = make_settings(daily_time_entry_enabled=True, allow_future_entries=True)
        body = self._make_body(future)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)):
            with pytest.raises(FutureDateEntryNotAllowed):
                await service.save_entries("ts1", body, user)

    @pytest.mark.asyncio
    async def test_allow_future_entries_false_blocks_future(self):
        user = make_user()
        ts = make_timesheet()
        future = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d")
        settings = make_settings(daily_time_entry_enabled=False, allow_future_entries=False)
        body = self._make_body(future)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)):
            with pytest.raises(FutureDateEntryNotAllowed):
                await service.save_entries("ts1", body, user)

    @pytest.mark.asyncio
    async def test_allow_future_entries_true_permits_future(self):
        user = make_user()
        ts = make_timesheet()
        future = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d")
        settings = make_settings(daily_time_entry_enabled=False, allow_future_entries=True,
                                  daily_restrictions_enabled=False, restrict_time_off_entries=False)
        body = self._make_body(future)
        entry = make_entry()

        MockTE = MagicMock()
        MockTE.find = MagicMock(return_value=make_query_mock([]))
        MockTE.find_one = AsyncMock(return_value=None)
        MockTE.return_value = entry
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.TimesheetEntry", MockTE), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))):
            result = await service.save_entries("ts1", body, user)
        assert result is not None

    @pytest.mark.asyncio
    async def test_closed_period_blocked(self):
        """The rolling allow_past_entries_days rule is now a monthly payroll cutoff."""
        user = make_user()
        ts = make_timesheet()
        ts.week_start_date = datetime(2026, 5, 4)
        ts.week_end_date = datetime(2026, 5, 10)
        settings = make_settings(allow_future_entries=True, daily_time_entry_enabled=False,
                                  past_submission_cutoff_enabled=True,
                                  past_submission_cutoff_day=25)
        # A real ObjectId: the cutoff check resolves project ids before any save.
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate
        body = TimesheetEntryBulkSave(entries=[TimesheetEntryCreate(
            project_id="507f1f77bcf86cd799439011", task_id="507f1f77bcf86cd7994390a1",
            entry_date="2026-05-04", hours=8.0,
        )])

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service.hidden_project_ids", AsyncMock(return_value=[])), \
             patch("src.timesheets.service.TimesheetEntry.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.PastSubmissionOverride.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.timesheets.service.Project.find",
                   MagicMock(return_value=make_query_mock([]))):
            with pytest.raises(PastSubmissionLocked):
                await service.save_entries("ts1", body, user)

    @pytest.mark.asyncio
    async def test_past_entry_within_limit_allowed(self):
        user = make_user()
        ts = make_timesheet()
        recent = (datetime.now(timezone.utc) - timedelta(days=10)).strftime("%Y-%m-%d")
        settings = make_settings(allow_future_entries=True,                                   daily_time_entry_enabled=False, daily_restrictions_enabled=False,
                                  restrict_time_off_entries=False)
        body = self._make_body(recent)
        entry = make_entry()

        MockTE = MagicMock()
        MockTE.find = MagicMock(return_value=make_query_mock([]))
        MockTE.find_one = AsyncMock(return_value=None)
        MockTE.return_value = entry
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.TimesheetEntry", MockTE), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))):
            result = await service.save_entries("ts1", body, user)
        assert result is not None


# ---------------------------------------------------------------------------
# save_entries — time-off restriction
# ---------------------------------------------------------------------------

_VALID_OID = "507f1f77bcf86cd799439011"  # valid 24-char hex ObjectId for tests


class TestSaveEntriesTimeOffRestriction:
    def _make_body(self):
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate
        return TimesheetEntryBulkSave(entries=[
            TimesheetEntryCreate(project_id=_VALID_OID, task_id=_VALID_OID, entry_date="2026-05-04", hours=8.0)
        ])

    @pytest.mark.asyncio
    async def test_time_off_task_restricted(self):
        user = make_user()
        ts = make_timesheet()
        settings = make_settings(restrict_time_off_entries=True, daily_time_entry_enabled=False,
                                  allow_future_entries=True, )
        body = self._make_body()

        time_off_query = make_query_mock(count=1)
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service.Task.find", return_value=time_off_query):
            with pytest.raises(TimeOffEntriesRestricted):
                await service.save_entries("ts1", body, user)

    @pytest.mark.asyncio
    async def test_regular_task_allowed(self):
        user = make_user()
        ts = make_timesheet()
        settings = make_settings(restrict_time_off_entries=True, daily_time_entry_enabled=False,
                                  allow_future_entries=True,                                   daily_restrictions_enabled=False)
        body = self._make_body()
        entry = make_entry()

        no_time_off_query = make_query_mock(count=0)
        MockTE = MagicMock()
        MockTE.find = MagicMock(return_value=make_query_mock([]))
        MockTE.find_one = AsyncMock(return_value=None)
        MockTE.return_value = entry
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service.Task.find", return_value=no_time_off_query), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.TimesheetEntry", MockTE), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))):
            result = await service.save_entries("ts1", body, user)
        assert result is not None


# ---------------------------------------------------------------------------
# save_entries — not editable
# ---------------------------------------------------------------------------

class TestSaveEntriesEditable:
    @pytest.mark.asyncio
    async def test_submitted_timesheet_not_editable_once_approved(self):
        """Submitted stays editable until an approver acts — see test_edit_while_pending."""
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.TimesheetProjectApproval.find",
                   MagicMock(return_value=make_query_mock(count=1))):
            from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate
            body = TimesheetEntryBulkSave(entries=[
                TimesheetEntryCreate(project_id="p1", task_id="t1", entry_date="2026-05-04", hours=8)
            ])
            with pytest.raises(TimesheetNotEditable):
                await service.save_entries("ts1", body, user)


# ---------------------------------------------------------------------------
# submit_timesheet — weekly hours
# ---------------------------------------------------------------------------

class TestSubmitTimesheetWeeklyHours:
    @pytest.mark.asyncio
    async def test_exceeds_weekly_hours(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT, total_hours=45.0)
        settings = make_settings(weekly_restrictions_enabled=True, max_hours_per_week=40.0)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={})):
            with pytest.raises(WeeklyHoursExceeded):
                await service.submit_timesheet("ts1", user)

    @pytest.mark.asyncio
    async def test_weekly_restrictions_disabled_allows_excess(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT, total_hours=60.0)
        settings = make_settings(weekly_restrictions_enabled=False, shortage_penalty_enabled=False,
                                  submission_deadline_hours=0, allow_past_due_submission=True,
                                  min_hours_per_day=0, submission_compliance_type="weekly")

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={})), \
             patch("src.timesheets.service._validate_submission_rules", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.ResourceAssignment.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.emit_activity", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_submitted", AsyncMock()):
            result = await service.submit_timesheet("ts1", user)
        assert result["timesheet_status"] == TimesheetStatusEnum.SUBMITTED

    @pytest.mark.asyncio
    async def test_deduct_leave_weekly_lowers_effective_total(self):
        """45h worked + 5h leave = 50h effective but settings cap is 50 — should pass."""
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT, total_hours=45.0)
        settings = make_settings(weekly_restrictions_enabled=True, max_hours_per_week=50.0,
                                  deduct_leave_weekly=True, shortage_penalty_enabled=False,
                                  submission_deadline_hours=0, allow_past_due_submission=True,
                                  min_hours_per_day=0, submission_compliance_type="weekly")

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={"2026-05-04": 5.0})), \
             patch("src.timesheets.service._validate_submission_rules", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.ResourceAssignment.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.emit_activity", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_submitted", AsyncMock()):
            result = await service.submit_timesheet("ts1", user)
        assert result["timesheet_status"] == TimesheetStatusEnum.SUBMITTED


# ---------------------------------------------------------------------------
# submit_timesheet — shortage and penalty
# ---------------------------------------------------------------------------

class TestSubmitTimesheetShortageAndPenalty:
    @pytest.mark.asyncio
    async def test_shortage_and_penalty_computed_on_submit(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT, total_hours=30.0)
        settings = make_settings(
            weekly_restrictions_enabled=False,
            standard_hours_per_day=8.0,
            shortage_penalty_enabled=True,
            penalty_percentage=10.0,
            submission_deadline_hours=0,
            allow_past_due_submission=True,
            min_hours_per_day=0,
            submission_compliance_type="weekly",
        )

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={})), \
             patch("src.timesheets.service._validate_submission_rules", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.ResourceAssignment.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.emit_activity", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_submitted", AsyncMock()):
            await service.submit_timesheet("ts1", user)

        assert ts.shortage_hours == 10.0  # 40 - 30 = 10
        assert abs(ts.penalty_hours - 1.0) < 0.001  # 10 * 10% = 1.0

    @pytest.mark.asyncio
    async def test_no_shortage_when_hours_sufficient(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT, total_hours=40.0)
        settings = make_settings(
            weekly_restrictions_enabled=False,
            standard_hours_per_day=8.0,
            shortage_penalty_enabled=True,
            penalty_percentage=10.0,
            submission_deadline_hours=0,
            allow_past_due_submission=True,
            min_hours_per_day=0,
            submission_compliance_type="weekly",
        )

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={})), \
             patch("src.timesheets.service._validate_submission_rules", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.ResourceAssignment.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.emit_activity", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_submitted", AsyncMock()):
            await service.submit_timesheet("ts1", user)

        assert ts.shortage_hours == 0.0
        assert ts.penalty_hours == 0.0


# ---------------------------------------------------------------------------
# submit_timesheet — not submittable
# ---------------------------------------------------------------------------

class TestSubmitTimesheetNotSubmittable:
    @pytest.mark.asyncio
    async def test_already_submitted(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)
        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)):
            with pytest.raises(TimesheetNotSubmittable):
                await service.submit_timesheet("ts1", user)


# ---------------------------------------------------------------------------
# _validate_submission_rules — min daily hours
# ---------------------------------------------------------------------------

class TestValidateSubmissionRulesMinHours:
    @pytest.mark.asyncio
    async def test_min_daily_hours_not_met(self):
        from src.exceptions import MinDailyHoursNotMet
        ts = make_timesheet()
        settings = make_settings(
            daily_restrictions_enabled=True,
            min_hours_per_day=8.0,
            allow_past_due_submission=True,
            submission_deadline_hours=0,
            submission_compliance_type="weekly",
            deduct_leave_daily=False,
        )
        # No entries logged for any day → all days fail
        with patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.WeeklyTimesheet.find", return_value=make_query_mock(count=0)):
            with pytest.raises(MinDailyHoursNotMet):
                await service._validate_submission_rules(ts, settings, "u1", _utcnow())

    @pytest.mark.asyncio
    async def test_leave_counts_toward_min_hours(self):
        ts = make_timesheet()
        settings = make_settings(
            daily_restrictions_enabled=True,
            min_hours_per_day=8.0,
            allow_past_due_submission=True,
            submission_deadline_hours=0,
            submission_compliance_type="weekly",
            deduct_leave_daily=True,
        )
        # Only 4h logged each day but 4h leave → effective 8h → should pass
        entries = [
            make_entry(entry_date=datetime(2026, 5, 4, tzinfo=timezone.utc), hours=4.0),
            make_entry(entry_date=datetime(2026, 5, 5, tzinfo=timezone.utc), hours=4.0),
            make_entry(entry_date=datetime(2026, 5, 6, tzinfo=timezone.utc), hours=4.0),
            make_entry(entry_date=datetime(2026, 5, 7, tzinfo=timezone.utc), hours=4.0),
            make_entry(entry_date=datetime(2026, 5, 8, tzinfo=timezone.utc), hours=4.0),
        ]
        leave = {
            "2026-05-04": 4.0, "2026-05-05": 4.0, "2026-05-06": 4.0,
            "2026-05-07": 4.0, "2026-05-08": 4.0,
        }
        with patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock(entries)), \
             patch("src.timesheets.service.WeeklyTimesheet.find", return_value=make_query_mock(count=0)):
            # Should not raise
            await service._validate_submission_rules(ts, settings, "u1", _utcnow(), leave_by_day=leave)


# ---------------------------------------------------------------------------
# Attachments
# ---------------------------------------------------------------------------

class TestAttachments:
    @pytest.mark.asyncio
    async def test_add_attachment_success(self):
        user = make_user()
        ts = make_timesheet(attachments=[])
        settings = make_settings(allow_attachment=True)

        from src.timesheets.schemas import AttachmentAdd
        # https + a host from the configured CORS origins (see AttachmentAdd validator)
        body = AttachmentAdd(filename="invoice.pdf", url="https://localhost:3000/invoice.pdf")

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
            result = await service.add_attachment("ts1", body, user)

        assert ts.save.called
        assert len(ts.attachments) == 1
        assert ts.attachments[0].filename == "invoice.pdf"

    @pytest.mark.asyncio
    async def test_add_attachment_not_allowed(self):
        user = make_user()
        ts = make_timesheet()
        settings = make_settings(allow_attachment=False)

        from src.timesheets.schemas import AttachmentAdd
        # https + a host from the configured CORS origins (see AttachmentAdd validator)
        body = AttachmentAdd(filename="invoice.pdf", url="https://localhost:3000/invoice.pdf")

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)):
            with pytest.raises(AttachmentsNotAllowed):
                await service.add_attachment("ts1", body, user)

    @pytest.mark.asyncio
    async def test_remove_attachment_success(self):
        user = make_user()
        attachment = TimesheetAttachment(
            id="att1", filename="invoice.pdf", url="https://example.com/invoice.pdf",
            uploaded_by="u1", uploaded_at=_utcnow(),
        )
        ts = make_timesheet(attachments=[attachment])

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
            await service.remove_attachment("ts1", "att1", user)

        assert ts.save.called
        assert len(ts.attachments) == 0

    @pytest.mark.asyncio
    async def test_remove_attachment_not_found(self):
        user = make_user()
        ts = make_timesheet(attachments=[])

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)):
            with pytest.raises(AttachmentNotFound):
                await service.remove_attachment("ts1", "nonexistent", user)


# ---------------------------------------------------------------------------
# auto_submit_pending
# ---------------------------------------------------------------------------

class TestAutoSubmitPending:
    @pytest.mark.asyncio
    async def test_no_enabled_settings_returns_empty(self):
        settings_query = make_query_mock([])
        with patch("src.timesheets.service.TimesheetSettings.find", return_value=settings_query):
            result = await service.auto_submit_pending()
        assert result["submitted"] == 0
        assert result["failed"] == 0

    @pytest.mark.asyncio
    async def test_submits_past_deadline_drafts(self):
        from src.models import TimesheetStatusEnum
        now = _utcnow()
        # Settings: deadline was yesterday — already passed
        s = make_settings(
            auto_submit_enabled=True,
            submission_day="monday",
            submission_time="09:00",
            submission_deadline_hours=0,
            weekly_restrictions_enabled=False,
            shortage_penalty_enabled=False,
            standard_hours_per_day=8,
        )
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT, total_hours=40.0)

        settings_query = make_query_mock([s])
        drafts_query = make_query_mock([ts])
        with patch("src.timesheets.service.TimesheetSettings.find", return_value=settings_query), \
             patch("src.timesheets.service.WeeklyTimesheet.find", return_value=drafts_query):
            result = await service.auto_submit_pending()

        assert ts.save.called
        assert ts.timesheet_status == TimesheetStatusEnum.SUBMITTED


# ---------------------------------------------------------------------------
# get_timesheet
# ---------------------------------------------------------------------------

class TestGetTimesheet:
    @pytest.mark.asyncio
    async def test_returns_timesheet_with_entries(self):
        user = make_user()
        ts = make_timesheet()
        entry = make_entry()

        entries_query = MagicMock()
        entries_query.sort = MagicMock(return_value=entries_query)
        entries_query.to_list = AsyncMock(return_value=[entry])

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=entries_query):
            result = await service.get_timesheet("ts1", user)

        assert result["id"] == "ts1"
        assert len(result["entries"]) == 1

    @pytest.mark.asyncio
    async def test_not_found_raises(self):
        user = make_user()
        with patch("src.timesheets.service._load_timesheet", AsyncMock(side_effect=TimesheetNotFound())):
            with pytest.raises(TimesheetNotFound):
                await service.get_timesheet("bad_id", user)


# ---------------------------------------------------------------------------
# list_timesheets
# ---------------------------------------------------------------------------

class TestListTimesheets:
    @pytest.mark.asyncio
    async def test_returns_paginated_result(self):
        user = make_user()
        p = PageParams(page=1, page_size=25)
        ts1 = make_timesheet()
        ts2 = make_timesheet(id="ts2", timesheet_status=TimesheetStatusEnum.SUBMITTED)

        with patch("src.timesheets.service.WeeklyTimesheet.find", return_value=make_query_mock([ts1, ts2], count=2)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
            result = await service.list_timesheets(user, p)

        assert result["total"] == 2
        assert len(result["items"]) == 2
        assert result["page"] == 1

    @pytest.mark.asyncio
    async def test_filters_by_status(self):
        user = make_user()
        p = PageParams()
        ts_submitted = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)

        with patch("src.timesheets.service.WeeklyTimesheet.find", return_value=make_query_mock([ts_submitted], count=1)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
            result = await service.list_timesheets(user, p, timesheet_status="submitted")

        assert result["total"] == 1

    @pytest.mark.asyncio
    async def test_empty_returns_zero(self):
        user = make_user()
        p = PageParams()
        with patch("src.timesheets.service.WeeklyTimesheet.find", return_value=make_query_mock([], count=0)), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])):
            result = await service.list_timesheets(user, p)

        assert result["total"] == 0
        assert result["items"] == []


# ---------------------------------------------------------------------------
# get_my_summary
# ---------------------------------------------------------------------------

class TestGetMySummary:
    @pytest.mark.asyncio
    async def test_counts_all_statuses(self):
        user = make_user()
        timesheets = [
            make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT),
            make_timesheet(id="ts2", timesheet_status=TimesheetStatusEnum.SUBMITTED),
            make_timesheet(id="ts3", timesheet_status=TimesheetStatusEnum.L1_APPROVED),
            make_timesheet(id="ts4", timesheet_status=TimesheetStatusEnum.CLIENT_APPROVED),
            make_timesheet(id="ts5", timesheet_status=TimesheetStatusEnum.L1_REJECTED),
        ]
        q = MagicMock()
        q.to_list = AsyncMock(return_value=timesheets)

        with patch("src.timesheets.service.WeeklyTimesheet.find", return_value=q):
            result = await service.get_my_summary(user)

        assert result["total"] == 5
        assert result["draft"] == 1
        assert result["submitted"] == 1
        assert result["l1_approved"] == 1
        assert result["client_approved"] == 1
        assert result["l1_rejected"] == 1
        assert result["pending_approval"] == 1  # submitted + resubmitted

    @pytest.mark.asyncio
    async def test_empty_returns_zeros(self):
        user = make_user()
        q = MagicMock()
        q.to_list = AsyncMock(return_value=[])

        with patch("src.timesheets.service.WeeklyTimesheet.find", return_value=q):
            result = await service.get_my_summary(user)

        assert result["total"] == 0
        assert result["pending_approval"] == 0


# ---------------------------------------------------------------------------
# resubmit_timesheet
# ---------------------------------------------------------------------------

class TestResubmitTimesheet:
    @pytest.mark.asyncio
    async def test_resubmit_rejected_timesheet(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_REJECTED, total_hours=40.0)
        settings = make_settings(
            weekly_restrictions_enabled=False,
            shortage_penalty_enabled=False,
            standard_hours_per_day=8,
            submission_deadline_hours=0,
            allow_past_due_submission=True,
            min_hours_per_day=0,
            submission_compliance_type="weekly",
        )

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={})), \
             patch("src.timesheets.service._validate_submission_rules", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.emit_activity", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_resubmitted", AsyncMock()):
            result = await service.resubmit_timesheet("ts1", user)

        assert ts.timesheet_status == TimesheetStatusEnum.RESUBMITTED
        assert ts.save.called
        assert result["timesheet_status"] == TimesheetStatusEnum.RESUBMITTED

    @pytest.mark.asyncio
    async def test_resubmit_client_rejected_timesheet(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.CLIENT_REJECTED, total_hours=40.0)
        settings = make_settings(
            weekly_restrictions_enabled=False,
            shortage_penalty_enabled=False,
            standard_hours_per_day=8,
            submission_deadline_hours=0,
            allow_past_due_submission=True,
            min_hours_per_day=0,
            submission_compliance_type="weekly",
        )

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service._get_leave_hours_for_week", AsyncMock(return_value={})), \
             patch("src.timesheets.service._validate_submission_rules", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service.emit_activity", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_resubmitted", AsyncMock()):
            result = await service.resubmit_timesheet("ts1", user)

        assert ts.timesheet_status == TimesheetStatusEnum.RESUBMITTED

    @pytest.mark.asyncio
    async def test_resubmit_submitted_timesheet_raises(self):
        """SUBMITTED is not resubmittable."""
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)):
            with pytest.raises(TimesheetNotSubmittable):
                await service.resubmit_timesheet("ts1", user)


# ---------------------------------------------------------------------------
# delete_entry
# ---------------------------------------------------------------------------

class TestDeleteEntry:
    @pytest.mark.asyncio
    async def test_delete_entry_success(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT)
        entry = make_entry()
        entry.weekly_timesheet_id = "ts1"
        entry.deleted_on = None

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.TimesheetEntry.get", AsyncMock(return_value=entry)), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(0.0, 0.0, 0.0))):
            await service.delete_entry("ts1", "e1", user)

        assert entry.deleted_on is not None
        assert entry.save.called

    @pytest.mark.asyncio
    async def test_delete_entry_approved_timesheet_raises(self):
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.L1_APPROVED)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)):
            with pytest.raises(TimesheetNotEditable):
                await service.delete_entry("ts1", "e1", user)

    @pytest.mark.asyncio
    async def test_delete_entry_not_found_raises(self):
        from src.exceptions import NotFound
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.TimesheetEntry.get", AsyncMock(return_value=None)):
            with pytest.raises(NotFound):
                await service.delete_entry("ts1", "missing_entry", user)

    @pytest.mark.asyncio
    async def test_delete_entry_wrong_timesheet_raises(self):
        from src.exceptions import NotFound
        user = make_user()
        ts = make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT)
        entry = make_entry()
        entry.weekly_timesheet_id = "other_ts"  # belongs to a different timesheet
        entry.deleted_on = None

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.TimesheetEntry.get", AsyncMock(return_value=entry)):
            with pytest.raises(NotFound):
                await service.delete_entry("ts1", "e1", user)


# ---------------------------------------------------------------------------
# get_assigned_projects
# ---------------------------------------------------------------------------

_PROJECT_OID = "507f1f77bcf86cd799439011"
_TASK_OID = "507f1f77bcf86cd799439022"


class TestGetAssignedProjects:
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_assignments(self):
        user = make_user()
        assignment_q = MagicMock()
        assignment_q.to_list = AsyncMock(return_value=[])

        with patch("src.timesheets.service.ResourceAssignment.find", return_value=assignment_q):
            result = await service.get_assigned_projects(user)

        assert result == []

    @pytest.mark.asyncio
    async def test_returns_projects_with_tasks(self):
        user = make_user()

        assignment = MagicMock()
        assignment.project_id = _PROJECT_OID
        assignment.task_id = None

        assignment_q = MagicMock()
        assignment_q.to_list = AsyncMock(return_value=[assignment])

        project = MagicMock()
        project.id = _PROJECT_OID
        project.name = "Alpha"
        project.code = "ALPHA"

        project_q = MagicMock()
        project_q.to_list = AsyncMock(return_value=[project])

        pt = MagicMock()
        pt.task_id = _TASK_OID

        pt_q = MagicMock()
        pt_q.to_list = AsyncMock(return_value=[pt])

        task = MagicMock()
        task.id = _TASK_OID
        task.name = "Backend Dev"

        task_q = MagicMock()
        task_q.to_list = AsyncMock(return_value=[task])

        with patch("src.timesheets.service.ResourceAssignment.find", return_value=assignment_q), \
             patch("src.timesheets.service.Project.find", return_value=project_q), \
             patch("src.timesheets.service.ProjectTask.find", return_value=pt_q), \
             patch("src.timesheets.service.Task.find", return_value=task_q):
            result = await service.get_assigned_projects(user)

        assert len(result) == 1
        assert result[0]["name"] == "Alpha"
        assert result[0]["tasks"][0]["task_name"] == "Backend Dev"


# ---------------------------------------------------------------------------
# get_assigned_project_tasks
# ---------------------------------------------------------------------------

class TestGetAssignedProjectTasks:
    @pytest.mark.asyncio
    async def test_not_assigned_raises(self):
        user = make_user()
        with patch("src.timesheets.service.ResourceAssignment.find_one", AsyncMock(return_value=None)):
            with pytest.raises(EmployeeNotAssignedToProject):
                await service.get_assigned_project_tasks(_PROJECT_OID, user)

    @pytest.mark.asyncio
    async def test_returns_task_list(self):
        user = make_user()

        ra = MagicMock()
        ra.project_id = _PROJECT_OID
        ra.is_billable = True

        pt = MagicMock()
        pt.task_id = _TASK_OID

        pt_q = MagicMock()
        pt_q.to_list = AsyncMock(return_value=[pt])

        task = MagicMock()
        task.id = _TASK_OID
        task.name = "Backend Dev"

        task_q = MagicMock()
        task_q.to_list = AsyncMock(return_value=[task])

        with patch("src.timesheets.service.ResourceAssignment.find_one", AsyncMock(return_value=ra)), \
             patch("src.timesheets.service.ProjectTask.find", return_value=pt_q), \
             patch("src.timesheets.service.Task.find", return_value=task_q):
            result = await service.get_assigned_project_tasks(_PROJECT_OID, user)

        assert len(result) == 1
        assert result[0]["task_name"] == "Backend Dev"


# ---------------------------------------------------------------------------
# _validate_submission_rules — additional edge cases
# ---------------------------------------------------------------------------

class TestValidateSubmissionRulesEdgeCases:
    @pytest.mark.asyncio
    async def test_past_due_timesheets_blocked(self):
        ts = make_timesheet(week_start_date=datetime(2026, 5, 4, tzinfo=timezone.utc))
        settings = make_settings(
            allow_past_due_submission=False,
            submission_deadline_hours=0,
            submission_compliance_type="weekly",
            daily_restrictions_enabled=False,
            min_hours_per_day=0,
        )

        with patch("src.timesheets.service.WeeklyTimesheet.find", return_value=make_query_mock([], count=1)):
            with pytest.raises(PastDueTimesheetsBlocked):
                await service._validate_submission_rules(ts, settings, "u1", _utcnow())

    @pytest.mark.asyncio
    async def test_submission_deadline_weekly_mode_passed(self):
        from datetime import datetime, timedelta, timezone
        # Week ended last Monday; deadline was 1h after Friday 18:00
        week_end = _utcnow() - timedelta(days=10)
        ts = make_timesheet(
            week_start_date=week_end - timedelta(days=6),
            week_end_date=week_end,
        )
        settings = make_settings(
            allow_past_due_submission=True,
            submission_compliance_type="weekly",
            submission_deadline_hours=1,
            submission_day="friday",
            submission_time="18:00",
            daily_restrictions_enabled=False,
            min_hours_per_day=0,
        )

        with pytest.raises(SubmissionDeadlinePassed):
            await service._validate_submission_rules(ts, settings, "u1", _utcnow())
