"""Dev/migration fallback: sync one org's IAM data straight into the leave (LMS) DB.

PRODUCTION NOTE: in the real system this sync happens via RabbitMQ domain events
(business_unit.created / department.created / employee.created, consumed by the
LMS `domain_events_consumer`). This script is ONLY a deterministic fallback for
local migration when broker delivery isn't available — it writes the SAME
documents that consumer would (keyed by the IAM `_id`, organisation_id -> org_id,
ids as ObjectId), straight into the LMS database. Idempotent (upsert by _id).

Both DBs live on the same Mongo cluster, so we reach the LMS DB by name.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.sync_org_to_lms                 # DRY RUN (counts only)
    python -m scripts.sync_org_to_lms --commit        # upsert into the LMS DB
    python -m scripts.sync_org_to_lms --lms-db NAME   # override LMS db name
"""

import argparse
import asyncio
from datetime import datetime

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

ORG_ID = ObjectId("6a3e05a5c0470e0bdd9ce9a9")
DEFAULT_LMS_DB = "sentrifugo_lms"


async def main():
    global ORG_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="write to the LMS DB (default: dry run)")
    ap.add_argument("--revert", action="store_true", help="delete this org's synced data from the LMS, then exit")
    ap.add_argument("--lms-db", default=DEFAULT_LMS_DB)
    ap.add_argument("--org-id", help="organisation id to sync (default: the built-in one)")
    args = ap.parse_args()
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    iam = client.get_default_database()
    lms = client[args.lms_db]

    if args.revert:
        out = {
            "employees": (await lms["employees"].delete_many({"organisation_id": ORG_ID})).deleted_count,
            "departments": (await lms["departments"].delete_many({"org_id": ORG_ID})).deleted_count,
            "business_units": (await lms["business_units"].delete_many({"org_id": ORG_ID})).deleted_count,
            "organisations": (await lms["organisations"].delete_many({"_id": ORG_ID})).deleted_count,
        }
        print(f"Reverted LMS sync ({args.lms_db}):", out)
        client.close()
        return

    # ── Read our org's data from the IAM DB ─────────────────────────────────
    org = await iam["organisations"].find_one({"_id": ORG_ID})
    bus = await iam["business_units"].find({"organisation_id": ORG_ID, "deleted_on": None}).to_list(None)
    depts = await iam["departments"].find({"organisation_id": ORG_ID, "deleted_on": None}).to_list(None)
    emps = await iam["employees"].find({"organisation_id": ORG_ID, "deleted_on": None}).to_list(None)
    uids = [e["user_id"] for e in emps if e.get("user_id")]
    users = {u["_id"]: u for u in await iam["users"].find({"_id": {"$in": uids}}).to_list(None)}
    # Employment-status master data our employees use — the LMS resolves active/
    # inactive from these (e.g. Direct/Third Party Contract aren't in its defaults).
    status_ids = list({e.get("employment_status") for e in emps if e.get("employment_status")})
    statuses = await iam["master_data"].find({"_id": {"$in": status_ids}}).to_list(None)

    print(f"IAM source: org={'yes' if org else 'NO'}, BUs={len(bus)}, "
          f"departments={len(depts)}, employees={len(emps)}, employment_statuses={len(statuses)}  (db={iam.name})")
    print(f"LMS target db: {args.lms_db}")

    if not args.commit:
        print("\nDRY RUN — no writes. Re-run with --commit to upsert into the LMS DB.")
        client.close()
        return

    # ── Organisation (mirrors _handle_organisation_created) ─────────────────
    if org:
        odoc = {k: v for k, v in org.items() if k != "_id"}
        odoc["is_deleted"] = False
        await lms["organisations"].update_one({"_id": ORG_ID}, {"$set": odoc}, upsert=True)

    # ── Business units (mirrors _handle_business_unit_created) ───────────────
    for b in bus:
        await lms["business_units"].update_one({"_id": b["_id"]}, {"$set": {
            "name": b.get("business_unit_name", ""),
            "org_id": b.get("organisation_id"),
            "currency": b.get("currency"),
            "time_zone": b.get("time_zone"),
            "is_subsidiary": b.get("is_subsidiary", False),
            "is_active": b.get("is_active", True),
            "head_user_id": b.get("head_user_id"),
            "is_deleted": False,
        }}, upsert=True)

    # ── Departments (mirrors _handle_department_created) ─────────────────────
    for d in depts:
        await lms["departments"].update_one({"_id": d["_id"]}, {"$set": {
            "name": d.get("department_name", ""),
            "org_id": d.get("organisation_id"),
            "business_unit_ids": d.get("business_units", []),
            "business_unit_id": d.get("primary_business_unit"),
            "is_active": d.get("is_active", True),
            "department_head": d.get("department_head"),
            "department_code": d.get("department_code"),
            "is_deleted": False,
        }}, upsert=True)

    # ── Employees (mirrors _handle_employee_created) ─────────────────────────
    for e in emps:
        u = users.get(e.get("user_id")) or {}
        await lms["employees"].update_one({"_id": e["_id"]}, {"$set": {
            "user_id": e.get("user_id"),
            "organisation_id": e.get("organisation_id"),
            "emp_code": e.get("emp_code"),
            "work_email": u.get("email"),
            "name": f"{u.get('first_name', '')} {u.get('last_name', '')}".strip(),
            "first_name": u.get("first_name"),
            "last_name": u.get("last_name"),
            "l1_manager_id": e.get("l1_manager_id"),
            "l2_manager_id": e.get("l2_manager_id"),
            "designation_id": e.get("designation_id"),
            "department_id": e.get("department_id"),
            "business_unit_id": e.get("business_unit_id"),
            "employment_status": e.get("employment_status"),
            "employment_type": e.get("employment_type"),
            "project_status": e.get("project_status"),
            # IAM stores a BSON Date; the RabbitMQ consumer stores the event's
            # "YYYY-MM-DD" string. Normalize to the string so the LMS collection
            # holds ONE type regardless of which path wrote the doc.
            "date_of_joining": (str(e["date_of_joining"].date())
                                if isinstance(e.get("date_of_joining"), datetime)
                                else e.get("date_of_joining")),
            "is_deleted": False,
        }}, upsert=True)

    # ── Employment statuses (mirrors _handle_employment_status_created) ──────
    for s in statuses:
        await lms["employment_statuses"].update_one({"_id": s["_id"]}, {"$set": {
            "key": s.get("key"), "value": s.get("value"),
            "is_active": bool(s.get("is_active", True)),
        }}, upsert=True)

    print(f"\nLMS upserted: {1 if org else 0} org, {len(bus)} BUs, {len(depts)} departments, "
          f"{len(emps)} employees, {len(statuses)} employment_statuses -> {args.lms_db}")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
