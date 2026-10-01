"""Activation token management — JWT with Valkey as a single-use revocation list.

Defense in depth:
  - JWT signature + `exp` + `typ` claims are verified on every read. A
    tampered or expired token is rejected without touching Valkey.
  - Valkey holds an entry per un-redeemed token so we can enforce single-use
    semantics (deleted on successful activation). A JWT whose Valkey entry
    is missing is treated as already-redeemed (or revoked).

This closes the previous asymmetry where a valid JWT with no Valkey entry
could still pass (or where any unsigned string could pass if the Valkey
entry happened to exist).
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt

from src.auth.config import auth_settings
from src import valkey
from src.logger import logger

ACTIVATION_PREFIX = "activation:"
ALGORITHM = "HS256"
TOKEN_TYPE = "activation"


def generate_activation_token(user_id: str) -> str:
    """Generate a signed JWT activation token."""
    expire = datetime.now(timezone.utc) + timedelta(hours=auth_settings.ACTIVATION_TOKEN_EXPIRE_HOURS)
    payload = {
        "sub": user_id,
        "typ": TOKEN_TYPE,
        "jti": str(uuid4()),
        "exp": expire,
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET_KEY, algorithm=ALGORITHM)


async def store_activation_token(user_id: str, token: str) -> None:
    """Store an activation token in Valkey with TTL-based expiry."""
    ttl_seconds = auth_settings.ACTIVATION_TOKEN_EXPIRE_HOURS * 3600
    key = f"{ACTIVATION_PREFIX}{token}"
    await valkey.valkey_client.set(key, user_id, ex=ttl_seconds)
    logger.info("Activation token stored", user_id=user_id)


async def get_user_id_by_activation_token(token: str) -> str | None:
    """Verify the JWT AND confirm it hasn't been redeemed; return user_id or None.

    None is returned on any failure (bad signature, expired, wrong typ,
    missing Valkey entry). The caller should surface a generic
    'invalid or expired' error so the three cases remain indistinguishable
    to the outside world.
    """
    try:
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError as e:
        logger.info("Activation token JWT invalid", error=str(e))
        return None

    if claims.get("typ") != TOKEN_TYPE:
        logger.info("Activation token has wrong typ claim", typ=claims.get("typ"))
        return None

    jwt_user_id = claims.get("sub")
    if not jwt_user_id:
        return None

    key = f"{ACTIVATION_PREFIX}{token}"
    stored = await valkey.valkey_client.get(key)
    if stored is None:
        # Already redeemed, or revoked via store flush.
        return None
    if stored != jwt_user_id:
        # Defence in depth — Valkey entry doesn't match JWT sub.
        logger.warning(
            "Activation token user_id mismatch",
            jwt_sub=jwt_user_id, valkey_user_id=stored,
        )
        return None

    return jwt_user_id


async def delete_activation_token(token: str) -> None:
    """Delete an activation token after use (single-use)."""
    key = f"{ACTIVATION_PREFIX}{token}"
    await valkey.valkey_client.delete(key)
