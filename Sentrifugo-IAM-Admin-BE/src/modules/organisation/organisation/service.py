"""Organisation service — thin orchestration layer between router and tools."""
from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.assets import asset_service
from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.models import ModuleEnum
from src.modules.organisation.organisation.schema import OrganisationUpdate
from src.modules.organisation.organisation.utils.tools import OrgTools

_tools = OrgTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def get_my_organisation(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    org = await _tools.get(org_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organisation not found")
    return org


async def get_organisation(org_id: PydanticObjectId, caller: UserBase) -> dict:
    org = await _tools.get(org_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organisation not found")
    check_org_access(org["id"], caller)
    return org


async def update_organisation(org_id: PydanticObjectId, data: OrganisationUpdate, caller: UserBase) -> dict:
    org = await _tools.get(org_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organisation not found")
    check_org_access(org["id"], caller)

    if data.enabled_modules is not None and not caller.is_super_admin:
        existing_codes = {
            (m["code"] if isinstance(m, dict) else m.code)
            for m in (org.get("enabled_modules") or [])
        }
        existing_codes = {ModuleEnum(c) if isinstance(c, str) else c for c in existing_codes}
        new_codes = {m.code for m in data.enabled_modules}
        if new_codes != existing_codes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Org admins can only toggle module status, not add or remove modules",
            )

    try:
        updated = await _tools.update(org_id, data)
    except Exception:
        existing_logo = org.get("logo_asset_id")
        new_logo = data.logo_asset_id
        if new_logo and new_logo != existing_logo:
            await asset_service.delete(new_logo)
        raise

    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organisation not found")
    return updated


async def delete_organisation(org_id: PydanticObjectId, caller: UserBase) -> None:
    org = await _tools.get(org_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organisation not found")
    check_org_access(org["id"], caller)
    await _tools.delete(org_id, actor_id=str(caller.id))
