"""JWT access token and refresh token utilities."""

import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt

from src.auth.config import auth_settings
from src.logger import logger

ALGORITHM = "HS256"


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=auth_settings.JWT_EXP_MINUTES))
    to_encode.update({"exp": expire})
    try:
        return jwt.encode(to_encode, auth_settings.JWT_SECRET_KEY, algorithm=ALGORITHM)
    except Exception as e:
        logger.error("Failed to encode JWT", error=str(e))
        raise


def generate_refresh_token(user_id: str, expire_days: int) -> str:
    """Generate a signed JWT refresh token expiring in `expire_days` days."""
    expire = datetime.now(timezone.utc) + timedelta(days=expire_days)
    payload = {
        "sub": user_id,
        "typ": "refresh",
        "jti": str(uuid4()),
        "exp": expire,
    }
    return jwt.encode(payload, auth_settings.JWT_SECRET_KEY, algorithm=ALGORITHM)


def hash_refresh_token(token: str) -> str:
    """Hash a refresh token for storage (SHA-256)."""
    return hashlib.sha256(token.encode()).hexdigest()
