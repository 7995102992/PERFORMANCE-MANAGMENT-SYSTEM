"""Direct Reply-To RPC client for IAM lookups (employees + payslip PINs).

Payroll resolves data owned by IAM over RabbitMQ Direct Reply-To, mirroring the
suite's RPC pattern (see timesheet ``lms_rpc.py``):

* ``resolve_employees`` — map upload ``emp_code``s to the IAM ``user_id`` (+ bank/
  statutory fields, tenant validation) on the
  ``{ENVIRONMENT}.iam.rpc.employee_lookup.queue`` queue.
* ``employee_pin`` — fetch/create/regenerate a user's payslip PIN on the
  ``{ENVIRONMENT}.iam.rpc.employee_pin.queue`` queue. IAM owns the PIN lifecycle
  (generation, storage, email) and returns the AES-256-GCM ``cipher_text`` +
  ``iv_key``, which this service decrypts with the shared ``ENCRYPTION_KEY``.

IAM replies on the reply-to pseudo-queue with::

    {"correlation_id": "...", "data": <result | null>}
"""
from __future__ import annotations

import asyncio
import json
from uuid import uuid4

import aio_pika

from src.config import settings
from src.rabbitmq import connection

_REPLY_TO = "amq.rabbitmq.reply-to"


class IamUnavailable(Exception):
    """RabbitMQ is unreachable, so IAM cannot be queried."""


class IamTimeout(IamUnavailable):
    """IAM did not reply within the RPC timeout.

    Subclasses ``IamUnavailable`` so ``except IamUnavailable`` call sites treat a
    timed-out IAM as simply unavailable (degrade gracefully / retry later).
    """


async def _rpc_data(routing_key: str, payload: dict, timeout: float | None) -> object:
    """Publish ``payload`` via Direct Reply-To and return the reply's ``data``.

    Raises:
        IamUnavailable: the broker is not connected.
        IamTimeout: a ``timeout`` was given and IAM did not reply within it.
    """
    if not connection.is_connected():
        raise IamUnavailable("RabbitMQ is not connected")

    correlation_id = str(uuid4())
    body = json.dumps(payload).encode()
    future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()

    # Direct Reply-To requires consume + publish on the SAME dedicated channel.
    channel = await connection.rabbitmq_connection.channel()
    try:

        async def _on_reply(message) -> None:  # aiormq.abc.DeliveredMessage
            if message.header.properties.correlation_id == correlation_id and not future.done():
                try:
                    future.set_result(json.loads(message.body))
                except Exception as exc:
                    future.set_exception(exc)

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

        if timeout is None:
            envelope = await future  # wait until IAM replies — no timeout
        else:
            try:
                envelope = await asyncio.wait_for(future, timeout=timeout)
            except TimeoutError as exc:
                raise IamTimeout(
                    f"IAM RPC to {routing_key} timed out after {timeout}s (correlation_id={correlation_id})"
                ) from exc

        return envelope.get("data") if isinstance(envelope, dict) else None
    finally:
        await channel.close()


async def resolve_employees(
    emp_codes: list[str],
    organisation_id: str,
    business_unit_id: str,
    timeout: float | None = None,
) -> dict[str, dict | None]:
    """Resolve ``emp_codes`` to employee info via IAM Direct Reply-To RPC.

    Returns ``{emp_code: {info} | None}`` — ``None`` for unknown / out-of-scope
    codes. ``timeout=None`` waits indefinitely; pass a number for a bounded wait.
    """
    if not emp_codes:
        return {}
    data = await _rpc_data(
        f"{settings.ENVIRONMENT}.iam.rpc.employee_lookup.queue",
        {
            "emp_codes": [str(c) for c in emp_codes],
            "organisation_id": str(organisation_id),
            "business_unit_id": str(business_unit_id),
        },
        timeout,
    )
    return data if isinstance(data, dict) else {}


async def employee_pin(
    user_id: str,
    organisation_id: str | None,
    operation: str = "get_or_create",
    timeout: float | None = None,
) -> dict | None:
    """Fetch a user's payslip PIN from IAM (which owns the PIN lifecycle).

    Args:
        user_id: The IAM user whose PIN is needed.
        organisation_id: The user's organisation (tenant context for IAM).
        operation: ``"get"`` (fetch only, ``None`` if unset), ``"get_or_create"``
            (create + email a PIN if the user has none), or ``"regenerate"``
            (replace + email a fresh PIN).

    Returns:
        ``{"cipher_text": <b64>, "iv_key": <b64>, "created": bool}`` — the
        AES-256-GCM ciphertext + IV this service decrypts with the shared key — or
        ``None`` when the user has no PIN (``get``) or IAM returns nothing.
    """
    data = await _rpc_data(
        f"{settings.ENVIRONMENT}.iam.rpc.employee_pin.queue",
        {"operation": operation, "user_id": str(user_id), "organisation_id": str(organisation_id or "")},
        timeout,
    )
    return data if isinstance(data, dict) else None
