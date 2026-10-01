from __future__ import annotations

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

_relay_task: asyncio.Task | None = None


async def start_relay() -> None:
    global _relay_task
    _relay_task = asyncio.create_task(_relay_loop())
    logger.info("Outbox relay started")


async def stop_relay() -> None:
    if _relay_task and not _relay_task.done():
        _relay_task.cancel()
        try:
            await _relay_task
        except asyncio.CancelledError:
            pass
    logger.info("Outbox relay stopped")


async def publish(
    event_type: str,
    payload: dict,
    *,
    idempotency_key: str,
    exchange: str = domain_events_config.EXCHANGE_NAME,
) -> str:
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
        logger.info("Outbox event persisted event_id=%s event_type=%s", event.id, event_type)
    except DuplicateKeyError:
        # idempotency_key is uniquely indexed — a retry/replay with the same key
        # means this event is already in the outbox. Return the existing event's
        # id (not the idempotency_key) so callers get a consistent identifier.
        logger.info(
            "Outbox event already exists (idempotent) idempotency_key=%s event_type=%s",
            idempotency_key, event_type,
        )
        existing = await OutboxEventDocument.find_one(
            OutboxEventDocument.idempotency_key == idempotency_key
        )
        return existing.id if existing else None

    if await _try_publish(event):
        event.status = "sent"
        event.sent_at = datetime.now(timezone.utc)
        await event.save()

    return event.id


async def publish_audit_log(
    *,
    module: str,
    actor_id: str,
    action: str,
    resource: str,
    debug_level: DebugLevel = DebugLevel.ADMIN,
    metadata: dict | None = None,
) -> str | None:
    """Bypass-proof: failures are logged and swallowed (returns ``None``) so a
    failed audit never breaks the caller. The routing key collapses dots in
    ``action`` to underscores so it matches the Logging Service's single-segment
    ``audit.*`` binding; the stored ``action`` keeps the readable dotted form."""
    try:
        event_id = str(uuid4())
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
            "Audit emit failed (non-blocking) action=%s error=%s",
            action, repr(exc),
        )
        return None


async def _try_publish(event: OutboxEventDocument) -> bool:
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
            event.id, repr(exc),
        )
        return False


async def _relay_loop() -> None:
    while True:
        try:
            await _relay_batch()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Outbox relay error: %s", repr(exc))
        await asyncio.sleep(domain_events_config.RELAY_INTERVAL_SECONDS)


async def _relay_batch() -> None:
    # If the broker is unreachable, skip this tick entirely so a transient
    # outage doesn't burn each event's retry budget (which would dead-letter
    # perfectly good messages). Retries are spent only on genuine per-message
    # publish failures while the broker is up.
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
                # Genuine, repeated publish failure while the broker is up
                # (poison payload / exchange mismatch / serialization bug) —
                # more retries won't help. Mark dead, stamp the time, and alert
                # loudly ONCE. The relay query (retries < MAX_RETRIES) won't pick
                # it up again, so this logs exactly once. Row kept for replay.
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
