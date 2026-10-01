import json
from datetime import date, datetime
from typing import Any, Optional

from src.logger import logger
from src.redis import get_redis


CALENDAR_TTL_SECONDS = 60 * 60
EMPLOYEE_CAL_TTL_SECONDS = 60 * 30


def calendar_key(calendar_id: str) -> str:
    return f"work_calendar:{calendar_id}"


def employee_calendar_key(employee_id: str) -> str:
    return f"emp:{employee_id}:calendar"


def _json_default(obj: Any) -> str:
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    raise TypeError(f"Not JSON serializable: {type(obj).__name__}")


async def cache_calendar(calendar: dict) -> None:
    try:
        redis = await get_redis()
        await redis.setex(
            calendar_key(calendar["_id"]),
            CALENDAR_TTL_SECONDS,
            json.dumps(calendar, default=_json_default),
        )
    except Exception as e:
        logger.warning("Failed to cache work calendar", error=str(e))


async def invalidate_calendar(calendar_id: str) -> None:
    try:
        redis = await get_redis()
        await redis.delete(calendar_key(calendar_id))
    except Exception as e:
        logger.warning("Failed to invalidate calendar cache", error=str(e))


async def get_cached_calendar(calendar_id: str) -> Optional[dict]:
    try:
        redis = await get_redis()
        raw = await redis.get(calendar_key(calendar_id))
        if raw:
            return json.loads(raw)
    except Exception as e:
        logger.warning("Failed to read calendar cache", error=str(e))
    return None
