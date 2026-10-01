"""Move the Service Request *analytics* permissions from the `service_request`
module to the `reports_and_analytics` module.

Why
---
All analytics permissions (leave / timesheet / exit / service-request) are being
consolidated under the `reports_and_analytics` module. SR's analytics dashboards
stay role-based (view_my / view_executor / view_approver / view_team /
view_org) — only the module they are enforced under changes. The SRM analytics
gate now reads `has_permission("reports_and_analytics", <code>)` (see
`src/analytics/scoping.py`), and `MODULE_PERMISSIONS` in `src/models.py` lists
these five codes under REPORTS_AND_ANALYTICS.

Because the session projection only records a code that is valid for its module
(`user_session._module_actions` -> `MODULE_PERMISSIONS`), the DB grants MUST move
in lockstep with the code deploy or granted users silently lose the dashboard.

What this does
--------------
1. Seeds the five analytics `permissions` lookup rows under
   `reports_and_analytics` (labels from `permission_label`).
2. For every `module_acl_permissions` grant where
   `module_id == "service_request"` AND `permission_id` is one of the five
   analytics codes, inserts an equivalent row under
   `module_id == "reports_and_analytics"` (same policy_id + acl_id), then
   hard-deletes the old `service_request` analytics grant.
3. Removes the now-orphaned five analytics `permissions` lookup rows under
   `service_request`.

Idempotent: re-running is safe. Operational SR codes (raise_request, ...) and the
derived-entitlement logic in SRM are untouched.

Usage
-----
    python -m scripts.migrate_analytics_permissions_to_reports          # dry-run
    python -m scripts.migrate_analytics_permissions_to_reports --apply  # execute
"""

from __future__ import annotations

import asyncio
import sys

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.lookups.utils import tools as repo
from src.models import (
    AclDocument,
    ModuleDocument,
    ModuleEnum,
    PermissionCodeEnum,
    PermissionDocument,
    permission_doc_id,
    permission_label,
)

SRC_MODULE = ModuleEnum.SERVICE_REQUEST.value          # "service_request"
DST_MODULE = ModuleEnum.REPORTS_AND_ANALYTICS.value    # "reports_and_analytics"

ANALYTICS_CODES: list[PermissionCodeEnum] = [
    PermissionCodeEnum.VIEW_MY_ANALYTICS,
    PermissionCodeEnum.VIEW_EXECUTOR_ANALYTICS,
    PermissionCodeEnum.VIEW_APPROVER_ANALYTICS,
    PermissionCodeEnum.VIEW_TEAM_ANALYTICS,
    PermissionCodeEnum.VIEW_ORG_ANALYTICS,
]
# String form for module_acl_permissions.permission_id queries.
ANALYTICS_CODE_VALUES: list[str] = [c.value for c in ANALYTICS_CODES]


async def seed_dst_lookups() -> int:
    """Upsert one PermissionDocument per (reports_and_analytics, analytics code)."""
    for code in ANALYTICS_CODES:
        await repo.upsert_permission(
            {
                "id": permission_doc_id(ModuleEnum.REPORTS_AND_ANALYTICS, code),
                "module": ModuleEnum.REPORTS_AND_ANALYTICS,
                "code": code,
                "label": permission_label(ModuleEnum.REPORTS_AND_ANALYTICS, code),
            }
        )
    return len(ANALYTICS_CODES)


async def move_grants(db, apply: bool) -> dict[str, int]:
    """Move service_request analytics grants -> reports_and_analytics."""
    coll = db["module_acl_permissions"]
    src_rows = await coll.find(
        {"module_id": SRC_MODULE, "permission_id": {"$in": ANALYTICS_CODE_VALUES}}
    ).to_list(None)

    found = len(src_rows)
    inserted = skipped = deleted = 0

    for row in src_rows:
        policy_id, acl_id, code = row["policy_id"], row["acl_id"], row["permission_id"]
        existing = await coll.find_one(
            {
                "policy_id": policy_id,
                "module_id": DST_MODULE,
                "acl_id": acl_id,
                "permission_id": code,
            }
        )
        if existing is None:
            if apply:
                new_row = {k: v for k, v in row.items() if k != "_id"}
                new_row["module_id"] = DST_MODULE
                await coll.insert_one(new_row)
            inserted += 1
        else:
            skipped += 1
        if apply:
            await coll.delete_one({"_id": row["_id"]})
        deleted += 1

    return {"found": found, "inserted": inserted,
            "skipped_present": skipped, "deleted_src": deleted}


async def drop_src_lookups(db, apply: bool) -> int:
    """Remove the orphaned service_request analytics permission lookup rows."""
    ids = [permission_doc_id(ModuleEnum.SERVICE_REQUEST, c) for c in ANALYTICS_CODES]
    if not apply:
        n = await db["permissions"].count_documents({"_id": {"$in": ids}})
        return n
    res = await db["permissions"].delete_many({"_id": {"$in": ids}})
    return res.deleted_count


async def run(apply: bool) -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL not configured. Check your .env.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[AclDocument, ModuleDocument, PermissionDocument],
    )

    mode = "APPLY" if apply else "DRY-RUN (no writes)"
    print(f"=== Move SR analytics permissions {SRC_MODULE} -> {DST_MODULE} [{mode}] ===")

    if apply:
        n = await seed_dst_lookups()
        print(f"Step 1  seeded {n} lookup rows under '{DST_MODULE}'.")
    else:
        print(f"Step 1  would seed {len(ANALYTICS_CODES)} lookup rows under '{DST_MODULE}'.")

    print("Step 2  moving grants...")
    c = await move_grants(db, apply)
    print(f"  src analytics grants found : {c['found']}")
    print(f"  moved (insert dst)         : {c['inserted']}")
    print(f"  dst already present        : {c['skipped_present']}")
    print(f"  src rows removed           : {c['deleted_src']}")

    print("Step 3  dropping orphaned src lookup rows...")
    n = await drop_src_lookups(db, apply)
    print(f"  src lookup rows {'deleted' if apply else 'to delete'}: {n}")

    print("\nDone." if apply else "\nDry-run complete — re-run with --apply to execute.")
    client.close()


if __name__ == "__main__":
    asyncio.run(run(apply="--apply" in sys.argv))
