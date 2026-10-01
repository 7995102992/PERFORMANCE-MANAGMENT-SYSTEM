from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.logger import logger
from src.models import audit_fields_create, audit_fields_update
from src.utils import to_oid
from src.year_end_processing.calculation_service import calculate
from src.year_end_processing.execution_service import run_year_end_execution
from src.year_end_processing.schemas import (
    ExecuteYearEndRequest,
    ExecuteYearEndResponse,
    PreviewResult,
    PreviewYearEndRequest,
    YearEndProcessingCreate,
    YearEndProcessingUpdate,
)
from src.year_end_processing.schemas import ProcessingType
from src.year_end_processing.validation_service import (
    _validate_carry_forward_expire_config,
    validate_create_payload,
    validate_payout_carry_config,
)

CONFIG_COLLECTION = "leave_plan_year_end_processing"


async def _get_plan_or_raise(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str | None = None
) -> dict:
    query: dict = {"_id": to_oid(leave_plan_id), "deleted_on": None}
    if org_id:
        # Tenant isolation: only resolve plans in the caller's org.
        # org_id is stored inconsistently (ObjectId vs string) — match both.
        query["org_id"] = {"$in": [to_oid(org_id), str(org_id)]}
    doc = await db["leave_plans"].find_one(query)
    if not doc:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def create_config(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: YearEndProcessingCreate,
    user_id: str,
    org_id: str | None = None,
) -> dict:
    plan = await _get_plan_or_raise(db, leave_plan_id, org_id)
    validate_create_payload(payload)

    existing = await db[CONFIG_COLLECTION].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message="Year-end processing config already exists for this leave plan",
            code="DUPLICATE_YEAR_END_CONFIG",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        **payload.model_dump(mode="json"),
        "leave_plan_id": to_oid(leave_plan_id),
        **audit_fields_create(user_id),
    }
    result = await db[CONFIG_COLLECTION].insert_one(doc)
    logger.info("Year-end processing config created", leave_plan_id=leave_plan_id)
    new_id = str(result.inserted_id)
    await emit_audit(
        action="year_end_config.created",
        resource=f"year_end_config:{new_id}",
        actor_id=user_id,
        organisation_id=str(plan["org_id"]) if plan.get("org_id") else None,
    )
    return doc


async def get_config(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: str | None = None
) -> dict:
    if org_id:
        # Ensure the plan belongs to the caller's org before reading its config.
        await _get_plan_or_raise(db, leave_plan_id, org_id)
    doc = await db[CONFIG_COLLECTION].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "deleted_on": None}
    )
    if not doc:
        raise DomainException(
            message="Year-end processing config not found for this leave plan",
            code="YEAR_END_CONFIG_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def update_config(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: YearEndProcessingUpdate,
    user_id: str,
    org_id: str | None = None,
) -> dict:
    existing = await get_config(db, leave_plan_id, org_id)

    update_data = payload.model_dump(exclude_none=True, mode="json")
    if not update_data:
        return existing

    if "payout_carry_config" in update_data and payload.payout_carry_config:
        # Validate against the effective processing type (payload override, else
        # the stored one) so CARRY_FORWARD_EXPIRE still requires a max_carry_limit
        # on update — otherwise a null limit would crash the year-end run.
        effective_type = payload.processing_type or existing.get("processing_type")
        if effective_type == ProcessingType.CARRY_FORWARD_EXPIRE:
            _validate_carry_forward_expire_config(payload.payout_carry_config)
        else:
            validate_payout_carry_config(payload.payout_carry_config)

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[CONFIG_COLLECTION].update_one(
        {"_id": existing["_id"]}, {"$set": update_data}
    )
    logger.info("Year-end processing config updated", leave_plan_id=leave_plan_id)
    config_id = str(existing["_id"])
    plan = await _get_plan_or_raise(db, leave_plan_id, org_id)
    await emit_audit(
        action="year_end_config.updated",
        resource=f"year_end_config:{config_id}",
        actor_id=user_id,
        organisation_id=str(plan["org_id"]) if plan.get("org_id") else None,
        changed_fields=changed_fields,
    )
    return await get_config(db, leave_plan_id, org_id)


async def preview(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: PreviewYearEndRequest,
    org_id: str | None = None,
) -> PreviewResult:
    await _get_plan_or_raise(db, leave_plan_id, org_id)
    config_doc = await db[CONFIG_COLLECTION].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "deleted_on": None}
    ) or {}

    processing_type = config_doc.get("processing_type") or "CARRY_FORWARD_ALL"
    raw_config = config_doc.get("payout_carry_config")
    negative_rule = config_doc.get("negative_balance_rule") or "RESET_TO_ZERO"
    balance = payload.mock_balance

    negative_recovered = 0.0
    payout = 0.0
    carry = 0.0
    expired = 0.0
    logs: list[str] = []

    if balance < 0:
        logs.append(f"Negative balance: {balance}")
        if negative_rule in ("RESET_TO_ZERO", "DEDUCT_FROM_PAYROLL"):
            negative_recovered = abs(balance)
            logs.append(f"{negative_rule}: negative balance recovered = {negative_recovered}")
        else:
            logs.append("CARRY_FORWARD_DEFICIT: negative balance carried forward")
        closing_balance = 0.0 if negative_rule != "CARRY_FORWARD_DEFICIT" else balance
    else:
        from src.year_end_processing.schemas import PayoutCarryConfig
        pcc = PayoutCarryConfig(**raw_config) if raw_config else None
        payout, carry, expired, logs = calculate(processing_type, balance, pcc)
        closing_balance = carry

    return PreviewResult(
        opening_balance=balance,
        payout_amount=payout,
        carry_forward_amount=carry,
        expired_amount=expired,
        negative_recovered_amount=negative_recovered,
        closing_balance=closing_balance,
        logs=logs,
    )


async def execute(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    payload: ExecuteYearEndRequest,
    user_id: str,
    org_id: str | None = None,
) -> ExecuteYearEndResponse:
    # Year-end behaviour is defined on each leave type now; a plan-level config
    # doc is optional (legacy). Fall back to safe defaults when absent — the
    # engine derives carry/payout/expire per leave type regardless.
    await _get_plan_or_raise(db, leave_plan_id, org_id)
    config_doc = await db[CONFIG_COLLECTION].find_one(
        {"leave_plan_id": to_oid(leave_plan_id), "deleted_on": None}
    ) or {}

    processing_type = config_doc.get("processing_type") or "CARRY_FORWARD_ALL"
    raw_config = config_doc.get("payout_carry_config")
    negative_rule = config_doc.get("negative_balance_rule") or "RESET_TO_ZERO"

    from src.year_end_processing.schemas import PayoutCarryConfig
    pcc = PayoutCarryConfig(**raw_config) if raw_config else None

    result = await run_year_end_execution(
        db=db,
        leave_plan_id=leave_plan_id,
        year=payload.year,
        processing_type=processing_type,
        payout_carry_config=pcc,
        negative_balance_rule=negative_rule,
        dry_run=payload.dry_run,
        user_id=user_id,
    )

    return ExecuteYearEndResponse(**result)
