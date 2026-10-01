from datetime import datetime, timezone
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.leave_plan_assignments.schemas import (
    EmployeeLeavePlanResponse,
    LeavePlanAssignmentCreate,
    LeavePlanAssignmentResponse,
)
from src.leave_plan_assignments.service import (
    create_assignment,
    # get_employee_leave_plan,
    list_assignments,
    resolve_employee_plan,
)

router = APIRouter(tags=["leave-plan-assignments"])


@router.post(
    "/leave-plan-assignments",
    response_model=list[LeavePlanAssignmentResponse],
    status_code=status.HTTP_201_CREATED,
)
async def add_assignment(
    payload: LeavePlanAssignmentCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[LeavePlanAssignmentResponse]:
    docs = await create_assignment(db, payload, created_by=current_user.user_id)
    return [LeavePlanAssignmentResponse(**doc) for doc in docs]


@router.get(
    "/leave-plans/{plan_id}/assignments",
    response_model=list[LeavePlanAssignmentResponse],
)
async def fetch_assignments(
    plan_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> list[LeavePlanAssignmentResponse]:
    docs = await list_assignments(db, plan_id)
    return [LeavePlanAssignmentResponse(**d) for d in docs]


@router.post(
    "/employee-leave-plans/resolve",
    response_model=Optional[EmployeeLeavePlanResponse],
)
async def resolve_plan_for_employee(
    user_id: str = Query(...),
    org_id: str = Query(...),
    department_id: Optional[str] = Query(default=None),
    business_unit_id: Optional[str] = Query(default=None),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> Optional[EmployeeLeavePlanResponse]:
    doc = await resolve_employee_plan(db, user_id, org_id, department_id, business_unit_id)
    if not doc:
        return None
    # resolve_employee_plan returns raw ObjectIds; shape them into the response
    # model (string ids, employee_id = the resolved user, resolved_at = now).
    return EmployeeLeavePlanResponse(
        _id=str(doc["assignment_id"]),
        employee_id=user_id,
        leave_plan_id=str(doc["leave_plan_id"]),
        assignment_id=str(doc["assignment_id"]),
        resolved_at=datetime.now(timezone.utc),
    )


# @router.get(
#     "/employee-leave-plans/{employee_id}",
#     response_model=Optional[EmployeeLeavePlanResponse],
# )
# async def fetch_employee_leave_plan(
#     employee_id: str,
#     current_user: UserBase = Depends(get_current_user),
#     db: Any = Depends(get_db_session),
# ) -> Optional[EmployeeLeavePlanResponse]:
#     doc = await get_employee_leave_plan(db, employee_id)
#     return EmployeeLeavePlanResponse(**doc) if doc else None
