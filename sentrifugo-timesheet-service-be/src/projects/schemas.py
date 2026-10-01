from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..models import BillableOnEnum, BillableRateTypeEnum, ProjectStatusEnum, ProjectTypeEnum, StatusEnum


class ProjectCreate(BaseModel):
    client_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=255)
    code: str | None = Field(None, max_length=50)
    description: str | None = None
    project_type: ProjectTypeEnum = ProjectTypeEnum.TIME_AND_MATERIALS
    start_date: str | None = None
    end_date: str | None = None
    budget_hours: float | None = None
    budget_cost: float | None = None
    billable_rate: float | None = None
    billable_rate_type: BillableRateTypeEnum | None = None
    billable_on: BillableOnEnum | None = None
    currency: str = "USD"
    project_head_ids: list[str] = []
    is_internal: bool = False
    send_alerts: int | None = None
    client_approval_required: bool = True

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=1, max_length=255)
    code: str | None = None
    description: str | None = None
    project_type: ProjectTypeEnum | None = None
    project_status: ProjectStatusEnum | None = None
    start_date: str | None = None
    end_date: str | None = None
    budget_hours: float | None = None
    budget_cost: float | None = None
    billable_rate: float | None = None
    billable_rate_type: BillableRateTypeEnum | None = None
    billable_on: BillableOnEnum | None = None
    currency: str | None = None
    project_head_ids: list[str] | None = None
    is_internal: bool | None = None
    send_alerts: int | None = None
    client_approval_required: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


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


class ProjectOut(BaseModel):
    id: str
    organisation_id: str
    client_id: str
    client_name: str | None = None
    name: str
    code: str | None = None
    description: str | None = None
    project_type: ProjectTypeEnum
    project_status: ProjectStatusEnum
    start_date: datetime | None = None
    end_date: datetime | None = None
    budget_hours: float | None = None
    budget_cost: float | None = None
    billable_rate: float | None = None
    billable_rate_type: BillableRateTypeEnum | None = None
    billable_on: BillableOnEnum | None = None
    currency: str = "USD"
    project_head_ids: list[str] = []
    project_head_names: list[str] = []
    is_internal: bool = False
    send_alerts: int | None = None
    client_approval_required: bool = True
    status: StatusEnum
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None
