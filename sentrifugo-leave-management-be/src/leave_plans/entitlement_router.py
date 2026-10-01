from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.exceptions import DomainException
from src.leave_plans.service import _assert_plan_pending, _get_raw_leave_plan
from src.leave_entitlements.schemas import (
    LeaveEntitlementCreate,
    LeaveEntitlementResponse,
    LeaveEntitlementSummary,
    LeaveEntitlementUpdate,
)
from src.leave_entitlements.service import (
    create_leave_entitlement,
    get_leave_entitlement_by_plan,
    get_leave_entitlements,
    update_leave_entitlement_by_plan,
)

router = APIRouter(prefix="/leave-plans", tags=["leave-entitlements"])


def _require_org_id(current_user: UserBase) -> str:
    if not current_user.org_id:
        raise DomainException(
            message="Organisation context is required",
            code="ORG_CONTEXT_MISSING",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return current_user.org_id


@router.post("/entitlements", response_model=LeaveEntitlementResponse, status_code=status.HTTP_201_CREATED)
async def create_entitlement(
    payload: LeaveEntitlementCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveEntitlementResponse:
    org_id = _require_org_id(current_user)
    doc = await create_leave_entitlement(db, payload, current_user.user_id, org_id)
    return LeaveEntitlementResponse(**doc)


@router.get("/{plan_id}/entitlements", response_model=Optional[LeaveEntitlementResponse])
async def get_entitlement_by_plan(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> Optional[LeaveEntitlementResponse]:
    org_id = _require_org_id(current_user)
    doc = await get_leave_entitlement_by_plan(db, plan_id, org_id, must_exist=False)
    return LeaveEntitlementResponse(**doc) if doc else None


@router.put("/{plan_id}/entitlements", response_model=LeaveEntitlementResponse)
async def update_entitlement_by_plan(
    plan_id: str,
    payload: LeaveEntitlementUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveEntitlementResponse:
    org_id = _require_org_id(current_user)
    plan = await _get_raw_leave_plan(db, plan_id)
    _assert_plan_pending(plan)
    doc = await update_leave_entitlement_by_plan(db, plan_id, payload, current_user.user_id, org_id)
    return LeaveEntitlementResponse(**doc)
