"""Audit-events consumer.

This service is the *consumer* of the ``audit_events`` exchange — it
receives audit messages from other services and ingests them into
TimescaleDB. The outbox in ``outbox.py`` is for messages this service
itself publishes (currently none, but the infrastructure is in place).
"""

import asyncio
import json

from aio_pika import ExchangeType

from src.logger import logger
from src.rabbitmq import connection
from src.rabbitmq.constants import audit_logging_config

_RETRY_INTERVAL_SECONDS = 5


async def start_audit_consumer() -> None:
    """Consume ``audit.*`` events and ingest them as logs."""
    from src.logs.schemas import LogEntryIn
    from src.logs.service import ingest_logs
    from src.timescaledb import get_pg_pool

    if not connection.is_connected():
        raise RuntimeError("RabbitMQ not initialized")

    channel = await connection.rabbitmq_connection.channel()
    await channel.set_qos(prefetch_count=100)

    exchange = await channel.declare_exchange(
        audit_logging_config.EXCHANGE_NAME, ExchangeType.TOPIC, durable=True,
    )
    queue = await channel.declare_queue(audit_logging_config.QUEUE_NAME, durable=True)
    await queue.bind(exchange, routing_key=audit_logging_config.ROUTING_PATTERN)

    logger.info(
        "RabbitMQ audit consumer started",
        exchange=audit_logging_config.EXCHANGE_NAME,
        queue=audit_logging_config.QUEUE_NAME,
        routing_key=audit_logging_config.ROUTING_PATTERN,
    )

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            # Parse + validate first. These failures are PERMANENT (malformed
            # JSON / invalid payload) — requeuing would loop forever, so ack and
            # drop with a loud log. (Previously a blanket except inside
            # message.process() ACKed EVERY failure, silently losing audit events
            # even on transient DB errors.)
            try:
                body = json.loads(message.body.decode())
                entries = body if isinstance(body, list) else [body]
                logs = [LogEntryIn.model_validate(entry) for entry in entries]
            except Exception:
                logger.exception(
                    "Dropping unprocessable audit message (permanent)",
                    routing_key=message.routing_key,
                )
                await message.ack()
                continue

            # Ingest. A failure HERE is TRANSIENT (TimescaleDB/pool down) — nack +
            # requeue rather than lose the audit event. Dedup on (event_id,
            # timestamp) makes the eventual redelivery a no-op.
            event_id = message.message_id or (message.headers or {}).get("idempotency_key")
            try:
                pg_pool = await get_pg_pool()
                count = await ingest_logs(logs, pg_pool, event_id=event_id)
                await message.ack()
                logger.info(
                    "Ingested logs from RabbitMQ",
                    routing_key=message.routing_key,
                    count=count,
                )
            except Exception:
                logger.exception(
                    "Ingest failed (transient) — requeueing",
                    routing_key=message.routing_key,
                )
                await message.nack(requeue=True)


async def run_audit_consumer() -> None:
    """Retry wrapper around :func:`start_audit_consumer`.

    Keeps (re)starting the consumer so it self-heals when RabbitMQ was down at
    boot or drops mid-run — no process restart needed. ``start_audit_consumer``
    blocks while consuming; when it returns (a broker flap closed the queue
    iterator) or raises, we reconnect if needed and try again after a short
    delay. ``init_rabbitmq`` is called directly because this service's
    ``ensure_ready`` does not self-heal a dead/absent connection.
    """
    while True:
        try:
            if not connection.is_connected():
                await connection.init_rabbitmq()
            await start_audit_consumer()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Audit consumer crashed — will retry")
        await asyncio.sleep(_RETRY_INTERVAL_SECONDS)
