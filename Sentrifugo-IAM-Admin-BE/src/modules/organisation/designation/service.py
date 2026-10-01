"""Designation service.

A designation is just a job title now (name + description + pay grades). Roles
(policies) are a separate concept, managed independently and assigned directly
to employees — designations no longer own a policy.
"""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.designation.schema import DesignationCreate, DesignationUpdate
from src.modules.organisation.designation.utils.tools import DesignationTools

_tools = DesignationTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def create_designation(data: DesignationCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    payload = data.model_copy(update={"organisation_id": org_id})
    return await _tools.create(payload)


async def list_designations(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    is_active: Optional[bool] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _tools.get_all(
        organisation_id=org_id,
        skip=skip, limit=limit, search=search, is_active=is_active,
    )


async def get_designation(desg_id: PydanticObjectId, caller: UserBase) -> dict:
    desg = await _tools.get(desg_id)
    if not desg:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Designation not found")
    check_org_access(desg.get("organisation_id") or desg.organisation_id, caller)
    return desg


async def update_designation(desg_id: PydanticObjectId, data: DesignationUpdate, caller: UserBase) -> dict:
    await get_designation(desg_id, caller)
    updated = await _tools.update(desg_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Designation not found")
    return updated


async def delete_designation(desg_id: PydanticObjectId, caller: UserBase) -> None:
    await get_designation(desg_id, caller)
    await _tools.delete(desg_id, actor_id=str(caller.id))
