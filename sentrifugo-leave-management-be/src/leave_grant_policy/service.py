from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.leave_grant_policy.schemas import GrantPolicyCreate, GrantPolicyUpdate
from src.logger import logger
from src.models import audit_fields_create, audit_fields_update
from src.utils import to_oid

COLLECTION = "leave_grant_policy"
PLANS_COLLECTION = "leave_plans"
ENTITLEMENT_COLLECTION = "leave_entitlement_configurations"

# Grant policy is step 2 in the leave plan wizard
GRANT_POLICY_STEP = 2


async def _mirror_into_entitlement(
    db: AsyncIOMotorDatabase, plan_id, payload: GrantPolicyCreate | GrantPolicyUpdate, user_id: str
) -> None:
    """
    Mirror the relocated grant fields (joining_rule, extra_leave) into the
    plan's entitlement config, which now owns them. No-op when the entitlement
    doc doesn't exist yet — the grant step can run before the entitlement step,
    so the grant collection still holds them and the processor/overview fall
    back to it.
    """
    set_fields: dict = {}
    if payload.joining_rule is not None:
        set_fields["entitlement.joining_rule"] = payload.joining_rule.model_dump(mode="json")
    if payload.extra_leave is not None:
        set_fields["entitlement.extra_leave"] = payload.extra_leave.model_dump(mode="json")
    if not set_fields:
        return
    set_fields.update(audit_fields_update(user_id))
    await db[ENTITLEMENT_COLLECTION].update_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None},
        {"$set": set_fields},
    )


async def _get_policy_or_raise(db: AsyncIOMotorDatabase, policy_id: str) -> dict:
    doc = await db[COLLECTION].find_one({"_id": to_oid(policy_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Grant policy not found",
            code="GRANT_POLICY_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def _get_plan_or_raise(db: AsyncIOMotorDatabase, plan_id: str) -> dict:
    doc = await db[PLANS_COLLECTION].find_one({"_id": to_oid(plan_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


def _serialize(doc: dict) -> dict:
    return {
        **doc,
        "_id": str(doc["_id"]),
        "org_id": str(doc["org_id"]),
        "leave_plan_id": str(doc["leave_plan_id"]),
    }


def _policy_fields(payload: GrantPolicyCreate | GrantPolicyUpdate) -> dict:
    data = {}
    if payload.allocation is not None:
        data["allocation"] = payload.allocation.model_dump(mode="json")
    if payload.credited_year_usage is not None:
        data["credited_year_usage"] = payload.credited_year_usage.model_dump(mode="json")
    if payload.joining_rule is not None:
        data["joining_rule"] = payload.joining_rule.model_dump(mode="json")
    if payload.extra_leave is not None:
        data["extra_leave"] = payload.extra_leave.model_dump(mode="json")
    return data


async def _bump_plan_progress(
    db: AsyncIOMotorDatabase, plan_id: str, current_progress: int, user_id: str
) -> None:
    if current_progress < GRANT_POLICY_STEP:
        await db[PLANS_COLLECTION].update_one(
            {"_id": to_oid(plan_id)},
            {"$set": {"progress": GRANT_POLICY_STEP, **audit_fields_update(user_id)}},
        )


async def upsert_grant_policy(
    db: AsyncIOMotorDatabase, plan_id: str, payload: GrantPolicyCreate, user_id: str
) -> dict:
    plan = await _get_plan_or_raise(db, plan_id)

    existing = await db[COLLECTION].find_one(
        {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
    )

    if existing:
        update_data = _policy_fields(payload)
        changed_fields = list(update_data.keys())
        update_data["version"] = existing.get("version", 1) + 1
        update_data.update(audit_fields_update(user_id))
        await db[COLLECTION].update_one({"_id": existing["_id"]}, {"$set": update_data})
        doc = await db[COLLECTION].find_one({"_id": existing["_id"]})
        logger.info("Grant policy updated (upsert)", plan_id=plan_id, version=update_data["version"])
        await emit_audit(
            action="grant_policy.updated",
            resource=f"grant_policy:{existing['_id']}",
            actor_id=user_id,
            organisation_id=str(plan["org_id"]),
            details={"leave_plan_id": plan_id, "version": update_data["version"]},
            changed_fields=changed_fields,
        )
    else:
        doc = {
            "org_id": plan["org_id"],
            "leave_plan_id": to_oid(plan_id),
            **_policy_fields(payload),
            "version": 1,
            "is_active": True,
            **audit_fields_create(user_id),
        }
        await db[COLLECTION].insert_one(doc)
        logger.info("Grant policy created (upsert)", plan_id=plan_id, policy_id=str(doc["_id"]))
        await emit_audit(
            action="grant_policy.created",
            resource=f"grant_policy:{doc['_id']}",
            actor_id=user_id,
            organisation_id=str(plan["org_id"]),
            details={"leave_plan_id": plan_id},
        )

    await _mirror_into_entitlement(db, plan_id, payload, user_id)
    await _bump_plan_progress(db, plan_id, plan.get("progress", 1), user_id)
    return _serialize(doc)


async def get_policy_by_plan(
    db: AsyncIOMotorDatabase, plan_id: str, must_exist: bool = True
) -> dict | None:
    # must_exist=False lets the GET route answer None for a plan that simply
    # hasn't saved this step yet (new-plan wizard).
    doc = await db[COLLECTION].find_one(
        {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
    )
    if not doc:
        if must_exist:
            raise DomainException(
                message="No active grant policy found for this leave plan",
                code="GRANT_POLICY_NOT_FOUND",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return None
    return _serialize(doc)


async def update_grant_policy(
    db: AsyncIOMotorDatabase, policy_id: str, payload: GrantPolicyUpdate, user_id: str
) -> dict:
    existing = await _get_policy_or_raise(db, policy_id)

    update_data = _policy_fields(payload)
    if not update_data:
        return _serialize(existing)

    changed_fields = list(update_data.keys())
    update_data["version"] = existing.get("version", 1) + 1
    update_data.update(audit_fields_update(user_id))
    await db[COLLECTION].update_one({"_id": existing["_id"]}, {"$set": update_data})
    await _mirror_into_entitlement(db, existing["leave_plan_id"], payload, user_id)
    logger.info("Grant policy updated", policy_id=policy_id, version=update_data["version"])
    await emit_audit(
        action="grant_policy.updated",
        resource=f"grant_policy:{policy_id}",
        actor_id=user_id,
        organisation_id=str(existing["org_id"]) if existing.get("org_id") else None,
        details={"version": update_data["version"]},
        changed_fields=changed_fields,
    )
    return _serialize(await db[COLLECTION].find_one({"_id": existing["_id"]}))
