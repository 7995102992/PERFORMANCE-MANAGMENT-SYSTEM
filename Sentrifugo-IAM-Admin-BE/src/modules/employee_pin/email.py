from uuid import uuid4

from src.config import settings
from src.rabbitmq import outbox
from src.rabbitmq.constants import email_events_config

ROUTING_KEY = "email.payslip_pin_generated"


async def publish_pin_email(
    user_email: str,
    display_name: str,
    pin: str,
    tenant_id: str = "",
    correlation_id: str = "",
) -> None:
    payroll_link = f"{settings.USER_FRONTEND_URL or settings.FRONTEND_URL or ''}/payroll/my"
    envelope = {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": "email.payslip_pin_generated",
        "correlation_id": correlation_id or str(uuid4()),
        "idempotency_key": str(uuid4()),
        "tenant_id": tenant_id,
        "payload": {
            "to": user_email,
            "template_id": "payslip_pin_generated_v1",
            "template_data": {
                "display_name": display_name,
                "pin": pin,
                "payslip_link": payroll_link,
            },
            "priority": "high",
        },
        "published_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
    }
    await outbox.publish(
        ROUTING_KEY,
        envelope,
        idempotency_key=f"email.payslip_pin:{envelope['event_id']}",
        exchange=email_events_config.EXCHANGE_NAME,
    )
