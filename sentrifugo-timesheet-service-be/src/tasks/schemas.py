from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..models import StatusEnum


class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    is_global: bool = False
    is_billable: bool = True
    is_time_off: bool = False
    is_frequent: bool = False
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class TaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    is_global: bool | None = None
    is_billable: bool | None = None
    is_time_off: bool | None = None
    is_frequent: bool | None = None
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None
    status: StatusEnum | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


class TaskOut(BaseModel):
    id: str
    organisation_id: str
    project_id: str | None = None
    name: str
    description: str | None = None
    is_global: bool
    is_billable: bool
    is_time_off: bool = False
    is_frequent: bool = False
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None
    status: StatusEnum
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None


class BulkImportResult(BaseModel):
    total: int
    created: int
    linked: int = 0
    errors: list[dict]


class ValidateRow(BaseModel):
    row: int
    status: str  # "new" | "existing" | "error"
    reason: str | None = None
    data: dict


class ValidateResult(BaseModel):
    total: int
    rows: list[ValidateRow]


class ProjectTaskCreate(BaseModel):
    """Add a task to a project, either by linking an existing shared task or by
    creating a new one that belongs to this project.

    Pass ``task_id`` to link, or ``name`` (plus any of the other fields) to create.
    A created task is owned by the project — another project may carry a task of the
    same name — unless ``is_global`` or ``is_frequent`` is set, which makes it a
    shared organisation-level task instead.
    """

    model_config = ConfigDict(extra="forbid")
    task_id: str | None = Field(None, min_length=1)
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    is_global: bool = False
    is_billable: bool = True
    is_time_off: bool = False
    is_frequent: bool = False
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None
    add_to_all_existing: bool = False

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _link_or_create(self) -> ProjectTaskCreate:
        if bool(self.task_id) == bool(self.name):
            raise ValueError("provide either task_id (to link an existing task) or name (to create one)")
        return self


class ProjectTaskUpdate(BaseModel):
    """Edit a task from inside a project — the same fields the add-task form offers.

    ``estimated_hours`` / ``billable_rate`` / ``notes`` are per-project overrides
    stored on the link; the remaining fields edit the shared task record and are
    therefore visible in every project the task is assigned to.
    """

    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    is_global: bool | None = None
    is_billable: bool | None = None
    is_time_off: bool | None = None
    is_frequent: bool | None = None
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


class ProjectTaskOut(BaseModel):
    id: str
    project_id: str
    task_id: str
    task_name: str | None = None
    description: str | None = None
    is_global: bool = False
    is_billable: bool | None = None
    is_time_off: bool = False
    is_frequent: bool = False
    is_active: bool
    estimated_hours: float | None = None
    billable_rate: float | None = None
    notes: str | None = None
    created_on: datetime | None = None
