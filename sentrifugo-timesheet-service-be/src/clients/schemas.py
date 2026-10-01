from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from ..models import StatusEnum


def _coerce_object_id_list(v):
    """Validate an optional list of ObjectId-strings; empty/None → None, a bare
    string is accepted as a single-item list, any bad hex → error."""
    if not v:
        return None
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, (list, tuple)):
        raise ValueError("must be a list of ids")
    from bson import ObjectId
    out = []
    for item in v:
        if not item:
            continue
        if not ObjectId.is_valid(item):
            raise ValueError("must contain valid ids")
        out.append(str(item))
    return out or None


class ClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    contact_person: str = Field(min_length=1, max_length=255)
    contact_email: EmailStr | None = Field(None, max_length=255)
    contact_phone: str = Field(min_length=1, max_length=50)
    address: str | None = Field(None, max_length=500)
    country: str = Field(min_length=1, max_length=100)
    state: str = Field(min_length=1, max_length=100)
    fax: str | None = Field(None, max_length=50)
    contact_user_id: str | None = None
    portal_access_enabled: bool = False
    notes: str | None = Field(None, max_length=1000)
    business_unit_ids: list[str] | None = None
    department_ids: list[str] | None = None
    status: StatusEnum = StatusEnum.ACTIVE

    @field_validator("name", "contact_person", "country", "state", mode="before")
    @classmethod
    def _strip_required(cls, v: str | None) -> str:
        return (v or "").strip()

    @field_validator("contact_phone", mode="before")
    @classmethod
    def _strip_phone(cls, v: str | None) -> str:
        return (v or "").strip()

    @field_validator("contact_email", mode="before")
    @classmethod
    def _empty_email_to_none(cls, v):
        # treat omitted / null / blank as no email
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @field_validator("business_unit_ids", "department_ids", mode="before")
    @classmethod
    def _validate_id_lists(cls, v):
        return _coerce_object_id_list(v)


class ClientUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=1, max_length=255)
    contact_person: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    address: str | None = None
    country: str | None = None
    state: str | None = None
    fax: str | None = None
    contact_user_id: str | None = None
    portal_access_enabled: bool | None = None
    notes: str | None = None
    business_unit_ids: list[str] | None = None
    department_ids: list[str] | None = None
    status: StatusEnum | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    @field_validator("business_unit_ids", "department_ids", mode="before")
    @classmethod
    def _validate_id_lists(cls, v):
        return _coerce_object_id_list(v)


class BulkImportResult(BaseModel):
    total: int
    created: int
    errors: list[dict]


class ValidateRow(BaseModel):
    row: int
    status: str  # "new" | "existing" | "error"
    reason: str | None = None
    data: dict


class ValidateResult(BaseModel):
    total: int
    rows: list[ValidateRow]


class ClientOut(BaseModel):
    id: str
    organisation_id: str
    name: str
    contact_person: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    address: str | None = None
    country: str | None = None
    state: str | None = None
    fax: str | None = None
    contact_user_id: str | None = None
    portal_access_enabled: bool = False
    notes: str | None = None
    business_unit_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)
    business_unit_names: list[str] | None = None
    department_names: list[str] | None = None
    status: StatusEnum
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None
