"""Super-admin organisation management endpoints.

All routes are gated by require_super_admin — the organisation module is
not part of the tenant-scoped permission catalog, because creating /
viewing / editing tenants is a platform-owner responsibility.

Routes are mounted under /super-admin/organisations to keep this surface
disjoint from the tenant-facing Organisation Setup module being built in
parallel (feature/org-setup/*). Both services share the underlying
`organisations` collection via OrganisationDocument, but the HTTP paths
and the OpenAPI tag ("super-admin: organisations") never overlap.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_super_admin
from src.tenancy import service
from src.tenancy.schemas import (
    OrganisationCreate,
    OrganisationListItem,
    OrganisationResponse,
    OrganisationUpdate,
)

router = APIRouter(
    prefix="/super-admin/organisations",
    tags=["super-admin: organisations"],
)


@router.post("", response_model=OrganisationResponse, status_code=status.HTTP_201_CREATED)
async def create_organisation(
    data: OrganisationCreate,
    current_user: Annotated[UserBase, Depends(require_super_admin)],
) -> OrganisationResponse:
    """Add New Organisation (image 3).

    Creates the organisation + its primary admin user. When
    `send_activation` is true, an activation email is dispatched so the
    admin can set their password and activate the account.
    """
    return await service.create_organisation(data, current_user_id=current_user.id)


@router.get("", response_model=list[OrganisationListItem])
async def list_organisations(
    current_user: Annotated[UserBase, Depends(require_super_admin)],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str | None = Query(default=None, min_length=1, max_length=200),
    setup_status: str | None = Query(default=None, pattern="^(draft|pending|active)$"),
    is_active: bool | None = Query(default=None),
) -> list[OrganisationListItem]:
    """Paginated list of organisations for the super-admin dashboard."""
    return await service.list_organisations(
        skip=skip,
        limit=limit,
        search=search,
        setup_status=setup_status,
        is_active=is_active,
    )


@router.get("/{org_id}", response_model=OrganisationResponse)
async def get_organisation(
    org_id: str,
    current_user: Annotated[UserBase, Depends(require_super_admin)],
) -> OrganisationResponse:
    """View Organisation (image 4). Resolves the admin via the users table."""
    return await service.get_organisation(org_id)


@router.put("/{org_id}", response_model=OrganisationResponse)
async def update_organisation(
    org_id: str,
    data: OrganisationUpdate,
    current_user: Annotated[UserBase, Depends(require_super_admin)],
) -> OrganisationResponse:
    """Edit Organisation (image 5). Org fields + admin-card fields."""
    return await service.update_organisation(
        org_id, data, current_user_id=current_user.id
    )
