"""Pay Grades service — thin orchestration layer between router and tools."""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.paygrades.schema import PayGradeCreate, PayGradeUpdate
from src.modules.organisation.paygrades.utils.tools import PayGradeTools
from src.rabbitmq import DebugLevel, outbox

_tools = PayGradeTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def create_paygrade(data: PayGradeCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    created = await _tools.create(data.model_copy(update={"organisation_id": org_id}))
    await outbox.publish_audit_log(
        module="paygrades",
        actor_id=str(caller.id),
        action="created",
        resource=f"paygrade:{created.get('id')}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )
    return created


async def list_paygrades(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    is_active: Optional[bool] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _tools.get_all(organisation_id=org_id, skip=skip, limit=limit, search=search, is_active=is_active)


async def get_paygrade(paygrade_id: PydanticObjectId, caller: UserBase) -> dict:
    paygrade = await _tools.get(paygrade_id)
    if not paygrade:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pay grade not found")
    check_org_access(paygrade.get("organisation_id") or paygrade.organisation_id, caller)
    return paygrade


async def update_paygrade(paygrade_id: PydanticObjectId, data: PayGradeUpdate, caller: UserBase) -> dict:
    await get_paygrade(paygrade_id, caller)
    updated = await _tools.update(paygrade_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pay grade not found")
    await outbox.publish_audit_log(
        module="paygrades",
        actor_id=str(caller.id),
        action="updated",
        resource=f"paygrade:{paygrade_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def delete_paygrade(paygrade_id: PydanticObjectId, caller: UserBase) -> None:
    await get_paygrade(paygrade_id, caller)
    await _tools.delete(paygrade_id, actor_id=str(caller.id))
    await outbox.publish_audit_log(
        module="paygrades",
        actor_id=str(caller.id),
        action="deleted",
        resource=f"paygrade:{paygrade_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )
