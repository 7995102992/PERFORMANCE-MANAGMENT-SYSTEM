from __future__ import annotations

import logging
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal, Optional, TypeVar
from uuid import uuid4

from beanie import Document, PydanticObjectId
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationInfo, field_validator
from pymongo import ASCENDING, IndexModel

logger = logging.getLogger(__name__)


class TimesheetAttachment(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    filename: str
    url: str
    uploaded_by: PydanticObjectId
    uploaded_at: datetime


# ---------- Base patterns ----------

class CustomModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class StatusEnum(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class MetadataMixin(BaseModel):
    created_by: PydanticObjectId | None = None
    created_on: datetime | None = None
    modified_by: PydanticObjectId | None = None
    modified_on: datetime | None = None
    deleted_by: PydanticObjectId | None = None
    deleted_on: datetime | None = None
    status: StatusEnum = StatusEnum.ACTIVE
    correlation_id: str | None = None  # uuid string, not an ObjectId reference


# ---------- Constants ----------

# Weekday keys (Monday-first) used by the employee-reminder per-day config.
WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


# ---------- Domain enums ----------

class ProjectTypeEnum(StrEnum):
    TIME_AND_MATERIALS = "time_and_materials"
    FIXED_FEE = "fixed_fee"
    NON_BILLABLE = "non_billable"


class BillableRateTypeEnum(StrEnum):
    PER_HOUR = "per_hour"
    PER_DAY = "per_day"


class BillableOnEnum(StrEnum):
    PROJECT = "project"
    RESOURCE = "resource"


class ProjectStatusEnum(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    COMPLETED = "completed"
    ON_HOLD = "on_hold"


class TimesheetStatusEnum(StrEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    L1_APPROVED = "l1_approved"
    L1_REJECTED = "l1_rejected"
    CLIENT_APPROVED = "client_approved"
    CLIENT_REJECTED = "client_rejected"
    RESUBMITTED = "resubmitted"


EDITABLE_STATUSES: set[TimesheetStatusEnum] = {
    TimesheetStatusEnum.DRAFT,
    TimesheetStatusEnum.L1_REJECTED,
    TimesheetStatusEnum.CLIENT_REJECTED,
}

SUBMITTABLE_STATUSES: set[TimesheetStatusEnum] = {
    TimesheetStatusEnum.DRAFT,
}

RESUBMITTABLE_STATUSES: set[TimesheetStatusEnum] = {
    TimesheetStatusEnum.L1_REJECTED,
    TimesheetStatusEnum.CLIENT_REJECTED,
}

# Submitted work stays editable until an approver actually acts on it — see
# `_assert_editable`. Once any project on the week is approved or rejected the
# timesheet freezes, and only a rejection reopens it.
PENDING_STATUSES: set[TimesheetStatusEnum] = {
    TimesheetStatusEnum.SUBMITTED,
    TimesheetStatusEnum.RESUBMITTED,
}


class ApprovalActionEnum(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ApproverRoleEnum(StrEnum):
    MANAGER = "manager"
    CLIENT = "client"


class ProjectApprovalStatusEnum(StrEnum):
    SUBMITTED = "submitted"
    RESUBMITTED = "resubmitted"
    L1_APPROVED = "l1_approved"
    L1_REJECTED = "l1_rejected"
    CLIENT_APPROVED = "client_approved"
    CLIENT_REJECTED = "client_rejected"


# Project-approval states that mean an approver has already acted on that project.
ACTED_PROJECT_STATUSES: set[ProjectApprovalStatusEnum] = {
    ProjectApprovalStatusEnum.L1_APPROVED,
    ProjectApprovalStatusEnum.L1_REJECTED,
    ProjectApprovalStatusEnum.CLIENT_APPROVED,
    ProjectApprovalStatusEnum.CLIENT_REJECTED,
}


# ---------- Tolerant hydration ----------

EnumT = TypeVar("EnumT", bound=StrEnum)


def lenient_enum(enum_cls: type[EnumT], fallback: EnumT | None):
    """Read an unrecognised stored value as ``fallback`` instead of failing.

    A document written before an enum existed, or by an importer with a wider
    vocabulary than ours, holds a string this model cannot parse. Strictly that
    is a validation error — but these fields are read in bulk, and Beanie
    validates a whole ``find`` as a unit, so one such document does not cost one
    row: it costs the entire query. That is how four seeded projects carrying
    ``fixed_bid`` / ``retainer`` / ``internal`` emptied every assigned-projects
    call in the organisation, and with it the expense form's project picker.

    Applied to the **persistence** models only. Request bodies validate through
    ``schemas.py`` — ``ProjectCreate`` and ``ProjectUpdate`` keep the strict enum
    — so a caller posting ``project_type=retainer`` is still refused. Nothing
    here widens what the API accepts; it only widens what it can survive
    reading.

    Not applied to workflow state — ``timesheet_status``, ``approver_role``,
    ``action``, the project-approval status, or ``MetadataMixin.status``. A
    fallback there would invent an answer to a question only the record can
    settle: silently reading an unparseable ``timesheet_status`` as ``DRAFT``
    reopens an approved week for editing, and reading a junk ``status`` as
    ``ACTIVE`` grants an assignment nobody granted. Failing loudly is correct for
    those; this is for fields that merely describe.

    Args:
        enum_cls: The enum the field is typed as.
        fallback: What an unrecognised value reads as. ``None`` for an optional
            field, which is how "we do not know" is already spelled there.

    Returns:
        A ``BeforeValidator`` to attach with ``Annotated``.
    """

    def _coerce(value: object, info: ValidationInfo) -> object:
        if value is None or isinstance(value, enum_cls):
            return value
        try:
            return enum_cls(value)
        except ValueError:
            # Warning rather than debug: this is data that needs cleaning, and
            # the id is here so somebody can go and clean it. `info.data` holds
            # the fields validated before this one; `id` is declared on
            # ``Document`` itself, so it is present for every field below.
            logger.warning(
                "lenient_enum: %s=%r is not a valid %s; reading as %r (document id=%s)",
                info.field_name,
                value,
                enum_cls.__name__,
                fallback,
                info.data.get("id"),
            )
            return fallback

    return BeforeValidator(_coerce)


LenientProjectType = Annotated[ProjectTypeEnum, lenient_enum(ProjectTypeEnum, ProjectTypeEnum.TIME_AND_MATERIALS)]
LenientProjectStatus = Annotated[ProjectStatusEnum, lenient_enum(ProjectStatusEnum, ProjectStatusEnum.ACTIVE)]
LenientBillableRateType = Annotated[
    Optional[BillableRateTypeEnum], lenient_enum(BillableRateTypeEnum, None)
]
LenientBillableOn = Annotated[Optional[BillableOnEnum], lenient_enum(BillableOnEnum, None)]


# ---------- Documents ----------

class Client(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    name: str
    name_lc: str
    contact_person: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    address: str | None = None
    country: str | None = None
    state: str | None = None
    fax: str | None = None
    contact_user_id: PydanticObjectId | None = None
    portal_access_enabled: bool = False
    notes: str | None = None
    business_unit_ids: list[PydanticObjectId] = Field(default_factory=list)
    department_ids: list[PydanticObjectId] = Field(default_factory=list)

    class Settings:
        name = "clients"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
            IndexModel(
                [("organisation_id", ASCENDING), ("name_lc", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class Project(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    client_id: PydanticObjectId
    name: str
    name_lc: str
    code: str | None = None
    description: str | None = None
    project_type: LenientProjectType = ProjectTypeEnum.TIME_AND_MATERIALS
    project_status: LenientProjectStatus = ProjectStatusEnum.ACTIVE
    start_date: datetime | None = None
    end_date: datetime | None = None
    budget_hours: float | None = None
    budget_cost: float | None = None
    billable_rate: float | None = None
    billable_rate_type: LenientBillableRateType = None
    billable_on: LenientBillableOn = None
    currency: str = "USD"
    project_head_ids: list[PydanticObjectId] = []
    is_internal: bool = False  # internal project → heads are employees, not client project-heads
    send_alerts: int | None = None
    client_approval_required: bool = True

    class Settings:
        name = "projects"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("client_id", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING), ("project_status", ASCENDING)]),
            IndexModel(
                [("organisation_id", ASCENDING), ("name_lc", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
            IndexModel(
                [("organisation_id", ASCENDING), ("code", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None, "code": {"$type": "string"}},
            ),
        ]


class Task(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    # Owning project, or None for a shared task. Shared tasks (global / frequent /
    # everything created through /tasks) live at organisation level and may be linked
    # to many projects; a project-owned task belongs to exactly one project, so two
    # projects can each have their own task of the same name.
    project_id: PydanticObjectId | None = None
    name: str
    name_lc: str
    description: str | None = None
    is_global: bool = False
    is_billable: bool = True
    is_time_off: bool = False
    is_frequent: bool = False
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None

    class Settings:
        name = "tasks"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
            # Shared tasks: one name per organisation.
            IndexModel(
                [("organisation_id", ASCENDING), ("name_lc", ASCENDING)],
                name="task_org_name_shared_unique",
                unique=True,
                partialFilterExpression={"deleted_on": None, "project_id": None},
            ),
            # Project-owned tasks: one name per project.
            IndexModel(
                [("project_id", ASCENDING), ("name_lc", ASCENDING)],
                name="task_project_name_unique",
                unique=True,
                partialFilterExpression={
                    "deleted_on": None,
                    "project_id": {"$type": "objectId"},
                },
            ),
        ]


class ProjectTask(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    project_id: PydanticObjectId
    task_id: PydanticObjectId
    is_active: bool = True
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None

    class Settings:
        name = "project_tasks"
        indexes = [
            IndexModel(
                [("project_id", ASCENDING), ("task_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class ResourceAssignment(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    project_id: PydanticObjectId
    task_id: PydanticObjectId | None = None
    user_id: PydanticObjectId
    role: str | None = None
    allocation_percentage: int = 100
    billable_rate: float | None = None
    is_billable: bool = True
    start_date: datetime | None = None
    end_date: datetime | None = None
    # Set when a project manager releases the resource. The row stays active so time
    # can still be logged up to `end_date`, but the allocation is closed: no further
    # edits are accepted, and the resource reads as removed. Cleared on reassign.
    released_on: datetime | None = None
    # Mandatory reason captured when a resource is removed; cleared on reassign.
    removal_comment: str | None = None
    # Audit trail of removals: {comment, removed_by, removed_at}. Retained across reassign.
    removal_history: list[dict] = Field(default_factory=list)

    class Settings:
        name = "resource_assignments"
        indexes = [
            IndexModel(
                [("project_id", ASCENDING), ("task_id", ASCENDING), ("user_id", ASCENDING)],
                name="ra_proj_task_emp",
            ),
            IndexModel(
                [("user_id", ASCENDING), ("status", ASCENDING)],
                name="ra_emp_status",
            ),
            IndexModel(
                [("project_id", ASCENDING), ("task_id", ASCENDING), ("user_id", ASCENDING)],
                unique=True,
                name="ra_proj_task_emp_unique",
                partialFilterExpression={"deleted_on": None, "status": "active"},
            ),
        ]


class WeeklyTimesheet(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    user_id: PydanticObjectId
    week_start_date: datetime
    week_end_date: datetime
    total_hours: float = 0
    billable_hours: float = 0
    non_billable_hours: float = 0
    shortage_hours: float = 0
    penalty_hours: float = 0
    timesheet_status: TimesheetStatusEnum = TimesheetStatusEnum.DRAFT
    submitted_at: datetime | None = None
    notes: str | None = None
    attachments: list[TimesheetAttachment] = Field(default_factory=list)

    class Settings:
        name = "weekly_timesheets"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("user_id", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING), ("timesheet_status", ASCENDING)]),
            IndexModel([("user_id", ASCENDING), ("week_start_date", ASCENDING)]),
            IndexModel(
                [("user_id", ASCENDING), ("week_start_date", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class TimesheetEntry(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    weekly_timesheet_id: PydanticObjectId
    project_id: PydanticObjectId
    task_id: PydanticObjectId
    entry_date: datetime
    hours: float = 0
    notes: str | None = None
    is_billable: bool = True

    class Settings:
        name = "timesheet_entries"
        indexes = [
            IndexModel([("weekly_timesheet_id", ASCENDING)]),
            IndexModel([("project_id", ASCENDING), ("entry_date", ASCENDING)]),
            IndexModel(
                [("weekly_timesheet_id", ASCENDING), ("project_id", ASCENDING),
                 ("task_id", ASCENDING), ("entry_date", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class ApprovalRecord(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    weekly_timesheet_id: PydanticObjectId
    approver_id: PydanticObjectId
    approver_role: ApproverRoleEnum
    approval_level: int = 1
    action: ApprovalActionEnum
    comments: str | None = None
    acted_at: datetime | None = None
    scope_project_ids: list[PydanticObjectId] = Field(default_factory=list)

    class Settings:
        name = "approval_records"
        indexes = [
            IndexModel([("weekly_timesheet_id", ASCENDING)]),
            IndexModel([("approver_id", ASCENDING), ("acted_at", ASCENDING)]),
        ]


class TimesheetProjectApproval(Document, MetadataMixin):
    """Tracks the approval state of a single project within a weekly timesheet."""
    organisation_id: PydanticObjectId
    weekly_timesheet_id: PydanticObjectId
    project_id: PydanticObjectId
    status: ProjectApprovalStatusEnum = ProjectApprovalStatusEnum.SUBMITTED
    # L1 (manager) action
    l1_approver_id: PydanticObjectId | None = None
    l1_acted_at: datetime | None = None
    l1_comments: str | None = None
    # Client action
    client_approver_id: PydanticObjectId | None = None
    client_acted_at: datetime | None = None
    client_comments: str | None = None

    class Settings:
        name = "timesheet_project_approvals"
        indexes = [
            IndexModel([("weekly_timesheet_id", ASCENDING)]),
            IndexModel(
                [("weekly_timesheet_id", ASCENDING), ("project_id", ASCENDING)],
                unique=True,
                name="tpa_ts_proj_unique",
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class TimesheetSettings(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    project_id: PydanticObjectId | None = None
    # Hour settings
    daily_restrictions_enabled: bool = True
    min_hours_per_day: float = 0
    max_hours_per_day: float = 24
    deduct_leave_daily: bool = False
    weekly_restrictions_enabled: bool = False
    standard_hours_per_day: float = 8
    max_hours_per_week: float = 40
    deduct_leave_weekly: bool = False
    show_hours_type: str = "gross"
    shortage_penalty_enabled: bool = False
    penalty_percentage: float = 5
    # Submission settings
    daily_time_entry_enabled: bool = False
    allow_past_due_submission: bool = True
    restrict_time_off_entries: bool = False
    allow_attachment: bool = True
    submission_compliance_type: str = "weekly"
    submission_deadline_hours: int = 0
    submission_day: str = "friday"
    submission_time: str = "18:00"
    auto_submit_enabled: bool = False
    # Approval settings
    approval_required: bool = True
    allow_future_entries: bool = False
    # Monthly payroll cutoff. Once the cutoff day of the month passes, every week
    # that ended before it is frozen — no saving, no submitting — until a project
    # manager reopens that month for their project (PastSubmissionOverride).
    past_submission_cutoff_enabled: bool = False
    past_submission_cutoff_day: int = 25
    # IAM master-data ids of the employment types excluded from the timesheet
    # approval emails — submitted, approved, rejected — the same value an employee
    # record carries in `employment_type`. Fill reminders still go to everyone, since
    # those prompt the work rather than report on it. Excluded people keep full
    # access to their timesheets; they are simply not mailed. Empty means everyone is
    # notified, which is what an organisation that never configures this gets.
    notification_excluded_employment_types: list[str] = Field(default_factory=list)
    # Client approval notification settings
    client_notify_on_pending_count_enabled: bool = True
    client_notify_pending_count: int = 1
    client_notify_on_schedule_enabled: bool = False
    client_notify_schedule: str = "weekend"  # "weekend" | "month_end"
    # Employee "fill your timesheet" reminder settings
    employee_reminder_enabled: bool = False
    employee_reminder_time: str = "09:00"  # HH:MM local time for reminder
    # Per-weekday enable map; reminder fires at employee_reminder_time on each enabled day
    employee_reminder_days: dict[str, bool] = Field(
        default_factory=lambda: {d: False for d in WEEKDAY_NAMES}
    )

    @field_validator("employee_reminder_days", mode="before")
    @classmethod
    def _coerce_reminder_days(cls, v):
        # Migrate legacy list (["week_start"/"weekend"]) and normalise to all 7 days
        out = {d: False for d in WEEKDAY_NAMES}
        if isinstance(v, dict):
            for k, val in v.items():
                key = str(k).strip().lower()
                if key in out:
                    out[key] = bool(val)
        elif isinstance(v, (list, str)):
            legacy = [v] if isinstance(v, str) else v
            if "week_start" in legacy:
                out["monday"] = True
            if "weekend" in legacy:
                out["friday"] = True
        return out

    class Settings:
        name = "timesheet_settings"
        indexes = [
            IndexModel(
                [("organisation_id", ASCENDING), ("project_id", ASCENDING)],
                unique=True,
                name="ts_settings_org_proj_unique",
            ),
        ]


class PastSubmissionOverride(Document, MetadataMixin):
    """A manager reopening one closed month for one employee.

    Granted per employee and month — a late timesheet is one person's to fix — but
    it only lifts the cutoff on the granting manager's own projects. A manager can
    invite late time onto work they are accountable for; they cannot reopen someone
    else's books by reopening their own.

    ``project_ids`` is a snapshot of the granter's approver scope at the moment of
    granting, so an exemption is a fixed decision rather than one that quietly widens
    when they pick up another project. An empty list means unrestricted, which only
    an admin's grant carries.

    One live row per granter, so two managers can each reopen the month for their own
    projects independently, and either can close their own again without disturbing
    the other.

    Expires on its own a week after it was granted. A reopened month is an exception
    to payroll, and an exception nobody remembers to close stops being one — so the
    window closes itself and a manager who still needs it grants it again. The row is
    kept past ``expires_at`` for the audit trail; it simply stops counting.
    """

    organisation_id: PydanticObjectId
    user_id: PydanticObjectId
    year: int
    month: int  # 1-12, the month of the week's start date
    project_ids: list[PydanticObjectId] = Field(default_factory=list)
    expires_at: datetime | None = None
    reason: str | None = None

    class Settings:
        name = "past_submission_overrides"
        indexes = [
            IndexModel(
                [("user_id", ASCENDING), ("year", ASCENDING), ("month", ASCENDING),
                 ("created_by", ASCENDING)],
                unique=True,
                name="pso_user_period_granter_unique",
                partialFilterExpression={"deleted_on": None},
            ),
            IndexModel([("organisation_id", ASCENDING), ("year", ASCENDING), ("month", ASCENDING)]),
        ]


class ApprovalLevelConfig(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    settings_id: PydanticObjectId
    level: int
    approver_role: str
    approver_id: PydanticObjectId | None = None

    class Settings:
        name = "approval_level_configs"
        indexes = [
            IndexModel(
                [("settings_id", ASCENDING), ("level", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class OutboxEventDocument(Document):
    id: str = Field(default_factory=lambda: str(uuid4()))
    idempotency_key: str = Field(description="Unique key for consumer-side deduplication")
    exchange: str = "domain_events"
    event_type: str
    payload: dict
    status: Literal["pending", "sent", "failed"] = "pending"
    retries: int = 0
    created_at: datetime
    sent_at: Optional[datetime] = None
    dead_lettered_at: Optional[datetime] = Field(
        default=None,
        description="Set when the event exhausts MAX_RETRIES and is abandoned",
    )

    class Settings:
        name = "outbox_events"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]


class ClientProjectHead(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    client_id: PydanticObjectId
    first_name: str
    last_name: str
    email: str
    phone: str | None = None
    iam_user_id: PydanticObjectId | None = None

    class Settings:
        name = "client_project_heads"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("client_id", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING), ("email", ASCENDING)]),
            # The same person may head several clients (one row per client), so the
            # email is unique per client — not per organisation.
            IndexModel(
                [("organisation_id", ASCENDING), ("client_id", ASCENDING), ("email", ASCENDING)],
                unique=True,
                name="cph_org_client_email_unique",
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class ClientApprovalToken(Document):
    """Single-use token that allows a client/project-head to approve or reject
    a timesheet via a magic link — no login required."""
    organisation_id: PydanticObjectId
    token: str
    timesheet_id: Optional[PydanticObjectId] = None
    timesheet_ids: list[PydanticObjectId] = Field(default_factory=list)
    project_ids: list[PydanticObjectId] = Field(default_factory=list)
    approver_id: PydanticObjectId
    approver_email: str
    is_bulk: bool = False
    expires_at: datetime
    used_at: Optional[datetime] = None
    used_action: Optional[str] = None  # "approved" | "rejected"

    class Settings:
        name = "client_approval_tokens"
        indexes = [
            IndexModel([("token", ASCENDING)], unique=True),
            IndexModel([("timesheet_id", ASCENDING)]),
            IndexModel([("expires_at", ASCENDING)]),
        ]


ALL_DOCUMENTS = [
    Client,
    Project,
    Task,
    ProjectTask,
    ResourceAssignment,
    WeeklyTimesheet,
    TimesheetEntry,
    ApprovalRecord,
    TimesheetProjectApproval,
    TimesheetSettings,
    PastSubmissionOverride,
    ApprovalLevelConfig,
    OutboxEventDocument,
    ClientProjectHead,
    ClientApprovalToken,
]
