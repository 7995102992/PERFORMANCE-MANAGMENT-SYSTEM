from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from src.attendance import service
from src.attendance.schemas import EmployeeDayAttendance
from src.dependencies import UserBase, get_current_user, require_permission

# Read-only. Punches are written to MongoDB by the separate collector service
# (sentrifugo-attendance-mssql-service), which runs inside the office LAN where
# the biometric MS SQL server lives. This backend only reads them for the
# calendar — there is no ingest or pull endpoint here.
router = APIRouter(prefix="/attendance", tags=["attendance"])


@router.get("/daily", response_model=list[EmployeeDayAttendance])
async def get_daily_attendance(
    current_user: Annotated[UserBase, Depends(require_permission("approve_as_hr"))],
    punch_date: date = Query(..., description="Date in YYYY-MM-DD format"),
):
    """Get attendance for all employees on a given date (HR view)."""
    return await service.get_all_employees_day(
        organisation_id=current_user.org_id,
        punch_date=punch_date,
    )


@router.get("/team/daily", response_model=list[EmployeeDayAttendance])
async def get_team_daily_attendance(
    current_user: Annotated[UserBase, Depends(require_permission("manager_attendance"))],
    punch_date: date = Query(..., description="Date in YYYY-MM-DD format"),
):
    """Daily attendance roster for the caller's direct (L1) reports.

    Gated by the dedicated `manager_attendance` permission and scoped to the
    caller's own reportees — a manager only ever sees their team.
    """
    return await service.get_team_day(
        organisation_id=current_user.org_id,
        manager_user_id=current_user.user_id,
        punch_date=punch_date,
    )


@router.get("/employee/{terminal_user_id}", response_model=EmployeeDayAttendance)
async def get_employee_attendance(
    terminal_user_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    punch_date: date = Query(..., description="Date in YYYY-MM-DD format"),
):
    """Get attendance for a single employee on a given date."""
    await service.authorize_employee_attendance_view(current_user, terminal_user_id)
    return await service.get_employee_day(
        organisation_id=current_user.org_id,
        terminal_user_id=terminal_user_id,
        punch_date=punch_date,
    )


@router.get("/employee/{terminal_user_id}/month", response_model=list[EmployeeDayAttendance])
async def get_employee_month_attendance(
    terminal_user_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    year: int = Query(...),
    month: int = Query(..., ge=1, le=12),
):
    """Get attendance for one employee for an entire month (calendar view)."""
    await service.authorize_employee_attendance_view(current_user, terminal_user_id)
    return await service.get_employee_month(
        organisation_id=current_user.org_id,
        terminal_user_id=terminal_user_id,
        year=year,
        month=month,
    )


@router.get("/my/daily", response_model=EmployeeDayAttendance)
async def get_my_attendance(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    punch_date: date = Query(..., description="Date in YYYY-MM-DD format"),
):
    """Get the logged-in user's own attendance for a given date."""
    return await service.get_my_day(
        organisation_id=current_user.org_id,
        employee_user_id=current_user.user_id,
        punch_date=punch_date,
    )


@router.get("/my/month", response_model=list[EmployeeDayAttendance])
async def get_my_month_attendance(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    year: int = Query(...),
    month: int = Query(..., ge=1, le=12),
):
    """Get the logged-in user's attendance for an entire month."""
    return await service.get_my_month(
        organisation_id=current_user.org_id,
        employee_user_id=current_user.user_id,
        year=year,
        month=month,
    )
