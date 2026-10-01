"""In-process SLA tick loop.

`run_sla_tick` pops expired deadlines out of the store and applies the SLA
rule's violation actions. Something has to call it on a timer — and nothing did:
the Schedule Service has no scheduler (it is message-driven; a task arrives on
RabbitMQ and an executor runs it), so the docstring's "called by Schedule
Service every 60s" was never true. Hence zero escalations across every ticket
ever raised.

This mirrors the outbox relay (``rabbitmq/outbox.py``): a task started from the
app lifespan, looping until cancelled.

Safe to run on more than one replica: deadlines live in Mongo and are taken with
an atomic per-entry claim (``sla_store.claim_due``), so two loops racing for the
same entry cannot both win it. That was *not* true of the Valkey ZSET this
replaced, whose ZRANGEBYSCORE-then-ZREM was two round trips and could double-fire
a breach. Setting SLA_TICK_INTERVAL_SECONDS=0 and driving
``/_internal/jobs/sla-tick`` from an external cron remains a valid alternative if
you would rather the cadence live outside the app.
"""
from __future__ import annotations

import asyncio
import logging

from ..config import settings
from .service_sla_tick import run_sla_tick

logger = logging.getLogger(__name__)

_tick_task: asyncio.Task | None = None


async def _tick_loop() -> None:
    interval = settings.SLA_TICK_INTERVAL_SECONDS
    logger.info("sla_ticker.started interval=%ss", interval)
    while True:
        try:
            summary = await run_sla_tick()
            # Quiet on the common path — a tick with nothing due is every tick
            # on an idle system. Only speak up when something happened.
            if summary.get("processed"):
                logger.info("sla_ticker.tick %s", summary)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the loop must outlive any one tick
            logger.exception("sla_ticker.tick_failed")
        await asyncio.sleep(interval)


async def start_sla_ticker() -> None:
    global _tick_task
    if settings.SLA_TICK_INTERVAL_SECONDS <= 0:
        logger.info("sla_ticker.disabled SLA_TICK_INTERVAL_SECONDS=0")
        return
    if _tick_task and not _tick_task.done():
        return
    _tick_task = asyncio.create_task(_tick_loop())


async def stop_sla_ticker() -> None:
    global _tick_task
    if _tick_task and not _tick_task.done():
        _tick_task.cancel()
        try:
            await _tick_task
        except asyncio.CancelledError:
            pass
    _tick_task = None
    logger.info("sla_ticker.stopped")
