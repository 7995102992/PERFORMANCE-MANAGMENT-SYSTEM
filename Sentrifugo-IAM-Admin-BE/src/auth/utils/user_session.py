"""Access-token-keyed user session stored in Valkey.

Downstream services look up a compact user context — identity + tenancy +
resolved permissions — with just the access token. Populated on issue
(login / refresh / SSO), cleared on password change. TTL matches the
access-token lifetime so sessions expire naturally if not explicitly revoked.

Key layout:
  session:<access_token>            -> JSON payload (user context + permissions)
  user:access_tokens:<user_id>      -> SET of access tokens belonging to user
                                       (used for bulk-revoke on password change)

Permissions shape (Shape 2 — resolved, no per-grant provenance):
  "permissions": {
    "<module>": {
      "acl":     "admin" | "editor" | "viewer",   # highest acl across matching policies
      "actions": { "create": bool, "read": bool, "update": bool, "delete": bool, "export": bool },
      # Highest acl per granted code. Only present for codes that are true in
      # `actions`. Levelled permissions (core_hr:resource_management) read this
      # rather than `acl`, which is a module-wide max and so says nothing about
      # the level held on one specific feature.
      "action_acls": { "<code>": "admin" | "editor" | "viewer" }
    },
    ...
  }

Super and org admins get a fully-populated grid (every module x every
action = true) plus the appropriate flag. Downstream services can read
the map directly without a flag short-circuit, eliminating the prior
"empty map means deny" footgun.
"""

import json

from src.auth.config import auth_settings
from src import valkey
from src.logger import logger
from src.lookups.utils import tools as lookup_repo
from src.models import (
    AclRoleEnum,
    MODULE_PERMISSIONS,
    ModuleEnum,
    PermissionCodeEnum,
)
from src.policies.utils import grants as policy_grants_repo
from src.users.utils import tools as user_repo

SESSION_PREFIX = "session:"
USER_ACCESS_PREFIX = "user:access_tokens:"
# Explicit access-token revocation denylist (F-13). Deleting the session cache
# alone doesn't revoke a token, because get_current_user's cold path re-validates
# the raw JWT on a cache miss. A token added here is rejected on BOTH paths until
# it naturally expires (TTL = remaining token lifetime).
REVOKED_PREFIX = "revoked:"

ACTIONS = tuple(p.value for p in PermissionCodeEnum)


def _module_actions(module: ModuleEnum | str) -> list[str]:
    """Return the permission codes valid for a given module."""
    try:
        m = ModuleEnum(module) if not isinstance(module, ModuleEnum) else module
    except ValueError:
        return []
    return [c.value for c in MODULE_PERMISSIONS.get(m, set())]

# Cached role-rank map loaded from the AclDocument lookup. Populated on
# first read; refreshed via reload_role_ranks() if the seed changes.
# Falls back to the canonical rank order baked into the seed script if
# the lookup is unreachable, so an outage doesn't break login.
_ROLE_RANK: dict[str, int] = {}
_FALLBACK_ROLE_RANK: dict[str, int] = {
    AclRoleEnum.VIEWER.value: 10,
    AclRoleEnum.EDITOR.value: 20,
    AclRoleEnum.ADMIN.value: 30,
}


async def _get_role_ranks() -> dict[str, int]:
    """Return {acl_id: rank}, loading from the acl collection on first use."""
    global _ROLE_RANK
    if _ROLE_RANK:
        return _ROLE_RANK
    try:
        rows = await lookup_repo.list_acl()
        _ROLE_RANK = {r["id"]: int(r["rank"]) for r in rows if "id" in r and "rank" in r}
    except Exception as exc:
        logger.warning("Failed to load role ranks from acl lookup", error=str(exc))
        _ROLE_RANK = {}
    if not _ROLE_RANK:
        _ROLE_RANK = dict(_FALLBACK_ROLE_RANK)
    return _ROLE_RANK


async def reload_role_ranks() -> dict[str, int]:
    """Force-reload the cached role-rank map (call after editing the seed)."""
    global _ROLE_RANK
    _ROLE_RANK = {}
    return await _get_role_ranks()


def _full_grid() -> dict:
    """Every module x its valid actions = true, role = admin. Used for org/super admins."""
    return {
        module.value: {
            "acl": AclRoleEnum.ADMIN.value,
            "actions": {action: True for action in _module_actions(module)},
            "action_acls": {
                action: AclRoleEnum.ADMIN.value for action in _module_actions(module)
            },
        }
        for module in ModuleEnum
    }


async def resolve_user_permissions(user_id: str) -> dict:
    """Aggregate the user's permissions from all their attached policies.

    Walks `user.policy_ids` → filters to active/non-deleted policies →
    loads grant rows in a single batch → folds into the module→entry shape
    downstream services consume.

    Merging rules when multiple policies cover the same module:
      - actions are OR'd (union of granted permissions)
      - role is the highest-ranked acl_id seen on any contributing grant
        (rank loaded from the acl lookup collection, not hardcoded)
      - action_acls[code] is the highest-ranked acl_id seen on grants for
        THAT code specifically

    `acl` is a module-wide maximum, so it cannot say what level a caller holds
    on one particular feature: an admin grant on Exit Management would read
    back as admin on every other core_hr code too. `action_acls` keeps the
    level per code, which is what require_permission_level enforces. Both are
    emitted — `acl` stays untouched for the readers that only need the
    module-wide role (require_any_module_admin, the FE's role derivation).

    Dangling policy_ids (pointing at soft-deleted or inactive policies)
    are silently dropped — keeps deletes loose and non-cascading.
    """
    user = await user_repo.get_user_by_id(user_id)
    if not user:
        return {}

    policy_ids = user.get("policy_ids") or []
    if not policy_ids:
        return {}

    active_policies = await policy_grants_repo.get_active_policies_by_ids(policy_ids)
    active_ids = [p["id"] for p in active_policies]
    if not active_ids:
        return {}

    grants = await policy_grants_repo.list_grants_for_policies(active_ids)
    role_rank = await _get_role_ranks()

    out: dict[str, dict] = {}
    for g in grants:
        module = g.get("module_id")
        acl = g.get("acl_id")
        perm = g.get("permission_id")
        if not module or not acl or not perm:
            continue

        if module not in out:
            out[module] = {
                "acl": acl,
                "actions": {a: False for a in _module_actions(module)},
                "action_acls": {},
            }

        entry = out[module]
        if perm in entry["actions"]:
            entry["actions"][perm] = True
            held = entry["action_acls"].get(perm)
            if held is None or role_rank.get(acl, 0) > role_rank.get(held, 0):
                entry["action_acls"][perm] = acl
        if role_rank.get(acl, 0) > role_rank.get(entry["acl"], 0):
            entry["acl"] = acl

    return out


def build_session_payload(
    user_doc: dict,
    permissions: dict | None = None,
    department_id: str | None = None,
    business_unit_id: str | None = None,
    is_pin_exists: bool = False,
    payslip_admin: bool = False,
) -> dict:
    """Assemble the compact user context stored against an access token.

    `permissions` should be pre-resolved via resolve_user_permissions(),
    or set to a `_full_grid()` for super/org admins so downstream readers
    can consult the map uniformly without flag short-circuits.

    `department_id` / `business_unit_id` are the user's
    EmployeeDocument.department_id / .business_unit_id if they have an
    employee record. Downstream services (e.g. SRM) read these to scope
    dept-/BU-aware views like "Employee Requests" and restricted catalog
    categories.
    """
    first = user_doc.get("first_name", "") or ""
    last = user_doc.get("last_name", "") or ""
    full_name = f"{first} {last}".strip()
    return {
        "user_id":        user_doc.get("id", ""),
        "email":          user_doc.get("email", ""),
        "full_name":      full_name,
        "first_name":     first,
        "last_name":      last,
        "org_id":         user_doc.get("organisation_id") or "",
        "is_super_admin": bool(user_doc.get("is_super_admin")),
        "is_org_admin":   bool(user_doc.get("is_org_admin")),
        "auth_method":    user_doc.get("auth_method", "local"),
        "permissions":    permissions or {},
        "department_id":    department_id,
        "business_unit_id": business_unit_id,
        "is_pin_exists":    is_pin_exists,
        "payslip_admin":    payslip_admin,
    }


async def create_user_session(access_token: str, user_doc: dict) -> dict:
    """Resolve permissions, then store a session keyed by the access token.

    Super admins and org admins receive a fully-populated permissions grid
    (every module x every action = true) so downstream services can read
    the map uniformly. The is_super_admin / is_org_admin flags are still
    set for callers that want to surface UI affordances ("you are an org
    admin"); enforcement reads the map.
    """
    if user_doc.get("is_super_admin") or user_doc.get("is_org_admin"):
        permissions = _full_grid()
    else:
        permissions = await resolve_user_permissions(user_doc["id"])

    # Look up the user's department + business unit (from EmployeeDocument) so
    # downstream services can scope "my-department" / "my-business-unit" views
    # (e.g. SRM restricted catalog categories) without a round-trip.
    department_id: str | None = None
    business_unit_id: str | None = None
    is_pin_exists: bool = False
    try:
        from beanie import PydanticObjectId
        from src.modules.organisation.models import EmployeeDocument
        from src.modules.employee_pin.models import EmployeePinDocument
        try:
            user_oid = PydanticObjectId(user_doc["id"])
        except Exception:
            user_oid = user_doc["id"]
        row = await EmployeeDocument.get_motor_collection().find_one(
            {"user_id": user_oid, "deleted_on": None},
            {"business_unit_id": 1, "department_id": 1},
        )
        if row:
            if row.get("business_unit_id"):
                business_unit_id = str(row["business_unit_id"])
            if row.get("department_id"):
                department_id = str(row["department_id"])
        pin_row = await EmployeePinDocument.get_motor_collection().find_one(
            {"user_id": user_oid, "deleted_on": None, "cipher_text": {"$ne": None}},
            {"_id": 1},
        )
        is_pin_exists = pin_row is not None
    except Exception as e:  # noqa: BLE001
        logger.warning("session.dept_lookup.failed user=%s err=%s",
                       user_doc.get("id"), e)

    from src.config import settings as _settings
    payslip_admin = (user_doc.get("email") or "").lower() in _settings.payslip_admin_email_set

    payload = build_session_payload(
        user_doc, permissions,
        department_id=department_id, business_unit_id=business_unit_id,
        is_pin_exists=is_pin_exists,
        payslip_admin=payslip_admin,
    )
    ttl_seconds = auth_settings.JWT_EXP_MINUTES * 60
    key = f"{SESSION_PREFIX}{access_token}"
    await valkey.valkey_client.set(key, json.dumps(payload), ex=ttl_seconds)
    await valkey.valkey_client.sadd(
        f"{USER_ACCESS_PREFIX}{payload['user_id']}", access_token
    )
    logger.info("User session created", user_id=payload["user_id"])
    return payload


async def get_user_session(access_token: str) -> dict | None:
    """Fetch the session payload by access token, or None if expired/missing."""
    raw = await valkey.valkey_client.get(f"{SESSION_PREFIX}{access_token}")
    if not raw:
        return None
    return json.loads(raw)


async def delete_user_session(access_token: str, user_id: str | None = None) -> None:
    """Remove a single session and its user-index entry."""
    await valkey.valkey_client.delete(f"{SESSION_PREFIX}{access_token}")
    if user_id:
        await valkey.valkey_client.srem(f"{USER_ACCESS_PREFIX}{user_id}", access_token)


async def revoke_access_token(access_token: str) -> None:
    """Add an access token to the revocation denylist (F-13).

    TTL is the full token lifetime — a safe upper bound on the remaining
    validity, after which the token is expired anyway and the key is redundant.
    """
    ttl_seconds = auth_settings.JWT_EXP_MINUTES * 60
    await valkey.valkey_client.set(f"{REVOKED_PREFIX}{access_token}", "1", ex=ttl_seconds)


async def is_access_token_revoked(access_token: str) -> bool:
    """True if the access token has been explicitly revoked (logout / security event)."""
    return bool(await valkey.valkey_client.exists(f"{REVOKED_PREFIX}{access_token}"))


async def delete_all_user_sessions_for_user(user_id: str) -> int:
    """Revoke every active access-token session for a user (e.g., on password change)."""
    set_key = f"{USER_ACCESS_PREFIX}{user_id}"
    tokens = await valkey.valkey_client.smembers(set_key)
    if not tokens:
        return 0
    keys = [f"{SESSION_PREFIX}{t}" for t in tokens]
    deleted = await valkey.valkey_client.delete(*keys)
    await valkey.valkey_client.delete(set_key)
    return deleted
