from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase, get_current_user
from ..common.pagination import PageParams, page_params
from ..config import settings as app_settings
from . import service
from .schemas import (
    AttachmentAdd,
    TimesheetCreate,
    TimesheetEntryBulkSave,
    WeeklyTimesheetOut,
)

router = APIRouter(tags=["timesheets"])
_logger = logging.getLogger(__name__)

_MOD = "timesheet_management"
_MY = require_permission(_MOD, "my_timesheet")


async def _verify_internal_key(x_internal_key: str = Header(..., alias="X-Internal-Key")) -> None:
    if not app_settings.INTERNAL_API_KEY or x_internal_key != app_settings.INTERNAL_API_KEY:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.get("/my-timesheets/limits")
async def my_timesheet_limits(
    user: Annotated[UserBase, Depends(_MY)],
) -> dict:
    """The weekly hour cap applied to this employee's timesheets, or null if none.

    Gated by `my_timesheet` rather than `manage_settings`: an employee has to see
    the limit they are held to without being able to read or change settings.
    """
    return await service.get_my_limits(user)


@router.get("/my-timesheets/summary")
async def my_timesheet_summary(
    user: Annotated[UserBase, Depends(_MY)],
) -> dict:
    return await service.get_my_summary(user)


@router.get("/my-timesheets/dashboard")
async def my_timesheet_dashboard(
    user: Annotated[UserBase, Depends(_MY)],
) -> dict:
    return await service.get_my_dashboard(user)


@router.get("/org/timesheet-compliance")
async def org_timesheet_compliance(
    user: Annotated[UserBase, Depends(get_current_user)],
) -> dict:
    """Org-wide timesheet compliance for the current week. Org admins only."""
    if not (user.is_super_admin or user.is_org_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Organisation admin access required",
        )
    return await service.get_org_compliance(user)


@router.get("/my-timesheets/assigned-projects")
async def my_assigned_projects(
    user: Annotated[UserBase, Depends(_MY)],
) -> list:
    return await service.get_assigned_projects(user)


@router.get("/my-timesheets/assigned-projects/{project_id}/tasks")
async def my_assigned_project_tasks(
    project_id: str,
    user: Annotated[UserBase, Depends(_MY)],
) -> list:
    return await service.get_assigned_project_tasks(project_id, user)


@router.post("/my-timesheets", status_code=status.HTTP_201_CREATED, response_model=WeeklyTimesheetOut)
async def create_timesheet(
    body: TimesheetCreate,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.create_timesheet(body, user)


@router.get("/my-timesheets")
async def list_timesheets(
    user: Annotated[UserBase, Depends(_MY)],
    p: Annotated[PageParams, Depends(page_params)],
    timesheet_status: str | None = Query(None),
) -> dict:
    return await service.list_timesheets(user, p, timesheet_status=timesheet_status)


@router.get("/my-timesheets/{id}", response_model=WeeklyTimesheetOut)
async def get_timesheet(
    id: str,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.get_timesheet(id, user)


@router.post("/my-timesheets/{id}/entries", response_model=WeeklyTimesheetOut)
async def save_entries(
    id: str,
    body: TimesheetEntryBulkSave,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.save_entries(id, body, user)


@router.delete("/my-timesheets/{timesheet_id}/entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    timesheet_id: str,
    entry_id: str,
    user: Annotated[UserBase, Depends(_MY)],
) -> Response:
    await service.delete_entry(timesheet_id, entry_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/my-timesheets/{id}/submit", response_model=WeeklyTimesheetOut)
async def submit_timesheet(
    id: str,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.submit_timesheet(id, user)


@router.post("/my-timesheets/{id}/resubmit", response_model=WeeklyTimesheetOut)
async def resubmit_timesheet(
    id: str,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.resubmit_timesheet(id, user)


@router.post("/my-timesheets/{id}/attachments", response_model=WeeklyTimesheetOut)
async def add_attachment(
    id: str,
    body: AttachmentAdd,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.add_attachment(id, body, user)


@router.delete("/my-timesheets/{id}/attachments/{attachment_id}", response_model=WeeklyTimesheetOut)
async def remove_attachment(
    id: str,
    attachment_id: str,
    user: Annotated[UserBase, Depends(_MY)],
) -> WeeklyTimesheetOut:
    return await service.remove_attachment(id, attachment_id, user)


@router.post(
    "/internal/timesheets/auto-submit",
    tags=["internal"],
    dependencies=[Depends(_verify_internal_key)],
)
async def auto_submit_timesheets() -> dict:
    return await service.auto_submit_pending()
