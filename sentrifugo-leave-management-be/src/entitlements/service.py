import uuid
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.entitlements.schemas import LedgerEntryCreate, LeaveEntitlementCreate
from src.logger import logger
from src.models import audit_fields_create
from src.utils import to_oid
from src.balance_tracker import get_balance_from_tracker, upsert_balance

ENTITLEMENTS_COLLECTION = "leave_entitlements"
LEDGER_COLLECTION = "leave_entitlement_ledger"


async def _validate_employee(db: AsyncIOMotorDatabase, employee_id: str) -> dict:
    exists = await db["employees"].find_one({"_id": ObjectId(employee_id), "is_deleted": {"$ne": True}})
    if not exists:
        raise DomainException(
            message="Employee not found",
            code="EMPLOYEE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return exists


async def _validate_policy(db: AsyncIOMotorDatabase, policy_id: str) -> dict:
    doc = await db["entitlement_policies"].find_one({"_id": policy_id, "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Entitlement policy not found",
            code="ENTITLEMENT_POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def create_entitlement(
    db: AsyncIOMotorDatabase, payload: LeaveEntitlementCreate, user_id: str
) -> dict:
    employee = await _validate_employee(db, payload.employee_id)
    await _validate_policy(db, payload.policy_id)
    org_id = str(employee["organisation_id"]) if employee.get("organisation_id") else None

    existing = await db[ENTITLEMENTS_COLLECTION].find_one(
        {
            "employee_id": ObjectId(payload.employee_id),
            "leave_type_id": payload.leave_type_id,
            "policy_id": payload.policy_id,
            "deleted_on": None,
        }
    )
    if existing:
        raise DomainException(
            message="Entitlement already exists for this employee, leave type, and policy",
            code="DUPLICATE_ENTITLEMENT",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "_id": str(uuid.uuid4()),
        **payload.model_dump(mode="json"),
        "employee_id": ObjectId(payload.employee_id),
        **audit_fields_create(user_id),
    }
    await db[ENTITLEMENTS_COLLECTION].insert_one(doc)
    logger.info(
        "Leave entitlement created",
        entitlement_id=doc["_id"],
        employee_id=payload.employee_id,
    )
    await emit_audit(
        action="entitlement.created",
        resource=f"entitlement:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={
            "employee_id": payload.employee_id,
            "leave_type_id": payload.leave_type_id,
            "policy_id": payload.policy_id,
        },
    )
    return doc


async def get_entitlements_for_employee(
    db: AsyncIOMotorDatabase, employee_id: str
) -> list[dict]:
    cursor = db[ENTITLEMENTS_COLLECTION].find(
        {"employee_id": ObjectId(employee_id), "deleted_on": None}
    )
    return await cursor.to_list(length=None)


async def add_ledger_entry(
    db: AsyncIOMotorDatabase, payload: LedgerEntryCreate, user_id: str
) -> dict:
    employee = await _validate_employee(db, payload.employee_id)
    org_id = str(employee["organisation_id"]) if employee.get("organisation_id") else None
    now = datetime.now(timezone.utc)
    doc = {
        "_id": str(uuid.uuid4()),
        **payload.model_dump(mode="json"),
        "employee_id": ObjectId(payload.employee_id),
        "created_on": now,
        "created_by": user_id,
    }
    await db[LEDGER_COLLECTION].insert_one(doc)

    # Keep the spendable balance tracker (keyed by user_id, in HOURS) in sync with
    # this manual ledger adjustment — otherwise the change shows in the ledger/reports
    # but the apply-engine (which reads the tracker) never sees it. The ledger `amount`
    # is already stored in hours and is always positive; the transaction_type decides
    # the sign, matching compute_balance: CREDIT/ADJUSTMENT/REVERSAL add, DEBIT subtracts.
    emp_user_id = employee.get("user_id")
    if emp_user_id is not None:
        emp_plan = await db["employee_leave_plans"].find_one(
            {"employee_id": ObjectId(payload.employee_id)}
        )
        leave_plan_id = emp_plan["leave_plan_id"] if emp_plan else None
        delta_hours = -payload.amount if payload.transaction_type == "DEBIT" else payload.amount
        await upsert_balance(
            db, str(emp_user_id), payload.leave_type_id, leave_plan_id, delta_hours, user_id, now
        )

    logger.info(
        "Ledger entry added",
        ledger_id=doc["_id"],
        transaction_type=payload.transaction_type,
        amount=payload.amount,
        employee_id=payload.employee_id,
    )
    # Direct admin mutation of an employee's leave balance — compliance audit.
    await emit_audit(
        action="entitlement.ledger_adjusted",
        resource=f"entitlement_ledger:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={
            "employee_id": payload.employee_id,
            "leave_type_id": payload.leave_type_id,
            "transaction_type": payload.transaction_type,
            "amount": payload.amount,
        },
    )
    return doc


async def get_ledger_entries(
    db: AsyncIOMotorDatabase,
    employee_id: str,
    leave_type_id: Optional[str] = None,
) -> list[dict]:
    query: dict = {"employee_id": ObjectId(employee_id)}
    if leave_type_id:
        query["leave_type_id"] = leave_type_id
    cursor = db[LEDGER_COLLECTION].find(query).sort("created_on", -1)
    return await cursor.to_list(length=None)


async def credit_leave_balance(
    db: AsyncIOMotorDatabase, payload, actor_id: str, actor_org_id: Optional[str] = None
) -> dict:
    exists = await db["employees"].find_one({"user_id": ObjectId(payload.user_id), "is_deleted": {"$ne": True}})
    if not exists:
        raise DomainException(
            message="Employee not found",
            code="EMPLOYEE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    # Tenant isolation: the target employee must belong to the caller's org.
    target_org_id = str(exists["organisation_id"]) if exists.get("organisation_id") else None
    if not actor_org_id or target_org_id != str(actor_org_id):
        raise DomainException(
            message="Employee does not belong to your organisation",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    leave_type = await db["leave_types"].find_one({"_id": to_oid(payload.leave_type_id), "deleted_on": None})
    if not leave_type:
        raise DomainException(
            message="Leave type not found",
            code="LEAVE_TYPE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    emp_plan = await db["employee_leave_plans"].find_one({"employee_id": ObjectId(payload.user_id)})
    leave_plan_id = emp_plan["leave_plan_id"] if emp_plan else None

    hours = payload.days * 8.0
    now = datetime.now(timezone.utc)
    doc = {
        "_id": str(uuid.uuid4()),
        "user_id": ObjectId(payload.user_id),
        "leave_type_id": payload.leave_type_id,
        "transaction_type": "CREDIT",
        "amount": hours,
        "reference_id": None,
        "note": payload.note,
        "created_on": now,
        "created_by": actor_id,
    }
    await db[LEDGER_COLLECTION].insert_one(doc)
    await upsert_balance(db, payload.user_id, payload.leave_type_id, leave_plan_id, hours, actor_id, now)
    logger.info("Leave balance credited", ledger_id=doc["_id"], days=payload.days, user_id=payload.user_id)

    # Admin manually credits leave days — financially-material balance change.
    await emit_audit(
        action="entitlement.credited",
        resource=f"entitlement_ledger:{doc['_id']}",
        actor_id=actor_id,
        organisation_id=str(exists["organisation_id"]) if exists.get("organisation_id") else None,
        details={
            "user_id": str(payload.user_id),
            "leave_type_id": str(payload.leave_type_id),
            "leave_plan_id": str(leave_plan_id) if leave_plan_id is not None else None,
            "days": payload.days,
            "hours": hours,
            "note": payload.note,
        },
    )

    balance_hours = await get_balance_from_tracker(db, payload.user_id, payload.leave_type_id) or 0.0
    return {
        **doc,
        "user_id": payload.user_id,
        "days_credited": payload.days,
        "hours_credited": hours,
        "balance_after": balance_hours / 8.0,
    }


async def compute_balance(
    db: AsyncIOMotorDatabase, employee_id: str, leave_type_id: str
) -> dict:
    """
    balance = SUM(CREDITS + ADJUSTMENTS) - (SUM(DEBITS) - SUM(REVERSALS))
    """
    pipeline = [
        {"$match": {"employee_id": ObjectId(employee_id), "leave_type_id": leave_type_id}},
        {
            "$group": {
                "_id": None,
                "total_credited": {
                    "$sum": {
                        "$cond": [
                            {"$in": ["$transaction_type", ["CREDIT", "ADJUSTMENT"]]},
                            "$amount",
                            0,
                        ]
                    }
                },
                "total_debited": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$transaction_type", "DEBIT"]},
                            "$amount",
                            0,
                        ]
                    }
                },
                "total_reversed": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$transaction_type", "REVERSAL"]},
                            "$amount",
                            0,
                        ]
                    }
                },
            }
        },
    ]
    results = await db[LEDGER_COLLECTION].aggregate(pipeline).to_list(length=1)
    if not results:
        return {
            "employee_id": employee_id,
            "leave_type_id": leave_type_id,
            "total_credited": 0.0,
            "total_debited": 0.0,
            "balance": 0.0,
        }

    row = results[0]
    total_credited = row["total_credited"]
    total_debited = row["total_debited"] - row["total_reversed"]
    return {
        "employee_id": employee_id,
        "leave_type_id": leave_type_id,
        "total_credited": total_credited,
        "total_debited": total_debited,
        "balance": total_credited - total_debited,
    }
