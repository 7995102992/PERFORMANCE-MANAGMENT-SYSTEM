from typing import Annotated, Any

from fastapi import APIRouter, Depends, status

from src.database import get_db_session
from src.dependencies import UserBase, require_permission
from src.year_end_processing.schemas import (
    ExecuteYearEndRequest,
    ExecuteYearEndResponse,
    PreviewResult,
    PreviewYearEndRequest,
    YearEndProcessingCreate,
    YearEndProcessingResponse,
    YearEndProcessingUpdate,
)
from src.year_end_processing.service import (
    create_config,
    execute,
    get_config,
    preview,
    update_config,
)

router = APIRouter(
    prefix="/leave-plans/{leave_plan_id}/year-end-processing",
    tags=["year-end-processing"],
)


@router.post(
    "",
    response_model=YearEndProcessingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_year_end_config(
    leave_plan_id: str,
    payload: YearEndProcessingCreate,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> YearEndProcessingResponse:
    doc = await create_config(db, leave_plan_id, payload, user_id=current_user.user_id, org_id=current_user.org_id)
    return YearEndProcessingResponse(**doc)


@router.get("", response_model=YearEndProcessingResponse)
async def fetch_year_end_config(
    leave_plan_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> YearEndProcessingResponse:
    doc = await get_config(db, leave_plan_id, org_id=current_user.org_id)
    return YearEndProcessingResponse(**doc)


@router.patch("", response_model=YearEndProcessingResponse)
async def patch_year_end_config(
    leave_plan_id: str,
    payload: YearEndProcessingUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> YearEndProcessingResponse:
    doc = await update_config(db, leave_plan_id, payload, user_id=current_user.user_id, org_id=current_user.org_id)
    return YearEndProcessingResponse(**doc)


@router.post("/preview", response_model=PreviewResult)
async def preview_year_end(
    leave_plan_id: str,
    payload: PreviewYearEndRequest,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> PreviewResult:
    return await preview(db, leave_plan_id, payload, org_id=current_user.org_id)


@router.post("/execute", response_model=ExecuteYearEndResponse)
async def execute_year_end(
    leave_plan_id: str,
    payload: ExecuteYearEndRequest,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> ExecuteYearEndResponse:
    return await execute(db, leave_plan_id, payload, user_id=current_user.user_id, org_id=current_user.org_id)
