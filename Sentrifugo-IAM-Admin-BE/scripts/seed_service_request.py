"""Seed script for the Service Request Management database (sentrifugo_srm).

Creates all collections with their indexes and seeds default categories and
request types (with embedded SLA rules) for every active organisation in IAM.

Foreign-key fields (organisation_id, department_id, category_id) are written as
bson ObjectId to match the SRM models after the ObjectId refactor — the app
queries with ObjectId filters, so string-keyed rows would be invisible. SLA
rules are embedded in request_types.sla_rules (the development-branch model),
not a separate collection.

Usage:
    python -m scripts.seed_service_request
"""

import asyncio
import random
from datetime import datetime, timezone
from uuid import uuid4

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING, IndexModel

from src.config import settings

SRM_DB_NAME = "sentrifugo_srm"

COLLECTIONS: dict[str, list[IndexModel]] = {
    "org_sr_config": [
        IndexModel([("organisation_id", ASCENDING)], unique=True),
    ],
    "categories": [
        IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
        IndexModel(
            [("organisation_id", ASCENDING), ("name_lc", ASCENDING)],
            unique=True,
            partialFilterExpression={"deleted_on": None},
        ),
    ],
    "request_types": [
        IndexModel([("organisation_id", ASCENDING), ("category_id", ASCENDING)]),
        IndexModel(
            [("organisation_id", ASCENDING), ("name_lc", ASCENDING)],
            unique=True,
            partialFilterExpression={"deleted_on": None},
        ),
    ],
    "workflows": [
        IndexModel([("organisation_id", ASCENDING), ("request_type_id", ASCENDING)]),
        IndexModel(
            [("request_type_id", ASCENDING), ("is_active_for_type", ASCENDING)],
            unique=True,
            partialFilterExpression={
                "is_active_for_type": True,
                "deleted_on": None,
            },
        ),
    ],
    "approval_levels": [
        IndexModel(
            [("workflow_id", ASCENDING), ("level_index", ASCENDING)],
            unique=True,
            partialFilterExpression={"deleted_on": None},
        ),
    ],
    "approvers": [
        IndexModel([("approval_level_id", ASCENDING), ("sort_order", ASCENDING)]),
    ],
    "escalation_configs": [
        IndexModel(
            [("workflow_id", ASCENDING)],
            unique=True,
            partialFilterExpression={"deleted_on": None},
        ),
    ],
    "service_requests": [
        IndexModel([("organisation_id", ASCENDING), ("request_status", ASCENDING)]),
        IndexModel([("organisation_id", ASCENDING), ("requester_user_id", ASCENDING)]),
        IndexModel([("organisation_id", ASCENDING), ("executor_user_id", ASCENDING)]),
        IndexModel([("organisation_id", ASCENDING), ("submitted_on", DESCENDING)]),
        IndexModel([("organisation_id", ASCENDING), ("ticket_no", ASCENDING)], unique=True),
    ],
    "approval_decisions": [
        IndexModel([("service_request_id", ASCENDING), ("level_index", ASCENDING)]),
        IndexModel(
            [("service_request_id", ASCENDING), ("level_index", ASCENDING), ("approver_user_id", ASCENDING)],
            unique=True,
            partialFilterExpression={"deleted_on": None},
        ),
    ],
    "comments": [
        IndexModel([("service_request_id", ASCENDING), ("created_on", DESCENDING)]),
    ],
    "internal_notes": [
        IndexModel([("service_request_id", ASCENDING), ("created_on", DESCENDING)]),
    ],
    "attachments": [
        IndexModel([("service_request_id", ASCENDING)]),
    ],
    "counters": [],
    "idempotency_records": [
        IndexModel([("key", ASCENDING)], unique=True),
    ],
    "outbox_events": [
        IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
        IndexModel([("idempotency_key", ASCENDING)], unique=True),
    ],
}

CATEGORY_REQUEST_TYPES: dict[str, list[str]] = {
    "IT Support": [
        "Hardware Issue",
        "Software Issue",
        "System Access Request",
        "Email / Outlook Issue",
        "VPN / Network Issue",
        "New Hardware Request",
        "Software Installation",
        "Password Reset",
        "Account Unlock",
        "Troubleshooting",
        "IT Support - Others",
    ],
    "HR Services": [
        "Employment Verification Letter",
        "Salary Certificate",
        "Experience Letter",
        "Leave Correction",
        "Reporting Manager Change",
        "Personal Details Update",
        "Access Card Request",
        "Policy Clarification",
        "HR Services - Others",
    ],
    "Payroll & Compensation": [
        "Salary Issue",
        "Payslip Request",
        "Tax Declaration",
        "Reimbursement Claim",
        "Bonus / Incentive Query",
        "PF / ESI Query",
        "Full & Final Settlement",
        "Payroll & Compensation - Others",
    ],
    "Finance & Accounts": [
        "Invoice Request",
        "Expense Reimbursement",
        "Payment Status Inquiry",
        "Vendor Payment Issue",
        "Budget Approval",
        "Journal Entry Request",
        "Finance & Accounts - Others",
    ],
    "Admin / Facilities": [
        "ID Card Request",
        "Seating Arrangement",
        "Transport Request",
        "Travel Desk Support",
        "Stationery Request",
        "Office Maintenance",
        "Parking Request",
        "Visitor Access",
        "Admin / Facilities - Others",
    ],
    "Recruitment / Hiring": [
        "New Position Request",
        "Candidate Interview Scheduling",
        "Offer Approval",
        "Offer Letter Request",
        "Background Verification",
        "Recruitment Status Inquiry",
        "Recruitment / Hiring - Others",
    ],
    "Procurement": [
        "Purchase Request",
        "Vendor Onboarding",
        "Quotation Request",
        "Purchase Order Issue",
        "Asset Procurement",
        "Procurement - Others",
    ],
    "Project Management / PMO": [
        "Timesheet Issue",
        "Project Allocation",
        "Resource Request",
        "Incorrect Hours Update",
        "Project Access Request",
        "Project Management / PMO - Others",
    ],
    "Compliance & Quality": [
        "Audit Issue",
        "Policy Violation Report",
        "Process Improvement Suggestion",
        "Documentation Request",
        "Compliance Clarification",
        "Compliance & Quality - Others",
    ],
    "Application / Product Support": [
        "Bug Report",
        "Feature Request",
        "Enhancement Request",
        "Access Issue",
        "Performance Issue",
        "Integration Issue",
        "Application / Product Support - Others",
    ],
    "Travel & Visa": [
        "Travel Request",
        "Travel Reimbursement",
        "Visa Processing",
        "Travel Approval",
        "Accommodation Request",
        "Travel & Visa - Others",
    ],
    "Security & Access Control": [
        "Security Access Request",
        "Role Change",
        "Permission Issue",
        "Security Incident Report",
        "Data Access Request",
        "Security & Access Control - Others",
    ],
    "General / Miscellaneous": [
        "General Inquiry",
        "Feedback",
        "Suggestion",
        "Complaint",
        "General / Miscellaneous - Others",
    ],
}


# Embedded SLA rules seeded into every request type — one per priority so a
# request is raisable at any priority. (minutes; first_response <= resolution.)
_SLA_DEFAULTS: dict[str, tuple[int, int]] = {
    "low":    (480, 5760),   # 8h / 4 business days
    "medium": (240, 2880),   # 4h / 2 days
    "high":   (120, 1440),   # 2h / 1 day
    "urgent": (30, 480),     # 30m / 8h
}


def _default_sla_rules(now: datetime) -> list[dict]:
    return [
        {
            "id": str(uuid4()),
            "priority": priority,
            "first_response_minutes": frm,
            "resolution_minutes": rm,
            "business_hours_only": False,
            "description": None,
            "violation_actions": [],
            "notification_recipients": [],
            "status": "active",
            "created_on": now,
            "modified_on": now,
            "deleted_on": None,
        }
        for priority, (frm, rm) in _SLA_DEFAULTS.items()
    ]


async def seed() -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client[SRM_DB_NAME]

    # Drop legacy indexes that are superseded by the ones defined in COLLECTIONS.
    _LEGACY_INDEXES: dict[str, list[str]] = {
        "request_types": ["organisation_id_1_category_id_1_name_lc_1"],
    }
    for coll_name, idx_names in _LEGACY_INDEXES.items():
        coll = db[coll_name]
        existing_idx = await coll.index_information()
        for idx_name in idx_names:
            if idx_name in existing_idx:
                await coll.drop_index(idx_name)
                print(f"  Dropped legacy index: {coll_name}.{idx_name}")

    # --- Create collections & indexes ---
    existing = await db.list_collection_names()
    for collection_name, indexes in COLLECTIONS.items():
        if collection_name not in existing:
            await db.create_collection(collection_name)
        if indexes:
            try:
                await db[collection_name].create_indexes(indexes)
            except Exception as e:
                print(f"  Warning: index on {collection_name} -- {e}")
        print(f"  OK: {collection_name} ({len(indexes)} indexes)")

    print(f"\nCreated {len(COLLECTIONS)} collections in '{SRM_DB_NAME}'.")

    # --- Fetch all active orgs from IAM DB ---
    iam_db = client.get_default_database()
    orgs = await iam_db["organisations"].find(
        {"deleted_on": None}, {"_id": 1}
    ).to_list(None)
    org_ids = [o["_id"] for o in orgs]  # ObjectId, matches SRM ObjectId filters

    if not org_ids:
        print("\nNo organisations found in IAM DB — skipping category seed.")
        print("Done.")
        client.close()
        return

    print(f"\nFound {len(org_ids)} organisation(s). Seeding categories and request types...")

    categories_coll = db["categories"]
    request_types_coll = db["request_types"]
    now = datetime.now(timezone.utc)

    total_cats = 0
    total_rts = 0

    for org_id in org_ids:
        cat_count = 0
        rt_count = 0

        # Load all active departments for this org once
        dept_docs = await iam_db["departments"].find(
            {"organisation_id": org_id, "is_active": True, "deleted_on": None}, {"_id": 1}
        ).to_list(None)
        dept_ids = [d["_id"] for d in dept_docs]  # ObjectId

        for cat_name, request_types in CATEGORY_REQUEST_TYPES.items():
            cat_filter = {"organisation_id": org_id, "name_lc": cat_name.lower(), "deleted_on": None}
            existing_cat = await categories_coll.find_one(cat_filter)

            if existing_cat:
                cat_id = existing_cat["_id"]
            else:
                if not dept_ids:
                    print(f"  Skipping org {org_id} — no active departments found.")
                    break
                dept_id = random.choice(dept_ids)
                result = await categories_coll.insert_one({
                    "organisation_id": org_id,
                    "name": cat_name,
                    "name_lc": cat_name.lower(),
                    "description": None,
                    "department_id": dept_id,
                    "status": "active",
                    "created_on": now,
                    "modified_on": now,
                    "deleted_on": None,
                })
                cat_id = result.inserted_id
                cat_count += 1

            for rt_name in request_types:
                rt_filter = {
                    "organisation_id": org_id,
                    "category_id": cat_id,
                    "name_lc": rt_name.lower(),
                    "deleted_on": None,
                }
                existing_rt = await request_types_coll.find_one(rt_filter)
                if not existing_rt:
                    await request_types_coll.insert_one({
                        "organisation_id": org_id,
                        "category_id": cat_id,
                        "name": rt_name,
                        "name_lc": rt_name.lower(),
                        "description": None,
                        "sla_rules": _default_sla_rules(now),
                        "status": "active",
                        "created_on": now,
                        "modified_on": now,
                        "deleted_on": None,
                    })
                    rt_count += 1

        print(f"  org {org_id}: {cat_count} categories, {rt_count} request types seeded")
        total_cats += cat_count
        total_rts += rt_count

    print(f"\nTotal seeded — categories: {total_cats}, request types: {total_rts}")
    print("Done.")
    client.close()


if __name__ == "__main__":
    asyncio.run(seed())
