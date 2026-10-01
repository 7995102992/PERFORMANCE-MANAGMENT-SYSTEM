"""In-process sweep of spent act-from-email tokens.

Mirrors ``sla_scheduler`` — a task started from the app lifespan, looping until
cancelled — for the same reason it exists: the Schedule Service is
message-driven (a task arrives on RabbitMQ and an executor runs it) and has no
cron, so nothing external is going to call this on a timer.

Housekeeping only. Deletes tokens already long past expiry; a missed run costs
nothing but a slightly larger collection, which is why this loop is quiet and
never alarms.

Set ACTION_TOKEN_PURGE_INTERVAL_SECONDS=0 to disable and drive
``/_internal/jobs/purge-action-tokens`` from an external cron instead.
"""
from __future__ import annotations

import asyncio
import logging

from ..config import settings
from .action_tokens import purge_expired_tokens

logger = logging.getLogger(__name__)

_purge_task: asyncio.Task | None = None


async def _purge_loop() -> None:
    interval = settings.ACTION_TOKEN_PURGE_INTERVAL_SECONDS
    logger.info("token_purge.started interval=%ss", interval)
    while True:
        try:
            summary = await purge_expired_tokens()
            # Quiet on the common path — most days delete nothing.
            if summary.get("deleted"):
                logger.info("token_purge.swept %s", summary)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the loop must outlive any one sweep
            logger.exception("token_purge.failed")
        await asyncio.sleep(interval)


async def start_token_purge_ticker() -> None:
    global _purge_task
    if settings.ACTION_TOKEN_PURGE_INTERVAL_SECONDS <= 0:
        logger.info("token_purge.disabled ACTION_TOKEN_PURGE_INTERVAL_SECONDS=0")
        return
    if _purge_task and not _purge_task.done():
        return
    _purge_task = asyncio.create_task(_purge_loop())


async def stop_token_purge_ticker() -> None:
    global _purge_task
    if _purge_task and not _purge_task.done():
        _purge_task.cancel()
        try:
            await _purge_task
        except asyncio.CancelledError:
            pass
    _purge_task = None
    logger.info("token_purge.stopped")
