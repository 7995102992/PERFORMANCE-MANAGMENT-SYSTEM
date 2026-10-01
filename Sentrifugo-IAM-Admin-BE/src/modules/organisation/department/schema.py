from typing import Optional
from beanie import PydanticObjectId
from pydantic import Field
from src.models import CustomModel

class DepartmentBase(CustomModel):
    organisation_id: Optional[PydanticObjectId] = Field(None, alias="organisationId")
    business_units: list[PydanticObjectId] = Field(..., alias="businessUnits", min_length=1)
    primary_business_unit: Optional[PydanticObjectId] = Field(None, alias="primaryBusinessUnit")
    department_name: str = Field(..., alias="departmentName", min_length=1)
    department_code: Optional[str] = Field(None, alias="departmentCode")
    description: Optional[str] = None
    department_head: Optional[PydanticObjectId] = Field(None, alias="departmentHead")
    is_active: bool = True

class DepartmentCreate(DepartmentBase):
    pass

class PrimaryBusinessUnitCompact(CustomModel):
    id: PydanticObjectId = Field(..., alias="_id")
    business_unit_name: str = Field(..., alias="businessUnitName")


class DepartmentResponse(DepartmentBase):
    id: PydanticObjectId
    primary_business_unit_data: Optional[PrimaryBusinessUnitCompact] = Field(None, alias="primaryBusinessUnitData")
    department_head_name: Optional[str] = Field(None, alias="departmentHeadName")
    business_unit_names: list[str] = Field(default_factory=list, alias="businessUnitNames")

class DepartmentUpdate(CustomModel):
    business_units: Optional[list[PydanticObjectId]] = Field(None, alias="businessUnits", min_length=1)
    primary_business_unit: Optional[PydanticObjectId] = Field(None, alias="primaryBusinessUnit")
    department_name: Optional[str] = Field(None, alias="departmentName", min_length=1)
    department_code: Optional[str] = Field(None, alias="departmentCode")
    description: Optional[str] = None
    department_head: Optional[PydanticObjectId] = Field(None, alias="departmentHead")
    is_active: Optional[bool] = None
