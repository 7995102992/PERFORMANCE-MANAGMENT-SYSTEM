"""Seed the ACL / modules / permissions lookup collections.

Usage:
    python -m scripts.seed_lookups

Idempotent: re-running upserts each row by id (business key). Existing rows
are updated with the latest label / description / mandatory values; new rows
are inserted. Nothing is ever deleted — if you need to remove a code, edit
it out of the corresponding constant below and delete the row manually.

The codes defined here must stay in sync with AclRoleEnum / ModuleEnum /
PermissionCodeEnum in src/models.py. Those Python-side enums give the rest
of the codebase type safety; these rows give the frontend something to
render with labels + descriptions + flags.
"""

import asyncio

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.lookups.utils import tools as repo
from src.models import (
    AclDocument,
    AclRoleEnum,
    MODULE_PERMISSIONS,
    ModuleDocument,
    ModuleEnum,
    PermissionDocument,
    permission_doc_id,
    permission_label,
)


ACL_SEED: list[dict] = [
    {"id": AclRoleEnum.ADMIN.value,  "role": AclRoleEnum.ADMIN,  "label": "Administrator", "rank": 2},
    {"id": AclRoleEnum.EDITOR.value, "role": AclRoleEnum.EDITOR, "label": "Editor",        "rank": 1},
    {"id": AclRoleEnum.VIEWER.value, "role": AclRoleEnum.VIEWER, "label": "Viewer",        "rank": 0},
]


# Descriptions come verbatim from the Add New Organization wireframe cards.
MODULE_SEED: list[dict] = [
    {
        "id": ModuleEnum.CORE_HR.value,
        "code": ModuleEnum.CORE_HR,
        "label": "Core HR",
        "description": "Employee database, org structure, and basic HR functions",
        "mandatory": True,
    },
{
        "id": ModuleEnum.LEAVE_MANAGEMENT.value,
        "code": ModuleEnum.LEAVE_MANAGEMENT,
        "label": "Leave & Attendance",
        "description": "Manage leave requests, approvals, balances, and employee attendance",
        "mandatory": False,
    },
    # {
    #     "id": ModuleEnum.PAYROLL.value,
    #     "code": ModuleEnum.PAYROLL,
    #     "label": "Payroll",
    #     "description": "Salary processing, tax calculations, and payslips",
    #     "mandatory": False,
    # },
    # {
    #     "id": ModuleEnum.PERFORMANCE_MANAGEMENT.value,
    #     "code": ModuleEnum.PERFORMANCE_MANAGEMENT,
    #     "label": "Performance Management",
    #     "description": "Goals, reviews, and performance evaluations",
    #     "mandatory": False,
    # },
    # {
    #     "id": ModuleEnum.RECRUITMENT.value,
    #     "code": ModuleEnum.RECRUITMENT,
    #     "label": "Recruitment",
    #     "description": "Job postings, candidate tracking, and hiring",
    #     "mandatory": False,
    # },
    # {
    #     "id": ModuleEnum.TRAINING_AND_DEVELOPMENT.value,
    #     "code": ModuleEnum.TRAINING_AND_DEVELOPMENT,
    #     "label": "Training & Development",
    #     "description": "Learning programs, courses, and skill development",
    #     "mandatory": False,
    # },
    # {
    #     "id": ModuleEnum.EXPENSE_MANAGEMENT.value,
    #     "code": ModuleEnum.EXPENSE_MANAGEMENT,
    #     "label": "Expense Management",
    #     "description": "Track and approve employee expenses and reimbursements",
    #     "mandatory": False,
    # },
    # {
    #     "id": ModuleEnum.ASSET_MANAGEMENT.value,
    #     "code": ModuleEnum.ASSET_MANAGEMENT,
    #     "label": "Asset Management",
    #     "description": "Manage company assets and equipment allocation",
    #     "mandatory": False,
    # },
    {
        "id": ModuleEnum.SERVICE_REQUEST.value,
        "code": ModuleEnum.SERVICE_REQUEST,
        "label": "Service Request",
        "description": "Raise and manage employee service requests",
        "mandatory": False,
    },
    {
        "id": ModuleEnum.TIMESHEET_MANAGEMENT.value,
        "code": ModuleEnum.TIMESHEET_MANAGEMENT,
        "label": "Timesheet Management",
        "description": "Track time, manage clients, projects, and approvals",
        "mandatory": False,
    },
    {
        "id": ModuleEnum.REPORTS_AND_ANALYTICS.value,
        "code": ModuleEnum.REPORTS_AND_ANALYTICS,
        "label": "Reports & Analytics",
        "description": "Reports & Analytics",
        "mandatory": False,
    },
]


PERMISSION_SEED: list[dict] = [
    {
        "id": permission_doc_id(module, code),
        "module": module,
        "code": code,
        "label": permission_label(module, code),
    }
    for module, codes in MODULE_PERMISSIONS.items()
    for code in sorted(codes, key=lambda c: c.value)
]


async def seed() -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    await init_beanie(
        database=db,
        document_models=[AclDocument, ModuleDocument, PermissionDocument],
    )

    acl_count = 0
    for row in ACL_SEED:
        await repo.upsert_acl(row)
        acl_count += 1

    mod_count = 0
    for row in MODULE_SEED:
        await repo.upsert_module(row)
        mod_count += 1

    perm_count = 0
    for row in PERMISSION_SEED:
        await repo.upsert_permission(row)
        perm_count += 1

    print(f"Seeded ACL:         {acl_count}")
    print(f"Seeded modules:     {mod_count}")
    print(f"Seeded permissions: {perm_count}")
    print("Done.")
    client.close()


if __name__ == "__main__":
    asyncio.run(seed())
