"""Policy CRUD + grid read/write on the PolicyDocument + ModuleAclPermissionDocument model.

Key flows:
  - `create_policy`  creates a policy row; when seed modules are supplied,
                     fans out the default grid (admin=all, editor=rw, viewer=r)
                     for each module.
  - `get_policy` / `list_policies` / `update_policy` / `delete_policy`
                     — metadata CRUD, tenant-scoped.
  - `get_policy_permissions` returns the full 9×3×5 grid assembled from
                     the live grant rows.
  - `replace_policy_permissions` takes a grid back, hands it to
                     `grants.replace_policy_grants` for a minimal diff.

Cache invalidation: policy mutations that change what grants a user holds
invalidate those users' Valkey session caches. Holders are looked up via
`users.find({'policy_ids': policy_id})` — targeted, not fan-out.
"""

from datetime import datetime, timezone

from fastapi import status

from fastapi import HTTPException as FastAPIHTTPException

from src.auth.models import UserDocument
from src.auth.schemas import UserBase
from src.auth.utils.user_session import delete_all_user_sessions_for_user
from src.exceptions import DomainException
from src.logger import logger
from src.models import (
    AclRoleEnum,
    ModuleEnum,
    MODULE_PERMISSIONS,
    PermissionCodeEnum,
)
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
from src.correlation import get_correlation_id
from src.policies.utils import grants as repo
from src.rabbitmq import DebugLevel, outbox
from src.users.utils import tools as user_repo


# ---------------------------------------------------------------------------
# Dependency check: block inactivation if users are assigned this policy.
# ---------------------------------------------------------------------------
async def _check_policy_dependencies(policy_id: str) -> None:
    from beanie import PydanticObjectId
    user_count = await UserDocument.find(
        {"policy_ids": PydanticObjectId(policy_id), "deleted_on": None}
    ).count()
    if user_count:
        raise FastAPIHTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Cannot inactivate policy. Active dependencies exist.",
                "dependencies": [{"type": "users", "count": user_count}],
            },
        )


# ---------------------------------------------------------------------------
# Cache invalidation: drop the Valkey access-token session for every user
# who holds a policy whose grants just changed. Best-effort — one bad user
# shouldn't abort the mutation; stale caches expire on TTL anyway.
# ---------------------------------------------------------------------------
async def _invalidate_cache_for_policy_holders(policy_id: str) -> None:
    holders = await user_repo.get_users_with_policy(policy_id)
    for holder in holders:
        try:
            await delete_all_user_sessions_for_user(holder["id"])
        except Exception as exc:
            logger.warning(
                "Failed to invalidate permissions cache",
                user_id=holder.get("id"), error=str(exc),
            )


# ---------------------------------------------------------------------------
# Default grid seeded when a policy is created with seed_module_codes.
# One grant row per (module, role, action) combination marked True.
# ---------------------------------------------------------------------------
_DEFAULT_SEED_MATRIX: dict[AclRoleEnum, set[PermissionCodeEnum]] = {
    # ADMIN gets every permission valid for the module being seeded —
    # resolved per-module via MODULE_PERMISSIONS at seed time.
    AclRoleEnum.ADMIN: set(),  # placeholder; expanded in _seed_grants_for_module
    AclRoleEnum.EDITOR: {
        PermissionCodeEnum.READ,
        PermissionCodeEnum.UPDATE,
    },
    AclRoleEnum.VIEWER: {
        PermissionCodeEnum.READ,
    },
}


def _seed_perms_for(module: ModuleEnum, role: AclRoleEnum) -> set[PermissionCodeEnum]:
    """Resolve the default permissions for (module, role) at seed time.

    ADMIN gets every code MODULE_PERMISSIONS lists for the module. EDITOR
    and VIEWER get the canonical defaults intersected with what the module
    actually supports — so a feature-only module like Leave Management
    gets nothing for EDITOR/VIEWER unless explicitly granted via the UI.
    """
    available = MODULE_PERMISSIONS.get(module, set())
    if role is AclRoleEnum.ADMIN:
        return set(available)
    return _DEFAULT_SEED_MATRIX[role] & available


# ---------------------------------------------------------------------------
# Tenancy helpers (mirror the existing patterns in users / organisations)
# ---------------------------------------------------------------------------
def _scope_org(caller: UserBase | None) -> str | None:
    """Return the org to filter by, or None for no scoping (super admins)."""
    if caller is None or caller.is_super_admin:
        return None
    return caller.organisation_id


def _resolve_target_org(caller: UserBase | None, requested_org: str | None) -> str | None:
    """Super admins may pick any org; everyone else gets their own."""
    if caller is None or caller.is_super_admin:
        return requested_org
    return caller.organisation_id


def _check_org_access(caller: UserBase | None, entity_org: str | None) -> None:
    """Raise 404 if caller may not see an entity in this org (hides existence)."""
    scope = _scope_org(caller)
    if scope is not None and entity_org != scope:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )


# ---------------------------------------------------------------------------
# Policy CRUD
# ---------------------------------------------------------------------------
async def create_policy(
    data: PolicyCreate,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> PolicyResponse:
    """Create a policy and, if seed_module_codes are given, the default grid."""
    target_org = _resolve_target_org(caller, data.organisation_id)

    existing = await repo.get_policy_by_name(data.name, organisation_id=target_org)
    if existing:
        raise DomainException(
            message="Policy name already exists",
            code="POLICY_NAME_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    now = datetime.now(timezone.utc)
    doc = {
        "name": data.name,
        "is_role": data.is_role,
        "is_active": data.is_active,
        "organisation_id": target_org,
        "seed_module_codes": [m.value for m in data.seed_module_codes],
        "created_by": current_user_id,
        "created_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
    }
    created = await repo.create_policy(doc)

    # An explicit permissions grid takes precedence over seed_module_code —
    # caller gets exactly what they asked for.
    if data.permissions is not None:
        valid_modules = {m.value for m in ModuleEnum}
        valid_roles = {r.value for r in AclRoleEnum}

        grant_rows = []
        for module_code, role_map in (data.permissions or {}).items():
            if module_code not in valid_modules:
                continue
            module_valid_perms = {p.value for p in MODULE_PERMISSIONS.get(ModuleEnum(module_code), set())}
            for role_code, perm_map in (role_map or {}).items():
                if role_code not in valid_roles:
                    continue
                for perm_code, granted in (perm_map or {}).items():
                    if granted and perm_code in module_valid_perms:
                        grant_rows.append({
                            "policy_id": created["id"],
                            "module_id": module_code,
                            "acl_id": role_code,
                            "permission_id": perm_code,
                            "created_by": current_user_id,
                            "created_on": now,
                            "modified_by": current_user_id,
                            "modified_on": now,
                        })

        if grant_rows:
            await repo.insert_grants_bulk(grant_rows)
        logger.info(
            "Policy created with explicit grid",
            policy_id=created["id"], grants=len(grant_rows),
        )

    elif data.seed_module_codes is not None:
        seed_rows = [
            {
                "policy_id": created["id"],
                "module_id": module.value,
                "acl_id": role.value,
                "permission_id": perm.value,
                "created_by": current_user_id,
                "created_on": now,
                "modified_by": current_user_id,
                "modified_on": now,
            }
            for module in data.seed_module_codes
            for role in _DEFAULT_SEED_MATRIX
            for perm in _seed_perms_for(module, role)
        ]
        await repo.insert_grants_bulk(seed_rows)
        logger.info(
            "Policy seeded with default grid",
            policy_id=created["id"],
            modules=[m.value for m in data.seed_module_codes],
            grants=len(seed_rows),
        )

    await outbox.publish(
        "policy.created",
        {"correlation_id": get_correlation_id(), "policy_id": created["id"], "name": data.name, "is_role": data.is_role,
         "organisation_id": str(target_org) if target_org else None,
         "is_active": created.get("is_active", True)},
        idempotency_key=f"policy.created:{created['id']}",
    )
    await outbox.publish_audit_log(
        module="policies",
        actor_id=current_user_id or "system",
        action="created",
        resource=f"policy:{created['id']}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(target_org) if target_org else None,
    )
    return _to_policy_response(created)


async def get_policy(policy_id: str, caller: UserBase | None = None) -> PolicyResponse:
    policy = await repo.get_policy_by_id(policy_id)
    if not policy:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, policy.get("organisation_id"))
    return _to_policy_response(policy)


async def list_policies(
    skip: int = 0,
    limit: int = 20,
    search: str | None = None,
    is_active: bool | None = None,
    caller: UserBase | None = None,
) -> dict:
    org = _scope_org(caller)
    rows = await repo.list_policies(skip, limit, search, is_active=is_active, organisation_id=org)
    total = await repo.count_policies(search, is_active=is_active, organisation_id=org)
    return {
        "items": [_to_policy_list_item(r) for r in rows],
        "total": total,
        "skip": skip,
        "limit": limit,
    }


async def list_role_policies(
    skip: int = 0,
    limit: int = 20,
    search: str | None = None,
    is_active: bool | None = None,
    caller: UserBase | None = None,
) -> dict:
    """Paginated list of policies where is_role=True, scoped to the caller's organisation."""
    org = _scope_org(caller)
    rows = await repo.list_policies(skip, limit, search, is_active=is_active, is_role=True, organisation_id=org)
    total = await repo.count_policies(search, is_active=is_active, is_role=True, organisation_id=org)
    return {
        "items": [_to_policy_list_item(r) for r in rows],
        "total": total,
        "skip": skip,
        "limit": limit,
    }


async def update_policy(
    policy_id: str,
    data: PolicyUpdate,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> PolicyResponse:
    existing = await repo.get_policy_by_id(policy_id)
    if not existing:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, existing.get("organisation_id"))

    update_fields: dict = {}
    if data.name is not None and data.name != existing["name"]:
        dup = await repo.get_policy_by_name(
            data.name, organisation_id=existing.get("organisation_id"),
        )
        if dup and dup["id"] != policy_id:
            raise DomainException(
                message="Policy name already exists",
                code="POLICY_NAME_EXISTS",
                status_code=status.HTTP_409_CONFLICT,
            )
        update_fields["name"] = data.name
    if data.is_active is not None:
        if data.is_active is False and existing.get("is_active") is True:
            await _check_policy_dependencies(policy_id)
        update_fields["is_active"] = data.is_active
    if data.is_role is not None:
        update_fields["is_role"] = data.is_role

    if not update_fields:
        raise DomainException(
            message="No fields to update",
            code="INVALID_INPUT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    update_fields["modified_by"] = current_user_id
    update_fields["modified_on"] = datetime.now(timezone.utc)
    updated = await repo.update_policy(policy_id, update_fields)

    # A status flip changes which grants take effect at resolution time; a
    # rename doesn't, but the cost of an extra invalidation is trivial.
    await _invalidate_cache_for_policy_holders(policy_id)

    await outbox.publish(
        "policy.updated",
        {
            "correlation_id": get_correlation_id(),
            "policy_id": policy_id,
            "name": (updated or {}).get("name") or existing.get("name"),
            "is_role": (updated or {}).get("is_role", existing.get("is_role")),
            "is_active": (updated or {}).get("is_active", existing.get("is_active")),
            "organisation_id": str(existing["organisation_id"]) if existing.get("organisation_id") else None,
            "changed_fields": list(update_fields.keys()),
        },
        idempotency_key=f"policy.updated:{policy_id}:{get_correlation_id()}",
    )
    await outbox.publish_audit_log(
        module="policies",
        actor_id=current_user_id or "system",
        action="updated",
        resource=f"policy:{policy_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(existing["organisation_id"]) if existing.get("organisation_id") else None,
        metadata={"changed_fields": list(update_fields.keys())},
    )
    return _to_policy_response(updated)


async def delete_policy(
    policy_id: str,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> None:
    policy = await repo.get_policy_by_id(policy_id)
    if not policy:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, policy.get("organisation_id"))

    ok = await repo.soft_delete_policy(policy_id, current_user_id=current_user_id)
    if not ok:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Dangling policy_ids on users become no-ops at resolution time, but
    # their cached sessions still need refreshing.
    await _invalidate_cache_for_policy_holders(policy_id)

    await outbox.publish(
        "policy.deleted",
        {"correlation_id": get_correlation_id(), "policy_id": policy_id},
        idempotency_key=f"policy.deleted:{policy_id}",
    )
    await outbox.publish_audit_log(
        module="policies",
        actor_id=current_user_id or "system",
        action="deleted",
        resource=f"policy:{policy_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(policy["organisation_id"]) if policy.get("organisation_id") else None,
    )
    org_id = policy.get("organisation_id")


# ---------------------------------------------------------------------------
# Copy / clone
# ---------------------------------------------------------------------------
async def copy_policy(
    source_policy_id: str,
    data: PolicyCopy,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> PolicyResponse:
    """Clone an existing policy's permission grid into a new policy."""
    source = await repo.get_policy_by_id(source_policy_id)
    if not source:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, source.get("organisation_id"))

    target_org = source.get("organisation_id")
    existing = await repo.get_policy_by_name(data.name, organisation_id=target_org)
    if existing:
        raise DomainException(
            message="Policy name already exists",
            code="POLICY_NAME_EXISTS",
            status_code=status.HTTP_409_CONFLICT,
        )

    now = datetime.now(timezone.utc)
    new_doc = {
        "name": data.name,
        "is_role": source.get("is_role", False),
        "is_active": True,
        "organisation_id": target_org,
        "seed_module_codes": list(source.get("seed_module_codes") or []),
        "created_by": current_user_id,
        "created_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
    }
    created = await repo.create_policy(new_doc)

    source_grants = await repo.list_grants_for_policy(source_policy_id)
    if source_grants:
        new_rows = [
            {
                "policy_id": created["id"],
                "module_id": g["module_id"],
                "acl_id": g["acl_id"],
                "permission_id": g["permission_id"],
                "created_by": current_user_id,
                "created_on": now,
                "modified_by": current_user_id,
                "modified_on": now,
            }
            for g in source_grants
        ]
        await repo.insert_grants_bulk(new_rows)

    logger.info(
        "Policy copied",
        source_policy_id=source_policy_id,
        new_policy_id=created["id"],
        grants=len(source_grants),
    )
    return _to_policy_response(created)


# ---------------------------------------------------------------------------
# List policies by module — "which policies have grants on core_hr?"
# ---------------------------------------------------------------------------
async def list_policies_by_module(
    module_id: str,
    caller: UserBase | None = None,
) -> list[PolicyListItem]:
    """Return policies that have at least one live grant on the given module."""
    valid_modules = {m.value for m in ModuleEnum}
    if module_id not in valid_modules:
        raise DomainException(
            message=f"Unknown module: {module_id}",
            code="INVALID_MODULE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    policy_ids = await repo.get_policy_ids_with_module(module_id)
    if not policy_ids:
        return []

    org = _scope_org(caller)
    results = []
    for pid in policy_ids:
        policy = await repo.get_policy_by_id(pid)
        if not policy:
            continue
        if org is not None and policy.get("organisation_id") != org:
            continue
        results.append(_to_policy_list_item(policy))
    return results


# ---------------------------------------------------------------------------
# Copy module permissions from source policy into target policy
# ---------------------------------------------------------------------------
async def copy_module_permissions(
    target_policy_id: str,
    data: PolicyCopyModulePermissions,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> PolicyGridResponse:
    """Copy specific module permissions from a source policy into the target.

    For each requested module, reads the source policy's grant rows and
    merges them into the target — existing grants on other modules are
    untouched. Grants on the requested modules in the target are replaced.
    """
    target = await repo.get_policy_by_id(target_policy_id)
    if not target:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, target.get("organisation_id"))

    source = await repo.get_policy_by_id(data.source_policy_id)
    if not source:
        raise DomainException(
            message="Source policy not found",
            code="SOURCE_POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, source.get("organisation_id"))

    valid_modules = {m.value for m in ModuleEnum}
    requested_modules = {m for m in data.modules if m in valid_modules}
    if not requested_modules:
        raise DomainException(
            message="No valid modules specified",
            code="INVALID_MODULE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    source_grants = await repo.list_grants_for_policy(data.source_policy_id)
    source_module_grants = [
        g for g in source_grants if g["module_id"] in requested_modules
    ]

    target_grants = await repo.list_grants_for_policy(target_policy_id)

    # Build the desired set: keep existing target grants for non-requested
    # modules, replace requested modules with source grants.
    desired: set[tuple[str, str, str]] = set()
    for g in target_grants:
        if g["module_id"] not in requested_modules:
            desired.add((g["module_id"], g["acl_id"], g["permission_id"]))
    for g in source_module_grants:
        desired.add((g["module_id"], g["acl_id"], g["permission_id"]))

    await repo.replace_policy_grants(target_policy_id, desired, current_user_id=current_user_id)

    now = datetime.now(timezone.utc)
    await repo.update_policy(target_policy_id, {
        "modified_by": current_user_id,
        "modified_on": now,
    })

    await _invalidate_cache_for_policy_holders(target_policy_id)

    logger.info(
        "Module permissions copied",
        source_policy_id=data.source_policy_id,
        target_policy_id=target_policy_id,
        modules=list(requested_modules),
    )
    return await get_policy_permissions(target_policy_id, caller=caller)


# ---------------------------------------------------------------------------
# Grid read
# ---------------------------------------------------------------------------
def _empty_grid() -> dict:
    """Module x role x (module-valid action), all False."""
    return {
        module.value: {
            role.value: {perm.value: False for perm in MODULE_PERMISSIONS.get(module, set())}
            for role in AclRoleEnum
        }
        for module in ModuleEnum
    }


async def get_policy_permissions(
    policy_id: str,
    caller: UserBase | None = None,
) -> PolicyGridResponse:
    policy = await repo.get_policy_by_id(policy_id)
    if not policy:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, policy.get("organisation_id"))

    grid = _empty_grid()
    for g in await repo.list_grants_for_policy(policy_id):
        # Defensive: skip any row with a code not in the current enum set
        # (shouldn't happen with normal writes, but keeps the response clean
        # if lookups are extended and old data lingers).
        if (
            g["module_id"] in grid
            and g["acl_id"] in grid[g["module_id"]]
            and g["permission_id"] in grid[g["module_id"]][g["acl_id"]]
        ):
            grid[g["module_id"]][g["acl_id"]][g["permission_id"]] = True

    return PolicyGridResponse(policy_id=policy_id, permissions=grid)


# ---------------------------------------------------------------------------
# Grid write — diff against live grants
# ---------------------------------------------------------------------------
async def replace_policy_permissions(
    policy_id: str,
    data: PolicyGridUpdate,
    current_user_id: str | None = None,
    caller: UserBase | None = None,
) -> PolicyGridResponse:
    policy = await repo.get_policy_by_id(policy_id)
    if not policy:
        raise DomainException(
            message="Policy not found",
            code="POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    _check_org_access(caller, policy.get("organisation_id"))

    # Validate codes against the canonical enums — unknown codes are dropped
    # so a stale client can't accidentally grant on a retired module.
    valid_modules = {m.value for m in ModuleEnum}
    valid_roles = {r.value for r in AclRoleEnum}

    desired: set[tuple[str, str, str]] = set()
    for module_code, role_map in (data.permissions or {}).items():
        if module_code not in valid_modules:
            continue
        module_valid_perms = {p.value for p in MODULE_PERMISSIONS.get(ModuleEnum(module_code), set())}
        for role_code, perm_map in (role_map or {}).items():
            if role_code not in valid_roles:
                continue
            for perm_code, granted in (perm_map or {}).items():
                if granted and perm_code in module_valid_perms:
                    desired.add((module_code, role_code, perm_code))

    await repo.replace_policy_grants(policy_id, desired, current_user_id=current_user_id)

    # Stamp modified_on on the policy so the list view reflects recency.
    await repo.update_policy(policy_id, {
        "modified_by": current_user_id,
        "modified_on": datetime.now(timezone.utc),
    })

    # Drop cached sessions for everyone holding this policy — their resolved
    # permissions are now stale.
    await _invalidate_cache_for_policy_holders(policy_id)

    await outbox.publish_audit_log(
        module="policies",
        actor_id=current_user_id or "system",
        action="permissions_updated",
        resource=f"policy:{policy_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(policy["organisation_id"]) if policy.get("organisation_id") else None,
        metadata={"grants_count": len(desired)},
    )

    # Return the freshly-saved grid so the UI can roundtrip it.
    return await get_policy_permissions(policy_id, caller=caller)


# ---------------------------------------------------------------------------
# Response mappers
# ---------------------------------------------------------------------------
def _to_policy_response(doc: dict) -> PolicyResponse:
    seeds = doc.get("seed_module_codes") or []
    return PolicyResponse(
        id=doc["id"],
        name=doc["name"],
        is_role=doc.get("is_role", False),
        is_active=doc.get("is_active", True),
        organisation_id=doc.get("organisation_id"),
        seed_module_codes=[ModuleEnum(s) for s in seeds],
        created_by=doc.get("created_by"),
        created_on=doc.get("created_on"),
        modified_by=doc.get("modified_by"),
        modified_on=doc.get("modified_on"),
    )


def _to_policy_list_item(doc: dict) -> PolicyListItem:
    seeds = doc.get("seed_module_codes") or []
    return PolicyListItem(
        id=doc["id"],
        name=doc["name"],
        is_role=doc.get("is_role", False),
        is_active=doc.get("is_active", True),
        organisation_id=doc.get("organisation_id"),
        seed_module_codes=[ModuleEnum(s) for s in seeds],
        created_on=doc.get("created_on"),
        modified_on=doc.get("modified_on"),
    )
