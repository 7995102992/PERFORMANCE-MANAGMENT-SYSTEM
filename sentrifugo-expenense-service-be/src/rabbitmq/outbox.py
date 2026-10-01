"""Transactional outbox — the single entry point for all RabbitMQ publishing.

Every message we send to RabbitMQ (domain events, audit logs, email events)
goes through this module. Each publish is persisted to the ``outbox_events``
collection first, so if RabbitMQ is down (or flapping) the message is not
lost — the background relay loop drains pending events and forwards them
once the broker is reachable again.

Usage from any service::

    from src.rabbitmq import outbox

    # generic domain event
    await outbox.publish("expense.submitted", payload, idempotency_key=claim_id)

    # audit log
    await outbox.publish_audit_log(
        module="claims", actor_id=uid, action="submitted", resource=f"claim:{claim_id}",
    )

    # email event (uses the email exchange)
    await outbox.publish(
        "email.expense_approved",
        {...},
        idempotency_key=f"email.expense_approved:{token}",
        exchange=email_events_config.EXCHANGE_NAME,
    )

Consumers MUST be idempotent — use the ``idempotency_key`` header to
deduplicate (delivery is at-least-once).
"""

import asyncio
import json
from datetime import UTC, datetime
from uuid import uuid4

import aio_pika
from pymongo.errors import DuplicateKeyError

from src.correlation import get_correlation_id
from src.logger import logger
from src.models import OutboxEventDocument
from src.rabbitmq import connection
from src.rabbitmq.constants import (
    DebugLevel,
    audit_logging_config,
    domain_events_config,
)

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


async def publish(
    event_type: str,
    payload: dict,
    *,
    idempotency_key: str,
    exchange: str = domain_events_config.EXCHANGE_NAME,
) -> str | None:
    """Persist an event to the outbox and best-effort eager-publish.

    Returns the outbox event id. The relay will pick it up if the eager
    publish fails or RabbitMQ is currently unreachable.
    """
    now = datetime.now(UTC)
    event = OutboxEventDocument(
        correlation_id=get_correlation_id(),
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
        logger.info(
            "Outbox event already exists (idempotent)",
            idempotency_key=idempotency_key,
            event_type=event_type,
        )
        existing = await OutboxEventDocument.find_one(OutboxEventDocument.idempotency_key == idempotency_key)
        return existing.id if existing else None
    logger.info("Outbox event persisted", event_id=event.id, event_type=event_type)

    # Eager publish — best-effort, relay will catch it if this fails.
    if await _try_publish(event):
        event.status = "sent"
        event.sent_at = datetime.now(UTC)
        await event.save()

    return event.id


async def publish_audit_log(
    *,
    module: str,
    actor_id: str,
    action: str,
    resource: str,
    debug_level: DebugLevel = DebugLevel.ADMIN,
    organisation_id: str | None = None,
    stream: str = "audit",
    metadata: dict | None = None,
) -> str | None:
    """Publish an audit event via the outbox (canonical cross-service spec).

    Canonical shape for the central Logging Service:
      * ``module``   = the emitting *service* — always ``"expense"`` here.
      * ``action``   = ``"<domain>.<verb>"``. Callers still pass the domain as
        ``module`` (e.g. ``"claims"``, ``"receipts"``) and the verb as
        ``action`` (e.g. ``"submitted"``); we fold them into ``"<domain>.<verb>"``
        so the entity is self-describing in the action.
      * ``resource`` = ``"<entity>:<id>"`` (caller-supplied, unchanged).

    The routing key is ``audit.<domain>_<verb>`` — dots in the qualified action
    are collapsed to underscores so the key stays a single segment and matches
    the Logging Service's ``audit.*`` binding. The stored ``action`` keeps the
    readable dotted form.
    """
    try:
        event_id = str(uuid4())
        domain = module
        qualified_action = action if action.startswith(f"{domain}.") else f"{domain}.{action}"
        routing_key = f"audit.{qualified_action.replace('.', '_')}"
        # Canonical metadata envelope shared across IAM / SRM / schedule:
        #   {stream, correlation_id, organisation_id, details, [changed_fields]}
        # Callers pass a flat dict (e.g. {"reason": ...} or {"changed_fields": [...]});
        # everything except changed_fields is wrapped under `details`.
        caller_meta = dict(metadata or {})
        changed_fields = caller_meta.pop("changed_fields", None)
        envelope = {
            "stream": stream,
            "correlation_id": get_correlation_id(),
            "organisation_id": organisation_id,
            "details": caller_meta,
        }
        if changed_fields is not None:
            envelope["changed_fields"] = changed_fields
        return await publish(
            routing_key,
            {
                "timestamp": datetime.now(UTC).isoformat(),
                "module": "expense",
                "actor_id": actor_id,
                "action": qualified_action,
                "resource": resource,
                "debug_level": int(debug_level),
                "metadata": envelope,
            },
            idempotency_key=f"audit:{event_id}",
            exchange=audit_logging_config.EXCHANGE_NAME,
        )
    except Exception as exc:
        # Audit must never break the calling operation — log and move on.
        logger.warning(
            "Audit emit failed (non-blocking)",
            module=module,
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
                event.exchange,
                aio_pika.ExchangeType.TOPIC,
                durable=True,
            )
            await exchange.publish(
                aio_pika.Message(
                    body=json.dumps(event.payload).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    message_id=event.id,
                    headers={
                        "idempotency_key": event.idempotency_key,
                        "correlation_id": event.correlation_id,
                    },
                ),
                routing_key=event.event_type,
            )
        return True
    except Exception as exc:
        logger.warning(
            "Outbox eager publish failed (relay will retry)",
            event_id=event.id,
            error=repr(exc),
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
            logger.error("Outbox relay error", error=repr(exc))
        await asyncio.sleep(domain_events_config.RELAY_INTERVAL_SECONDS)


async def _relay_batch() -> None:
    """Fetch a batch of unsent events and attempt to publish each one."""
    # If the broker is unreachable, skip this tick entirely so a transient
    # outage doesn't burn each event's retry budget (which would dead-letter
    # perfectly good messages). Retries are spent only on genuine per-message
    # publish failures while the broker is up.
    if not await connection.ensure_ready():
        return

    events = (
        await OutboxEventDocument.find(
            {
                "status": {"$in": ["pending", "failed"]},
                "retries": {"$lt": domain_events_config.MAX_RETRIES},
            },
        )
        .sort("+created_at")
        .limit(domain_events_config.RELAY_BATCH_SIZE)
        .to_list()
    )

    for event in events:
        if await _try_publish(event):
            event.status = "sent"
            event.sent_at = datetime.now(UTC)
        else:
            event.retries += 1
            if event.retries >= domain_events_config.MAX_RETRIES:
                # Genuine, repeated publish failure while the broker is up
                # (poison payload / exchange mismatch / serialization bug) —
                # more retries won't help. Mark dead, stamp the time, and alert
                # loudly ONCE. The relay query (retries < MAX_RETRIES) won't
                # pick it up again, so this logs exactly once. The row is kept
                # for audit/replay.
                event.status = "failed"
                event.dead_lettered_at = datetime.now(UTC)
                logger.error(
                    "Outbox event exhausted retries — needs manual intervention",
                    event_id=event.id,
                    event_type=event.event_type,
                    exchange=event.exchange,
                    idempotency_key=event.idempotency_key,
                )
            else:
                event.status = "pending"
        await event.save()
