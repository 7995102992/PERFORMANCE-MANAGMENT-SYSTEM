from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.organisation import service
from src.modules.organisation.organisation.schema import OrganisationResponse, OrganisationUpdate

router = APIRouter(prefix="/organisations", tags=["organisations"])


@router.get("/", response_model=OrganisationResponse)
async def get_my_organisation(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    """Returns the caller's organisation."""
    return await service.get_my_organisation(caller=current_user)


@router.get("/{org_id}", response_model=OrganisationResponse)
async def get_organisation(
    org_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_organisation(org_id, caller=current_user)


@router.put("/{org_id}", response_model=OrganisationResponse)
async def update_organisation(
    org_id: PydanticObjectId,
    data: OrganisationUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_organisation(org_id, data, caller=current_user)


@router.delete("/{org_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_organisation(
    org_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_organisation(org_id, caller=current_user)
