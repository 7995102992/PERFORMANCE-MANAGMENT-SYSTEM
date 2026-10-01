from fastapi import APIRouter, Depends, HTTPException, status
from typing import Annotated

from beanie import PydanticObjectId

from src.auth.utils.authorization import require_super_admin, require_permission
from src.auth.utils.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.dashboard.schemas import (
    BirthdaysResponse,
    DashboardStats,
    HeadcountSnapshot,
    OrgDashboardStats,
)
from src.dashboard.service import (
    get_dashboard_stats,
    get_headcount_snapshot,
    get_org_birthdays,
    get_org_dashboard_stats,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats", response_model=DashboardStats)
async def fetch_stats(
    current_user: Annotated[UserBase, Depends(require_super_admin)],
) -> DashboardStats:
    return await get_dashboard_stats()


@router.get("/org-stats", response_model=OrgDashboardStats)
async def fetch_org_stats(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
) -> OrgDashboardStats:
    if not current_user.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return await get_org_dashboard_stats(PydanticObjectId(current_user.organisation_id))


@router.get("/headcount-snapshot", response_model=HeadcountSnapshot)
async def fetch_headcount_snapshot(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
) -> HeadcountSnapshot:
    if not current_user.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return await get_headcount_snapshot(PydanticObjectId(current_user.organisation_id))


@router.get("/birthdays", response_model=BirthdaysResponse)
async def fetch_birthdays(
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> BirthdaysResponse:
    """Org-wide birthdays (today + upcoming). Visible to any authenticated user."""
    if not current_user.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return await get_org_birthdays(PydanticObjectId(current_user.organisation_id))
