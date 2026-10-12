"""Seed the 7 PMS roles (Corporate HR, GP, Employee, Section Head / Reporting
Manager, HOD / Functional Head, Plant HR, Plant Head) with the Performance
Management grants from PERMISSION_SEEDING.md section 6 ("Seed rows (default)").
DEVELOPMENT ONLY.

What it does (idempotent — safe to re-run):
  * Finds the target organisation through an existing org admin (same
    convention as seed_employees.py / seed_pms_test_users.py; override with
    PMS_ROLES_ORG_ADMIN_EMAIL).
  * For each of the 7 roles: if a policy of that exact name already exists in
    the org, SKIPS it entirely (never touches its grants) and prints a diff
    against the section-6 matrix. Otherwise creates the role as a new policy
    (is_role=True) and grants exactly the Performance Management permissions
    listed for it, at the level (Viewer/Editor/Administrator) given.
  * Only writes performance_management grants on roles THIS script creates.
    No other module, no Core HR grant, no existing role, user or UI file is
    touched. The six "extra" permission rows from section 7 (HR Competency
    Rating, Verification, Transfers, Audit Trail, Version History, Appraisal
    Dashboard) are never added — adding them is a schema change (new codes in
    src/models.py) out of scope for this script and is only done with
    explicit, separate approval.

Does NOT create or assign any users.

Usage (from the IAM repo root, venv active, Mongo reachable):
    python -m scripts.seed_pms_roles --dry-run     # report, no writes
    python -m scripts.seed_pms_roles               # seed for real
    python -m scripts.seed_pms_roles --verify       # read-only: print every
                                                     # role's granted PMS
                                                     # permissions and level
"""

from __future__ import annotations

import argparse
import asyncio
import os
from datetime import datetime, timezone

from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.config import settings
from src.models import AclRoleEnum, ModuleEnum, PermissionCodeEnum, permission_label
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.policies.utils import grants as policy_repo

SEED_MARKER = "seed_pms_roles"
MODULE = ModuleEnum.PERFORMANCE_MANAGEMENT

# Org whose roles we seed, resolved via an existing org admin's email
# (same convention as seed_employees.py / seed_pms_team.py).
ORG_ADMIN_EMAIL = os.getenv("PMS_ROLES_ORG_ADMIN_EMAIL", "akhil.nandanavanam+tblk@sagarsoft.in")

P = PermissionCodeEnum
A = AclRoleEnum

# Section 6 "Seed rows (default)" for each role, exactly as written in
# PERMISSION_SEEDING.md. One (permission, level) pair per granted row;
# anything not listed here is deliberately NOT granted.
ROLE_PERMISSIONS: dict[str, list[tuple[PermissionCodeEnum, AclRoleEnum]]] = {
    "Corporate HR": [
        (P.PMS_CYCLE, A.ADMIN),
        (P.GOAL_TEMPLATE, A.ADMIN),
        (P.KRA_MASTER, A.ADMIN),
        (P.KPI_MASTER, A.ADMIN),
        (P.COMPETENCY_MASTER, A.ADMIN),
        (P.RATING_SCALE, A.ADMIN),
        (P.RATING_NORMALIZATION, A.ADMIN),
        (P.CYCLE_CLOSURE, A.ADMIN),
        (P.TARGET_REVISION, A.EDITOR),
        (P.MY_GOALS, A.EDITOR),
        (P.SELF_APPRAISAL, A.EDITOR),
        (P.MID_YEAR_REVIEW, A.EDITOR),
        (P.TEAM_APPRAISAL, A.EDITOR),
        (P.APPRAISAL_HISTORY, A.VIEWER),
    ],
    "GP": [
        (P.GOAL_TEMPLATE, A.VIEWER),
        (P.KRA_MASTER, A.VIEWER),
        (P.KPI_MASTER, A.VIEWER),
        (P.COMPETENCY_MASTER, A.VIEWER),
        (P.RATING_SCALE, A.VIEWER),
    ],
    "Employee": [
        (P.MY_GOALS, A.EDITOR),
        (P.PROGRESS, A.EDITOR),
        (P.SELF_APPRAISAL, A.EDITOR),
        (P.MY_RATING, A.VIEWER),
    ],
    "Section Head / Reporting Manager": [
        (P.TEAM_GOALS, A.EDITOR),
        (P.TEAM_PROGRESS, A.VIEWER),
        (P.MID_YEAR_REVIEW, A.EDITOR),
        (P.TEAM_APPRAISAL, A.EDITOR),
        (P.MY_GOALS, A.EDITOR),
        (P.SELF_APPRAISAL, A.EDITOR),
    ],
    "HOD / Functional Head": [
        (P.TEAM_GOALS, A.EDITOR),
        (P.GOAL_APPROVAL, A.EDITOR),
        (P.TARGET_REVISION, A.EDITOR),
        (P.TEAM_PROGRESS, A.VIEWER),
        (P.MID_YEAR_REVIEW, A.EDITOR),
        (P.APPRAISAL_REVIEW, A.EDITOR),
        (P.MY_GOALS, A.EDITOR),
        (P.SELF_APPRAISAL, A.EDITOR),
    ],
    "Plant HR": [
        (P.TEAM_GOALS, A.EDITOR),
        (P.TEAM_PROGRESS, A.VIEWER),
        (P.MID_YEAR_REVIEW, A.EDITOR),
        (P.TEAM_APPRAISAL, A.EDITOR),
        (P.MY_GOALS, A.EDITOR),
        (P.SELF_APPRAISAL, A.EDITOR),
        (P.APPRAISAL_HISTORY, A.VIEWER),
    ],
    "Plant Head": [
        (P.TEAM_GOALS, A.EDITOR),
        (P.GOAL_APPROVAL, A.EDITOR),
        (P.TARGET_REVISION, A.EDITOR),
        (P.TEAM_PROGRESS, A.VIEWER),
        (P.MID_YEAR_REVIEW, A.EDITOR),
        (P.TEAM_APPRAISAL, A.EDITOR),
        (P.MY_GOALS, A.EDITOR),
        (P.SELF_APPRAISAL, A.EDITOR),
        (P.APPRAISAL_HISTORY, A.VIEWER),
    ],
}


def _print(msg: str = "") -> None:
    print(msg)


async def _find_org_id() -> PydanticObjectId:
    org_admin = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL.lower())
    if not org_admin or not org_admin.organisation_id:
        raise SystemExit(
            f"ERROR: org admin {ORG_ADMIN_EMAIL} not found or has no organisation. "
            "Set PMS_ROLES_ORG_ADMIN_EMAIL to an org admin's email."
        )
    return org_admin.organisation_id


def _row_label(code: PermissionCodeEnum) -> str:
    return permission_label(MODULE, code)


async def _report_diff(role_name: str, existing: dict, desired: list[tuple[PermissionCodeEnum, AclRoleEnum]]) -> None:
    """Role already exists and is untouched. Report how its live grants differ
    from the section-6 matrix, without changing anything."""
    live_rows = await policy_repo.list_grants_for_policy(existing["id"])
    live_pm = {
        r["permission_id"]: r["acl_id"]
        for r in live_rows
        if r["module_id"] == MODULE.value
    }
    desired_map = {code.value: level.value for code, level in desired}

    missing = [c for c in desired_map if c not in live_pm]
    extra = [c for c in live_pm if c not in desired_map]
    mismatched = [c for c in desired_map if c in live_pm and live_pm[c] != desired_map[c]]

    if not missing and not extra and not mismatched:
        _print(f"  SKIP (already exists, created_by={existing.get('created_by')!r}): "
               f"'{role_name}' - grants already match section 6 exactly.")
        return

    _print(f"  SKIP (already exists, created_by={existing.get('created_by')!r}): '{role_name}' - "
           f"differs from section 6 (not changed, additive-only):")
    for c in missing:
        _print(f"    missing: {_row_label(PermissionCodeEnum(c))} should be {desired_map[c]}")
    for c in extra:
        _print(f"    extra:   {_row_label(PermissionCodeEnum(c))} is {live_pm[c]} (not in section 6 seed rows)")
    for c in mismatched:
        _print(f"    level mismatch: {_row_label(PermissionCodeEnum(c))} is {live_pm[c]}, section 6 says {desired_map[c]}")


async def seed(dry_run: bool) -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[UserDocument, PolicyDocument, ModuleAclPermissionDocument],
    )

    if dry_run:
        _print("################  DRY RUN - no writes will be made  ################\n")

    now = datetime.now(timezone.utc)
    try:
        org_id = await _find_org_id()
        _print(f"Organisation: {org_id}\n")

        _print("--- Roles and grants -------------------------------------------------")
        for role_name, desired in ROLE_PERMISSIONS.items():
            existing = await policy_repo.get_policy_by_name(role_name, organisation_id=str(org_id))

            if existing:
                await _report_diff(role_name, existing, desired)
                continue

            if dry_run:
                _print(f"  WOULD CREATE role: '{role_name}'")
                for code, level in desired:
                    _print(f"    + {_row_label(code)}: {level.value}")
                continue

            created = await policy_repo.create_policy({
                "name": role_name,
                "is_role": True,
                "is_active": True,
                "organisation_id": org_id,
                "seed_module_codes": [],
                "created_by": SEED_MARKER,
                "created_on": now,
                "modified_by": SEED_MARKER,
                "modified_on": now,
            })
            _print(f"  role created: '{role_name}' ({created['id']})")

            desired_triples = {
                (MODULE.value, level.value, code.value)
                for code, level in desired
            }
            inserts, removes = await policy_repo.replace_policy_grants(
                created["id"], desired_triples, current_user_id=SEED_MARKER,
            )
            _print(f"    grants: {len(desired_triples)} wanted, +{inserts} added, -{removes} removed")

        _print("\n=======================================================================")
        if dry_run:
            _print("  DRY RUN - nothing was written. Re-run without --dry-run to apply.")
        else:
            _print("  PMS roles seeded. No users created or assigned.")
        _print("=======================================================================")
    finally:
        client.close()


async def verify() -> None:
    """Read-only: print every one of the 7 roles' granted PMS permissions and level."""
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[UserDocument, PolicyDocument, ModuleAclPermissionDocument],
    )
    try:
        org_id = await _find_org_id()
        _print(f"Organisation: {org_id}\n")
        _print("--- Verification ------------------------------------------------------")
        for role_name in ROLE_PERMISSIONS:
            existing = await policy_repo.get_policy_by_name(role_name, organisation_id=str(org_id))
            if not existing:
                _print(f"  '{role_name}': NOT FOUND")
                continue
            live_rows = await policy_repo.list_grants_for_policy(existing["id"])
            pm_rows = sorted(
                (r for r in live_rows if r["module_id"] == MODULE.value),
                key=lambda r: r["permission_id"],
            )
            _print(f"  '{role_name}' (created_by={existing.get('created_by')!r}):")
            if not pm_rows:
                _print("    (no Performance Management grants)")
            for r in pm_rows:
                code = PermissionCodeEnum(r["permission_id"])
                _print(f"    {_row_label(code)}: {r['acl_id']}")
        _print("=======================================================================")
    finally:
        client.close()


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Seed the 7 PMS roles with their Performance Management grants (section 6, default rows only)."
    )
    ap.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    ap.add_argument("--verify", action="store_true", help="Read-only: print each role's granted permissions.")
    ap.add_argument(
        "--with-extra-permissions", action="store_true",
        help="Not implemented: the 6 extra rows (section 7) require adding new permission codes "
             "to src/models.py, which this script will not do without separate, explicit approval.",
    )
    return ap.parse_args()


async def _main() -> None:
    args = _parse_args()
    if args.with_extra_permissions:
        raise SystemExit(
            "ERROR: --with-extra-permissions is not implemented. Adding the 6 extra rows "
            "(HR Competency Rating, Verification, Transfers, Audit Trail, Version History, "
            "Appraisal Dashboard) requires a schema change in src/models.py (new permission "
            "codes), which needs separate explicit approval before any code is written."
        )
    if args.verify:
        await verify()
        return
    await seed(args.dry_run)


if __name__ == "__main__":
    asyncio.run(_main())
