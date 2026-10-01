"""Repository layer for the new PolicyDocument + ModuleAclPermissionDocument.

These coexist with the old src/policies/utils/tools.py during the transition.
Chunk 3 swaps the service over to use these. Chunk 6 removes the old file.

Design notes
------------
Grants are presence-based — a ModuleAclPermissionDocument row existing
means the combination is granted. There is no `granted: bool` column;
toggling a cell off soft-deletes the row (`deleted_on` set).

The grid shape the UI sends looks like:
    { module_code: { acl_role: { permission_code: bool } } }
`replace_policy_grants` turns that into a diff against current rows:
  - missing combos that are now True → insert
  - existing combos that are now False → soft-delete
  - combos that haven't changed → no-op

That keeps writes minimal on save and lets audit trails reconstruct who
revoked what and when.
"""

from datetime import datetime, timezone
from typing import Iterable

import re

from beanie import PydanticObjectId

from src.logger import logger
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument


# ===========================================================================
# Serialization helpers — ObjectId → str at the repo boundary
# ===========================================================================
def _serialize_policy(doc: PolicyDocument) -> dict:
    d = doc.model_dump()
    if d.get("id") is not None:
        d["id"] = str(d["id"])
    if d.get("organisation_id") is not None:
        d["organisation_id"] = str(d["organisation_id"])
    return d


def _serialize_grant(doc: ModuleAclPermissionDocument) -> dict:
    d = doc.model_dump()
    if d.get("id") is not None:
        d["id"] = str(d["id"])
    if d.get("policy_id") is not None:
        d["policy_id"] = str(d["policy_id"])
    return d


def _to_oid(value: str) -> PydanticObjectId:
    return PydanticObjectId(value)


# ===========================================================================
# PolicyDocument
# ===========================================================================
async def create_policy(data: dict) -> dict:
    """Insert a new policy. Caller populates the audit fields."""
    policy = PolicyDocument(**data)
    await policy.insert()
    logger.info("Policy created", policy_id=str(policy.id), name=policy.name)
    return _serialize_policy(policy)


async def get_policy_by_id(policy_id: str) -> dict | None:
    doc = await PolicyDocument.find_one(
        PolicyDocument.id == _to_oid(policy_id),
        PolicyDocument.deleted_on == None,  # noqa: E711
    )
    return _serialize_policy(doc) if doc else None


async def get_policy_by_name(name: str, organisation_id: str | None = None) -> dict | None:
    """Find a policy by (name, organisation_id). Matches tenant-scoped uniqueness."""
    filters = [
        PolicyDocument.name == name,
        PolicyDocument.deleted_on == None,  # noqa: E711
    ]
    if organisation_id is None:
        filters.append(PolicyDocument.organisation_id == None)  # noqa: E711
    else:
        filters.append(PolicyDocument.organisation_id == _to_oid(organisation_id))
    doc = await PolicyDocument.find_one(*filters)
    return _serialize_policy(doc) if doc else None


async def list_policies(
    skip: int = 0,
    limit: int = 20,
    search: str | None = None,
    is_active: bool | None = None,
    is_role: bool | None = None,
    organisation_id: str | None = None,
) -> list[dict]:
    filters = [PolicyDocument.deleted_on == None]  # noqa: E711
    if search:
        filters.append({"name": {"$regex": re.escape(search), "$options": "i"}})
    if is_active is not None:
        filters.append(PolicyDocument.is_active == is_active)
    if is_role is not None:
        filters.append(PolicyDocument.is_role == is_role)
    if organisation_id is not None:
        filters.append(PolicyDocument.organisation_id == _to_oid(organisation_id))

    rows = await PolicyDocument.find(*filters).skip(skip).limit(limit).to_list()
    return [_serialize_policy(r) for r in rows]


async def count_policies(
    search: str | None = None,
    is_active: bool | None = None,
    is_role: bool | None = None,
    organisation_id: str | None = None,
) -> int:
    filters = [PolicyDocument.deleted_on == None]  # noqa: E711
    if search:
        filters.append({"name": {"$regex": re.escape(search), "$options": "i"}})
    if is_active is not None:
        filters.append(PolicyDocument.is_active == is_active)
    if is_role is not None:
        filters.append(PolicyDocument.is_role == is_role)
    if organisation_id is not None:
        filters.append(PolicyDocument.organisation_id == _to_oid(organisation_id))
    return await PolicyDocument.find(*filters).count()


async def update_policy(policy_id: str, update_data: dict) -> dict | None:
    doc = await PolicyDocument.find_one(
        PolicyDocument.id == _to_oid(policy_id),
        PolicyDocument.deleted_on == None,  # noqa: E711
    )
    if not doc:
        return None
    await doc.set(update_data)
    return _serialize_policy(doc)


async def soft_delete_policy(policy_id: str, current_user_id: str | None = None) -> bool:
    """Soft-delete a policy AND cascade-soft-delete all its grants."""
    now = datetime.now(timezone.utc)
    updated = await update_policy(policy_id, {
        "deleted_by": current_user_id,
        "deleted_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
    })
    if not updated:
        return False

    # Cascade — soft-delete every grant row for this policy.
    live_grants = await ModuleAclPermissionDocument.find(
        ModuleAclPermissionDocument.policy_id == _to_oid(policy_id),
        ModuleAclPermissionDocument.deleted_on == None,  # noqa: E711
    ).to_list()
    for row in live_grants:
        await row.set({
            "deleted_by": current_user_id,
            "deleted_on": now,
            "modified_by": current_user_id,
            "modified_on": now,
        })
    return True


# ===========================================================================
# ModuleAclPermissionDocument (grants)
# ===========================================================================
async def get_policy_ids_with_module(module_id: str) -> list[str]:
    """Return distinct policy_ids that have at least one live grant on the given module."""
    rows = await ModuleAclPermissionDocument.find(
        ModuleAclPermissionDocument.module_id == module_id,
        ModuleAclPermissionDocument.deleted_on == None,  # noqa: E711
    ).to_list()
    return list({str(r.policy_id) for r in rows})


async def get_policy_ids_with_permission(module_id: str, permission_id: str) -> list[str]:
    """Return distinct policy_ids with a live grant for (module, permission)."""
    rows = await ModuleAclPermissionDocument.find(
        ModuleAclPermissionDocument.module_id == module_id,
        ModuleAclPermissionDocument.permission_id == permission_id,
        ModuleAclPermissionDocument.deleted_on == None,  # noqa: E711
    ).to_list()
    return list({str(r.policy_id) for r in rows})


async def list_grants_for_policy(policy_id: str) -> list[dict]:
    """Return every live grant row for a policy."""
    rows = await ModuleAclPermissionDocument.find(
        ModuleAclPermissionDocument.policy_id == _to_oid(policy_id),
        ModuleAclPermissionDocument.deleted_on == None,  # noqa: E711
    ).to_list()
    return [_serialize_grant(r) for r in rows]


async def list_grants_for_policies(policy_ids: Iterable[str]) -> list[dict]:
    """Return every live grant row for any of the given policies.

    Used by the permission-resolution path: load a user's policies at once
    rather than N round-trips.
    """
    oids = [_to_oid(i) for i in policy_ids if i]
    if not oids:
        return []
    rows = await ModuleAclPermissionDocument.find(
        {"policy_id": {"$in": oids}, "deleted_on": None},
    ).to_list()
    return [_serialize_grant(r) for r in rows]


async def get_active_policies_by_ids(policy_ids: Iterable[str]) -> list[dict]:
    """Return only the live, active subset of the given policy ids.

    Used at resolution time to filter out policies that were soft-deleted
    or deactivated after being attached to a user. Dangling policy_ids on
    users become no-ops rather than errors — matches the loose-coupling
    model we already have for `organisation_id`.
    """
    oids = [_to_oid(i) for i in policy_ids if i]
    if not oids:
        return []
    rows = await PolicyDocument.find(
        {"_id": {"$in": oids}, "deleted_on": None, "is_active": True},
    ).to_list()
    return [_serialize_policy(r) for r in rows]


async def exists_grant(
    policy_ids: Iterable[str],
    module_id: str,
    permission_id: str,
) -> bool:
    """Fast existence check: does any live grant match (policy, module, perm)?

    Backed by the composite index on module_acl_permissions — one indexed
    query per permission check, no scans.
    """
    oids = [_to_oid(i) for i in policy_ids if i]
    if not oids:
        return False
    count = await ModuleAclPermissionDocument.find({
        "policy_id": {"$in": oids},
        "module_id": module_id,
        "permission_id": permission_id,
        "deleted_on": None,
    }).count()
    return count > 0


async def insert_grant(data: dict) -> dict:
    """Insert a single grant row. Caller is responsible for uniqueness checks."""
    doc = ModuleAclPermissionDocument(**data)
    await doc.insert()
    return _serialize_grant(doc)


async def insert_grants_bulk(rows: list[dict]) -> int:
    """Bulk-insert grant rows. Returns number inserted."""
    if not rows:
        return 0
    docs = [ModuleAclPermissionDocument(**r) for r in rows]
    await ModuleAclPermissionDocument.insert_many(docs)
    return len(docs)


async def soft_delete_grant(grant_id: str, current_user_id: str | None = None) -> bool:
    now = datetime.now(timezone.utc)
    doc = await ModuleAclPermissionDocument.find_one(
        ModuleAclPermissionDocument.id == _to_oid(grant_id),
        ModuleAclPermissionDocument.deleted_on == None,  # noqa: E711
    )
    if not doc:
        return False
    await doc.set({
        "deleted_by": current_user_id,
        "deleted_on": now,
        "modified_by": current_user_id,
        "modified_on": now,
    })
    return True


# ===========================================================================
# Grid diff — the core write path called from PUT /policies/{id}/permissions
# ===========================================================================
def _combo_key(module_id: str, acl_id: str, permission_id: str) -> tuple[str, str, str]:
    return (module_id, acl_id, permission_id)


async def replace_policy_grants(
    policy_id: str,
    desired: set[tuple[str, str, str]],
    current_user_id: str | None = None,
) -> tuple[int, int]:
    """Diff the policy's current grants against `desired`, apply changes.

    `desired` is a set of (module_id, acl_id, permission_id) tuples — exactly
    the combinations the policy should grant after this call. Anything
    currently live but not in `desired` gets soft-deleted; anything in
    `desired` but not live gets inserted.

    Returns (inserts, removes) for observability.
    """
    pid = _to_oid(policy_id)
    live_rows = await list_grants_for_policy(policy_id)
    live = {
        _combo_key(r["module_id"], r["acl_id"], r["permission_id"]): r
        for r in live_rows
    }

    to_add = desired - set(live.keys())
    to_remove_keys = set(live.keys()) - desired

    now = datetime.now(timezone.utc)

    # Inserts
    new_rows = [
        {
            "policy_id": pid,
            "module_id": m,
            "acl_id": a,
            "permission_id": p,
            "created_by": current_user_id,
            "created_on": now,
            "modified_by": current_user_id,
            "modified_on": now,
        }
        for (m, a, p) in to_add
    ]
    if new_rows:
        await insert_grants_bulk(new_rows)

    # Removes (soft-delete)
    for key in to_remove_keys:
        grant = live[key]
        await soft_delete_grant(grant["id"], current_user_id=current_user_id)

    if to_add or to_remove_keys:
        logger.info(
            "Policy grants updated",
            policy_id=policy_id,
            added=len(to_add),
            removed=len(to_remove_keys),
        )

    return len(to_add), len(to_remove_keys)
