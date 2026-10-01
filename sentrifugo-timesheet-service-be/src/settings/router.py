from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from . import service
from .schemas import (
    ApprovalSettingsUpdate,
    HourSettingsUpdate,
    SubmissionSettingsUpdate,
    TimesheetSettingsOut,
)

router = APIRouter(tags=["settings"])

_MOD = "timesheet_management"
_MANAGE = require_permission(_MOD, "manage_settings")


@router.get("/settings", response_model=TimesheetSettingsOut)
async def get_settings(
    user: Annotated[UserBase, Depends(_MANAGE)],
    project_id: str | None = Query(None),
) -> TimesheetSettingsOut:
    return await service.get_settings(user, project_id=project_id)


@router.get("/settings/employment-types")
async def list_employment_types(
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> list[dict]:
    """Employment types available to this organisation, as `{key, value}`.

    Populates the picker for `notification_excluded_employment_types`; the key is
    what the setting stores.
    """
    return await service.list_employment_types(user)


@router.put("/settings/hours", response_model=TimesheetSettingsOut)
async def update_hour_settings(
    body: HourSettingsUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
    project_id: str | None = Query(None),
) -> TimesheetSettingsOut:
    return await service.update_hour_settings(body, user, project_id=project_id)


@router.put("/settings/submission", response_model=TimesheetSettingsOut)
async def update_submission_settings(
    body: SubmissionSettingsUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
    project_id: str | None = Query(None),
) -> TimesheetSettingsOut:
    return await service.update_submission_settings(body, user, project_id=project_id)


@router.put("/settings/approval", response_model=TimesheetSettingsOut)
async def update_approval_settings(
    body: ApprovalSettingsUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
    project_id: str | None = Query(None),
) -> TimesheetSettingsOut:
    return await service.update_approval_settings(body, user, project_id=project_id)
