import json

import aio_pika

from src.logger import logger
from src.messaging.constants.queues import Queues
import src.rabbitmq as _rabbitmq

MAX_RETRIES = 5
BASE_DELAY_SECONDS = 2


def get_retry_count(message: aio_pika.IncomingMessage) -> int:
    """Extract retry count from message headers."""
    headers = message.headers or {}
    return int(headers.get("x-retry-count", 0))


async def publish_to_dlq(original_body: bytes, error: str, retry_count: int) -> None:
    """Push a failed message to the Dead Letter Queue."""
    if not _rabbitmq.rabbitmq_connection:
        raise RuntimeError("RabbitMQ not initialized")

    dlq_payload = {
        "original_event": json.loads(original_body),
        "error": error,
        "retry_count": retry_count,
    }

    async with _rabbitmq.rabbitmq_connection.channel() as channel:
        await channel.default_exchange.publish(
            aio_pika.Message(
                body=json.dumps(dlq_payload).encode(),
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=Queues.DLQ,
        )

    logger.warning(
        "Message sent to DLQ",
        retry_count=retry_count,
        error=error,
    )


async def requeue_with_backoff(
    message: aio_pika.IncomingMessage,
    exchange: aio_pika.Exchange,
    error: str,
) -> None:
    """Retry a message with exponential backoff or send to DLQ if max retries exceeded."""
    retry_count = get_retry_count(message) + 1

    if retry_count > MAX_RETRIES:
        await publish_to_dlq(message.body, error, retry_count - 1)
        await message.ack()
        return

    delay_ms = BASE_DELAY_SECONDS * (2 ** retry_count) * 1000

    headers = dict(message.headers or {})
    headers["x-retry-count"] = retry_count

    logger.info(
        "Requeuing message with backoff",
        retry_count=retry_count,
        delay_ms=delay_ms,
        routing_key=message.routing_key,
    )

    # Publish back to the same exchange with updated headers
    await exchange.publish(
        aio_pika.Message(
            body=message.body,
            headers=headers,
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            expiration=int(delay_ms),
        ),
        routing_key=message.routing_key or "",
    )

    await message.ack()
