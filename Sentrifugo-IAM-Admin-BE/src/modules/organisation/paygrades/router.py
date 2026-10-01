from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.paygrades import service
from src.modules.organisation.paygrades.schema import PayGradeCreate, PayGradeResponse, PayGradeUpdate

router = APIRouter(prefix="/paygrades", tags=["paygrades"])


@router.post("/", response_model=PayGradeResponse, status_code=status.HTTP_201_CREATED)
async def create_paygrade(
    data: PayGradeCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_paygrade(data, caller=current_user)


@router.get("/", response_model=list[PayGradeResponse])
async def list_paygrades(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    is_active: Optional[bool] = Query(default=None, description="Filter by active status"),
):
    return await service.list_paygrades(
        caller=current_user, skip=skip, limit=limit, search=search, is_active=is_active,
    )


@router.get("/{paygrade_id}", response_model=PayGradeResponse)
async def get_paygrade(
    paygrade_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_paygrade(paygrade_id, caller=current_user)


@router.put("/{paygrade_id}", response_model=PayGradeResponse)
async def update_paygrade(
    paygrade_id: PydanticObjectId,
    data: PayGradeUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_paygrade(paygrade_id, data, caller=current_user)


@router.delete("/{paygrade_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_paygrade(
    paygrade_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_paygrade(paygrade_id, caller=current_user)
