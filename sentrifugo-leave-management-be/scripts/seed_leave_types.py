"""Seed script to insert system-defined leave types (not org-specific).

Usage:
    python -m scripts.seed_leave_types

On re-run:
    Leave types whose code already exists as a system type (org_id=None)
    are skipped. Only missing ones are inserted.
"""

import asyncio
import uuid
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

COLLECTION = "leave_types"

SYSTEM_LEAVE_TYPES = [
    {
        "name": "Annual Leave",
        "code": "AL",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": True,
        "is_paid_leave": True,
        "deduct_from_leave_balance": True,
        "show_description": False,
        "is_sick_leave": False,
        "is_statutory_leave": False,
        "description": "Yearly paid leave entitlement for rest and recreation.",
        "color": "#4CAF50",
        "restrictions": {"gender": None, "marital_status": None},
    },
    {
        "name": "Sick Leave",
        "code": "SL",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": True,
        "is_paid_leave": True,
        "deduct_from_leave_balance": True,
        "show_description": True,
        "is_sick_leave": True,
        "is_statutory_leave": False,
        "description": "Leave for personal illness or medical appointments.",
        "color": "#F44336",
        "restrictions": {"gender": None, "marital_status": None},
    },
    {
        "name": "Casual Leave",
        "code": "CL",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": True,
        "is_paid_leave": True,
        "deduct_from_leave_balance": True,
        "show_description": False,
        "is_sick_leave": False,
        "is_statutory_leave": False,
        "description": "Short-notice leave for personal or urgent matters.",
        "color": "#FF9800",
        "restrictions": {"gender": None, "marital_status": None},
    },
    {
        "name": "Maternity Leave",
        "code": "ML",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": False,
        "is_paid_leave": True,
        "deduct_from_leave_balance": False,
        "show_description": True,
        "is_sick_leave": False,
        "is_statutory_leave": True,
        # Maternity Benefit (Amendment) Act, 2017 — 26 weeks (182 days) for first two children
        "max_statutory_days": 182,
        # Statutory maternity leave is counted in calendar days — weekends and
        # holidays falling within the period are included in the duration.
        "count_calendar_days": True,
        "description": "Statutory leave for childbirth and post-natal care.",
        "color": "#E91E63",
        "restrictions": {"gender": "FEMALE", "marital_status": None},
    },
    {
        "name": "Paternity Leave",
        "code": "PL",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": False,
        "is_paid_leave": True,
        "deduct_from_leave_balance": False,
        "show_description": True,
        "is_sick_leave": False,
        "is_statutory_leave": True,
        # CCS (Leave) Rules — 15 days for central govt employees; widely adopted as private sector standard
        "max_statutory_days": 15,
        # Statutory paternity leave is counted in calendar days — weekends and
        # holidays falling within the period are included in the duration.
        "count_calendar_days": True,
        "description": "Leave for fathers following the birth of a child.",
        "color": "#2196F3",
        "restrictions": {"gender": "MALE", "marital_status": None},
    },
    {
        "name": "Unpaid Leave",
        "code": "UL",
        "unit": "DAYS",
        "is_paid": False,
        "deduct_from_balance": False,
        "is_paid_leave": False,
        "deduct_from_leave_balance": False,
        "show_description": True,
        "is_sick_leave": False,
        "is_statutory_leave": False,
        "description": "Leave without pay for extended personal needs.",
        "color": "#9E9E9E",
        "restrictions": {"gender": None, "marital_status": None},
    },
    {
        "name": "Compensatory Leave",
        "code": "COL",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": True,
        "is_paid_leave": True,
        "deduct_from_leave_balance": True,
        "show_description": False,
        "is_sick_leave": False,
        "is_statutory_leave": False,
        "description": "Leave earned in lieu of extra hours or holiday worked.",
        "color": "#9C27B0",
        "restrictions": {"gender": None, "marital_status": None},
    },
    {
        "name": "Bereavement Leave",
        "code": "BL",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": False,
        "is_paid_leave": True,
        "deduct_from_leave_balance": False,
        "show_description": True,
        "is_sick_leave": False,
        "is_statutory_leave": False,
        "description": "Leave granted for the death of an immediate family member.",
        "color": "#607D8B",
        "restrictions": {"gender": None, "marital_status": None},
    },
    {
        "name": "Work From Home",
        "code": "WFH",
        "unit": "DAYS",
        "is_paid": True,
        "deduct_from_balance": False,
        "is_paid_leave": True,
        "deduct_from_leave_balance": False,
        "show_description": False,
        "is_sick_leave": False,
        "is_statutory_leave": False,
        "description": "Approved remote working day.",
        "color": "#00BCD4",
        "restrictions": {"gender": None, "marital_status": None},
    }
]


async def seed() -> None:
    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL is not configured. Check your .env file.")
        return

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()
    now = datetime.now(timezone.utc)

    inserted = 0
    skipped = 0

    for lt in SYSTEM_LEAVE_TYPES:
        existing = await db[COLLECTION].find_one(
            {"org_id": None, "code": lt["code"], "deleted_on": None}
        )
        if existing:
            print(f"  SKIP  [{lt['code']}] {lt['name']} — already exists")
            skipped += 1
            continue

        doc = {
            "org_id": None,
            **lt,
            "is_active": True,
            "is_custom": False,
            "created_on": now,
            "created_by": None,
            "updated_on": None,
            "updated_by": None,
            "deleted_on": None,
            "deleted_by": None,
            "correlation_id": str(uuid.uuid4()),
        }
        await db[COLLECTION].insert_one(doc)
        print(f"  INSERT [{lt['code']}] {lt['name']}")
        inserted += 1

    print()
    print(f"Done. {inserted} inserted, {skipped} skipped.")
    client.close()


if __name__ == "__main__":
    asyncio.run(seed())
