import asyncio
from typing import Optional

import aio_pika

from src.config import settings
from src.logger import logger

_HEARTBEAT_SECONDS = 30
_RECONNECT_INTERVAL_SECONDS = 5
_READY_TIMEOUT_SECONDS = 2

rabbitmq_connection: Optional[aio_pika.RobustConnection] = None

# Serialises (re)connection so concurrent callers (relay loop, consumer,
# publishers) can't each open a connection and leak all but the last one.
_reconnect_lock = asyncio.Lock()


async def init_rabbitmq():
    global rabbitmq_connection
    rabbitmq_connection = await aio_pika.connect_robust(
        settings.RABBITMQ_URL,
        heartbeat=_HEARTBEAT_SECONDS,
        reconnect_interval=_RECONNECT_INTERVAL_SECONDS,
    )
    logger.info("RabbitMQ connection initialized")

async def close_rabbitmq():
    if rabbitmq_connection:
        await rabbitmq_connection.close()
        logger.info("RabbitMQ connection closed")


async def ensure_ready() -> bool:
    """Wait briefly for the robust connection to be usable, reconnecting if needed.

    If there is no live connection (e.g. ``init_rabbitmq`` failed at boot because
    the broker was down), self-heal by re-initialising it here so the relay/
    consumer/publishers recover on their own once the broker is reachable — no
    process restart required. ``init_rabbitmq`` raises on failure, so the re-init
    is wrapped in try/except.
    """
    global rabbitmq_connection
    if rabbitmq_connection is None or rabbitmq_connection.is_closed:
        async with _reconnect_lock:
            # Re-check inside the lock — another coroutine may have reconnected
            # while we were waiting to acquire it.
            if rabbitmq_connection is None or rabbitmq_connection.is_closed:
                try:
                    await init_rabbitmq()
                except Exception as exc:
                    logger.debug("RabbitMQ re-init failed", error=repr(exc))
                    return False
    try:
        await asyncio.wait_for(rabbitmq_connection.ready(), timeout=_READY_TIMEOUT_SECONDS)
        return True
    except Exception as exc:
        logger.debug("RabbitMQ not ready", error=repr(exc))
        return False


def is_connected() -> bool:
    """Cheap, sync best-effort check for health endpoints."""
    return rabbitmq_connection is not None and not rabbitmq_connection.is_closed


async def get_rabbitmq_channel():
    """Dependency to pull RabbitMQ channels locally per-request"""
    if not rabbitmq_connection:
        raise RuntimeError("RabbitMQ not initialized")
    async with rabbitmq_connection.channel() as channel:
        yield channel
