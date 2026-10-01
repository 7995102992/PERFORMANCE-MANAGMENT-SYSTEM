import json
from datetime import datetime, timezone

import asyncpg
from redis.asyncio import Redis

from src.logger import logger
from src.logs.config import logs_settings
from src.logs.constants import DebugLevel
from src.logs.schemas import LogEntryIn, LogEntryOut, LogsResponse, PaginationInfo

INSERT_SQL = """
INSERT INTO audit_logs (event_id, timestamp, module, actor_id, action, resource, debug_level, organisation_id, metadata)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (event_id, timestamp) DO NOTHING
"""


def _extract_org_id(entry: LogEntryIn) -> str | None:
    """The canonical audit envelope nests organisation_id under metadata; promote
    it to the top-level column. Prefer an explicit top-level value if a producer
    sends one. Coerce to str so mixed producer types stay consistent."""
    org = entry.organisation_id
    if org is None and entry.metadata:
        org = entry.metadata.get("organisation_id")
    return str(org) if org else None


def _parse_timestamp(value: str | None) -> datetime:
    """ISO string -> tz-aware UTC datetime. Naive values are assumed UTC so they
    aren't silently shifted when stored in the TIMESTAMPTZ column."""
    if not value:
        return datetime.now(timezone.utc)
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)


async def ingest_logs(
    logs: list[LogEntryIn], pg_pool: asyncpg.Pool, event_id: str | None = None
) -> int:
    """Insert audit rows ONE AT A TIME so a single bad row can't drop the whole
    batch, and dedupe on (event_id, timestamp) so an at-least-once redelivery is
    a no-op. ``event_id`` is the broker message id; for a multi-row message each
    row gets a "<event_id>:<index>" suffix so they stay individually unique.

    Per-row constraint/data violations are logged and skipped (permanent — they
    won't succeed on retry). Connection/infra errors are NOT caught here — they
    propagate so the consumer can requeue the message instead of losing it.
    """
    processed = 0
    async with pg_pool.acquire() as conn:
        for i, entry in enumerate(logs):
            row_event_id = None
            if event_id:
                row_event_id = f"{event_id}:{i}" if len(logs) > 1 else event_id
            try:
                await conn.execute(
                    INSERT_SQL,
                    row_event_id,
                    _parse_timestamp(entry.timestamp),
                    entry.module,
                    entry.actor_id,
                    entry.action,
                    entry.resource,
                    entry.debug_level.value,
                    _extract_org_id(entry),
                    json.dumps(entry.metadata) if entry.metadata else None,
                )
                processed += 1
            except (asyncpg.exceptions.DataError, asyncpg.exceptions.IntegrityConstraintViolationError):
                logger.exception(
                    "Skipping unprocessable audit row",
                    module=entry.module,
                    action=entry.action,
                )

    logger.info("Ingested audit logs", received=len(logs), processed=processed)
    return processed


async def fetch_logs(
    start_time: datetime,
    end_time: datetime,
    user_debug_level: DebugLevel,
    pg_pool: asyncpg.Pool,
    redis_client: Redis,
    module: str | None = None,
    actor_id: str | None = None,
    debug_level: int | None = None,
    organisation_id: str | None = None,
    limit: int = 1000,
    offset: int = 0,
) -> LogsResponse:
    cache_key = (
        f"logs:{start_time.isoformat()}:{end_time.isoformat()}"
        f":{module}:{actor_id}:{debug_level}:{organisation_id}:{user_debug_level.value}:{limit}:{offset}"
    )

    cached = await redis_client.get(cache_key)
    if cached:
        logger.debug("Cache hit for logs query", cache_key=cache_key)
        return LogsResponse.model_validate_json(cached)

    conditions = [
        "timestamp >= $1",
        "timestamp <= $2",
        f"debug_level <= {user_debug_level.value}",
    ]
    params: list = [start_time, end_time]
    param_idx = 3

    if module:
        conditions.append(f"module = ${param_idx}")
        params.append(module)
        param_idx += 1

    if actor_id:
        conditions.append(f"actor_id = ${param_idx}")
        params.append(actor_id)
        param_idx += 1

    if debug_level is not None:
        conditions.append(f"debug_level = ${param_idx}")
        params.append(debug_level)
        param_idx += 1

    if organisation_id:
        conditions.append(f"organisation_id = ${param_idx}")
        params.append(organisation_id)
        param_idx += 1

    where_clause = " AND ".join(conditions)

    count_sql = f"SELECT count(*) FROM audit_logs WHERE {where_clause}"
    columns = "timestamp, module, actor_id, action, resource, debug_level, organisation_id, metadata"
    data_sql = (
        f"SELECT {columns} FROM audit_logs WHERE {where_clause}"
        f" ORDER BY timestamp DESC LIMIT {limit} OFFSET {offset}"
    )

    async with pg_pool.acquire() as conn:
        total = await conn.fetchval(count_sql, *params)
        rows = await conn.fetch(data_sql, *params)

    entries = [
        LogEntryOut(
            timestamp=row["timestamp"].isoformat(),
            module=row["module"],
            actor_id=row["actor_id"],
            action=row["action"],
            resource=row["resource"],
            debug_level=row["debug_level"],
            organisation_id=row["organisation_id"],
            metadata=row["metadata"],
        )
        for row in rows
    ]

    response = LogsResponse(
        data=entries,
        pagination=PaginationInfo(limit=limit, offset=offset, total=total or 0),
    )

    await redis_client.setex(cache_key, logs_settings.LOG_CACHE_TTL_SECONDS, response.model_dump_json())
    logger.debug("Cached logs query result", cache_key=cache_key)

    return response
