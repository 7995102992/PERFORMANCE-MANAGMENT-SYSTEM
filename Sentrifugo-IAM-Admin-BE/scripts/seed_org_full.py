"""Full organisation seeding script.

Creates a complete org setup with interlinked data:
  - 1 Organisation + org admin user
  - 3 Business Units (with addresses)
  - 6 Departments (spread across BUs)
  - 12 Designations (spread across departments)
  - 6 Bands
  - 3 Pay Grades (linking bands + designations)
  - 2 Policies (Admin Full Access, Employee Basic)
  - 15 Employees (with BU/Dept/Desg assignments, managers, emergency contacts)
  - Org head + BU heads assigned
  - Setup progress set to all-completed

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.seed_org_full

Credentials after seeding:
    Super Admin:  sethunarayanan.valaparambil@sagarsoft.in / SuperAdmin@2026
    Org Admin:    orgadmin@acmecorp.com / test@123
    Employees:    <work_email> / (inactive — activation required)
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
from src.models import (
    AclDocument,
    ModuleDocument,
    ModuleEnum,
    OrgModule,
    PermissionDocument,
    StatusEnum,
)
from src.modules.organisation.models import (
    AddressDocument,
    BandDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    EmployeeDocument,
    EmergencyContact,
    OrganisationDocument,
    PayGradeDocument,
)
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.security.crypto import encrypt_amount, build_ctc

NOW = datetime.now(timezone.utc)
AUDIT = {
    "created_by": "seed_script",
    "created_on": NOW,
    "modified_by": "seed_script",
    "modified_on": NOW,
}


async def _md(category: str, key: str) -> PydanticObjectId:
    """Look up a master_data document by category+key and return its _id."""
    doc = await MasterDataDocument.find_one(
        MasterDataDocument.category == category,
        MasterDataDocument.key == key,
        MasterDataDocument.is_active == True,  # noqa: E712
    )
    if not doc:
        raise RuntimeError(f"Master data not found: {category}/{key}. Run seed_master_data first.")
    return doc.id


async def seed():
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check .env")
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
            AclDocument,
            ModuleDocument,
            PermissionDocument,
            PolicyDocument,
            ModuleAclPermissionDocument,
            AddressDocument,
            OrganisationDocument,
            BusinessUnitDocument,
            DepartmentDocument,
            DesignationDocument,
            BandDocument,
            PayGradeDocument,
            EmployeeDocument,
            MasterDataDocument,
            CustomFieldDefinitionDocument,
            CustomFieldOptionDocument,
            CustomFieldValueDocument,
        ],
    )

    # ── Clean up previous seed run (if any) ──────────────────────────
    ORG_NAME = "Acme Corp Technologies Pvt Ltd"
    existing_org = await OrganisationDocument.find_one(
        OrganisationDocument.legal_name == ORG_NAME,
    )
    if existing_org:
        oid = existing_org.id
        print(f"Found existing seed data (org={oid}). Cleaning up...")
        await EmployeeDocument.find(EmployeeDocument.organisation_id == oid).delete()
        await PayGradeDocument.find(PayGradeDocument.organisation_id == oid).delete()
        await BandDocument.find(BandDocument.organisation_id == oid).delete()
        await DesignationDocument.find(DesignationDocument.organisation_id == oid).delete()
        await DepartmentDocument.find(DepartmentDocument.organisation_id == oid).delete()
        await BusinessUnitDocument.find(BusinessUnitDocument.organisation_id == oid).delete()
        # policies + grants
        old_policies = await PolicyDocument.find(PolicyDocument.organisation_id == oid).to_list()
        for p in old_policies:
            await ModuleAclPermissionDocument.find(
                ModuleAclPermissionDocument.policy_id == p.id
            ).delete()
        await PolicyDocument.find(PolicyDocument.organisation_id == oid).delete()
        # users (org admin + employees)
        await UserDocument.find(UserDocument.organisation_id == oid).delete()
        # addresses tied to org
        await AddressDocument.find(AddressDocument.organisation_id == oid).delete()
        # org address (no organisation_id set on it, find via org.address_id)
        if existing_org.address_id:
            await AddressDocument.find(AddressDocument.id == existing_org.address_id).delete()
        # BU addresses (organisation_id is None on them, but they're orphaned now)
        await existing_org.delete()
        # Also clean any BU addresses that had no org_id
        print("  Cleanup complete.")

    # Pre-check: master data must be seeded
    md_count = await MasterDataDocument.count()
    if md_count == 0:
        print("ERROR: No master data found. Run `python -m scripts.seed_master_data` first.")
        client.close()
        return

    # Resolve master data IDs we'll need
    print("Resolving master data lookups...")
    sector_it = await _md("SECTORS", "information-technology")
    btype_service = await _md("BUSINESS_TYPES", "service-based")
    btype_product = await _md("BUSINESS_TYPES", "product-based")
    bnature_saas = await _md("BUSINESS_NATURES", "b2b-saas")
    bnature_custom = await _md("BUSINESS_NATURES", "custom-software")


    cl_leadership = await _md("CLASS_LABELS", "leadership")
    cl_senior = await _md("CLASS_LABELS", "senior-level")
    cl_mid = await _md("CLASS_LABELS", "mid-level")
    cl_junior = await _md("CLASS_LABELS", "junior-level")
    cl_intern = await _md("CLASS_LABELS", "intern")
    cl_billable = await _md("CLASS_LABELS", "billable")

    freq_monthly = await _md("FREQUENCIES", "monthly")

    et_fulltime = await _md("EMPLOYMENT_TYPES", "full-time")
    et_contract = await _md("EMPLOYMENT_TYPES", "contract")

    es_active = await _md("EMPLOYMENT_STATUSES", "permanent")
    ps_allocated = await _md("PROJECT_STATUSES", "allocated-to-project")

    soh_linkedin = await _md("SOURCES_OF_HIRE", "linkedin")
    soh_referral = await _md("SOURCES_OF_HIRE", "employee-referral")
    soh_campus = await _md("SOURCES_OF_HIRE", "campus-hiring")

    gender_male = await _md("GENDERS", "male")
    gender_female = await _md("GENDERS", "female")

    # -------------------------------------------------------------------------
    # 1. ORGANISATION
    # -------------------------------------------------------------------------
    print("Creating organisation...")
    org_address = AddressDocument(
        country="India",
        state="Telangana",
        city="Hyderabad",
        zip_code="500081",
        address_line_1="Plot 42, Madhapur IT Park",
        address_line_2="HITEC City",
        **AUDIT,
    )
    await org_address.insert()

    org = OrganisationDocument(
        legal_name="Acme Corp Technologies Pvt Ltd",
        address_id=org_address.id,
        date_of_incorporation=date(2015, 3, 15),
        financial_year="April - March",
        currency="INR",
        timezone="Asia/Kolkata",
        is_multiple_business_units=True,
        is_active=True,
        setup_status="active",
        enabled_modules=[
            OrgModule(code=ModuleEnum.CORE_HR, is_active=True),
            OrgModule(code=ModuleEnum.LEAVE_MANAGEMENT, is_active=True),
            OrgModule(code=ModuleEnum.SERVICE_REQUEST, is_active=True),
            OrgModule(code=ModuleEnum.TIMESHEET_MANAGEMENT, is_active=True),
        ],
        **AUDIT,
    )
    await org.insert()
    org_id = org.id
    print(f"  Organisation: {org.legal_name} (id={org_id})")

    # Org admin user
    org_admin = UserDocument(
        email="orgadmin@acmecorp.com",
        password_hash=get_password_hash("test@123"),
        auth_method="local",
        first_name="Arjun",
        last_name="Sharma",
        status=StatusEnum.ACTIVE,
        is_org_admin=True,
        organisation_id=org_id,
        password_changed_at=NOW,
        **AUDIT,
    )
    await org_admin.insert()
    print(f"  Org Admin: orgadmin@acmecorp.com / test@123")

    # -------------------------------------------------------------------------
    # 2. BUSINESS UNITS (3)
    # -------------------------------------------------------------------------
    print("Creating business units...")

    bu_data = [
        {
            "business_unit_name": "Software Services",
            "emp_code_prefix": "SVC",
            "sector": sector_it,
            "type_of_business": btype_service,
            "nature_of_business": bnature_custom,
            "address": {
                "country": "India", "state": "Telangana", "city": "Hyderabad",
                "zip_code": "500081",
                "address_line_1": "Block A, Madhapur IT Park",
            },
        },
        {
            "business_unit_name": "Cloud Products",
            "emp_code_prefix": "CPD",
            "sector": sector_it,
            "type_of_business": btype_product,
            "nature_of_business": bnature_saas,
            "address": {
                "country": "India", "state": "Karnataka", "city": "Bangalore",
                "zip_code": "560103",
                "address_line_1": "Tower 3, Manyata Tech Park",
            },
        },
        {
            "business_unit_name": "Global Operations",
            "emp_code_prefix": "GOP",
            "sector": sector_it,
            "type_of_business": btype_service,
            "nature_of_business": bnature_custom,
            "address": {
                "country": "India", "state": "Maharashtra", "city": "Pune",
                "zip_code": "411057",
                "address_line_1": "Floor 5, Hinjewadi Phase 2",
            },
        },
    ]

    bus: list[BusinessUnitDocument] = []
    for bd in bu_data:
        addr = AddressDocument(**bd["address"], **AUDIT)
        await addr.insert()
        bu = BusinessUnitDocument(
            organisation_id=org_id,
            business_unit_name=bd["business_unit_name"],
            emp_code_prefix=bd["emp_code_prefix"],
            address_id=addr.id,
            sector=bd["sector"],
            type_of_business=bd["type_of_business"],
            nature_of_business=bd["nature_of_business"],
            date_of_incorporation=date(2015, 3, 15),
            financial_year="April - March",
            currency="INR",
            time_zone="Asia/Kolkata",
            time_format="24hr",
            is_active=True,
            emp_code_last_number=0,
            emp_code_last_numbers={},
            emp_code_start_from={},
            **AUDIT,
        )
        await bu.insert()
        bus.append(bu)
        print(f"  BU: {bu.business_unit_name} ({bu.emp_code_prefix})")

    bu_svc, bu_cpd, bu_gop = bus

    # -------------------------------------------------------------------------
    # 3. DEPARTMENTS (6)
    # -------------------------------------------------------------------------
    print("Creating departments...")

    # primary_business_unit is mandatory when a department spans multiple BUs.
    # For single-BU depts we set it to that BU explicitly.
    dept_data = [
        {"department_name": "Engineering",       "department_code": "ENG",  "bus": [bu_svc.id, bu_cpd.id],            "primary_bu": bu_svc.id},
        {"department_name": "Quality Assurance",  "department_code": "QA",   "bus": [bu_svc.id, bu_cpd.id],            "primary_bu": bu_svc.id},
        {"department_name": "Human Resources",    "department_code": "HR",   "bus": [bu_svc.id, bu_cpd.id, bu_gop.id], "primary_bu": bu_gop.id},
        {"department_name": "Finance & Accounts", "department_code": "FIN",  "bus": [bu_gop.id],                        "primary_bu": bu_gop.id},
        {"department_name": "Product Management", "department_code": "PM",   "bus": [bu_cpd.id],                        "primary_bu": bu_cpd.id},
        {"department_name": "DevOps & Infra",     "department_code": "DOPS", "bus": [bu_svc.id, bu_cpd.id],            "primary_bu": bu_svc.id},
    ]

    depts: list[DepartmentDocument] = []
    for dd in dept_data:
        dept = DepartmentDocument(
            organisation_id=org_id,
            department_name=dd["department_name"],
            department_code=dd["department_code"],
            business_units=dd["bus"],
            primary_business_unit=dd["primary_bu"],
            is_active=True,
            **AUDIT,
        )
        await dept.insert()
        depts.append(dept)
        print(f"  Dept: {dept.department_name} ({dept.department_code})")

    dept_eng, dept_qa, dept_hr, dept_fin, dept_pm, dept_dops = depts

    # -------------------------------------------------------------------------
    # 4. DESIGNATIONS (12)
    # -------------------------------------------------------------------------
    print("Creating designations...")

    # Designations are org-level now (no department / hierarchy role).
    desg_data = [
        "CTO", "VP Engineering", "Engineering Manager", "Senior Software Engineer",
        "Software Engineer", "QA Lead", "QA Engineer", "HR Director", "HR Executive",
        "Finance Manager", "Product Manager", "DevOps Engineer",
    ]

    desgs: dict[str, DesignationDocument] = {}
    for desg_name in desg_data:
        desg = DesignationDocument(
            organisation_id=org_id,
            designation_name=desg_name,
            description=f"{desg_name} role",
            is_active=True,
            **AUDIT,
        )
        await desg.insert()
        desgs[desg_name] = desg
        print(f"  Desg: {desg.designation_name}")

    # -------------------------------------------------------------------------
    # 5. BANDS (6)
    # -------------------------------------------------------------------------
    print("Creating bands...")

    band_data = [
        {"name": "Band L1 - Leadership",  "class_label": cl_leadership, "min": 200000, "max": 500000},
        {"name": "Band L2 - Senior Mgmt", "class_label": cl_senior,     "min": 120000, "max": 250000},
        {"name": "Band M1 - Management",  "class_label": cl_mid,        "min": 80000,  "max": 150000},
        {"name": "Band S1 - Senior IC",   "class_label": cl_billable,   "min": 60000,  "max": 120000},
        {"name": "Band J1 - Junior IC",   "class_label": cl_junior,     "min": 30000,  "max": 70000},
        {"name": "Band I1 - Intern",      "class_label": cl_intern,     "min": 15000,  "max": 30000},
    ]

    bands: list[BandDocument] = []
    for bd in band_data:
        # Intern band gets an explicit effective_to to mirror the new validator
        # (effective_to must be strictly after effective_from when provided).
        effective_to = date(2026, 3, 31) if bd["name"] == "Band I1 - Intern" else None
        band = BandDocument(
            organisation_id=org_id,
            name=bd["name"],
            class_label=bd["class_label"],
            frequency=freq_monthly,
            currency="INR",
            min_amount=encrypt_amount(bd["min"]),
            max_amount=encrypt_amount(bd["max"]),
            effective_from=date(2025, 4, 1),
            effective_to=effective_to,
            notes="",
            is_active=True,
            **AUDIT,
        )
        await band.insert()
        bands.append(band)
        print(f"  Band: {band.name} (₹{bd['min']:,.0f} - ₹{bd['max']:,.0f})")

    band_l1, band_l2, band_m1, band_s1, band_j1, band_i1 = bands

    # -------------------------------------------------------------------------
    # 6. PAY GRADES (3)
    # -------------------------------------------------------------------------
    print("Creating pay grades...")

    # The pay-grade ↔ designation link now lives on the DESIGNATION
    # (DesignationDocument.pay_grade_ids), not on the pay grade. So pay grades
    # are inserted with bands only, then each is mapped onto its designations
    # below.
    pg_data = [
        {
            "name": "Executive Grade",
            "description": "CXO and Leadership roles",
            "band_ids": [band_l1.id, band_l2.id],
            "designations": ["CTO", "VP Engineering", "HR Director"],
        },
        {
            "name": "Management Grade",
            "description": "Manager-level roles",
            "band_ids": [band_m1.id, band_s1.id],
            "designations": ["Engineering Manager", "QA Lead", "Finance Manager", "Product Manager"],
        },
        {
            "name": "Individual Contributor Grade",
            "description": "Engineers, analysts, and support roles",
            "band_ids": [band_j1.id, band_i1.id],
            "designations": [
                "Senior Software Engineer", "Software Engineer",
                "QA Engineer", "HR Executive", "DevOps Engineer",
            ],
        },
    ]

    # designation_name -> list of pay-grade ObjectIds assigned to it.
    desg_pay_grades: dict[str, list[PydanticObjectId]] = {}
    for pgd in pg_data:
        pg = PayGradeDocument(
            organisation_id=org_id,
            name=pgd["name"],
            description=pgd["description"],
            band_ids=pgd["band_ids"],
            is_active=True,
            **AUDIT,
        )
        await pg.insert()
        for desg_name in pgd["designations"]:
            desg_pay_grades.setdefault(desg_name, []).append(pg.id)
        print(f"  PayGrade: {pg.name}")

    # Persist the link on each designation.
    for desg_name, pg_ids in desg_pay_grades.items():
        desg = desgs.get(desg_name)
        if desg:
            desg.pay_grade_ids = pg_ids
            await desg.save()
    print("  Pay grades linked to designations")

    # -------------------------------------------------------------------------
    # 7. POLICIES (2)
    # -------------------------------------------------------------------------
    print("Creating policies...")

    # Policy 1: Admin Full Access
    policy_admin = PolicyDocument(
        name="Admin Full Access",
        is_role=True,
        is_active=True,
        organisation_id=org_id,
        seed_module_codes=["core_hr", "leave_management", "service_request", "timesheet_management"],
        **AUDIT,
    )
    await policy_admin.insert()

    admin_perms = {
        "core_hr": ["create_resource", "apply_exit_request", "approve_exit_request",
                     "monitor_exit_request", "it_clearances", "admin_clearances", "final_settlement"],
        "leave_management": ["holiday_plan", "leave_plan", "work_calendar", "leave_configuration",
                             "leave_types", "leave_request", "manage_leave_request", "leave_balance"],
        "service_request": ["raise_request", "execute_request", "approve_request", "manage_request",
                            "view_all_requests", "manage_catalog", "manage_workflows"],
        "timesheet_management": ["my_timesheet", "manage_timesheet", "client_timesheet",
                                 "manage_clients", "manage_projects", "manage_settings", "view_reports"],
    }
    for module_code, perm_codes in admin_perms.items():
        for perm_code in perm_codes:
            grant = ModuleAclPermissionDocument(
                policy_id=policy_admin.id,
                module_id=module_code,
                acl_id="admin",
                permission_id=perm_code,
                **AUDIT,
            )
            await grant.insert()

    # Policy 2: Employee Basic
    policy_emp = PolicyDocument(
        name="Employee Basic",
        is_role=True,
        is_active=True,
        organisation_id=org_id,
        seed_module_codes=["core_hr", "leave_management", "service_request", "timesheet_management"],
        **AUDIT,
    )
    await policy_emp.insert()

    emp_perms = {
        "core_hr": ["apply_exit_request"],
        "leave_management": ["leave_request", "leave_balance"],
        "service_request": ["raise_request"],
        "timesheet_management": ["my_timesheet"],
    }
    for module_code, perm_codes in emp_perms.items():
        for perm_code in perm_codes:
            grant = ModuleAclPermissionDocument(
                policy_id=policy_emp.id,
                module_id=module_code,
                acl_id="viewer",
                permission_id=perm_code,
                **AUDIT,
            )
            await grant.insert()

    print(f"  Policy: {policy_admin.name}")
    print(f"  Policy: {policy_emp.name}")

    # -------------------------------------------------------------------------
    # 8. EMPLOYEES (15) — created in hierarchy order
    # -------------------------------------------------------------------------
    print("Creating employees...")

    EMP_TYPE_LETTERS = {"full-time": "F", "contract": "C", "internship": "I"}

    # CTC per tier (INR / month) — stored encrypted in the EmployeeDocument.
    CTC_BY_TIER = {
        "cxo": 450000.0,
        "leadership": 300000.0,
        "manager": 180000.0,
        "ic": 90000.0,
    }

    async def _next_emp_code(bu: BusinessUnitDocument, emp_type_key: str = "full-time") -> str:
        letter = EMP_TYPE_LETTERS.get(emp_type_key)
        if not letter:
            raise RuntimeError(f"Unsupported employment type '{emp_type_key}'. Allowed: full-time, contract, internship.")
        bu.emp_code_last_numbers[letter] = bu.emp_code_last_numbers.get(letter, 0) + 1
        start_from = bu.emp_code_start_from.get(letter, 0)
        next_num = start_from + bu.emp_code_last_numbers[letter]
        await bu.save()
        return f"{bu.emp_code_prefix}-{next_num}" if letter == "F" else f"{bu.emp_code_prefix}-{letter}-{next_num}"

    async def create_employee(
        *,
        email: str,
        first_name: str,
        last_name: str,
        bu: BusinessUnitDocument,
        dept: DepartmentDocument,
        desg: DesignationDocument,
        gender: PydanticObjectId,
        doj: date,
        source: PydanticObjectId,
        l1: Optional[PydanticObjectId] = None,
        l2: Optional[PydanticObjectId] = None,
        policies: Optional[list[PolicyDocument]] = None,
        tier: str = "ic",
    ) -> tuple[UserDocument, EmployeeDocument]:
        emp_code = await _next_emp_code(bu)

        user = UserDocument(
            email=email,
            password_hash=get_password_hash("test@123"),
            auth_method="local",
            first_name=first_name,
            last_name=last_name,
            gender=gender,
            organisation_id=org_id,
            status=StatusEnum.ACTIVE,
            policy_ids=[p.id for p in policies] if policies else [policy_emp.id],
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
            designation_id=desg.id,
            employment_type=et_fulltime,
            employment_status=es_active,
            project_status=ps_allocated,
            source_of_hire=source,
            date_of_joining=doj,
            l1_manager_id=l1,
            l2_manager_id=l2,
            ctc=build_ctc(CTC_BY_TIER.get(tier, CTC_BY_TIER["ic"]), "INR"),
            currency="INR",
            emergency_contacts=[
                EmergencyContact(
                    contact_name=f"{first_name} Emergency",
                    contact_number="+91-9876543210",
                    relationship="Spouse",
                )
            ],
            **AUDIT,
        )
        await emp.insert()
        print(f"  {emp_code} | {first_name} {last_name} <{email}> | {desg.designation_name}")
        return user, emp

    # --- CXO / Leadership (no managers required) ---

    u_cto, e_cto = await create_employee(
        email="rajesh.kumar@acmecorp.com",
        first_name="Rajesh", last_name="Kumar",
        bu=bu_svc, dept=dept_eng, desg=desgs["CTO"],
        gender=gender_male, doj=date(2015, 3, 15),
        source=soh_linkedin, policies=[policy_admin], tier="cxo",
    )

    u_vpe, e_vpe = await create_employee(
        email="priya.nair@acmecorp.com",
        first_name="Priya", last_name="Nair",
        bu=bu_cpd, dept=dept_eng, desg=desgs["VP Engineering"],
        gender=gender_female, doj=date(2016, 6, 1),
        source=soh_linkedin, l1=u_cto.id,
        policies=[policy_admin], tier="leadership",
    )

    u_hrd, e_hrd = await create_employee(
        email="meena.iyer@acmecorp.com",
        first_name="Meena", last_name="Iyer",
        bu=bu_gop, dept=dept_hr, desg=desgs["HR Director"],
        gender=gender_female, doj=date(2016, 8, 10),
        source=soh_linkedin, l1=u_cto.id,
        policies=[policy_admin], tier="leadership",
    )

    # --- Managers (need L1 + L2) — get Admin policy ---

    u_em1, e_em1 = await create_employee(
        email="suresh.reddy@acmecorp.com",
        first_name="Suresh", last_name="Reddy",
        bu=bu_svc, dept=dept_eng, desg=desgs["Engineering Manager"],
        gender=gender_male, doj=date(2017, 1, 10),
        source=soh_referral, l1=u_vpe.id, l2=u_cto.id,
        policies=[policy_admin], tier="manager",
    )

    u_em2, e_em2 = await create_employee(
        email="anita.desai@acmecorp.com",
        first_name="Anita", last_name="Desai",
        bu=bu_cpd, dept=dept_eng, desg=desgs["Engineering Manager"],
        gender=gender_female, doj=date(2018, 4, 1),
        source=soh_linkedin, l1=u_vpe.id, l2=u_cto.id,
        policies=[policy_admin], tier="manager",
    )

    u_qal, e_qal = await create_employee(
        email="vikram.singh@acmecorp.com",
        first_name="Vikram", last_name="Singh",
        bu=bu_svc, dept=dept_qa, desg=desgs["QA Lead"],
        gender=gender_male, doj=date(2018, 7, 15),
        source=soh_referral, l1=u_vpe.id, l2=u_cto.id,
        policies=[policy_admin], tier="manager",
    )

    u_fm, e_fm = await create_employee(
        email="deepa.menon@acmecorp.com",
        first_name="Deepa", last_name="Menon",
        bu=bu_gop, dept=dept_fin, desg=desgs["Finance Manager"],
        gender=gender_female, doj=date(2017, 9, 1),
        source=soh_linkedin, l1=u_hrd.id, l2=u_cto.id,
        policies=[policy_admin], tier="manager",
    )

    u_pm, e_pm = await create_employee(
        email="arun.patel@acmecorp.com",
        first_name="Arun", last_name="Patel",
        bu=bu_cpd, dept=dept_pm, desg=desgs["Product Manager"],
        gender=gender_male, doj=date(2019, 2, 1),
        source=soh_linkedin, l1=u_vpe.id, l2=u_cto.id,
        policies=[policy_admin], tier="manager",
    )

    # --- Individual Contributors (need L1 + L2) ---

    u_sse1, e_sse1 = await create_employee(
        email="kavitha.raju@acmecorp.com",
        first_name="Kavitha", last_name="Raju",
        bu=bu_svc, dept=dept_eng, desg=desgs["Senior Software Engineer"],
        gender=gender_female, doj=date(2019, 6, 10),
        source=soh_referral, l1=u_em1.id, l2=u_vpe.id,
    )

    u_se1, e_se1 = await create_employee(
        email="rohit.verma@acmecorp.com",
        first_name="Rohit", last_name="Verma",
        bu=bu_svc, dept=dept_eng, desg=desgs["Software Engineer"],
        gender=gender_male, doj=date(2020, 8, 1),
        source=soh_campus, l1=u_em1.id, l2=u_vpe.id,
    )

    u_se2, e_se2 = await create_employee(
        email="sneha.gupta@acmecorp.com",
        first_name="Sneha", last_name="Gupta",
        bu=bu_cpd, dept=dept_eng, desg=desgs["Software Engineer"],
        gender=gender_female, doj=date(2021, 1, 15),
        source=soh_campus, l1=u_em2.id, l2=u_vpe.id,
    )

    u_qa1, e_qa1 = await create_employee(
        email="rahul.joshi@acmecorp.com",
        first_name="Rahul", last_name="Joshi",
        bu=bu_svc, dept=dept_qa, desg=desgs["QA Engineer"],
        gender=gender_male, doj=date(2020, 3, 1),
        source=soh_linkedin, l1=u_qal.id, l2=u_vpe.id,
    )

    u_hre, e_hre = await create_employee(
        email="pooja.shah@acmecorp.com",
        first_name="Pooja", last_name="Shah",
        bu=bu_gop, dept=dept_hr, desg=desgs["HR Executive"],
        gender=gender_female, doj=date(2021, 5, 1),
        source=soh_referral, l1=u_hrd.id, l2=u_cto.id,
    )

    u_dops, e_dops = await create_employee(
        email="kiran.rao@acmecorp.com",
        first_name="Kiran", last_name="Rao",
        bu=bu_cpd, dept=dept_dops, desg=desgs["DevOps Engineer"],
        gender=gender_male, doj=date(2020, 11, 1),
        source=soh_linkedin, l1=u_em2.id, l2=u_vpe.id,
    )

    # -------------------------------------------------------------------------
    # 9. ASSIGN HEADS
    # -------------------------------------------------------------------------
    print("Assigning heads...")

    # Org head = CTO
    org.head_user_id = u_cto.id
    await org.save()
    print(f"  Org Head: {u_cto.first_name} {u_cto.last_name}")

    # BU heads
    bu_svc.head_user_id = u_em1.id
    await bu_svc.save()
    print(f"  BU Head ({bu_svc.business_unit_name}): Suresh Reddy")

    bu_cpd.head_user_id = u_vpe.id
    await bu_cpd.save()
    print(f"  BU Head ({bu_cpd.business_unit_name}): Priya Nair")

    bu_gop.head_user_id = u_hrd.id
    await bu_gop.save()
    print(f"  BU Head ({bu_gop.business_unit_name}): Meena Iyer")

    # Dept heads
    dept_eng.department_head = u_vpe.id
    await dept_eng.save()
    dept_qa.department_head = u_qal.id
    await dept_qa.save()
    dept_hr.department_head = u_hrd.id
    await dept_hr.save()
    dept_fin.department_head = u_fm.id
    await dept_fin.save()
    dept_pm.department_head = u_pm.id
    await dept_pm.save()
    dept_dops.department_head = u_em2.id
    await dept_dops.save()
    print("  Department heads assigned")

    # -------------------------------------------------------------------------
    # 10. UPDATE SETUP PROGRESS → all completed
    # -------------------------------------------------------------------------
    print("Updating setup progress...")

    org.setup_progress = {
        "organisation": "completed",
        "business_units": "completed",
        "departments": "completed",
        "org_documents": "pending",
        "policies": "completed",
        "designations": "completed",
        "bands": "completed",
        "pay_grades": "completed",
        "employees": "completed",
        "assign_head": "completed",
    }
    await org.save()

    # -------------------------------------------------------------------------
    # SUMMARY
    # -------------------------------------------------------------------------
    print("\n" + "=" * 65)
    print("  SEED COMPLETE — Acme Corp Technologies Pvt Ltd")
    print("=" * 65)
    print()
    print("  Org ID:          ", str(org_id))
    print("  Business Units:   3")
    print("  Departments:      6")
    print("  Designations:    12")
    print("  Bands:            6")
    print("  Pay Grades:       3")
    print("  Policies:         2")
    print("  Employees:       15")
    print()
    print("  ─── LOGIN CREDENTIALS ───")
    print()
    print("  SUPER ADMIN (Admin Portal)")
    print("    Email:    sethunarayanan.valaparambil@sagarsoft.in")
    print("    Password: SuperAdmin@2026")
    print()
    print("  ORG ADMIN (Tenant Login)")
    print("    Email:    orgadmin@acmecorp.com")
    print("    Password: test@123")
    print()
    print("  ALL EMPLOYEES")
    print("    Password: test@123  (all 15 employees, status=ACTIVE)")
    print()
    print("  Note: Org documents step is 'pending' (files/docs are optional).")
    print("=" * 65)

    client.close()


if __name__ == "__main__":
    asyncio.run(seed())
