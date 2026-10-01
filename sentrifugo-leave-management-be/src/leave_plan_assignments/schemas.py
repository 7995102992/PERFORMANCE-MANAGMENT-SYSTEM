from datetime import datetime
from typing import Literal, Optional

from bson import ObjectId
from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


class LeavePlanAssignmentCreate(CustomModel):
    leave_plan_id: str
    scope_type: Literal["ORG", "BU", "DEPARTMENT"]
    business_unit_id: Optional[str] = None
    department_ids: Optional[list[str]] = None
    apply_to_whole_bu: bool = False
    priority: int = Field(ge=1, default=1)


class LeavePlanAssignmentResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    scope_type: str
    business_unit_id: Optional[str] = None
    department_id: Optional[str] = None
    priority: int
    is_active: bool = True

    @model_validator(mode="before")
    @classmethod
    def _coerce_oids_to_str(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "id", "leave_plan_id","business_unit_id", "department_id"):
            v = data.get(field)
            if isinstance(v, ObjectId):
                data[field] = str(v)
        return data


class EmployeeLeavePlanResponse(CustomModel):
    id: str = Field(alias="_id")
    employee_id: str
    leave_plan_id: str
    assignment_id: str
    resolved_at: datetime
