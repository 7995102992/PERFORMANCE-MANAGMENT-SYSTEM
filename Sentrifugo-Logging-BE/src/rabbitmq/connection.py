"""Singleton aio_pika RobustConnection for the service.

Nothing in here publishes. Publishing goes through ``src.rabbitmq.outbox``.
"""

import asyncio

import aio_pika

from src.config import settings
from src.logger import logger

_HEARTBEAT_SECONDS = 30
_RECONNECT_INTERVAL_SECONDS = 5
_READY_TIMEOUT_SECONDS = 2

rabbitmq_connection: aio_pika.RobustConnection | None = None

# Serialises (re)connection so concurrent callers (relay loop, consumer,
# publishers) can't each open a connection and leak all but the last one.
_reconnect_lock = asyncio.Lock()


async def init_rabbitmq() -> None:
    """Open the singleton RobustConnection.

    Safe to call once at startup. Callers in main.py should wrap this in a
    try/except so the app still boots if the broker is unreachable; the
    relay loop will recover once the broker comes back.
    """
    global rabbitmq_connection
    rabbitmq_connection = await aio_pika.connect_robust(
        settings.RABBITMQ_URL,
        heartbeat=_HEARTBEAT_SECONDS,
        reconnect_interval=_RECONNECT_INTERVAL_SECONDS,
    )
    logger.info("RabbitMQ connection initialized")


async def close_rabbitmq() -> None:
    global rabbitmq_connection
    if rabbitmq_connection is not None and not rabbitmq_connection.is_closed:
        await rabbitmq_connection.close()
        logger.info("RabbitMQ connection closed")
    rabbitmq_connection = None


def is_connected() -> bool:
    """Cheap, sync, best-effort liveness probe.

    Only safe for health endpoints. ``RobustConnection.is_closed`` only
    flips to True after an explicit ``.close()`` — during a network blip
    it stays False even though the underlying transport is dead. Use
    :func:`ensure_ready` from publish paths.
    """
    return rabbitmq_connection is not None and not rabbitmq_connection.is_closed


async def ensure_ready() -> bool:
    """Block until the connection is actually usable, with a short timeout.

    The right primitive for publish paths: ``RobustConnection.ready()``
    waits for the underlying link to be re-established after a blip,
    which ``is_closed`` cannot detect.

    If there is no live connection (e.g. ``init_rabbitmq`` failed at boot
    because the broker was down), self-heal by re-initialising it here so the
    relay/publishers recover on their own once the broker is reachable — no
    process restart required. ``init_rabbitmq`` raises on failure, so the
    re-init is wrapped in try/except.
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
            rabbitmq_connection.ready(), timeout=_READY_TIMEOUT_SECONDS,
        )
        return True
    except Exception as exc:
        logger.debug("RabbitMQ not ready", error=str(exc))
        return False
