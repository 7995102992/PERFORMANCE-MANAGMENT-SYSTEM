from typing import Annotated, List

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.addresses import service
from src.modules.organisation.addresses.schema import AddressCreate, AddressResponse, AddressUpdate

router = APIRouter(prefix="/addresses", tags=["addresses"])


@router.post("/", response_model=AddressResponse, status_code=status.HTTP_201_CREATED)
async def create_address(
    data: AddressCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_address(data, caller=current_user)


@router.get("/", response_model=List[AddressResponse])
async def list_addresses(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
):
    return await service.list_addresses(caller=current_user, skip=skip, limit=limit, search=search)


@router.get("/{address_id}", response_model=AddressResponse)
async def get_address(
    address_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_address(address_id, caller=current_user)


@router.put("/{address_id}", response_model=AddressResponse)
async def update_address(
    address_id: PydanticObjectId,
    data: AddressUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_address(address_id, data, caller=current_user)


@router.delete("/{address_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_address(
    address_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_address(address_id, caller=current_user)
