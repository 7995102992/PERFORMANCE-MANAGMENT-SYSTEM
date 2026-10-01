"""Organisation context dependency for multi-tenant endpoints.

Rule:
  - Org admin  → organisation_id always comes from their token (cannot be overridden)
  - Super admin → must pass organisation_id as a query parameter
"""

from beanie import PydanticObjectId
from fastapi import Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.dependencies import get_current_user
from src.exceptions import DomainException


async def resolve_org_id(
    organisation_id: str | None = Query(default=None, description="Organisation ID (super admin only)"),
    current_user: UserBase = Depends(get_current_user),
) -> PydanticObjectId:
    if current_user.is_super_admin:
        if not organisation_id:
            raise DomainException(
                message="Super admin must specify organisation_id as a query parameter",
                code="MISSING_ORG_ID",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        try:
            return PydanticObjectId(organisation_id)
        except Exception:
            raise DomainException(
                message="Invalid organisation_id format",
                code="INVALID_ORG_ID",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    if not current_user.organisation_id:
        raise DomainException(
            message="No organisation context",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return PydanticObjectId(current_user.organisation_id)


def check_org_access(resource_org_id: PydanticObjectId | str | None, current_user: UserBase) -> None:
    """Raise 403 if an org admin tries to access a resource from a different org."""
    if current_user.is_super_admin:
        return
    if str(resource_org_id) != current_user.organisation_id:
        raise DomainException(
            message="Access denied",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
