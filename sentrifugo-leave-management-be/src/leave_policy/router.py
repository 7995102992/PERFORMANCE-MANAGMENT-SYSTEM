from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user, require_permission
from src.exceptions import DomainException
from src.leave_policy.schemas import (
    ApprovalPolicyResponse,
    ApprovalPolicyUpsert,
    SandwichPolicyResponse,
    SandwichPolicyUpsert,
)
from src.leave_policy.service import (
    get_approval_policy,
    get_sandwich_policy,
    upsert_approval_policy,
    upsert_sandwich_policy,
)

router = APIRouter(tags=["leave-policy"])


def _require_org_id(current_user: UserBase) -> str:
    if not current_user.org_id:
        raise DomainException(
            message="Organisation context is required",
            code="ORG_CONTEXT_MISSING",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return current_user.org_id


@router.get("/leave-plans/{leave_plan_id}/sandwich-policy", response_model=SandwichPolicyResponse)
async def get_sandwich(
    leave_plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> SandwichPolicyResponse:
    org_id = _require_org_id(current_user)
    doc = await get_sandwich_policy(db, leave_plan_id, org_id)
    return SandwichPolicyResponse(**doc)


@router.put("/leave-plans/{leave_plan_id}/sandwich-policy", response_model=SandwichPolicyResponse)
async def upsert_sandwich(
    leave_plan_id: str,
    payload: SandwichPolicyUpsert,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> SandwichPolicyResponse:
    org_id = _require_org_id(current_user)
    doc = await upsert_sandwich_policy(db, leave_plan_id, payload, current_user.user_id, org_id)
    return SandwichPolicyResponse(**doc)


@router.get("/leave-plans/{leave_plan_id}/approval-policy", response_model=ApprovalPolicyResponse)
async def get_approval(
    leave_plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ApprovalPolicyResponse:
    org_id = _require_org_id(current_user)
    doc = await get_approval_policy(db, leave_plan_id, org_id)
    return ApprovalPolicyResponse(**doc)


@router.put("/leave-plans/{leave_plan_id}/approval-policy", response_model=ApprovalPolicyResponse)
async def upsert_approval(
    leave_plan_id: str,
    payload: ApprovalPolicyUpsert,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> ApprovalPolicyResponse:
    org_id = _require_org_id(current_user)
    doc = await upsert_approval_policy(db, leave_plan_id, payload, current_user.user_id, org_id)
    return ApprovalPolicyResponse(**doc)
