"""Transactional outbox — the single entry point for all RabbitMQ publishing.

Every message we send to RabbitMQ (domain events, audit logs, email events)
goes through this module. Each publish is persisted to the ``outbox_events``
collection first, so if RabbitMQ is down (or flapping) the message is not
lost — the background relay loop drains pending events and forwards them
once the broker is reachable again.

Usage from any service::

    from src.rabbitmq import outbox

    # generic domain event
    await outbox.publish("srm.request.submitted", payload, idempotency_key=req_id)

    # audit log
    await outbox.publish_audit_log(
        module="requests", actor_id=uid, action="created", resource=f"request:{rid}",
    )

Consumers MUST be idempotent — use the ``idempotency_key`` header to
deduplicate (delivery is at-least-once).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from uuid import uuid4

import aio_pika
from pymongo.errors import DuplicateKeyError

from src.models import OutboxEventDocument
from src.rabbitmq import connection
from src.rabbitmq.constants import (
    DebugLevel,
    audit_logging_config,
    domain_events_config,
)

logger = logging.getLogger(__name__)

# ── Relay lifecycle ──────────────────────────────────────────────────────────
_relay_task: asyncio.Task | None = None


async def start_relay() -> None:
    """Start the background outbox relay loop."""
    global _relay_task
    _relay_task = asyncio.create_task(_relay_loop())
    logger.info("Outbox relay started")


async def stop_relay() -> None:
    """Gracefully cancel the relay loop."""
    if _relay_task and not _relay_task.done():
        _relay_task.cancel()
        try:
            await _relay_task
        except asyncio.CancelledError:
            pass
    logger.info("Outbox relay stopped")


# ── Public API ───────────────────────────────────────────────────────────────

ROUTING_KEYS = {
    "submitted": "srm.request.submitted",
    "approval_decided": "srm.request.approval.decided",
    "assigned": "srm.request.assigned",
    "escalated": "srm.request.escalated",
    "sla_warning": "srm.request.sla.warning",
    "sla_breached": "srm.request.sla.breached",
    "resolved": "srm.request.resolved",
    "closed": "srm.request.closed",
    "rejected": "srm.request.rejected",
    "comment_added": "srm.request.comment.added",
    "executor_assigned": "srm.request.assigned",
    "approval_pending": "srm.request.approval.pending",
}


async def publish(
    event_type: str,
    payload: dict,
    *,
    idempotency_key: str,
    exchange: str = domain_events_config.EXCHANGE_NAME,
) -> str:
    """Persist an event to the outbox and best-effort eager-publish.

    Returns the outbox event id. The relay will pick it up if the eager
    publish fails or RabbitMQ is currently unreachable.
    """
    now = datetime.now(timezone.utc)
    event = OutboxEventDocument(
        idempotency_key=idempotency_key,
        exchange=exchange,
        event_type=event_type,
        payload=payload,
        status="pending",
        retries=0,
        created_at=now,
    )
    try:
        await event.insert()
    except DuplicateKeyError:
        # idempotency_key is uniquely indexed — a retry/replay with the same key
        # means this event is already in the outbox. Return the existing id
        # instead of failing the caller (idempotent publish).
        logger.info(
            "Outbox event already exists (idempotent) idempotency_key=%s event_type=%s",
            idempotency_key, event_type,
        )
        existing = await OutboxEventDocument.find_one(
            OutboxEventDocument.idempotency_key == idempotency_key
        )
        return existing.id if existing else None
    logger.info("Outbox event persisted event_id=%s event_type=%s", event.id, event_type)

    if await _try_publish(event):
        event.status = "sent"
        event.sent_at = datetime.now(timezone.utc)
        await event.save()

    return event.id


async def publish_event(event_key: str, payload: dict) -> str:
    """Drop-in replacement for the old fire-and-forget publish_event().

    Resolves the routing key from ROUTING_KEYS and publishes via the outbox.
    """
    routing_key = ROUTING_KEYS.get(event_key, f"srm.request.{event_key}")
    idemp_key = f"srm:{event_key}:{uuid4()}"
    return await publish(routing_key, payload, idempotency_key=idemp_key)


async def publish_audit_log(
    *,
    module: str,
    actor_id: str,
    action: str,
    resource: str,
    debug_level: DebugLevel = DebugLevel.ADMIN,
    metadata: dict | None = None,
) -> str | None:
    """Publish an audit event via the outbox.

    Bypass-proof: any failure is logged and swallowed (returns ``None``) so a
    failed audit never breaks the caller. The per-call-site ``try/except``
    blocks remain as defence-in-depth but are no longer required for safety.
    """
    try:
        event_id = str(uuid4())
        # Collapse dots in `action` so the routing key stays a single segment after
        # "audit." — the Logging Service binds "audit.*", which matches exactly one
        # segment. A dotted action like "workflow.activated" would otherwise produce
        # "audit.workflow.activated" (3 segments) and be silently dropped. The
        # payload's `action` field below keeps the original dotted value for display.
        return await publish(
            f"audit.{action.replace('.', '_')}",
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "module": module,
                "actor_id": actor_id,
                "action": action,
                "resource": resource,
                "debug_level": int(debug_level),
                "metadata": metadata,
            },
            idempotency_key=f"audit:{event_id}",
            exchange=audit_logging_config.EXCHANGE_NAME,
        )
    except Exception as exc:  # noqa: BLE001 — audit must never break the operation
        logger.warning(
            "Audit emit failed (non-blocking)",
            action=action,
            error=repr(exc),
        )
        return None


# ── Internal helpers ─────────────────────────────────────────────────────────

async def _try_publish(event: OutboxEventDocument) -> bool:
    """Attempt to publish a single outbox event to RabbitMQ. Returns True on
    success."""
    if not await connection.ensure_ready():
        return False

    try:
        async with connection.rabbitmq_connection.channel() as channel:
            exchange = await channel.declare_exchange(
                event.exchange, aio_pika.ExchangeType.TOPIC, durable=True,
            )
            await exchange.publish(
                aio_pika.Message(
                    body=json.dumps(event.payload, default=str).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    message_id=event.id,
                    headers={"idempotency_key": event.idempotency_key},
                ),
                routing_key=event.event_type,
            )
        return True
    except Exception as exc:
        logger.warning(
            "Outbox eager publish failed (relay will retry) event_id=%s error=%s",
            event.id,
            repr(exc),
        )
        return False


async def _relay_loop() -> None:
    """Background loop that drains pending/failed outbox events."""
    while True:
        try:
            await _relay_batch()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Outbox relay error: %s", repr(exc))
        await asyncio.sleep(domain_events_config.RELAY_INTERVAL_SECONDS)


async def _relay_batch() -> None:
    """Fetch a batch of unsent events and attempt to publish each one."""
    # If the broker is unreachable, skip this tick so a transient outage
    # doesn't burn each event's retry budget (which would dead-letter good
    # messages). Retries count only genuine per-message failures while up.
    if not await connection.ensure_ready():
        return

    events = await OutboxEventDocument.find(
        {
            "status": {"$in": ["pending", "failed"]},
            "retries": {"$lt": domain_events_config.MAX_RETRIES},
        },
    ).sort("+created_at").limit(domain_events_config.RELAY_BATCH_SIZE).to_list()

    for event in events:
        if await _try_publish(event):
            event.status = "sent"
            event.sent_at = datetime.now(timezone.utc)
        else:
            event.retries += 1
            if event.retries >= domain_events_config.MAX_RETRIES:
                # Genuine repeated failure while the broker is up — more retries
                # won't help. Mark dead, stamp the time, and alert loudly ONCE
                # (the relay query filters retries < MAX_RETRIES, so it won't be
                # picked up again). Row is kept for audit/replay.
                event.status = "failed"
                event.dead_lettered_at = datetime.now(timezone.utc)
                logger.error(
                    "Outbox event exhausted retries — needs manual intervention "
                    "event_id=%s event_type=%s exchange=%s idempotency_key=%s",
                    event.id, event.event_type, event.exchange,
                    event.idempotency_key,
                )
            else:
                event.status = "pending"
        await event.save()
