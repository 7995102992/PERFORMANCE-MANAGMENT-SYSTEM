from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..models import WEEKDAY_NAMES


class HourSettingsUpdate(BaseModel):
    daily_restrictions_enabled: bool = True
    min_hours_per_day: float = Field(ge=0, le=24)
    max_hours_per_day: float = Field(default=24, ge=0, le=24)
    deduct_leave_daily: bool = False
    weekly_restrictions_enabled: bool = False
    standard_hours_per_day: float = Field(ge=0, le=24)
    max_hours_per_week: float = Field(ge=0, le=168)
    deduct_leave_weekly: bool = False
    show_hours_type: str = Field(default="gross", pattern="^(gross|net|both)$")
    shortage_penalty_enabled: bool = False
    penalty_percentage: float = Field(default=5, ge=0, le=100)


class SubmissionSettingsUpdate(BaseModel):
    daily_time_entry_enabled: bool = False
    allow_past_due_submission: bool = True
    restrict_time_off_entries: bool = False
    allow_attachment: bool = True
    submission_compliance_type: str = Field(default="weekly", pattern="^(daily|weekly)$")
    submission_deadline_hours: int = Field(default=0)
    submission_day: str = Field(pattern="^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$")
    submission_time: str = Field(pattern="^\\d{2}:\\d{2}$")
    auto_submit_enabled: bool = False
    client_notify_on_pending_count_enabled: bool = True
    client_notify_pending_count: int = Field(default=1, ge=1)
    client_notify_on_schedule_enabled: bool = False
    client_notify_schedule: str = Field(default="weekend", pattern="^(weekend|month_end)$")
    # Also on ApprovalSettingsUpdate: the field is edited in the submission UI
    # alongside the client-notification options, but belongs to the approval group.
    # Accepting it here lets that Save persist it in one call.
    notification_excluded_employment_types: list[str] = Field(default_factory=list)
    employee_reminder_enabled: bool = False
    employee_reminder_time: str = Field(default="09:00", pattern=r"^\d{2}:\d{2}$")
    # Per-weekday enable map; payload may send any subset — normalised to all 7 days
    employee_reminder_days: dict[str, bool] = Field(
        default_factory=lambda: {d: False for d in WEEKDAY_NAMES}
    )

    @field_validator("employee_reminder_days", mode="before")
    @classmethod
    def _normalise_days(cls, v):
        out = {d: False for d in WEEKDAY_NAMES}
        if v is None:
            return out
        if not isinstance(v, dict):
            raise ValueError("employee_reminder_days must be an object of {weekday: bool}")
        invalid = [k for k in v if str(k).strip().lower() not in out]
        if invalid:
            raise ValueError(f"Invalid weekday(s): {invalid}. Allowed: {WEEKDAY_NAMES}")
        for k, val in v.items():
            out[str(k).strip().lower()] = bool(val)
        return out


class ApprovalLevelConfigIn(BaseModel):
    level: int = Field(ge=1)
    approver_role: str = Field(min_length=1)
    approver_id: str | None = None


class ApprovalSettingsUpdate(BaseModel):
    approval_required: bool = True
    allow_future_entries: bool = False
    past_submission_cutoff_enabled: bool = False
    past_submission_cutoff_day: int = Field(default=25, ge=1, le=31)
    # IAM employment-type ids whose people are not mailed (they keep full access)
    notification_excluded_employment_types: list[str] = Field(default_factory=list)
    levels: list[ApprovalLevelConfigIn] = Field(default_factory=list)
    client_notify_on_pending_count_enabled: bool = True
    client_notify_pending_count: int = Field(default=1, ge=1)
    client_notify_on_schedule_enabled: bool = False
    client_notify_schedule: str = Field(default="weekend", pattern="^(weekend|month_end)$")


class ApprovalLevelConfigOut(BaseModel):
    id: str
    level: int
    approver_role: str
    approver_id: str | None = None


class TimesheetSettingsOut(BaseModel):
    id: str
    organisation_id: str
    project_id: str | None = None
    # Hour settings
    daily_restrictions_enabled: bool
    min_hours_per_day: float
    max_hours_per_day: float
    deduct_leave_daily: bool
    weekly_restrictions_enabled: bool
    standard_hours_per_day: float
    max_hours_per_week: float
    deduct_leave_weekly: bool
    show_hours_type: str
    shortage_penalty_enabled: bool
    penalty_percentage: float
    # Submission settings
    daily_time_entry_enabled: bool
    allow_past_due_submission: bool
    restrict_time_off_entries: bool
    allow_attachment: bool
    submission_compliance_type: str
    submission_deadline_hours: int
    submission_day: str
    submission_time: str
    auto_submit_enabled: bool
    # Approval settings
    approval_required: bool
    allow_future_entries: bool
    past_submission_cutoff_enabled: bool
    past_submission_cutoff_day: int
    notification_excluded_employment_types: list[str] = []
    approval_levels: list[ApprovalLevelConfigOut] = Field(default_factory=list)
    # Client approval notification settings
    client_notify_on_pending_count_enabled: bool
    client_notify_pending_count: int
    client_notify_on_schedule_enabled: bool
    client_notify_schedule: str
    # Employee reminder settings
    employee_reminder_enabled: bool
    employee_reminder_time: str
    employee_reminder_days: dict[str, bool]
    created_on: datetime | None = None
    modified_on: datetime | None = None
