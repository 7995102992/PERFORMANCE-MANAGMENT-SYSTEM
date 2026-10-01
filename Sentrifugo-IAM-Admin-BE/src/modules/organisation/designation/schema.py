from typing import Optional
from beanie import PydanticObjectId
from pydantic import Field
from src.models import CustomModel


class PayGradeCompact(CustomModel):
    """Compact pay-grade reference for display on a designation."""
    id: PydanticObjectId = Field(..., alias="_id")
    name: str


class DesignationBase(CustomModel):
    organisation_id: Optional[PydanticObjectId] = Field(None, alias="organisationId")
    designation_name: str = Field(..., alias="designationName", min_length=1)
    description: str = ""
    # Pay grades assigned to this designation.
    pay_grade_ids: list[PydanticObjectId] = Field(default_factory=list, alias="payGradeIds")
    is_active: bool = True


class DesignationCreate(DesignationBase):
    # Designations no longer own a role/policy — roles are managed separately
    # and assigned directly to employees.
    pass


class DesignationResponse(DesignationBase):
    id: PydanticObjectId
    pay_grades: list[PayGradeCompact] = Field(default_factory=list, alias="payGrades")


class DesignationUpdate(CustomModel):
    designation_name: Optional[str] = Field(None, alias="designationName", min_length=1)
    description: Optional[str] = None
    pay_grade_ids: Optional[list[PydanticObjectId]] = Field(None, alias="payGradeIds")
    is_active: Optional[bool] = None
