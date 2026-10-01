from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from ...config import settings
from ...rabbitmq import outbox
from ...rabbitmq.constants import email_events_config

ACTIVATION_ROUTING_KEY = "email.activation"


async def publish_activation_email(
    *,
    to: str,
    display_name: str,
    activation_token: str,
    tenant_id: str = "",
    reset_link: str = "",
) -> None:
    activation_link = f"{settings.FRONTEND_URL}/activate?token={activation_token}"

    envelope = {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": ACTIVATION_ROUTING_KEY,
        "correlation_id": str(uuid4()),
        "idempotency_key": str(uuid4()),
        "tenant_id": tenant_id,
        "payload": {
            "to": to,
            "template_id": "activation_v1",
            "template_data": {
                "display_name": display_name,
                "activation_link": activation_link,
                "reset_link": reset_link,
            },
        },
        "published_at": datetime.now(timezone.utc).isoformat(),
    }

    await outbox.publish(
        ACTIVATION_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.activation:{to}:{activation_token[:16]}",
        exchange=email_events_config.EXCHANGE_NAME,
    )
