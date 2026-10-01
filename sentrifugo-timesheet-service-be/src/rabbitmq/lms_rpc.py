from __future__ import annotations

import asyncio
import json
from datetime import date
from uuid import uuid4

import aio_pika

from ..config import settings
from . import connection as _conn

_REPLY_TO = "amq.rabbitmq.reply-to"
_DEFAULT_RPC_TIMEOUT = 10.0  # seconds


class LMSUnavailable(Exception):
    """Raised when the broker is unreachable."""


class LMSTimeout(LMSUnavailable):
    """Raised when LMS does not reply within the RPC timeout.

    Subclasses LMSUnavailable so existing ``except LMSUnavailable`` call sites
    degrade gracefully (treat a timed-out LMS as unavailable).
    """


async def get_employee_leave_calendar(
    employee_ids: list[str],
    from_date: date | str,
    to_date: date | str,
) -> dict:
    if not _conn.is_connected():
        raise LMSUnavailable("RabbitMQ is not connected")

    correlation_id = str(uuid4())
    routing_key = f"{settings.ENVIRONMENT}.lms.rpc.leave_calendar.queue"
    body = json.dumps({
        "employee_ids": employee_ids,
        "from_date": from_date.isoformat() if isinstance(from_date, date) else from_date,
        "to_date": to_date.isoformat() if isinstance(to_date, date) else to_date,
    }).encode()

    future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()

    # Open a dedicated channel; Direct Reply-To requires consume + publish on the same channel.
    channel = await _conn.rabbitmq_connection.channel()
    try:
        async def _on_reply(message) -> None:  # aiormq.abc.DeliveredMessage
            if message.header.properties.correlation_id == correlation_id and not future.done():
                try:
                    future.set_result(json.loads(message.body))
                except Exception as exc:
                    future.set_exception(exc)

        # basic_consume on the Direct Reply-To pseudo-queue (cannot be declared normally).
        # no_ack=True is required by the RabbitMQ spec for this pseudo-queue.
        await channel.channel.basic_consume(
            _REPLY_TO,
            _on_reply,
            no_ack=True,
        )

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

        return await future
    finally:
        await channel.close()


async def get_employee_shift_details(
    employee_ids: list[str],
    timeout: float = _DEFAULT_RPC_TIMEOUT,
) -> dict:
    """Query LMS for each employee's calendar/shift details via Direct Reply-To RPC.

    Returns the parsed LMS response, e.g.::

        {"correlation_id": "...", "data": {"<user_id>": {... shift info ...} | None}}

    where ``data[user_id]`` is None when no calendar is assigned, and individual
    shift fields are None when a calendar is assigned but no shift is.

    Raises:
        LMSUnavailable: when the broker is not connected.
        LMSTimeout:     when LMS does not reply within ``timeout`` seconds.
    """
    if not _conn.is_connected():
        raise LMSUnavailable("RabbitMQ is not connected")

    correlation_id = str(uuid4())
    routing_key = f"{settings.ENVIRONMENT}.lms.rpc.shift_details.queue"
    body = json.dumps({"employee_ids": [str(e) for e in employee_ids]}).encode()

    future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()

    # Direct Reply-To requires consume + publish on the SAME dedicated channel.
    channel = await _conn.rabbitmq_connection.channel()
    try:
        async def _on_reply(message) -> None:  # aiormq.abc.DeliveredMessage
            if message.header.properties.correlation_id == correlation_id and not future.done():
                try:
                    future.set_result(json.loads(message.body))
                except Exception as exc:
                    future.set_exception(exc)

        # no_ack=True is required by the RabbitMQ spec for the reply-to pseudo-queue.
        await channel.channel.basic_consume(
            _REPLY_TO,
            _on_reply,
            no_ack=True,
        )

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

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise LMSTimeout(
                f"LMS shift_details RPC timed out after {timeout}s "
                f"(correlation_id={correlation_id})"
            )
    finally:
        await channel.close()
