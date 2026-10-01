"""
Attendance crawl cron.

Background task that periodically pulls attendance rows from the MS SQL source
database and pushes them to the configured target API. Runs every
``CRAWL_INTERVAL_HOURS`` (default 6h); optionally runs once immediately on
startup so a fresh deploy syncs without waiting a full interval.

Modelled on the cron pattern used across the other Sentrifugo services
(see leave-management ``employee_sync/cron.py``).
"""

import asyncio

from src.attendance import service
from src.attendance.config import attendance_settings
from src.attendance.schemas import CrawlRunResult
from src.logger import logger

_cron_task: asyncio.Task | None = None
_crawl_lock = asyncio.Lock()

# Module state read by the router's status endpoint.
last_run: CrawlRunResult | None = None


def is_running() -> bool:
    return _crawl_lock.locked()


async def run_crawl_guarded() -> CrawlRunResult:
    """Run one crawl, guaranteeing only one crawl is in flight at a time.

    The lock protects against a manual trigger overlapping the scheduled run —
    two concurrent crawls would double-send every row to the target API.
    """
    global last_run
    if _crawl_lock.locked():
        return CrawlRunResult(status="skipped", error="A crawl is already in progress")
    async with _crawl_lock:
        last_run = await service.run_crawl()
        return last_run


async def _cron_loop() -> None:
    interval_seconds = attendance_settings.CRAWL_INTERVAL_HOURS * 3600
    logger.info(
        "Attendance crawl cron started",
        interval_hours=attendance_settings.CRAWL_INTERVAL_HOURS,
        crawl_on_startup=attendance_settings.CRAWL_ON_STARTUP,
    )
    if attendance_settings.CRAWL_ON_STARTUP:
        await run_crawl_guarded()
    while True:
        await asyncio.sleep(interval_seconds)
        await run_crawl_guarded()


def start_cron() -> None:
    global _cron_task
    _cron_task = asyncio.create_task(_cron_loop())


async def stop_cron() -> None:
    global _cron_task
    if _cron_task:
        _cron_task.cancel()
        try:
            await _cron_task
        except asyncio.CancelledError:
            pass
        _cron_task = None
        logger.info("Attendance crawl cron stopped")
