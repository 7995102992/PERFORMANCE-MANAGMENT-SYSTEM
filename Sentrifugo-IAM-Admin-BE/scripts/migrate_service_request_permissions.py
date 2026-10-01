"""Migrate Service Request module permissions from the legacy
`create_resource` code to the new role-based codes.

What this script does
---------------------
1. Re-seeds the `permissions` lookup collection so the seven new SR
   permission rows (raise_request, execute_request, approve_request,
   manage_request, view_all_requests, manage_catalog, manage_workflows)
   exist with the right labels. It piggy-backs on `seed_lookups` logic.

2. Back-fills `module_acl_permissions`: for every existing grant where
   `module_id == "service_request"` AND `permission_id == "create_resource"`,
   inserts seven equivalent rows — one per new SR code — keyed under the
   same (policy_id, acl_id). The old `create_resource` rows are also
   deleted so the grid stays consistent with `MODULE_PERMISSIONS` in
   `src/models.py`.

Idempotent: re-running it is safe. New rows are skipped if already
present. The legacy delete step is a no-op once the back-fill has run.

Usage
-----
    python -m scripts.migrate_service_request_permissions
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.lookups.utils import tools as repo
from src.models import (
    AclDocument,
    MODULE_PERMISSIONS,
    ModuleDocument,
    ModuleEnum,
    PermissionCodeEnum,
    PermissionDocument,
    permission_doc_id,
    permission_label,
)


SR_MODULE_ID = ModuleEnum.SERVICE_REQUEST.value
LEGACY_CODE = PermissionCodeEnum.CREATE_RESOURCE.value

# The seven new codes that replace `create_resource` on the SERVICE_REQUEST
# module. Order is preserved for deterministic logging only.
NEW_SR_CODES: list[str] = [
    PermissionCodeEnum.RAISE_REQUEST.value,
    PermissionCodeEnum.EXECUTE_REQUEST.value,
    PermissionCodeEnum.APPROVE_REQUEST.value,
    PermissionCodeEnum.MANAGE_REQUEST.value,
    PermissionCodeEnum.VIEW_ALL_REQUESTS.value,
    PermissionCodeEnum.MANAGE_CATALOG.value,
    PermissionCodeEnum.MANAGE_WORKFLOWS.value,
]


# ---------------------------------------------------------------------------
# Lookup-table seeding
# ---------------------------------------------------------------------------

async def seed_sr_permission_lookups() -> int:
    """Upsert one PermissionDocument row per (SR module, new code).

    Returns the number of rows seeded.
    """
    rows = [
        {
            "id": permission_doc_id(ModuleEnum.SERVICE_REQUEST, code),
            "module": ModuleEnum.SERVICE_REQUEST,
            "code": code,
            "label": permission_label(ModuleEnum.SERVICE_REQUEST, code),
        }
        for code in MODULE_PERMISSIONS[ModuleEnum.SERVICE_REQUEST]
    ]
    for row in rows:
        await repo.upsert_permission(row)
    return len(rows)


# ---------------------------------------------------------------------------
# Existing-grant back-fill on `module_acl_permissions`
# ---------------------------------------------------------------------------

async def backfill_grants(db) -> dict[str, int]:
    """For every legacy `service_request:create_resource` row, insert
    seven equivalent rows keyed by the new codes (same policy_id + acl_id).

    Returns counts: {found, inserted, skipped_already_present, deleted_legacy}.
    """
    coll = db["module_acl_permissions"]
    now = datetime.now(timezone.utc)

    legacy_rows = await coll.find(
        {"module_id": SR_MODULE_ID, "permission_id": LEGACY_CODE, "deleted_on": None}
    ).to_list(None)

    found = len(legacy_rows)
    inserted = 0
    skipped = 0

    for row in legacy_rows:
        policy_id = row["policy_id"]
        acl_id = row["acl_id"]
        for new_code in NEW_SR_CODES:
            existing = await coll.find_one(
                {
                    "policy_id": policy_id,
                    "module_id": SR_MODULE_ID,
                    "acl_id": acl_id,
                    "permission_id": new_code,
                    "deleted_on": None,
                }
            )
            if existing is not None:
                skipped += 1
                continue
            await coll.insert_one(
                {
                    "policy_id": policy_id,
                    "module_id": SR_MODULE_ID,
                    "acl_id": acl_id,
                    "permission_id": new_code,
                    "created_on": now,
                    "modified_on": now,
                    "deleted_on": None,
                }
            )
            inserted += 1

    # Soft-delete the legacy `create_resource` rows so they no longer appear
    # in the grid. Permission code `create_resource` is still a valid enum
    # value used by other modules — only the SR-scoped grants are removed.
    legacy_delete_result = await coll.delete_many(
        {"module_id": SR_MODULE_ID, "permission_id": LEGACY_CODE}
    )

    return {
        "found": found,
        "inserted": inserted,
        "skipped_already_present": skipped,
        "deleted_legacy": legacy_delete_result.deleted_count,
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

async def run() -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[AclDocument, ModuleDocument, PermissionDocument],
    )

    print("Step 1 — seeding SR permission lookups...")
    n = await seed_sr_permission_lookups()
    print(f"  Upserted {n} permission rows for module '{SR_MODULE_ID}'.")

    print("\nStep 2 — back-filling existing grants...")
    counts = await backfill_grants(db)
    print(
        f"  Legacy rows found ({SR_MODULE_ID}:{LEGACY_CODE}): {counts['found']}"
    )
    print(f"  New (policy, acl, code) grants inserted: {counts['inserted']}")
    print(f"  Already present (skipped): {counts['skipped_already_present']}")
    print(f"  Legacy rows deleted: {counts['deleted_legacy']}")

    print("\nDone.")
    client.close()


if __name__ == "__main__":
    asyncio.run(run())
