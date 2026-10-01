from typing import Any

from src import database, rabbitmq
from src import redis as redis_module
from src.logger import logger


async def check_health() -> dict[str, Any]:
    """Report connectivity of each infra dependency.

    Reads live module state and treats every probe defensively: if a dependency
    is uninitialized or unreachable it is reported as disconnected (``degraded``)
    rather than raising. A health endpoint must never fail just because the
    infrastructure it reports on is down.
    """
    db_connected = False
    redis_connected = False
    rabbitmq_connected = False

    try:
        if database.db is not None:
            await database.db.command("ping")
            db_connected = True
    except Exception as e:
        logger.error("Database health check failed", error=str(e))

    try:
        if redis_module.redis_client is not None and await redis_module.redis_client.ping():
            redis_connected = True
    except Exception as e:
        logger.error("Redis health check failed", error=str(e))

    try:
        conn = rabbitmq.rabbitmq_connection
        if conn is not None and not conn.is_closed:
            rabbitmq_connected = True
    except Exception as e:
        logger.error("RabbitMQ health check failed", error=str(e))

    status = "ok" if db_connected and redis_connected and rabbitmq_connected else "degraded"

    return {
        "status": status,
        "db_connected": db_connected,
        "redis_connected": redis_connected,
        "rabbitmq_connected": rabbitmq_connected,
    }
