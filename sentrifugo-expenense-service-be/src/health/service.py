"""Dependency probes backing the ``/health`` endpoint.

Every probe is individually guarded: a down backend is *reported* as
``connected: False``, never raised. The endpoint must always answer so
orchestrators can tell "process up, dependency down" from "process dead".
"""

from typing import Any

from src import valkey
from src.logger import logger
from src.rabbitmq import is_connected as rabbitmq_is_connected


async def check_health() -> dict[str, Any]:
    """Probe Mongo, Valkey and RabbitMQ.

    Returns:
        Mapping with an overall ``status`` (``"ok"`` when every dependency is
        reachable, else ``"degraded"``) plus a boolean per dependency.
    """
    mongo_connected = False
    valkey_connected = False
    rabbitmq_connected = False

    # MongoDB
    try:
        from src.database import get_mongo

        db = get_mongo()
        await db.command("ping")
        mongo_connected = True
    except Exception as e:
        logger.error("MongoDB health check failed", error=str(e))

    # Valkey
    try:
        if valkey.valkey_client and await valkey.valkey_client.ping():
            valkey_connected = True
    except Exception as e:
        logger.error("Valkey health check failed", error=str(e))

    # RabbitMQ
    try:
        if rabbitmq_is_connected():
            rabbitmq_connected = True
    except Exception as e:
        logger.error("RabbitMQ health check failed", error=str(e))

    all_healthy = mongo_connected and valkey_connected and rabbitmq_connected

    return {
        "status": "ok" if all_healthy else "degraded",
        "mongo_connected": mongo_connected,
        "valkey_connected": valkey_connected,
        "rabbitmq_connected": rabbitmq_connected,
    }
