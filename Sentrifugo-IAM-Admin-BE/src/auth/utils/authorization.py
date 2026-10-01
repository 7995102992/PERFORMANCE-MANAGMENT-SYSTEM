"""Authorization enforcement: require_permission FastAPI dependency.

Evaluates the current user's resolved permissions against a requested
(module, action) pair. The hot path reads the Valkey-cached session
payload built at login by user_session.create_user_session(); a Mongo
fallback rebuilds the grid on cache miss (TTL expiry, eviction, restart).
"""

from typing import Annotated, Callable

from fastapi import Depends, status

from src.auth.schemas import UserBase
from src.auth.utils.dependencies import _extract_token, get_current_user
from src.auth.utils.user_session import (
    ACTIONS,
    _get_role_ranks,
    get_user_session,
    resolve_user_permissions,
)
from src.exceptions import DomainException
from src.logger import logger
from src.models import AclRoleEnum, MODULE_PERMISSIONS, ModuleEnum, PermissionCodeEnum


VALID_ACTIONS = set(ACTIONS)


# IAM-internal module strings that are not in ModuleEnum (admin-only routes
# bypass the grid lookup, but require_permission is still called with these
# for uniform call sites).
_IAM_INTERNAL_MODULES = {"users", "policies", "dashboard", "tenancy"}


def _is_action_valid_for_module(module: str, action: str) -> bool:
    """True if (module, action) is a registered combination.

    IAM-internal modules accept any code in PermissionCodeEnum since they
    never hit the grid (admins-only). Product modules must have the action
    listed in MODULE_PERMISSIONS.
    """
    if module in _IAM_INTERNAL_MODULES:
        return action in VALID_ACTIONS
    try:
        mod_enum = ModuleEnum(module)
        code_enum = PermissionCodeEnum(action)
    except ValueError:
        return False
    return code_enum in MODULE_PERMISSIONS.get(mod_enum, set())


async def require_super_admin(
    current_user: Annotated[UserBase, Depends(get_current_user)],
) -> UserBase:
    """FastAPI dependency that allows only super admins.

    Used by super-admin-only surfaces (e.g. organisation management) where
    the (module, action) permission model doesn't apply because the feature
    isn't part of the tenant-scoped module catalog.
    """
    if not current_user.is_super_admin:
        logger.info("Super-admin-only route denied", user_id=current_user.id)
        raise DomainException(
            message="Super admin privilege required",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return current_user


def _grid_grants(grid: dict, module: str, action: str) -> bool:
    """Inspect a resolved permissions grid for a single (module, action) cell."""
    entry = grid.get(module)
    if not entry:
        return False
    return bool(entry.get("actions", {}).get(action))


def require_permission(module: str, action: str) -> Callable:
    """Return a FastAPI dependency that enforces (module, action) on the caller.

    Two classes of check share this gate:
      - Product-module checks (e.g. "leave_management", "create") — gated by
        the user's resolved policy grid.
      - IAM-internal admin checks (e.g. "users", "policies", "dashboard") —
        these aren't ModuleEnum values; no policy grants on them. They are
        admin-only by construction.

    Resolution order:
      1. Super or org admin → allow (covers both classes uniformly).
      2. Read the Valkey session payload, consult
         payload["permissions"][module]["actions"][action].
      3. On cache miss, rebuild the grid via resolve_user_permissions
         and check the same way. No write-through; the session repopulates
         on the next login / refresh.
      4. Otherwise 403 FORBIDDEN.
    """
    if not _is_action_valid_for_module(module, action):
        raise ValueError(
            f"Action '{action}' is not valid for module '{module}'. "
            f"See MODULE_PERMISSIONS in src/models.py."
        )

    async def _dep(
        current_user: Annotated[UserBase, Depends(get_current_user)],
        access_token: Annotated[str, Depends(_extract_token)],
    ) -> UserBase:
        # Admins bypass — covers IAM-internal modules (users/policies/dashboard)
        # which never appear in the policy grid, and also lets product-module
        # checks succeed for org-wide roles without a grid lookup.
        if current_user.is_super_admin or current_user.is_org_admin:
            return current_user

        # Hot path: cached session.
        session = await get_user_session(access_token)
        if session is not None:
            grid = session.get("permissions") or {}
            if _grid_grants(grid, module, action):
                return current_user
            _deny(current_user.id, module, action)

        # Cold path: cache miss — rebuild from source-of-truth.
        grid = await resolve_user_permissions(current_user.id)
        if _grid_grants(grid, module, action):
            return current_user

        _deny(current_user.id, module, action)

    return _dep


async def _grid_level(grid: dict, module: str, action: str) -> str | None:
    """The acl level a resolved grid holds on one (module, action) cell.

    Reads `action_acls[action]` — the per-code level. Falls back to the
    module-wide `acl` for sessions cached before action_acls existed, so a
    deploy doesn't 403 everyone still holding a warm session; those expire at
    the access-token TTL and the next login writes the new shape.
    """
    entry = grid.get(module)
    if not entry or not entry.get("actions", {}).get(action):
        return None
    return (entry.get("action_acls") or {}).get(action) or entry.get("acl")


async def _meets_level(grid: dict, module: str, action: str, min_level: AclRoleEnum) -> bool:
    held = await _grid_level(grid, module, action)
    if held is None:
        return False
    ranks = await _get_role_ranks()
    return ranks.get(held, 0) >= ranks.get(min_level.value, 0)


def require_permission_level(
    module: str,
    action: str,
    min_level: AclRoleEnum,
) -> Callable:
    """Enforce (module, action) AND a minimum acl level on that action.

    The levelled counterpart to require_permission. Where that gate only asks
    "is this code granted at all?", this one also asks "at what level?" — so a
    single permission code can back a read-only view, an editable one, and a
    destructive action, instead of needing three separate codes.

    Level ranking comes from the acl lookup collection (viewer < editor <
    admin), same source resolve_user_permissions merges with, so re-ranking the
    seed re-ranks the gate.

    Resolution mirrors require_permission: super/org admins bypass, then the
    cached session, then a cold rebuild on cache miss.
    """
    if not _is_action_valid_for_module(module, action):
        raise ValueError(
            f"Action '{action}' is not valid for module '{module}'. "
            f"See MODULE_PERMISSIONS in src/models.py."
        )

    async def _dep(
        current_user: Annotated[UserBase, Depends(get_current_user)],
        access_token: Annotated[str, Depends(_extract_token)],
    ) -> UserBase:
        if current_user.is_super_admin or current_user.is_org_admin:
            return current_user

        session = await get_user_session(access_token)
        if session is not None:
            grid = session.get("permissions") or {}
            if await _meets_level(grid, module, action, min_level):
                return current_user
            _deny_level(current_user.id, module, action, min_level)

        grid = await resolve_user_permissions(current_user.id)
        if await _meets_level(grid, module, action, min_level):
            return current_user

        _deny_level(current_user.id, module, action, min_level)

    return _dep


async def caller_permission_level(
    current_user: UserBase, module: str, action: str
) -> str | None:
    """The acl level the caller holds on (module, action), or None if ungranted.

    Programmatic (non-dependency) counterpart to require_permission_level, for
    services that need to branch on level rather than reject — e.g. returning a
    trimmed payload to a viewer instead of a 403.
    """
    if current_user.is_super_admin or current_user.is_org_admin:
        return AclRoleEnum.ADMIN.value
    grid = await resolve_user_permissions(str(current_user.id))
    return await _grid_level(grid, module, action)


async def caller_has_permission(current_user: UserBase, module: str, action: str) -> bool:
    """Programmatic (non-dependency) permission check for use inside services.

    Mirrors require_permission's resolution: super/org admins pass; otherwise the
    caller's resolved permission grid must grant (module, action). Returns a bool
    instead of raising, so call sites can branch (e.g. own-record vs HR access).
    """
    if current_user.is_super_admin or current_user.is_org_admin:
        return True
    grid = await resolve_user_permissions(str(current_user.id))
    return _grid_grants(grid, module, action)


def _deny_level(user_id: str, module: str, action: str, min_level: AclRoleEnum) -> None:
    logger.info(
        "Permission level denied",
        user_id=user_id, module=module, action=action, required=min_level.value,
    )
    raise DomainException(
        message=f"Permission denied: {module}:{action} requires {min_level.value} access",
        code="FORBIDDEN",
        status_code=status.HTTP_403_FORBIDDEN,
    )


def _deny(user_id: str, module: str, action: str) -> None:
    logger.info("Permission denied", user_id=user_id, module=module, action=action)
    raise DomainException(
        message=f"Permission denied: {module}:{action}",
        code="FORBIDDEN",
        status_code=status.HTTP_403_FORBIDDEN,
    )


def _has_any_module_admin(grid: dict) -> bool:
    return any(entry.get("acl") == AclRoleEnum.ADMIN.value for entry in grid.values())


async def require_any_module_admin(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    access_token: Annotated[str, Depends(_extract_token)],
) -> UserBase:
    """FastAPI dependency that allows super/org admins and users with admin ACL on any module."""
    if current_user.is_super_admin or current_user.is_org_admin:
        return current_user

    session = await get_user_session(access_token)
    if session is not None:
        if _has_any_module_admin(session.get("permissions") or {}):
            return current_user
        logger.info("Module-admin access denied", user_id=current_user.id)
        raise DomainException(
            message="Admin access to at least one module is required",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    grid = await resolve_user_permissions(current_user.id)
    if _has_any_module_admin(grid):
        return current_user

    logger.info("Module-admin access denied", user_id=current_user.id)
    raise DomainException(
        message="Admin access to at least one module is required",
        code="FORBIDDEN",
        status_code=status.HTTP_403_FORBIDDEN,
    )
