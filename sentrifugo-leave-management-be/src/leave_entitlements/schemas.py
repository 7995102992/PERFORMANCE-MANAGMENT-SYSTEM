from enum import Enum
from typing import List, Optional

from pydantic import Field, field_validator, model_validator

from src.models import AuditMixin, CustomModel
# joining_rule + extra_leave were relocated here from the (now slimmed) grant
# policy step, so the entitlement config owns them. Imported from their original
# home to keep a single definition; no import cycle (grant schemas only depend
# on src.models).
from src.leave_grant_policy.schemas import ExtraLeave, JoiningRule


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class DistributionMode(str, Enum):
    ALL_AT_ONCE = "all_at_once"
    STEP_BY_STEP = "step_by_step"


class AccrualFrequency(str, Enum):
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    HALF_YEARLY = "half_yearly"
    YEARLY = "yearly"


class MidYearJoiningMode(str, Enum):
    PRO_RATE = "pro_rate"
    CREDIT_JOINING_MONTH = "credit_joining_month"


class ProbationCreditMode(str, Enum):
    SAME_FOR_ALL = "same_for_all"
    TIERED_BY_DURATION = "tiered_by_duration"


class ProbationCreditStart(str, Enum):
    START_DATE = "start_date"
    CONFIRMATION_DATE = "confirmation_date"


class FractionRoundingMode(str, Enum):
    EXACT = "exact"
    NEAREST_HALF = "nearest_half"
    NEAREST_ONE = "nearest_one"
    ROUND_UP = "round_up"
    ROUND_DOWN = "round_down"


class CreditTimingMode(str, Enum):
    BEFORE_MONTH_START = "before_month_start"
    NO_CHANGE = "no_change"
    DO_NOT_CREDIT_NOTICE = "do_not_credit_notice"
    LAST_MONTH_PRORATED = "last_month_prorated"


class CommentRequirementMode(str, Enum):
    MANDATORY = "mandatory"
    OPTIONAL = "optional"
    NOT_REQUIRED = "not_required"


class NoticePeriodLeaveMode(str, Enum):
    BLOCK = "block"
    ALLOW_WITH_NOTICE_EXTENSION = "allow_with_extension"


class NegativeBalanceApprovalMode(str, Enum):
    AUTO_DEDUCT = "auto_deduct"
    REQUIRE_APPROVAL = "require_approval"


# ---------------------------------------------------------------------------
# Nested config models
# ---------------------------------------------------------------------------

class StepAccrualRule(CustomModel):
    from_day: int
    to_day: int
    allocation: float
    unit: str


class PostingCycleRule(CustomModel):
    leave_type_id: str
    value: int
    unit: str
    # Per-leave-type accrual frequency. Replaces the plan-level
    # ``DistributionConfig.accrual_frequency`` (kept below only for reading
    # legacy plans). When None, consumers fall back to the plan-level value.
    accrual_frequency: Optional[AccrualFrequency] = None
    # Whether this leave type's balance carries forward at year-end. Acts as a
    # gate on the plan's Year-End Processing config (which still defines how
    # much carries forward).
    carry_forward: bool = False


class DistributionConfig(CustomModel):
    enabled: bool
    mode: DistributionMode
    # DEPRECATED (plan-level). Accrual frequency is now per-leave-type on each
    # PostingCycleRule. Retained, optional, only so existing plans still read
    # and so the accrual engine can fall back for rows without a per-type value.
    accrual_frequency: Optional[AccrualFrequency] = None
    policy_cycle_start_day: Optional[int] = None
    posting_cycles: List[PostingCycleRule] = Field(default_factory=list)
    step_rules: List[StepAccrualRule] = Field(default_factory=list)


class MidYearSlabRule(CustomModel):
    from_date: str
    to_date: str
    allocation: float
    unit: str


_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
_CUM_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]


def _parse_ddmm(v) -> Optional[tuple]:
    """Parse a "DD-MM" string into (day, month); None for any other format."""
    if not isinstance(v, str) or len(v) != 5 or v[2] != "-":
        return None
    try:
        d, m = int(v[:2]), int(v[3:])
    except ValueError:
        return None
    if not (1 <= m <= 12) or not (1 <= d <= _DAYS_IN_MONTH[m - 1]):
        return None
    return d, m


def _ddmm_days_in_range(from_date, to_date) -> Optional[int]:
    """Inclusive day count of a "DD-MM" range (handles year-crossing). None when
    either date isn't a "DD-MM" string (legacy/ISO data is left unchecked)."""
    a = _parse_ddmm(from_date)
    b = _parse_ddmm(to_date)
    if not a or not b:
        return None
    fa = _CUM_DAYS[a[1] - 1] + a[0]
    tb = _CUM_DAYS[b[1] - 1] + b[0]
    return (tb - fa + 1) if fa <= tb else (366 - fa + 1 + tb)


_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _uncovered_months(slabs) -> List[str]:
    """Month names not fully covered by the union of slab ranges. Empty list when
    fully covered, or when any slab date isn't "DD-MM" (legacy data is skipped)."""
    covered = [False] * 367
    for s in slabs:
        a = _parse_ddmm(s.from_date)
        b = _parse_ddmm(s.to_date)
        if not a or not b:
            return []  # legacy / non-DD-MM data — don't enforce coverage
        fa = _CUM_DAYS[a[1] - 1] + a[0]
        tb = _CUM_DAYS[b[1] - 1] + b[0]
        if fa <= tb:
            for i in range(fa, tb + 1):
                covered[i] = True
        else:
            for i in range(fa, 367):
                covered[i] = True
            for i in range(1, tb + 1):
                covered[i] = True
    out: List[str] = []
    for m in range(1, 13):
        start = _CUM_DAYS[m - 1] + 1
        end = _CUM_DAYS[m - 1] + _DAYS_IN_MONTH[m - 1]
        if not all(covered[i] for i in range(start, end + 1)):
            out.append(_MONTH_NAMES[m - 1])
    return out


class MidYearJoiningConfig(CustomModel):
    # NOTE: `enabled` was removed from the contract. Behaviour is driven by
    # `mode` (and `slab_rules` when `mode == credit_joining_month`). Old
    # documents that still have `enabled` are ignored on load.
    mode: Optional[MidYearJoiningMode] = None
    slab_rules: List[MidYearSlabRule] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_slabs(self) -> "MidYearJoiningConfig":
        # Credit-for-joining-month needs at least one slab, and a slab can't
        # grant more leave than the number of days its date range spans.
        if self.mode == MidYearJoiningMode.CREDIT_JOINING_MONTH:
            if not self.slab_rules:
                raise ValueError(
                    "At least one slab rule is required when mid-year mode is credit_joining_month"
                )
            for s in self.slab_rules:
                days = _ddmm_days_in_range(s.from_date, s.to_date)
                if days is not None and s.allocation > days:
                    raise ValueError(
                        f"Slab allocation ({s.allocation}) cannot exceed the {days} days "
                        f"in range {s.from_date}–{s.to_date}"
                    )
            # Every month must be covered by some slab (any split is allowed).
            uncovered = _uncovered_months(self.slab_rules)
            if uncovered:
                raise ValueError(
                    "All 12 months must be covered by slab rules; not covered: "
                    + ", ".join(uncovered)
                )
        return self


class BandRule(CustomModel):
    from_month: int
    to_month: int
    credit_amount: float
    unit: str


def probation_leave_type_ids(probation_cfg: Optional[dict]) -> List[str]:
    """The configured probation leave types, read from a raw stored config.

    Every consumer reads the persisted dict rather than the model, so this is the
    one place that knows the plural field superseded the singular one. Plans
    saved before multi-select carry only ``probation_leave_type_id``; both shapes
    resolve to a list here, so no reader has to care which it is.
    """
    cfg = probation_cfg or {}
    ids = cfg.get("probation_leave_type_ids") or []
    if not ids:
        single = cfg.get("probation_leave_type_id")
        ids = [single] if single else []
    return [str(lt_id) for lt_id in ids if lt_id]


class ProbationConfig(CustomModel):
    enabled: bool
    credit_mode: Optional[ProbationCreditMode] = None
    credit_start: Optional[ProbationCreditStart] = None
    probation_duration_months: Optional[int] = None
    band_rules: List[BandRule] = Field(default_factory=list)
    # DEPRECATED, read-only for plans saved before multi-select. Folded into
    # ``probation_leave_type_ids`` by ``_normalize_leave_types`` — read the list,
    # never this.
    probation_leave_type_id: Optional[str] = None
    # The leave types a probationer is funded into (by the bands) and the only
    # types they may apply for while in probation. Empty → legacy behaviour
    # (bands credit every type, no apply restriction).
    #
    # Each selected type is credited at the band's own rate: a band of 1 day per
    # month with three types selected grants 1 day into each, not a third each.
    # The band configuration is untouched by the count of types.
    probation_leave_type_ids: List[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _normalize_leave_types(self) -> "ProbationConfig":
        """Make the list the single source of truth.

        Stored configs predate the list and carry only the singular id, so it is
        folded in when the list is empty. The singular is then kept in sync so a
        rolling deploy — old readers alongside new — cannot see an empty value
        where one type is configured.
        """
        if not self.probation_leave_type_ids and self.probation_leave_type_id:
            self.probation_leave_type_ids = [self.probation_leave_type_id]
        # De-duplicate while preserving the admin's order.
        seen: set[str] = set()
        deduped: List[str] = []
        for lt_id in self.probation_leave_type_ids:
            key = str(lt_id)
            if key and key not in seen:
                seen.add(key)
                deduped.append(key)
        self.probation_leave_type_ids = deduped
        self.probation_leave_type_id = deduped[0] if deduped else None
        return self

    @model_validator(mode="after")
    def _validate_tiered(self) -> "ProbationConfig":
        # Tiered credit needs a start point; crediting from the start date also
        # needs the probation duration. (same_for_all and credit-from-confirmation
        # have no further required fields.)
        if self.enabled and self.credit_mode == ProbationCreditMode.TIERED_BY_DURATION:
            if self.credit_start is None:
                raise ValueError(
                    "credit_start (start_date or confirmation_date) is required for "
                    "tiered_by_duration probation credit"
                )
            if (
                self.credit_start == ProbationCreditStart.START_DATE
                and self.probation_duration_months is None
            ):
                raise ValueError(
                    "probation_duration_months is required when crediting from the start date"
                )
        return self


class FutureLeaveRequestConfig(CustomModel):
    allow_future_requests: bool = True
    allow_based_on_projected_balance: bool


class NegativeBalanceConfig(CustomModel):
    allow_negative_balance: bool
    max_negative_balance: Optional[float] = None
    approval_required: bool
    approval_mode: Optional[NegativeBalanceApprovalMode] = None


class FractionHandlingConfig(CustomModel):
    mode: FractionRoundingMode


class CreditExpiryConfig(CustomModel):
    expiry_enabled: bool
    expiry_period_value: Optional[int] = None
    expiry_period_unit: Optional[str] = None
    expiry_at_cycle_end: bool


class DateRangeCreditRule(CustomModel):
    from_day: int
    to_day: int
    credit_day: int
    allocation_days: float


class CreditTimingConfig(CustomModel):
    mode: Optional[CreditTimingMode] = None
    date_rules: List[DateRangeCreditRule] = Field(default_factory=list)


class UploadRequirementConfig(CustomModel):
    mandatory: bool
    required_after_days: Optional[int] = None


class CommentRequirementConfig(CustomModel):
    mode: CommentRequirementMode


class RequestLimitConfig(CustomModel):
    max_requests_allowed: Optional[int] = None
    period: Optional[str] = None
    enforce_gap: bool
    gap_days: Optional[int] = None


class ClubbingConfig(CustomModel):
    enabled: bool
    restricted_leave_type_ids: List[str] = Field(default_factory=list)


class ContinuousLeaveLimitConfig(CustomModel):
    enabled: bool
    max_consecutive_days: Optional[int] = None
    include_weekends: bool
    include_holidays: bool

    @model_validator(mode="after")
    def _validate_max(self) -> "ContinuousLeaveLimitConfig":
        if self.enabled and (self.max_consecutive_days is None or self.max_consecutive_days < 1):
            raise ValueError(
                "max_consecutive_days is required and must be >= 1 when the continuous leave limit is enabled"
            )
        return self


class MonthlyLeaveLimitConfig(CustomModel):
    enabled: bool
    max_days_per_month: Optional[int] = None

    @model_validator(mode="after")
    def _validate_max(self) -> "MonthlyLeaveLimitConfig":
        if self.enabled and (self.max_days_per_month is None or self.max_days_per_month <= 0):
            raise ValueError(
                "max_days_per_month is required and must be > 0 when the monthly leave limit is enabled"
            )
        return self


class NoticePeriodLeaveConfig(CustomModel):
    mode: Optional[NoticePeriodLeaveMode] = None


class BackdatedLeaveConfig(CustomModel):
    enabled: bool
    max_days: Optional[int] = None

    @field_validator("max_days")
    @classmethod
    def max_days_must_be_positive(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 1:
            raise ValueError("max_days must be >= 1")
        return v


class EntitlementConfig(CustomModel):
    distribution: DistributionConfig
    mid_year_joining: MidYearJoiningConfig
    probation: ProbationConfig
    future_request: FutureLeaveRequestConfig
    negative_balance: NegativeBalanceConfig
    fractional_balance: FractionHandlingConfig
    credit_expiry: CreditExpiryConfig
    credit_timing: CreditTimingConfig
    upload_requirement: UploadRequirementConfig
    comment_requirement: CommentRequirementConfig
    request_limits: RequestLimitConfig
    clubbing: ClubbingConfig
    continuous_limit: ContinuousLeaveLimitConfig
    monthly_limit: MonthlyLeaveLimitConfig
    notice_period_leave: NoticePeriodLeaveConfig
    backdated_leave: BackdatedLeaveConfig = Field(
        default_factory=lambda: BackdatedLeaveConfig(enabled=False, max_days=None)
    )
    # Relocated from the grant policy step (which is being merged into this
    # config). Optional so entitlement docs saved before the merge still load.
    joining_rule: Optional[JoiningRule] = None
    extra_leave: Optional[ExtraLeave] = None


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class LeaveEntitlementCreate(CustomModel):
    leave_plan_id: str
    entitlement: EntitlementConfig


class LeaveEntitlementUpdate(CustomModel):
    entitlement: Optional[EntitlementConfig] = None
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class LeaveEntitlementSummary(CustomModel):
    id: str = Field(alias="_id")
    org_id: str
    leave_plan_id: str
    is_active: bool

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id", "leave_plan_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        return data


class LeaveEntitlementResponse(AuditMixin):
    id: str = Field(alias="_id")
    org_id: str
    leave_plan_id: str
    entitlement: EntitlementConfig
    is_active: bool

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id", "leave_plan_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        entitlement = data.get("entitlement")
        if isinstance(entitlement, dict):
            clubbing = entitlement.get("clubbing")
            if isinstance(clubbing, dict) and clubbing.get("restricted_leave_type_ids"):
                clubbing["restricted_leave_type_ids"] = [
                    str(i) for i in clubbing["restricted_leave_type_ids"]
                ]
        return data
