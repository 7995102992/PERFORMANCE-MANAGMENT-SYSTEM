"""Password-reset token management using Valkey (Redis-compatible).

Mirrors `activation.py` — same JWT-plus-Valkey design — but with a shorter
TTL and a distinct Valkey key prefix so a leaked activation token can never
be redeemed as a reset token and vice versa.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt

from src.auth.config import auth_settings
from src import valkey
from src.logger import logger

PASSWORD_RESET_PREFIX = "password_reset:"
ALGORITHM = "HS256"
TOKEN_TYPE = "password_reset"


def generate_password_reset_token(user_id: str, ttl_minutes: int | None = None) -> str:
    """Generate a signed JWT password-reset token.

    ``ttl_minutes`` overrides the default expiry when the token is bundled
    with an activation email (so both links share the same window).
    """
    minutes = ttl_minutes or auth_settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
    expire = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    payload = {
        "sub": user_id,
        "typ": TOKEN_TYPE,
        "jti": str(uuid4()),
        "exp": expire,
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET_KEY, algorithm=ALGORITHM)


async def store_password_reset_token(user_id: str, token: str, ttl_seconds: int | None = None) -> None:
    """Store a reset token in Valkey with TTL-based expiry."""
    ttl = ttl_seconds or (auth_settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES * 60)
    key = f"{PASSWORD_RESET_PREFIX}{token}"
    await valkey.valkey_client.set(key, user_id, ex=ttl)
    logger.info("Password reset token stored", user_id=user_id)


async def get_user_id_by_password_reset_token(token: str) -> str | None:
    """Verify JWT AND confirm Valkey entry exists; return user_id or None.

    See activation.py for rationale — defence in depth against tampered /
    replayed / revoked tokens. A JWT that looks like an activation token
    (wrong `typ`) will be rejected here even if it decodes cleanly.
    """
    try:
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError as e:
        logger.info("Reset token JWT invalid", error=str(e))
        return None

    if claims.get("typ") != TOKEN_TYPE:
        logger.info("Reset token has wrong typ claim", typ=claims.get("typ"))
        return None

    jwt_user_id = claims.get("sub")
    if not jwt_user_id:
        return None

    key = f"{PASSWORD_RESET_PREFIX}{token}"
    stored = await valkey.valkey_client.get(key)
    if stored is None:
        return None
    if stored != jwt_user_id:
        logger.warning(
            "Reset token user_id mismatch",
            jwt_sub=jwt_user_id, valkey_user_id=stored,
        )
        return None

    return jwt_user_id


async def delete_password_reset_token(token: str) -> None:
    """Delete a reset token after use (single-use semantics)."""
    key = f"{PASSWORD_RESET_PREFIX}{token}"
    await valkey.valkey_client.delete(key)
