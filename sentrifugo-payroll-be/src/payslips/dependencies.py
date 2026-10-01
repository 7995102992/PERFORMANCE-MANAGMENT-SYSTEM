"""Route dependencies for the payslips domain.

``require_tenant_scope`` resolves the caller's organisation + business unit from
the IAM session (via :func:`get_current_user`) into validated ObjectIds. Every
payslip route depends on it, so requests are both authenticated *and* tenant-
scoped — reads are filtered and writes are stamped with this scope.

RBAC on top: the admin payslip routers are gated by ``require_payslip_admin`` —
the IAM session carries a top-level ``payslip_admin`` boolean (admins bypass). The
self-service router still uses ``require_permission`` against the ``core_hr``
feature blob (``permissions["core_hr"]["actions"][<feature>]``).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from beanie import PydanticObjectId
from fastapi import Depends
from pydantic import BaseModel

from src.auth.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.exceptions import Forbidden

# IAM groups the payroll feature flags under this module in the session blob.
PERMISSION_MODULE = "core_hr"


class TenantScope(BaseModel):
    """The caller's organisation + business unit, as ObjectIds."""

    organisation_id: PydanticObjectId
    business_unit_id: PydanticObjectId


def _to_object_id(value: str | None, field: str) -> PydanticObjectId:
    if not value:
        raise Forbidden(f"Session is missing {field}")
    try:
        return PydanticObjectId(value)
    except (ValueError, TypeError) as exc:
        raise Forbidden(f"Session has an invalid {field}") from exc


async def require_tenant_scope(user: UserBase = Depends(get_current_user)) -> TenantScope:
    """Resolve and validate the caller's tenant scope, or 403 if absent."""
    return TenantScope(
        organisation_id=_to_object_id(user.organisation_id, "organisation_id"),
        business_unit_id=_to_object_id(user.business_unit_id, "business_unit_id"),
    )


def require_permission(feature: str) -> Callable[[UserBase], Awaitable[UserBase]]:
    """Build a dependency that 403s unless the caller holds ``core_hr.<feature>``.

    Super-admins and org-admins bypass the check; everyone else is denied by
    default unless the IAM session explicitly grants the feature. ``get_current_user``
    is shared (FastAPI caches it per request), so gating a router with this on top
    of ``require_tenant_scope`` does not re-read the session.
    """

    async def _check(user: UserBase = Depends(get_current_user)) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        if not user.has_permission(PERMISSION_MODULE, feature):
            raise Forbidden(f"Missing required permission: {PERMISSION_MODULE}.{feature}")
        return user

    return _check


async def require_payslip_admin(user: UserBase = Depends(get_current_user)) -> UserBase:
    """403 unless the caller is a payslip admin.

    Gates the admin payroll routers (uploads + payslip records). Access is granted
    by the ``payslip_admin`` boolean carried in the IAM session; super-admins and
    org-admins bypass. Shares the cached ``get_current_user`` with the tenant scope.
    """
    if user.is_super_admin or user.is_org_admin or user.payslip_admin:
        return user
    raise Forbidden("Payslip admin access required")


# Self-service router still uses a core_hr feature flag (see src/payslips/router.py).
require_my_payroll = require_permission("my_payroll")  # /my-payroll
