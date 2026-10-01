from datetime import date, datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


class DurationMode(str, Enum):
    FULL_DAYS = "FULL_DAYS"
    HALF_DAY = "HALF_DAY"
    CUSTOM = "CUSTOM"


class SessionHalf(str, Enum):
    FIRST_HALF = "FIRST_HALF"
    SECOND_HALF = "SECOND_HALF"


class ApprovalLevelConfig(CustomModel):
    level: int
    type: Literal["ROLE", "USER"]
    value: str


class ApprovalFlowCreate(CustomModel):
    leave_plan_id: str
    levels: list[ApprovalLevelConfig] = Field(min_length=1)
    skip_if_no_action_days: Optional[int] = None


class ApprovalFlowResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    levels: list[ApprovalLevelConfig]
    skip_if_no_action_days: Optional[int] = None


class ApprovalState(CustomModel):
    current_level: int = 1


class LeaveRequestCreate(CustomModel):
    leave_type_id: str
    start_date: date
    end_date: date
    duration_mode: DurationMode = DurationMode.FULL_DAYS
    # HALF_DAY mode: which half of the single day
    half_day_period: Optional[SessionHalf] = None
    # CUSTOM mode: which session the start and end fall in
    start_session: Optional[SessionHalf] = None
    end_session: Optional[SessionHalf] = None
    reason: str = Field(..., max_length=300)
    notify_cc: list[str] = Field(default_factory=list)
    asset_ids: list[str] = Field(default_factory=list)
    # Expiring / comp-off leave only: the non-working days the employee worked
    # that this leave compensates. One worked day per requested leave day; each
    # must be availed within the leave type's expiry window. Ignored (and left
    # empty) for ordinary leave types — enforced server-side against the type.
    worked_dates: list[date] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_mode_fields(self) -> "LeaveRequestCreate":
        if self.duration_mode == DurationMode.HALF_DAY:
            if self.half_day_period is None:
                raise ValueError("half_day_period is required for HALF_DAY mode")
            if self.start_date != self.end_date:
                raise ValueError("start_date and end_date must be the same for HALF_DAY mode")
        if self.duration_mode == DurationMode.CUSTOM:
            if self.start_session is None or self.end_session is None:
                raise ValueError("start_session and end_session are required for CUSTOM mode")
        return self


class AssetDetail(CustomModel):
    id: str
    original_filename: str
    content_type: str
    size: int
    url: Optional[str] = None


class LeaveTypeUsage(CustomModel):
    """How much of an unrestricted leave type the employee has already taken.

    ``days_used`` includes ``pending_days`` — the split is exposed so the UI can
    say "8 days used (2 awaiting approval)" rather than implying all 8 are
    settled.
    """
    days_used: float = 0.0
    pending_days: float = 0.0
    period_start: Optional[str] = None
    period_label: Optional[str] = None


class LeaveRequestResponse(AuditMixin):
    id: str = Field(alias="_id")
    user_id: str
    leave_type_id: str
    leave_plan_id: Optional[str] = None
    start_date: date
    end_date: date
    start_datetime: datetime
    end_datetime: datetime
    duration_mode: str
    half_day_period: Optional[str] = None
    start_session: Optional[str] = None
    end_session: Optional[str] = None
    duration_hours: float
    duration_days: float
    loss_of_pay: bool = False
    status: str
    approval_state: ApprovalState = Field(default_factory=ApprovalState)
    reason: Optional[str] = None
    notify_cc: list[str] = Field(default_factory=list)
    asset_ids: list[str] = Field(default_factory=list)
    assets: list[AssetDetail] = Field(default_factory=list)
    # Expiring / comp-off leave: the worked (compensated) days pointed to.
    worked_dates: list[date] = Field(default_factory=list)
    employee_name: Optional[str] = None
    employee_email: Optional[str] = None
    employee_first_name: Optional[str] = None
    employee_last_name: Optional[str] = None
    # Resolved from the LMS employee mirror on manager listing surfaces — the
    # FE's journey lookup can't see L2 reports, so the row carries these itself.
    employee_emp_code: Optional[str] = None
    employee_designation: Optional[str] = None
    # Profile photo from the IAM user replica (None when no photo uploaded).
    employee_avatar_url: Optional[str] = None
    # Balance column on manager listing surfaces: remaining days for this
    # request's leave type (None for LOP / non-deducting types) and the type's
    # configured annual allocation ("X of Y left").
    employee_balance_days: Optional[float] = None
    leave_type_annual_days: Optional[float] = None
    # The employee's own credited total for the type (sum of
    # employee_leave_balances.total_credited, in days) — the correct "Y" in
    # "X of Y left"; leave_type_annual_days is only master data.
    employee_entitled_days: Optional[float] = None
    leave_type_name: Optional[str] = None
    # Aging indicator (populated on approver/HR listing surfaces): how many days
    # the request has been awaiting action, whether it has breached the plan's
    # skip_if_no_action_days threshold, and a three-state status that warns one
    # day BEFORE breach ("due_soon") so approvers can act in time.
    days_pending: Optional[int] = None
    is_overdue: bool = False
    aging_status: Optional[str] = None  # "on_track" | "due_soon" | "overdue"
    # Set only for an unrestricted type with show_usage_warning on: how much of
    # this leave the employee has already taken this leave year. Such a type has
    # no balance, so this is what the employee and the approver reason about.
    usage_warning: Optional[LeaveTypeUsage] = None
    # Set when an APPROVED request was cancelled by a manager (distinguishes it
    # from an employee's own cancel of a pending request).
    cancelled_by: Optional[str] = None
    cancellation_reason: Optional[str] = None
    cancelled_on: Optional[datetime] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_fields(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("start_date", "end_date"):
            v = data.get(field)
            if isinstance(v, str):
                try:
                    data[field] = date.fromisoformat(v)
                except ValueError:
                    # Tolerate legacy rows where the date was persisted as a
                    # full datetime string (e.g. '2026-02-23 00:00:00') rather
                    # than a date-only 'YYYY-MM-DD'. Parse and drop the time.
                    data[field] = datetime.fromisoformat(v).date()
        from bson import ObjectId as _OID
        if isinstance(data.get("_id"), _OID):
            data["_id"] = str(data["_id"])
        for field in ("id", "_id","user_id", "leave_plan_id", "leave_type_id", "cancelled_by"):
            if isinstance(data.get(field), _OID):
                data[field] = str(data[field])
        return data


class LeaveRequestStatusCounts(CustomModel):
    all: int
    pending: int
    approved: int
    rejected: int
    cancelled: int


class MyLeaveRequestsResponse(CustomModel):
    items: list[LeaveRequestResponse]
    page: int
    page_size: int
    total: int
    total_pages: int
    counts: LeaveRequestStatusCounts


class ManagerInfo(CustomModel):
    id: str
    name: str
    email: Optional[str] = None


class EmployeeInfo(CustomModel):
    id: str
    name: str
    email: Optional[str] = None
    department_id: Optional[str] = None
    department_name: Optional[str] = None
    avatar_url: Optional[str] = None


class ApprovalTimelineEntry(CustomModel):
    action: str
    level: Optional[int] = None
    actor_id: str
    actor_name: Optional[str] = None
    comment: Optional[str] = None
    timestamp: datetime


class LeaveBalanceSnapshot(CustomModel):
    leave_type_id: str
    leave_type_name: str
    available_today_days: float
    available_today_hours: float
    projected_by_leave_date_days: float
    projected_by_leave_date_hours: float
    after_approval_days: float
    after_approval_hours: float


class LeaveRequestDetailResponse(LeaveRequestResponse):
    employee: Optional[EmployeeInfo] = None
    l1_manager: Optional[ManagerInfo] = None
    l2_manager: Optional[ManagerInfo] = None
    approval_timeline: list[ApprovalTimelineEntry] = Field(default_factory=list)
    balance_projection: Optional[LeaveBalanceSnapshot] = None


class LeaveTypeProjection(CustomModel):
    leave_type_id: str
    leave_type_name: str
    current_balance_hours: float
    current_balance_days: float
    pending_hours: float
    pending_days: float
    approved_future_hours: float
    approved_future_days: float
    max_balance_hours: float
    max_balance_days: float


class BalanceProjectionResponse(CustomModel):
    projections: list[LeaveTypeProjection]


class LeaveHistoryResponse(CustomModel):
    total: int
    offset: int
    limit: int
    items: list[LeaveRequestResponse]


class LeaveBalanceResponse(CustomModel):
    user_id: str
    leave_type_id: str
    available_days: float
    available_hours: float


class BackdatedLeaveConstraint(CustomModel):
    enabled: bool
    max_days: Optional[int] = None


class EntitlementConstraints(CustomModel):
    backdated_leave: BackdatedLeaveConstraint


class LeaveTypeBalance(CustomModel):
    leave_type_id: str
    leave_type_name: str
    leave_type_code: Optional[str] = None
    # The leave type's display order. The list already arrives in this order —
    # it is echoed so a client that re-sorts (merging in extra rows, say) can
    # reproduce it instead of falling back to alphabetical.
    rank: Optional[int] = None
    unit: str
    # balance = credited - approved debits; on_hold = active pending reservations;
    # available = balance - on_hold (what new requests validate against).
    balance_hours: float = 0.0
    balance_days: float = 0.0
    on_hold_hours: float = 0.0
    on_hold_days: float = 0.0
    available_hours: float
    available_days: float
    deduct_from_balance: bool


class AllLeaveBalancesResponse(CustomModel):
    user_id: str
    balances: list[LeaveTypeBalance]


class LeaveEstimateResponse(CustomModel):
    estimated_days: float
    estimated_hours: float
    is_lop: bool = False
    includes_weekends: bool = False


class BalanceEstimateResponse(CustomModel):
    leave_type_id: str
    leave_type_name: str
    is_lop: bool = False
    includes_weekends: bool = False
    estimated_hours: float
    estimated_days: float
    available_today_hours: float
    available_today_days: float
    projected_by_leave_date_hours: float
    projected_by_leave_date_days: float
    after_approval_hours: float
    after_approval_days: float
    entitlement_constraints: Optional[EntitlementConstraints] = None


class ApprovalInstanceResponse(CustomModel):
    id: str = Field(alias="_id")
    leave_request_id: str
    level: int
    approver_id: str
    status: str
    acted_at: Optional[datetime] = None
    created_on: datetime
    created_by: str


class ApprovalOverrideLevelConfig(CustomModel):
    level: int
    approver_id: str


class ApprovalOverrideCreate(CustomModel):
    leave_request_id: str
    levels: list[ApprovalOverrideLevelConfig] = Field(min_length=1)


class ApprovalActionPayload(CustomModel):
    comment: Optional[str] = None


class CancellationActionPayload(CustomModel):
    # A manager undoing an approved leave must say why — the reason lands in the
    # activity timeline and the employee's notification.
    reason: str = Field(min_length=1, max_length=1000)


class ToggleConfigUpsert(CustomModel):
    # Step 3 — Grant Configuration
    grant_joining_rule: bool = False
    grant_first_month_restriction: bool = False
    grant_extra_leave: bool = False

    # Step 4 — Entitlement Configuration
    distribution: bool = False
    mid_year_joining: bool = False
    probation: bool = False
    backdated_leave: bool = False
    clubbing: bool = False
    continuous_limit: bool = False
    monthly_limit: bool = False
    credit_expiry: bool = False
    negative_balance: bool = False
    upload_requirement: bool = False
    request_limits_gap: bool = False
    future_requests: bool = False
    future_projected_balance: bool = False

    # Step 5 — Sandwich & Approval Configuration
    sandwich: bool = False
    approval_required: bool = False

    # Step 6 — Year End Processing Configuration
    year_end_rounding: bool = False


class ToggleConfigResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str

    # Step 3 — Grant Configuration
    grant_joining_rule: bool
    grant_first_month_restriction: bool
    grant_extra_leave: bool

    # Step 4 — Entitlement Configuration
    distribution: bool
    mid_year_joining: bool
    probation: bool
    backdated_leave: bool
    clubbing: bool
    continuous_limit: bool
    monthly_limit: bool
    credit_expiry: bool
    negative_balance: bool
    upload_requirement: bool
    request_limits_gap: bool
    future_requests: bool
    future_projected_balance: bool

    # Step 5 — Sandwich & Approval Configuration
    sandwich: bool
    approval_required: bool

    # Step 6 — Year End Processing Configuration
    year_end_rounding: bool

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "leave_plan_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        return data
