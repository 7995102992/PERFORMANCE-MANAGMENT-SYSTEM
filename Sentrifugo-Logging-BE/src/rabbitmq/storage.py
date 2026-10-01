"""Postgres-backed persistence for the transactional outbox.

The original spec called for a Beanie/MongoDB ``OutboxEventDocument``; this
service uses TimescaleDB+asyncpg, so the document is adapted to a regular
relational table living alongside ``audit_logs``. The shape is preserved
1:1 — id, idempotency_key, exchange, event_type, payload, status, retries,
created_at, sent_at — so consumers and reasoning about the pattern stay
identical.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from src.logger import logger
from src.timescaledb import get_pg_pool

OUTBOX_TABLE = "outbox_events"

CREATE_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {OUTBOX_TABLE} (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT 'domain_events',
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retries INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    dead_lettered_at TIMESTAMPTZ
);
"""

# Idempotent migration for tables created before dead_lettered_at existed.
ALTER_TABLE_SQL = (
    f"ALTER TABLE {OUTBOX_TABLE} "
    f"ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;"
)

CREATE_INDEXES_SQL = [
    f"CREATE INDEX IF NOT EXISTS idx_{OUTBOX_TABLE}_status_created "
    f"ON {OUTBOX_TABLE} (status, created_at);",
    f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{OUTBOX_TABLE}_idempotency_key "
    f"ON {OUTBOX_TABLE} (idempotency_key);",
]


@dataclass
class OutboxEvent:
    id: str
    idempotency_key: str
    exchange: str
    event_type: str
    payload: dict
    status: str
    retries: int
    created_at: datetime
    sent_at: Optional[datetime] = None
    dead_lettered_at: Optional[datetime] = None

    @classmethod
    def new(
        cls,
        *,
        idempotency_key: str,
        event_type: str,
        payload: dict,
        exchange: str,
    ) -> "OutboxEvent":
        return cls(
            id=str(uuid4()),
            idempotency_key=idempotency_key,
            exchange=exchange,
            event_type=event_type,
            payload=payload,
            status="pending",
            retries=0,
            created_at=datetime.now(timezone.utc),
            sent_at=None,
        )


_schema_ready = False


async def ensure_outbox_schema() -> None:
    """Idempotent CREATE TABLE / CREATE INDEX. Safe to call multiple times."""
    global _schema_ready
    if _schema_ready:
        return
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        await conn.execute(CREATE_TABLE_SQL)
        await conn.execute(ALTER_TABLE_SQL)
        for idx_sql in CREATE_INDEXES_SQL:
            await conn.execute(idx_sql)
    _schema_ready = True
    logger.info("outbox_events table ensured")


async def insert_event(event: OutboxEvent) -> bool:
    """Insert the event idempotently.

    ``idempotency_key`` is uniquely indexed; on a duplicate (retry/replay) the
    ``ON CONFLICT DO NOTHING`` makes this a no-op. Returns ``True`` if a new row
    was inserted, ``False`` if it already existed.
    """
    import json

    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            f"""
            INSERT INTO {OUTBOX_TABLE}
                (id, idempotency_key, exchange, event_type, payload,
                 status, retries, created_at, sent_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
            ON CONFLICT (idempotency_key) DO NOTHING
            """,
            event.id,
            event.idempotency_key,
            event.exchange,
            event.event_type,
            json.dumps(event.payload),
            event.status,
            event.retries,
            event.created_at,
            event.sent_at,
        )
    # asyncpg returns the command tag, e.g. "INSERT 0 1" (inserted) or
    # "INSERT 0 0" (conflict — nothing written).
    return result.endswith("1")


async def find_event_id_by_idempotency_key(idempotency_key: str) -> Optional[str]:
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT id FROM {OUTBOX_TABLE} WHERE idempotency_key = $1",
            idempotency_key,
        )
    return row["id"] if row else None


async def mark_sent(event_id: str, sent_at: datetime) -> None:
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {OUTBOX_TABLE} SET status = 'sent', sent_at = $2 WHERE id = $1",
            event_id,
            sent_at,
        )


async def mark_failed(event_id: str, retries: int) -> None:
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {OUTBOX_TABLE} SET status = 'failed', retries = $2 WHERE id = $1",
            event_id,
            retries,
        )


async def mark_dead_lettered(event_id: str, retries: int, dead_lettered_at: datetime) -> None:
    """Terminal failure: the event exhausted MAX_RETRIES. Stamp the time so it's
    distinguishable from a retryable 'failed' row (the relay query filters
    retries < MAX_RETRIES, so it won't be picked up again). Row kept for replay."""
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            f"UPDATE {OUTBOX_TABLE} "
            f"SET status = 'failed', retries = $2, dead_lettered_at = $3 WHERE id = $1",
            event_id,
            retries,
            dead_lettered_at,
        )


async def fetch_pending_batch(*, max_retries: int, batch_size: int) -> list[OutboxEvent]:
    pool = await get_pg_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, idempotency_key, exchange, event_type, payload,
                   status, retries, created_at, sent_at, dead_lettered_at
            FROM {OUTBOX_TABLE}
            WHERE status IN ('pending', 'failed') AND retries < $1
            ORDER BY created_at ASC
            LIMIT $2
            """,
            max_retries,
            batch_size,
        )

    import json

    events: list[OutboxEvent] = []
    for row in rows:
        payload = row["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        events.append(
            OutboxEvent(
                id=row["id"],
                idempotency_key=row["idempotency_key"],
                exchange=row["exchange"],
                event_type=row["event_type"],
                payload=payload,
                status=row["status"],
                retries=row["retries"],
                created_at=row["created_at"],
                sent_at=row["sent_at"],
                dead_lettered_at=row["dead_lettered_at"],
            )
        )
    return events
