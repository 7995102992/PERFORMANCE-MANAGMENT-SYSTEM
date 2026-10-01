from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.bands import service
from src.modules.organisation.bands.schema import BandCreate, BandResponse, BandUpdate

router = APIRouter(prefix="/bands", tags=["bands"])


@router.post("/", response_model=BandResponse, status_code=status.HTTP_201_CREATED)
async def create_band(
    data: BandCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_band(data, caller=current_user)


@router.get("/", response_model=list[BandResponse])
async def list_bands(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    is_active: Optional[bool] = Query(default=None, description="Filter by active status"),
):
    return await service.list_bands(
        caller=current_user, skip=skip, limit=limit, search=search, is_active=is_active,
    )


@router.get("/{band_id}", response_model=BandResponse)
async def get_band(
    band_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_band(band_id, caller=current_user)


@router.put("/{band_id}", response_model=BandResponse)
async def update_band(
    band_id: PydanticObjectId,
    data: BandUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_band(band_id, data, caller=current_user)


@router.delete("/{band_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_band(
    band_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_band(band_id, caller=current_user)
