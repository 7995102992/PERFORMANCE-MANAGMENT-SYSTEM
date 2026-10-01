from datetime import datetime
from typing import Optional

from pydantic import Field, model_validator

from src.models import CustomModel


class HolidayPlanEmployeeSync(CustomModel):
    user_ids: list[str]


class HolidayPlanEmployeesByDepartments(CustomModel):
    department_ids: list[str] = Field(default_factory=list)


class HolidayPlanEmployeeEntry(CustomModel):
    id: str = Field(alias="_id")
    plan_id: str
    user_id: str
    created_on: Optional[datetime] = None
    created_by: Optional[str] = None
    # Enriched from the LMS employee mirror so the FE renders members directly
    # from this response (no IAM employee fetch + client-side join).
    name: Optional[str] = None
    emp_code: Optional[str] = None
    work_email: Optional[str] = None
    department_name: Optional[str] = None
    business_unit_name: Optional[str] = None
    designation_name: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "plan_id", "user_id", "created_by"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        return data
