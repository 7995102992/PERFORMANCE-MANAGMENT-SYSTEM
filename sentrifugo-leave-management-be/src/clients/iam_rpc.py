"""Direct Reply-To RPC client for IAM lookups.

Replaces the unauthenticated ``/internal/*`` HTTP channel this service used to
call. Mirrors the suite's RPC pattern (payroll ``iam_rpc.py``, timesheet
``lms_rpc.py``): publish to a well-known queue with ``reply_to`` set to the
``amq.rabbitmq.reply-to`` pseudo-queue, match the reply by ``correlation_id``.

IAM replies with::

    {"correlation_id": "...", "data": <result | null>, "error": <str | null>}

Every failure mode raises :class:`IamUnavailable` (or a subclass). Nothing here
returns an empty result on failure — callers sweeping a cursor MUST be able to
tell "IAM says there is no more" from "IAM did not answer", or a broker hiccup
mid-sweep reads as a successful end-of-collection.
"""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import aio_pika

from src import rabbitmq as _rabbitmq
from src.config import settings
from src.logger import logger

_REPLY_TO = "amq.rabbitmq.reply-to"


class IamUnavailable(Exception):
    """RabbitMQ is unreachable, so IAM cannot be queried."""


class IamTimeout(IamUnavailable):
    """IAM did not reply within the RPC timeout.

    Subclasses ``IamUnavailable`` so ``except IamUnavailable`` call sites treat a
    timed-out IAM as simply unavailable (degrade gracefully / retry later).
    """


class IamError(IamUnavailable):
    """IAM replied, but with an error envelope.

    Also an ``IamUnavailable`` so callers degrade identically — the distinction
    exists so logs can tell a broken handler from a broken transport.
    """


async def rpc_call(queue: str, payload: dict, timeout: float) -> object:
    """Publish ``payload`` to ``queue`` and return the reply's ``data``.

    Args:
        queue: The unqualified queue name, e.g. ``"employees_sync"``. The
            environment prefix and ``iam.rpc.*.queue`` shape are applied here so
            no call site can get them subtly wrong.
        timeout: Seconds to wait for a reply. Required on purpose — an unbounded
            wait means a dead consumer parks this coroutine forever.

    Raises:
        IamUnavailable: broker unreachable, or a publish-path error.
        IamTimeout: no reply within ``timeout``.
        IamError: IAM replied with an ``error``, or with an undecodable body.
    """
    # Publish paths must use ensure_ready() — is_closed stays False during a
    # RobustConnection reconnect, so is_connected() would be a false positive.
    if not await _rabbitmq.ensure_ready():
        raise IamUnavailable("RabbitMQ is not ready")

    routing_key = f"{settings.ENVIRONMENT}.iam.rpc.{queue}.queue"
    correlation_id = str(uuid4())
    body = json.dumps(payload).encode()
    future: asyncio.Future[dict | None] = asyncio.get_running_loop().create_future()

    def _on_reply(message) -> None:  # aiormq.abc.DeliveredMessage
        if message.header.properties.correlation_id != correlation_id or future.done():
            return
        try:
            future.set_result(json.loads(message.body))
        except Exception as exc:  # foreign/corrupt reply on the shared queue
            logger.warning("iam_rpc.bad_reply", routing_key=routing_key, error=str(exc))
            future.set_result({"error": f"undecodable reply: {exc}"})

    channel = None
    try:
        # Direct Reply-To requires consume + publish on the SAME dedicated channel.
        channel = await _rabbitmq.rabbitmq_connection.channel()
        # no_ack=True is required by the RabbitMQ spec for the reply-to pseudo-queue.
        await channel.channel.basic_consume(_REPLY_TO, _on_reply, no_ack=True)
        await channel.default_exchange.publish(
            aio_pika.Message(
                body=body,
                reply_to=_REPLY_TO,
                correlation_id=correlation_id,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.NOT_PERSISTENT,
            ),
            routing_key=routing_key,
        )
        envelope = await asyncio.wait_for(future, timeout=timeout)
    except (TimeoutError, asyncio.TimeoutError) as exc:
        raise IamTimeout(
            f"IAM RPC to {routing_key} timed out after {timeout}s "
            f"(correlation_id={correlation_id})"
        ) from exc
    except IamUnavailable:
        raise
    except Exception as exc:  # channel-open / publish / transport error mid-outage
        logger.warning("iam_rpc.publish_failed", routing_key=routing_key, error=repr(exc))
        raise IamUnavailable(f"IAM RPC transport error: {exc}") from exc
    finally:
        if channel is not None:
            try:
                await channel.close()
            except Exception:  # noqa: BLE001 - closing a dead channel must not mask the real error
                pass

    if not isinstance(envelope, dict):
        raise IamError(f"IAM RPC to {routing_key} returned a non-object envelope")
    if envelope.get("error"):
        raise IamError(f"IAM RPC to {routing_key} failed: {envelope['error']}")
    return envelope.get("data")
