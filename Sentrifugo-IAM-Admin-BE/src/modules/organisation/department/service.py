"""Department service — thin orchestration layer between router and tools.

Handles org scoping and delegates to DeptsTools for business logic + DB ops.
"""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.department.schema import DepartmentCreate, DepartmentResponse, DepartmentUpdate
from src.modules.organisation.department.utils.tools import DeptsTools

_tools = DeptsTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def create_department(data: DepartmentCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    return await _tools.create(data.model_copy(update={"organisation_id": org_id}))


async def list_departments(
    caller: UserBase,
    business_unit_ids: Optional[list[PydanticObjectId]] = None,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    is_active: Optional[bool] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _tools.get_all(
        organisation_id=org_id,
        business_unit_ids=business_unit_ids,
        skip=skip, limit=limit, search=search, is_active=is_active,
    )


async def get_department(dept_id: PydanticObjectId, caller: UserBase) -> dict:
    dept = await _tools.get(dept_id)
    if not dept:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found")
    check_org_access(dept.get("organisation_id") or dept.organisation_id, caller)
    return dept


async def update_department(dept_id: PydanticObjectId, data: DepartmentUpdate, caller: UserBase) -> dict:
    await get_department(dept_id, caller)
    updated = await _tools.update(dept_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Department not found")

    return updated


async def delete_department(dept_id: PydanticObjectId, caller: UserBase) -> None:
    await get_department(dept_id, caller)
    await _tools.delete(dept_id, actor_id=str(caller.id))
