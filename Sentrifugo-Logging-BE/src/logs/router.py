from datetime import datetime

import asyncpg
from fastapi import APIRouter, Depends, Query
from redis.asyncio import Redis

from src.logs.dependencies import ApiKeyInfo, validate_api_key
from src.logs.schemas import LogEntryIn, LogsResponse
from src.logs.service import fetch_logs, ingest_logs
from src.redis import get_redis
from src.timescaledb import get_pg_pool

router = APIRouter(prefix="/logs", tags=["logs"])


@router.post("")
async def post_logs(
    logs: list[LogEntryIn],
    api_key_info: ApiKeyInfo = Depends(validate_api_key),
    pg_pool: asyncpg.Pool = Depends(get_pg_pool),
):
    count = await ingest_logs(logs, pg_pool)
    return {"ingested": count}


@router.get("", response_model=LogsResponse)
async def get_logs(
    start_time: datetime = Query(...),
    end_time: datetime = Query(...),
    module: str | None = Query(None),
    actor_id: str | None = Query(None),
    debug_level: int | None = Query(None),
    organisation_id: str | None = Query(None),
    limit: int = Query(1000, ge=1, le=10000),
    offset: int = Query(0, ge=0),
    api_key_info: ApiKeyInfo = Depends(validate_api_key),
    pg_pool: asyncpg.Pool = Depends(get_pg_pool),
    redis_client: Redis = Depends(get_redis),
) -> LogsResponse:
    return await fetch_logs(
        start_time=start_time,
        end_time=end_time,
        user_debug_level=api_key_info.debug_level,
        pg_pool=pg_pool,
        redis_client=redis_client,
        module=module,
        actor_id=actor_id,
        debug_level=debug_level,
        organisation_id=organisation_id,
        limit=limit,
        offset=offset,
    )
