from enum import Enum
from typing import List, Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SandwichRuleType(str, Enum):
    BETWEEN_TWO_LEAVE_DAYS = "between_two_leave_days"
    BEFORE_A_LEAVE_DAY = "before_a_leave_day"
    AFTER_A_LEAVE_DAY = "after_a_leave_day"
    BEFORE_OR_AFTER_LEAVE_DAY = "before_or_after_leave_day"
    BETWEEN_TWO_HOLIDAYS = "between_two_holidays"


class DurationUnit(str, Enum):
    DAYS = "days"
    HOURS = "hours"


class LevelOperator(str, Enum):
    AND = "AND"
    OR = "OR"


# ---------------------------------------------------------------------------
# Sandwich Policy
# ---------------------------------------------------------------------------

class SandwichPolicyUpsert(CustomModel):
    enabled: bool = False
    apply_rule_when: SandwichRuleType
    minimum_consecutive_value: int = Field(gt=0)
    minimum_consecutive_unit: DurationUnit
    ignore_half_day_leaves: bool = True


class SandwichPolicyResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    enabled: bool
    apply_rule_when: SandwichRuleType
    minimum_consecutive_value: int
    minimum_consecutive_unit: DurationUnit
    ignore_half_day_leaves: bool

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "leave_plan_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        return data


# ---------------------------------------------------------------------------
# Approval Policy
# ---------------------------------------------------------------------------

class ApprovalLevelRequest(CustomModel):
    level: int = Field(ge=1, le=2)


class ApprovalLevelResponse(CustomModel):
    level: int


class ApprovalPolicyUpsert(CustomModel):
    approval_required: bool = False
    approval_levels: List[ApprovalLevelRequest] = Field(default_factory=list)
    levels_operator: Optional[LevelOperator] = None
    # HR overrides (plan-level): allow users holding the HR permission to act on
    # (approve/reject) and to view leave requests under this plan.
    allow_hr_to_act: bool = False
    allow_hr_to_view: bool = False

    @model_validator(mode="after")
    def _validate_levels(self):
        if self.approval_required and not self.approval_levels:
            raise ValueError("approval_levels cannot be empty when approval_required is True")

        levels = [lvl.level for lvl in self.approval_levels]

        if len(levels) > 2:
            raise ValueError("A maximum of 2 approval levels is allowed")

        if len(levels) != len(set(levels)):
            raise ValueError("Duplicate level numbers are not allowed")

        if levels and sorted(levels) != list(range(1, len(levels) + 1)):
            raise ValueError("Level numbers must be sequential starting from 1")

        if len(levels) == 2 and self.levels_operator is None:
            raise ValueError("levels_operator (AND/OR) is required when two approval levels are configured")

        if len(levels) < 2 and self.levels_operator is not None:
            raise ValueError("levels_operator is only applicable when two approval levels are configured")

        return self


class ApprovalPolicyResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    approval_required: bool
    approval_levels: List[ApprovalLevelResponse] = Field(default_factory=list)
    levels_operator: Optional[LevelOperator] = None
    allow_hr_to_act: bool = False
    allow_hr_to_view: bool = False

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "leave_plan_id"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        return data
