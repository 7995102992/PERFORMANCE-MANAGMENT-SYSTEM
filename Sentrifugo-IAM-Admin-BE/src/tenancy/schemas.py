from datetime import datetime
from typing import Literal

from pydantic import EmailStr, Field, field_validator

from src.models import CustomModel, ModuleEnum, OrgModule


SetupStatus = Literal["draft", "pending", "active"]


# ---------------------------------------------------------------------------
# Administrator (maps to a UserDocument — not stored on the org)
# ---------------------------------------------------------------------------
class AdministratorInput(CustomModel):
    """Admin contact captured at org creation; persisted as a UserDocument."""
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=40)


class AdministratorUpdate(CustomModel):
    """Partial admin update from the Edit Organisation screen.

    Fields land on the admin UserDocument (first_name / last_name / phone),
    not on the org record.  Email is immutable after creation.
    """
    name: str | None = Field(default=None, min_length=1, max_length=100)
    phone: str | None = Field(default=None, max_length=40)


# ---------------------------------------------------------------------------
# Organisation request schemas
# ---------------------------------------------------------------------------
class OrganisationCreate(CustomModel):
    """Input for super-admin 'Add New Organization' flow.

    Creates the org, creates the admin UserDocument, optionally sends the
    activation link. The administrator fields are split out because they
    land on a User, not on the Organisation.
    """
    legal_name: str = Field(min_length=1, max_length=200)
    address_id: str | None = None
    date_of_incorporation: datetime | None = None
    financial_year: str | None = None
    currency: str | None = None
    timezone: str | None = None
    logo_asset_id: str | None = None
    is_multiple_business_units: bool = False
    is_active: bool = True

    enabled_modules: list[OrgModule] = Field(default_factory=list)
    setup_status: SetupStatus = "draft"

    administrator: AdministratorInput
    send_activation: bool = True

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

    @field_validator("enabled_modules")
    @classmethod
    def _core_hr_mandatory(cls, v):
        codes = {m.code for m in v} if v else set()
        if ModuleEnum.CORE_HR not in codes:
            raise ValueError("Core HR is mandatory and must be in enabled_modules")
        for m in v:
            if m.code == ModuleEnum.CORE_HR:
                m.is_active = True
        return v


class OrganisationUpdate(CustomModel):
    """Partial update — all fields optional."""
    legal_name: str | None = Field(default=None, min_length=1, max_length=200)
    address_id: str | None = None
    date_of_incorporation: datetime | None = None
    financial_year: str | None = None
    currency: str | None = None
    timezone: str | None = None
    logo_asset_id: str | None = None
    is_multiple_business_units: bool | None = None
    is_active: bool | None = None

    enabled_modules: list[OrgModule] | None = None
    setup_status: SetupStatus | None = None

    # Admin-card edits from image 5 are routed to the admin UserDocument.
    administrator: AdministratorUpdate | None = None

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
    def _core_hr_mandatory(cls, v):
        if v is not None:
            codes = {m.code for m in v}
            if ModuleEnum.CORE_HR not in codes:
                raise ValueError("Core HR is mandatory and must be in enabled_modules")
            for m in v:
                if m.code == ModuleEnum.CORE_HR:
                    m.is_active = True
        return v


# ---------------------------------------------------------------------------
# Organisation response schemas
# ---------------------------------------------------------------------------
class AdministratorView(CustomModel):
    """Admin details resolved by joining the primary admin UserDocument."""
    user_id: str
    name: str
    email: str
    phone: str | None = None
    # Email waiting on confirmation, if any. The 'email' field above is still
    # the active one until the admin clicks the confirmation link.
    pending_email: str | None = None


class OrganisationResponse(CustomModel):
    """Super-admin view — only fields the super admin can see/edit."""
    id: str
    legal_name: str
    logo_asset_id: str | None = None
    is_active: bool
    enabled_modules: list[OrgModule]
    administrator: AdministratorView | None = None
    created_on: datetime | None = None
    modified_on: datetime | None = None

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


class OrganisationListItem(CustomModel):
    """Summary for the Super Admin dashboard organisations list."""
    id: str
    legal_name: str
    is_active: bool
    setup_status: SetupStatus | None = None
    enabled_modules_count: int
    active_modules_count: int
    created_on: datetime | None = None
