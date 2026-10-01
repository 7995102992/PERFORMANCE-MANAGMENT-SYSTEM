"""Bands service — thin orchestration layer between router and tools."""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.bands.schema import BandCreate, BandUpdate
from src.modules.organisation.bands.utils.tools import BandTools
from src.rabbitmq import DebugLevel, outbox

_tools = BandTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def create_band(data: BandCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    created = await _tools.create(data.model_copy(update={"organisation_id": org_id}))
    await outbox.publish_audit_log(
        module="bands",
        actor_id=str(caller.id),
        action="created",
        resource=f"band:{created.get('id')}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )
    return created


async def list_bands(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    is_active: Optional[bool] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _tools.get_all(organisation_id=org_id, skip=skip, limit=limit, search=search, is_active=is_active)


async def get_band(band_id: PydanticObjectId, caller: UserBase) -> dict:
    band = await _tools.get(band_id)
    if not band:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Band not found")
    check_org_access(band.get("organisation_id") or band.organisation_id, caller)
    return band


async def update_band(band_id: PydanticObjectId, data: BandUpdate, caller: UserBase) -> dict:
    await get_band(band_id, caller)
    updated = await _tools.update(band_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Band not found")
    await outbox.publish_audit_log(
        module="bands",
        actor_id=str(caller.id),
        action="updated",
        resource=f"band:{band_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def delete_band(band_id: PydanticObjectId, caller: UserBase) -> None:
    await get_band(band_id, caller)
    await _tools.delete(band_id, actor_id=str(caller.id))
    await outbox.publish_audit_log(
        module="bands",
        actor_id=str(caller.id),
        action="deleted",
        resource=f"band:{band_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )
