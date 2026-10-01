from typing import Literal, Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel
from src.leave_entitlements.schemas import (
    AccrualFrequency,
    BackdatedLeaveConfig,
    ClubbingConfig,
    CommentRequirementConfig,
    ContinuousLeaveLimitConfig,
    CreditExpiryConfig,
    CreditTimingConfig,
    FractionHandlingConfig,
    FutureLeaveRequestConfig,
    MidYearJoiningConfig,
    MonthlyLeaveLimitConfig,
    NegativeBalanceConfig,
    NoticePeriodLeaveConfig,
    ProbationConfig,
    RequestLimitConfig,
    UploadRequirementConfig,
)


class LeaveTypeRestrictions(CustomModel):
    gender: Optional[Literal["MALE", "FEMALE", "OTHER"]] = None
    marital_status: Optional[Literal["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"]] = None


# ---------------------------------------------------------------------------
# Self-contained leave-type policy (the leave type IS the policy). All fields
# are optional so leave types created before this change still load. The
# accrual engine / plan wizard prefer these per-type values and fall back to
# the plan's grant + entitlement config for legacy plans.
# ---------------------------------------------------------------------------

class LeaveTypeAccrual(CustomModel):
    # Number of leaves granted per year (in the leave type's own unit).
    annual_count: Optional[float] = None
    # How the annual_count is credited. "yearly" == one lump sum at year start.
    accrual_frequency: Optional[AccrualFrequency] = None
    # Whether this type's balance carries forward at year-end, and how much.
    carry_forward: bool = False
    carry_forward_count: Optional[float] = None
    # Whether unused balance can be encashed (only meaningful for paid leave).
    # When encashable, encash_percentage (1-100) of the post-carry leftover is
    # paid out and the remainder of that leftover is reset/expired.
    encashable: bool = False
    encash_percentage: Optional[float] = None


class LeaveTypePolicies(CustomModel):
    """The non-accrual entitlement policies, relocated onto the leave type."""
    mid_year_joining: Optional[MidYearJoiningConfig] = None
    probation: Optional[ProbationConfig] = None
    future_request: Optional[FutureLeaveRequestConfig] = None
    negative_balance: Optional[NegativeBalanceConfig] = None
    fractional_balance: Optional[FractionHandlingConfig] = None
    credit_expiry: Optional[CreditExpiryConfig] = None
    credit_timing: Optional[CreditTimingConfig] = None
    upload_requirement: Optional[UploadRequirementConfig] = None
    comment_requirement: Optional[CommentRequirementConfig] = None
    request_limits: Optional[RequestLimitConfig] = None
    clubbing: Optional[ClubbingConfig] = None
    continuous_limit: Optional[ContinuousLeaveLimitConfig] = None
    monthly_limit: Optional[MonthlyLeaveLimitConfig] = None
    notice_period_leave: Optional[NoticePeriodLeaveConfig] = None
    backdated_leave: Optional[BackdatedLeaveConfig] = None


def accrual_rules_error(
    is_paid_leave: bool,
    is_statutory_leave: bool,
    accrual: Optional["LeaveTypeAccrual"],
) -> Optional[str]:
    """
    Shared accrual / carry-forward business rules for a leave type.

    Returns an error message, or None when the (effective, possibly merged)
    configuration is valid:

      * Paid leave must declare how many leaves accrue and how often
        (annual_count + accrual_frequency). Statutory leave is exempt — its
        count comes from max_statutory_days.
      * Carry-forward, when enabled, must say how much carries over
        (carry_forward_count).
      * Unpaid leave can neither carry forward nor be encashed.
    """
    if is_paid_leave and not is_statutory_leave:
        if accrual is None or accrual.annual_count is None or accrual.accrual_frequency is None:
            return (
                "Paid leave requires accrual configuration: number of leaves "
                "and accrual frequency are mandatory"
            )
        # A year has at most 365 days — reject nonsensical allocations.
        if accrual.annual_count <= 0 or accrual.annual_count > 365:
            return "Number of leaves per year must be between 1 and 365"
    if accrual is not None:
        if accrual.carry_forward and accrual.carry_forward_count is None:
            return "Carry forward unused balance is required when carry forward is enabled"
        # Cannot carry more than is granted in a year.
        # if (
        #     accrual.carry_forward
        #     and accrual.carry_forward_count is not None
        #     and accrual.annual_count is not None
        #     # and accrual.carry_forward_count > accrual.annual_count
        # ):
        #     return "Carry-forward count cannot exceed the annual allocation"
        if not is_paid_leave and (accrual.carry_forward or accrual.encashable):
            return "Unpaid leave cannot carry forward or be encashed"
        if accrual.encashable:
            pct = accrual.encash_percentage
            if pct is None or pct <= 0 or pct > 100:
                return "Encashment percentage (1–100) is required when encashment is enabled"
    return None


class LeaveTypeCreate(CustomModel):
    org_id: Optional[str] = None
    name: str
    code: str
    # Display order within the org, 1-based. Every surface that lists leave
    # types (admin table, the employee's apply dropdown, the balance card)
    # orders by this. Omit it and the service assigns the next free rank, so a
    # client never has to compute one.
    rank: Optional[int] = Field(default=None, ge=1)
    unit: Literal["DAYS", "HOURS"] = "DAYS"
    is_paid: bool = True
    deduct_from_balance: bool = True
    restrictions: LeaveTypeRestrictions = Field(default_factory=LeaveTypeRestrictions)
    show_description: bool = False
    # Whether this leave type is surfaced in the analytics service. Left unset
    # (None) it is resolved in `_default_analytics_visibility` below: statutory
    # and sick types default to True (they drive the compliance / Bradford
    # metrics), everything else defaults to False. An explicit True/False from
    # the client is always kept.
    show_in_analytics: Optional[bool] = None
    # Whether this leave type appears in the employee's leave-balance list
    # (/leave-requests/balances). Defaults to False, so a type is excluded from
    # the balance view unless explicitly opted in (legacy types with no stored
    # value also read as hidden).
    show_in_leave_balance: bool = False
    is_paid_leave: bool = True
    deduct_from_leave_balance: bool = True
    is_sick_leave: bool = False
    is_statutory_leave: bool = False
    max_statutory_days: Optional[int] = None
    count_calendar_days: bool = False
    # Expiring / comp-off leave: has no accrued balance. Each request compensates
    # one or more non-working days the employee worked ("worked_dates"), and must
    # be availed within ``expiry_days`` of each worked day. Always paid; never
    # deducts from a balance; carries no accrual config.
    is_comp_off: bool = False
    expiry_days: Optional[int] = None
    # Unrestricted leave: anyone eligible for the type may apply without an
    # assigned balance, an entitlement policy, or an employment-status /
    # probation restriction. Approval rules still apply, and so do the
    # eligibility restrictions (gender / marital status) that decide who is
    # offered the type at all — "unrestricted" lifts the entitlement gates, not
    # who the type is for.
    is_unrestricted: bool = False
    # Only meaningful on an unrestricted type: surfaces "used N days this leave
    # year" to the employee applying and to the approver, since neither has a
    # balance to reason about. Defaults ON for that reason — without it there is
    # no number for either party to judge a request by. Cleared automatically
    # when the type is not unrestricted, so the default costs nothing elsewhere.
    show_usage_warning: bool = True
    # ADVISORY yearly cap. Enforces nothing — going past it neither blocks the
    # request nor converts it to LOP; it only triggers the "allocation exceeded"
    # email to the employee and their approvers. It exists because the types
    # that need that warning (WFH and other unrestricted / non-deducting leave)
    # carry no accrual, so `accrual.annual_count` is absent for exactly the
    # types where the warning matters. When unset, the warning falls back to
    # `accrual.annual_count`.
    annual_limit: Optional[int] = Field(default=None, ge=1, le=365)
    description: Optional[str] = None
    color: Optional[str] = None
    is_custom: bool = True
    # The leave type now carries its own accrual + policy configuration.
    accrual: Optional[LeaveTypeAccrual] = None
    policies: Optional[LeaveTypePolicies] = None

    @model_validator(mode="after")
    def _unrestricted_implies(self) -> "LeaveTypeCreate":
        # No balance is tracked for an unrestricted type, so it cannot deduct
        # from one — the same pairing comp-off enforces below. The usage warning
        # is meaningless without it, so it is cleared when the flag is off.
        if self.is_unrestricted:
            if self.is_statutory_leave:
                raise ValueError(
                    "A statutory leave type cannot be unrestricted — statutory "
                    "leave must deduct from a tracked balance"
                )
            self.deduct_from_balance = False
            self.deduct_from_leave_balance = False
            # Nothing accrues, so accrual/carry-forward config is meaningless —
            # cleared here and exempted in validate_accrual_rules, exactly as
            # comp-off does.
            self.accrual = None
        else:
            self.show_usage_warning = False
        return self

    @model_validator(mode="after")
    def _comp_off_implies(self) -> "LeaveTypeCreate":
        # An expiring (comp-off) type is always paid, never balance-deducting,
        # never statutory, and has no accrual. It just needs an expiry window.
        if self.is_comp_off:
            self.is_paid_leave = True
            self.is_paid = True
            self.deduct_from_balance = False
            self.deduct_from_leave_balance = False
            self.is_statutory_leave = False
            self.max_statutory_days = None
            self.accrual = None
            if self.expiry_days is None or self.expiry_days <= 0:
                raise ValueError("expiry_days must be greater than 0 for an expiring leave type")
        return self

    @model_validator(mode="after")
    def _statutory_implies_paid(self) -> "LeaveTypeCreate":
        # Statutory leave is always paid, always deducts from balance, and runs as
        # one continuous block — every calendar day in the span is charged,
        # including weekends and holidays. Force all of these on.
        if self.is_statutory_leave:
            self.is_paid_leave = True
            self.is_paid = True
            self.deduct_from_balance = True
            self.deduct_from_leave_balance = True
            self.count_calendar_days = True
        return self

    @model_validator(mode="after")
    def validate_statutory_days(self) -> "LeaveTypeCreate":
        if self.is_statutory_leave and self.max_statutory_days is None:
            raise ValueError("max_statutory_days is required when is_statutory_leave is True")
        return self

    @model_validator(mode="after")
    def validate_accrual_rules(self) -> "LeaveTypeCreate":
        # Comp-off / expiring and unrestricted leave carry no accrual config —
        # neither tracks a balance, so the accrual rules don't apply.
        if self.is_comp_off or self.is_unrestricted:
            return self
        # Paid leave → no. of leaves + frequency mandatory; carry-forward →
        # carry-forward count mandatory; unpaid → no carry/encash.
        err = accrual_rules_error(self.is_paid_leave, self.is_statutory_leave, self.accrual)
        if err:
            raise ValueError(err)
        return self

    @model_validator(mode="after")
    def _default_analytics_visibility(self) -> "LeaveTypeCreate":
        # Statutory and sick leave types feed the compliance and Bradford/burnout
        # analytics, so when a client omits show_in_analytics they default to
        # visible; every other type defaults to hidden. An explicit True/False is
        # always respected. This is a safety net for API clients that omit the
        # field — the admin UI sends it explicitly and never relies on this.
        if self.show_in_analytics is None:
            self.show_in_analytics = bool(self.is_statutory_leave or self.is_sick_leave)
        return self


class LeaveTypeUpdate(CustomModel):
    name: Optional[str] = None
    code: Optional[str] = None
    rank: Optional[int] = Field(default=None, ge=1)
    unit: Optional[Literal["DAYS", "HOURS"]] = None
    is_paid: Optional[bool] = None
    deduct_from_balance: Optional[bool] = None
    restrictions: Optional[LeaveTypeRestrictions] = None
    show_description: Optional[bool] = None
    show_in_analytics: Optional[bool] = None
    show_in_leave_balance: Optional[bool] = None
    is_paid_leave: Optional[bool] = None
    deduct_from_leave_balance: Optional[bool] = None
    is_sick_leave: Optional[bool] = None
    is_statutory_leave: Optional[bool] = None
    max_statutory_days: Optional[int] = None
    count_calendar_days: Optional[bool] = None
    is_comp_off: Optional[bool] = None
    expiry_days: Optional[int] = None
    is_unrestricted: Optional[bool] = None
    show_usage_warning: Optional[bool] = None
    annual_limit: Optional[int] = Field(default=None, ge=1, le=365)
    description: Optional[str] = None
    color: Optional[str] = None
    is_custom: Optional[bool] = None
    is_active: Optional[bool] = None
    accrual: Optional[LeaveTypeAccrual] = None
    policies: Optional[LeaveTypePolicies] = None

    @model_validator(mode="after")
    def _unrestricted_implies(self) -> "LeaveTypeUpdate":
        # Turning a type unrestricted clears the balance/accrual config so the
        # merged state stays consistent (assigning the fields marks them "set",
        # so exclude_unset persists the clears). Turning it OFF clears the usage
        # warning, which only means anything for an unrestricted type.
        if self.is_unrestricted is True:
            if self.is_statutory_leave is True:
                raise ValueError(
                    "A statutory leave type cannot be unrestricted — statutory "
                    "leave must deduct from a tracked balance"
                )
            self.deduct_from_balance = False
            self.deduct_from_leave_balance = False
            self.accrual = None
        elif self.is_unrestricted is False:
            self.show_usage_warning = False
        return self

    @model_validator(mode="after")
    def _comp_off_implies(self) -> "LeaveTypeUpdate":
        # Turning a type comp-off forces paid on and clears balance/accrual/
        # statutory config so the merged state stays consistent (setting the
        # fields marks them "set", so exclude_unset persists the clears).
        if self.is_comp_off is True:
            self.is_paid_leave = True
            self.is_paid = True
            self.deduct_from_balance = False
            self.deduct_from_leave_balance = False
            self.is_statutory_leave = False
            self.max_statutory_days = None
            self.accrual = None
            if self.expiry_days is None or self.expiry_days <= 0:
                raise ValueError("expiry_days must be greater than 0 for an expiring leave type")
        return self

    @model_validator(mode="after")
    def _statutory_implies_paid(self) -> "LeaveTypeUpdate":
        # Turning a type statutory forces paid + deduct-from-balance on so they
        # persist with the update (the merged-state check in the service relies
        # on this).
        if self.is_statutory_leave is True:
            self.is_paid_leave = True
            self.is_paid = True
            self.deduct_from_balance = True
            self.deduct_from_leave_balance = True
            self.count_calendar_days = True
        return self

    @model_validator(mode="after")
    def validate_statutory_days(self) -> "LeaveTypeUpdate":
        if self.is_statutory_leave is True and self.max_statutory_days is None:
            raise ValueError("max_statutory_days is required when setting is_statutory_leave to True")
        return self

    # Cross-field accrual rules for updates are enforced in the service against
    # the merged (persisted + payload) state, so partial updates can't bypass
    # them — see ``update_leave_type``.


class LeaveTypeUsagePlan(CustomModel):
    id: str
    name: str
    status: Optional[str] = None
    is_active: bool = False


class LeaveTypeUsageResponse(CustomModel):
    """Answers 'can this leave type be deleted, and what breaks if it is?'"""
    leave_type_id: str
    name: Optional[str] = None
    code: Optional[str] = None
    # Referenced by at least one leave plan (active or not).
    in_use: bool = False
    # False only when an ACTIVE plan uses it — deletion is refused outright.
    can_delete: bool = True
    # True when it is only on plans that were never activated — deletion is
    # allowed once the user acknowledges the warning (DELETE ?confirm=true).
    requires_confirmation: bool = False
    message: str
    active_plans: list[LeaveTypeUsagePlan] = Field(default_factory=list)
    inactive_plans: list[LeaveTypeUsagePlan] = Field(default_factory=list)
    # Informational: historical requests already raised against this type.
    leave_request_count: int = 0


class LeaveTypeResponse(AuditMixin):
    id: str = Field(alias="_id")
    org_id: Optional[str] = None
    name: str
    code: str
    # None only for types created before ranking existed and not yet
    # backfilled — those sort last (see ``leave_type_sort_key``).
    rank: Optional[int] = None
    unit: str
    is_paid: bool
    deduct_from_balance: bool
    restrictions: LeaveTypeRestrictions = Field(default_factory=LeaveTypeRestrictions)
    is_active: bool = True
    show_description: bool = False
    show_in_analytics: bool = False
    show_in_leave_balance: bool = False
    is_paid_leave: bool = True
    deduct_from_leave_balance: bool = True
    is_sick_leave: bool = False
    is_statutory_leave: bool = False
    max_statutory_days: Optional[int] = None
    count_calendar_days: bool = False
    is_comp_off: bool = False
    expiry_days: Optional[int] = None
    # Legacy rows predate both flags, so they read as False — the restricted
    # behaviour every existing type already has.
    is_unrestricted: bool = False
    show_usage_warning: bool = False
    # Advisory only — see LeaveTypeCreate.annual_limit.
    annual_limit: Optional[int] = None
    description: Optional[str] = None
    color: Optional[str] = None
    is_custom: bool = True
    accrual: Optional[LeaveTypeAccrual] = None
    policies: Optional[LeaveTypePolicies] = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "plan_id", "org_id", "business_unit_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        if "applicable_department_ids" in data:
            data["applicable_department_ids"] = [str(v) for v in data["applicable_department_ids"]]
        return data
