"""Analytics endpoints.

  GET /analytics/roles               → dashboards the caller may view + default
  GET /analytics/dashboard?role=...  → a role dashboard (defaults to the
                                       caller's most-privileged entitled role)

Mounted under the service API prefix in main.py, e.g.
``/api/v1/service-requests/analytics``.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from ..auth.utils.dependencies import UserBase, get_current_user
from .bu import build_bu_comparison, list_business_units
from .schemas import (
    AnalyticsRole,
    AvailableRoles,
    BuComparisonResponse,
    BusinessUnitInfo,
    BusinessUnitsResponse,
    DashboardResponse,
    RoleInfo,
)
from .scoping import ROLE_LABELS, default_role_from, entitled_roles, is_entitled
from .service import build_dashboard

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/roles", response_model=AvailableRoles)
async def list_dashboards(
    user: Annotated[UserBase, Depends(get_current_user)],
) -> AvailableRoles:
    roles = await entitled_roles(user)
    return AvailableRoles(
        roles=[RoleInfo(role=r, label=ROLE_LABELS[r]) for r in roles],
        default=default_role_from(roles),
    )


@router.get("/dashboard", response_model=DashboardResponse)
async def get_dashboard(
    user: Annotated[UserBase, Depends(get_current_user)],
    role: AnalyticsRole | None = None,
    business_unit_id: str | None = None,
) -> DashboardResponse:
    # A role is named (common case): one cheap grant-OR-derived check. Otherwise
    # compute the full entitled set just to pick the default dashboard.
    if role is not None:
        if not await is_entitled(user, role):
            raise HTTPException(status_code=403, detail=f"Not entitled to the '{role.value}' dashboard")
        target = role
    else:
        target = default_role_from(await entitled_roles(user))
    return await build_dashboard(user, target, business_unit_id=business_unit_id)


@router.get("/business-units", response_model=BusinessUnitsResponse)
async def business_units(
    user: Annotated[UserBase, Depends(get_current_user)],
) -> BusinessUnitsResponse:
    """Business units selectable on the CXO dashboard (View-BU / Compare-BUs)."""
    if not await is_entitled(user, AnalyticsRole.CXO):
        raise HTTPException(status_code=403, detail="Not entitled to the organisation dashboard")
    return BusinessUnitsResponse(business_units=[BusinessUnitInfo(**b) for b in await list_business_units(user)])


@router.get("/bu-comparison", response_model=BuComparisonResponse)
async def bu_comparison(
    user: Annotated[UserBase, Depends(get_current_user)],
) -> BuComparisonResponse:
    """Compare-BUs view: key metrics + SLA-compliance trend across business units."""
    if not await is_entitled(user, AnalyticsRole.CXO):
        raise HTTPException(status_code=403, detail="Not entitled to the organisation dashboard")
    return BuComparisonResponse(charts=await build_bu_comparison(user))
