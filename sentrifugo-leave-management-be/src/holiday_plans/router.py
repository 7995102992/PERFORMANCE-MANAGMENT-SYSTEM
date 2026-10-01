from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status

from src.dependencies import UserBase, get_current_user
from src.database import get_db_session
from src.exceptions import DomainException
from src.holiday_plans.schemas import (
    HolidayPlanCreate,
    HolidayPlanResponse,
    HolidayPlanScopeUpdate,
    HolidayPlanScopeUpdateResult,
    HolidayPlanSummary,
    HolidayPlanUpdate,
)
from src.holiday_plans.service import (
    create_holiday_plan,
    delete_holiday_plan,
    get_holiday_plan,
    get_holiday_plans,
    update_holiday_plan,
    update_holiday_plan_scope,
)

router = APIRouter(prefix="/holiday-plans", tags=["holiday-plans"])


def _require_org_id(user: UserBase) -> str:
    if not user.org_id:
        raise DomainException(
            message="Authenticated user is missing an org_id",
            code="MISSING_ORG_CONTEXT",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return user.org_id


@router.post("", response_model=HolidayPlanResponse, status_code=status.HTTP_201_CREATED)
async def create_plan(
    payload: HolidayPlanCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> HolidayPlanResponse:
    org_id = _require_org_id(current_user)
    doc = await create_holiday_plan(db, payload, org_id, current_user.user_id)
    return HolidayPlanResponse(**doc)


@router.get("", response_model=list[HolidayPlanSummary])
async def list_plans(
    year: int | None = Query(None),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> list[HolidayPlanSummary]:
    org_id = _require_org_id(current_user)
    docs = await get_holiday_plans(db, org_id, year)
    return [HolidayPlanSummary(**d) for d in docs]


@router.get("/{plan_id}", response_model=HolidayPlanResponse)
async def get_plan(
    plan_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> HolidayPlanResponse:
    doc = await get_holiday_plan(db, plan_id, expected_org_id=current_user.org_id)
    return HolidayPlanResponse(**doc)


@router.put("/{plan_id}", response_model=HolidayPlanResponse)
async def update_plan(
    plan_id: str,
    payload: HolidayPlanUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> HolidayPlanResponse:
    doc = await update_holiday_plan(
        db, plan_id, payload, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return HolidayPlanResponse(**doc)


@router.put("/{plan_id}/scope", response_model=HolidayPlanScopeUpdateResult)
async def update_plan_scope(
    plan_id: str,
    payload: HolidayPlanScopeUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> HolidayPlanScopeUpdateResult:
    """Atomic BU/dept scope edit — updates the plan, re-scopes its holidays, and
    reconciles employee assignments in a single transaction (all-or-nothing)."""
    result = await update_holiday_plan_scope(
        db, plan_id, payload, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return HolidayPlanScopeUpdateResult(**result)


@router.get("/{plan_id}/dependencies")
async def check_plan_dependencies(
    plan_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> dict:
    # Tenant guard: verify the plan belongs to caller's org before counting.
    await get_holiday_plan(db, plan_id, expected_org_id=current_user.org_id)
    from bson import ObjectId
    plan_oid = ObjectId(plan_id)
    emp_count = await db["holiday_plan_employees"].count_documents(
        {"plan_id": plan_oid, "deleted_on": None}
    )
    holiday_count = await db["holidays"].count_documents(
        {"plan_id": plan_oid, "deleted_on": None}
    )
    return {"employees": emp_count, "holidays": holiday_count}


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> None:
    await delete_holiday_plan(
        db, plan_id, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
