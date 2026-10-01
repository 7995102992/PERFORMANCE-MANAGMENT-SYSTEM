from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from . import service

router = APIRouter(tags=["analytics"])

_MOD = "timesheet_management"
_MY = require_permission(_MOD, "my_timesheet")
_MANAGER = require_permission(_MOD, "manage_timesheet")
_VIEW = require_permission(_MOD, "view_reports")


@router.get("/analytics/employee/descriptive")
async def employee_descriptive(
    user: Annotated[UserBase, Depends(_MY)],
    cal_month: int | None = Query(None, ge=1, le=12),
    cal_year: int | None = Query(None, ge=2020, le=2100),
) -> dict:
    return await service.get_employee_descriptive(user, cal_year=cal_year, cal_month=cal_month)


@router.get("/analytics/manager/descriptive")
async def manager_descriptive(
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> dict:
    return await service.get_manager_descriptive(user)


@router.get("/analytics/hr/descriptive")
async def hr_descriptive(
    user: Annotated[UserBase, Depends(_VIEW)],
    bu: str | None = Query(None),
) -> dict:
    return await service.get_hr_descriptive(user, bu_filter=bu)


@router.get("/analytics/cfo/descriptive")
async def cfo_descriptive(
    user: Annotated[UserBase, Depends(_VIEW)],
    bu: str | None = Query(None),
) -> dict:
    return await service.get_cfo_descriptive(user, bu_filter=bu)


@router.get("/analytics/md/descriptive")
async def md_descriptive(
    user: Annotated[UserBase, Depends(_VIEW)],
) -> dict:
    return await service.get_md_descriptive(user)
