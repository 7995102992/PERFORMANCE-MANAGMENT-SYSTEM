"""Full organisation seeding via REST API.

Calls the actual API endpoints so RabbitMQ events fire and all downstream
microservices (leave, timesheet, service-request, etc.) pick up the data.

Flow:
  1. Login as super admin → get token
  2. Create org via /super-admin/organisations (creates org + org admin)
  3. Login as org admin → get org-scoped token
  4. Create BUs, Depts, Designations, Bands, Pay Grades, Policies, Employees
  5. Assign heads (org, BU, dept)
  6. Activate all employees + set passwords via direct DB update

Prerequisites:
    - IAM Admin BE running at BASE_URL (default http://localhost:8000)
    - seed_master_data, seed_lookups, seed_superadmin already run

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.seed_org_via_api

    # Custom base URL:
    BASE_URL=http://localhost:8001 python -m scripts.seed_org_via_api

Credentials after seeding:
    Super Admin:  sethunarayanan.valaparambil@sagarsoft.in / SuperAdmin@2026
    Org Admin:    orgadmin@yopmail.com / test@123
    All Employees: <work_email> / test@123  (activated via DB)
"""

import asyncio
import os
import sys
from datetime import date, datetime, timezone

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
ORG_ADMIN_EMAIL = "orgadmin@yopmail.com"
ORG_ADMIN_PASSWORD = "test@123"
ORG_NAME = "NexaGen Solutions Pvt Ltd"
EMP_PASSWORD = "test@123"


# ── Helpers ──────────────────────────────────────────────────────────────────

def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def _login(client: httpx.AsyncClient, email: str, password: str, *, portal: bool = False) -> str:
    url = f"{BASE_URL}/auth/{'portal/login' if portal else 'login'}"
    r = await client.post(url, json={"email": email, "password": password})
    if r.status_code != 200:
        print(f"  LOGIN FAILED ({email}): {r.status_code} {r.text}")
        sys.exit(1)
    token = r.json()["access_token"]
    return token


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


async def _get(client: httpx.AsyncClient, path: str, token: str) -> dict | list:
    r = await client.get(f"{BASE_URL}{path}", headers=_hdr(token))
    if r.status_code != 200:
        print(f"  GET {path} FAILED: {r.status_code}")
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


# ── Main ─────────────────────────────────────────────────────────────────────

async def seed():
    # Init Beanie just for master_data lookups + final DB password update
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

    # ── Clean up previous seed run (if any) ──────────────────────────
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
    btype_product = await _md_id("BUSINESS_TYPES", "product-based")
    bnature_saas = await _md_id("BUSINESS_NATURES", "b2b-saas")
    bnature_custom = await _md_id("BUSINESS_NATURES", "custom-software")

    cl_leadership = await _md_id("CLASS_LABELS", "leadership")
    cl_senior = await _md_id("CLASS_LABELS", "senior-level")
    cl_mid = await _md_id("CLASS_LABELS", "mid-level")
    cl_junior = await _md_id("CLASS_LABELS", "junior-level")
    cl_intern = await _md_id("CLASS_LABELS", "intern")
    cl_billable = await _md_id("CLASS_LABELS", "billable")

    freq_monthly = await _md_id("FREQUENCIES", "monthly")

    et_fulltime = await _md_id("EMPLOYMENT_TYPES", "full-time")
    es_active = await _md_id("EMPLOYMENT_STATUSES", "permanent")
    ps_allocated = await _md_id("PROJECT_STATUSES", "allocated-to-project")

    soh_linkedin = await _md_id("SOURCES_OF_HIRE", "linkedin")
    soh_referral = await _md_id("SOURCES_OF_HIRE", "employee-referral")
    soh_campus = await _md_id("SOURCES_OF_HIRE", "campus-hiring")

    gender_male = await _md_id("GENDERS", "male")
    gender_female = await _md_id("GENDERS", "female")

    async with httpx.AsyncClient(timeout=TIMEOUT) as http:

        # ── 1. Login as super admin ──────────────────────────────────────
        print("Logging in as super admin...")
        sa_token = await _login(http, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, portal=True)
        print("  OK")

        # ── 2. Create org via super-admin endpoint ───────────────────────
        print("Creating organisation via API...")
        org_resp = await _post(http, "/super-admin/organisations", sa_token, {
            "legal_name": ORG_NAME,
            "is_multiple_business_units": True,
            "is_active": True,
            "setup_status": "active",
            "enabled_modules": [
                {"code": "core_hr", "is_active": True},
                {"code": "leave_management", "is_active": True},
                {"code": "service_request", "is_active": True},
                {"code": "timesheet_management", "is_active": True},
                {"code": "reports_and_analytics", "is_active": True},
            ],
            "administrator": {
                "name": "Vikram Mehta",
                "email": ORG_ADMIN_EMAIL,
            },
            "send_activation": False,
        })
        org_id = org_resp["id"]
        print(f"  Org: {org_resp['legal_name']} (id={org_id})")

        # Activate org admin + set password directly in DB
        admin_user = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL)
        if admin_user:
            admin_user.password_hash = get_password_hash(ORG_ADMIN_PASSWORD)
            admin_user.status = StatusEnum.ACTIVE
            admin_user.password_changed_at = datetime.now(timezone.utc)
            await admin_user.save()
            print(f"  Org Admin activated: {ORG_ADMIN_EMAIL} / {ORG_ADMIN_PASSWORD}")

        # ── 3. Login as org admin ────────────────────────────────────────
        print("Logging in as org admin...")
        oa_token = await _login(http, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD)
        print("  OK")

        # ── 4. Update org with address + details ─────────────────────────
        print("Updating organisation details...")
        await _put(http, f"/organisations/{org_id}", oa_token, {
            "address": {
                "country": "India",
                "state": "Telangana",
                "city": "Hyderabad",
                "zip_code": "500081",
                "address_line_1": "Tower B, Raheja Mindspace",
                "address_line_2": "HITEC City, Madhapur",
            },
            "date_of_incorporation": "2016-07-01",
            "financial_year": "April - March",
            "currency": "INR",
            "timezone": "Asia/Kolkata",
        })
        print("  OK")

        # ── 5. Business Units (3) ────────────────────────────────────────
        print("Creating business units...")
        # empCodeStartFrom is required by BusinessUnitCreate. It is the FIRST
        # emp code per type (digit string; a leading zero sets the zero-pad
        # width). "1" → codes like PREFIX-F-1, PREFIX-F-2, … with no padding.
        code_start = {"fullTime": "1", "contract": "1", "internship": "1"}
        bu_data = [
            {
                "business_unit_name": "Digital Engineering",
                "emp_code_prefix": "DEN",
                "empCodeStartFrom": code_start,
                "sector": sector_it, "type_of_business": btype_service,
                "nature_of_business": bnature_custom,
                "address": {
                    "country": "India", "state": "Telangana", "city": "Hyderabad",
                    "zip_code": "500081", "address_line_1": "Wing A, Raheja Mindspace",
                },
            },
            {
                "business_unit_name": "SaaS Products",
                "emp_code_prefix": "SPD",
                "empCodeStartFrom": code_start,
                "sector": sector_it, "type_of_business": btype_product,
                "nature_of_business": bnature_saas,
                "address": {
                    "country": "India", "state": "Karnataka", "city": "Bangalore",
                    "zip_code": "560103", "address_line_1": "Block C, Prestige Tech Park",
                },
            },
            {
                "business_unit_name": "Enterprise Solutions",
                "emp_code_prefix": "ESL",
                "empCodeStartFrom": code_start,
                "sector": sector_it, "type_of_business": btype_service,
                "nature_of_business": bnature_custom,
                "address": {
                    "country": "India", "state": "Maharashtra", "city": "Pune",
                    "zip_code": "411057", "address_line_1": "Level 4, ICC Trade Tower",
                },
            },
        ]

        bus = {}
        for bd in bu_data:
            resp = await _post(http, "/business-units/", oa_token, {
                **bd,
                "date_of_incorporation": "2016-07-01T00:00:00",
                "financial_year": "April - March",
                "currency": "INR",
                "time_zone": "Asia/Kolkata",
                "time_format": "24hr",
            })
            bus[bd["business_unit_name"]] = resp["id"]
            print(f"  BU: {bd['business_unit_name']} ({bd['emp_code_prefix']})")

        bu_den = bus["Digital Engineering"]
        bu_spd = bus["SaaS Products"]
        bu_esl = bus["Enterprise Solutions"]

        # ── 6. Departments (6) ───────────────────────────────────────────
        # NOTE: primaryBusinessUnit is required when a department spans
        # multiple BUs; single-BU depts have it auto-set server-side.
        print("Creating departments...")
        dept_data = [
            {"departmentName": "Engineering",       "departmentCode": "ENG",  "businessUnits": [bu_den, bu_spd],          "primaryBusinessUnit": bu_den},
            {"departmentName": "Quality Assurance",  "departmentCode": "QA",   "businessUnits": [bu_den, bu_spd],          "primaryBusinessUnit": bu_den},
            {"departmentName": "Human Resources",    "departmentCode": "HR",   "businessUnits": [bu_den, bu_spd, bu_esl], "primaryBusinessUnit": bu_esl},
            {"departmentName": "Finance & Accounts", "departmentCode": "FIN",  "businessUnits": [bu_esl]},
            {"departmentName": "Product Management", "departmentCode": "PM",   "businessUnits": [bu_spd]},
            {"departmentName": "DevOps & Infra",     "departmentCode": "DOPS", "businessUnits": [bu_den, bu_spd],          "primaryBusinessUnit": bu_den},
        ]

        depts = {}
        for dd in dept_data:
            resp = await _post(http, "/departments/", oa_token, dd)
            depts[dd["departmentName"]] = resp["id"]
            print(f"  Dept: {dd['departmentName']} ({dd['departmentCode']})")

        # ── 7. Designations (12) ─────────────────────────────────────────
        # Flat org-level job titles now (no department, hierarchy, or owned
        # policy). Roles are created separately (§10) and assigned directly to
        # employees via roleIds.
        print("Creating designations...")
        desg_data = [
            "CTO", "VP Engineering", "Engineering Manager", "Senior Software Engineer",
            "Software Engineer", "QA Lead", "QA Engineer", "HR Director", "HR Executive",
            "Finance Manager", "Product Manager", "DevOps Engineer",
        ]

        desgs = {}
        for name in desg_data:
            resp = await _post(http, "/designations/", oa_token, {"designationName": name})
            desgs[name] = resp["id"]
            print(f"  Desg: {name}")

        # ── 8. Bands (6) ─────────────────────────────────────────────────
        print("Creating bands...")
        band_data = [
            {"name": "Band L1 - Leadership",  "classLabel": cl_leadership, "minAmount": 200000, "maxAmount": 500000},
            {"name": "Band L2 - Senior Mgmt", "classLabel": cl_senior,     "minAmount": 120000, "maxAmount": 250000},
            {"name": "Band M1 - Management",  "classLabel": cl_mid,        "minAmount": 80000,  "maxAmount": 150000},
            {"name": "Band S1 - Senior IC",   "classLabel": cl_billable,   "minAmount": 60000,  "maxAmount": 120000},
            {"name": "Band J1 - Junior IC",   "classLabel": cl_junior,     "minAmount": 30000,  "maxAmount": 70000},
            {"name": "Band I1 - Intern",      "classLabel": cl_intern,     "minAmount": 15000,  "maxAmount": 30000},
        ]

        bands = {}
        for bd in band_data:
            # effective_to must be strictly after effective_from when set.
            # Intern band gets an explicit window to exercise that validator.
            payload = {
                **bd,
                "frequency": freq_monthly,
                "currency": "INR",
                "effectiveFrom": "2025-04-01",
            }
            if bd["name"] == "Band I1 - Intern":
                payload["effectiveTo"] = "2026-03-31"
            resp = await _post(http, "/bands/", oa_token, payload)
            bands[bd["name"]] = resp["id"]
            print(f"  Band: {bd['name']}")

        # ── 9. Pay Grades (3) ────────────────────────────────────────────
        # The pay-grade ↔ designation link now lives on the DESIGNATION
        # (designation.pay_grade_ids), not on the pay grade. Pay grades are
        # created with bands only, then attached to their designations below.
        print("Creating pay grades...")
        pg_data = [
            {
                "name": "Executive Grade",
                "description": "CXO and Leadership roles",
                "bandIds": [bands["Band L1 - Leadership"], bands["Band L2 - Senior Mgmt"]],
            },
            {
                "name": "Management Grade",
                "description": "Manager-level roles",
                "bandIds": [bands["Band M1 - Management"], bands["Band S1 - Senior IC"]],
            },
            {
                "name": "Individual Contributor Grade",
                "description": "Engineers, analysts, and support roles",
                "bandIds": [bands["Band J1 - Junior IC"], bands["Band I1 - Intern"]],
            },
        ]

        pgs = {}
        for pgd in pg_data:
            resp = await _post(http, "/paygrades/", oa_token, pgd)
            pgs[pgd["name"]] = resp["id"]
            print(f"  PayGrade: {pgd['name']}")

        # Attach each pay grade to its designations (link stored on the designation).
        pg_by_desg = {
            "CTO": "Executive Grade",
            "VP Engineering": "Executive Grade",
            "HR Director": "Executive Grade",
            "Engineering Manager": "Management Grade",
            "QA Lead": "Management Grade",
            "Finance Manager": "Management Grade",
            "Product Manager": "Management Grade",
            "Senior Software Engineer": "Individual Contributor Grade",
            "Software Engineer": "Individual Contributor Grade",
            "QA Engineer": "Individual Contributor Grade",
            "HR Executive": "Individual Contributor Grade",
            "DevOps Engineer": "Individual Contributor Grade",
        }
        print("Linking pay grades to designations...")
        for desg_name, pg_name in pg_by_desg.items():
            pg_id = pgs.get(pg_name)
            if pg_id and desgs.get(desg_name):
                await _put(http, f"/designations/{desgs[desg_name]}", oa_token,
                           {"payGradeIds": [pg_id]})
        print("  Pay grades linked to designations")

        # ── 10. Policies (2) with permission grids ───────────────────────
        print("Creating policies...")

        admin_grid = {
            "core_hr": {"admin": {
                "create_resource": True, "apply_exit_request": True,
                "approve_exit_request": True, "monitor_exit_request": True,
                "it_clearances": True, "admin_clearances": True, "final_settlement": True,
            }, "editor": {}, "viewer": {}},
            "leave_management": {"admin": {
                "holiday_plan": True, "leave_plan": True, "work_calendar": True,
                "leave_configuration": True, "leave_types": True, "leave_request": True,
                "manage_leave_request": True, "leave_balance": True, "approve_as_hr": True,
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
            "reports_and_analytics": {"admin": {"reports": True}, "editor": {}, "viewer": {}},
        }

        pol_admin_resp = await _post(http, "/policies", oa_token, {
            "name": "Admin Full Access",
            "is_role": True,
            "is_active": True,
            "organisation_id": org_id,
            "seed_module_codes": ["core_hr", "leave_management", "service_request", "timesheet_management", "reports_and_analytics"],
            "permissions": admin_grid,
        })
        pol_admin_id = pol_admin_resp["id"]
        print(f"  Policy: Admin Full Access (id={pol_admin_id})")

        emp_grid = {
            "core_hr": {"admin": {}, "editor": {}, "viewer": {"apply_exit_request": True}},
            "leave_management": {"admin": {}, "editor": {}, "viewer": {"leave_request": True, "leave_balance": True}},
            # ICs handle requests routed to their own department (the
            # "Employee Requests" queue): manage_request to see/self-assign the
            # dept queue, execute_request to actually work the ticket (first
            # response, submit-for-approval, resolve). Both at editor acl so
            # is_manager() recognises them as dept-request handlers in SRM.
            "service_request": {"admin": {}, "editor": {"manage_request": True, "execute_request": True}, "viewer": {"raise_request": True}},
            "timesheet_management": {"admin": {}, "editor": {}, "viewer": {"my_timesheet": True}},
            "reports_and_analytics": {"admin": {}, "editor": {}, "viewer": {"reports": True}},
        }
        pol_emp_resp = await _post(http, "/policies", oa_token, {
            "name": "Employee Basic",
            "is_role": True,
            "is_active": True,
            "organisation_id": org_id,
            "seed_module_codes": ["core_hr", "leave_management", "service_request", "timesheet_management", "reports_and_analytics"],
            "permissions": emp_grid,
        })
        pol_emp_id = pol_emp_resp["id"]
        print(f"  Policy: Employee Basic (id={pol_emp_id})")

        # ── 11. Employees (15) ───────────────────────────────────────────
        print("Creating employees...")

        # CTC bands per tier (INR / month) — encrypted server-side.
        ctc_by_tier = {
            "cxo": 450000.0,
            "leadership": 300000.0,
            "manager": 180000.0,
            "ic": 90000.0,
        }

        def _emp(*, email, first, last, bu_id, dept, desg, gender, doj, source,
                 l1=None, l2=None, policy_ids=None, tier="ic"):
            return {
                "workEmail": email,
                "firstName": first,
                "lastName": last,
                "businessUnitId": bu_id,
                "departmentId": depts[dept],
                "designationId": desgs[desg],
                "gender": gender,
                "dateOfJoining": doj,
                "sourceOfHire": source,
                "l1ManagerId": l1,
                "l2ManagerId": l2,
                "employmentType": et_fulltime,
                "employmentStatus": es_active,
                "projectStatus": ps_allocated,
                "ctc": ctc_by_tier.get(tier, ctc_by_tier["ic"]),
                "currency": "INR",
                # Roles assigned directly to the employee (schema alias is roleIds).
                "roleIds": policy_ids or [pol_emp_id],
                "emergencyContacts": [
                    {"contactName": f"{first} Emergency", "contactNumber": "+91-9876543210", "relationship": "Spouse"}
                ],
            }

        user_ids = {}

        # --- CXO (no managers required) ---
        cto_payload = _emp(email="arvind.krishnan@yopmail.com", first="Arvind", last="Krishnan",
                           bu_id=bu_den, dept="Engineering", desg="CTO",
                           gender=gender_male, doj="2016-07-01", source=soh_linkedin,
                           policy_ids=[pol_admin_id], tier="cxo")
        resp = await _post(http, "/employees/", oa_token, cto_payload)
        cto_uid = resp.get("userId") or resp.get("user_id")
        user_ids[cto_payload["workEmail"]] = cto_uid
        code = resp.get("empCode") or resp.get("emp_code", "")
        print(f"  {code} | Arvind Krishnan <arvind.krishnan@yopmail.com>")

        # --- Leadership (L1 = CTO) ---
        leadership = [
            _emp(email="lakshmi.venkat@yopmail.com", first="Lakshmi", last="Venkataraman",
                 bu_id=bu_spd, dept="Engineering", desg="VP Engineering",
                 gender=gender_female, doj="2017-03-15", source=soh_linkedin,
                 l1=cto_uid, policy_ids=[pol_admin_id], tier="leadership"),

            _emp(email="sunita.mohan@yopmail.com", first="Sunita", last="Mohan",
                 bu_id=bu_esl, dept="Human Resources", desg="HR Director",
                 gender=gender_female, doj="2017-06-01", source=soh_linkedin,
                 l1=cto_uid, policy_ids=[pol_admin_id], tier="leadership"),
        ]

        for emp_payload in leadership:
            resp = await _post(http, "/employees/", oa_token, emp_payload)
            uid = resp.get("userId") or resp.get("user_id")
            user_ids[emp_payload["workEmail"]] = uid
            code = resp.get("empCode") or resp.get("emp_code", "")
            print(f"  {code} | {emp_payload['firstName']} {emp_payload['lastName']} <{emp_payload['workEmail']}>")

        vpe_uid = user_ids["lakshmi.venkat@yopmail.com"]
        hrd_uid = user_ids["sunita.mohan@yopmail.com"]

        # --- Managers (need L1 + L2) — admin policy ---
        managers = [
            _emp(email="ramesh.pillai@yopmail.com", first="Ramesh", last="Pillai",
                 bu_id=bu_den, dept="Engineering", desg="Engineering Manager",
                 gender=gender_male, doj="2018-01-10", source=soh_referral,
                 l1=vpe_uid, l2=cto_uid, policy_ids=[pol_admin_id], tier="manager"),

            _emp(email="divya.narayan@yopmail.com", first="Divya", last="Narayan",
                 bu_id=bu_spd, dept="Engineering", desg="Engineering Manager",
                 gender=gender_female, doj="2018-09-01", source=soh_linkedin,
                 l1=vpe_uid, l2=cto_uid, policy_ids=[pol_admin_id], tier="manager"),

            _emp(email="manoj.tiwari@yopmail.com", first="Manoj", last="Tiwari",
                 bu_id=bu_den, dept="Quality Assurance", desg="QA Lead",
                 gender=gender_male, doj="2019-02-15", source=soh_referral,
                 l1=vpe_uid, l2=cto_uid, policy_ids=[pol_admin_id], tier="manager"),

            _emp(email="swathi.bhat@yopmail.com", first="Swathi", last="Bhat",
                 bu_id=bu_esl, dept="Finance & Accounts", desg="Finance Manager",
                 gender=gender_female, doj="2018-05-01", source=soh_linkedin,
                 l1=hrd_uid, l2=cto_uid, policy_ids=[pol_admin_id], tier="manager"),

            _emp(email="nitin.saxena@yopmail.com", first="Nitin", last="Saxena",
                 bu_id=bu_spd, dept="Product Management", desg="Product Manager",
                 gender=gender_male, doj="2019-08-01", source=soh_linkedin,
                 l1=vpe_uid, l2=cto_uid, policy_ids=[pol_admin_id], tier="manager"),
        ]

        for emp_payload in managers:
            resp = await _post(http, "/employees/", oa_token, emp_payload)
            uid = resp.get("userId") or resp.get("user_id")
            user_ids[emp_payload["workEmail"]] = uid
            code = resp.get("empCode") or resp.get("emp_code", "")
            print(f"  {code} | {emp_payload['firstName']} {emp_payload['lastName']} <{emp_payload['workEmail']}>")

        em1_uid = user_ids["ramesh.pillai@yopmail.com"]
        em2_uid = user_ids["divya.narayan@yopmail.com"]
        qal_uid = user_ids["manoj.tiwari@yopmail.com"]

        # --- Individual Contributors (L1 + L2 required) — basic policy ---
        ics = [
            _emp(email="harini.das@yopmail.com", first="Harini", last="Das",
                 bu_id=bu_den, dept="Engineering", desg="Senior Software Engineer",
                 gender=gender_female, doj="2020-01-10", source=soh_referral,
                 l1=em1_uid, l2=vpe_uid),

            _emp(email="siddharth.jain@yopmail.com", first="Siddharth", last="Jain",
                 bu_id=bu_den, dept="Engineering", desg="Software Engineer",
                 gender=gender_male, doj="2021-06-01", source=soh_campus,
                 l1=em1_uid, l2=vpe_uid),

            _emp(email="tanvi.kulkarni@yopmail.com", first="Tanvi", last="Kulkarni",
                 bu_id=bu_spd, dept="Engineering", desg="Software Engineer",
                 gender=gender_female, doj="2021-09-15", source=soh_campus,
                 l1=em2_uid, l2=vpe_uid),

            _emp(email="aditya.pandey@yopmail.com", first="Aditya", last="Pandey",
                 bu_id=bu_den, dept="Quality Assurance", desg="QA Engineer",
                 gender=gender_male, doj="2020-11-01", source=soh_linkedin,
                 l1=qal_uid, l2=vpe_uid),

            _emp(email="megha.srinivasan@yopmail.com", first="Megha", last="Srinivasan",
                 bu_id=bu_esl, dept="Human Resources", desg="HR Executive",
                 gender=gender_female, doj="2021-04-01", source=soh_referral,
                 l1=hrd_uid, l2=cto_uid),

            _emp(email="prasad.gowda@yopmail.com", first="Prasad", last="Gowda",
                 bu_id=bu_spd, dept="DevOps & Infra", desg="DevOps Engineer",
                 gender=gender_male, doj="2021-01-01", source=soh_linkedin,
                 l1=em2_uid, l2=vpe_uid),

            _emp(email="nandini.rao@yopmail.com", first="Nandini", last="Rao",
                 bu_id=bu_den, dept="Engineering", desg="Software Engineer",
                 gender=gender_female, doj="2022-03-01", source=soh_campus,
                 l1=em1_uid, l2=vpe_uid),
        ]

        for emp_payload in ics:
            resp = await _post(http, "/employees/", oa_token, emp_payload)
            uid = resp.get("userId") or resp.get("user_id")
            user_ids[emp_payload["workEmail"]] = uid
            code = resp.get("empCode") or resp.get("emp_code", "")
            print(f"  {code} | {emp_payload['firstName']} {emp_payload['lastName']} <{emp_payload['workEmail']}>")

        # ── 12. Assign Heads ─────────────────────────────────────────────
        print("Assigning heads...")

        await _put(http, f"/organisations/{org_id}", oa_token, {"head_user_id": cto_uid})
        print("  Org Head: Arvind Krishnan (CTO)")

        await _put(http, f"/business-units/{bu_den}", oa_token, {"head_user_id": em1_uid})
        print("  BU Head (Digital Engineering): Ramesh Pillai")
        await _put(http, f"/business-units/{bu_spd}", oa_token, {"head_user_id": vpe_uid})
        print("  BU Head (SaaS Products): Lakshmi Venkataraman")
        await _put(http, f"/business-units/{bu_esl}", oa_token, {"head_user_id": hrd_uid})
        print("  BU Head (Enterprise Solutions): Sunita Mohan")

        fm_uid = user_ids["swathi.bhat@yopmail.com"]
        pm_uid = user_ids["nitin.saxena@yopmail.com"]
        await _put(http, f"/departments/{depts['Engineering']}", oa_token, {"departmentHead": vpe_uid})
        await _put(http, f"/departments/{depts['Quality Assurance']}", oa_token, {"departmentHead": qal_uid})
        await _put(http, f"/departments/{depts['Human Resources']}", oa_token, {"departmentHead": hrd_uid})
        await _put(http, f"/departments/{depts['Finance & Accounts']}", oa_token, {"departmentHead": fm_uid})
        await _put(http, f"/departments/{depts['Product Management']}", oa_token, {"departmentHead": pm_uid})
        await _put(http, f"/departments/{depts['DevOps & Infra']}", oa_token, {"departmentHead": em2_uid})
        print("  Department heads assigned")

    # ── 13. Activate all employees + set password (direct DB) ────────────
    print("Activating all employees & setting passwords...")
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
    print("  Business Units:   3  (Digital Engineering, SaaS Products, Enterprise Solutions)")
    print("  Departments:      6")
    print("  Designations:    12")
    print("  Bands:            6")
    print("  Pay Grades:       3")
    print("  Policies:         2  (Admin Full Access + Employee Basic)")
    print(f"  Employees:       {len(user_ids)}  (8 admin, {len(user_ids)-8} viewer)")
    print()
    print("  ─── LOGIN CREDENTIALS ───")
    print()
    print("  SUPER ADMIN (Admin Portal)")
    print(f"    Email:    {SUPERADMIN_EMAIL}")
    print(f"    Password: {SUPERADMIN_PASSWORD}")
    print()
    print("  ORG ADMIN (Tenant Login)")
    print(f"    Email:    {ORG_ADMIN_EMAIL}")
    print(f"    Password: {ORG_ADMIN_PASSWORD}")
    print()
    print("  ALL EMPLOYEES")
    print(f"    Password: {EMP_PASSWORD}  (all employees, status=ACTIVE)")
    print()
    print("  EMPLOYEE EMAILS:")
    for email in sorted(user_ids.keys()):
        print(f"    {email}")
    print()
    print("  RabbitMQ events fired for all entities")
    print("  Downstream services will auto-sync")
    print("=" * 65)

    mongo_client.close()


if __name__ == "__main__":
    asyncio.run(seed())
