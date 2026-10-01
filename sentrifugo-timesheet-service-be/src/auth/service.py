from __future__ import annotations

import logging

from ..config import settings
from .utils.activation import (
    ACTIVATION_TOKEN_EXPIRE_HOURS,
    generate_activation_token,
    store_activation_token,
)
from .utils.email_events import publish_activation_email
from .utils.password_reset import (
    generate_password_reset_token,
    store_password_reset_token,
)

logger = logging.getLogger(__name__)


async def send_activation_email(
    user_id: str,
    email: str,
    full_name: str,
    tenant_id: str = "",
) -> None:
    try:
        activation_token = generate_activation_token(user_id)
        await store_activation_token(user_id, activation_token)

        reset_ttl_minutes = ACTIVATION_TOKEN_EXPIRE_HOURS * 60
        reset_token = generate_password_reset_token(user_id, ttl_minutes=reset_ttl_minutes)
        await store_password_reset_token(
            user_id, reset_token, ttl_seconds=reset_ttl_minutes * 60
        )

        reset_link = f"{settings.FRONTEND_URL}/reset-password?token={reset_token}"
        await publish_activation_email(
            to=email,
            display_name=full_name,
            activation_token=activation_token,
            tenant_id=tenant_id,
            reset_link=reset_link,
        )
    except Exception:
        logger.exception(
            "send_activation_email failed user_id=%s email=%s", user_id, email
        )
