from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.exceptions import DomainException
from src.leave_plan_type_mapping.schemas import (
    LeavePlanTypeDetailResponse,
    LeavePlanTypeMappingCreate,
    LeavePlanTypeMappingResponse,
    LeaveTypeRemovalCheckResponse,
)
from src.leave_plan_type_mapping.service import (
    add_leave_type_to_plan,
    list_leave_types_for_plan,
    remove_leave_type_from_plan,
)
from src.leave_plans.service import check_leave_type_removable

router = APIRouter(tags=["leave-plan-type-mapping"])


def _require_org_id(user: UserBase) -> str:
    if not user.org_id:
        raise DomainException(
            message="Authenticated user is missing an org_id",
            code="MISSING_ORG_CONTEXT",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return user.org_id


@router.post(
    "/leave-plans/{plan_id}/leave-types",
    response_model=LeavePlanTypeMappingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_type_to_plan(
    plan_id: str,
    payload: LeavePlanTypeMappingCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanTypeMappingResponse:
    org_id = _require_org_id(current_user)
    doc = await add_leave_type_to_plan(
        db, plan_id, payload.leave_type_id, org_id, current_user.user_id
    )
    return LeavePlanTypeMappingResponse(**doc)


@router.get(
    "/leave-plans/{plan_id}/leave-types",
    response_model=list[LeavePlanTypeDetailResponse],
)
async def fetch_types_for_plan(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[LeavePlanTypeDetailResponse]:
    org_id = _require_org_id(current_user)
    docs = await list_leave_types_for_plan(db, plan_id, org_id)
    return [LeavePlanTypeDetailResponse(**d) for d in docs]


@router.get(
    "/leave-plans/{plan_id}/leave-types/{leave_type_id}/removal-check",
    response_model=LeaveTypeRemovalCheckResponse,
)
async def check_type_removable(
    plan_id: str,
    leave_type_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveTypeRemovalCheckResponse:
    """Pre-check for the plan wizard's leave-types step.

    ``can_remove=false`` means unselecting the type will be rejected — either the
    plan is active, or a later step (probation, clubbing) points at this type and
    must be pointed somewhere else first. ``message`` explains which.
    """
    _require_org_id(current_user)
    result = await check_leave_type_removable(db, plan_id, leave_type_id)
    return LeaveTypeRemovalCheckResponse(**result)


@router.delete(
    "/leave-plans/{plan_id}/leave-types/{leave_type_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_type_from_plan(
    plan_id: str,
    leave_type_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> None:
    org_id = _require_org_id(current_user)
    await remove_leave_type_from_plan(db, plan_id, leave_type_id, org_id)
