from typing import Annotated, Optional
from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.department import service
from src.modules.organisation.department.schema import DepartmentCreate, DepartmentResponse, DepartmentUpdate

router = APIRouter(prefix="/departments", tags=["departments"])


@router.post("/", response_model=DepartmentResponse, status_code=status.HTTP_201_CREATED)
async def create_department(
    data: DepartmentCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_department(data, caller=current_user)


@router.get("/", response_model=list[DepartmentResponse])
async def list_departments(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    business_unit_ids: str | None = Query(default=None, description="Comma-separated BU IDs"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    is_active: Optional[bool] = Query(default=None, description="Filter by active status"),
):
    bu_ids = None
    if business_unit_ids:
        bu_ids = [PydanticObjectId(bid.strip()) for bid in business_unit_ids.split(",") if bid.strip()]
    return await service.list_departments(
        caller=current_user, business_unit_ids=bu_ids, skip=skip, limit=limit, search=search, is_active=is_active,
    )


@router.get("/{dept_id}", response_model=DepartmentResponse)
async def get_department(
    dept_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_department(dept_id, caller=current_user)


@router.put("/{dept_id}", response_model=DepartmentResponse)
async def update_department(
    dept_id: PydanticObjectId,
    data: DepartmentUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_department(dept_id, data, caller=current_user)


@router.delete("/{dept_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_department(
    dept_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_department(dept_id, caller=current_user)
