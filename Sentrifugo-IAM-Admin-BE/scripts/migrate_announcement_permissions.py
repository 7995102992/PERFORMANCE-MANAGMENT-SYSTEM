"""Grant the Announcements read permission (core_hr:view_announcements) to every
existing role/designation policy, in every organisation.

Why
---
Announcements ships two new codes under the existing `core_hr` module:

  * `manage_announcements` — admin CRUD + publish/unpublish.
  * `view_announcements`   — read-only employee dashboard feed.

The employee dashboard card is meant to be visible to *everyone*, but the
permission model is deny-by-default: without a grant, `require_permission(
"core_hr", "view_announcements")` rejects every ordinary employee and the card
stays empty on day one. Rather than have each org admin tick the same checkbox
on every role, this back-fill adds the read grant to every existing policy once.

`manage_announcements` is deliberately NOT granted here. It is the admin
surface and stays an explicit, per-designation decision by an org admin.

What this does (idempotent — safe to re-run)
--------------------------------------------
1. Verifies the `permissions` catalog row `core_hr:view_announcements` exists
   (written by `scripts.seed_permissions`). Without it the policy grid has no
   checkbox to render and the grant would be invisible in the UI.
2. Loads every live `policies` row (`deleted_on: null`), by default only the
   role/designation policies (`is_role: true`) — those are what employees carry
   in `users.policy_ids`. Pass `--all-policies` to include non-role policies.
3. For each policy without a live `core_hr:view_announcements` grant, inserts
   one `module_acl_permissions` row (`acl_id` defaults to `viewer`, since the
   code is read-only). Policies that already hold the grant under *any* ACL are
   left untouched — that is what makes the script re-runnable.

Inactive-but-not-deleted policies are included on purpose: permission
resolution skips them today, but re-activating one later should not require
re-running this migration.

Deploy-then-apply ordering
--------------------------
The session projection only records a code that is valid for its module
(`src/auth/utils/user_session.py::_module_actions` -> `MODULE_PERMISSIONS`), so
grants written before the code deploy are silently dropped at login. Run in
this order:

  1. Deploy the code carrying the two new `PermissionCodeEnum` members.
  2. `python -m scripts.seed_permissions`            (publishes the catalog)
  3. `python -m scripts.migrate_announcement_permissions`   (this script)

Affected users must **re-login**: the resolved permission grid is written into
the shared Valkey session at login and is not refreshed in place. Super admins
and org admins bypass permission checks entirely and need neither the grant nor
a re-login.

Usage (from the IAM repo root, venv active, Mongo reachable)
------------------------------------------------------------
    python -m scripts.migrate_announcement_permissions --dry-run   # report only
    python -m scripts.migrate_announcement_permissions             # apply
    python -m scripts.migrate_announcement_permissions --org-id <org_id>
    python -m scripts.migrate_announcement_permissions --acl editor
    python -m scripts.migrate_announcement_permissions --all-policies
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone

from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.models import (
    AclRoleEnum,
    ModuleEnum,
    PermissionCodeEnum,
    PermissionDocument,
    permission_doc_id,
)
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.policies.utils import grants as grants_repo

_MODULE = ModuleEnum.CORE_HR.value                        # "core_hr"
_PERMISSION = PermissionCodeEnum.VIEW_ANNOUNCEMENTS.value  # "view_announcements"
_CATALOG_ID = permission_doc_id(ModuleEnum.CORE_HR, PermissionCodeEnum.VIEW_ANNOUNCEMENTS)
_ACTOR = "system"
_NO_ORG = "global (no organisation)"


async def _check_catalog(dry_run: bool) -> bool:
    """Return True when the `core_hr:view_announcements` catalog row exists."""
    row = await PermissionDocument.find_one(PermissionDocument.id == _CATALOG_ID)
    if row is not None:
        print(f"  catalog row present: {_CATALOG_ID}")
        return True
    print(f"  MISSING catalog row: {_CATALOG_ID}")
    print("  Run `python -m scripts.seed_permissions` first (deploy -> seed -> migrate).")
    return dry_run  # dry-run keeps going so the report is still useful


async def _load_policies(org_id: str | None, roles_only: bool) -> list[PolicyDocument]:
    """Live policies to back-fill, oldest first for deterministic output."""
    query: dict = {"deleted_on": None}
    if roles_only:
        query["is_role"] = True
    if org_id is not None:
        query["organisation_id"] = PydanticObjectId(org_id)
    return await PolicyDocument.find(query).sort("_id").to_list()


async def _org_names(db) -> dict[str, str]:
    """{organisation_id: legal_name} for readable per-org summaries."""
    rows = await db["organisations"].find({}, {"legal_name": 1}).to_list(None)
    return {str(r["_id"]): r.get("legal_name") or str(r["_id"]) for r in rows}


async def _grant_policy(policy: PolicyDocument, acl: str, dry_run: bool) -> bool:
    """Ensure the read grant exists on one policy. Returns True when it was added.

    Existence is checked across every ACL role, so a policy that already has the
    permission under `admin`/`editor` is not given a duplicate `viewer` row.
    """
    policy_id = str(policy.id)
    if await grants_repo.exists_grant([policy_id], _MODULE, _PERMISSION):
        return False
    if not dry_run:
        now = datetime.now(timezone.utc)
        await grants_repo.insert_grant({
            "policy_id": policy.id,
            "module_id": _MODULE,
            "acl_id": acl,
            "permission_id": _PERMISSION,
            "created_by": _ACTOR,
            "created_on": now,
            "modified_by": _ACTOR,
            "modified_on": now,
        })
    return True


async def backfill(db, acl: str, org_id: str | None, roles_only: bool, dry_run: bool) -> dict[str, int]:
    """Add the read grant to every matching policy, reporting per organisation."""
    policies = await _load_policies(org_id, roles_only)
    if not policies:
        print("  no matching policies found.")
        return {"policies": 0, "granted": 0, "already_present": 0}

    names = await _org_names(db)
    buckets: dict[str, list[PolicyDocument]] = {}
    for policy in policies:
        key = str(policy.organisation_id) if policy.organisation_id else ""
        buckets.setdefault(key, []).append(policy)

    totals = {"policies": len(policies), "granted": 0, "already_present": 0}
    verb = "would grant" if dry_run else "granted"

    for key in sorted(buckets, key=lambda k: names.get(k, k)):
        granted = present = 0
        for policy in buckets[key]:
            if await _grant_policy(policy, acl, dry_run):
                granted += 1
            else:
                present += 1
        totals["granted"] += granted
        totals["already_present"] += present
        label = names.get(key, key) if key else _NO_ORG
        print(f"  {label}: {len(buckets[key])} policies - {verb} {granted}, already had it {present}")

    return totals


async def run(args: argparse.Namespace) -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    acl = args.acl
    valid_acls = {r.value for r in AclRoleEnum}
    if acl not in valid_acls:
        raise SystemExit(f"ERROR: --acl must be one of {sorted(valid_acls)}")
    if args.org_id and not PydanticObjectId.is_valid(args.org_id):
        raise SystemExit(f"ERROR: --org-id is not a valid ObjectId: {args.org_id}")

    dry_run = args.dry_run
    if dry_run:
        print("################  DRY RUN - no writes will be made  ################\n")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[PolicyDocument, ModuleAclPermissionDocument, PermissionDocument],
    )

    scope = "role policies only" if not args.all_policies else "all policies"
    print(f"--- Announcements read grant ({_MODULE}:{_PERMISSION}, acl={acl}, {scope}) ---")

    print("\nStep 1 - catalog check")
    if not await _check_catalog(dry_run):
        client.close()
        raise SystemExit("ERROR: aborting - the permission catalog is not seeded.")

    print("\nStep 2 - back-filling policy grants")
    totals = await backfill(db, acl, args.org_id, not args.all_policies, dry_run)

    print("\n=====================================================================")
    print(f"  policies scanned : {totals['policies']}")
    print(f"  grants {'to add ' if dry_run else 'added  '}    : {totals['granted']}")
    print(f"  already present  : {totals['already_present']}")
    if dry_run:
        print("  DRY RUN - nothing was written. Re-run without --dry-run to apply.")
    else:
        print("  Done. Affected users must re-login before the permission takes effect.")
    print("=====================================================================")

    client.close()


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Grant core_hr:view_announcements to every existing role policy.",
    )
    ap.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    ap.add_argument("--org-id", default=None, help="Limit the back-fill to one organisation id.")
    ap.add_argument(
        "--acl",
        default=AclRoleEnum.VIEWER.value,
        help=f"ACL role for new grants (default: {AclRoleEnum.VIEWER.value}).",
    )
    ap.add_argument(
        "--all-policies",
        action="store_true",
        help="Include non-role policies (is_role=false), not just role/designation policies.",
    )
    return ap.parse_args()


if __name__ == "__main__":
    asyncio.run(run(_parse_args()))
