"""RPC server — employee payslip PIN.

Queue: {ENVIRONMENT}.iam.rpc.employee_pin.queue  (Direct Reply-To pattern)

Request:
    { "operation": "get" | "get_or_create" | "regenerate",
      "user_id": "<oid>", "organisation_id": "<oid>" }
    { "operation": "verify",
      "user_id": "<oid>", "organisation_id": "<oid>", "pin": "<candidate>" }

Reply:
    { "correlation_id": "...",
      "data": {"cipher_text": "<b64>", "iv_key": "<b64>", "created": <bool>} | null }
    verify → { "correlation_id": "...",
               "data": {"valid": <bool>, "pin_set": <bool>,
                        "locked": <bool>, "retry_after": <int seconds>} }
"""
import asyncio
import json
from typing import Optional

import aio_pika

from src.config import settings
from src.logger import logger
from src.rabbitmq import connection

_QUEUE_NAME = f"{settings.ENVIRONMENT}.iam.rpc.employee_pin.queue"
_consumer_task: Optional[asyncio.Task] = None


async def _handle(message: aio_pika.abc.AbstractIncomingMessage) -> None:
    async with message.process(requeue=False):
        if not message.reply_to:
            logger.warning("rpc.employee_pin: message missing reply_to, dropping")
            return

        try:
            payload = json.loads(message.body)
        except (ValueError, TypeError):
            logger.warning("rpc.employee_pin: undecodable message body")
            return
        if not isinstance(payload, dict):
            # Valid JSON but not an object (e.g. a list/number from a foreign
            # producer) — reply null rather than crashing so the caller doesn't
            # wait out its full RPC timeout.
            logger.warning("rpc.employee_pin: non-object payload", body_type=type(payload).__name__)
            await _reply(message, message.correlation_id or "", None)
            return

        operation = payload.get("operation", "get")
        user_id = payload.get("user_id", "")
        organisation_id = payload.get("organisation_id", "")
        correlation_id = message.correlation_id or ""

        logger.info(
            "rpc.employee_pin: request received",
            operation=operation, user_id=user_id,
            organisation_id=organisation_id, correlation_id=correlation_id,
        )

        try:
            from src.modules.employee_pin import service as pin_svc

            if operation == "get":
                data = await pin_svc.get_pin(user_id, organisation_id)
            elif operation == "get_or_create":
                data = await pin_svc.get_or_create_pin(user_id, organisation_id, correlation_id)
            elif operation == "regenerate":
                data = await pin_svc.regenerate_pin(user_id, organisation_id, correlation_id)
            elif operation == "verify":
                data = await pin_svc.verify_pin(user_id, organisation_id, payload.get("pin", ""))
            else:
                logger.warning("rpc.employee_pin: unknown operation=%s", operation)
                data = None
        except Exception as exc:
            logger.error("rpc.employee_pin: lookup failed", error=repr(exc))
            data = None

        if operation == "verify":
            logger.info(
                "rpc.employee_pin: verify result",
                user_id=user_id, correlation_id=correlation_id,
                valid=bool(data and data.get("valid")),
                pin_set=bool(data and data.get("pin_set")),
            )
        else:
            logger.info(
                "rpc.employee_pin: replying",
                operation=operation, user_id=user_id,
                correlation_id=correlation_id, found=data is not None,
            )

        await _reply(message, correlation_id, data)


async def _reply(message: aio_pika.abc.AbstractIncomingMessage, correlation_id: str, data) -> None:
    """Publish the ``{correlation_id, data}`` envelope to the caller's reply_to."""
    if not message.reply_to:
        return
    reply = json.dumps({"correlation_id": correlation_id, "data": data}).encode()
    try:
        async with connection.rabbitmq_connection.channel() as channel:
            await channel.default_exchange.publish(
                aio_pika.Message(
                    body=reply,
                    content_type="application/json",
                    correlation_id=correlation_id,
                ),
                routing_key=message.reply_to,
            )
    except Exception as exc:
        logger.error("rpc.employee_pin: failed to send reply", error=repr(exc))


_START_RETRY_SECONDS = 5


async def _consume() -> bool:
    """Register the RPC consumer once. Returns False if the broker isn't ready.

    ``queue.consume`` registers a callback and returns; the RobustConnection then
    restores the consumer automatically across post-boot reconnects.
    """
    if not await connection.ensure_ready():
        return False
    channel = await connection.rabbitmq_connection.channel()
    await channel.set_qos(prefetch_count=10)
    queue = await channel.declare_queue(_QUEUE_NAME, durable=True)
    await queue.consume(_handle)
    logger.info("RPC employee_pin consumer started", queue=_QUEUE_NAME)
    return True


async def _run() -> None:
    """Keep trying to register the consumer until it succeeds, then return.

    Covers the broker-down-at-boot window: without this, a single failed
    ensure_ready() left the queue unconsumed forever (needing a manual restart).
    Once registered, the RobustConnection keeps the consumer alive on its own.
    """
    while True:
        try:
            if await _consume():
                return
            logger.warning("rpc.employee_pin: RabbitMQ not ready, retrying", retry_in=_START_RETRY_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("rpc.employee_pin: consumer start failed, retrying")
        await asyncio.sleep(_START_RETRY_SECONDS)


def start_employee_pin_rpc() -> None:
    global _consumer_task
    _consumer_task = asyncio.create_task(_run())


async def stop_employee_pin_rpc() -> None:
    if _consumer_task and not _consumer_task.done():
        _consumer_task.cancel()
        try:
            await _consumer_task
        except asyncio.CancelledError:
            pass
