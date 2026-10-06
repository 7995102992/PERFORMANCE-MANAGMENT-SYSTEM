"""Seed the PMS manager's team (screens 3.1 - 3.5) into IAM. DEVELOPMENT ONLY.

Creates, for the org found through an org admin:
  * the two designations the mockups use, under the existing Manufacturing
    department, if they are missing;
  * an employee record for the PMS manager test user (pms.manager@sagarsoft.com);
  * five team members whose L1 manager is that user.

Idempotent: existing users, employees and designations are reused, and a team
member whose L1 manager differs is repaired to the PMS manager. Passwords of
existing users are never changed.

Usage (from the IAM repo root, venv active, Mongo reachable):
    PMS_TEST_ORG_ADMIN_EMAIL=harsha.tatapudi@sagarsoft.in python -m scripts.seed_pms_team
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

SEED = "seed_pms_team"
NOW = datetime.now(timezone.utc)
AUDIT = {"created_by": SEED, "created_on": NOW, "modified_by": SEED, "modified_on": NOW}

# DEV ONLY: same password as the PMS test accounts.
PASSWORD = "Pms@12345"
ORG_ADMIN_EMAIL = os.getenv("PMS_TEST_ORG_ADMIN_EMAIL", "akhil.nandanavanam+tblk@sagarsoft.in")
MANAGER_EMAIL = "pms.manager@sagarsoft.com"
DEPARTMENT_NAME = "Manufacturing"

KILN = "Engineer – Kiln Ops"
RAW_MILL = "Sr. Engineer – Raw Mill"
MANAGER_DESIGNATION = "Plant Superviser"

# (email, first name, last name, designation). Names follow the mockup's "Suresh Babu N." form.
TEAM = [
    ("suresh.babu@sagarsoft.com", "Suresh Babu", "N.", KILN),
    ("prakash.rao@sagarsoft.com", "Prakash Rao", "M.", KILN),
    ("divya.sree@sagarsoft.com", "Divya Sree", "P.", KILN),
    ("naveen.kumar@sagarsoft.com", "Naveen Kumar", "G.", RAW_MILL),
    ("srinivas.y@sagarsoft.com", "Srinivas", "Y.", RAW_MILL),
]

EMP_TYPE_LETTERS = {"full-time": "F"}


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
        print(f"  designation exists: {name}")
        return existing.id
    doc = DesignationDocument(organisation_id=org_id, designation_name=name, is_active=True, **AUDIT)
    await doc.insert()
    print(f"  designation created: {name}")
    return doc.id


async def _next_emp_code(bu: BusinessUnitDocument) -> str:
    letter = EMP_TYPE_LETTERS["full-time"]
    bu.emp_code_last_numbers[letter] = bu.emp_code_last_numbers.get(letter, 0) + 1
    start_from = bu.emp_code_start_from.get(letter, 0)
    next_num = start_from + bu.emp_code_last_numbers[letter]
    await bu.save()
    prefix = bu.emp_code_prefix or "EMP"
    return f"{prefix}-{next_num}"


async def _ensure_employee(
    *,
    org_id: PydanticObjectId,
    bu: BusinessUnitDocument,
    dept: DepartmentDocument,
    user: UserDocument,
    designation_id: PydanticObjectId,
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
        if l1_manager_user_id and emp.l1_manager_id != l1_manager_user_id:
            await emp.set({"l1_manager_id": l1_manager_user_id, "modified_by": SEED, "modified_on": NOW})
            print(f"  employee repaired: {user.email} -> L1 manager set")
        else:
            print(f"  employee exists:   {user.email}")
        return emp

    emp = EmployeeDocument(
        organisation_id=org_id,
        user_id=user.id,
        emp_code=await _next_emp_code(bu),
        business_unit_id=bu.id,
        department_id=dept.id,
        designation_id=designation_id,
        employment_type=et_fulltime,
        employment_status=es_active,
        project_status=ps_allocated,
        date_of_joining=date(2025, 1, 1),
        l1_manager_id=l1_manager_user_id,
        **AUDIT,
    )
    await emp.insert()
    print(f"  employee created:  {user.email} ({emp.emp_code})")
    return emp


async def _ensure_user(email: str, first: str, last: str, org_id: PydanticObjectId) -> UserDocument:
    user = await UserDocument.find_one(UserDocument.email == email.lower())
    if user:
        print(f"  user exists:       {email}")
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
        **AUDIT,
    )
    await user.insert()
    print(f"  user created:      {email}")
    return user


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
        ],
    )
    try:
        admin = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL.lower())
        if not admin or not admin.organisation_id:
            raise SystemExit(f"ERROR: org admin {ORG_ADMIN_EMAIL} not found or has no organisation.")
        org_id = admin.organisation_id
        print(f"Organisation: {org_id}")

        bu = await BusinessUnitDocument.find_one(
            BusinessUnitDocument.organisation_id == org_id,
            BusinessUnitDocument.is_active == True,  # noqa: E712
        )
        if not bu:
            raise SystemExit("ERROR: no active business unit in this organisation.")
        dept = await DepartmentDocument.find_one(
            DepartmentDocument.organisation_id == org_id,
            DepartmentDocument.department_name == DEPARTMENT_NAME,
            DepartmentDocument.is_active == True,  # noqa: E712
        )
        if not dept:
            raise SystemExit(f"ERROR: department '{DEPARTMENT_NAME}' not found in this organisation.")

        et_fulltime = await _md("EMPLOYMENT_TYPES", "full-time")
        es_active = await _md("EMPLOYMENT_STATUSES", "permanent")
        ps_allocated = await _md("PROJECT_STATUSES", "allocated-to-project")

        print("\n--- Designations ----------------------------------------------------")
        kiln_id = await _ensure_designation(org_id, KILN)
        raw_id = await _ensure_designation(org_id, RAW_MILL)
        manager_des_id = await _ensure_designation(org_id, MANAGER_DESIGNATION)

        print("\n--- Manager ---------------------------------------------------------")
        manager = await UserDocument.find_one(UserDocument.email == MANAGER_EMAIL)
        if not manager:
            raise SystemExit(f"ERROR: {MANAGER_EMAIL} not found. Run seed_pms_test_users first.")
        await _ensure_employee(
            org_id=org_id, bu=bu, dept=dept, user=manager, designation_id=manager_des_id,
            l1_manager_user_id=None, et_fulltime=et_fulltime, es_active=es_active, ps_allocated=ps_allocated,
        )

        print("\n--- Team ------------------------------------------------------------")
        for email, first, last, designation in TEAM:
            user = await _ensure_user(email, first, last, org_id)
            await _ensure_employee(
                org_id=org_id, bu=bu, dept=dept, user=user,
                designation_id=kiln_id if designation == KILN else raw_id,
                l1_manager_user_id=manager.id,
                et_fulltime=et_fulltime, es_active=es_active, ps_allocated=ps_allocated,
            )

        print("\nPMS team ready. DEV ONLY - password for team accounts: " + PASSWORD)
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(seed())
