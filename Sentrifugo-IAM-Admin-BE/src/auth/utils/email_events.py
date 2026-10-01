"""Publish email events via the transactional outbox.

Routes through ``src.rabbitmq.outbox`` so the activation email survives a
RabbitMQ outage — the relay will forward it once the broker is back up.
"""

from datetime import datetime, timezone
from uuid import uuid4

from src.auth.config import auth_settings
from src.config import settings
from src.correlation import get_correlation_id
from src.rabbitmq import outbox
from src.rabbitmq.constants import email_events_config

ROUTING_KEY = "email.activation"
PASSWORD_RESET_ROUTING_KEY = "email.password_reset"
EMAIL_CHANGE_ROUTING_KEY = "email.email_change"


def humanize_ttl(seconds: int) -> str:
    """Render a token TTL as the display copy the email templates print.

    IAM owns these TTLs, so IAM also owns how they read — the consumer must
    never re-derive the wording from a number and risk drifting from it.

    Deliberately stops at hours: "1 day" would be ambiguous next to a link
    that dies on a wall-clock deadline, and every current TTL is a clean
    number of hours or minutes. Returns "" for a non-positive or sub-minute
    TTL, which tells the consumer to drop the sentence rather than print
    something false.
    """
    hours, minutes = divmod(max(seconds, 0) // 60, 60)
    if hours == 0 and minutes == 0:
        return ""
    parts = []
    if hours:
        parts.append(f"{hours} hour" if hours == 1 else f"{hours} hours")
    if minutes:
        parts.append(f"{minutes} minute" if minutes == 1 else f"{minutes} minutes")
    return " ".join(parts)


def _expiry_fields(seconds: int) -> dict:
    """The two-field expiry contract shared by every IAM email template."""
    return {
        "expires_in_human": humanize_ttl(seconds),
        "expires_in_seconds": seconds,
    }


def _frontend_base(is_admin_portal: bool) -> str:
    """Pick the portal base URL by audience.

    Super/org admins are routed to the admin portal (``FRONTEND_URL``);
    everyone else goes to the user portal (``USER_FRONTEND_URL``). Falls
    back to the admin URL if the user portal isn't configured.
    """
    if is_admin_portal:
        return settings.FRONTEND_URL or ""
    return settings.USER_FRONTEND_URL or settings.FRONTEND_URL or ""


def _build_task_envelope(
    event_type: str,
    tenant_id: str,
    payload: dict,
) -> dict:
    return {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": event_type,
        "correlation_id": get_correlation_id(),
        "idempotency_key": str(uuid4()),
        "tenant_id": tenant_id,
        "payload": payload,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }


async def publish_activation_email(
    user_email: str,
    display_name: str,
    activation_token: str,
    tenant_id: str = "",
    reset_link: str = "",
    is_admin_portal: bool = False,
) -> None:
    """Publish an activation email event to the outbox.

    When ``reset_link`` is provided it is embedded in the template so the
    user can set their password directly from the same email (fallback if
    they close the browser after clicking the activation link).

    ``is_admin_portal`` routes super/org admins to the admin portal; all
    other users are sent to the user portal.

    The expiry fields state the real validity window instead of letting the
    template hardcode it. One window covers both links: ``send_activation_email``
    mints the fallback reset token with the activation TTL so they never
    expire apart.
    """
    activation_link = f"{_frontend_base(is_admin_portal)}/activate?token={activation_token}"

    template_data: dict = {
        "display_name": display_name,
        "activation_link": activation_link,
        **_expiry_fields(auth_settings.ACTIVATION_TOKEN_EXPIRE_HOURS * 3600),
    }
    if reset_link:
        template_data["reset_link"] = reset_link

    envelope = _build_task_envelope(
        ROUTING_KEY,
        tenant_id,
        {
            "to": user_email,
            "template_id": "activation_v1",
            "template_data": template_data,
        },
    )

    await outbox.publish(
        ROUTING_KEY,
        envelope,
        idempotency_key=f"email.activation:{activation_token}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_password_reset_email(
    user_email: str,
    display_name: str,
    reset_token: str,
    tenant_id: str = "",
    is_admin_portal: bool = False,
    ttl_minutes: int | None = None,
) -> None:
    """Publish a password-reset email event to the outbox.

    ``is_admin_portal`` routes super/org admins to the admin portal; all
    other users are sent to the user portal.

    ``ttl_minutes`` must mirror what the caller passed to
    ``generate_password_reset_token`` — that call also takes an override, so
    reading the default from config here would misstate the window for any
    caller that overrode it. Defaults to the same config value the token
    generator defaults to.
    """
    reset_link = f"{_frontend_base(is_admin_portal)}/reset-password?token={reset_token}"
    ttl_seconds = (ttl_minutes or auth_settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES) * 60

    envelope = _build_task_envelope(
        PASSWORD_RESET_ROUTING_KEY,
        tenant_id,
        {
            "to": user_email,
            "template_id": "password_reset_v1",
            "template_data": {
                "display_name": display_name,
                "reset_link": reset_link,
                **_expiry_fields(ttl_seconds),
            },
        },
    )

    await outbox.publish(
        PASSWORD_RESET_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.password_reset:{reset_token}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_email_change_confirmation_email(
    new_email: str,
    display_name: str,
    token: str,
    tenant_id: str = "",
) -> None:
    """Send a confirmation link to the NEW email address for an email change."""
    link = f"{settings.FRONTEND_URL}/confirm-email-change?token={token}"

    envelope = _build_task_envelope(
        EMAIL_CHANGE_ROUTING_KEY,
        tenant_id,
        {
            "to": new_email,
            "template_id": "email_change_v1",
            "template_data": {
                "display_name": display_name,
                "confirmation_link": link,
                **_expiry_fields(auth_settings.EMAIL_CHANGE_TOKEN_EXPIRE_HOURS * 3600),
            },
        },
    )

    await outbox.publish(
        EMAIL_CHANGE_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.email_change:{token}",
        exchange=email_events_config.EXCHANGE_NAME,
    )
