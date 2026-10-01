from typing import Any

import aio_pika
from fastapi import APIRouter, Depends
from redis.asyncio import Redis

from src.database import get_db_session
from src.health.schemas import HealthResponse
from src.health.service import check_health
from src.rabbitmq import get_rabbitmq_channel_dep
from src.redis import get_redis

router = APIRouter(prefix="/health", tags=["health"])

@router.get("", response_model=HealthResponse)
async def get_health_status(
    db_session: Any = Depends(get_db_session),
    redis_client: Redis = Depends(get_redis),
    rabbitmq_channel: aio_pika.RobustChannel = Depends(get_rabbitmq_channel_dep),
) -> HealthResponse:
    result = await check_health(db_session, redis_client, rabbitmq_channel)
    return HealthResponse(**result)
