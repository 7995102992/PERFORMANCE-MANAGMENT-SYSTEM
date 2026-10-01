"""Shared plumbing for this service's Direct Reply-To RPC consumers.

Two things every RPC consumer here was missing, extracted so both get them and
any future one inherits them:

* **Always reply.** A consumer that logs and returns leaves the caller blocked
  until its timeout — and timesheet's ``get_employee_leave_calendar`` client
  passes no timeout at all, so "until its timeout" means forever. A malformed
  request must still produce an envelope.
* **Survive a broker-down boot.** Consumer registration happens once inside
  ``main``'s startup try/except; if the broker is not up yet the whole block is
  skipped and the queues stay unconsumed until someone restarts the process.
  Registration is retried here instead.

Reply envelope::

    {"correlation_id": "...", "data": <result | null>, "error": <str | null>}

``error`` is additive — callers that only read ``data`` are unaffected.
"""
import asyncio
import json
from typing import Awaitable, Callable, Optional

import aio_pika

from src.logger import logger
from src.rabbitmq import get_connection

_START_RETRY_SECONDS = 5

# Registration tasks are kept referenced; a bare create_task can be garbage
# collected mid-flight, which would silently un-start a consumer.
_tasks: set[asyncio.Task] = set()


async def publish_reply(
    reply_to: Optional[str],
    correlation_id: Optional[str],
    data: object,
    *,
    error: Optional[str] = None,
    log_name: str = "rpc",
) -> None:
    """Publish the ``{correlation_id, data, error}`` envelope to ``reply_to``."""
    if not reply_to:
        return
    body = json.dumps(
        {"correlation_id": correlation_id, "data": data, "error": error},
        default=str,
    ).encode()
    try:
        async with get_connection().channel() as channel:
            await channel.default_exchange.publish(
                aio_pika.Message(
                    body=body,
                    content_type="application/json",
                    correlation_id=correlation_id,
                    delivery_mode=aio_pika.DeliveryMode.NOT_PERSISTENT,
                ),
                routing_key=reply_to,
            )
    except Exception as exc:
        # Nothing further we can do; the caller falls back to its timeout.
        logger.error(
            f"{log_name}: failed to publish response",
            correlation_id=correlation_id,
            error=repr(exc),
        )


def start_with_retry(log_name: str, register: Callable[[], Awaitable[None]]) -> None:
    """Run ``register`` in the background, retrying until it succeeds.

    ``register`` should declare the queue and attach the consumer callback.
    ``queue.consume`` only registers the callback and returns — the
    RobustConnection restores it automatically across later reconnects, so this
    only needs to cover the broker-down-at-boot window.
    """

    async def _run() -> None:
        while True:
            try:
                await register()
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    f"{log_name}: consumer start failed, retrying",
                    retry_in=_START_RETRY_SECONDS,
                )
            await asyncio.sleep(_START_RETRY_SECONDS)

    task = asyncio.create_task(_run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
