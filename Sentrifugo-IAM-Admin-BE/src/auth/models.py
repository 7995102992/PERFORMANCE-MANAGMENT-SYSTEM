"""Auth-domain Beanie ODM documents."""

from datetime import date, datetime
from typing import Literal, Optional
from uuid import uuid4

from beanie import Document, PydanticObjectId
from pydantic import Field, field_validator
from pymongo import ASCENDING, IndexModel

from src.models import AuditMixin, StatusEnum


class UserDocument(Document, AuditMixin):
    """Beanie ODM document for the 'users' collection.

    Uses MongoDB ObjectId for the primary key (_id).
    """

    email: str
    password_hash: Optional[str] = None

    @field_validator("email", "pending_email", mode="before")
    @classmethod
    def _normalize_email(cls, v):
        """Emails are case-insensitive in practice — store them lowercased so
        lookups (login, uniqueness) are consistent regardless of input casing."""
        return v.strip().lower() if isinstance(v, str) else v
    auth_method: Literal["azure_sso", "local", "seeded"] = "local"
    azure_oid: Optional[str] = None
    first_name: str
    last_name: str
    middle_name: Optional[str] = None
    phone: Optional[str] = None
    work_phone: Optional[str] = None
    work_phone_extension: Optional[str] = None
    avatar_url: Optional[str] = None
    dob: Optional[datetime] = None
    gender: Optional[PydanticObjectId] = None
    marital_status: Optional[PydanticObjectId] = None
    status: StatusEnum = StatusEnum.ACTIVE
    pending_email: Optional[str] = None
    last_login_at: Optional[datetime] = None
    password_changed_at: Optional[datetime] = None
    # Set once when the account first completes activation. ``None`` => the
    # account has never been activated (pending). This is the single source of
    # truth for "is this account pending activation?" — independent of status,
    # which also flips to INACTIVE on admin deactivation of an already-active user.
    activated_at: Optional[datetime] = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    organisation_id: Optional[PydanticObjectId] = None
    policy_ids: list[PydanticObjectId] = Field(default_factory=list)

    class Settings:
        name = "users"
        indexes = [
            IndexModel([("email", ASCENDING)], unique=True),
            IndexModel(
                [("azure_oid", ASCENDING)],
                unique=True,
                partialFilterExpression={"azure_oid": {"$type": "string"}},
            ),
            IndexModel([("organisation_id", ASCENDING)]),
        ]


class PasswordHistoryDocument(Document):
    """Stores previous password hashes to prevent reuse."""

    id: str = Field(default_factory=lambda: str(uuid4()))
    user_id: str
    password_hash: str
    changed_at: datetime

    class Settings:
        name = "password_history"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("changed_at", ASCENDING)]),
        ]
