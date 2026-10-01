from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from . import service

router = APIRouter(tags=["reports"])

_MOD = "timesheet_management"
_VIEW = require_permission(_MOD, "view_reports")


@router.get("/reports/project-summary")
async def get_project_summary(
    user: Annotated[UserBase, Depends(_VIEW)],
    client_id: str | None = Query(None),
) -> list:
    return await service.get_project_summary(user, client_id=client_id)


@router.get("/reports/employee-summary")
async def get_employee_summary(
    user: Annotated[UserBase, Depends(_VIEW)],
    project_id: str | None = Query(None),
) -> list:
    return await service.get_employee_summary(user, project_id=project_id)
