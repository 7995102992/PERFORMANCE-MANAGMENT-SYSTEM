"""Low-level RabbitMQ connection lifecycle.

This module owns the singleton connection. All publishing must go through
``src.rabbitmq.outbox`` so messages survive broker downtime via the
transactional outbox + relay loop — services should never publish directly.
"""

import asyncio

import aio_pika

from src.config import settings
from src.logger import logger

# Tunables for reconnect behaviour. Heartbeat lets us notice a dead TCP
# socket within ~2x the interval; reconnect_interval is how long aio_pika
# waits between retry attempts after the broker drops.
_HEARTBEAT_SECONDS = 30
_RECONNECT_INTERVAL_SECONDS = 5
_READY_TIMEOUT_SECONDS = 2

rabbitmq_connection: aio_pika.RobustConnection | None = None

# Serialises (re)connection so concurrent callers (relay loop, publishers)
# can't each open a connection and leak all but the last one.
_reconnect_lock = asyncio.Lock()


async def init_rabbitmq() -> None:
    global rabbitmq_connection
    rabbitmq_connection = await aio_pika.connect_robust(
        settings.RABBITMQ_URL,
        heartbeat=_HEARTBEAT_SECONDS,
        reconnect_interval=_RECONNECT_INTERVAL_SECONDS,
    )
    logger.info("RabbitMQ connection initialized")


async def close_rabbitmq() -> None:
    if rabbitmq_connection:
        await rabbitmq_connection.close()
        logger.info("RabbitMQ connection closed")


async def ensure_ready() -> bool:
    """Wait briefly for the robust connection to be usable, reconnecting if needed.

    ``RobustConnection.is_closed`` only flips to True after an explicit
    ``.close()`` — during a reconnect cycle it stays False even though the
    transport is dead. We instead probe ``.ready()`` with a short timeout so
    callers can decide to skip and let the relay retry next tick.

    If there is no live connection (e.g. ``init_rabbitmq`` failed at boot
    because the broker was down), we self-heal by re-initialising it here, so
    the relay/publishers recover on their own once the broker is reachable —
    no process restart required.
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
                    logger.debug("RabbitMQ re-init failed", error=str(exc))
                    return False
    try:
        await asyncio.wait_for(
            rabbitmq_connection.ready(),
            timeout=_READY_TIMEOUT_SECONDS,
        )
        return True
    except Exception as exc:
        logger.debug("RabbitMQ not ready", error=str(exc))
        return False


def is_connected() -> bool:
    """Cheap, sync best-effort check for health endpoints.

    Use ``ensure_ready()`` from publish paths — this is only safe for
    health checks where a momentary false-positive is fine.
    """
    return rabbitmq_connection is not None and not rabbitmq_connection.is_closed
