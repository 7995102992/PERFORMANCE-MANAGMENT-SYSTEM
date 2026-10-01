from __future__ import annotations

from pydantic import BaseModel


class ProjectSummaryItem(BaseModel):
    project_id: str
    project_name: str | None = None
    total_hours: float = 0
    billable_hours: float = 0
    non_billable_hours: float = 0
    resource_count: int = 0


class EmployeeSummaryItem(BaseModel):
    user_id: str
    total_hours: float = 0
    billable_hours: float = 0
    non_billable_hours: float = 0
    submitted_count: int = 0
    approved_count: int = 0
