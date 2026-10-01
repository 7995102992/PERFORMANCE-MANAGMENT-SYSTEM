"""Back-fill the new `core_hr:resource_management` permission from the legacy
`core_hr:create_resource` grants.

Why
---
The employee routes (`/employees/*`) used to sit behind the blanket
`core_hr:create_resource` grant — the same code that gates business units,
departments, designations, bands, paygrades, org documents and custom fields.
That made "can see the employee list" and "can edit an employee record"
indistinguishable.

They now sit behind `core_hr:resource_management`, which is LEVELLED: viewer
reads, editor writes, admin deletes (see `require_permission_level`).
`create_resource` is untouched and still gates the rest of Core HR.

What this does
--------------
1. Upserts the `core_hr:resource_management` row into the `permissions` lookup
   so the policy editor can offer it.
2. For every live `core_hr:create_resource` grant, inserts a matching
   `core_hr:resource_management` grant under the SAME (policy_id, acl_id).
   The legacy rows are KEPT — they still carry the rest of Core HR.

The access question
-------------------
Under the old gate the acl column was ignored: anyone holding
`create_resource` at ANY level could create, update and delete employees. So
copying the acl across faithfully will REDUCE what some policies can do — a
policy granted at `viewer` becomes read-only, which is the whole point of the
change, but it is a behaviour change and not a silent one.

By default the acl is preserved and every policy landing below `admin` is
listed at the end, so you can review them in the policy editor. Pass
`--grant-admin` to instead copy every grant in at `admin`, which preserves
today's effective access exactly and lets you downgrade policies by hand
afterwards.

Idempotent: re-running skips grants that already exist.

Usage
-----
    python -m scripts.migrate_core_hr_resource_management --dry-run
    python -m scripts.migrate_core_hr_resource_management
    python -m scripts.migrate_core_hr_resource_management --grant-admin
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.lookups.utils import tools as lookups_repo
from src.models import (
    AclDocument,
    AclRoleEnum,
    ModuleDocument,
    ModuleEnum,
    PermissionCodeEnum,
    PermissionDocument,
    permission_doc_id,
    permission_label,
)

MODULE_ID = ModuleEnum.CORE_HR.value
LEGACY_CODE = PermissionCodeEnum.CREATE_RESOURCE.value
NEW_CODE = PermissionCodeEnum.RESOURCE_MANAGEMENT.value


# ---------------------------------------------------------------------------
# Lookup catalog
# ---------------------------------------------------------------------------

async def seed_permission_lookup(dry_run: bool) -> None:
    """Upsert the single new PermissionDocument row so the editor can offer it."""
    row = {
        "id": permission_doc_id(ModuleEnum.CORE_HR, PermissionCodeEnum.RESOURCE_MANAGEMENT),
        "module": ModuleEnum.CORE_HR,
        "code": PermissionCodeEnum.RESOURCE_MANAGEMENT,
        "label": permission_label(ModuleEnum.CORE_HR, PermissionCodeEnum.RESOURCE_MANAGEMENT),
    }
    if not dry_run:
        await lookups_repo.upsert_permission(row)
    verb = "would upsert" if dry_run else "upserted"
    print(f"  {verb} permission lookup: {row['id']} ({row['label']})")


# ---------------------------------------------------------------------------
# Grant back-fill
# ---------------------------------------------------------------------------

async def backfill_grants(db, dry_run: bool, grant_admin: bool) -> dict:
    coll = db["module_acl_permissions"]
    now = datetime.now(timezone.utc)

    legacy_rows = await coll.find(
        {"module_id": MODULE_ID, "permission_id": LEGACY_CODE, "deleted_on": None}
    ).to_list(None)

    inserted = 0
    skipped = 0
    # policy_id -> acl the policy ends up with on the new code (highest seen)
    landed: dict[str, str] = {}
    rank = {AclRoleEnum.VIEWER.value: 0, AclRoleEnum.EDITOR.value: 1, AclRoleEnum.ADMIN.value: 2}

    for row in legacy_rows:
        policy_id = row["policy_id"]
        acl_id = AclRoleEnum.ADMIN.value if grant_admin else row["acl_id"]

        held = landed.get(policy_id)
        if held is None or rank.get(acl_id, 0) > rank.get(held, 0):
            landed[policy_id] = acl_id

        existing = await coll.find_one({
            "policy_id": policy_id,
            "module_id": MODULE_ID,
            "acl_id": acl_id,
            "permission_id": NEW_CODE,
            "deleted_on": None,
        })
        if existing is not None:
            skipped += 1
            continue

        if not dry_run:
            await coll.insert_one({
                "policy_id": policy_id,
                "module_id": MODULE_ID,
                "acl_id": acl_id,
                "permission_id": NEW_CODE,
                "created_on": now,
                "modified_on": now,
                "deleted_on": None,
            })
        inserted += 1

    return {
        "found": len(legacy_rows),
        "inserted": inserted,
        "skipped_already_present": skipped,
        "landed": landed,
    }


async def _policy_names(db, policy_ids: list[str]) -> dict[str, str]:
    """Resolve policy ids to names for the review report (best effort)."""
    if not policy_ids:
        return {}
    from bson import ObjectId

    oids = []
    for pid in policy_ids:
        try:
            oids.append(ObjectId(pid))
        except Exception:  # noqa: BLE001 — a non-ObjectId id just goes unnamed
            continue
    rows = await db["policies"].find({"_id": {"$in": oids}}, {"name": 1}).to_list(None)
    return {str(r["_id"]): r.get("name", "") for r in rows}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

async def run(args: argparse.Namespace) -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    if args.dry_run:
        print("################  DRY RUN - no writes will be made  ################\n")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[AclDocument, ModuleDocument, PermissionDocument],
    )

    print("Step 1 — permission catalog")
    await seed_permission_lookup(args.dry_run)

    print("\nStep 2 — back-filling grants")
    counts = await backfill_grants(db, args.dry_run, args.grant_admin)
    print(f"  legacy {MODULE_ID}:{LEGACY_CODE} grants found: {counts['found']}")
    print(f"  {NEW_CODE} grants inserted: {counts['inserted']}")
    print(f"  already present (skipped): {counts['skipped_already_present']}")
    if args.grant_admin:
        print("  --grant-admin: every grant copied in at 'admin' (access preserved)")

    below = {p: a for p, a in counts["landed"].items() if a != AclRoleEnum.ADMIN.value}
    if below:
        names = await _policy_names(db, list(below))
        print(
            f"\n  {len(below)} policy/policies land below 'admin' on {NEW_CODE} and so "
            "lose employee delete (and, at viewer, create/edit) — review these:"
        )
        for pid, acl in sorted(below.items(), key=lambda kv: kv[1]):
            print(f"    - {names.get(pid, '(unnamed)')} [{pid}] -> {acl}")

    print("\nStep 3 — sessions")
    print("  Cached sessions keep the old grid until the access token expires.")
    print("  Users see the change on next login / token refresh.")

    print("\nDone." if not args.dry_run else "\nDRY RUN - nothing was written.")
    client.close()


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Back-fill core_hr:resource_management from core_hr:create_resource."
    )
    ap.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    ap.add_argument(
        "--grant-admin",
        action="store_true",
        help="Copy every grant in at 'admin' instead of preserving the source acl, "
             "so no policy loses access on deploy.",
    )
    return ap.parse_args()


if __name__ == "__main__":
    asyncio.run(run(_parse_args()))
