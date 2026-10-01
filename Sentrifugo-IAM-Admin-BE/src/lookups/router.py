"""Read-only lookup endpoints for the frontend.

Powers three UIs:
  - GET /lookups/modules      — module picker on Add/Edit Organization
  - GET /lookups/acl          — role picker in Policy editor (admin/editor/viewer)
  - GET /lookups/permissions  — action picker in Policy editor (CRUD/E)

Open to any authenticated user (no role gating) — these are product-wide
reference data, not tenant-scoped.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from src.auth.schemas import UserBase
from src.auth.utils.dependencies import get_current_user
from src.lookups import service
from src.lookups.schemas import AclItem, ModuleCatalogItem, PermissionItem
from src.models import ModuleEnum

router = APIRouter(prefix="/lookups", tags=["lookups"])


@router.get("/acl", response_model=list[AclItem])
async def get_acl(
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> list[AclItem]:
    """Return the three ACL roles (admin/editor/viewer), ordered by rank."""
    return await service.list_acl()


@router.get("/modules", response_model=list[ModuleCatalogItem])
async def get_modules(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    all: Annotated[bool, Query(description="Return full catalog without org filtering")] = False,
) -> list[ModuleCatalogItem]:
    """Return modules enabled for the caller's organisation, or full catalog if all=true."""
    org_id = None if all else current_user.organisation_id
    return await service.list_modules(organisation_id=org_id)


@router.get("/permissions", response_model=list[PermissionItem])
async def get_permissions(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    module: Annotated[str | None, Query(description="Filter to permissions valid for this module")] = None,
) -> list[PermissionItem]:
    """Return permissions scoped to the caller's organisation's enabled modules.

    Unknown/invalid `module` values are ignored (treated as no filter) rather
    than rejected, so new module codes on the client don't break this endpoint.
    """
    try:
        module_enum = ModuleEnum(module) if module else None
    except ValueError:
        module_enum = None
    return await service.list_permissions(
        module_enum,
        organisation_id=current_user.organisation_id,
        actor_id=str(current_user.id),
    )
