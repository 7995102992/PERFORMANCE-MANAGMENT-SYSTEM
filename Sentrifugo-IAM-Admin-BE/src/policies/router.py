"""Policy management endpoints.

Three distinct surfaces:
  - `/policies`                     metadata CRUD (name, status, tenancy).
  - `/policies/{id}/permissions`    the permission grid — read and write.
  - `/policies/{id}/copy`           clone a policy with its full grant grid.

Old `/assignments` and `/policies/modules` endpoints are removed.
Modules moved to `/lookups/modules` (Chunk 1). Assignments are
replaced by user.policy_ids attachment in Chunk 4.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_any_module_admin, require_permission
from src.policies import service
from src.policies.schemas import (
    PolicyCopy,
    PolicyCopyModulePermissions,
    PolicyCreate,
    PolicyGridResponse,
    PolicyGridUpdate,
    PolicyListItem,
    PolicyResponse,
    PolicyUpdate,
)
from src.auth.utils.dependencies import get_current_user
router = APIRouter(prefix="/policies", tags=["policies"])


# ---------------------------------------------------------------------------
# Policy list + create (root — must come before parameterized routes)
# ---------------------------------------------------------------------------
@router.post("", response_model=PolicyResponse, status_code=status.HTTP_201_CREATED)
async def create_policy(
    data: PolicyCreate,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyResponse:
    """Create a policy. If `seed_module_codes` is provided, seeds a default
    admin/editor/viewer grid for each listed module."""
    return await service.create_policy(
        data, current_user_id=current_user.id, caller=current_user,
    )


@router.get("")
async def list_policies(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=500),
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
) -> dict:
    """Paginated list of policies, scoped to the caller's organisation."""
    return await service.list_policies(skip, limit, search, is_active=is_active, caller=current_user)


@router.get("/roles")
async def list_role_policies(
    current_user: Annotated[UserBase, Depends(require_any_module_admin)],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=500),
    search: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
) -> dict:
    """Paginated list of policies with is_role=True.

    Accessible to super admins, org admins, and users who hold admin ACL on
    at least one module.
    """
    return await service.list_role_policies(skip, limit, search, is_active=is_active, caller=current_user)


@router.get("/by-module/{module_id}", response_model=list[PolicyListItem])
async def list_policies_by_module(
    module_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> list[PolicyListItem]:
    """List policies that have permissions on a specific module.

    Used by the UI to show which policies can be copied from when a user
    selects a module during policy creation/editing.
    """
    return await service.list_policies_by_module(module_id, caller=current_user)


# ---------------------------------------------------------------------------
# Grid read / write (literal /permissions segment — must precede /{policy_id})
# ---------------------------------------------------------------------------
@router.get("/{policy_id}/permissions", response_model=PolicyGridResponse)
async def get_policy_permissions(
    policy_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyGridResponse:
    """Return the full 9 modules × 3 roles × 5 actions grid for a policy.

    Cells set True are currently granted; False means not granted. The UI
    can render the full checkbox grid directly from this payload.
    """
    return await service.get_policy_permissions(policy_id, caller=current_user)


@router.put("/{policy_id}/permissions", response_model=PolicyGridResponse)
async def replace_policy_permissions(
    policy_id: str,
    data: PolicyGridUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyGridResponse:
    """Replace the policy's grant grid with the submitted one.

    Minimal diff against current state — only the cells that changed get
    written. Returns the resulting grid so clients can roundtrip safely.
    """
    return await service.replace_policy_permissions(
        policy_id, data, current_user_id=current_user.id, caller=current_user,
    )


# ---------------------------------------------------------------------------
# Copy / clone
# ---------------------------------------------------------------------------
@router.post("/{policy_id}/copy", response_model=PolicyResponse, status_code=status.HTTP_201_CREATED)
async def copy_policy(
    policy_id: str,
    data: PolicyCopy,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyResponse:
    """Clone an existing policy's permission grid into a new policy.

    Reads all live grant rows from the source policy and duplicates them
    under a new policy with the given name. The new policy inherits the
    source's organisation_id.
    """
    return await service.copy_policy(
        policy_id, data, current_user_id=current_user.id, caller=current_user,
    )


@router.post("/{policy_id}/copy-module-permissions", response_model=PolicyGridResponse)
async def copy_module_permissions(
    policy_id: str,
    data: PolicyCopyModulePermissions,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyGridResponse:
    """Copy specific module permissions from a source policy into this policy.

    For each module in the request, replaces the target policy's grants for
    that module with the source policy's grants. Grants on other modules
    are untouched. Returns the updated grid.
    """
    return await service.copy_module_permissions(
        policy_id, data, current_user_id=current_user.id, caller=current_user,
    )


# ---------------------------------------------------------------------------
# Policy single-item CRUD (parameterized — must come last)
# ---------------------------------------------------------------------------
@router.get("/{policy_id}", response_model=PolicyResponse)
async def get_policy(
    policy_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyResponse:
    """Fetch a policy's metadata."""
    return await service.get_policy(policy_id, caller=current_user)


@router.put("/{policy_id}", response_model=PolicyResponse)
async def update_policy(
    policy_id: str,
    data: PolicyUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> PolicyResponse:
    """Update a policy's name or status. Grants are managed via /permissions."""
    return await service.update_policy(
        policy_id, data, current_user_id=current_user.id, caller=current_user,
    )


@router.delete("/{policy_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_policy(
    policy_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("policies", "create_resource"))],
) -> None:
    """Soft-delete a policy; cascades to all its grant rows."""
    await service.delete_policy(
        policy_id, current_user_id=current_user.id, caller=current_user,
    )
