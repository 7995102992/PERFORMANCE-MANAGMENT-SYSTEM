from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from ..models import StatusEnum


class ClientProjectHeadCreate(BaseModel):
    client_id: str = Field(min_length=1)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    phone: str | None = Field(None, max_length=50)

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class ProjectHeadAssignItem(BaseModel):
    """One selected head — an internal employee or an external contact. Both groups in
    the /available response carry exactly these fields, so the picker maps 1:1."""
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    phone: str | None = Field(None, max_length=50)

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class ProjectHeadBulkAssign(BaseModel):
    client_id: str = Field(min_length=1)
    heads: list[ProjectHeadAssignItem] = Field(min_length=1)


class ClientProjectHeadUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_name: str | None = Field(None, min_length=1, max_length=100)
    last_name: str | None = Field(None, max_length=100)
    email: str | None = None
    phone: str | None = None
    status: StatusEnum | None = None

    @field_validator("first_name", "last_name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


class ClientProjectHeadOut(BaseModel):
    id: str
    organisation_id: str
    client_id: str
    first_name: str
    last_name: str
    email: str
    phone: str | None = None
    iam_user_id: str | None = None
    status: StatusEnum
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None
