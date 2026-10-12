"""Build the two PMS reporting chains from PERMISSION_SEEDING.md section 4,
with one test user per level, under the 7 roles seed_pms_roles.py created.
DEVELOPMENT ONLY.

Target hierarchy (GP is the shared root of both chains):

    GP
    |-- Corporate HR            (Corporate Office chain)
    |     |-- Functional Head         [role: HOD / Functional Head]
    |           |-- Reporting Manager [role: Section Head / Reporting Manager]
    |                 |-- Employee (corporate)
    |-- Plant Head               (Plant chain)
          |-- Plant HR
                |-- HOD                [role: HOD / Functional Head]
                      |-- Section Head [role: Section Head / Reporting Manager]
                            |-- Employee (plant)

What it does (idempotent -- safe to re-run):
  * Finds the org through an existing org admin (PMS_ROLES_ORG_ADMIN_EMAIL,
    same convention/default as seed_pms_roles.py).
  * Requires all 7 PMS role policies to already exist (created by
    `python -m scripts.seed_pms_roles`) -- never creates or edits a role or
    its grants. "Corporate HR" and "Employee" are the pre-existing org roles
    (left as-is by seed_pms_roles.py); this script assigns users to them
    unchanged.
  * Creates each of the 10 users above if missing (never recreates an
    existing user or changes its password), each holding exactly one PMS
    role.
  * Gives each user an EmployeeDocument with the designation/department
    below and the correct L1 manager, or repairs the L1 manager if wrong.

Does not touch any permission, module, or role grant.

Usage (from the IAM repo root, venv active, Mongo reachable):
    PMS_ROLES_ORG_ADMIN_EMAIL=orgadmin@sagarcements.in python -m scripts.seed_pms_role_hierarchy
"""

import asyncio
import os
from datetime import date, datetime, timezone
from typing import Optional

from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.auth.utils.tools import get_password_hash
from src.config import settings
from src.master_data.models import MasterDataDocument
from src.models import StatusEnum
from src.modules.organisation.models import (
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    EmployeeDocument,
    OrganisationDocument,
)
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.policies.utils import grants as policy_repo

SEED = "seed_pms_role_hierarchy"
NOW = datetime.now(timezone.utc)
AUDIT = {"created_by": SEED, "created_on": NOW, "modified_by": SEED, "modified_on": NOW}

# DEV ONLY.
PASSWORD = "Pms@12345"
ORG_ADMIN_EMAIL = os.getenv("PMS_ROLES_ORG_ADMIN_EMAIL", "orgadmin@sagarcements.in")

# id, email, first, last, role name, designation, department, parent id (None = root)
Account = tuple[str, str, str, str, str, str, str, Optional[str]]

ACCOUNTS: list[Account] = [
    ("gp", "pms.gp@sagarsoft.com", "PMS", "Group President",
     "GP", "Group President", "Unit Head", None),

    # Corporate Office chain
    ("corp_hr", "pms.corporate.hr@sagarsoft.com", "PMS Corporate", "HR",
     "Corporate HR", "Corporate HR Head", "Human Resource & Administration", "gp"),
    ("functional_head", "pms.functional.head@sagarsoft.com", "PMS", "Functional Head",
     "HOD / Functional Head", "Functional Head", "Finance & Accounts", "corp_hr"),
    ("reporting_manager", "pms.reporting.manager@sagarsoft.com", "PMS", "Reporting Manager",
     "Section Head / Reporting Manager", "Reporting Manager", "Finance & Accounts", "functional_head"),
    ("employee_corp", "pms.employee.corp@sagarsoft.com", "PMS", "Employee (Corporate)",
     "Employee", "Employee - Corporate", "Finance & Accounts", "reporting_manager"),

    # Plant chain
    ("plant_head", "pms.plant.head@sagarsoft.com", "PMS", "Plant Head",
     "Plant Head", "Plant Head", "Unit Head", "gp"),
    ("plant_hr", "pms.plant.hr@sagarsoft.com", "PMS", "Plant HR",
     "Plant HR", "Plant HR Head", "Human Resource & Administration", "plant_head"),
    ("hod", "pms.hod@sagarsoft.com", "PMS", "HOD",
     "HOD / Functional Head", "HOD", "Mechanical", "plant_hr"),
    ("section_head", "pms.section.head@sagarsoft.com", "PMS", "Section Head",
     "Section Head / Reporting Manager", "Section Head (GM/AGM)", "Mechanical", "hod"),
    ("employee_plant", "pms.employee.plant@sagarsoft.com", "PMS", "Employee (Plant)",
     "Employee", "Employee - Plant", "Mechanical", "section_head"),
]

REQUIRED_ROLES = sorted({a[4] for a in ACCOUNTS})


def _print(msg: str = "") -> None:
    print(msg)


async def _md(category: str, key: str) -> PydanticObjectId:
    doc = await MasterDataDocument.find_one(
        MasterDataDocument.category == category,
        MasterDataDocument.key == key,
        MasterDataDocument.is_active == True,  # noqa: E712
    )
    if not doc:
        raise SystemExit(f"ERROR: master data not found: {category}/{key}")
    return doc.id


async def _ensure_designation(org_id: PydanticObjectId, name: str) -> PydanticObjectId:
    existing = await DesignationDocument.find_one(
        DesignationDocument.organisation_id == org_id,
        DesignationDocument.designation_name == name,
        DesignationDocument.deleted_on == None,  # noqa: E711
    )
    if existing:
        _print(f"  designation exists: {name}")
        return existing.id
    doc = DesignationDocument(organisation_id=org_id, designation_name=name, is_active=True, **AUDIT)
    await doc.insert()
    _print(f"  designation created: {name}")
    return doc.id


async def _next_emp_code(bu: BusinessUnitDocument) -> str:
    letter = "F"  # full-time
    bu.emp_code_last_numbers[letter] = bu.emp_code_last_numbers.get(letter, 0) + 1
    start_from = bu.emp_code_start_from.get(letter, 0)
    next_num = start_from + bu.emp_code_last_numbers[letter]
    await bu.save()
    prefix = bu.emp_code_prefix or "EMP"
    return f"{prefix}-{next_num}"


async def _ensure_user(email: str, first: str, last: str, org_id: PydanticObjectId, role_id: PydanticObjectId) -> UserDocument:
    user = await UserDocument.find_one(UserDocument.email == email.lower())
    if user:
        if role_id not in user.policy_ids:
            await user.set({"policy_ids": user.policy_ids + [role_id], "modified_by": SEED, "modified_on": NOW})
            _print(f"  user updated:  {email} -> added role")
        else:
            _print(f"  user exists:   {email}")
        return user
    user = UserDocument(
        email=email.lower(),
        password_hash=get_password_hash(PASSWORD),
        auth_method="seeded",
        first_name=first,
        last_name=last,
        organisation_id=org_id,
        status=StatusEnum.ACTIVE,
        activated_at=NOW,
        password_changed_at=NOW,
        is_super_admin=False,
        is_org_admin=False,
        policy_ids=[role_id],
        **AUDIT,
    )
    await user.insert()
    _print(f"  user created:  {email}")
    return user


async def _ensure_employee(
    *,
    org_id: PydanticObjectId,
    bu: BusinessUnitDocument,
    designation_id: PydanticObjectId,
    department_id: PydanticObjectId,
    user: UserDocument,
    l1_manager_user_id: Optional[PydanticObjectId],
    et_fulltime: PydanticObjectId,
    es_active: PydanticObjectId,
    ps_allocated: PydanticObjectId,
) -> EmployeeDocument:
    emp = await EmployeeDocument.find_one(
        EmployeeDocument.organisation_id == org_id,
        EmployeeDocument.user_id == user.id,
        EmployeeDocument.deleted_on == None,  # noqa: E711
    )
    if emp:
        if emp.l1_manager_id != l1_manager_user_id:
            await emp.set({"l1_manager_id": l1_manager_user_id, "modified_by": SEED, "modified_on": NOW})
            _print(f"  employee repaired: {user.email} -> L1 manager set")
        else:
            _print(f"  employee exists:   {user.email}")
        return emp

    emp = EmployeeDocument(
        organisation_id=org_id,
        user_id=user.id,
        emp_code=await _next_emp_code(bu),
        business_unit_id=bu.id,
        department_id=department_id,
        designation_id=designation_id,
        employment_type=et_fulltime,
        employment_status=es_active,
        project_status=ps_allocated,
        date_of_joining=date(2025, 1, 1),
        l1_manager_id=l1_manager_user_id,
        **AUDIT,
    )
    await emp.insert()
    _print(f"  employee created:  {user.email} ({emp.emp_code})")
    return emp


async def seed() -> None:
    if not settings.MONGODB_URL:
        raise SystemExit("ERROR: MONGODB_URL is not configured. Check your .env file.")

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[
            UserDocument,
            OrganisationDocument,
            BusinessUnitDocument,
            DepartmentDocument,
            DesignationDocument,
            EmployeeDocument,
            MasterDataDocument,
            PolicyDocument,
            ModuleAclPermissionDocument,
        ],
    )
    try:
        admin = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL.lower())
        if not admin or not admin.organisation_id:
            raise SystemExit(f"ERROR: org admin {ORG_ADMIN_EMAIL} not found or has no organisation.")
        org_id = admin.organisation_id
        _print(f"Organisation: {org_id}")

        bu = await BusinessUnitDocument.find_one(
            BusinessUnitDocument.organisation_id == org_id,
            BusinessUnitDocument.is_active == True,  # noqa: E712
        )
        if not bu:
            raise SystemExit("ERROR: no active business unit in this organisation.")

        et_fulltime = await _md("EMPLOYMENT_TYPES", "full-time")
        es_active = await _md("EMPLOYMENT_STATUSES", "permanent")
        ps_allocated = await _md("PROJECT_STATUSES", "allocated-to-project")

        _print("\n--- Roles (must already exist, never created/modified here) ----------")
        role_ids: dict[str, PydanticObjectId] = {}
        for role_name in REQUIRED_ROLES:
            role = await policy_repo.get_policy_by_name(role_name, organisation_id=str(org_id))
            if not role:
                raise SystemExit(
                    f"ERROR: role '{role_name}' not found in this org. "
                    "Run `python -m scripts.seed_pms_roles` first."
                )
            role_ids[role_name] = PydanticObjectId(role["id"])
            _print(f"  role found: '{role_name}' ({role['id']})")

        _print("\n--- Departments and designations --------------------------------------")
        dept_cache: dict[str, PydanticObjectId] = {}
        des_cache: dict[str, PydanticObjectId] = {}
        for _id, email, first, last, role_name, designation, department, parent in ACCOUNTS:
            if department not in dept_cache:
                dept = await DepartmentDocument.find_one(
                    DepartmentDocument.organisation_id == org_id,
                    DepartmentDocument.department_name == department,
                    DepartmentDocument.is_active == True,  # noqa: E712
                )
                if not dept:
                    raise SystemExit(f"ERROR: department '{department}' not found in this organisation.")
                dept_cache[department] = dept.id
            if designation not in des_cache:
                des_cache[designation] = await _ensure_designation(org_id, designation)

        _print("\n--- Users ---------------------------------------------------------------")
        user_cache: dict[str, UserDocument] = {}
        for _id, email, first, last, role_name, designation, department, parent in ACCOUNTS:
            user_cache[_id] = await _ensure_user(email, first, last, org_id, role_ids[role_name])

        _print("\n--- Employees + reporting hierarchy --------------------------------------")
        for _id, email, first, last, role_name, designation, department, parent in ACCOUNTS:
            l1 = user_cache[parent].id if parent else None
            await _ensure_employee(
                org_id=org_id,
                bu=bu,
                designation_id=des_cache[designation],
                department_id=dept_cache[department],
                user=user_cache[_id],
                l1_manager_user_id=l1,
                et_fulltime=et_fulltime,
                es_active=es_active,
                ps_allocated=ps_allocated,
            )

        _print("\n===========================================================================")
        _print("  PMS role hierarchy ready. DEV ONLY -- password for every account: " + PASSWORD)
        _print("===========================================================================")
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(seed())
