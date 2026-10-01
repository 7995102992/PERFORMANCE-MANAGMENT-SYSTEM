import asyncio
import json

import aio_pika
from aio_pika.abc import AbstractIncomingMessage

from src import database as db_module
from src.email.config import email_settings
from src.email.service import (
    check_idempotency_cache,
    insert_inbox_event,
    mark_inbox_failed,
    mark_inbox_processed,
    set_idempotency_cache,
)
from src.audit import emit_audit_safe
from src.executors.base import TaskContext
from src.executors.registry import get_executor
from src.executors.schemas import TaskMessage
from src.logger import logger
from src import rabbitmq as rabbitmq_module
from src.redis import redis_client

_RETRY_INTERVAL_SECONDS = 5
_channel: aio_pika.abc.AbstractChannel | None = None
_consumer_task: asyncio.Task | None = None


async def _republish_for_retry(message: AbstractIncomingMessage, retry_count: int) -> None:
    """Republish the message to the same exchange with an incremented
    ``x-retry-count`` header. You can't mutate an incoming message's headers in
    place, so we publish a fresh copy and ack the original."""
    conn = rabbitmq_module.rabbitmq_connection
    if conn is None or conn.is_closed:
        raise RuntimeError("RabbitMQ connection unavailable for retry republish")
    headers = dict(message.headers or {})
    headers["x-retry-count"] = retry_count + 1
    async with conn.channel() as channel:
        exchange = await channel.declare_exchange(
            email_settings.RABBITMQ_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True,
        )
        await exchange.publish(
            aio_pika.Message(
                body=message.body,
                headers=headers,
                content_type=message.content_type,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=message.routing_key or email_settings.RABBITMQ_ROUTING_KEY,
        )


async def _handle_failure(message: AbstractIncomingMessage, task: TaskMessage, error_detail: str) -> None:
    """Bounded retry, then dead-letter.

    The producer/broker never sets or increments ``x-retry-count`` (RabbitMQ does
    not bump custom headers on a plain requeue), so the old ``nack(requeue=True)``
    looped a deterministically-failing message FOREVER and it never reached the
    DLQ. We track attempts ourselves: republish with an incremented counter until
    RABBITMQ_MAX_RETRIES, then ``reject(requeue=False)`` so the queue's configured
    dead-letter routing sends it to the DLQ.
    """
    retry_count = (message.headers or {}).get("x-retry-count", 0)
    if isinstance(retry_count, str):
        retry_count = int(retry_count)

    if retry_count >= email_settings.RABBITMQ_MAX_RETRIES:
        logger.error(
            "Max retries exceeded, dead-lettering",
            task_type=task.task_type,
            retry_count=retry_count,
        )
        await emit_audit_safe(
            action="task.dead_lettered",
            tenant_id=str(task.tenant_id),
            resource=f"task:{task.idempotency_key}",
            details={
                "task_type": task.task_type,
                "event_type": task.event_type,
                "error": error_detail,
                "retry_count": retry_count,
            },
            correlation_id=str(task.correlation_id),
        )
        await message.reject(requeue=False)  # → DLQ via the queue's x-dead-letter-* args
        return

    try:
        await _republish_for_retry(message, retry_count)
        await message.ack()
    except Exception as exc:  # noqa: BLE001
        # Republish failed (broker hiccup) — requeue so the message isn't lost.
        logger.warning("Retry republish failed, requeueing", error=repr(exc))
        await message.nack(requeue=True)


async def process_message(message: AbstractIncomingMessage) -> None:
    try:
        body = json.loads(message.body.decode())
        task = TaskMessage(**body)
    except Exception as e:
        logger.error("Malformed message, rejecting", error=str(e))
        await emit_audit_safe(
            action="task.rejected",
            details={"reason": "malformed_message", "error": str(e)},
        )
        await message.reject(requeue=False)
        return

    executor = get_executor(task.task_type)
    if not executor:
        logger.error("No executor registered for task_type", task_type=task.task_type)
        await emit_audit_safe(
            action="task.rejected",
            tenant_id=str(task.tenant_id),
            resource=f"task:{task.idempotency_key}",
            details={"reason": "no_executor", "task_type": task.task_type},
            correlation_id=str(task.correlation_id),
        )
        await message.reject(requeue=False)
        return

    tenant_id = task.tenant_id
    idempotency_key = task.idempotency_key

    try:
        if redis_client and await check_idempotency_cache(redis_client, tenant_id, idempotency_key):
            logger.info("Idempotency cache hit, ACK and skip", task_type=task.task_type, tenant_id=str(tenant_id))
            await message.ack()
            return
    except Exception:
        logger.warning("Valkey unavailable for idempotency check, falling through to DB")

    if db_module.db is None:
        logger.error("Database not initialized, NACK")
        await message.nack(requeue=True)
        return
    db = db_module.db

    try:
        inserted = await insert_inbox_event(db, task)
        if not inserted:
            await message.ack()
            return

        context = TaskContext(
            tenant_id=tenant_id,
            idempotency_key=idempotency_key,
            correlation_id=task.correlation_id,
            event_type=task.event_type,
            db=db,
            redis_client=redis_client,
        )

        result = await executor.execute(task.payload, context)

        if not result.success:
            await mark_inbox_failed(db, tenant_id, idempotency_key, result.detail or "Executor failed")
            await emit_audit_safe(
                action="task.failed",
                tenant_id=str(tenant_id),
                resource=f"task:{task.idempotency_key}",
                details={
                    "task_type": task.task_type,
                    "event_type": task.event_type,
                    "reason": result.detail or "Executor failed",
                },
                correlation_id=str(task.correlation_id),
            )
            await _handle_failure(message, task, result.detail or "Executor failed")
            return

        await mark_inbox_processed(db, tenant_id, idempotency_key)

        if redis_client:
            await set_idempotency_cache(redis_client, tenant_id, idempotency_key)

        await emit_audit_safe(
            action="task.succeeded",
            tenant_id=str(tenant_id),
            resource=f"task:{task.idempotency_key}",
            details={
                "task_type": task.task_type,
                "event_type": task.event_type,
                "detail": result.detail,
                "data": result.data,
            },
            correlation_id=str(task.correlation_id),
        )

        await message.ack()

    except Exception as e:
        logger.error(
            "Failed to process task",
            task_type=task.task_type,
            tenant_id=str(tenant_id),
            error=str(e),
        )
        try:
            await mark_inbox_failed(db, tenant_id, idempotency_key, str(e))
        except Exception:
            logger.error("Could not mark inbox event as failed")

        await _handle_failure(message, task, str(e))


async def start_consumer() -> bool:
    """Declare the queue/bindings and begin consuming.

    Returns ``True`` if the consumer was registered, ``False`` if the broker was
    unavailable or setup failed (``run_consumer`` retries on ``False``).
    """
    global _channel
    if not await rabbitmq_module.ensure_ready():
        logger.warning("RabbitMQ not ready, task consumer not started")
        return False

    try:
        _channel = await rabbitmq_module.rabbitmq_connection.channel()
        await _channel.set_qos(prefetch_count=email_settings.RABBITMQ_PREFETCH_COUNT)

        exchange = await _channel.declare_exchange(
            email_settings.RABBITMQ_EXCHANGE,
            aio_pika.ExchangeType.TOPIC,
            durable=True,
        )

        dlq = await _channel.declare_queue(email_settings.RABBITMQ_DLQ, durable=True)

        queue = await _channel.declare_queue(
            email_settings.RABBITMQ_QUEUE,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": email_settings.RABBITMQ_DLQ,
            },
        )

        await queue.bind(exchange, routing_key=email_settings.RABBITMQ_ROUTING_KEY)

        await queue.consume(process_message, no_ack=False)
        logger.info(
            "Task consumer started",
            exchange=email_settings.RABBITMQ_EXCHANGE,
            queue=email_settings.RABBITMQ_QUEUE,
        )
        return True
    except Exception as exc:  # noqa: BLE001 — never block startup on the broker
        logger.warning("Task consumer start failed", error=repr(exc))
        return False


async def run_consumer() -> None:
    """Retry wrapper: keep attempting to register the consumer until it
    succeeds, so a broker that was down at boot self-heals with no process
    restart. Once registered, aio-pika's robust connection re-establishes the
    subscription across broker flaps, so this returns after the first success.
    """
    while True:
        if await start_consumer():
            return
        await asyncio.sleep(_RETRY_INTERVAL_SECONDS)


def start_consumer_task() -> None:
    """Launch the consumer retry loop as a background task (non-blocking, so a
    broker down at boot doesn't hold up app startup)."""
    global _consumer_task
    _consumer_task = asyncio.create_task(run_consumer())
    logger.info("Task consumer retry loop started")


async def stop_consumer() -> None:
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
