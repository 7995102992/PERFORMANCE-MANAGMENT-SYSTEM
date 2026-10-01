from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.leave_grant_policy.schemas import (
    GrantPolicyCreate,
    GrantPolicyResponse,
    GrantPolicyUpdate,
)
from src.leave_grant_policy.service import (
    get_policy_by_plan,
    update_grant_policy,
    upsert_grant_policy,
)

router = APIRouter(prefix="/leave-plans", tags=["leave-grant-policy"])


@router.post(
    "/{plan_id}/grant-policy",
    response_model=GrantPolicyResponse,
    status_code=status.HTTP_200_OK,
)
async def save_grant_policy(
    plan_id: str,
    payload: GrantPolicyCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> GrantPolicyResponse:
    doc = await upsert_grant_policy(db, plan_id, payload, current_user.user_id)
    return GrantPolicyResponse(**doc)


@router.get("/{plan_id}/grant-policy", response_model=Optional[GrantPolicyResponse])
async def get_by_plan(
    plan_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> Optional[GrantPolicyResponse]:
    doc = await get_policy_by_plan(db, plan_id, must_exist=False)
    return GrantPolicyResponse(**doc) if doc else None


@router.put("/{plan_id}/grant-policy/{policy_id}", response_model=GrantPolicyResponse)
async def update(
    plan_id: str,
    policy_id: str,
    payload: GrantPolicyUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> GrantPolicyResponse:
    doc = await update_grant_policy(db, policy_id, payload, current_user.user_id)
    return GrantPolicyResponse(**doc)

