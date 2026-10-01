"""Shared Direct Reply-To RPC server scaffolding.

Every IAM RPC server needs the same three things, and each hand-rolled copy so
far has got a different subset of them right:

* **Always reply.** A handler that returns without publishing leaves the caller
  blocked until its timeout — or forever, if it passed none. Undecodable bodies,
  non-object payloads and handler exceptions all still produce an envelope.
* **Distinguish failure from emptiness.** The envelope carries an ``error`` field
  so a caller can tell "IAM blew up" from "IAM says there is nothing". Swallowing
  an exception into an empty result is how a transient Mongo blip turns into
  "this employee does not exist".
* **Survive a broker-down boot.** ``queue.consume`` only registers a callback; if
  the broker is not up yet, registration must be retried or the queue is never
  consumed until someone restarts the process.

Reply envelope::

    {"correlation_id": "<from request>", "data": <result | null>, "error": <str | null>}

``error`` is additive — existing clients that only read ``data`` are unaffected.
"""
import asyncio
import json
from typing import Awaitable, Callable, Optional

import aio_pika

from src.logger import logger
from src.rabbitmq import connection

# Handlers receive the decoded request payload and return whatever should land
# in ``data``. Raising is fine — it becomes an error envelope, not a hang.
Handler = Callable[[dict], Awaitable[object]]

_START_RETRY_SECONDS = 5


class RpcServer:
    """A single Direct Reply-To RPC queue, consumed by one handler."""

    def __init__(
        self,
        queue_name: str,
        handler: Handler,
        *,
        prefetch: int = 10,
        log_name: Optional[str] = None,
    ) -> None:
        self.queue_name = queue_name
        self.handler = handler
        self.prefetch = prefetch
        self.log_name = log_name or queue_name
        self._task: Optional[asyncio.Task] = None

    # ── Reply ────────────────────────────────────────────────────────────────

    async def _reply(
        self,
        message: aio_pika.abc.AbstractIncomingMessage,
        data: object,
        error: Optional[str] = None,
    ) -> None:
        if not message.reply_to:
            return
        correlation_id = message.correlation_id or ""
        body = json.dumps(
            {"correlation_id": correlation_id, "data": data, "error": error},
            default=str,
        ).encode()
        try:
            async with connection.rabbitmq_connection.channel() as channel:
                await channel.default_exchange.publish(
                    aio_pika.Message(
                        body=body,
                        content_type="application/json",
                        correlation_id=correlation_id,
                        delivery_mode=aio_pika.DeliveryMode.NOT_PERSISTENT,
                    ),
                    routing_key=message.reply_to,
                )
        except Exception as exc:
            # Nothing further we can do — the caller will fall back to its
            # timeout. Log loudly so a broken reply path is visible.
            logger.error(
                f"rpc.{self.log_name}: failed to send reply",
                correlation_id=correlation_id,
                error=repr(exc),
            )

    # ── Message handling ─────────────────────────────────────────────────────

    async def _handle(self, message: aio_pika.abc.AbstractIncomingMessage) -> None:
        async with message.process(requeue=False):
            if not message.reply_to:
                # No return address; replying is impossible, so drop it.
                logger.warning(f"rpc.{self.log_name}: message missing reply_to, dropping")
                return

            try:
                payload = json.loads(message.body)
            except (ValueError, TypeError) as exc:
                logger.warning(f"rpc.{self.log_name}: undecodable message body", error=str(exc))
                await self._reply(message, None, error="undecodable request body")
                return
            if not isinstance(payload, dict):
                logger.warning(
                    f"rpc.{self.log_name}: non-object payload",
                    body_type=type(payload).__name__,
                )
                await self._reply(message, None, error="request payload must be an object")
                return

            try:
                data = await self.handler(payload)
            except Exception as exc:
                # An error envelope, NOT an empty result: the caller must be able
                # to retry rather than treat this as an authoritative "nothing".
                logger.error(
                    f"rpc.{self.log_name}: handler failed",
                    correlation_id=message.correlation_id,
                    error=repr(exc),
                )
                await self._reply(message, None, error=repr(exc))
                return

            await self._reply(message, data)

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def _consume(self) -> bool:
        """Register the consumer once. False if the broker isn't ready yet.

        ``queue.consume`` registers a callback and returns; the RobustConnection
        then restores the consumer automatically across post-boot reconnects.
        """
        if not await connection.ensure_ready():
            return False
        channel = await connection.rabbitmq_connection.channel()
        await channel.set_qos(prefetch_count=self.prefetch)
        queue = await channel.declare_queue(self.queue_name, durable=True)
        await queue.consume(self._handle)
        logger.info(f"RPC {self.log_name} consumer started", queue=self.queue_name)
        return True

    async def _run(self) -> None:
        """Keep trying to register the consumer until it succeeds, then return."""
        while True:
            try:
                if await self._consume():
                    return
                logger.warning(
                    f"rpc.{self.log_name}: RabbitMQ not ready, retrying",
                    retry_in=_START_RETRY_SECONDS,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(f"rpc.{self.log_name}: consumer start failed, retrying")
            await asyncio.sleep(_START_RETRY_SECONDS)

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
