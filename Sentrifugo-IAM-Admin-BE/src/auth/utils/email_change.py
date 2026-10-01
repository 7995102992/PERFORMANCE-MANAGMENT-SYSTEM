"""Email-change confirmation token management.

Same JWT + Valkey defence-in-depth design as activation / password reset,
but the Valkey entry carries BOTH the user_id and the new email so the
new address can be verified even if the UserDocument is concurrently
edited (e.g. super admin queues a different change while one is pending).
"""

import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt

from src.auth.config import auth_settings
from src import valkey
from src.logger import logger

EMAIL_CHANGE_PREFIX = "email_change:"
ALGORITHM = "HS256"
TOKEN_TYPE = "email_change"


def generate_email_change_token(user_id: str) -> str:
    """Generate a signed JWT email-change confirmation token."""
    expire = datetime.now(timezone.utc) + timedelta(
        hours=auth_settings.EMAIL_CHANGE_TOKEN_EXPIRE_HOURS
    )
    payload = {
        "sub": user_id,
        "typ": TOKEN_TYPE,
        "jti": str(uuid4()),
        "exp": expire,
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET_KEY, algorithm=ALGORITHM)


async def store_email_change_token(user_id: str, new_email: str, token: str) -> None:
    """Persist {user_id, new_email} for a pending confirmation."""
    ttl_seconds = auth_settings.EMAIL_CHANGE_TOKEN_EXPIRE_HOURS * 3600
    key = f"{EMAIL_CHANGE_PREFIX}{token}"
    payload = json.dumps({"user_id": user_id, "new_email": new_email})
    await valkey.valkey_client.set(key, payload, ex=ttl_seconds)
    logger.info("Email-change token stored", user_id=user_id)


async def get_email_change_payload(token: str) -> dict | None:
    """Verify JWT + Valkey entry and return {user_id, new_email} or None."""
    try:
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError as e:
        logger.info("Email-change token JWT invalid", error=str(e))
        return None

    if claims.get("typ") != TOKEN_TYPE:
        return None

    jwt_user_id = claims.get("sub")
    if not jwt_user_id:
        return None

    raw = await valkey.valkey_client.get(f"{EMAIL_CHANGE_PREFIX}{token}")
    if not raw:
        return None

    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None

    if payload.get("user_id") != jwt_user_id:
        logger.warning("Email-change user_id mismatch", jwt_sub=jwt_user_id)
        return None

    return payload


async def delete_email_change_token(token: str) -> None:
    """Delete a pending token (consumed or invalidated)."""
    await valkey.valkey_client.delete(f"{EMAIL_CHANGE_PREFIX}{token}")
