from typing import Optional

from pydantic import Field, model_validator
from bson import ObjectId

from src.models import AuditMixin, CustomModel


class LeavePlanTypeMappingCreate(CustomModel):
    leave_type_id: str


class LeavePlanTypeMappingResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    leave_type_id: str
    org_id: str
    @model_validator(mode="before")
    @classmethod
    def _coerce_audit_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id", "leave_plan_id", "leave_type_id"):
            v = data.get(field)
            if v is not None and isinstance(v, ObjectId):
                data[field] = str(v)
        return data


class LeaveTypeRemovalCheckResponse(CustomModel):
    """Answers 'can this leave type be taken off the plan, and if not, why?'"""
    leave_plan_id: str
    leave_type_id: str
    name: Optional[str] = None
    can_remove: bool = True
    # The plan is live — its type list is frozen regardless of dependencies.
    plan_is_active: bool = False
    # Later steps of this plan that point at the type, e.g.
    # "probation settings (probation leave type)".
    used_by: list[str] = Field(default_factory=list)
    message: str


class LeaveTypeRestrictions(CustomModel):
    gender: Optional[str] = None
    marital_status: Optional[str] = None


class LeaveTypeSummary(CustomModel):
    id: str = Field(alias="_id")
    name: str
    code: str
    unit: str
    is_custom: bool
    is_paid: bool = True
    is_paid_leave: bool = True
    deduct_from_balance: bool = True
    deduct_from_leave_balance: bool = True
    is_sick_leave: bool = False
    is_statutory_leave: bool = False
    max_statutory_days: Optional[int] = None
    show_description: bool = False
    restrictions: LeaveTypeRestrictions = Field(default_factory=LeaveTypeRestrictions)
    is_active: bool = True
    description: Optional[str] = None
    color: Optional[str] = None
    # Per-leave-type accrual + carry config (and the relocated policies). Kept as
    # pass-through dicts so the plan wizard receives the full settings unchanged.
    accrual: Optional[dict] = None
    policies: Optional[dict] = None


class LeavePlanTypeDetailResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    org_id: str
    leave_type: LeaveTypeSummary
    @model_validator(mode="before")
    @classmethod
    def _coerce_audit_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id", "leave_plan_id"):
            v = data.get(field)
            if v is not None and isinstance(v, ObjectId):
                data[field] = str(v)
        return data
