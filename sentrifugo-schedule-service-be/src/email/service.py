from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError
from redis.asyncio import Redis

from src.email.config import email_settings
from src.email.schemas import InboxEventStatus
from src.logger import logger

if TYPE_CHECKING:
    from src.executors.base import TaskContext
    from src.executors.schemas import TaskMessage
    from src.email.schemas import EmailPayload


async def check_idempotency_cache(redis_client: Redis, tenant_id: str, idempotency_key: UUID) -> bool:
    key = f"{tenant_id}:idempotency:{idempotency_key}"
    return await redis_client.exists(key) > 0


async def set_idempotency_cache(redis_client: Redis, tenant_id: str, idempotency_key: UUID) -> None:
    key = f"{tenant_id}:idempotency:{idempotency_key}"
    await redis_client.set(key, "1", ex=email_settings.IDEMPOTENCY_TTL_SECONDS)


async def insert_inbox_event(db: AsyncIOMotorDatabase, task: TaskMessage) -> bool:
    """Insert into inbox_events with status=received. Returns False if already processed.

    If the existing record has status=failed the event is eligible for retry —
    reset it to received and return True so the consumer re-runs the executor.
    """
    try:
        await db.inbox_events.insert_one({
            "_id": str(uuid4()),
            "tenant_id": task.tenant_id,
            "idempotency_key": str(task.idempotency_key),
            "event_type": task.event_type,
            "correlation_id": str(task.correlation_id),
            "payload": task.payload,
            "status": InboxEventStatus.RECEIVED.value,
            "received_at": datetime.now(timezone.utc),
            "processed_at": None,
            "error_detail": None,
        })
        return True
    except DuplicateKeyError:
        # Atomic claim: flip a FAILED row back to RECEIVED in a SINGLE conditional
        # update and re-run only if WE won the claim (modified_count == 1). The old
        # find-then-update was a TOCTOU race — under prefetch>1, two concurrent
        # deliveries of the same key could both see FAILED, both reset, and both
        # re-run the executor (double send). The status filter makes exactly one win.
        claimed = await db.inbox_events.update_one(
            {
                "tenant_id": task.tenant_id,
                "idempotency_key": str(task.idempotency_key),
                "status": InboxEventStatus.FAILED.value,
            },
            {"$set": {
                "status": InboxEventStatus.RECEIVED.value,
                "received_at": datetime.now(timezone.utc),
                "error_detail": None,
            }},
        )
        if claimed.modified_count == 1:
            logger.info(
                "Retrying previously failed inbox event",
                tenant_id=str(task.tenant_id),
                idempotency_key=str(task.idempotency_key),
            )
            return True
        # Either already processed/received, or another delivery won the claim.
        logger.info(
            "Duplicate inbox event, skipping",
            tenant_id=str(task.tenant_id),
            idempotency_key=str(task.idempotency_key),
        )
        return False


async def mark_inbox_processed(db: AsyncIOMotorDatabase, tenant_id: str, idempotency_key: UUID) -> None:
    await db.inbox_events.update_one(
        {"tenant_id": tenant_id, "idempotency_key": str(idempotency_key)},
        {"$set": {"status": InboxEventStatus.PROCESSED.value, "processed_at": datetime.now(timezone.utc)}},
    )


async def mark_inbox_failed(db: AsyncIOMotorDatabase, tenant_id: str, idempotency_key: UUID, error_detail: str) -> None:
    await db.inbox_events.update_one(
        {"tenant_id": tenant_id, "idempotency_key": str(idempotency_key)},
        {"$set": {
            "status": InboxEventStatus.FAILED.value,
            "error_detail": error_detail,
            "processed_at": datetime.now(timezone.utc),
        }},
    )


async def insert_email_log(
    db: AsyncIOMotorDatabase, context: TaskContext, email: EmailPayload, provider_used: str = "brevo"
) -> None:
    now = datetime.now(timezone.utc)
    try:
        await db.email_log.insert_one({
            "_id": str(uuid4()),
            "tenant_id": context.tenant_id,
            "idempotency_key": str(context.idempotency_key),
            "correlation_id": str(context.correlation_id),
            "to_email": email.to,
            "template_id": email.template_id,
            "template_data": email.template_data,
            "provider_used": provider_used,
            "status": "sent",
            "attempts": 1,
            "scheduled_at": email.scheduled_at.isoformat() if email.scheduled_at else None,
            "sent_at": now,
            "created_at": now,
        })
    except DuplicateKeyError:
        # Unique index on (tenant_id, idempotency_key): a row already exists for
        # this send (a redelivery after a prior successful send). Treat as already
        # logged — raising here would fail the task and NACK-requeue it even
        # though the email went out, causing a retry loop of duplicate sends.
        logger.info(
            "Email log already exists (idempotent), skipping",
            tenant_id=context.tenant_id,
            idempotency_key=str(context.idempotency_key),
        )


async def insert_scheduled_email(db: AsyncIOMotorDatabase, context: TaskContext, email: EmailPayload) -> None:
    await db.email_log.insert_one({
        "_id": str(uuid4()),
        "tenant_id": context.tenant_id,
        "idempotency_key": str(context.idempotency_key),
        "correlation_id": str(context.correlation_id),
        "to_email": email.to,
        "template_id": email.template_id,
        "template_data": email.template_data,
        "status": "pending",
        "attempts": 0,
        "scheduled_at": email.scheduled_at.isoformat() if email.scheduled_at else None,
        "created_at": datetime.now(timezone.utc),
    })


async def check_rate_limit(redis_client: Redis, tenant_id: str, daily_limit: int | None = None) -> bool:
    """Returns True if under rate limit, False if exceeded."""
    limit = daily_limit or email_settings.DAILY_RATE_LIMIT_DEFAULT
    key = f"{tenant_id}:daily_email_count"
    count = await redis_client.get(key)
    current = int(count) if count else 0
    return current < limit


async def increment_daily_count(redis_client: Redis, tenant_id: str) -> None:
    key = f"{tenant_id}:daily_email_count"
    pipe = redis_client.pipeline()
    pipe.incr(key)
    pipe.expire(key, 86400)
    await pipe.execute()


async def resolve_provider_template(
    db: AsyncIOMotorDatabase, tenant_id: str, template_id: str, provider: str
) -> str | None:
    """Look up the provider-specific template reference from template_mappings."""
    doc = await db.template_mappings.find_one({
        "tenant_id": tenant_id,
        "template_id": template_id,
        "provider": provider,
        "is_active": True,
    })
    return doc["provider_template_ref"] if doc else None
