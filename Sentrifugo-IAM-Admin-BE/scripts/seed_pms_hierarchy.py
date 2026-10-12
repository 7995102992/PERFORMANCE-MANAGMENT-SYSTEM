"""Build the PMS Corporate HR -> {Manager, HOD} -> Employees test hierarchy. DEV ONLY.

Does NOT touch the 5 base PMS role accounts (Corporate HR, Manager, Employee,
HOD, HR Governance) created by seed_pms_test_users.py -- run that script first
if those don't exist yet; this one errors out rather than recreating them.

Also independent of seed_pms_team.py's mock "Suresh Babu N." team (which sits
under pms.manager too, under different designations) -- both can coexist.

What it does (idempotent -- safe to re-run):
  * Finds the org through an existing org admin (same convention as the other
    PMS seed scripts; override with PMS_TEST_ORG_ADMIN_EMAIL).
  * Reuses the existing "Employee" PMS role (created by seed_pms_test_users.py)
    for every newly created employee01-05 user.
  * Creates pms.employee01..05@sagarsoft.com if missing (never recreates an
    existing user or changes its password).
  * Gives every one of corporate-hr / manager / hod / employee / employee01-05
    an EmployeeDocument if it doesn't have one yet, or repairs its l1_manager_id
    if it's wrong -- this is the only place the manager relationship actually
    lives (UserDocument has no manager field).
  * Verifies the result by calling the *same* src.internal.service.direct_reports
    function the IAM RPC queue serves to PMS, direct reports only.

Target hierarchy:
    PMS Corporate HR
      |-- PMS Manager
      |     |-- PMS Employee, PMS Employee 01, PMS Employee 02, PMS Employee 03
      |-- PMS HOD
            |-- PMS Employee 04, PMS Employee 05

Usage (from the IAM repo root, venv active, Mongo reachable):
    python -m scripts.seed_pms_hierarchy
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
from src.internal import service
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

SEED = "seed_pms_hierarchy"
NOW = datetime.now(timezone.utc)
AUDIT = {"created_by": SEED, "created_on": NOW, "modified_by": SEED, "modified_on": NOW}

# DEV ONLY: same password convention as the other PMS seed scripts.
PASSWORD = "Pms@12345"
ORG_ADMIN_EMAIL = os.getenv("PMS_TEST_ORG_ADMIN_EMAIL", "akhil.nandanavanam+tblk@sagarsoft.in")
DEPARTMENT_NAME = "Manufacturing"

CORP_HR_EMAIL = "pms.corporate.hr@sagarsoft.com"
MANAGER_EMAIL = "pms.manager@sagarsoft.com"
HOD_EMAIL = "pms.hod@sagarsoft.com"
EMPLOYEE_EMAIL = "pms.employee@sagarsoft.com"
EMPLOYEE_ROLE_NAME = "Employee"  # the PMS role seed_pms_test_users.py created

CORP_HR_DESIGNATION = "Corporate HR Head"
MANAGER_DESIGNATION = "Plant Superviser"  # same name seed_pms_team.py uses -- reused, not duplicated
HOD_DESIGNATION = "Department Head"
EMPLOYEE_DESIGNATION = "PMS Test Employee"

# (email, first name, last name). All five get the existing "Employee" role and land
# under either pms.manager or pms.hod, per the split below.
UNDER_MANAGER = [
    ("pms.employee01@sagarsoft.com", "PMS", "Employee 01"),
    ("pms.employee02@sagarsoft.com", "PMS", "Employee 02"),
    ("pms.employee03@sagarsoft.com", "PMS", "Employee 03"),
]
UNDER_HOD = [
    ("pms.employee04@sagarsoft.com", "PMS", "Employee 04"),
    ("pms.employee05@sagarsoft.com", "PMS", "Employee 05"),
]


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
            _print(f"  user updated:  {email} -> added Employee role")
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
    _print(f"  employee created:  {user.email} ({emp.emp_code})")
    return emp


async def _verify(label: str, manager_user_id: PydanticObjectId, org_id: PydanticObjectId) -> list[dict]:
    reports = await service.direct_reports(str(manager_user_id), str(org_id))
    _print(f"\n{label}: {len(reports)} direct report(s)")
    for r in reports:
        name = f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip()
        _print(f"    - {name} ({r.get('work_email')}) [{r.get('emp_code')}]")
    return reports


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

        # The 5 base PMS accounts must already exist -- this script never creates them.
        corp_hr = await UserDocument.find_one(UserDocument.email == CORP_HR_EMAIL)
        manager = await UserDocument.find_one(UserDocument.email == MANAGER_EMAIL)
        hod = await UserDocument.find_one(UserDocument.email == HOD_EMAIL)
        employee = await UserDocument.find_one(UserDocument.email == EMPLOYEE_EMAIL)
        missing = [e for e, u in [(CORP_HR_EMAIL, corp_hr), (MANAGER_EMAIL, manager), (HOD_EMAIL, hod), (EMPLOYEE_EMAIL, employee)] if not u]
        if missing:
            raise SystemExit(f"ERROR: missing base PMS user(s) {missing}. Run `python -m scripts.seed_pms_test_users` first.")

        employee_role = await policy_repo.get_policy_by_name(EMPLOYEE_ROLE_NAME, organisation_id=str(org_id))
        if not employee_role:
            raise SystemExit(f"ERROR: PMS role '{EMPLOYEE_ROLE_NAME}' not found. Run `python -m scripts.seed_pms_test_users` first.")
        employee_role_id = PydanticObjectId(employee_role["id"])

        _print("\n--- Designations ----------------------------------------------------")
        corp_hr_des = await _ensure_designation(org_id, CORP_HR_DESIGNATION)
        manager_des = await _ensure_designation(org_id, MANAGER_DESIGNATION)
        hod_des = await _ensure_designation(org_id, HOD_DESIGNATION)
        employee_des = await _ensure_designation(org_id, EMPLOYEE_DESIGNATION)

        def emp_kwargs(user, designation, l1):
            return dict(
                org_id=org_id, bu=bu, dept=dept, user=user, designation_id=designation,
                l1_manager_user_id=l1, et_fulltime=et_fulltime, es_active=es_active, ps_allocated=ps_allocated,
            )

        _print("\n--- Corporate HR (top of the hierarchy, no manager) ------------------")
        await _ensure_employee(**emp_kwargs(corp_hr, corp_hr_des, None))

        _print("\n--- Manager and HOD (report to Corporate HR) -------------------------")
        await _ensure_employee(**emp_kwargs(manager, manager_des, corp_hr.id))
        await _ensure_employee(**emp_kwargs(hod, hod_des, corp_hr.id))

        _print("\n--- PMS Employee (existing account, reports to Manager) ---------------")
        await _ensure_employee(**emp_kwargs(employee, employee_des, manager.id))

        _print("\n--- New employees under Manager ---------------------------------------")
        for email, first, last in UNDER_MANAGER:
            u = await _ensure_user(email, first, last, org_id, employee_role_id)
            await _ensure_employee(**emp_kwargs(u, employee_des, manager.id))

        _print("\n--- New employees under HOD ---------------------------------------")
        for email, first, last in UNDER_HOD:
            u = await _ensure_user(email, first, last, org_id, employee_role_id)
            await _ensure_employee(**emp_kwargs(u, employee_des, hod.id))

        _print("\n=====================================================================")
        _print("  Verifying via src.internal.service.direct_reports (same function the")
        _print("  IAM RPC queue serves to PMS) -- direct reports only, not recursive.")
        _print("=====================================================================")
        await _verify("Corporate HR", corp_hr.id, org_id)
        await _verify("Manager", manager.id, org_id)
        await _verify("HOD", hod.id, org_id)

        _print("\nDone. DEV ONLY -- password for newly created employee01-05 accounts: " + PASSWORD)
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(seed())
