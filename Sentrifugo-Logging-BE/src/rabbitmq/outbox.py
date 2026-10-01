"""Transactional outbox — the only way to publish messages to RabbitMQ.

Services MUST NOT touch ``aio_pika`` or ``connection.rabbitmq_connection``
directly. Call :func:`publish` (or :func:`publish_audit_log` for the
standardized audit envelope) and the outbox will:

1. Persist the event to ``outbox_events`` (durable, survives broker outage).
2. Best-effort eager-publish so the happy path stays low-latency.
3. If eager publish fails (broker down, transient error), the relay loop
   re-drains pending/failed rows on a fixed interval until they land.

Delivery is **at-least-once**. Consumers must dedupe on the
``idempotency_key`` header.
"""

import asyncio
import json
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import aio_pika
from aio_pika import ExchangeType

from src.logger import logger
from src.rabbitmq import connection
from src.rabbitmq.constants import (
    DebugLevel,
    audit_logging_config,
    domain_events_config,
)
from src.rabbitmq.storage import (
    OutboxEvent,
    ensure_outbox_schema,
    fetch_pending_batch,
    find_event_id_by_idempotency_key,
    insert_event,
    mark_dead_lettered,
    mark_failed,
    mark_sent,
)

_relay_task: Optional[asyncio.Task] = None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def publish(
    event_type: str,
    payload: dict,
    *,
    idempotency_key: str,
    exchange: str = domain_events_config.EXCHANGE_NAME,
) -> str:
    """Persist an event and best-effort eager-publish it.

    Never raises on broker errors. The caller's transaction always sees
    success once the row is committed; the relay guarantees eventual
    delivery. Returns the persisted event id.
    """
    event = OutboxEvent.new(
        idempotency_key=idempotency_key,
        event_type=event_type,
        payload=payload,
        exchange=exchange,
    )
    if not await insert_event(event):
        # Duplicate idempotency_key (retry/replay) — the event is already in the
        # outbox. Return the existing event's id instead of inserting again.
        existing_id = await find_event_id_by_idempotency_key(idempotency_key)
        logger.info(
            "Outbox event already exists (idempotent)",
            idempotency_key=idempotency_key,
            event_type=event_type,
        )
        return existing_id or event.id

    if await _try_publish(event):
        sent_at = datetime.now(timezone.utc)
        await mark_sent(event.id, sent_at)
        event.status = "sent"
        event.sent_at = sent_at

    return event.id


async def publish_audit_log(
    *,
    module: str,
    actor_id: str,
    action: str,
    resource: str,
    debug_level: DebugLevel = DebugLevel.ADMIN,
    metadata: Optional[dict] = None,
) -> str:
    """Standardized audit envelope.

    Builds the payload the logging service expects, routes to the audit
    exchange with key ``audit.<action>``, and uses a fresh UUID
    idempotency key prefixed with ``audit:``.
    """
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "module": module,
        "actor_id": actor_id,
        "action": action,
        "resource": resource,
        "debug_level": int(debug_level),
        "metadata": metadata or {},
    }
    return await publish(
        event_type=f"audit.{action}",
        payload=payload,
        idempotency_key=f"audit:{uuid4()}",
        exchange=audit_logging_config.EXCHANGE_NAME,
    )


async def start_relay() -> None:
    """Ensure schema and start the background relay loop.

    Idempotent: calling twice is a no-op.
    """
    global _relay_task
    await ensure_outbox_schema()
    if _relay_task is not None and not _relay_task.done():
        return
    _relay_task = asyncio.create_task(_relay_loop(), name="rabbitmq-outbox-relay")
    logger.info("Outbox relay started")


async def stop_relay() -> None:
    global _relay_task
    if _relay_task is None:
        return
    _relay_task.cancel()
    try:
        await _relay_task
    except (asyncio.CancelledError, Exception):
        pass
    _relay_task = None
    logger.info("Outbox relay stopped")


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


async def _try_publish(event: OutboxEvent) -> bool:
    """Best-effort publish. Returns False on any failure (never raises)."""
    if not await connection.ensure_ready():
        logger.warning(
            "Skipping eager publish — RabbitMQ disconnected",
            event_id=event.id,
            event_type=event.event_type,
        )
        return False

    try:
        async with connection.rabbitmq_connection.channel() as channel:
            exchange = await channel.declare_exchange(
                event.exchange, ExchangeType.TOPIC, durable=True,
            )
            message = aio_pika.Message(
                body=json.dumps(event.payload).encode("utf-8"),
                content_type="application/json",
                message_id=event.id,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                headers={"idempotency_key": event.idempotency_key},
            )
            await exchange.publish(message, routing_key=event.event_type)
        return True
    except Exception as e:
        logger.warning(
            "Outbox publish failed — relay will retry",
            event_id=event.id,
            event_type=event.event_type,
            error=str(e),
        )
        return False


async def _relay_loop() -> None:
    while True:
        try:
            await _relay_batch()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Outbox relay batch crashed")
        await asyncio.sleep(domain_events_config.RELAY_INTERVAL_SECONDS)


async def _relay_batch() -> None:
    # If the broker is unreachable, skip this tick entirely so a transient
    # outage doesn't burn each event's retry budget (which would dead-letter
    # perfectly good messages). Retries are spent only on genuine per-message
    # publish failures while the broker is up.
    if not await connection.ensure_ready():
        return

    events = await fetch_pending_batch(
        max_retries=domain_events_config.MAX_RETRIES,
        batch_size=domain_events_config.RELAY_BATCH_SIZE,
    )
    if not events:
        return

    logger.debug("Relaying outbox batch", count=len(events))
    for event in events:
        if await _try_publish(event):
            await mark_sent(event.id, datetime.now(timezone.utc))
        else:
            retries = event.retries + 1
            if retries >= domain_events_config.MAX_RETRIES:
                # Genuine, repeated publish failure while the broker is up —
                # more retries won't help. Mark dead, stamp the time, and alert
                # loudly ONCE (the relay query filters retries < MAX_RETRIES, so
                # it won't be picked up again). Row kept for audit/replay.
                await mark_dead_lettered(event.id, retries, datetime.now(timezone.utc))
                logger.error(
                    "Outbox event exhausted retries — needs manual intervention",
                    event_id=event.id,
                    event_type=event.event_type,
                    exchange=event.exchange,
                    idempotency_key=event.idempotency_key,
                )
            else:
                await mark_failed(event.id, retries)
