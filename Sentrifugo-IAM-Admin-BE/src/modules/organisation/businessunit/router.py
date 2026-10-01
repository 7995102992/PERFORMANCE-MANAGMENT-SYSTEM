from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.businessunit import service
from src.modules.organisation.businessunit.schema import BulkDeleteRequest, BusinessUnitCreate, BusinessUnitResponse, BusinessUnitUpdate

router = APIRouter(prefix="/business-units", tags=["business-units"])


@router.post("/", response_model=BusinessUnitResponse, status_code=status.HTTP_201_CREATED)
async def create_business_unit(
    data: BusinessUnitCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_business_unit(data, caller=current_user)


@router.get("/", response_model=list[BusinessUnitResponse])
async def list_business_units(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    is_active: Optional[bool] = Query(default=None, description="Filter by active status"),
    is_subsidiary: Optional[bool] = Query(default=None, description="Filter by subsidiary flag"),
):
    return await service.list_business_units(
        caller=current_user, skip=skip, limit=limit, search=search,
        is_active=is_active, is_subsidiary=is_subsidiary,
    )


@router.post("/bulk-delete", status_code=status.HTTP_200_OK)
async def bulk_delete_business_units(
    data: BulkDeleteRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    deleted = await service.bulk_delete_business_units(data.ids, caller=current_user)
    return {"deleted": deleted}


@router.get("/{bu_id}", response_model=BusinessUnitResponse)
async def get_business_unit(
    bu_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_business_unit(bu_id, caller=current_user)


@router.put("/{bu_id}", response_model=BusinessUnitResponse)
async def update_business_unit(
    bu_id: PydanticObjectId,
    data: BusinessUnitUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_business_unit(bu_id, data, caller=current_user)


@router.delete("/{bu_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_business_unit(
    bu_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_business_unit(bu_id, caller=current_user)
