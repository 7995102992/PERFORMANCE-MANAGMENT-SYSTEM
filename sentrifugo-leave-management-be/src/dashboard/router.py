from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from src.dashboard.schemas import EmployeeDashboardResponse, OrgOnLeaveResponse
from src.dashboard.service import get_employee_dashboard, get_org_on_leave_today
from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.exceptions import DomainException

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _require_org_admin(current_user: UserBase) -> None:
    if not (current_user.is_org_admin or current_user.is_super_admin):
        raise DomainException(
            message="Organisation admin access required",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )


@router.get("/employee", response_model=EmployeeDashboardResponse)
async def employee_dashboard(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> EmployeeDashboardResponse:
    """Leave-domain dashboard data for the signed-in employee."""
    data = await get_employee_dashboard(
        db,
        user_id=current_user.user_id,
        org_id=current_user.org_id or "",
    )
    return EmployeeDashboardResponse(**data)


@router.get("/org/on-leave-today", response_model=OrgOnLeaveResponse)
async def org_on_leave_today(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> OrgOnLeaveResponse:
    """Org-wide 'who is out today'. Organisation admins only."""
    _require_org_admin(current_user)
    data = await get_org_on_leave_today(db, org_id=current_user.org_id or "")
    return OrgOnLeaveResponse(**data)
