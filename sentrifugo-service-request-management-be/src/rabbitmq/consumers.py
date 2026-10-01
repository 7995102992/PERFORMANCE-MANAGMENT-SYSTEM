"""Inbound RabbitMQ consumer — keeps SRM's local IAM replicas in sync.

SRM reads departments and users/employees live from IAM; this consumer
subscribes to IAM's domain events and applies them to the local fallback copies
(``integrations.department_replica`` and ``integrations.employee_replica``) so
request-time lookups survive an IAM outage. Publishing stays in ``outbox`` —
this is the only consumer SRM runs.

IAM publishes to the ``domain_events`` topic exchange (confirmed against the
IAM service config). We declare our **own** durable queue bound to the
department + employee routing keys, so we get our own copy without competing
with other consumers (e.g. LMS) on the same exchange.

Boot is best-effort: if RabbitMQ is unavailable we log and skip — the
write-through cache still provides fallback data, and aio-pika's robust
connection re-establishes the consumer when the broker returns.
"""
from __future__ import annotations

import asyncio
import json
import logging

import aio_pika

from src.config import settings
from src.integrations import department_replica, employee_replica
from src.rabbitmq import connection

logger = logging.getLogger(__name__)

_EXCHANGE = "domain_events"
_QUEUE = f"{settings.ENVIRONMENT}.srm.inbound.domain_events.queue"
_ROUTING_KEYS = (
    "department.created",
    "department.updated",
    "department.deleted",
    "employee.created",
    "employee.updated",
    "employee.deleted",
)

_channel: aio_pika.abc.AbstractChannel | None = None
_consumer_task: asyncio.Task | None = None
_RETRY_INTERVAL_SECONDS = 5


async def _process(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    # requeue=False: on error the message is dropped rather than poison-looped.
    # Replica writes are idempotent and reads re-warm the cache, so losing the
    # odd event is tolerable; a tight requeue loop would not be.
    async with message.process(requeue=False):
        try:
            body = json.loads(message.body)
        except json.JSONDecodeError as exc:
            logger.error("iam_consumer.bad_json error=%s", exc)
            return
        event_type = message.routing_key or body.get("event_type", "")
        payload = body.get("payload", body)

        if event_type == "department.deleted":
            dep_id = str(payload.get("department_id") or payload.get("id") or "")
            if dep_id:
                await department_replica.mark_deleted(dep_id)
        elif event_type in ("department.created", "department.updated"):
            await department_replica.upsert_from_event(payload)
        elif event_type == "employee.deleted":
            uid = str(payload.get("user_id") or payload.get("id") or "")
            if uid:
                await employee_replica.mark_deleted(uid)
        elif event_type in ("employee.created", "employee.updated"):
            uid = str(payload.get("user_id") or payload.get("id") or "")
            if uid:
                await employee_replica.upsert_event(uid, payload)
        else:
            logger.debug("iam_consumer.ignored event=%s", event_type)
            return
        logger.info("iam_consumer.applied event=%s", event_type)


async def start_dept_consumer() -> bool:
    """Declare the binding and begin consuming IAM department events.

    Returns ``True`` if the consumer was registered, ``False`` if the broker was
    unavailable or setup failed (``run_dept_consumer`` retries on ``False``).
    """
    global _channel
    if not await connection.ensure_ready():
        logger.warning("dept_consumer.skipped rabbitmq_unavailable")
        return False
    try:
        _channel = await connection.rabbitmq_connection.channel()
        await _channel.set_qos(prefetch_count=10)
        exchange = await _channel.declare_exchange(
            _EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True,
        )
        queue = await _channel.declare_queue(_QUEUE, durable=True)
        for rk in _ROUTING_KEYS:
            await queue.bind(exchange, routing_key=rk)
        await queue.consume(_process)
        logger.info("dept_consumer.started queue=%s", _QUEUE)
        return True
    except Exception:  # noqa: BLE001 — never block startup on the broker
        logger.exception("dept_consumer.start_failed")
        return False


async def run_dept_consumer() -> None:
    """Retry wrapper: keep attempting to register the consumer until it
    succeeds, so a broker that was down at boot self-heals with no process
    restart. Once registered, aio-pika's robust connection re-establishes the
    subscription across broker flaps, so this returns after the first success.
    """
    while True:
        if await start_dept_consumer():
            return
        await asyncio.sleep(_RETRY_INTERVAL_SECONDS)


def start_dept_consumer_task() -> None:
    """Launch the consumer retry loop as a background task (non-blocking, so a
    broker down at boot doesn't hold up app startup)."""
    global _consumer_task
    _consumer_task = asyncio.create_task(run_dept_consumer())
    logger.info("dept_consumer.task_started")


async def stop_dept_consumer() -> None:
    global _channel, _consumer_task
    if _consumer_task is not None and not _consumer_task.done():
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
    _consumer_task = None
    if _channel is not None and not _channel.is_closed:
        await _channel.close()
    _channel = None
