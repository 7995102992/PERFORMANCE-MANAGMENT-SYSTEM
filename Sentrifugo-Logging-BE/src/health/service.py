from typing import Any

import asyncpg
from redis.asyncio import Redis

from src.logger import logger
from src.rabbitmq import is_connected as rabbitmq_is_connected


async def check_health(pg_pool: asyncpg.Pool, redis_client: Redis) -> dict[str, Any]:
    timescaledb_connected = False
    redis_connected = False
    rabbitmq_connected = False

    # Check TimescaleDB via PG wire
    try:
        async with pg_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
            timescaledb_connected = True
    except Exception as e:
        logger.error("TimescaleDB health check failed", error=str(e))

    # Check Redis
    try:
        if await redis_client.ping():
            redis_connected = True
    except Exception as e:
        logger.error("Redis health check failed", error=str(e))

    # Check RabbitMQ — call is_connected() rather than reading the
    # connection variable directly: importing the variable captures
    # ``None`` at import time because init_rabbitmq() reassigns it.
    try:
        rabbitmq_connected = rabbitmq_is_connected()
    except Exception as e:
        logger.error("RabbitMQ health check failed", error=str(e))

    status = "ok" if timescaledb_connected and redis_connected and rabbitmq_connected else "degraded"

    return {
        "status": status,
        "timescaledb_connected": timescaledb_connected,
        "redis_connected": redis_connected,
        "rabbitmq_connected": rabbitmq_connected,
    }
