from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.leave_entitlements.schemas import LeaveEntitlementCreate, LeaveEntitlementUpdate
from src.logger import logger
from src.models import audit_fields_create, audit_fields_update
from src.utils import to_oid

COLLECTION = "leave_entitlement_configurations"


async def _validate_leave_plan(db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str) -> None:
    plan = await db["leave_plans"].find_one(
        {"_id": to_oid(leave_plan_id), "org_id": to_oid(org_id), "deleted_on": None}
    )
    if not plan:
        raise DomainException(
            message="Leave plan not found or does not belong to this organisation",
            code="INVALID_LEAVE_PLAN",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


async def _validate_probation_leave_type(
    db: AsyncIOMotorDatabase, leave_plan_id: str, entitlement
) -> None:
    """Every configured probation leave type must be one of the leave types
    assigned to this plan — otherwise probationers would be funded into (and
    restricted to) a type that isn't on their plan, leaving them with no usable
    leave. Active plan types come from the mapping collection and/or the plan's
    embedded leave_type_ids (mirrors list_leave_types_for_plan).

    Checked for EVERY selected type: one bad id in the set would otherwise leave
    probationers restricted to a type they can never be credited for."""
    probation = getattr(entitlement, "probation", None)
    prob_lt_ids = (
        getattr(probation, "probation_leave_type_ids", None) or []
    ) if probation else []
    if not prob_lt_ids:
        return
    plan_oid = to_oid(leave_plan_id)
    plan = await db["leave_plans"].find_one({"_id": plan_oid})
    embedded = {str(x) for x in (plan or {}).get("leave_type_ids", [])}

    for prob_lt_id in prob_lt_ids:
        if str(prob_lt_id) in embedded:
            continue
        mapping = await db["leave_plan_type_mapping"].find_one(
            {"leave_plan_id": plan_oid, "leave_type_id": to_oid(prob_lt_id)}
        )
        if mapping:
            continue
        raise DomainException(
            message="The selected probation leave type is not assigned to this leave plan",
            code="INVALID_PROBATION_LEAVE_TYPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def _prepare_entitlement_dict(entitlement_config) -> dict:
    data = entitlement_config.model_dump(mode="json")
    if data.get("clubbing", {}).get("restricted_leave_type_ids"):
        data["clubbing"]["restricted_leave_type_ids"] = [
            to_oid(i) for i in data["clubbing"]["restricted_leave_type_ids"]
        ]
    return data


async def create_leave_entitlement(
    db: AsyncIOMotorDatabase, payload: LeaveEntitlementCreate, user_id: str, org_id: str
) -> dict:
    await _validate_leave_plan(db, payload.leave_plan_id, org_id)
    await _validate_probation_leave_type(db, payload.leave_plan_id, payload.entitlement)

    existing = await db[COLLECTION].find_one(
        {"leave_plan_id": to_oid(payload.leave_plan_id), "org_id": to_oid(org_id), "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message="An entitlement configuration already exists for this leave plan",
            code="DUPLICATE_ENTITLEMENT",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "org_id": to_oid(org_id),
        "leave_plan_id": to_oid(payload.leave_plan_id),
        "entitlement": _prepare_entitlement_dict(payload.entitlement),
        "is_active": True,
        **audit_fields_create(user_id),
    }
    await db[COLLECTION].insert_one(doc)
    logger.info("Leave entitlement configuration created", config_id=str(doc["_id"]))
    await emit_audit(
        action="leave_entitlement.created",
        resource=f"leave_entitlement:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"leave_plan_id": payload.leave_plan_id},
    )
    return doc


async def get_leave_entitlements(db: AsyncIOMotorDatabase, org_id: str) -> list[dict]:
    cursor = db[COLLECTION].find(
        {"org_id": to_oid(org_id), "deleted_on": None}
    ).sort("created_on", -1)
    return await cursor.to_list(None)


async def get_leave_entitlement_by_plan(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str, must_exist: bool = True
) -> dict | None:
    # must_exist=False lets the GET route answer None for a plan that simply
    # hasn't saved this step yet (new-plan wizard); update paths keep the 404.
    doc = await db[COLLECTION].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "org_id": to_oid(org_id), "deleted_on": None}
    )
    if not doc and must_exist:
        raise DomainException(
            message="Leave entitlement configuration not found for this leave plan",
            code="ENTITLEMENT_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def update_leave_entitlement_by_plan(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: LeaveEntitlementUpdate,
    user_id: str,
    org_id: str,
) -> dict:
    existing = await get_leave_entitlement_by_plan(db, leave_plan_id, org_id)

    if payload.entitlement is not None:
        await _validate_probation_leave_type(db, leave_plan_id, payload.entitlement)

    update_data: dict = {}

    if payload.entitlement is not None:
        update_data["entitlement"] = _prepare_entitlement_dict(payload.entitlement)

    if payload.is_active is not None:
        update_data["is_active"] = payload.is_active

    if not update_data:
        return existing

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[COLLECTION].update_one({"_id": existing["_id"]}, {"$set": update_data})
    logger.info("Leave entitlement configuration updated", leave_plan_id=leave_plan_id)
    await emit_audit(
        action="leave_entitlement.updated",
        resource=f"leave_entitlement:{existing['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"leave_plan_id": leave_plan_id},
        changed_fields=changed_fields,
    )
    return await get_leave_entitlement_by_plan(db, leave_plan_id, org_id)
