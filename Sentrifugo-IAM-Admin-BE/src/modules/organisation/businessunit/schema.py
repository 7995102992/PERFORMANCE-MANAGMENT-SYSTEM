import re
from datetime import datetime
from typing import Optional
from beanie import PydanticObjectId
from pydantic import Field, field_validator
from src.models import CustomModel, MasterDataCompact
from src.modules.organisation.addresses.schema import AddressCreate, AddressResponse
from src.modules.custom_fields.schema import FieldWithValue

class EmpCodeStartFrom(CustomModel):
    # Digit string — leading zeros are significant and define the zero-pad width.
    # "006" → first code 006 (width 3); "1" → first code 1 (no padding); "0001" → 0001.
    full_time: str = Field("0", alias="fullTime")
    contract: str = Field("0")
    internship: str = Field("0")

    @field_validator("full_time", "contract", "internship", mode="before")
    @classmethod
    def _coerce_digits(cls, v):
        s = ("0" if v is None else str(v)).strip() or "0"
        if not re.fullmatch(r"\d{1,7}", s):
            raise ValueError("must be 1–7 digits; leading zeros allowed (e.g. 006, 0001)")
        return s


class BusinessUnitBase(CustomModel):
    organisation_id: Optional[PydanticObjectId] = None
    head_user_id: Optional[PydanticObjectId] = None
    business_unit_name: str = Field(min_length=1)
    emp_code_prefix: str = Field(min_length=1, max_length=10)
    emp_code_start_from: Optional[EmpCodeStartFrom] = Field(None, alias="empCodeStartFrom")
    ein: Optional[str] = None
    sector: Optional[PydanticObjectId] = None
    type_of_business: Optional[PydanticObjectId] = None
    nature_of_business: Optional[PydanticObjectId] = None
    date_of_incorporation: datetime
    financial_year: Optional[str] = None
    currency: Optional[str] = None
    time_zone: Optional[str] = None
    time_format: Optional[str] = None
    is_subsidiary: bool = Field(False, alias="isSubsidiary")
    is_active: bool = True

class BusinessUnitCreate(BusinessUnitBase):
    address: AddressCreate
    emp_code_start_from: EmpCodeStartFrom = Field(..., alias="empCodeStartFrom")

class EmpCodeStartFromResponse(CustomModel):
    # Padded digit strings rebuilt from the stored number + width (e.g. "006").
    full_time: str = Field("0", alias="F")
    contract: str = Field("0", alias="C")
    internship: str = Field("0", alias="I")


class BusinessUnitResponse(BusinessUnitBase):
    id: PydanticObjectId
    address_id: PydanticObjectId
    address: Optional[AddressResponse] = None
    head_employee_name: Optional[str] = None
    head_emp_code: Optional[str] = None
    emp_code_start_from: Optional[EmpCodeStartFromResponse] = Field(None, alias="empCodeStartFrom")
    has_employees: bool = Field(False, alias="hasEmployees")
    sector: Optional[MasterDataCompact] = None
    type_of_business: Optional[MasterDataCompact] = None
    nature_of_business: Optional[MasterDataCompact] = None
    custom_fields: list[FieldWithValue] = Field(default_factory=list)


class BulkDeleteRequest(CustomModel):
    ids: list[PydanticObjectId] = Field(..., min_length=1)

class BusinessUnitUpdate(CustomModel):
    head_user_id: Optional[PydanticObjectId] = None
    address: Optional[AddressCreate] = None
    business_unit_name: Optional[str] = Field(None, min_length=1)
    emp_code_prefix: Optional[str] = Field(None, min_length=1, max_length=10)
    emp_code_start_from: Optional[EmpCodeStartFrom] = Field(None, alias="empCodeStartFrom")
    emp_code_padding: Optional[int] = Field(None, alias="empCodePadding", ge=0, le=10)
    ein: Optional[str] = None
    sector: Optional[PydanticObjectId] = None
    type_of_business: Optional[PydanticObjectId] = None
    nature_of_business: Optional[PydanticObjectId] = None
    date_of_incorporation: Optional[datetime] = None
    financial_year: Optional[str] = None
    currency: Optional[str] = None
    time_zone: Optional[str] = None
    time_format: Optional[str] = None
    is_subsidiary: Optional[bool] = Field(None, alias="isSubsidiary")
    is_active: Optional[bool] = None
