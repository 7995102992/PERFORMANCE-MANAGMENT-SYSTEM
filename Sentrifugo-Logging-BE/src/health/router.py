import asyncpg
from fastapi import APIRouter, Depends
from redis.asyncio import Redis

from src.health.schemas import HealthResponse
from src.health.service import check_health
from src.redis import get_redis
from src.timescaledb import get_pg_pool

router = APIRouter(prefix="/health", tags=["health"])


@router.get("", response_model=HealthResponse)
async def get_health_status(
    pg_pool: asyncpg.Pool = Depends(get_pg_pool),
    redis_client: Redis = Depends(get_redis),
) -> HealthResponse:
    result = await check_health(pg_pool, redis_client)
    return HealthResponse(**result)
