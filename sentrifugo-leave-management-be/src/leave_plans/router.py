from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import StreamingResponse

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.leave_plans.schemas import GrantPolicyPayload, LeavePlanCreate, LeavePlanLeaveTypesPayload, LeavePlanResponse, LeavePlanUpdate
from src.leave_plans.overview_export import generate_overview_xlsx
from src.leave_plans.overview_service import get_leave_plan_overview
from src.leave_plans.service import (
    activate_leave_plan, create_leave_plan, deactivate_leave_plan, delete_leave_plan,
    get_leave_plan, list_leave_plans, set_grant_policy, set_leave_types_on_plan, update_leave_plan,
)

router = APIRouter(tags=["leave-plans"])


@router.post("/leave-plans", response_model=LeavePlanResponse, status_code=status.HTTP_201_CREATED)
async def add_leave_plan(
    payload: LeavePlanCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await create_leave_plan(db, payload, created_by=current_user.user_id)
    return LeavePlanResponse(**doc)


@router.get("/leave-plans", response_model=list[LeavePlanResponse])
async def fetch_leave_plans(
    org_id: str = Query(...),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> list[LeavePlanResponse]:
    docs = await list_leave_plans(db, org_id)
    return [LeavePlanResponse(**d) for d in docs]


@router.get("/leave-plans/{plan_id}", response_model=LeavePlanResponse)
async def fetch_leave_plan(
    plan_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await get_leave_plan(db, plan_id)
    return LeavePlanResponse(**doc)


@router.put("/leave-plans/{plan_id}", response_model=LeavePlanResponse)
async def modify_leave_plan(
    plan_id: str,
    payload: LeavePlanUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await update_leave_plan(db, plan_id, payload, updated_by=current_user.user_id)
    return LeavePlanResponse(**doc)


@router.post("/leave-plans/{plan_id}/leave-types", response_model=LeavePlanResponse)
async def assign_leave_types(
    plan_id: str,
    payload: LeavePlanLeaveTypesPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await set_leave_types_on_plan(db, plan_id, payload, updated_by=current_user.user_id)
    return LeavePlanResponse(**doc)


@router.post("/leave-plans/{plan_id}/grant-policy", response_model=LeavePlanResponse)
async def set_plan_grant_policy(
    plan_id: str,
    payload: GrantPolicyPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await set_grant_policy(db, plan_id, payload, updated_by=current_user.user_id)
    return LeavePlanResponse(**doc)


@router.post("/leave-plans/{plan_id}/activate", response_model=LeavePlanResponse)
async def activate_plan(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await activate_leave_plan(db, plan_id, updated_by=current_user.user_id)
    return LeavePlanResponse(**doc)


@router.post("/leave-plans/{plan_id}/deactivate", response_model=LeavePlanResponse)
async def deactivate_plan(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeavePlanResponse:
    doc = await deactivate_leave_plan(db, plan_id, updated_by=current_user.user_id)
    return LeavePlanResponse(**doc)


@router.delete("/leave-plans/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_leave_plan(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> None:
    await delete_leave_plan(db, plan_id, deleted_by=current_user.user_id)


@router.get("/leave-plans/{plan_id}/overview")
async def get_overview(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
    business_unit_ids: str | None = Query(None, description="Comma-separated BU ids to filter"),
    department_ids: str | None = Query(None, description="Comma-separated dept ids to filter"),
    employment_status_keys: str | None = Query(None, description="Comma-separated status keys to filter (e.g. permanent,probation)"),
):
    bu_filter = [s.strip() for s in business_unit_ids.split(",") if s.strip()] if business_unit_ids else None
    dept_filter = [s.strip() for s in department_ids.split(",") if s.strip()] if department_ids else None
    status_filter = [s.strip() for s in employment_status_keys.split(",") if s.strip()] if employment_status_keys else None
    return await get_leave_plan_overview(
        db, plan_id,
        bu_filter=bu_filter,
        dept_filter=dept_filter,
        status_filter=status_filter,
        include_employees=True,
    )


@router.get("/leave-plans/{plan_id}/overview/export")
async def export_overview(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
    business_unit_ids: str | None = Query(None),
    department_ids: str | None = Query(None),
    employment_status_keys: str | None = Query(None),
):
    bu_filter = [s.strip() for s in business_unit_ids.split(",") if s.strip()] if business_unit_ids else None
    dept_filter = [s.strip() for s in department_ids.split(",") if s.strip()] if department_ids else None
    status_filter = [s.strip() for s in employment_status_keys.split(",") if s.strip()] if employment_status_keys else None

    data = await get_leave_plan_overview(
        db, plan_id,
        bu_filter=bu_filter,
        dept_filter=dept_filter,
        status_filter=status_filter,
        include_employees=True,
    )

    content = generate_overview_xlsx(data)
    filename = f"leave-plan-overview-{plan_id}.xlsx"
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

