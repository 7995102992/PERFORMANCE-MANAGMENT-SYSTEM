"""Large organisation seeding via REST API (~75 employees, 10-15 per dept).

Calls actual API endpoints so RabbitMQ events fire and all downstream
microservices (leave, timesheet, service-request, etc.) pick up the data.

Structure:
  - 1 Organisation: "Zenith Digital Pvt Ltd"
  - 3 Business Units
  - 6 Departments (10-15 employees each)
  - 15 Designations (flat org-level job titles, linked to pay grades)
  - 6 Bands, 3 Pay Grades
  - 3 Role policies (Administrator / Manager / Employee), assigned directly to employees
  - ~75 Employees with full L1/L2 manager hierarchy
  - Org head, BU heads, Dept heads assigned

Prerequisites:
    - IAM Admin BE running at BASE_URL (default http://localhost:8000)
    - seed_master_data, seed_lookups, seed_superadmin already run

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.seed_org_large_via_api

Credentials after seeding:
    Super Admin:  admin@sagarsoft.in / SuperAdmin@2026
    Org Admin:    orgadmin.zenith@yopmail.com / test@123
    All Employees: <work_email> / test@123  (active employees only)
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

SUPERADMIN_EMAIL = "admin@sagarsoft.in"
SUPERADMIN_PASSWORD = "SuperAdmin@2026"
ORG_ADMIN_EMAIL = "orgadmin.zenith@yopmail.com"
ORG_ADMIN_PASSWORD = "test@123"
ORG_NAME = "Zenith Digital Pvt Ltd"
EMP_PASSWORD = "test@123"
DOMAIN = "yopmail.com"


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


async def _post(client: httpx.AsyncClient, path: str, token: str, body: dict, *, optional: bool = False) -> dict:
    r = await client.post(f"{BASE_URL}{path}", headers=_hdr(token), json=body)
    if r.status_code not in (200, 201):
        print(f"  POST {path} FAILED: {r.status_code}")
        print(f"    {r.text[:500]}")
        if optional:
            return {}
        sys.exit(1)
    return r.json()


async def _put(client: httpx.AsyncClient, path: str, token: str, body: dict) -> dict:
    r = await client.put(f"{BASE_URL}{path}", headers=_hdr(token), json=body)
    if r.status_code not in (200, 201):
        print(f"  PUT {path} FAILED: {r.status_code}")
        print(f"    {r.text[:500]}")
        sys.exit(1)
    return r.json()


async def _md_id(category: str, key: str, *, any_status: bool = False) -> str:
    filters = [MasterDataDocument.category == category, MasterDataDocument.key == key]
    if not any_status:
        filters.append(MasterDataDocument.is_active == True)  # noqa: E712
    doc = await MasterDataDocument.find_one(*filters)
    if not doc:
        raise RuntimeError(f"Master data not found: {category}/{key}. Run seed_master_data first.")
    return str(doc.id)


def _email(first: str, last: str) -> str:
    return f"{first.lower()}.{last.lower().replace(' ', '')}@{DOMAIN}"


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

    # ── Cleanup ──────────────────────────────────────────────────────────
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
    et_contract = await _md_id("EMPLOYMENT_TYPES", "contract")
    et_intern = await _md_id("EMPLOYMENT_TYPES", "internship")

    # Employment statuses (lifecycle). NOTE: allocated-to-project / bench /
    # long-leave were moved to the new PROJECT_STATUSES category, so they're
    # resolved separately below and assigned to project_status (not employment).
    es_absconded = await _md_id("EMPLOYMENT_STATUSES", "absconded", any_status=True)
    es_notice = await _md_id("EMPLOYMENT_STATUSES", "notice-period")
    es_probation = await _md_id("EMPLOYMENT_STATUSES", "probation")
    es_permanent = await _md_id("EMPLOYMENT_STATUSES", "permanent")
    es_exit = await _md_id("EMPLOYMENT_STATUSES", "exit", any_status=True)
    es_retired = await _md_id("EMPLOYMENT_STATUSES", "retired", any_status=True)
    es_terminated = await _md_id("EMPLOYMENT_STATUSES", "terminated", any_status=True)

    # Project / allocation statuses (independent of employment lifecycle).
    ps_allocated = await _md_id("PROJECT_STATUSES", "allocated-to-project")
    ps_bench = await _md_id("PROJECT_STATUSES", "bench")
    ps_long_leave = await _md_id("PROJECT_STATUSES", "long-leave")
    project_status_ids = {ps_allocated, ps_bench, ps_long_leave}

    soh_linkedin = await _md_id("SOURCES_OF_HIRE", "linkedin")
    soh_referral = await _md_id("SOURCES_OF_HIRE", "employee-referral")
    soh_campus = await _md_id("SOURCES_OF_HIRE", "campus-hiring")

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
            "administrator": {"name": "Raghav Kapoor", "email": ORG_ADMIN_EMAIL},
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
                "zip_code": "500032", "address_line_1": "Floor 8, Salarpuria Sattva",
                "address_line_2": "Gachibowli",
            },
            "date_of_incorporation": "2017-01-15",
            "financial_year": "April - March",
            "currency": "INR",
            "timezone": "Asia/Kolkata",
        })
        print("  Org details updated")

        # ── 5. Business Units (3) ────────────────────────────────────────
        print("Creating business units...")
        # empCodeStartFrom is required by BusinessUnitCreate. It is the FIRST
        # emp code per type (digit string; a leading zero sets the zero-pad
        # width). "1" → codes like PREFIX-F-1, PREFIX-F-2, … with no padding.
        code_start = {"fullTime": "1", "contract": "1", "internship": "1"}
        bu_data = [
            {
                "business_unit_name": "Core Engineering",
                "emp_code_prefix": "CEN",
                "empCodeStartFrom": code_start,
                "sector": sector_it, "type_of_business": btype_service,
                "nature_of_business": bnature_custom,
                "address": {
                    "country": "India", "state": "Telangana", "city": "Hyderabad",
                    "zip_code": "500032", "address_line_1": "Wing A, Salarpuria Sattva",
                },
            },
            {
                "business_unit_name": "Product Division",
                "emp_code_prefix": "PDV",
                "empCodeStartFrom": code_start,
                "sector": sector_it, "type_of_business": btype_product,
                "nature_of_business": bnature_saas,
                "address": {
                    "country": "India", "state": "Karnataka", "city": "Bangalore",
                    "zip_code": "560066", "address_line_1": "Tower 2, Embassy TechVillage",
                },
            },
            {
                "business_unit_name": "Shared Services",
                "emp_code_prefix": "SSH",
                "empCodeStartFrom": code_start,
                "sector": sector_it, "type_of_business": btype_service,
                "nature_of_business": bnature_custom,
                "address": {
                    "country": "India", "state": "Maharashtra", "city": "Pune",
                    "zip_code": "411014", "address_line_1": "Level 3, Kharadi IT Park",
                },
            },
        ]

        bus = {}
        for bd in bu_data:
            resp = await _post(http, "/business-units/", oa_token, {
                **bd,
                "date_of_incorporation": "2017-01-15T00:00:00",
                "financial_year": "April - March",
                "currency": "INR",
                "time_zone": "Asia/Kolkata",
                "time_format": "24hr",
            })
            bus[bd["business_unit_name"]] = resp["id"]
            print(f"  BU: {bd['business_unit_name']} ({bd['emp_code_prefix']})")

        bu_cen = bus["Core Engineering"]
        bu_pdv = bus["Product Division"]
        bu_ssh = bus["Shared Services"]

        # ── 6. Departments (6) ───────────────────────────────────────────
        # NOTE: primaryBusinessUnit is required when a department spans
        # multiple business units; it's auto-set for single-BU departments.
        print("Creating departments...")
        dept_data = [
            {"departmentName": "Engineering",       "departmentCode": "ENG",  "businessUnits": [bu_cen, bu_pdv],          "primaryBusinessUnit": bu_cen},
            {"departmentName": "Quality Assurance",  "departmentCode": "QA",   "businessUnits": [bu_cen, bu_pdv],          "primaryBusinessUnit": bu_cen},
            {"departmentName": "Human Resources",    "departmentCode": "HR",   "businessUnits": [bu_cen, bu_pdv, bu_ssh], "primaryBusinessUnit": bu_ssh},
            {"departmentName": "Finance & Accounts", "departmentCode": "FIN",  "businessUnits": [bu_ssh]},
            {"departmentName": "Product Management", "departmentCode": "PM",   "businessUnits": [bu_pdv]},
            {"departmentName": "DevOps & Infra",     "departmentCode": "DOPS", "businessUnits": [bu_cen, bu_pdv],          "primaryBusinessUnit": bu_cen},
        ]

        depts = {}
        for dd in dept_data:
            resp = await _post(http, "/departments/", oa_token, dd)
            depts[dd["departmentName"]] = resp["id"]
            print(f"  Dept: {dd['departmentName']}")

        # ── 7. Roles + Designations ──────────────────────────────────────
        # Roles (is_role=true policies) are standalone now and assigned directly
        # to employees via roleIds — designations no longer own a policy. We
        # create 3 role policies from the grids below, then create flat
        # org-level designations (job titles only).
        #
        # Three grids:
        #   Administrator → full admin on all 4 modules (CXO / leadership)
        #   Manager       → manager subset under the EDITOR acl (SRM is_manager()
        #                   accepts editor/admin; IAM require_any_module_admin stays
        #                   admin-only, so managers aren't full module admins)
        #   Employee      → self-service viewer actions only
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
        mgr_grid = {
            "core_hr": {"admin": {}, "viewer": {}, "editor": {
                "apply_exit_request": True, "approve_exit_request": True,
                "monitor_exit_request": True,
            }},
            "leave_management": {"admin": {}, "viewer": {}, "editor": {
                "leave_request": True, "leave_balance": True, "manage_leave_request": True,
            }},
            "service_request": {"admin": {}, "viewer": {}, "editor": {
                "raise_request": True, "execute_request": True, "approve_request": True,
                "manage_request": True, "view_all_requests": True,
            }},
            "timesheet_management": {"admin": {}, "viewer": {}, "editor": {
                "my_timesheet": True, "manage_timesheet": True, "view_reports": True,
            }},
            "reports_and_analytics": {"admin": {}, "viewer": {}, "editor": {"reports": True}},
        }
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
        # Create the 3 standalone role policies (is_role=true). Each employee is
        # assigned one of these directly via roleIds (see create_emp below).
        print("Creating role policies...")
        roles = {}
        for role_name, grid in (("Administrator", admin_grid), ("Manager", mgr_grid), ("Employee", emp_grid)):
            resp = await _post(http, "/policies", oa_token, {
                "name": role_name, "is_role": True, "is_active": True,
                "organisation_id": org_id, "permissions": grid,
            })
            roles[role_name] = resp["id"]
            print(f"  Role: {role_name} (id={resp['id']})")

        # Employee tier → role policy name (used in create_emp).
        role_by_tier = {
            "cxo": "Administrator", "leadership": "Administrator",
            "manager": "Manager",
            "ic": "Employee", "contract": "Employee", "intern": "Employee",
        }

        # Designations are flat org-level job titles now (no department,
        # hierarchy, or owned policy).
        print("Creating designations...")
        desg_data = [
            "CTO", "VP Engineering", "Engineering Manager", "Senior Software Engineer",
            "Software Engineer", "QA Lead", "QA Engineer", "HR Director", "HR Executive",
            "Finance Manager", "Accounts Executive", "Product Manager", "Business Analyst",
            "DevOps Lead", "DevOps Engineer",
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
            # effective_to validation: must be strictly after effective_from when set.
            # Intern band is given an explicit window to exercise that validator.
            payload = {
                **bd, "frequency": freq_monthly, "currency": "INR", "effectiveFrom": "2025-04-01",
            }
            if bd["name"] == "Band I1 - Intern":
                payload["effectiveTo"] = "2026-03-31"
            resp = await _post(http, "/bands/", oa_token, payload, optional=True)
            bands[bd["name"]] = resp.get("id")
            if resp:
                print(f"  Band: {bd['name']}")

        # ── 9. Pay Grades (3) ────────────────────────────────────────────
        # The pay-grade ↔ designation link now lives on the DESIGNATION
        # (designation.pay_grade_ids), not on the pay grade. So pay grades are
        # created here with bands only, then attached to their designations via
        # an update below.
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
        if all(bands.values()):
            for pgd in pg_data:
                resp = await _post(http, "/paygrades/", oa_token, pgd)
                pgs[pgd["name"]] = resp["id"]
                print(f"  PayGrade: {pgd['name']}")
        else:
            print("  Skipping pay grades (bands failed)")

        # Attach each pay grade to its designations. The link is stored on the
        # designation (pay_grade_ids), so we update the designations here.
        pg_by_desg = {
            "CTO": "Executive Grade",
            "VP Engineering": "Executive Grade",
            "HR Director": "Executive Grade",
            "Engineering Manager": "Management Grade",
            "QA Lead": "Management Grade",
            "Finance Manager": "Management Grade",
            "Product Manager": "Management Grade",
            "DevOps Lead": "Management Grade",
            "Senior Software Engineer": "Individual Contributor Grade",
            "Software Engineer": "Individual Contributor Grade",
            "QA Engineer": "Individual Contributor Grade",
            "HR Executive": "Individual Contributor Grade",
            "Accounts Executive": "Individual Contributor Grade",
            "Business Analyst": "Individual Contributor Grade",
            "DevOps Engineer": "Individual Contributor Grade",
        }
        if pgs:
            print("Linking pay grades to designations...")
            for desg_name, pg_name in pg_by_desg.items():
                pg_id = pgs.get(pg_name)
                if pg_id and desgs.get(desg_name):
                    await _put(http, f"/designations/{desgs[desg_name]}", oa_token,
                               {"payGradeIds": [pg_id]})
            print("  Pay grades linked to designations")

        # ── 10. Roles ────────────────────────────────────────────────────
        # The 3 role policies (Administrator / Manager / Employee) were created
        # in section 7; each employee is assigned one directly via roleIds in
        # create_emp below (mapped from the employee's tier).

        # ── 11. Employees (~75) ──────────────────────────────────────────
        print("\nCreating employees...")
        user_ids = {}
        sources = [soh_linkedin, soh_referral, soh_campus]
        emp_count = 0

        # CTC bands per tier (INR / month) — encrypted server-side.
        # Tier passed by caller via `tier` ("cxo" | "leadership" | "manager" | "ic" | "contract" | "intern").
        ctc_by_tier = {
            "cxo": 450000.0,
            "leadership": 300000.0,
            "manager": 180000.0,
            "ic": 90000.0,
            "contract": 70000.0,
            "intern": 22000.0,
        }

        async def create_emp(*, first, last, bu_id, dept, desg, gender, doj, source_idx=0,
                             l1=None, l2=None, emp_status=None, project_status=None,
                             emp_type=None, tier="ic"):
            nonlocal emp_count
            email = _email(first, last)
            # allocated-to-project / bench / long-leave are PROJECT statuses now.
            # If a row passes one as emp_status, treat it as project_status and
            # keep the employee's employment lifecycle "permanent" (active).
            status_in = emp_status or ps_allocated
            proj = project_status
            if status_in in project_status_ids:
                proj = status_in
                status_in = es_permanent
            payload = {
                "workEmail": email, "firstName": first, "lastName": last,
                "businessUnitId": bu_id,
                "departmentId": depts[dept], "designationId": desgs[desg],
                "gender": gender, "dateOfJoining": doj,
                "sourceOfHire": sources[source_idx % 3],
                "l1ManagerId": l1, "l2ManagerId": l2,
                "employmentType": emp_type or et_fulltime,
                "employmentStatus": status_in,
                "projectStatus": proj or ps_allocated,
                "ctc": ctc_by_tier.get(tier, ctc_by_tier["ic"]),
                "currency": "INR",
                # Roles assigned directly to the employee (schema alias roleIds),
                # mapped from the employee's tier to one of the 3 role policies.
                "roleIds": [roles[role_by_tier.get(tier, "Employee")]],
                "emergencyContacts": [
                    {"contactName": f"{first} Family", "contactNumber": "+91-9876543210", "relationship": "Spouse"}
                ],
            }
            resp = await _post(http, "/employees/", oa_token, payload)
            uid = resp.get("userId") or resp.get("user_id")
            user_ids[email] = (uid, status_in)
            code = resp.get("empCode") or resp.get("emp_code", "")
            emp_count += 1
            print(f"  {code} | {first} {last} <{email}> | {desg}")
            return uid

        # ═══════════════════════════════════════════════════════════════════
        # TIER 1: CXO
        # ═══════════════════════════════════════════════════════════════════
        print("\n  --- CXO ---")
        cto = await create_emp(first="Venkat", last="Raman", bu_id=bu_cen,
                               dept="Engineering", desg="CTO", gender=gender_male,
                               doj="2017-01-15", tier="cxo")

        # ═══════════════════════════════════════════════════════════════════
        # TIER 2: Leadership (L1=CTO)
        # ═══════════════════════════════════════════════════════════════════
        print("\n  --- Leadership ---")
        vpe = await create_emp(first="Padma", last="Lakshmi", bu_id=bu_pdv,
                               dept="Engineering", desg="VP Engineering", gender=gender_female,
                               doj="2017-06-01", l1=cto, tier="leadership")

        hrd = await create_emp(first="Nalini", last="Sharma", bu_id=bu_ssh,
                               dept="Human Resources", desg="HR Director", gender=gender_female,
                               doj="2017-08-01", l1=cto, tier="leadership")

        # ═══════════════════════════════════════════════════════════════════
        # TIER 3: Managers (L1=Leadership, L2=CTO)
        # ═══════════════════════════════════════════════════════════════════
        print("\n  --- Managers ---")

        # Engineering Managers (2)
        em1 = await create_emp(first="Gopal", last="Nair", bu_id=bu_cen,
                               dept="Engineering", desg="Engineering Manager", gender=gender_male,
                               doj="2018-03-01", l1=vpe, l2=cto, source_idx=1, tier="manager")

        em2 = await create_emp(first="Rekha", last="Iyer", bu_id=bu_pdv,
                               dept="Engineering", desg="Engineering Manager", gender=gender_female,
                               doj="2018-07-15", l1=vpe, l2=cto, tier="manager")

        # QA Lead
        qal = await create_emp(first="Tarun", last="Malhotra", bu_id=bu_cen,
                               dept="Quality Assurance", desg="QA Lead", gender=gender_male,
                               doj="2018-09-01", l1=vpe, l2=cto, source_idx=1, tier="manager")

        # Finance Manager
        fm = await create_emp(first="Jayashree", last="Menon", bu_id=bu_ssh,
                              dept="Finance & Accounts", desg="Finance Manager", gender=gender_female,
                              doj="2018-04-01", l1=hrd, l2=cto, tier="manager")

        # Product Manager
        pm = await create_emp(first="Kartik", last="Reddy", bu_id=bu_pdv,
                              dept="Product Management", desg="Product Manager", gender=gender_male,
                              doj="2019-01-10", l1=vpe, l2=cto, source_idx=2, tier="manager")

        # DevOps Lead
        dol = await create_emp(first="Ashwin", last="Prasad", bu_id=bu_cen,
                               dept="DevOps & Infra", desg="DevOps Lead", gender=gender_male,
                               doj="2018-11-01", l1=vpe, l2=cto, tier="manager")

        # ═══════════════════════════════════════════════════════════════════
        # TIER 4: Individual Contributors
        # ═══════════════════════════════════════════════════════════════════

        # ─── Engineering (12 ICs under 2 managers) ────────────────────────
        # Full-time employees
        print("\n  --- Engineering ICs (Full-Time) ---")
        eng_ft = [
            ("Deepak",   "Yadav",     bu_cen, "Senior Software Engineer", gender_male,   "2019-02-01", em1, vpe, 0, ps_allocated),
            ("Ananya",   "Chopra",    bu_cen, "Senior Software Engineer", gender_female,  "2019-05-15", em1, vpe, 1, es_permanent),
            ("Vivek",    "Mishra",    bu_pdv, "Senior Software Engineer", gender_male,    "2019-08-01", em2, vpe, 2, es_exit),
            ("Ritu",     "Agarwal",   bu_pdv, "Senior Software Engineer", gender_female,  "2019-11-01", em2, vpe, 0, ps_bench),
            ("Ajay",     "Bansal",    bu_cen, "Software Engineer",        gender_male,    "2020-06-01", em1, vpe, 1, es_notice),
            ("Preethi",  "Sundaram",  bu_cen, "Software Engineer",        gender_female,  "2020-09-01", em1, vpe, 2, ps_long_leave),
            ("Rohan",    "Kulkarni",  bu_pdv, "Software Engineer",        gender_male,    "2021-01-15", em2, vpe, 0, es_retired),
            ("Shruti",   "Deshpande", bu_pdv, "Software Engineer",        gender_female,  "2021-04-01", em2, vpe, 1, es_absconded),
        ]
        for first, last, bu, desg, g, doj, l1, l2, si, es in eng_ft:
            await create_emp(first=first, last=last, bu_id=bu, dept="Engineering",
                             desg=desg, gender=g, doj=doj, l1=l1, l2=l2, source_idx=si, emp_status=es, tier="ic")
        # Contract employees
        print("  --- Engineering ICs (Contract) ---")
        eng_ct = [
            ("Gaurav",   "Thakur",    bu_cen, "Software Engineer",        gender_male,    "2021-07-01", em1, vpe, 2, ps_allocated),
            ("Ishita",   "Sen",       bu_cen, "Software Engineer",        gender_female,  "2022-01-10", em1, vpe, 0, es_terminated),
        ]
        for first, last, bu, desg, g, doj, l1, l2, si, es in eng_ct:
            await create_emp(first=first, last=last, bu_id=bu, dept="Engineering",
                             desg=desg, gender=g, doj=doj, l1=l1, l2=l2, source_idx=si, emp_status=es, emp_type=et_contract, tier="contract")
        # Interns
        print("  --- Engineering ICs (Intern) ---")
        eng_in = [
            ("Pranav",   "Hegde",     bu_pdv, "Software Engineer",        gender_male,    "2022-04-01", em2, vpe, 1, es_probation),
            ("Kavya",    "Nambiar",   bu_pdv, "Software Engineer",        gender_female,  "2022-07-01", em2, vpe, 2, ps_allocated),
        ]
        for first, last, bu, desg, g, doj, l1, l2, si, es in eng_in:
            await create_emp(first=first, last=last, bu_id=bu, dept="Engineering",
                             desg=desg, gender=g, doj=doj, l1=l1, l2=l2, source_idx=si, emp_status=es, emp_type=et_intern, tier="intern")

        # ─── Quality Assurance (11 ICs under QA Lead) ─────────────────────
        print("\n  --- QA ICs (Full-Time) ---")
        qa_ft = [
            ("Sunil",    "Bhatt",     bu_cen, gender_male,   "2019-06-01", 0, ps_allocated),
            ("Meghna",   "Kaur",      bu_cen, gender_female,  "2019-10-01", 1, es_permanent),
            ("Harsh",    "Trivedi",   bu_pdv, gender_male,    "2020-01-15", 2, es_retired),
            ("Pallavi",  "Patil",     bu_pdv, gender_female,  "2020-05-01", 0, ps_bench),
            ("Nikhil",   "Dhawan",    bu_cen, gender_male,    "2020-08-01", 1, es_notice),
            ("Lata",     "Gupta",     bu_cen, gender_female,  "2021-02-01", 2, ps_long_leave),
            ("Omkar",    "Shetty",    bu_pdv, gender_male,    "2021-06-01", 0, es_exit),
        ]
        for first, last, bu, g, doj, si, es in qa_ft:
            await create_emp(first=first, last=last, bu_id=bu, dept="Quality Assurance",
                             desg="QA Engineer", gender=g, doj=doj, l1=qal, l2=vpe, source_idx=si, emp_status=es, tier="ic")
        print("  --- QA ICs (Contract) ---")
        qa_ct = [
            ("Aarti",    "Verma",     bu_pdv, gender_female,  "2021-10-01", 1, ps_allocated),
            ("Ravi",     "Shankar",   bu_cen, gender_male,    "2022-02-01", 2, es_terminated),
        ]
        for first, last, bu, g, doj, si, es in qa_ct:
            await create_emp(first=first, last=last, bu_id=bu, dept="Quality Assurance",
                             desg="QA Engineer", gender=g, doj=doj, l1=qal, l2=vpe, source_idx=si, emp_status=es, emp_type=et_contract, tier="contract")
        print("  --- QA ICs (Intern) ---")
        qa_in = [
            ("Snehal",   "Joshi",     bu_cen, gender_female,  "2022-06-01", 0, es_probation),
            ("Kunal",    "Pandey",    bu_pdv, gender_male,    "2022-09-01", 1, ps_allocated),
        ]
        for first, last, bu, g, doj, si, es in qa_in:
            await create_emp(first=first, last=last, bu_id=bu, dept="Quality Assurance",
                             desg="QA Engineer", gender=g, doj=doj, l1=qal, l2=vpe, source_idx=si, emp_status=es, emp_type=et_intern, tier="intern")

        # ─── Human Resources (10 ICs under HR Director) ──────────────────
        print("\n  --- HR ICs (Full-Time) ---")
        hr_ft = [
            ("Aparna",   "Bose",      bu_ssh, gender_female,  "2019-03-01", 0, ps_allocated),
            ("Mahesh",   "Chauhan",   bu_ssh, gender_male,    "2019-07-01", 1, es_permanent),
            ("Shalini",  "Saxena",    bu_cen, gender_female,  "2020-01-10", 2, ps_long_leave),
            ("Amit",     "Rawat",     bu_pdv, gender_male,    "2020-06-01", 0, es_notice),
            ("Geeta",    "Pillai",    bu_ssh, gender_female,  "2020-11-01", 1, ps_bench),
            ("Rajiv",    "Tiwari",    bu_cen, gender_male,    "2021-03-01", 2, es_retired),
        ]
        for first, last, bu, g, doj, si, es in hr_ft:
            await create_emp(first=first, last=last, bu_id=bu, dept="Human Resources",
                             desg="HR Executive", gender=g, doj=doj, l1=hrd, l2=cto, source_idx=si, emp_status=es, tier="ic")
        print("  --- HR ICs (Contract) ---")
        hr_ct = [
            ("Divya",    "Goswami",   bu_ssh, gender_female,  "2021-08-01", 0, ps_allocated),
            ("Pankaj",   "Pande",     bu_pdv, gender_male,    "2022-01-15", 1, es_exit),
        ]
        for first, last, bu, g, doj, si, es in hr_ct:
            await create_emp(first=first, last=last, bu_id=bu, dept="Human Resources",
                             desg="HR Executive", gender=g, doj=doj, l1=hrd, l2=cto, source_idx=si, emp_status=es, emp_type=et_contract, tier="contract")
        print("  --- HR ICs (Intern) ---")
        hr_in = [
            ("Jyoti",    "Rana",      bu_ssh, gender_female,  "2022-05-01", 2, es_probation),
            ("Suresh",   "Khatri",    bu_ssh, gender_male,    "2022-09-01", 0, ps_allocated),
        ]
        for first, last, bu, g, doj, si, es in hr_in:
            await create_emp(first=first, last=last, bu_id=bu, dept="Human Resources",
                             desg="HR Executive", gender=g, doj=doj, l1=hrd, l2=cto, source_idx=si, emp_status=es, emp_type=et_intern, tier="intern")

        # ─── Finance & Accounts (10 ICs under Finance Manager) ────────────
        print("\n  --- Finance ICs (Full-Time) ---")
        fin_ft = [
            ("Poornima", "Rao",       gender_female,  "2019-04-01", 0, ps_allocated),
            ("Sandeep",  "Varma",     gender_male,    "2019-09-01", 1, es_permanent),
            ("Nisha",    "Arora",     gender_female,  "2020-02-01", 2, es_absconded),
            ("Vikash",   "Sinha",     gender_male,    "2020-07-01", 0, ps_bench),
            ("Bhavna",   "Dutta",     gender_female,  "2020-12-01", 1, es_notice),
            ("Mohan",    "Aggarwal",  gender_male,    "2021-05-01", 2, ps_long_leave),
        ]
        for first, last, g, doj, si, es in fin_ft:
            await create_emp(first=first, last=last, bu_id=bu_ssh, dept="Finance & Accounts",
                             desg="Accounts Executive", gender=g, doj=doj, l1=fm, l2=hrd, source_idx=si, emp_status=es, tier="ic")
        print("  --- Finance ICs (Contract) ---")
        fin_ct = [
            ("Sapna",    "Bhatia",    gender_female,  "2021-10-01", 0, es_terminated),
            ("Akash",    "Mehra",     gender_male,    "2022-03-01", 1, ps_allocated),
        ]
        for first, last, g, doj, si, es in fin_ct:
            await create_emp(first=first, last=last, bu_id=bu_ssh, dept="Finance & Accounts",
                             desg="Accounts Executive", gender=g, doj=doj, l1=fm, l2=hrd, source_idx=si, emp_status=es, emp_type=et_contract, tier="contract")
        print("  --- Finance ICs (Intern) ---")
        fin_in = [
            ("Kiran",    "Sethi",     gender_female,  "2022-07-01", 2, es_probation),
            ("Dinesh",   "Goel",      gender_male,    "2022-11-01", 0, es_exit),
        ]
        for first, last, g, doj, si, es in fin_in:
            await create_emp(first=first, last=last, bu_id=bu_ssh, dept="Finance & Accounts",
                             desg="Accounts Executive", gender=g, doj=doj, l1=fm, l2=hrd, source_idx=si, emp_status=es, emp_type=et_intern, tier="intern")

        # ─── Product Management (10 ICs under Product Manager) ────────────
        print("\n  --- Product ICs (Full-Time) ---")
        pm_ft = [
            ("Aditi",    "Deshmukh",  gender_female,  "2019-06-15", 0, ps_allocated),
            ("Rahul",    "Kapoor",    gender_male,    "2019-11-01", 1, es_permanent),
            ("Swati",    "Naik",      gender_female,  "2020-04-01", 2, es_exit),
            ("Manish",   "Choudhary", gender_male,    "2020-09-01", 0, ps_bench),
            ("Ritika",   "Bajaj",     gender_female,  "2021-01-15", 1, es_notice),
            ("Sourabh",  "Mathur",    gender_male,    "2021-07-01", 2, es_retired),
        ]
        for first, last, g, doj, si, es in pm_ft:
            await create_emp(first=first, last=last, bu_id=bu_pdv, dept="Product Management",
                             desg="Business Analyst", gender=g, doj=doj, l1=pm, l2=vpe, source_idx=si, emp_status=es, tier="ic")
        print("  --- Product ICs (Contract) ---")
        pm_ct = [
            ("Ankita",   "Pandey",    gender_female,  "2021-11-01", 0, ps_allocated),
            ("Varun",    "Khanna",    gender_male,    "2022-04-01", 1, es_terminated),
        ]
        for first, last, g, doj, si, es in pm_ct:
            await create_emp(first=first, last=last, bu_id=bu_pdv, dept="Product Management",
                             desg="Business Analyst", gender=g, doj=doj, l1=pm, l2=vpe, source_idx=si, emp_status=es, emp_type=et_contract, tier="contract")
        print("  --- Product ICs (Intern) ---")
        pm_in = [
            ("Neha",     "Sachdev",   gender_female,  "2022-08-01", 2, es_probation),
            ("Arjun",    "Luthra",    gender_male,    "2023-01-10", 0, ps_allocated),
        ]
        for first, last, g, doj, si, es in pm_in:
            await create_emp(first=first, last=last, bu_id=bu_pdv, dept="Product Management",
                             desg="Business Analyst", gender=g, doj=doj, l1=pm, l2=vpe, source_idx=si, emp_status=es, emp_type=et_intern, tier="intern")

        # ─── DevOps & Infra (10 ICs under DevOps Lead) ───────────────────
        print("\n  --- DevOps ICs (Full-Time) ---")
        do_ft = [
            ("Sameer",   "Wagh",      bu_cen, gender_male,    "2019-05-01", 0, ps_allocated),
            ("Puja",     "Mehta",     bu_pdv, gender_female,  "2019-10-01", 1, es_permanent),
            ("Abhinav",  "Srivastava",bu_cen, gender_male,    "2020-03-01", 2, es_absconded),
            ("Madhuri",  "Das",       bu_pdv, gender_female,  "2020-08-01", 0, ps_long_leave),
            ("Sanjay",   "Mukherjee", bu_cen, gender_male,    "2020-12-15", 1, ps_bench),
            ("Radha",    "Krishnan",  bu_pdv, gender_female,  "2021-05-01", 2, es_exit),
        ]
        for first, last, bu, g, doj, si, es in do_ft:
            await create_emp(first=first, last=last, bu_id=bu, dept="DevOps & Infra",
                             desg="DevOps Engineer", gender=g, doj=doj, l1=dol, l2=vpe, source_idx=si, emp_status=es, tier="ic")
        print("  --- DevOps ICs (Contract) ---")
        do_ct = [
            ("Tushar",   "Jha",       bu_cen, gender_male,    "2021-09-01", 0, es_notice),
            ("Kirti",    "Patel",     bu_pdv, gender_female,  "2022-02-01", 1, es_terminated),
        ]
        for first, last, bu, g, doj, si, es in do_ct:
            await create_emp(first=first, last=last, bu_id=bu, dept="DevOps & Infra",
                             desg="DevOps Engineer", gender=g, doj=doj, l1=dol, l2=vpe, source_idx=si, emp_status=es, emp_type=et_contract, tier="contract")
        print("  --- DevOps ICs (Intern) ---")
        do_in = [
            ("Naveen",   "Babu",      bu_cen, gender_male,    "2022-06-01", 2, es_probation),
            ("Swapna",   "Reddy",     bu_pdv, gender_female,  "2022-10-01", 0, ps_allocated),
        ]
        for first, last, bu, g, doj, si, es in do_in:
            await create_emp(first=first, last=last, bu_id=bu, dept="DevOps & Infra",
                             desg="DevOps Engineer", gender=g, doj=doj, l1=dol, l2=vpe, source_idx=si, emp_status=es, emp_type=et_intern, tier="intern")

        # ── 12. Assign Heads ─────────────────────────────────────────────
        print("\nAssigning heads...")

        # Org head
        await _put(http, f"/organisations/{org_id}", oa_token, {"head_user_id": cto})
        print("  Org Head: Venkat Raman (CTO)")

        # BU heads
        await _put(http, f"/business-units/{bu_cen}", oa_token, {"head_user_id": em1})
        print("  BU Head (Core Engineering): Gopal Nair")
        await _put(http, f"/business-units/{bu_pdv}", oa_token, {"head_user_id": vpe})
        print("  BU Head (Product Division): Padma Lakshmi")
        await _put(http, f"/business-units/{bu_ssh}", oa_token, {"head_user_id": hrd})
        print("  BU Head (Shared Services): Nalini Sharma")

        # Dept heads
        await _put(http, f"/departments/{depts['Engineering']}", oa_token, {"departmentHead": vpe})
        await _put(http, f"/departments/{depts['Quality Assurance']}", oa_token, {"departmentHead": qal})
        await _put(http, f"/departments/{depts['Human Resources']}", oa_token, {"departmentHead": hrd})
        await _put(http, f"/departments/{depts['Finance & Accounts']}", oa_token, {"departmentHead": fm})
        await _put(http, f"/departments/{depts['Product Management']}", oa_token, {"departmentHead": pm})
        await _put(http, f"/departments/{depts['DevOps & Infra']}", oa_token, {"departmentHead": dol})
        print("  All department heads assigned")

    # ── 13. Activate employees + set passwords ─────────────────────────
    print("\nActivating employees & setting passwords...")
    now = datetime.now(timezone.utc)
    pw_hash = get_password_hash(EMP_PASSWORD)
    activated = 0

    inactive_statuses = {es_absconded, es_exit, es_retired, es_terminated}
    for email, (uid, status_id) in user_ids.items():
        user = await UserDocument.find_one(UserDocument.id == PydanticObjectId(uid))
        if user:
            user.password_hash = pw_hash
            user.password_changed_at = now
            if status_id not in inactive_statuses:
                user.status = StatusEnum.ACTIVE
                activated += 1
            await user.save()

    print(f"  {activated} employees activated, {len(user_ids) - activated} inactive (password: {EMP_PASSWORD})")

    # ── Summary ──────────────────────────────────────────────────────────
    # Count per dept
    dept_counts = {
        "Engineering": 1 + 1 + 2 + 12,   # CTO + VP + 2 mgrs + 12 ICs = 16
        "Quality Assurance": 1 + 11,       # QA Lead + 11 ICs = 12
        "Human Resources": 1 + 10,         # HR Dir + 10 ICs = 11
        "Finance & Accounts": 1 + 10,      # Fin Mgr + 10 ICs = 11
        "Product Management": 1 + 10,      # PM + 10 ICs = 11
        "DevOps & Infra": 1 + 10,          # DevOps Lead + 10 ICs = 11
    }

    print(f"\n{'=' * 65}")
    print(f"  SEED COMPLETE (via API) — {ORG_NAME}")
    print(f"{'=' * 65}")
    print()
    print(f"  Org ID:           {org_id}")
    print(f"  Business Units:   3")
    print(f"  Departments:      6")
    print(f"  Designations:    15")
    print(f"  Bands:            6")
    print(f"  Pay Grades:       3")
    print(f"  Role Policies:    3  (Administrator / Manager / Employee)")
    print(f"  Total Employees: {emp_count}")
    print()
    print("  ─── EMPLOYEES PER DEPARTMENT ───")
    for dept_name, count in dept_counts.items():
        print(f"    {dept_name:25s} {count}")
    print()
    print("  ─── HEADS ───")
    print("    Org Head:          Venkat Raman (CTO)")
    print("    Core Engineering:  Gopal Nair (Eng Manager)")
    print("    Product Division:  Padma Lakshmi (VP Eng)")
    print("    Shared Services:   Nalini Sharma (HR Director)")
    print("    Dept Engineering:  Padma Lakshmi (VP Eng)")
    print("    Dept QA:           Tarun Malhotra (QA Lead)")
    print("    Dept HR:           Nalini Sharma (HR Director)")
    print("    Dept Finance:      Jayashree Menon (Finance Mgr)")
    print("    Dept Product:      Kartik Reddy (Product Mgr)")
    print("    Dept DevOps:       Ashwin Prasad (DevOps Lead)")
    print()
    print("  ─── LOGIN CREDENTIALS ───")
    print(f"    Super Admin:  {SUPERADMIN_EMAIL} / {SUPERADMIN_PASSWORD}")
    print(f"    Org Admin:    {ORG_ADMIN_EMAIL} / {ORG_ADMIN_PASSWORD}")
    print(f"    All Employees: <email> / {EMP_PASSWORD}  (active employees only)")
    print()
    print("  RabbitMQ events fired for all entities")
    print("  Downstream services will auto-sync")
    print(f"{'=' * 65}")

    mongo_client.close()


if __name__ == "__main__":
    asyncio.run(seed())
