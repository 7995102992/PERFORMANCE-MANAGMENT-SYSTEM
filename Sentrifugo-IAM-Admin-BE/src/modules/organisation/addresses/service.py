"""Addresses service — thin orchestration layer between router and tools."""
from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.addresses.schema import AddressCreate, AddressUpdate
from src.modules.organisation.addresses.utils.tools import AddressTools
from src.rabbitmq import DebugLevel, outbox

_tools = AddressTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def create_address(data: AddressCreate, caller: UserBase):
    org_id = _resolve_org(caller)
    created = await _tools.create(data.model_copy(update={"organisation_id": org_id}))
    await outbox.publish_audit_log(
        module="addresses",
        actor_id=str(caller.id),
        action="created",
        resource=f"address:{created.id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )
    return created


async def list_addresses(caller: UserBase, skip: int = 0, limit: int = 20, search: str = ""):
    org_id = _resolve_org(caller)
    return await _tools.get_all(organisation_id=org_id, skip=skip, limit=limit, search=search)


async def get_address(address_id: PydanticObjectId, caller: UserBase):
    address = await _tools.get(address_id)
    if not address:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Address not found")
    check_org_access(address.organisation_id, caller)
    return address


async def update_address(address_id: PydanticObjectId, data: AddressUpdate, caller: UserBase):
    await get_address(address_id, caller)
    updated = await _tools.update(address_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Address not found")
    await outbox.publish_audit_log(
        module="addresses",
        actor_id=str(caller.id),
        action="updated",
        resource=f"address:{address_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def delete_address(address_id: PydanticObjectId, caller: UserBase) -> None:
    await get_address(address_id, caller)
    deleted = await _tools.delete(address_id, actor_id=str(caller.id))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Address not found")
    await outbox.publish_audit_log(
        module="addresses",
        actor_id=str(caller.id),
        action="deleted",
        resource=f"address:{address_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )
