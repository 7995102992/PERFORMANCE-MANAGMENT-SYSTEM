"""
Seed script: create a client portal user for testing the client review workflow.

What it does:
  1. Creates (or reuses) an IAM user for the client contact
  2. Creates (or reuses) a "Timesheet client policy" with client_timesheet permission
  3. Attaches the policy to the user
  4. Links the user to the first timesheet Client record via contact_user_id
  5. Ensures there are L1-approved timesheets visible to the client portal

Usage:
    cd sentrifugo-timesheet-be
    .venv/Scripts/python seed_client_user.py

Login as:
    email:    clientuser@yopmail.com
    password: Welcome@123
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

# ── Configuration ─────────────────────────────────────────────
ORG_ID = "69fdb48a7b3e3279cee669f7"
ADMIN_ID = "69fdb48a7b3e3279cee669f8"

CLIENT_EMAIL = "clientuser@yopmail.com"
CLIENT_PASSWORD = "test@123"
CLIENT_FIRST_NAME = "Bob"
CLIENT_LAST_NAME = "Smith"

IAM_DB = "sentrifugo_iam"
TSM_DB = settings.MONGO_DB_NAME

POLICY_NAME = "Timesheet client policy"

NOW = datetime.now(timezone.utc)


async def seed():
    motor = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    iam_db = motor[IAM_DB]
    tsm_db = motor[TSM_DB]

    users_col = iam_db["users"]
    policies_col = iam_db["policies"]
    grants_col = iam_db["module_acl_permissions"]
    clients_col = tsm_db["clients"]

    # ── 1. Create or reuse the client IAM user ────────────────
    print("\n[1] Client IAM user...")
    existing_user = await users_col.find_one({"email": CLIENT_EMAIL})

    if existing_user:
        client_user_id = str(existing_user["_id"])
        print(f"  Already exists: {client_user_id}")
    else:
        # Pre-computed bcrypt hash for "test@123"
        pw_hash = "$2b$12$8OXqaJ9KCpUBn3hYI9Rt4u.GBnLlGLJpk0X1fHmOujzf20sVDd/qW"
        user_doc = {
            "email": CLIENT_EMAIL,
            "password_hash": pw_hash,
            "auth_method": "local",
            "azure_oid": None,
            "first_name": CLIENT_FIRST_NAME,
            "last_name": CLIENT_LAST_NAME,
            "middle_name": None,
            "phone": None,
            "work_phone": None,
            "work_phone_extension": None,
            "avatar_url": None,
            "dob": None,
            "gender": None,
            "marital_status": None,
            "status": "active",
            "pending_email": None,
            "last_login_at": None,
            "password_changed_at": NOW,
            "is_super_admin": False,
            "is_org_admin": False,
            "organisation_id": ObjectId(ORG_ID),
            "policy_ids": [],
            "created_by": ADMIN_ID,
            "created_on": NOW,
            "modified_by": ADMIN_ID,
            "modified_on": NOW,
            "deleted_by": None,
            "deleted_on": None,
            "correlation_id": None,
        }
        result = await users_col.insert_one(user_doc)
        client_user_id = str(result.inserted_id)
        print(f"  Created: {client_user_id}")

    # ── 2. Create or reuse the client policy ──────────────────
    print("\n[2] Client policy...")
    existing_policy = await policies_col.find_one({
        "name": POLICY_NAME,
        "organisation_id": ObjectId(ORG_ID),
        "deleted_on": None,
    })

    if existing_policy:
        policy_id = existing_policy["_id"]
        print(f"  Already exists: {policy_id}")
    else:
        policy_doc = {
            "name": POLICY_NAME,
            "is_role": False,
            "is_active": True,
            "organisation_id": ObjectId(ORG_ID),
            "seed_module_codes": [],
            "created_by": ADMIN_ID,
            "created_on": NOW,
            "modified_by": ADMIN_ID,
            "modified_on": NOW,
            "deleted_by": None,
            "deleted_on": None,
            "correlation_id": None,
        }
        result = await policies_col.insert_one(policy_doc)
        policy_id = result.inserted_id
        print(f"  Created: {policy_id}")

    # ── 3. Create permission grant: timesheet_management / client_timesheet
    print("\n[3] Permission grant (client_timesheet)...")
    existing_grant = await grants_col.find_one({
        "policy_id": policy_id,
        "module_id": "timesheet_management",
        "permission_id": "client_timesheet",
        "deleted_on": None,
    })

    if existing_grant:
        print(f"  Already exists: {existing_grant['_id']}")
    else:
        grant_doc = {
            "policy_id": policy_id,
            "module_id": "timesheet_management",
            "acl_id": "admin",
            "permission_id": "client_timesheet",
            "created_by": ADMIN_ID,
            "created_on": NOW,
            "modified_by": ADMIN_ID,
            "modified_on": NOW,
            "deleted_by": None,
            "deleted_on": None,
            "correlation_id": None,
        }
        result = await grants_col.insert_one(grant_doc)
        print(f"  Created: {result.inserted_id}")

    # ── 4. Attach policy to the client user ───────────────────
    print("\n[4] Attaching policy to user...")
    user_doc = await users_col.find_one({"_id": ObjectId(client_user_id)})
    current_policies = user_doc.get("policy_ids", [])

    if policy_id in current_policies:
        print("  Already attached")
    else:
        await users_col.update_one(
            {"_id": ObjectId(client_user_id)},
            {
                "$addToSet": {"policy_ids": policy_id},
                "$set": {"modified_on": NOW, "modified_by": ADMIN_ID},
            },
        )
        print("  Attached")

    # ── 5. Link client user to the first TSM Client record ────
    print("\n[5] Linking user to timesheet Client record...")
    first_client = await clients_col.find_one({
        "organisation_id": ORG_ID,
        "deleted_on": None,
    })

    if not first_client:
        print("  WARNING: No timesheet Client record found. Run seed.py first.")
    else:
        client_name = first_client.get("name", "?")
        current_contact = first_client.get("contact_user_id")
        if current_contact == client_user_id:
            print(f"  Already linked to '{client_name}'")
        else:
            await clients_col.update_one(
                {"_id": first_client["_id"]},
                {
                    "$set": {
                        "contact_user_id": client_user_id,
                        "contact_email": CLIENT_EMAIL,
                        "portal_access_enabled": True,
                        "modified_on": NOW,
                        "modified_by": ADMIN_ID,
                    },
                },
            )
            print(f"  Linked to '{client_name}' (was: {current_contact})")

    # ── 6. Verify: count L1-approved timesheets visible to client
    print("\n[6] Checking visible timesheets for client portal...")
    projects = await tsm_db["projects"].find({
        "client_id": str(first_client["_id"]) if first_client else "none",
        "organisation_id": ORG_ID,
        "deleted_on": None,
    }).to_list(100)

    project_ids = [str(p["_id"]) for p in projects]
    print(f"  Client projects: {[p.get('name') for p in projects]}")

    if project_ids:
        entries = await tsm_db["timesheet_entries"].find({
            "project_id": {"$in": project_ids},
            "deleted_on": None,
        }).to_list(1000)
        ts_ids = list({e["weekly_timesheet_id"] for e in entries})

        if ts_ids:
            ts_oids = [ObjectId(tid) for tid in ts_ids if ObjectId.is_valid(tid)]
            visible_ts = await tsm_db["weekly_timesheets"].find({
                "_id": {"$in": ts_oids},
                "organisation_id": ORG_ID,
                "deleted_on": None,
                "timesheet_status": {"$in": ["l1_approved", "client_approved", "client_rejected"]},
            }).to_list(100)
            print(f"  Visible timesheets: {len(visible_ts)}")
            for ts in visible_ts:
                print(f"    {ts['_id']} - {ts['timesheet_status']} - {ts.get('total_hours', 0)}h")
        else:
            print("  No timesheet entries found for client projects")
    else:
        print("  No projects found under this client")

    # ── Summary ───────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  CLIENT USER SEED COMPLETE")
    print("=" * 60)
    print(f"""
Client Portal Login:
  Email:    {CLIENT_EMAIL}
  Password: {CLIENT_PASSWORD}

IAM Records:
  User ID:   {client_user_id}
  Policy ID: {policy_id}
  Permission: timesheet_management / client_timesheet

TSM Records:
  Client: {first_client.get('name', 'N/A') if first_client else 'N/A'}
  contact_user_id: {client_user_id}

What to test:
  1. Login as {CLIENT_EMAIL}
  2. Navigate to /timesheet/client-review
  3. See L1-approved timesheets pending client review
  4. Approve or reject individual timesheets
  5. Use bulk approve/reject with checkboxes
  6. View timesheet detail with daily breakdown
  7. Check /timesheet/activity-history for audit log
""")

    motor.close()


if __name__ == "__main__":
    asyncio.run(seed())
