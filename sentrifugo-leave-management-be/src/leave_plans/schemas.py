from typing import Literal, Optional

from pydantic import Field, model_validator

from src.assets.schemas import AssetResponse
from src.models import AuditMixin, CustomModel
from bson import ObjectId


class Allocation(CustomModel):
    amount: int = Field(ge=1)
    unit: Literal["DAYS", "HOURS"]
    frequency: Literal["YEARLY", "HALF_YEARLY", "QUARTERLY", "MONTHLY"]

    @model_validator(mode="after")
    def _validate_amount_max(self) -> "Allocation":
        max_val = 365 if self.unit == "DAYS" else 2920
        if self.amount > max_val:
            raise ValueError(f"amount must be <= {max_val} when unit is {self.unit}")
        return self


class ExtraLeave(CustomModel):
    status: Literal["ALLOWED", "NOT_ALLOWED"]
    max_days: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _validate_max_days(self) -> "ExtraLeave":
        if self.status == "ALLOWED" and self.max_days < 1:
            raise ValueError("max_days must be >= 1 when status is ALLOWED")
        return self


class FirstMonthRestriction(CustomModel):
    enabled: bool = False
    # Optional so the config saves/loads when the restriction is OFF (the FE sends
    # 0 by default and older docs stored None). A real 1–31 day is only required
    # when the restriction is enabled (enforced below) — matching the FE.
    cutoff_day: Optional[int] = Field(default=None, ge=0, le=31)

    @model_validator(mode="after")
    def _validate_cutoff(self) -> "FirstMonthRestriction":
        if self.enabled and not (self.cutoff_day and 1 <= self.cutoff_day <= 31):
            raise ValueError(
                "cutoff_day must be between 1 and 31 when the first-month restriction is enabled"
            )
        return self


class JoiningRule(CustomModel):
    enabled: bool = False
    first_month_restriction: FirstMonthRestriction

    @model_validator(mode="after")
    def _coerce_first_month_restriction(self) -> "JoiningRule":
        if not self.enabled:
            self.first_month_restriction.enabled = False
        return self


class GrantPolicyPayload(CustomModel):
    allocation: Allocation
    extra_leave: ExtraLeave
    joining_rule: JoiningRule


class LeavePlanCreate(CustomModel):
    org_id: str
    name: str
    calendar_start_month: int = Field(ge=1, le=12, default=1)
    asset_id: Optional[str] = None
    business_unit_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_required(self) -> "LeavePlanCreate":
        # Step 1 of the wizard: name + at least one BU and one department.
        if not self.name or not self.name.strip():
            raise ValueError("Leave plan name is required")
        if not self.business_unit_ids:
            raise ValueError("At least one business unit is required")
        if not self.department_ids:
            raise ValueError("At least one department is required")
        return self


class LeavePlanUpdate(CustomModel):
    name: Optional[str] = None
    calendar_start_month: Optional[int] = Field(default=None, ge=1, le=12)
    asset_id: Optional[str] = None
    progress: Optional[int] = Field(default=None, ge=1)
    business_unit_ids: Optional[list[str]] = None
    department_ids: Optional[list[str]] = None

    @model_validator(mode="after")
    def _validate_when_present(self) -> "LeavePlanUpdate":
        # Partial update: only enforce the rule for fields actually supplied, so
        # progress-only / asset-only updates still work. When the step-1 edit
        # sends these fields, they must stay valid (name non-empty, BU/dept >= 1).
        if self.name is not None and not self.name.strip():
            raise ValueError("Leave plan name cannot be empty")
        if self.business_unit_ids is not None and len(self.business_unit_ids) == 0:
            raise ValueError("At least one business unit is required")
        if self.department_ids is not None and len(self.department_ids) == 0:
            raise ValueError("At least one department is required")
        return self


class LeavePlanLeaveTypesPayload(CustomModel):
    leave_type_ids: list[str]


class EntityRef(CustomModel):
    id: str
    name: str


class LeavePlanResponse(AuditMixin):
    id: str = Field(alias="_id")
    org_id: str
    name: str
    calendar_start_month: int
    asset: Optional[AssetResponse] = None
    status: Literal["pending_configuration", "active", "inactive"] = "pending_configuration"
    is_active: bool = False
    progress: int = 1
    business_unit_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)
    leave_type_ids: list[str] = Field(default_factory=list)
    grant_policy: Optional[GrantPolicyPayload] = None
    business_units: list[EntityRef] = Field(default_factory=list)
    departments: list[EntityRef] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce_audit_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id", "leave_plan_id"):
            v = data.get(field)
            if v is not None and isinstance(v, ObjectId):
                data[field] = str(v)
        for field in ("business_unit_ids", "department_ids", "leave_type_ids"):
            lst = data.get(field)
            if lst:
                data[field] = [str(v) if isinstance(v, ObjectId) else v for v in lst]
        # is_active is always derived from status — never read from the stored field
        data["is_active"] = data.get("status") == "active"
        return data


class PolicyDocumentMeta(CustomModel):
    id: str
    leave_plan_id: str
    original_filename: str
    content_type: str
    size: int
