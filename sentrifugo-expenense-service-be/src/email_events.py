"""Expense email event publisher — publishes to the ``email_events`` exchange.

Uses the same transactional outbox as IAM / SRM so emails survive broker
downtime. A downstream email worker (shared across services) consumes these
events and sends the actual emails via SMTP.

Template IDs follow the convention ``expense_<event>_v1``. Expense gate
notifications (the ``expense_gate_v1`` template) are added to this module as
thin wrappers around :func:`_publish_email` once the gate workflow lands — this
file intentionally ships with the generic scaffolding only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from src.logger import logger
from src.rabbitmq.constants import email_events_config
from src.rabbitmq.outbox import publish


def _envelope(event_type: str, tenant_id: str, payload: dict, idempotency_key: str = "") -> dict:
    """Wrap an email payload in the cross-service task envelope.

    Args:
        event_type: Routing key / event name (e.g. ``email.expense.gate``).
        tenant_id: Organisation the email belongs to.
        payload: Email body — ``to``, ``template_id``, ``template_data``.
        idempotency_key: Consumer-side dedupe key; generated when omitted.

    Returns:
        The envelope dict expected by the shared email worker.
    """
    return {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": event_type,
        "correlation_id": str(uuid4()),
        "idempotency_key": idempotency_key or str(uuid4()),
        "tenant_id": tenant_id,
        "payload": payload,
        "published_at": datetime.now(UTC).isoformat(),
    }


async def _publish_email(
    routing_key: str,
    to: str,
    template_id: str,
    template_data: dict,
    tenant_id: str = "",
    idempotency_suffix: str = "",
) -> None:
    """Publish one templated email to the ``email_events`` exchange via the outbox.

    Never raises: a publish failure is logged so email delivery can never break
    the caller's business transaction.

    Args:
        routing_key: Event name / routing key (e.g. ``email.expense.gate``).
        to: Recipient email address.
        template_id: Email template identifier (e.g. ``expense_gate_v1``).
        template_data: Values interpolated into the template.
        tenant_id: Organisation the email belongs to.
        idempotency_suffix: Discriminator appended to the outbox dedupe key —
            pass something stable per (event, recipient) so re-publishes do not
            double-send, and widen it when fanning out to several recipients.
    """
    envelope_idemp = str(uuid4())
    outbox_idemp = f"{routing_key}:{idempotency_suffix or uuid4()}"
    envelope = _envelope(
        routing_key,
        tenant_id,
        {"to": to, "template_id": template_id, "template_data": template_data},
        idempotency_key=envelope_idemp,
    )
    try:
        await publish(
            routing_key,
            envelope,
            idempotency_key=outbox_idemp,
            exchange=email_events_config.EXCHANGE_NAME,
        )
        logger.info(
            "EMAIL_TRIGGER",
            event=routing_key,
            to=to,
            template=template_id,
            data=template_data,
        )
    except Exception as e:
        logger.warning("email_event.publish_failed", routing_key=routing_key, to=to, error=str(e))


# ── Public email triggers ─────────────────────────────────────────────────
# Expense gate notifications (``expense_gate_v1``) go here.
