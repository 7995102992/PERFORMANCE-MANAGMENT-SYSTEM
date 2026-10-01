"""Small organisation seeding via REST API (10 employees, single BU, 3 depts).

A lightweight counterpart to seed_org_via_api.py / seed_org_large_via_api.py —
good for a quick, realistic tenant without the bulk. Calls the actual API
endpoints so RabbitMQ events fire and downstream microservices (leave,
timesheet, service-request, etc.) pick up the data.

Structure:
  - 1 Organisation: "Brightwave Labs Pvt Ltd"  (is_multiple_business_units=False)
  - 1 Business Unit: "Brightwave HQ" (prefix BWL)
  - 3 Departments: Engineering, Operations, People & Culture
  - 7 Designations (flat org-level job titles), linked to 1 Pay Grade
  - 2 Bands, 1 Pay Grade
  - 2 Role policies (Administrator / Employee), assigned directly via roleIds
  - 10 Employees with an L1 manager chain
  - Org head, BU head, Dept heads assigned

Prerequisites:
    - IAM Admin BE running at BASE_URL (default http://localhost:8000)
    - seed_master_data, seed_lookups, seed_superadmin already run

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.seed_org_small_via_api

    # Custom base URL:
    BASE_URL=http://localhost:8001 python -m scripts.seed_org_small_via_api

Credentials after seeding:
    Super Admin:  sethunarayanan.valaparambil@sagarsoft.in / SuperAdmin@2026
    Org Admin:    orgadmin@brightwave.com / test@123
    All Employees: <work_email> / test@123  (status=ACTIVE)
"""

import asyncio
import os
import sys
from datetime import datetime, timezone

import httpx
from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.auth.utils.tools import get_password_hash
from src.config import settings
from src.master_data.models import MasterDataDocument
from src.models import StatusEnum
from src.modules.organisation.models import (
    AddressDocument,
    BandDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    EmployeeDocument,
    OrganisationDocument,
    PayGradeDocument,
)
from src.policies.models import ModuleAclPermissionDocument, PolicyDocument

BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
TIMEOUT = 30.0

SUPERADMIN_EMAIL = "sethunarayanan.valaparambil@sagarsoft.in"
SUPERADMIN_PASSWORD = "SuperAdmin@2026"
ORG_ADMIN_EMAIL = "orgadmin@brightwave.com"
ORG_ADMIN_PASSWORD = "test@123"
ORG_NAME = "Brightwave Labs Pvt Ltd"
EMP_PASSWORD = "test@123"
DOMAIN = "brightwave.com"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def _login(client: httpx.AsyncClient, email: str, password: str, *, portal: bool = False) -> str:
    url = f"{BASE_URL}/auth/{'portal/login' if portal else 'login'}"
    r = await client.post(url, json={"email": email, "password": password})
    if r.status_code != 200:
        print(f"  LOGIN FAILED ({email}): {r.status_code} {r.text}")
        sys.exit(1)
    return r.json()["access_token"]


async def _post(client: httpx.AsyncClient, path: str, token: str, body: dict) -> dict:
    r = await client.post(f"{BASE_URL}{path}", headers=_hdr(token), json=body)
    if r.status_code not in (200, 201):
        print(f"  POST {path} FAILED: {r.status_code}")
        print(f"    {r.text[:500]}")
        sys.exit(1)
    return r.json()


async def _put(client: httpx.AsyncClient, path: str, token: str, body: dict) -> dict:
    r = await client.put(f"{BASE_URL}{path}", headers=_hdr(token), json=body)
    if r.status_code not in (200, 201):
        print(f"  PUT {path} FAILED: {r.status_code}")
        print(f"    {r.text[:500]}")
        sys.exit(1)
    return r.json()


async def _md_id(category: str, key: str) -> str:
    """Look up a master_data ObjectId by category+key. Returns string ID."""
    doc = await MasterDataDocument.find_one(
        MasterDataDocument.category == category,
        MasterDataDocument.key == key,
        MasterDataDocument.is_active == True,  # noqa: E712
    )
    if not doc:
        raise RuntimeError(f"Master data not found: {category}/{key}. Run seed_master_data first.")
    return str(doc.id)


def _email(first: str, last: str) -> str:
    return f"{first.lower()}.{last.lower()}@{DOMAIN}"


# ── Main ─────────────────────────────────────────────────────────────────────

async def seed():
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL not configured.")
        return

    mongo_client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = mongo_client.get_default_database()
    await init_beanie(database=db, document_models=[
        UserDocument, MasterDataDocument,
        OrganisationDocument, BusinessUnitDocument, DepartmentDocument,
        DesignationDocument, BandDocument, PayGradeDocument,
        EmployeeDocument, AddressDocument,
        PolicyDocument, ModuleAclPermissionDocument,
    ])

    # ── Clean up previous seed run (if any) ──────────────────────────────
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
        old_policies = await PolicyDocument.find(PolicyDocument.organisation_id == oid).to_list()
        for p in old_policies:
            await ModuleAclPermissionDocument.find(
                ModuleAclPermissionDocument.policy_id == p.id
            ).delete()
        await PolicyDocument.find(PolicyDocument.organisation_id == oid).delete()
        await UserDocument.find(UserDocument.organisation_id == oid).delete()
        await AddressDocument.find(AddressDocument.organisation_id == oid).delete()
        if existing_org.address_id:
            await AddressDocument.find(AddressDocument.id == existing_org.address_id).delete()
        await existing_org.delete()
        print("  Cleanup complete.")

    md_count = await MasterDataDocument.count()
    if md_count == 0:
        print("ERROR: No master data. Run `python -m scripts.seed_master_data` first.")
        mongo_client.close()
        return

    # ── Resolve master data IDs ──────────────────────────────────────────
    print("Resolving master data lookups...")
    sector_it = await _md_id("SECTORS", "information-technology")
    btype_service = await _md_id("BUSINESS_TYPES", "service-based")
    bnature_custom = await _md_id("BUSINESS_NATURES", "custom-software")

    cl_mid = await _md_id("CLASS_LABELS", "mid-level")
    cl_junior = await _md_id("CLASS_LABELS", "junior-level")
    freq_monthly = await _md_id("FREQUENCIES", "monthly")

    et_fulltime = await _md_id("EMPLOYMENT_TYPES", "full-time")
    es_permanent = await _md_id("EMPLOYMENT_STATUSES", "permanent")
    ps_allocated = await _md_id("PROJECT_STATUSES", "allocated-to-project")

    soh_linkedin = await _md_id("SOURCES_OF_HIRE", "linkedin")
    soh_referral = await _md_id("SOURCES_OF_HIRE", "employee-referral")
    soh_campus = await _md_id("SOURCES_OF_HIRE", "campus-hiring")
    sources = [soh_linkedin, soh_referral, soh_campus]

    gender_male = await _md_id("GENDERS", "male")
    gender_female = await _md_id("GENDERS", "female")

    async with httpx.AsyncClient(timeout=TIMEOUT) as http:

        # ── 1. Super admin login ─────────────────────────────────────────
        print("Logging in as super admin...")
        sa_token = await _login(http, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, portal=True)
        print("  OK")

        # ── 2. Create org ────────────────────────────────────────────────
        print("Creating organisation via API...")
        org_resp = await _post(http, "/super-admin/organisations", sa_token, {
            "legal_name": ORG_NAME,
            "is_multiple_business_units": False,
            "is_active": True,
            "setup_status": "active",
            "enabled_modules": [
                {"code": "core_hr", "is_active": True},
                {"code": "leave_management", "is_active": True},
                {"code": "service_request", "is_active": True},
                {"code": "timesheet_management", "is_active": True},
            ],
            "administrator": {"name": "Meera Iyer", "email": ORG_ADMIN_EMAIL},
            "send_activation": False,
        })
        org_id = org_resp["id"]
        print(f"  Org: {ORG_NAME} (id={org_id})")

        admin_user = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL)
        if admin_user:
            admin_user.password_hash = get_password_hash(ORG_ADMIN_PASSWORD)
            admin_user.status = StatusEnum.ACTIVE
            admin_user.password_changed_at = datetime.now(timezone.utc)
            await admin_user.save()
            print(f"  Org Admin activated: {ORG_ADMIN_EMAIL} / {ORG_ADMIN_PASSWORD}")

        # ── 3. Org admin login ───────────────────────────────────────────
        print("Logging in as org admin...")
        oa_token = await _login(http, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD)
        print("  OK")

        # ── 4. Update org details ────────────────────────────────────────
        await _put(http, f"/organisations/{org_id}", oa_token, {
            "address": {
                "country": "India", "state": "Telangana", "city": "Hyderabad",
                "zip_code": "500084", "address_line_1": "5th Floor, Cyber Gateway",
                "address_line_2": "HITEC City",
            },
            "date_of_incorporation": "2020-04-01",
            "financial_year": "April - March",
            "currency": "INR",
            "timezone": "Asia/Kolkata",
        })
        print("  Org details updated")

        # ── 5. Business Unit (1) ─────────────────────────────────────────
        # empCodeStartFrom is the FIRST emp code per type (digit string; a
        # leading zero sets the zero-pad width). "1" → codes like BWL-F-1, BWL-F-2.
        print("Creating business unit...")
        code_start = {"fullTime": "1", "contract": "1", "internship": "1"}
        bu_resp = await _post(http, "/business-units/", oa_token, {
            "business_unit_name": "Brightwave HQ",
            "emp_code_prefix": "BWL",
            "empCodeStartFrom": code_start,
            "sector": sector_it, "type_of_business": btype_service,
            "nature_of_business": bnature_custom,
            "address": {
                "country": "India", "state": "Telangana", "city": "Hyderabad",
                "zip_code": "500084", "address_line_1": "5th Floor, Cyber Gateway",
            },
            "date_of_incorporation": "2020-04-01T00:00:00",
            "financial_year": "April - March",
            "currency": "INR",
            "time_zone": "Asia/Kolkata",
            "time_format": "24hr",
        })
        bu_id = bu_resp["id"]
        print(f"  BU: Brightwave HQ (BWL)")

        # ── 6. Departments (3) ───────────────────────────────────────────
        # Single-BU departments → primaryBusinessUnit is auto-set server-side.
        print("Creating departments...")
        dept_data = [
            {"departmentName": "Engineering",      "departmentCode": "ENG", "businessUnits": [bu_id]},
            {"departmentName": "Operations",        "departmentCode": "OPS", "businessUnits": [bu_id]},
            {"departmentName": "People & Culture",  "departmentCode": "PPL", "businessUnits": [bu_id]},
        ]
        depts = {}
        for dd in dept_data:
            resp = await _post(http, "/departments/", oa_token, dd)
            depts[dd["departmentName"]] = resp["id"]
            print(f"  Dept: {dd['departmentName']}")

        # ── 7. Role policies (2) ─────────────────────────────────────────
        # Roles are standalone (is_role=true) and assigned directly to employees
        # via roleIds. Two grids: Administrator (full) + Employee (self-service).
        admin_grid = {
            "core_hr": {"admin": {
                "create_resource": True, "apply_exit_request": True,
                "approve_exit_request": True, "monitor_exit_request": True,
                "it_clearances": True, "admin_clearances": True, "final_settlement": True,
            }, "editor": {}, "viewer": {}},
            "leave_management": {"admin": {
                "holiday_plan": True, "leave_plan": True, "work_calendar": True,
                "leave_configuration": True, "leave_types": True, "leave_request": True,
                "manage_leave_request": True, "leave_balance": True,
            }, "editor": {}, "viewer": {}},
            "service_request": {"admin": {
                "raise_request": True, "execute_request": True, "approve_request": True,
                "manage_request": True, "view_all_requests": True,
                "manage_catalog": True, "manage_workflows": True,
            }, "editor": {}, "viewer": {}},
            "timesheet_management": {"admin": {
                "my_timesheet": True, "manage_timesheet": True, "client_timesheet": True,
                "manage_clients": True, "manage_projects": True,
                "manage_settings": True, "view_reports": True,
            }, "editor": {}, "viewer": {}},
        }
        emp_grid = {
            "core_hr": {"admin": {}, "editor": {}, "viewer": {"apply_exit_request": True}},
            "leave_management": {"admin": {}, "editor": {}, "viewer": {"leave_request": True, "leave_balance": True}},
            "service_request": {"admin": {}, "editor": {"manage_request": True, "execute_request": True}, "viewer": {"raise_request": True}},
            "timesheet_management": {"admin": {}, "editor": {}, "viewer": {"my_timesheet": True}},
        }
        print("Creating role policies...")
        roles = {}
        for role_name, grid in (("Administrator", admin_grid), ("Employee", emp_grid)):
            resp = await _post(http, "/policies", oa_token, {
                "name": role_name, "is_role": True, "is_active": True,
                "organisation_id": org_id, "permissions": grid,
            })
            roles[role_name] = resp["id"]
            print(f"  Role: {role_name} (id={resp['id']})")

        # ── 8. Designations (7) — flat org-level job titles ──────────────
        print("Creating designations...")
        desg_data = [
            "Engineering Manager", "Software Engineer", "QA Engineer",
            "Operations Lead", "Operations Executive",
            "HR Manager", "HR Executive",
        ]
        desgs = {}
        for name in desg_data:
            resp = await _post(http, "/designations/", oa_token, {"designationName": name})
            desgs[name] = resp["id"]
            print(f"  Desg: {name}")

        # ── 9. Bands (2) + Pay Grade (1) ─────────────────────────────────
        print("Creating bands...")
        band_data = [
            {"name": "Management Band", "classLabel": cl_mid,    "minAmount": 90000, "maxAmount": 200000},
            {"name": "IC Band",         "classLabel": cl_junior, "minAmount": 35000, "maxAmount": 90000},
        ]
        bands = {}
        for bd in band_data:
            resp = await _post(http, "/bands/", oa_token, {
                **bd, "frequency": freq_monthly, "currency": "INR", "effectiveFrom": "2025-04-01",
            })
            bands[bd["name"]] = resp["id"]
            print(f"  Band: {bd['name']}")

        print("Creating pay grade...")
        # Pay grade carries bands only — the pay-grade ↔ designation link lives
        # on the designation (pay_grade_ids), set via the update below.
        pg_resp = await _post(http, "/paygrades/", oa_token, {
            "name": "Standard Grade",
            "description": "Default pay grade for all roles",
            "bandIds": [bands["Management Band"], bands["IC Band"]],
        })
        pg_id = pg_resp["id"]
        print("  PayGrade: Standard Grade")

        print("Linking pay grade to designations...")
        for name in desg_data:
            await _put(http, f"/designations/{desgs[name]}", oa_token, {"payGradeIds": [pg_id]})
        print("  Pay grade linked to all designations")

        # ── 10. Employees (10) ───────────────────────────────────────────
        print("\nCreating employees...")
        user_ids = {}
        ctc_by_tier = {"admin": 220000.0, "manager": 150000.0, "ic": 70000.0}

        async def create_emp(*, first, last, dept, desg, gender, doj, source_idx=0,
                             l1=None, l2=None, tier="ic", role="Employee"):
            email = _email(first, last)
            payload = {
                "workEmail": email, "firstName": first, "lastName": last,
                "businessUnitId": bu_id,
                "departmentId": depts[dept], "designationId": desgs[desg],
                "gender": gender, "dateOfJoining": doj,
                "sourceOfHire": sources[source_idx % 3],
                "l1ManagerId": l1, "l2ManagerId": l2,
                "employmentType": et_fulltime,
                "employmentStatus": es_permanent,
                "projectStatus": ps_allocated,
                "ctc": ctc_by_tier.get(tier, ctc_by_tier["ic"]),
                "currency": "INR",
                # Roles assigned directly to the employee (schema alias roleIds).
                "roleIds": [roles[role]],
                "emergencyContacts": [
                    {"contactName": f"{first} Family", "contactNumber": "+91-9876543210", "relationship": "Spouse"}
                ],
            }
            resp = await _post(http, "/employees/", oa_token, payload)
            uid = resp.get("userId") or resp.get("user_id")
            user_ids[email] = uid
            code = resp.get("empCode") or resp.get("emp_code", "")
            print(f"  {code} | {first} {last} <{email}> | {desg}")
            return uid

        # Top of the org — head + Administrator role, no managers.
        head = await create_emp(first="Rohan", last="Kapoor", dept="Engineering",
                                desg="Engineering Manager", gender=gender_male,
                                doj="2020-04-01", tier="admin", role="Administrator")

        # Engineering ICs (report to head)
        await create_emp(first="Ananya", last="Reddy", dept="Engineering", desg="Software Engineer",
                         gender=gender_female, doj="2021-02-01", source_idx=0, l1=head, tier="ic")
        await create_emp(first="Karan", last="Mehta", dept="Engineering", desg="Software Engineer",
                         gender=gender_male, doj="2021-07-15", source_idx=1, l1=head, tier="ic")
        await create_emp(first="Pooja", last="Nair", dept="Engineering", desg="Software Engineer",
                         gender=gender_female, doj="2022-01-10", source_idx=2, l1=head, tier="ic")
        await create_emp(first="Vikram", last="Shah", dept="Engineering", desg="QA Engineer",
                         gender=gender_male, doj="2022-06-01", source_idx=0, l1=head, tier="ic")

        # Operations — lead (Administrator) + 2 executives
        ops_lead = await create_emp(first="Sneha", last="Joshi", dept="Operations", desg="Operations Lead",
                                    gender=gender_female, doj="2020-09-01", source_idx=1,
                                    l1=head, tier="manager", role="Administrator")
        await create_emp(first="Arjun", last="Desai", dept="Operations", desg="Operations Executive",
                         gender=gender_male, doj="2021-11-01", source_idx=2, l1=ops_lead, l2=head, tier="ic")
        await create_emp(first="Divya", last="Menon", dept="Operations", desg="Operations Executive",
                         gender=gender_female, doj="2022-03-15", source_idx=0, l1=ops_lead, l2=head, tier="ic")

        # People & Culture — HR manager (Administrator) + HR executive
        hr_mgr = await create_emp(first="Neha", last="Gupta", dept="People & Culture", desg="HR Manager",
                                  gender=gender_female, doj="2020-06-01", source_idx=1,
                                  l1=head, tier="manager", role="Administrator")
        await create_emp(first="Rahul", last="Verma", dept="People & Culture", desg="HR Executive",
                         gender=gender_male, doj="2021-05-01", source_idx=2, l1=hr_mgr, l2=head, tier="ic")

        # ── 11. Assign heads ─────────────────────────────────────────────
        print("\nAssigning heads...")
        await _put(http, f"/organisations/{org_id}", oa_token, {"head_user_id": head})
        await _put(http, f"/business-units/{bu_id}", oa_token, {"head_user_id": head})
        await _put(http, f"/departments/{depts['Engineering']}", oa_token, {"departmentHead": head})
        await _put(http, f"/departments/{depts['Operations']}", oa_token, {"departmentHead": ops_lead})
        await _put(http, f"/departments/{depts['People & Culture']}", oa_token, {"departmentHead": hr_mgr})
        print("  Org / BU / department heads assigned")

    # ── 12. Activate all employees + set passwords (direct DB) ───────────
    print("\nActivating employees & setting passwords...")
    now = datetime.now(timezone.utc)
    pw_hash = get_password_hash(EMP_PASSWORD)
    for email, uid in user_ids.items():
        user = await UserDocument.find_one(UserDocument.id == PydanticObjectId(uid))
        if user:
            user.status = StatusEnum.ACTIVE
            user.password_hash = pw_hash
            user.password_changed_at = now
            await user.save()
    print(f"  {len(user_ids)} employees activated with password {EMP_PASSWORD}")

    # ── Summary ──────────────────────────────────────────────────────────
    print()
    print("=" * 65)
    print(f"  SEED COMPLETE (via API) — {ORG_NAME}")
    print("=" * 65)
    print()
    print(f"  Org ID:           {org_id}")
    print("  Business Units:   1  (Brightwave HQ)")
    print("  Departments:      3  (Engineering, Operations, People & Culture)")
    print("  Designations:     7")
    print("  Bands:            2")
    print("  Pay Grades:       1")
    print("  Role Policies:    2  (Administrator / Employee)")
    print(f"  Employees:       {len(user_ids)}")
    print()
    print("  ─── LOGIN CREDENTIALS ───")
    print(f"    Super Admin:  {SUPERADMIN_EMAIL} / {SUPERADMIN_PASSWORD}")
    print(f"    Org Admin:    {ORG_ADMIN_EMAIL} / {ORG_ADMIN_PASSWORD}")
    print(f"    All Employees: <email> / {EMP_PASSWORD}  (status=ACTIVE)")
    print()
    print("  EMPLOYEE EMAILS:")
    for email in sorted(user_ids.keys()):
        print(f"    {email}")
    print()
    print("  RabbitMQ events fired for all entities")
    print("=" * 65)

    mongo_client.close()


if __name__ == "__main__":
    asyncio.run(seed())
