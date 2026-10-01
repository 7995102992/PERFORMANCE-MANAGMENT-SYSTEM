from typing import Literal, Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


class GrantAllocation(CustomModel):
    amount: int = Field(gt=0)
    unit: Literal["DAYS", "HOURS"]
    frequency: Literal["YEARLY", "HALF_YEARLY", "QUARTERLY", "MONTHLY"]


class CreditedYearUsage(CustomModel):
    allow_anytime: bool = True


class FirstMonthRestriction(CustomModel):
    enabled: bool = False
    # Optional so callers can omit it when the parent joining_rule is disabled.
    # Range validation (1–31) is enforced by JoiningRule only when the rule is active.
    cutoff_day: Optional[int] = Field(default=None)
    rule: Literal["NO_CREDIT_IF_JOIN_AFTER"] = "NO_CREDIT_IF_JOIN_AFTER"


class JoiningRule(CustomModel):
    enabled: bool = False
    first_month_restriction: FirstMonthRestriction = Field(
        default_factory=FirstMonthRestriction
    )

    @model_validator(mode="after")
    def _validate_restriction(self) -> "JoiningRule":
        fmr = self.first_month_restriction
        if not self.enabled:
            # Rule is off — clear any stale restriction data so it is never acted on.
            fmr.enabled = False
            fmr.cutoff_day = None
            return self
        if fmr.enabled:
            if fmr.cutoff_day is None:
                raise ValueError("cutoff_day is required when first_month_restriction is enabled")
            if not (1 <= fmr.cutoff_day <= 31):
                raise ValueError("cutoff_day must be between 1 and 31")
        return self


class ExtraLeave(CustomModel):
    status: Literal["ALLOWED", "NOT_ALLOWED"] = "NOT_ALLOWED"
    max_days: int = Field(default=0, ge=0)


class GrantPolicyCreate(CustomModel):
    # Allocation (how many leaves + frequency) now lives on the leave type, so
    # the grant policy is optional here — this step only carries joining rules,
    # extra leave, and credited-year usage.
    allocation: Optional[GrantAllocation] = None
    credited_year_usage: CreditedYearUsage = Field(default_factory=CreditedYearUsage)
    joining_rule: JoiningRule = Field(default_factory=JoiningRule)
    extra_leave: ExtraLeave = Field(default_factory=ExtraLeave)


class GrantPolicyUpdate(CustomModel):
    allocation: Optional[GrantAllocation] = None
    credited_year_usage: Optional[CreditedYearUsage] = None
    joining_rule: Optional[JoiningRule] = None
    extra_leave: Optional[ExtraLeave] = None


class GrantPolicyResponse(AuditMixin):
    id: str = Field(alias="_id")
    org_id: str
    leave_plan_id: str
    allocation: Optional[GrantAllocation] = None
    credited_year_usage: CreditedYearUsage
    joining_rule: JoiningRule
    extra_leave: ExtraLeave
    version: int
    is_active: bool
