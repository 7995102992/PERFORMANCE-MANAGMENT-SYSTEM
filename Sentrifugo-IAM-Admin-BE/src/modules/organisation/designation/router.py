from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.designation import service
from src.modules.organisation.designation.schema import DesignationCreate, DesignationResponse, DesignationUpdate

router = APIRouter(prefix="/designations", tags=["designations"])


@router.post("/", response_model=DesignationResponse, status_code=status.HTTP_201_CREATED)
async def create_designation(
    data: DesignationCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_designation(data, caller=current_user)


@router.get("/", response_model=list[DesignationResponse])
async def list_designations(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=1000),
    search: str = Query(default=""),
    is_active: Optional[bool] = Query(default=None, description="Filter by active status"),
):
    # Designations are org-level now — no department / hierarchy filtering.
    return await service.list_designations(
        caller=current_user,
        skip=skip, limit=limit, search=search, is_active=is_active,
    )


@router.get("/{desg_id}", response_model=DesignationResponse)
async def get_designation(
    desg_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_designation(desg_id, caller=current_user)


@router.put("/{desg_id}", response_model=DesignationResponse)
async def update_designation(
    desg_id: PydanticObjectId,
    data: DesignationUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_designation(desg_id, data, caller=current_user)


@router.delete("/{desg_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_designation(
    desg_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_designation(desg_id, caller=current_user)
