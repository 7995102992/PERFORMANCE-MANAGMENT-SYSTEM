"""Seed the PMS development test users and their roles (Corporate HR, Manager,
Employee, HOD, HR Governance) into the existing IAM. DEVELOPMENT ONLY.

What it does (idempotent — safe to re-run):
  * Finds the target organisation through an existing org admin (same
    convention as seed_employees.py; override with PMS_TEST_ORG_ADMIN_EMAIL).
  * Creates each PMS role as a policy with is_role=True, or reuses it if this
    script created it earlier. A role of the same name created by anyone else
    aborts the run, because replacing its grants would break that role.
  * Sets the role's Performance Management grants to exactly the PMS screen
    permissions below (grants outside this set are removed from these roles only).
  * Creates each test user if missing, with the single PMS role attached. Other
    policies on an existing test user are kept. Passwords of existing users
    are not changed.

Test accounts (password is the same for all five, DEV ONLY — never run this
script against production):
    pms.corporate.hr@sagarsoft.com   Corporate HR
    pms.manager@sagarsoft.com        Manager
    pms.employee@sagarsoft.com       Employee
    pms.hod@sagarsoft.com            HOD
    pms.hr.governance@sagarsoft.com  HR Governance

Usage (from the IAM repo root, venv active, Mongo reachable):
    python -m scripts.seed_pms_test_users
"""

import asyncio
import os
from datetime import datetime, timezone

from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.auth.utils.tools import get_password_hash
from src.config import settings
from src.models import AclRoleEnum, ModuleEnum, PermissionCodeEnum, StatusEnum
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.policies.utils import grants as policy_repo

SEED_MARKER = "seed_pms_test_users"

# DEV ONLY. Same password for all five test accounts.
PMS_TEST_PASSWORD = "Pms@12345"

# Existing org admin whose organisation hosts the test users (seed_employees convention).
ORG_ADMIN_EMAIL = os.getenv("PMS_TEST_ORG_ADMIN_EMAIL", "akhil.nandanavanam+tblk@sagarsoft.in")

P = PermissionCodeEnum

# Role name -> (email, first name, last name, permissions). Each user gets exactly one PMS role.
PMS_TEST_ACCOUNTS: list[dict] = [
    {
        "role": "Corporate HR",
        "email": "pms.corporate.hr@sagarsoft.com",
        "first_name": "PMS Corporate",
        "last_name": "HR",
        "permissions": [
            P.PMS_MANAGE_CYCLES,
            P.PMS_MANAGE_GOAL_TEMPLATES,
            P.PMS_MANAGE_MASTERS,
            P.PMS_MANAGE_RATING_SCALE,
            P.PMS_VIEW_APPRAISAL_HISTORY,
        ],
    },
    {
        "role": "Manager",
        "email": "pms.manager@sagarsoft.com",
        "first_name": "PMS",
        "last_name": "Manager",
        "permissions": [
            P.PMS_MANAGE_TEAM_GOALS,
            P.PMS_VIEW_TEAM_PROGRESS,
            P.PMS_MANAGE_MID_YEAR_REVIEW,
            P.PMS_MANAGE_TEAM_APPRAISAL,
        ],
    },
    {
        "role": "Employee",
        "email": "pms.employee@sagarsoft.com",
        "first_name": "PMS",
        "last_name": "Employee",
        "permissions": [
            P.PMS_MANAGE_OWN_GOALS,
            P.PMS_UPDATE_OWN_PROGRESS,
            P.PMS_MANAGE_SELF_APPRAISAL,
            P.PMS_VIEW_OWN_FINAL_RATING,
        ],
    },
    {
        "role": "HOD",
        "email": "pms.hod@sagarsoft.com",
        "first_name": "PMS",
        "last_name": "HOD",
        "permissions": [
            P.PMS_MANAGE_HOD_GOAL_SETTINGS,
            P.PMS_REVIEW_EMPLOYEE_SCORECARD,
            P.PMS_VIEW_TARGET_REVISIONS,
            P.PMS_APPROVE_TARGET_REVISIONS,
            P.PMS_REVIEW_ASSESSMENT,
            P.PMS_MANAGE_HOD_RATING,
            P.PMS_REVIEW_APPRAISAL,
        ],
    },
    {
        "role": "HR Governance",
        "email": "pms.hr.governance@sagarsoft.com",
        "first_name": "PMS HR",
        "last_name": "Governance",
        "permissions": [
            P.PMS_MANAGE_RATING_NORMALIZATION,
            P.PMS_VIEW_PLANTWISE_APPRAISAL_HISTORY,
        ],
    },
]


def _print(msg: str = "") -> None:
    print(msg)


async def _find_org_id() -> PydanticObjectId:
    org_admin = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL.lower())
    if not org_admin or not org_admin.organisation_id:
        raise SystemExit(
            f"ERROR: org admin {ORG_ADMIN_EMAIL} not found or has no organisation. "
            "Set PMS_TEST_ORG_ADMIN_EMAIL to an org admin's email."
        )
    return org_admin.organisation_id


async def _ensure_role(name: str, org_id: PydanticObjectId, now: datetime) -> dict:
    """Return the PMS role policy for this org, creating it on first run."""
    existing = await policy_repo.get_policy_by_name(name, organisation_id=str(org_id))
    if existing:
        if existing.get("created_by") != SEED_MARKER:
            raise SystemExit(
                f"ERROR: a role named '{name}' already exists in this organisation and was not "
                "created by this seed. Refusing to replace its grants. Rename or remove it first."
            )
        _print(f"  role exists:  {name} ({existing['id']})")
        return existing

    created = await policy_repo.create_policy({
        "name": name,
        "is_role": True,
        "is_active": True,
        "organisation_id": org_id,
        "seed_module_codes": [],
        "created_by": SEED_MARKER,
        "created_on": now,
        "modified_by": SEED_MARKER,
        "modified_on": now,
    })
    _print(f"  role created: {name} ({created['id']})")
    return created


async def _sync_grants(policy_id: str, permissions: list[PermissionCodeEnum]) -> None:
    desired = {
        (ModuleEnum.PERFORMANCE_MANAGEMENT.value, AclRoleEnum.ADMIN.value, perm.value)
        for perm in permissions
    }
    inserts, removes = await policy_repo.replace_policy_grants(policy_id, desired, current_user_id=SEED_MARKER)
    _print(f"    grants: {len(desired)} wanted, +{inserts} added, -{removes} removed")


async def _ensure_user(account: dict, role_id: PydanticObjectId, pms_role_ids: set[PydanticObjectId],
                       org_id: PydanticObjectId, now: datetime) -> None:
    email = account["email"].lower()
    user = await UserDocument.find_one(UserDocument.email == email)

    if user is None:
        await UserDocument(
            email=email,
            password_hash=get_password_hash(PMS_TEST_PASSWORD),
            auth_method="seeded",
            first_name=account["first_name"],
            last_name=account["last_name"],
            status=StatusEnum.ACTIVE,
            activated_at=now,
            password_changed_at=now,
            is_super_admin=False,
            is_org_admin=False,
            organisation_id=org_id,
            policy_ids=[role_id],
            created_by=SEED_MARKER,
            created_on=now,
            modified_by=SEED_MARKER,
            modified_on=now,
        ).insert()
        _print(f"  user created: {email} -> {account['role']}")
        return

    # Existing test user: keep password and profile, swap only the PMS role.
    kept = [pid for pid in user.policy_ids if pid not in pms_role_ids]
    new_ids = kept + [role_id]
    if sorted(map(str, new_ids)) != sorted(map(str, user.policy_ids)):
        await user.set({"policy_ids": new_ids, "modified_by": SEED_MARKER, "modified_on": now})
        _print(f"  user updated: {email} -> {account['role']}")
    else:
        _print(f"  user exists:  {email} -> {account['role']}")


async def seed() -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[UserDocument, PolicyDocument, ModuleAclPermissionDocument],
    )

    now = datetime.now(timezone.utc)
    try:
        org_id = await _find_org_id()
        _print(f"Organisation: {org_id}\n")

        _print("--- Roles and grants ------------------------------------------------")
        role_ids: dict[str, PydanticObjectId] = {}
        for account in PMS_TEST_ACCOUNTS:
            role = await _ensure_role(account["role"], org_id, now)
            role_ids[account["role"]] = PydanticObjectId(role["id"])
            await _sync_grants(role["id"], account["permissions"])

        pms_role_ids = set(role_ids.values())

        _print("\n--- Test users ------------------------------------------------------")
        for account in PMS_TEST_ACCOUNTS:
            await _ensure_user(account, role_ids[account["role"]], pms_role_ids, org_id, now)

        _print("\n=====================================================================")
        _print("  PMS test users ready. DEV ONLY — password for all accounts: " + PMS_TEST_PASSWORD)
        _print("=====================================================================")
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(seed())
