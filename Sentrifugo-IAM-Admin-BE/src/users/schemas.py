from datetime import datetime
from typing import Literal

from beanie import PydanticObjectId
from pydantic import EmailStr, Field

from src.models import CustomModel, MetadataMixin, StatusEnum


class UserCreate(CustomModel):
    """Input schema for creating a user."""
    email: EmailStr
    password: str | None = Field(default=None, min_length=8, max_length=128)
    auth_method: Literal["azure_sso", "local"] = "local"
    azure_oid: str | None = None
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    phone: str | None = Field(default=None, max_length=40)
    avatar_url: str | None = None
    avatar_asset_id: str | None = None
    dob: datetime | None = None
    gender: str | PydanticObjectId | None = None
    marital_status: str | PydanticObjectId | None = None
    organisation_id: str | None = None
    is_org_admin: bool = False
    send_activation: bool = False


class UserUpdate(CustomModel):
    """Input schema for updating a user. All fields optional.

    Email is immutable after creation — not accepted here.
    """
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    phone: str | None = Field(default=None, max_length=40)
    avatar_url: str | None = None
    avatar_asset_id: str | None = None
    dob: datetime | None = None
    gender: str | PydanticObjectId | None = None
    marital_status: str | PydanticObjectId | None = None
    status: StatusEnum | None = None
    is_org_admin: bool | None = None


class MeUpdate(CustomModel):
    """Self-service profile update via PUT /me.

    Excludes email, status, is_org_admin, policy_ids, organisation_id, and
    password — those go through admin or dedicated flows (change-password,
    email-change verification, role assignment).
    """
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    phone: str | None = Field(default=None, max_length=40)
    dob: datetime | None = None
    gender: str | PydanticObjectId | None = None
    marital_status: str | PydanticObjectId | None = None


class UserResponse(CustomModel):
    """Output schema returned to clients. Never includes password_hash."""
    id: str
    email: str
    auth_method: str
    azure_oid: str | None = None
    first_name: str
    last_name: str
    middle_name: str | None = None
    phone: str | None = None
    avatar_url: str | None = None
    avatar_asset_id: str | None = None
    dob: datetime | None = None
    gender: str | PydanticObjectId | None = None
    marital_status: str | PydanticObjectId | None = None
    status: StatusEnum
    organisation_id: str | None = None
    is_org_admin: bool = False
    pending_email: str | None = None
    policy_ids: list[str] = []
    last_login_at: datetime | None = None
    password_changed_at: datetime | None = None
    activated_at: datetime | None = None
    # True when the account has never been activated → eligible for resend.
    activation_pending: bool = False
    created_on: datetime | None = None
    modified_on: datetime | None = None


class UserInDB(MetadataMixin):
    """Internal schema representing the full user document in MongoDB."""
    id: str
    email: str
    password_hash: str | None = None
    auth_method: Literal["azure_sso", "local"] = "local"
    azure_oid: str | None = None
    first_name: str
    last_name: str
    middle_name: str | None = None
    avatar_url: str | None = None
    avatar_asset_id: str | None = None
    last_login_at: datetime | None = None
