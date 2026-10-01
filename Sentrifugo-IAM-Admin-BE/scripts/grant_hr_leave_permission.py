"""Grant the dedicated HR leave permission (leave_management:approve_as_hr) to users.

This closes the loop on the Leave Management HR-escalation feature: the catalog
seed (scripts/seed_permissions.py) makes the permission *assignable*; this script
actually *grants* it. It ensures a reusable role policy carrying the grant, then
attaches that policy to the given users.

What it does (idempotent — safe to re-run):
  * Ensures a global role policy ("HR Leave Approver") exists.
  * Ensures that policy has the (leave_management, <acl>, approve_as_hr) grant.
  * Attaches the policy to each user resolved by email.

Note: resolved permissions are baked into a user's session at login. Granted
users must log in again (or refresh their token) before the Leave Management
service sees the new capability.

Usage (from the IAM repo root, venv active, Mongo reachable):
    python -m scripts.grant_hr_leave_permission --emails a@x.com,b@x.com --dry-run
    python -m scripts.grant_hr_leave_permission --emails a@x.com,b@x.com
    python -m scripts.grant_hr_leave_permission --emails a@x.com --acl admin
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone

from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.auth.models import UserDocument
from src.models import (
    AclRoleEnum,
    ModuleEnum,
    PermissionCodeEnum,
    permission_doc_id,
)
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.policies.utils import grants as grants_repo
from src.users.utils import tools as user_repo

_POLICY_NAME = "HR Leave Approver"
_MODULE = ModuleEnum.LEAVE_MANAGEMENT.value           # "leave_management"
_PERMISSION = PermissionCodeEnum.APPROVE_AS_HR.value  # "approve_as_hr"


async def _ensure_policy(dry_run: bool, policy_name: str) -> str | None:
    """Return the id of the global role policy, creating it if needed."""
    existing = await grants_repo.get_policy_by_name(policy_name, organisation_id=None)
    if existing:
        return existing["id"]
    if dry_run:
        print(f"  would create policy '{policy_name}' (global, is_role=True)")
        return None
    now = datetime.now(timezone.utc)
    created = await grants_repo.create_policy({
        "name": policy_name,
        "is_role": True,
        "is_active": True,
        "organisation_id": None,
        "created_by": "system",
        "created_on": now,
        "modified_by": "system",
        "modified_on": now,
    })
    print(f"  created policy '{policy_name}' ({created['id']})")
    return created["id"]


async def _ensure_grant(dry_run: bool, policy_id: str, acl: str) -> None:
    """Ensure the (leave_management, acl, approve_as_hr) grant exists on the policy."""
    already = await grants_repo.exists_grant([policy_id], _MODULE, _PERMISSION)
    if already:
        print(f"  grant already present: {_MODULE}:{_PERMISSION} (acl={acl})")
        return
    if dry_run:
        print(f"  would add grant: {_MODULE} / {acl} / {_PERMISSION}")
        return
    now = datetime.now(timezone.utc)
    await grants_repo.insert_grant({
        "policy_id": PydanticObjectId(policy_id),
        "module_id": _MODULE,
        "acl_id": acl,
        "permission_id": _PERMISSION,
        "created_by": "system",
        "created_on": now,
        "modified_by": "system",
        "modified_on": now,
    })
    print(f"  added grant: {_MODULE} / {acl} / {_PERMISSION}")


async def _attach_to_users(dry_run: bool, policy_id: str | None, emails: list[str]) -> None:
    for email in emails:
        user = await user_repo.get_user_by_email(email)
        if not user:
            print(f"  [skip] no user found for {email}")
            continue
        if policy_id and policy_id in (user.get("policy_ids") or []):
            print(f"  [ok] {email} already has the policy")
            continue
        if dry_run or not policy_id:
            print(f"  would attach policy to {email}")
            continue
        await user_repo.attach_policy(user["id"], policy_id)
        print(f"  attached policy to {email}")


async def run(args: argparse.Namespace) -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    acl = args.acl
    valid_acls = {r.value for r in AclRoleEnum}
    if acl not in valid_acls:
        raise SystemExit(f"ERROR: --acl must be one of {sorted(valid_acls)}")

    emails = [e.strip() for e in args.emails.split(",") if e.strip()]
    if not emails:
        raise SystemExit("ERROR: provide at least one email via --emails")

    # Sanity: the permission must exist in the catalog (run seed_permissions first).
    assert permission_doc_id(ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.APPROVE_AS_HR) \
        == f"{_MODULE}:{_PERMISSION}"

    dry_run = args.dry_run
    if dry_run:
        print("################  DRY RUN - no writes will be made  ################\n")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[PolicyDocument, ModuleAclPermissionDocument, UserDocument],
    )

    print("--- HR leave permission grant ---------------------------------------")
    policy_id = await _ensure_policy(dry_run, args.policy_name)
    if policy_id:
        await _ensure_grant(dry_run, policy_id, acl)
    await _attach_to_users(dry_run, policy_id, emails)

    print("\n=====================================================================")
    if dry_run:
        print("  DRY RUN - nothing was written. Re-run without --dry-run to apply.")
    else:
        print("  Done. Granted users must re-login before the permission takes effect.")
    print("=====================================================================")

    client.close()


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Grant the HR leave permission to users.")
    ap.add_argument("--emails", required=True, help="Comma-separated user emails to grant.")
    ap.add_argument("--acl", default=AclRoleEnum.EDITOR.value, help="ACL role for the grant (default: editor).")
    ap.add_argument("--policy-name", default=_POLICY_NAME, help=f"Role policy name (default: '{_POLICY_NAME}').")
    ap.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    return ap.parse_args()


if __name__ == "__main__":
    asyncio.run(run(_parse_args()))
