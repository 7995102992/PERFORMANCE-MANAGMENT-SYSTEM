"""Low-level RabbitMQ connection lifecycle.

This module owns the singleton connection. All publishing must go through
``src.rabbitmq.outbox`` so messages survive broker downtime via the
transactional outbox + relay loop — services should never publish directly.
"""

import asyncio
import logging
from typing import Optional

import aio_pika

from src.config import settings

logger = logging.getLogger(__name__)

_HEARTBEAT_SECONDS = 30
_RECONNECT_INTERVAL_SECONDS = 5
_READY_TIMEOUT_SECONDS = 2

rabbitmq_connection: Optional[aio_pika.RobustConnection] = None

# Serialises (re)connection so concurrent callers (relay loop, publishers)
# can't each open a connection and leak all but the last one.
_reconnect_lock = asyncio.Lock()


async def init_rabbitmq() -> None:
    global rabbitmq_connection
    try:
        rabbitmq_connection = await asyncio.wait_for(
            aio_pika.connect_robust(
                settings.RABBITMQ_URL,
                heartbeat=_HEARTBEAT_SECONDS,
                reconnect_interval=_RECONNECT_INTERVAL_SECONDS,
            ),
            timeout=5,
        )
        logger.info("RabbitMQ connection initialized")
    except Exception as exc:
        logger.warning("RabbitMQ unavailable, starting without broker: %s", exc)
        rabbitmq_connection = None


async def close_rabbitmq() -> None:
    if rabbitmq_connection:
        await rabbitmq_connection.close()
        logger.info("RabbitMQ connection closed")


async def ensure_ready() -> bool:
    """Wait briefly for the robust connection to be usable, reconnecting if needed.

    If there is no live connection (e.g. ``init_rabbitmq`` failed at boot
    because the broker was down), self-heal by re-initialising it here so the
    relay/publishers recover on their own once the broker is reachable — no
    process restart required.
    """
    global rabbitmq_connection
    if rabbitmq_connection is None or rabbitmq_connection.is_closed:
        async with _reconnect_lock:
            # Re-check inside the lock — another coroutine may have reconnected
            # while we were waiting to acquire it.
            if rabbitmq_connection is None or rabbitmq_connection.is_closed:
                await init_rabbitmq()  # safe: catches internally, sets None on failure
    if rabbitmq_connection is None or rabbitmq_connection.is_closed:
        return False
    try:
        await asyncio.wait_for(
            rabbitmq_connection.ready(), timeout=_READY_TIMEOUT_SECONDS,
        )
        return True
    except Exception as exc:
        logger.debug("RabbitMQ not ready: %s", exc)
        return False


def is_connected() -> bool:
    """Cheap, sync best-effort check for health endpoints."""
    return rabbitmq_connection is not None and not rabbitmq_connection.is_closed
