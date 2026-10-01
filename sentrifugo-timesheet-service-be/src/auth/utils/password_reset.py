from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from ..config import auth_settings
from ...valkey import get_valkey

_VALKEY_PREFIX = "password_reset"
_ALGORITHM = "HS256"


def generate_password_reset_token(user_id: str, ttl_minutes: int = 1440) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "typ": "password_reset",
        "iat": now,
        "exp": now + timedelta(minutes=ttl_minutes),
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET_KEY, algorithm=_ALGORITHM)


async def store_password_reset_token(
    user_id: str, token: str, ttl_seconds: int = 86400
) -> None:
    await get_valkey().setex(
        f"{_VALKEY_PREFIX}:{token}",
        ttl_seconds,
        user_id,
    )


async def get_user_id_by_password_reset_token(token: str) -> str | None:
    return await get_valkey().get(f"{_VALKEY_PREFIX}:{token}")


async def delete_password_reset_token(token: str) -> None:
    await get_valkey().delete(f"{_VALKEY_PREFIX}:{token}")
