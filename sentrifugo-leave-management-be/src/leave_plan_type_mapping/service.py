import uuid

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.leave_plans.service import _assert_plan_pending, assert_leave_types_removable
from src.logger import logger
from src.models import audit_fields_create
from src.utils import to_oid
COLLECTION = "leave_plan_type_mapping"
LEAVE_PLANS_COLLECTION = "leave_plans"
LEAVE_TYPES_COLLECTION = "leave_types"


async def _get_plan_or_raise(db: AsyncIOMotorDatabase, plan_id: str) -> dict:
    doc = await db[LEAVE_PLANS_COLLECTION].find_one({"_id": to_oid(plan_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def _get_leave_type_or_raise(db: AsyncIOMotorDatabase, leave_type_id: str) -> dict:
    doc = await db[LEAVE_TYPES_COLLECTION].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Leave type not found",
            code="LEAVE_TYPE_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def add_leave_type_to_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    leave_type_id: str,
    org_id: str,
    user_id: str,
) -> dict:
    plan = await _get_plan_or_raise(db, plan_id)
    if str(plan["org_id"]) != org_id:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    await _get_leave_type_or_raise(db, leave_type_id)

    existing = await db[COLLECTION].find_one(
        {"leave_plan_id": to_oid(plan_id), "leave_type_id": to_oid(leave_type_id)}
    )
    if existing:
        raise DomainException(
            message="Leave type is already added to this plan",
            code="DUPLICATE_PLAN_TYPE_MAPPING",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "leave_plan_id": to_oid(plan_id),
        "leave_type_id": to_oid(leave_type_id),
        "org_id": to_oid(org_id),
        **audit_fields_create(user_id),
    }
    await db[COLLECTION].insert_one(doc)
    logger.info("Leave type added to plan", plan_id=plan_id, leave_type_id=leave_type_id)
    await emit_audit(
        action="leave_plan_type_mapping.created",
        resource=f"leave_plan_type_mapping:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"leave_plan_id": plan_id, "leave_type_id": leave_type_id},
    )
    return doc


async def remove_leave_type_from_plan(
    db: AsyncIOMotorDatabase,
    plan_id: str,
    leave_type_id: str,
    org_id: str,
) -> None:
    plan = await _get_plan_or_raise(db, plan_id)
    if str(plan["org_id"]) != org_id:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    # An active plan's type list is frozen (same rule the bulk save path applies),
    # and a type a later step points at cannot be dropped from under it.
    _assert_plan_pending(plan)
    await assert_leave_types_removable(db, plan_id, [leave_type_id])

    mapping_filter = {
        "leave_plan_id": to_oid(plan_id),
        "leave_type_id": to_oid(leave_type_id),
        "org_id": to_oid(org_id),
    }
    existing = await db[COLLECTION].find_one(mapping_filter)
    result = await db[COLLECTION].delete_one(mapping_filter)
    # The type may have been attached via the plan document instead of a mapping
    # row — detach it there too, so both write paths agree on what came off.
    pulled = await db[LEAVE_PLANS_COLLECTION].update_one(
        {"_id": to_oid(plan_id)},
        {"$pull": {"leave_type_ids": to_oid(leave_type_id)}},
    )
    if result.deleted_count == 0 and pulled.modified_count == 0:
        raise DomainException(
            message="Mapping not found",
            code="PLAN_TYPE_MAPPING_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    logger.info("Leave type removed from plan", plan_id=plan_id, leave_type_id=leave_type_id)
    mapping_id = str(existing["_id"]) if existing else None
    await emit_audit(
        action="leave_plan_type_mapping.deleted",
        resource=f"leave_plan_type_mapping:{mapping_id}",
        actor_id=None,
        organisation_id=org_id,
        details={"leave_plan_id": plan_id, "leave_type_id": leave_type_id},
    )


async def list_leave_types_for_plan(
    db: AsyncIOMotorDatabase, plan_id: str, org_id: str
) -> list[dict]:
    from datetime import datetime, timezone

    plan = await _get_plan_or_raise(db, plan_id)

    # Collect IDs from both sources so the endpoint works regardless of which
    # write path was used (embedded on plan vs. separate mapping collection).
    mapping_docs = await db[COLLECTION].find(
        {"leave_plan_id": to_oid(plan_id)},
    ).to_list(length=None)
    mapping_by_lt: dict = {str(doc["leave_type_id"]): doc for doc in mapping_docs}

    embedded_ids: list = [str(lt_id) for lt_id in plan.get("leave_type_ids", [])]

    all_lt_ids = list({*mapping_by_lt.keys(), *embedded_ids})
    if not all_lt_ids:
        return []

    leave_types = await db[LEAVE_TYPES_COLLECTION].find(
        {"_id": {"$in": [to_oid(lt_id) for lt_id in all_lt_ids]}, "deleted_on": None}
    ).to_list(length=None)

    fallback_ts = plan.get("created_on") or datetime.now(timezone.utc)
    fallback_by = plan.get("created_by")
    plan_id_str = plan_id
    org_id_str = str(plan.get("org_id", org_id))

    result = []
    for lt in leave_types:
        lt_id_str = str(lt["_id"])
        m = mapping_by_lt.get(lt_id_str)
        result.append({
            "_id": str(m["_id"]) if m else lt_id_str,
            "leave_plan_id": plan_id_str,
            "org_id": org_id_str,
            "leave_type": {
                "_id": lt_id_str,
                "name": lt.get("name", ""),
                "code": lt.get("code", ""),
                "unit": lt.get("unit", "DAYS"),
                "is_custom": lt.get("is_custom", False),
                "is_paid": lt.get("is_paid", True),
                "is_paid_leave": lt.get("is_paid_leave", True),
                "deduct_from_balance": lt.get("deduct_from_balance", True),
                "deduct_from_leave_balance": lt.get("deduct_from_leave_balance", True),
                "is_sick_leave": lt.get("is_sick_leave", False),
                "is_statutory_leave": lt.get("is_statutory_leave", False),
                "max_statutory_days": lt.get("max_statutory_days"),
                "show_description": lt.get("show_description", False),
                "restrictions": lt.get("restrictions", {}),
                "is_active": lt.get("is_active", True),
                "description": lt.get("description"),
                "color": lt.get("color"),
                # The leave type now owns its accrual + carry config; surface it
                # so the plan wizard (assign step, year-end summary) can show it.
                "accrual": lt.get("accrual"),
                "policies": lt.get("policies"),
            },
            "created_on": m["created_on"] if m else fallback_ts,
            "created_by": m.get("created_by") if m else fallback_by,
            "updated_on": m.get("updated_on") if m else None,
            "updated_by": m.get("updated_by") if m else None,
            "deleted_on": None,
            "deleted_by": None,
        })

    return result
