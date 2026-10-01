from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import text

from src.attendance import client as target_api_client
from src.attendance.config import attendance_settings
from src.attendance.schemas import CrawlRunResult
from src.database import get_session_factory
from src.logger import logger


def _serialize_value(value: Any) -> Any:
    """Coerce driver-specific types (datetime, Decimal, bytes) into JSON-safe values."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return value.hex()
    return value


async def fetch_attendance_rows() -> list[dict[str, Any]]:
    """Run the configured crawl query against the MS SQL source and return rows as dicts."""
    session_factory = get_session_factory()
    async with session_factory() as session:
        result = await session.execute(text(attendance_settings.CRAWL_QUERY))
        columns = list(result.keys())
        return [{col: _serialize_value(val) for col, val in zip(columns, row)} for row in result.fetchall()]


async def run_crawl() -> CrawlRunResult:
    """One full crawl cycle: fetch from MS SQL, batch, and push to the target API."""
    started_at = datetime.now(timezone.utc)
    try:
        rows = await fetch_attendance_rows()
    except Exception as e:
        logger.error("Attendance crawl failed while querying MS SQL", error=str(e))
        return CrawlRunResult(
            status="failed",
            started_at=started_at,
            finished_at=datetime.now(timezone.utc),
            error=str(e),
        )

    if not rows:
        logger.info("Attendance crawl found no rows to send")
        return CrawlRunResult(
            status="success",
            started_at=started_at,
            finished_at=datetime.now(timezone.utc),
        )

    batch_size = attendance_settings.CRAWL_BATCH_SIZE
    batches_sent = 0
    batches_failed = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        if await target_api_client.send_batch(batch):
            batches_sent += 1
        else:
            batches_failed += 1

    status = "success" if batches_failed == 0 else ("partial" if batches_sent else "failed")
    result = CrawlRunResult(
        status=status,
        rows_fetched=len(rows),
        batches_sent=batches_sent,
        batches_failed=batches_failed,
        started_at=started_at,
        finished_at=datetime.now(timezone.utc),
    )
    logger.info(
        "Attendance crawl complete",
        status=status,
        rows_fetched=len(rows),
        batches_sent=batches_sent,
        batches_failed=batches_failed,
    )
    return result
