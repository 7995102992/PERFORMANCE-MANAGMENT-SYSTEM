from typing import Any

from redis.asyncio import Redis
import aio_pika

from src.logger import logger


async def check_health(db_session: Any, redis_client: Redis, rabbitmq_channel: aio_pika.RobustChannel) -> dict[str, Any]:
    db_connected = False
    redis_connected = False
    rabbitmq_connected = False

    # Check Database
    try:
        await db_session.command("ping")
        db_connected = True
    except Exception as e:
        logger.error("Database health check failed", error=str(e))

    # Check Redis
    try:
        if await redis_client.ping():
            redis_connected = True
    except Exception as e:
        logger.error("Redis health check failed", error=str(e))

    # Check RabbitMQ
    try:
        if not rabbitmq_channel.is_closed:
             rabbitmq_connected = True
    except Exception as e:
        logger.error("RabbitMQ health check failed", error=str(e))

    status = "ok" if db_connected and redis_connected and rabbitmq_connected else "degraded"

    return {
        "status": status,
        "db_connected": db_connected,
        "redis_connected": redis_connected,
        "rabbitmq_connected": rabbitmq_connected
    }
