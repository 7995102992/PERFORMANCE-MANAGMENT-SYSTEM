"""Authorization dependencies — generic IAM permission gates.

Every check reads ``user.permissions``, the nested policy grid IAM projects into
the Valkey session::

    permissions[module]["actions"][action] -> bool

Super admins and org admins bypass all three gates. Failures raise
:class:`src.exceptions.Forbidden`.

The expense permission module will grant codes such as ``submit_expense``,
``expense_manager_approval``, ``expense_finance_approval`` and
``expense_l2_approval``; route modules wire them up like::

    Depends(require_permission("expense", "submit_expense"))

Resource-scoped ownership guards (claim requester / approver checks) are
deliberately not defined here — they belong with the expense domain models.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends

from src.auth.dependencies import get_current_user
from src.auth.schemas import UserBase
from src.exceptions import Forbidden


def require_permission(module: str, action: str) -> Callable:
    """Build a FastAPI dependency that validates a single IAM permission.

    Args:
        module: The IAM permission module (e.g. ``"expense"``).
        action: The permission code to require (e.g. ``"submit_expense"``).

    Returns:
        An async dependency returning the caller when allowed.

    Raises:
        Forbidden: When the caller holds neither an admin flag nor the grant.
    """

    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        if user.has_permission(module, action):
            return user
        raise Forbidden(f"Missing permission: {module}:{action}")

    return _dep


def require_any_permission(module: str, actions: list[str]) -> Callable:
    """Build a FastAPI dependency that passes if the caller has ANY of ``actions``.

    Args:
        module: The IAM permission module (e.g. ``"expense"``).
        actions: Permission codes; holding any one of them is sufficient.

    Returns:
        An async dependency returning the caller when allowed.

    Raises:
        Forbidden: When the caller holds none of the listed grants.
    """

    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        for action in actions:
            if user.has_permission(module, action):
                return user
        raise Forbidden(f"Missing any of permissions: {module}:{'|'.join(actions)}")

    return _dep


def require_org_admin() -> Callable:
    """Build a FastAPI dependency that requires super admin or org admin.

    Use this for mutation endpoints that should be restricted to admins
    regardless of explicit permission grants.

    Returns:
        An async dependency returning the caller when allowed.

    Raises:
        Forbidden: When the caller carries neither admin flag.
    """

    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        raise Forbidden("Admin access required")

    return _dep
