from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from ..models import StatusEnum


class _TaskSelection(BaseModel):
    """Shared task-selection handling for the create/update payloads.

    A resource is assigned either to specific tasks or to the project as a whole
    (no task), never both. ``task_ids`` is the multi-select form; the singular
    ``task_id`` is kept for existing callers and folded into the same list.
    """

    task_id: str | None = None
    task_ids: list[str] | None = None

    def selected_task_ids(self) -> list[str]:
        """Return the de-duplicated task ids to assign, order preserved.

        An empty list means a project-level assignment covering every task.
        """
        ids = list(self.task_ids or [])
        if self.task_id:
            ids.insert(0, self.task_id)
        return list(dict.fromkeys(i for i in ids if i))

    def selects_tasks(self) -> bool:
        """Whether the payload carries a task selection at all (vs leaving it alone)."""
        return bool({"task_id", "task_ids"} & self.model_fields_set)


class ResourceAssignmentCreate(_TaskSelection):
    user_id: str = Field(min_length=1)
    role: str | None = None
    allocation_percentage: int = Field(100, ge=0, le=100)
    billable_rate: float | None = None
    is_billable: bool = True
    start_date: str | None = None
    end_date: str | None = None


class ResourceAssignmentUpdate(_TaskSelection):
    model_config = ConfigDict(extra="forbid")
    role: str | None = None
    allocation_percentage: int | None = Field(None, ge=0, le=100)
    billable_rate: float | None = None
    is_billable: bool | None = None
    start_date: str | None = None
    end_date: str | None = None
    status: StatusEnum | None = None


class ResourceAssignmentDelete(BaseModel):
    """Remove a resource from a project, effective on a date.

    The allocation closes rather than disappearing: time can still be logged up to
    ``end_date``, after which entry is refused. The allocation is final — it accepts
    no further edits — and reads as removed, carrying the manager's comment.
    """

    model_config = ConfigDict(extra="forbid")
    comment: str = Field(min_length=1, max_length=1000)
    end_date: str = Field(description="ISO date the allocation ends on (inclusive)")


class ResourceAssignmentOut(BaseModel):
    id: str
    organisation_id: str
    project_id: str
    task_id: str | None = None
    user_id: str
    role: str | None = None
    allocation_percentage: int
    billable_rate: float | None = None
    is_billable: bool
    start_date: datetime | None = None
    end_date: datetime | None = None
    status: StatusEnum
    # "allocated" | "ending" | "removed" — derived from the release and its end date.
    allocation_status: str = "allocated"
    released_on: datetime | None = None
    removal_comment: str | None = None
    removal_history: list[dict] = Field(default_factory=list)
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None
