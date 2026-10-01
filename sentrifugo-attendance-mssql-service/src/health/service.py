from typing import Any

from sqlalchemy import text

from src import database
from src.attendance import cron
from src.logger import logger


async def check_health() -> dict[str, Any]:
    """Report connectivity of each infra dependency.

    Every probe is defensive: an uninitialized or unreachable dependency is
    reported as disconnected (``degraded``) rather than raising. A health
    endpoint must never fail just because the infrastructure it reports on is down.
    """
    db_connected = False

    try:
        if database.engine is not None:
            async with database.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            db_connected = True
    except Exception as e:
        logger.error("Database health check failed", error=str(e))

    status = "ok" if db_connected else "degraded"

    return {
        "status": status,
        "db_connected": db_connected,
        "crawler_running": cron.is_running(),
    }
