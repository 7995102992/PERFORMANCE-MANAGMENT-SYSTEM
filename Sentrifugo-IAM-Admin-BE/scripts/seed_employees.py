"""Seed employees with department + manager mapping for the existing org.

Finds the org via the org admin email, looks up existing departments,
creates users + employee records with L1/L2 manager hierarchy.

All users: status=ACTIVE, password=test@123, password_changed_at=now

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.seed_employees
"""

import asyncio
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
from src.policies.models import PolicyDocument

NOW = datetime.now(timezone.utc)
PASSWORD = "test@123"
AUDIT = {
    "created_by": "seed_employees",
    "created_on": NOW,
    "modified_by": "seed_employees",
    "modified_on": NOW,
}

ORG_ADMIN_EMAIL = "akhil.nandanavanam+tblk@sagarsoft.in"


async def _md(category: str, key: str) -> PydanticObjectId:
    doc = await MasterDataDocument.find_one(
        MasterDataDocument.category == category,
        MasterDataDocument.key == key,
        MasterDataDocument.is_active == True,  # noqa: E712
    )
    if not doc:
        raise RuntimeError(f"Master data not found: {category}/{key}")
    return doc.id


async def seed():
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    from src.modules.custom_fields.models import (
        CustomFieldDefinitionDocument,
        CustomFieldOptionDocument,
        CustomFieldValueDocument,
    )

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
            CustomFieldDefinitionDocument,
            CustomFieldOptionDocument,
            CustomFieldValueDocument,
        ],
    )

    # ── Find org via org admin ──────────────────────────────────────────
    org_admin = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL)
    if not org_admin:
        print(f"ERROR: Org admin user not found: {ORG_ADMIN_EMAIL}")
        client.close()
        return

    org_id = org_admin.organisation_id
    if not org_id:
        print("ERROR: Org admin has no organisation_id")
        client.close()
        return

    org = await OrganisationDocument.get(org_id)
    print(f"Found org: {org.legal_name} (id={org_id})")

    # ── Find departments ────────────────────────────────────────────────
    all_depts = await DepartmentDocument.find(
        DepartmentDocument.organisation_id == org_id,
        DepartmentDocument.is_active == True,  # noqa: E712
    ).to_list()

    dept_map = {d.department_name: d for d in all_depts}
    print(f"Found {len(all_depts)} departments: {list(dept_map.keys())}")

    # Match user-provided department names to actual department names
    def find_dept(search: str) -> Optional[DepartmentDocument]:
        search_lower = search.lower()
        for name, dept in dept_map.items():
            if search_lower in name.lower() or name.lower() in search_lower:
                return dept
        return None

    dept_it = find_dept("IT Support")
    dept_eng = find_dept("Engineering")
    dept_fin = find_dept("Finance")
    dept_hr = find_dept("HR") or find_dept("Human Resources")

    missing = []
    if not dept_it:
        missing.append("IT Support")
    if not dept_eng:
        missing.append("Engineering")
    if not dept_fin:
        missing.append("Finance")
    if not dept_hr:
        missing.append("HR")

    if missing:
        print(f"ERROR: Could not find departments: {missing}")
        print(f"  Available: {list(dept_map.keys())}")
        client.close()
        return

    print(f"  IT Support  → {dept_it.department_name} ({dept_it.id})")
    print(f"  Engineering → {dept_eng.department_name} ({dept_eng.id})")
    print(f"  Finance     → {dept_fin.department_name} ({dept_fin.id})")
    print(f"  HR          → {dept_hr.department_name} ({dept_hr.id})")

    # ── Find a business unit ────────────────────────────────────────────
    bu = await BusinessUnitDocument.find_one(
        BusinessUnitDocument.organisation_id == org_id,
        BusinessUnitDocument.is_active == True,  # noqa: E712
    )
    if not bu:
        print("ERROR: No active business unit found")
        client.close()
        return
    print(f"Using BU: {bu.business_unit_name} ({bu.id})")

    # ── Resolve master data ─────────────────────────────────────────────
    et_fulltime = await _md("EMPLOYMENT_TYPES", "full-time")
    es_active = await _md("EMPLOYMENT_STATUSES", "permanent")
    ps_allocated = await _md("PROJECT_STATUSES", "allocated-to-project")
    gender_male = await _md("GENDERS", "male")

    # ── Find a policy for employees ─────────────────────────────────────
    policy = await PolicyDocument.find_one(
        PolicyDocument.organisation_id == org_id,
        PolicyDocument.is_active == True,  # noqa: E712
    )
    policy_ids = [policy.id] if policy else []

    # ── Clean up previous seed run ──────────────────────────────────────
    all_emails = [
        "cxo@yopmail.com",
        "pavan@yopmail.com", "kiran@yopmail.com",
        "madav_l1@yopmail.com", "madav_l2@yopmail.com", "madav_head@yopmail.com",
        "aftab@yopmail.com", "sethu@yopmail.com", "akhil@yopmail.com",
        "karthikeya@yopmail.com", "prekshana@yopmail.com", "manas@yopmail.com",
        "pavan_l1@yopmail.com", "pavan_l2@yopmail.com", "pavan_head@yopmail.com",
        "ramu@yopmail.com", "venusree@yopmail.com",
        "murali_l1@yopmail.com", "murali_l2@yopmail.com", "murali_head@yopmail.com",
        "nisha_l1@yopmail.com", "nisha_l2@yopmail.com", "nisha_head@yopmail.com",
        "karthika@yopmail.com", "srinivas@yopmail.com",
    ]

    print("Cleaning up existing seed users...")
    for email in all_emails:
        existing_user = await UserDocument.find_one(UserDocument.email == email)
        if existing_user:
            await EmployeeDocument.find(EmployeeDocument.user_id == existing_user.id).delete()
            await existing_user.delete()
            print(f"  Removed: {email}")

    # ── Helper to create user + employee ────────────────────────────────
    pw_hash = get_password_hash(PASSWORD)

    EMP_TYPE_LETTERS = {"full-time": "F", "contract": "C", "internship": "I"}

    async def _next_emp_code(emp_type_key: str = "full-time") -> str:
        letter = EMP_TYPE_LETTERS.get(emp_type_key)
        if not letter:
            raise RuntimeError(f"Unsupported employment type '{emp_type_key}'. Allowed: full-time, contract, internship.")
        bu.emp_code_last_numbers[letter] = bu.emp_code_last_numbers.get(letter, 0) + 1
        start_from = bu.emp_code_start_from.get(letter, 0)
        next_num = start_from + bu.emp_code_last_numbers[letter]
        await bu.save()
        prefix = bu.emp_code_prefix or "EMP"
        return f"{prefix}-{next_num}" if letter == "F" else f"{prefix}-{letter}-{next_num}"

    async def create_emp(
        *,
        email: str,
        first_name: str,
        last_name: str,
        dept: DepartmentDocument,
        l1_user_id: Optional[PydanticObjectId] = None,
        l2_user_id: Optional[PydanticObjectId] = None,
    ) -> UserDocument:
        emp_code = await _next_emp_code()

        user = UserDocument(
            email=email,
            password_hash=pw_hash,
            auth_method="local",
            first_name=first_name,
            last_name=last_name,
            gender=gender_male,
            organisation_id=org_id,
            status=StatusEnum.ACTIVE,
            policy_ids=policy_ids,
            password_changed_at=NOW,
            **AUDIT,
        )
        await user.insert()

        emp = EmployeeDocument(
            organisation_id=org_id,
            user_id=user.id,
            emp_code=emp_code,
            business_unit_id=bu.id,
            department_id=dept.id,
            employment_type=et_fulltime,
            employment_status=es_active,
            project_status=ps_allocated,
            date_of_joining=date(2025, 1, 1),
            l1_manager_id=l1_user_id,
            l2_manager_id=l2_user_id,
            **AUDIT,
        )
        await emp.insert()

        role = ""
        if not l1_user_id and not l2_user_id:
            role = " [CXO]"
        print(f"  {emp_code} | {first_name} {last_name} <{email}> | {dept.department_name}{role}")
        return user

    # ── Create employees in hierarchy order ─────────────────────────────
    print("\nCreating employees...")

    # 1. CXO — top level, no managers
    u_cxo = await create_emp(
        email="cxo@yopmail.com", first_name="CXO", last_name="User",
        dept=dept_eng,
    )

    # ═══════════════════════════════════════════════════════════════════
    # IT Support
    # ═══════════════════════════════════════════════════════════════════
    print("\n  --- IT Support ---")

    u_it_head = await create_emp(
        email="madav_head@yopmail.com", first_name="Madhav", last_name="Head",
        dept=dept_it, l1_user_id=u_cxo.id,
    )
    u_it_l2 = await create_emp(
        email="madav_l2@yopmail.com", first_name="Madhav", last_name="L2",
        dept=dept_it, l1_user_id=u_it_head.id, l2_user_id=u_cxo.id,
    )
    u_it_l1 = await create_emp(
        email="madav_l1@yopmail.com", first_name="Madhav", last_name="L1",
        dept=dept_it, l1_user_id=u_it_l2.id, l2_user_id=u_it_head.id,
    )
    await create_emp(
        email="pavan@yopmail.com", first_name="Pavan", last_name="IT",
        dept=dept_it, l1_user_id=u_it_l1.id, l2_user_id=u_it_l2.id,
    )
    await create_emp(
        email="kiran@yopmail.com", first_name="Kiran", last_name="IT",
        dept=dept_it, l1_user_id=u_it_l1.id, l2_user_id=u_it_l2.id,
    )

    # ═══════════════════════════════════════════════════════════════════
    # Engineering
    # ═══════════════════════════════════════════════════════════════════
    print("\n  --- Engineering ---")

    u_eng_head = await create_emp(
        email="pavan_head@yopmail.com", first_name="Pavan", last_name="Head",
        dept=dept_eng, l1_user_id=u_cxo.id,
    )
    u_eng_l2 = await create_emp(
        email="pavan_l2@yopmail.com", first_name="Pavan", last_name="L2",
        dept=dept_eng, l1_user_id=u_eng_head.id, l2_user_id=u_cxo.id,
    )
    u_eng_l1 = await create_emp(
        email="pavan_l1@yopmail.com", first_name="Pavan", last_name="L1",
        dept=dept_eng, l1_user_id=u_eng_l2.id, l2_user_id=u_eng_head.id,
    )
    await create_emp(
        email="aftab@yopmail.com", first_name="Aftab", last_name="Engineer",
        dept=dept_eng, l1_user_id=u_eng_l1.id, l2_user_id=u_eng_l2.id,
    )
    await create_emp(
        email="sethu@yopmail.com", first_name="Sethu", last_name="Engineer",
        dept=dept_eng, l1_user_id=u_eng_l1.id, l2_user_id=u_eng_l2.id,
    )
    await create_emp(
        email="akhil@yopmail.com", first_name="Akhil", last_name="Engineer",
        dept=dept_eng, l1_user_id=u_eng_l1.id, l2_user_id=u_eng_l2.id,
    )
    await create_emp(
        email="karthikeya@yopmail.com", first_name="Karthikeya", last_name="Engineer",
        dept=dept_eng, l1_user_id=u_eng_l1.id, l2_user_id=u_eng_l2.id,
    )
    await create_emp(
        email="prekshana@yopmail.com", first_name="Prekshana", last_name="Engineer",
        dept=dept_eng, l1_user_id=u_eng_l1.id, l2_user_id=u_eng_l2.id,
    )
    await create_emp(
        email="manas@yopmail.com", first_name="Manas", last_name="Engineer",
        dept=dept_eng, l1_user_id=u_eng_l1.id, l2_user_id=u_eng_l2.id,
    )

    # ═══════════════════════════════════════════════════════════════════
    # Finance
    # ═══════════════════════════════════════════════════════════════════
    print("\n  --- Finance ---")

    u_fin_head = await create_emp(
        email="murali_head@yopmail.com", first_name="Murali", last_name="Head",
        dept=dept_fin, l1_user_id=u_cxo.id,
    )
    u_fin_l2 = await create_emp(
        email="murali_l2@yopmail.com", first_name="Murali", last_name="L2",
        dept=dept_fin, l1_user_id=u_fin_head.id, l2_user_id=u_cxo.id,
    )
    u_fin_l1 = await create_emp(
        email="murali_l1@yopmail.com", first_name="Murali", last_name="L1",
        dept=dept_fin, l1_user_id=u_fin_l2.id, l2_user_id=u_fin_head.id,
    )
    await create_emp(
        email="ramu@yopmail.com", first_name="Ramu", last_name="Finance",
        dept=dept_fin, l1_user_id=u_fin_l1.id, l2_user_id=u_fin_l2.id,
    )
    await create_emp(
        email="venusree@yopmail.com", first_name="Venusree", last_name="Finance",
        dept=dept_fin, l1_user_id=u_fin_l1.id, l2_user_id=u_fin_l2.id,
    )

    # ═══════════════════════════════════════════════════════════════════
    # HR Department
    # ═══════════════════════════════════════════════════════════════════
    print("\n  --- HR Department ---")

    u_hr_head = await create_emp(
        email="nisha_head@yopmail.com", first_name="Nisha", last_name="Head",
        dept=dept_hr, l1_user_id=u_cxo.id,
    )
    u_hr_l2 = await create_emp(
        email="nisha_l2@yopmail.com", first_name="Nisha", last_name="L2",
        dept=dept_hr, l1_user_id=u_hr_head.id, l2_user_id=u_cxo.id,
    )
    u_hr_l1 = await create_emp(
        email="nisha_l1@yopmail.com", first_name="Nisha", last_name="L1",
        dept=dept_hr, l1_user_id=u_hr_l2.id, l2_user_id=u_hr_head.id,
    )
    await create_emp(
        email="karthika@yopmail.com", first_name="Karthika", last_name="HR",
        dept=dept_hr, l1_user_id=u_hr_l1.id, l2_user_id=u_hr_l2.id,
    )
    await create_emp(
        email="srinivas@yopmail.com", first_name="Srinivas", last_name="HR",
        dept=dept_hr, l1_user_id=u_hr_l1.id, l2_user_id=u_hr_l2.id,
    )

    # ── Set department heads ────────────────────────────────────────────
    print("\nAssigning department heads...")
    dept_it.department_head = u_it_head.id
    await dept_it.save()
    dept_eng.department_head = u_eng_head.id
    await dept_eng.save()
    dept_fin.department_head = u_fin_head.id
    await dept_fin.save()
    dept_hr.department_head = u_hr_head.id
    await dept_hr.save()
    print("  Done")

    # ── Summary ─────────────────────────────────────────────────────────
    total = len(all_emails)
    print(f"\n{'=' * 60}")
    print(f"  SEED COMPLETE — {total} employees created")
    print(f"{'=' * 60}")
    print(f"  Org:      {org.legal_name}")
    print(f"  Password: {PASSWORD} (all users)")
    print(f"  Status:   ACTIVE (all users)")
    print(f"  password_changed_at: {NOW.isoformat()}")
    print()
    print("  Manager hierarchy per department:")
    print("    Dept Head → L1=CXO")
    print("    L2 Mgr    → L1=Head, L2=CXO")
    print("    L1 Mgr    → L1=L2,   L2=Head")
    print("    Employee  → L1=L1,   L2=L2")
    print(f"{'=' * 60}")

    client.close()


if __name__ == "__main__":
    asyncio.run(seed())
