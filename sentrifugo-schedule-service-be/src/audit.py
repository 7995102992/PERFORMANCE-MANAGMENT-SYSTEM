"""Audit logging for the schedule service.

Self-contained transactional outbox that publishes audit events to the shared
``audit_events`` RabbitMQ exchange, which the central Logging Service consumes
(binding ``audit.*``) and persists into TimescaleDB.

This mirrors the contract used by IAM Admin BE / Service Request BE
(``timestamp, module, actor_id, action, resource, debug_level, metadata``) but
is implemented on raw ``motor`` (this service does not use Beanie) and reuses
the existing ``src.rabbitmq`` connection module.

Reliability: every event is first persisted to the ``audit_outbox_events``
collection, then eager-published best-effort. A background relay loop drains
pending/failed events so nothing is lost while RabbitMQ is unreachable.

Usage::

    from src.audit import emit_audit_safe, DebugLevel

    await emit_audit_safe(
        action="task.succeeded",
        tenant_id=str(tenant_id),
        details={"task_type": task_type},
    )

The schedule service is machine-driven, so most events use ``actor_id="system"``
and ``debug_level=ADMIN``. ``emit_audit_safe`` never raises — audit failures must
never break the work being audited.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from enum import IntEnum
from typing import Any
from uuid import uuid4

import aio_pika
from pymongo.errors import DuplicateKeyError

from src import rabbitmq as rabbitmq_module
from src.database import get_db
from src.logger import logger

# ── Config ───────────────────────────────────────────────────────────────────
AUDIT_EXCHANGE = "audit_events"
MODULE = "schedule"

RELAY_INTERVAL_SECONDS = 5
RELAY_BATCH_SIZE = 50
MAX_RETRIES = 10

OUTBOX_COLLECTION = "audit_outbox_events"


class DebugLevel(IntEnum):
    EMPLOYEE = 1
    MANAGER = 2
    HR = 3
    ADMIN = 4


# ── Relay lifecycle ────────────────────────────────────────────────────────────
_relay_task: asyncio.Task | None = None


async def start_audit_relay() -> None:
    """Start the background outbox relay loop."""
    global _relay_task
    _relay_task = asyncio.create_task(_relay_loop())
    logger.info("Audit outbox relay started")


async def stop_audit_relay() -> None:
    """Gracefully cancel the relay loop."""
    global _relay_task
    if _relay_task and not _relay_task.done():
        _relay_task.cancel()
        try:
            await _relay_task
        except asyncio.CancelledError:
            pass
    logger.info("Audit outbox relay stopped")


# ── Public API ─────────────────────────────────────────────────────────────────
async def emit_audit(
    *,
    action: str,
    actor_id: str | None = None,
    tenant_id: str | None = None,
    resource: str | None = None,
    debug_level: DebugLevel = DebugLevel.ADMIN,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> str:
    """Emit an ops/compliance audit event for the schedule service.

    Best-effort: ``publish_audit_log`` swallows persistence failures (returns
    ``None``), so this never raises. ``emit_audit_safe`` is kept as an explicit
    alias for hot paths and call sites that prefer the intent to be obvious.
    """
    return await publish_audit_log(
        module=MODULE,
        actor_id=actor_id or "system",
        action=action,
        resource=resource or f"schedule:{action}",
        debug_level=debug_level,
        metadata={
            "stream": "audit",
            "correlation_id": correlation_id,
            "organisation_id": tenant_id,  # tenant == organisation in this system
            "details": details or {},
        },
    )


async def emit_audit_safe(**kwargs: Any) -> None:
    """Fire-and-forget variant — logs and swallows any error so the caller's
    critical path is never affected by audit problems."""
    try:
        await emit_audit(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Audit emit failed (non-blocking)",
            action=kwargs.get("action"),
            error=repr(exc),
        )


async def publish_audit_log(
    *,
    module: str,
    actor_id: str,
    action: str,
    resource: str,
    debug_level: DebugLevel = DebugLevel.ADMIN,
    metadata: dict | None = None,
) -> str | None:
    """Persist an audit event to the outbox and best-effort eager-publish.

    Bypass-proof: any failure is logged and swallowed (returns ``None``) so a
    failed audit can never break the caller — every entry point (``emit_audit``,
    ``emit_audit_safe``, or a direct call) is automatically safe.

    The routing key is ``audit.<action>`` with dots in ``action`` collapsed to
    underscores so it matches the Logging Service's single-segment ``audit.*``
    binding (e.g. ``task.succeeded`` -> ``audit.task_succeeded``).
    """
    try:
        event_id = str(uuid4())
        now = datetime.now(timezone.utc)
        payload = {
            "timestamp": now.isoformat(),
            "module": module,
            "actor_id": actor_id,
            "action": action,
            "resource": resource,
            "debug_level": int(debug_level),
            "metadata": metadata,
        }
        routing_key = f"audit.{action.replace('.', '_')}"
        doc = {
            "_id": event_id,
            "idempotency_key": f"audit:{event_id}",
            "exchange": AUDIT_EXCHANGE,
            "routing_key": routing_key,
            "payload": payload,
            "status": "pending",
            "retries": 0,
            "created_at": now,
            "sent_at": None,
            "dead_lettered_at": None,
            "correlation_id": (metadata or {}).get("correlation_id"),
        }

        db = get_db()
        try:
            await db[OUTBOX_COLLECTION].insert_one(doc)
        except DuplicateKeyError:
            return event_id

        if await _try_publish(doc):
            await db[OUTBOX_COLLECTION].update_one(
                {"_id": event_id},
                {"$set": {"status": "sent", "sent_at": datetime.now(timezone.utc)}},
            )
        return event_id
    except Exception as exc:  # noqa: BLE001 — audit must never break the operation
        logger.warning(
            "Audit emit failed (non-blocking)",
            action=action,
            error=repr(exc),
        )
        return None


# ── Internal helpers ───────────────────────────────────────────────────────────
async def _try_publish(doc: dict) -> bool:
    """Attempt to publish a single outbox event to RabbitMQ. Returns True on
    success."""
    if not await rabbitmq_module.ensure_ready():
        return False
    conn = rabbitmq_module.rabbitmq_connection
    try:
        async with conn.channel() as channel:
            exchange = await channel.declare_exchange(
                doc["exchange"], aio_pika.ExchangeType.TOPIC, durable=True,
            )
            await exchange.publish(
                aio_pika.Message(
                    body=json.dumps(doc["payload"], default=str).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    message_id=doc["_id"],
                    headers={
                        "idempotency_key": doc["idempotency_key"],
                        "correlation_id": doc.get("correlation_id"),
                    },
                ),
                routing_key=doc["routing_key"],
            )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Audit outbox eager publish failed (relay will retry)",
            event_id=doc["_id"],
            error=repr(exc),
        )
        return False


async def _relay_loop() -> None:
    while True:
        try:
            await _relay_batch()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("Audit outbox relay error", error=repr(exc))
        await asyncio.sleep(RELAY_INTERVAL_SECONDS)


async def _relay_batch() -> None:
    # If the broker is unreachable, skip this tick entirely so a transient outage
    # doesn't burn each event's retry budget (which would dead-letter perfectly
    # good messages). Retries are spent only on genuine per-message publish
    # failures while the broker is up.
    if not await rabbitmq_module.ensure_ready():
        return

    db = get_db()
    docs = (
        await db[OUTBOX_COLLECTION]
        .find({"status": {"$in": ["pending", "failed"]}, "retries": {"$lt": MAX_RETRIES}})
        .sort("created_at", 1)
        .limit(RELAY_BATCH_SIZE)
        .to_list(length=RELAY_BATCH_SIZE)
    )
    for doc in docs:
        if await _try_publish(doc):
            await db[OUTBOX_COLLECTION].update_one(
                {"_id": doc["_id"]},
                {"$set": {"status": "sent", "sent_at": datetime.now(timezone.utc)}},
            )
        else:
            new_retries = doc.get("retries", 0) + 1
            if new_retries >= MAX_RETRIES:
                # Genuine, repeated publish failure while the broker is up — more
                # retries won't help. Mark dead, stamp the time, and alert loudly
                # ONCE (the relay query filters retries < MAX_RETRIES, so it won't
                # be picked up again). Row kept for audit/replay.
                await db[OUTBOX_COLLECTION].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {
                        "status": "failed",
                        "retries": new_retries,
                        "dead_lettered_at": datetime.now(timezone.utc),
                    }},
                )
                logger.error(
                    "Audit outbox event exhausted retries — needs manual intervention",
                    event_id=doc["_id"],
                    routing_key=doc.get("routing_key"),
                    exchange=doc.get("exchange"),
                    idempotency_key=doc.get("idempotency_key"),
                )
            else:
                await db[OUTBOX_COLLECTION].update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"status": "pending"}, "$inc": {"retries": 1}},
                )
