from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from ..models import ApprovalActionEnum, ApproverRoleEnum, TimesheetStatusEnum


class ApprovalAction(BaseModel):
    comments: str | None = None


class RejectionAction(BaseModel):
    comments: str = Field(min_length=1)


class BulkApprovalAction(BaseModel):
    timesheet_ids: list[str]
    comments: str | None = None


class BulkRejectionAction(BaseModel):
    timesheet_ids: list[str]
    comments: str = Field(min_length=1)


class ApprovalRecordOut(BaseModel):
    id: str
    weekly_timesheet_id: str
    approver_id: str
    approver_role: ApproverRoleEnum
    approval_level: int
    action: ApprovalActionEnum
    comments: str | None = None
    acted_at: datetime | None = None


class ManagerDashboardResponse(BaseModel):
    total: int = 0
    submitted: int = 0
    resubmitted: int = 0
    l1_approved: int = 0
    l1_rejected: int = 0
    client_approved: int = 0
    client_rejected: int = 0


class EmployeeTimesheetSummary(BaseModel):
    id: str
    user_id: str
    user_name: str | None = None
    week_start_date: datetime
    week_end_date: datetime
    total_hours: float
    submitted_at: datetime | None = None
    timesheet_status: TimesheetStatusEnum


class EmployeeDetailResponse(BaseModel):
    user_id: str
    user_name: str | None = None
    total_submitted: int = 0
    approved: int = 0
    rejected: int = 0
    client_approved: int = 0
    pending_manager: int = 0
    pending_client: int = 0
    client_rejected: int = 0


class PastSubmissionCutoffOut(BaseModel):
    """The monthly payroll cutoff, as Team Timesheets renders against it.

    ``cutoff_day`` is always the effective value — the organisation default when
    nothing is configured — so a caller never has to supply its own fallback. It
    stays meaningful when ``enabled`` is false: that is the day the cutoff would
    take effect if it were switched on.
    """

    enabled: bool
    cutoff_day: int


class WeeklyTimelineRow(BaseModel):
    project_id: str
    project_name: str | None = None
    task_id: str
    task_name: str | None = None
    mon: float = 0
    tue: float = 0
    wed: float = 0
    thu: float = 0
    fri: float = 0
    sat: float = 0
    sun: float = 0
    total: float = 0
