from redis.asyncio import Redis, from_url

from src.config import settings
from src.logger import logger

redis_client: Redis | None = None

async def init_redis():
    global redis_client
    # Assign the client BEFORE pinging: from_url returns a lazy, auto-reconnecting
    # connection pool, so the client is usable even if Redis is down right now —
    # it starts working the moment Redis comes up, no restart needed. The ping is
    # just a boot-time health probe; its failure must NOT kill the app.
    redis_client = from_url(settings.REDIS_URL, decode_responses=True)
    try:
        await redis_client.ping()
        logger.info("Redis connection initialized")
    except Exception as exc:
        logger.warning("Redis ping failed at init (will self-heal)", error=repr(exc))

async def close_redis():
    global redis_client
    if redis_client:
        await redis_client.aclose()
        redis_client = None
        logger.info("Redis connection closed")

async def get_redis():
    """Dependency to inject redis client properly"""
    if not redis_client:
        raise RuntimeError("Redis not initialized")
    return redis_client
