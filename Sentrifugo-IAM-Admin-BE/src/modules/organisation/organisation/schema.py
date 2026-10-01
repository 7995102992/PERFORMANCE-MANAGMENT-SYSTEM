from datetime import date
from typing import Literal, Optional
from beanie import PydanticObjectId
from pydantic import Field, field_validator
from src.models import CustomModel, ModuleEnum, OrgModule
from src.modules.organisation.addresses.schema import AddressCreate, AddressResponse
from src.modules.custom_fields.schema import FieldWithValue

class OrganisationBase(CustomModel):
    legal_name: str = Field(min_length=1)
    date_of_incorporation: Optional[date] = None
    financial_year: Optional[str] = None
    currency: Optional[str] = None
    timezone: Optional[str] = None
    is_multiple_business_units: bool
    is_active: bool = True

class OrganisationCreate(OrganisationBase):
    address: AddressCreate
    logo_asset_id: Optional[PydanticObjectId] = None
    admin_email: str = Field(min_length=1)
    admin_first_name: str = Field(min_length=1)
    admin_last_name: str = Field(min_length=1)

class OrganisationResponse(OrganisationBase):
    id: PydanticObjectId
    address_id: Optional[PydanticObjectId] = None
    head_user_id: Optional[PydanticObjectId] = None
    address: Optional[AddressResponse] = None
    logo_asset_id: Optional[PydanticObjectId] = None
    logo_url: Optional[str] = None
    head_employee_name: Optional[str] = None
    setup_status: Optional[str] = None
    setup_progress: dict[str, str] = Field(default_factory=dict)
    custom_fields: list[FieldWithValue] = Field(default_factory=list)
    enabled_modules: list[OrgModule] = Field(default_factory=list)

    @field_validator("enabled_modules", mode="before")
    @classmethod
    def _coerce_modules(cls, v):
        if v is None:
            return []
        result = []
        for item in v:
            if isinstance(item, str):
                result.append({"code": item, "is_active": True})
            elif isinstance(item, (dict, OrgModule)):
                result.append(item)
            else:
                result.append({"code": str(item), "is_active": True})
        return result

class OrganisationUpdate(CustomModel):
    legal_name: Optional[str] = Field(None, min_length=1)
    head_user_id: Optional[PydanticObjectId] = None
    address: Optional[AddressCreate] = None
    date_of_incorporation: Optional[date] = None
    financial_year: Optional[str] = None
    currency: Optional[str] = None
    timezone: Optional[str] = None
    logo_asset_id: Optional[PydanticObjectId] = None
    is_multiple_business_units: Optional[bool] = None
    is_active: Optional[bool] = None
    setup_status: Optional[Literal["draft", "pending", "active"]] = None
    enabled_modules: Optional[list[OrgModule]] = None

    @field_validator("enabled_modules", mode="before")
    @classmethod
    def _coerce_modules(cls, v):
        if v is None:
            return v
        result = []
        for item in v:
            if isinstance(item, str):
                result.append({"code": item, "is_active": True})
            elif isinstance(item, (dict, OrgModule)):
                result.append(item)
            else:
                result.append({"code": str(item), "is_active": True})
        return result

    @field_validator("enabled_modules")
    @classmethod
    def _core_hr_mandatory(cls, v: list[OrgModule] | None) -> list[OrgModule] | None:
        if v is not None:
            codes = {m.code for m in v}
            if ModuleEnum.CORE_HR not in codes:
                raise ValueError("Core HR is mandatory and must be in enabled_modules")
            for m in v:
                if m.code == ModuleEnum.CORE_HR:
                    m.is_active = True
        return v
