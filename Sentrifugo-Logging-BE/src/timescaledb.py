import asyncpg

from src.logger import logger
from src.logs.config import logs_settings

pg_pool: asyncpg.Pool | None = None

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS audit_logs (
    event_id TEXT,
    timestamp TIMESTAMPTZ NOT NULL,
    module TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    debug_level INT NOT NULL,
    organisation_id TEXT,
    metadata JSONB
);
"""

# Idempotent migrations for tables created before these columns existed.
# organisation_id is promoted out of the metadata JSONB envelope into its own
# column so per-org Activity/audit views can filter and index on it.
ALTER_TABLE_SQL = [
    "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_id TEXT;",
    "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS organisation_id TEXT;",
]

CREATE_HYPERTABLE_SQL = """
SELECT create_hypertable('audit_logs', 'timestamp', if_not_exists => TRUE);
"""

CREATE_INDEXES_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs (module, timestamp DESC);",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, timestamp DESC);",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_debug ON audit_logs (debug_level, timestamp DESC);",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs (organisation_id, timestamp DESC);",
    # Dedup for at-least-once delivery: re-ingesting the same audit event is a
    # no-op (see ON CONFLICT in ingest_logs). On a hypertable a unique index MUST
    # include the partitioning column (timestamp). NULL event_ids (producers that
    # don't set a message id) are treated as distinct, so they're never blocked.
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_event ON audit_logs (event_id, timestamp);",
]


async def init_timescaledb():
    global pg_pool

    pg_pool = await asyncpg.create_pool(dsn=logs_settings.TIMESCALEDB_DSN)
    logger.info("TimescaleDB connection pool initialized")

    async with pg_pool.acquire() as conn:
        await conn.execute(CREATE_TABLE_SQL)
        for alter_sql in ALTER_TABLE_SQL:
            await conn.execute(alter_sql)
        await conn.execute(CREATE_HYPERTABLE_SQL)
        for idx_sql in CREATE_INDEXES_SQL:
            await conn.execute(idx_sql)
    logger.info("audit_logs hypertable ensured")


async def close_timescaledb():
    global pg_pool
    if pg_pool:
        await pg_pool.close()
        logger.info("TimescaleDB connection pool closed")


async def get_pg_pool() -> asyncpg.Pool:
    if not pg_pool:
        raise RuntimeError("TimescaleDB pool not initialized")
    return pg_pool
