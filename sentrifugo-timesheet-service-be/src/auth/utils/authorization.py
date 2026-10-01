from __future__ import annotations

from typing import Annotated, Callable

from fastapi import Depends

from ...exceptions import Forbidden
from .dependencies import UserBase, get_current_user

MODULE_NAME = "timesheet_management"


def require_permission(module: str, action: str) -> Callable:
    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        if user.has_permission(module, action):
            return user
        raise Forbidden(f"Missing permission: {module}:{action}")

    return _dep
