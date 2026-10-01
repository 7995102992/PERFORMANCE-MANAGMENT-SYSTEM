from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from ..config import auth_settings
from ...valkey import get_valkey

ACTIVATION_TOKEN_EXPIRE_HOURS = 24
_VALKEY_PREFIX = "activation"
_ALGORITHM = "HS256"


def generate_activation_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "typ": "activation",
        "iat": now,
        "exp": now + timedelta(hours=ACTIVATION_TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET_KEY, algorithm=_ALGORITHM)


async def store_activation_token(user_id: str, token: str) -> None:
    await get_valkey().setex(
        f"{_VALKEY_PREFIX}:{token}",
        ACTIVATION_TOKEN_EXPIRE_HOURS * 3600,
        user_id,
    )


async def get_user_id_by_activation_token(token: str) -> str | None:
    return await get_valkey().get(f"{_VALKEY_PREFIX}:{token}")


async def delete_activation_token(token: str) -> None:
    await get_valkey().delete(f"{_VALKEY_PREFIX}:{token}")
