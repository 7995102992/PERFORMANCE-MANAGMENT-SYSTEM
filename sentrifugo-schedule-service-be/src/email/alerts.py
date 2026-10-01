import json
from datetime import datetime, timezone
from uuid import uuid4

import aio_pika

from src.email.config import email_settings
from src.logger import logger
from src.rabbitmq import rabbitmq_connection


async def _publish_alert(routing_key: str, payload: dict) -> None:
    if not rabbitmq_connection:
        logger.error("Cannot publish alert — RabbitMQ not connected")
        return
    try:
        async with rabbitmq_connection.channel() as channel:
            exchange = await channel.declare_exchange(
                email_settings.ALERTS_EXCHANGE,
                aio_pika.ExchangeType.TOPIC,
                durable=True,
            )
            await exchange.publish(
                aio_pika.Message(
                    body=json.dumps(payload).encode(),
                    content_type="application/json",
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    message_id=payload.get("alert_id", str(uuid4())),
                ),
                routing_key=routing_key,
            )
        logger.info("Alert published", routing_key=routing_key, alert_id=payload.get("alert_id"))
    except Exception as e:
        logger.error("Failed to publish alert", routing_key=routing_key, error=str(e))


async def alert_provider_health_check_failed(
    tenant_id: str,
    provider: str,
    consecutive_failures: int,
    error: str,
) -> None:
    alert_payload = {
        "alert_id": str(uuid4()),
        "alert_type": "provider_health_check_failed",
        "severity": "warning" if consecutive_failures < 5 else "critical",
        "tenant_id": tenant_id,
        "provider": provider,
        "consecutive_failures": consecutive_failures,
        "error": error,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": (
            f"Health check failed for provider '{provider}' (tenant {tenant_id}). "
            f"Consecutive failures: {consecutive_failures}. Error: {error}. "
            "Possible infrastructure issue — investigate provider availability and credentials."
        ),
    }

    logger.warning(
        "Provider health check failed — alerting admin",
        tenant_id=tenant_id,
        provider=provider,
        consecutive_failures=consecutive_failures,
        error=error,
    )

    await _publish_alert("alert.email.provider_health_check_failed", alert_payload)


async def alert_all_providers_failed(
    tenant_id: str,
    event_type: str,
    to_email: str,
    correlation_id: str,
    providers_tried: str,
    error_summary: str,
) -> None:
    alert_payload = {
        "alert_id": str(uuid4()),
        "alert_type": "all_email_providers_failed",
        "severity": "critical",
        "tenant_id": tenant_id,
        "event_type": event_type,
        "to_email": to_email,
        "correlation_id": correlation_id,
        "providers_tried": providers_tried,
        "error_summary": error_summary,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": (
            f"All email providers failed for tenant {tenant_id}. "
            f"Providers tried: {providers_tried}. "
            "This may indicate an infrastructure issue — investigate immediately."
        ),
    }

    logger.critical(
        "ALL EMAIL PROVIDERS FAILED — alerting super admin",
        tenant_id=tenant_id,
        providers_tried=providers_tried,
        error_summary=error_summary,
    )

    await _publish_alert("alert.email.all_providers_failed", alert_payload)
