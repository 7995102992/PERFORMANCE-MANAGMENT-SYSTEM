"""Business Unit service — thin orchestration layer between router and tools."""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.businessunit.schema import BusinessUnitCreate, BusinessUnitUpdate
from src.modules.organisation.businessunit.utils.tools import BuTools

_tools = BuTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def create_business_unit(data: BusinessUnitCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    return await _tools.create(data.model_copy(update={"organisation_id": org_id}))


async def list_business_units(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    is_active: Optional[bool] = None,
    is_subsidiary: Optional[bool] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _tools.get_all(
        organisation_id=org_id, skip=skip, limit=limit, search=search,
        is_active=is_active, is_subsidiary=is_subsidiary,
    )


async def get_business_unit(bu_id: PydanticObjectId, caller: UserBase) -> dict:
    bu = await _tools.get(bu_id)
    if not bu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Business unit not found")
    check_org_access(bu.get("organisation_id") or bu.organisation_id, caller)
    return bu


async def update_business_unit(bu_id: PydanticObjectId, data: BusinessUnitUpdate, caller: UserBase) -> dict:
    await get_business_unit(bu_id, caller)
    updated = await _tools.update(bu_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Business unit not found")
    return updated


async def delete_business_unit(bu_id: PydanticObjectId, caller: UserBase) -> None:
    await get_business_unit(bu_id, caller)
    await _tools.delete(bu_id, actor_id=str(caller.id))


async def bulk_delete_business_units(bu_ids: list[PydanticObjectId], caller: UserBase) -> int:
    _resolve_org(caller)
    for bu_id in bu_ids:
        await get_business_unit(bu_id, caller)
    return await _tools.bulk_delete(bu_ids, actor_id=str(caller.id))
