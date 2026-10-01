from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.custom_fields import service
from src.modules.custom_fields.models import EntityType, SectionType
from src.modules.custom_fields.schema import (
    DefinitionCreate,
    DefinitionResponse,
    DefinitionUpdate,
    EntityValuesResponse,
    OptionCreate,
    OptionResponse,
    OptionUpdate,
    ReorderRequest,
    ValueUpsert,
    ValueResponse,
)

router = APIRouter(prefix="/custom-fields", tags=["custom-fields"])


# ---------------------------------------------------------------------------
# Definitions
# ---------------------------------------------------------------------------

@router.post("/definitions", response_model=DefinitionResponse, status_code=status.HTTP_201_CREATED)
async def create_definition(
    data: DefinitionCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_definition(data, caller=current_user)


@router.get("/definitions", response_model=list[DefinitionResponse])
async def list_definitions(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    entity_type: Optional[EntityType] = Query(default=None),
    section: Optional[SectionType] = Query(default=None),
    is_active: Optional[bool] = Query(default=None),
):
    return await service.list_definitions(
        caller=current_user, entity_type=entity_type, section=section, is_active=is_active,
    )


@router.get("/definitions/{def_id}", response_model=DefinitionResponse)
async def get_definition(
    def_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_definition(def_id, caller=current_user)


@router.put("/definitions/{def_id}", response_model=DefinitionResponse)
async def update_definition(
    def_id: PydanticObjectId,
    data: DefinitionUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_definition(def_id, data, caller=current_user)


@router.delete("/definitions/{def_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_definition(
    def_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_definition(def_id, caller=current_user)


@router.patch("/definitions/reorder", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_definitions(
    data: ReorderRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.reorder_definitions(data, caller=current_user)


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

@router.post("/definitions/{def_id}/options", response_model=OptionResponse, status_code=status.HTTP_201_CREATED)
async def create_option(
    def_id: PydanticObjectId,
    data: OptionCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_option(def_id, data, caller=current_user)


@router.get("/definitions/{def_id}/options", response_model=list[OptionResponse])
async def list_options(
    def_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.list_options(def_id, caller=current_user)


@router.put("/options/{option_id}", response_model=OptionResponse)
async def update_option(
    option_id: PydanticObjectId,
    data: OptionUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_option(option_id, data, caller=current_user)


@router.delete("/options/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_option(
    option_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_option(option_id, caller=current_user)


@router.patch("/definitions/{def_id}/options/reorder", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_options(
    def_id: PydanticObjectId,
    data: ReorderRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.reorder_options(def_id, data, caller=current_user)


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------

@router.get("/values/{entity_type}/{entity_id}", response_model=EntityValuesResponse)
async def get_entity_values(
    entity_type: EntityType,
    entity_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_entity_values(entity_type, entity_id, caller=current_user)


@router.put("/values/{entity_type}/{entity_id}", response_model=list[ValueResponse])
async def upsert_entity_values(
    entity_type: EntityType,
    entity_id: PydanticObjectId,
    items: list[ValueUpsert],
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.upsert_entity_values(entity_type, entity_id, items, caller=current_user)


@router.delete("/values/{entity_type}/{entity_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entity_values(
    entity_type: EntityType,
    entity_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_entity_values(entity_type, entity_id, caller=current_user)
