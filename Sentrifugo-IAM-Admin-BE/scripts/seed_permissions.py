"""Seed the permission catalog (ACL roles, modules, permissions) for the platform.

This is the IAM-side seed that makes the *whole platform's* authorization work:
all downstream services (Service Request, Timesheet) read the permission grid
that IAM writes into the shared Valkey session at login. The catalog seeded
here is the source of truth the policy/designation editors build on top of.

What it does (idempotent — safe to re-run):
  * Lookups — upsert ACL roles (admin/editor/viewer), Modules, and Permissions
              from MODULE_PERMISSIONS (the canonical catalog in src/models.py).

This is pure master data: it is org-agnostic and has no org dependency, so it
runs cleanly on a fresh database. Enabling modules *on an organisation* is a
separate concern owned by the org create/update API (the frontend drives it) —
it is deliberately not done here.

Note: role policies / grants are NOT created here — permissions are attached to
designations. This script only populates the catalog those attachments draw from.

Context
  * Super admin / org admin bypass ALL permission checks.
  * Schedule and Logging services do NOT enforce IAM permissions at their
    routes (auth-only / API-key).
  * Leave Management is auth-only at its routes EXCEPT for the dedicated HR
    capability (approve_as_hr), which it now enforces: holders may act on /
    view leave requests under plans that enable allow_hr_to_act /
    allow_hr_to_view. Granting that capability here makes the toggles live.

Usage (from the IAM repo root, venv active, Mongo reachable):
    python -m scripts.seed_permissions --dry-run          # report, no writes
    python -m scripts.seed_permissions                    # seed the catalog
"""
from __future__ import annotations

import argparse
import asyncio

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.lookups.utils import tools as lookups_repo
from src.models import (
    MODULE_LABELS,
    MODULE_PERMISSIONS,
    AclDocument,
    AclRoleEnum,
    ModuleDocument,
    ModuleEnum,
    PermissionDocument,
    permission_doc_id,
    permission_label,
)

# Functional modules with a running backend / FE surface — seeded into the catalog.
MODULES_IN_SCOPE = [
    ModuleEnum.CORE_HR,
    ModuleEnum.SERVICE_REQUEST,
    ModuleEnum.TIMESHEET_MANAGEMENT,
    ModuleEnum.LEAVE_MANAGEMENT,
    ModuleEnum.REPORTS_AND_ANALYTICS,
    ModuleEnum.EXPENSE_MANAGEMENT,
]


# ─── Lookups ────────────────────────────────────────────────────────────────

async def seed_lookups(dry_run: bool) -> None:
    if not dry_run:
        for role, label, rank in (
            (AclRoleEnum.ADMIN, "Administrator", 2),
            (AclRoleEnum.EDITOR, "Editor", 1),
            (AclRoleEnum.VIEWER, "Viewer", 0),
        ):
            await lookups_repo.upsert_acl({"id": role.value, "role": role, "label": label, "rank": rank})

        for mod in MODULES_IN_SCOPE:
            await lookups_repo.upsert_module({
                "id": mod.value,
                "code": mod,
                "label": MODULE_LABELS.get(mod, mod.value),
                "description": MODULE_LABELS.get(mod, mod.value),
                "mandatory": mod == ModuleEnum.CORE_HR,
            })

        for mod in MODULES_IN_SCOPE:
            for code in MODULE_PERMISSIONS.get(mod, set()):
                await lookups_repo.upsert_permission({
                    "id": permission_doc_id(mod, code),
                    "module": mod,
                    "code": code,
                    "label": permission_label(mod, code),
                })

    perm_count = sum(len(MODULE_PERMISSIONS.get(m, set())) for m in MODULES_IN_SCOPE)
    verb = "would upsert" if dry_run else "upserted"
    print(f"  lookups {verb}: 3 acl, {len(MODULES_IN_SCOPE)} modules, {perm_count} permissions")


# ─── Main ─────────────────────────────────────────────────────────────────────

async def seed(args: argparse.Namespace) -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    dry_run = args.dry_run
    if dry_run:
        print("################  DRY RUN - no writes will be made  ################\n")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[AclDocument, ModuleDocument, PermissionDocument],
    )

    print("--- Lookups ---------------------------------------------------------")
    await seed_lookups(dry_run)

    print("\n=====================================================================")
    if dry_run:
        print("  DRY RUN - nothing was written. Re-run without --dry-run to apply.")
    else:
        print("  Catalog seeded. Permissions are attached to designations elsewhere.")
    print("=====================================================================")

    client.close()


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Seed the permission catalog (ACL/modules/permissions).")
    ap.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    return ap.parse_args()


if __name__ == "__main__":
    asyncio.run(seed(_parse_args()))
