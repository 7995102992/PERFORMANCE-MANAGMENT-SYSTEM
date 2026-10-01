from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.leave_policy.schemas import ApprovalPolicyUpsert, SandwichPolicyUpsert
from src.logger import logger
from src.models import audit_fields_create, audit_fields_update
from src.utils import to_oid

SANDWICH_COLLECTION = "leave_sandwich_policies"
APPROVAL_COLLECTION = "leave_approval_policies"


async def _validate_leave_plan(db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str) -> None:
    plan = await db["leave_plans"].find_one(
        {"_id": to_oid(leave_plan_id), "org_id": to_oid(org_id), "deleted_on": None}
    )
    if not plan:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )


# ---------------------------------------------------------------------------
# Sandwich Policy
# ---------------------------------------------------------------------------

async def get_sandwich_policy(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str
) -> dict:
    await _validate_leave_plan(db, leave_plan_id, org_id)
    doc = await db[SANDWICH_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})
    if not doc:
        raise DomainException(
            message="Sandwich policy not configured for this leave plan",
            code="SANDWICH_POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def upsert_sandwich_policy(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: SandwichPolicyUpsert,
    user_id: str,
    org_id: str,
) -> dict:
    await _validate_leave_plan(db, leave_plan_id, org_id)
    existing = await db[SANDWICH_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})

    if existing:
        payload_data = payload.model_dump(mode="json")
        update_data = {
            **payload_data,
            **audit_fields_update(user_id),
        }
        await db[SANDWICH_COLLECTION].update_one(
            {"leave_plan_id": to_oid(leave_plan_id)},
            {"$set": update_data},
        )
        logger.info("Sandwich policy updated", leave_plan_id=leave_plan_id)
        await emit_audit(
            action="sandwich_policy.updated",
            resource=f"sandwich_policy:{existing['_id']}",
            actor_id=user_id,
            organisation_id=org_id,
            details={"leave_plan_id": leave_plan_id},
            changed_fields=list(payload_data.keys()),
        )
    else:
        doc = {
            "leave_plan_id": to_oid(leave_plan_id),
            **payload.model_dump(mode="json"),
            **audit_fields_create(user_id),
        }
        await db[SANDWICH_COLLECTION].insert_one(doc)
        logger.info("Sandwich policy created", leave_plan_id=leave_plan_id)
        await emit_audit(
            action="sandwich_policy.created",
            resource=f"sandwich_policy:{doc['_id']}",
            actor_id=user_id,
            organisation_id=org_id,
            details={"leave_plan_id": leave_plan_id},
        )

    return await db[SANDWICH_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})


# ---------------------------------------------------------------------------
# Approval Policy
# ---------------------------------------------------------------------------

async def get_approval_policy(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str
) -> dict:
    await _validate_leave_plan(db, leave_plan_id, org_id)
    doc = await db[APPROVAL_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})
    if not doc:
        raise DomainException(
            message="Approval policy not configured for this leave plan",
            code="APPROVAL_POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def upsert_approval_policy(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: ApprovalPolicyUpsert,
    user_id: str,
    org_id: str,
) -> dict:
    await _validate_leave_plan(db, leave_plan_id, org_id)
    levels = [lvl.model_dump(mode="json") for lvl in payload.approval_levels]
    existing = await db[APPROVAL_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})

    if existing:
        update_data = {
            "approval_required": payload.approval_required,
            "approval_levels": levels,
            "levels_operator": payload.levels_operator,
            "allow_hr_to_act": payload.allow_hr_to_act,
            "allow_hr_to_view": payload.allow_hr_to_view,
            **audit_fields_update(user_id),
        }
        await db[APPROVAL_COLLECTION].update_one(
            {"leave_plan_id": to_oid(leave_plan_id)},
            {"$set": update_data},
        )
        logger.info("Approval policy updated", leave_plan_id=leave_plan_id)
        await emit_audit(
            action="approval_policy.updated",
            resource=f"approval_policy:{existing['_id']}",
            actor_id=user_id,
            organisation_id=org_id,
            details={"leave_plan_id": leave_plan_id},
            changed_fields=[
                "approval_required",
                "approval_levels",
                "levels_operator",
                "allow_hr_to_act",
                "allow_hr_to_view",
            ],
        )
    else:
        doc = {
            "leave_plan_id": to_oid(leave_plan_id),
            "approval_required": payload.approval_required,
            "approval_levels": levels,
            "levels_operator": payload.levels_operator,
            "allow_hr_to_act": payload.allow_hr_to_act,
            "allow_hr_to_view": payload.allow_hr_to_view,
            **audit_fields_create(user_id),
        }
        await db[APPROVAL_COLLECTION].insert_one(doc)
        logger.info("Approval policy created", leave_plan_id=leave_plan_id)
        await emit_audit(
            action="approval_policy.created",
            resource=f"approval_policy:{doc['_id']}",
            actor_id=user_id,
            organisation_id=org_id,
            details={"leave_plan_id": leave_plan_id},
        )

    return await db[APPROVAL_COLLECTION].find_one({"leave_plan_id": to_oid(leave_plan_id)})
