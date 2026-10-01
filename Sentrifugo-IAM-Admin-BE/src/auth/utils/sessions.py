"""Refresh token session management using Valkey (Redis-compatible)."""

import json
from datetime import datetime, timezone
from uuid import uuid4

from src.logger import logger
from src import valkey

SESSION_PREFIX = "session:rt:"
USER_SESSIONS_PREFIX = "user:sessions:"


async def create_session(
    user_id: str,
    refresh_token_hash: str,
    expires_at: datetime,
    auth_method: str,
    ip_address: str,
    user_agent: str,
    remember: bool = False,
) -> dict:
    """Store a session in Valkey with TTL-based expiry."""
    now = datetime.now(timezone.utc)
    ttl_seconds = int((expires_at - now).total_seconds())
    if ttl_seconds <= 0:
        ttl_seconds = 1

    session_data = {
        "id": str(uuid4()),
        "user_id": user_id,
        "refresh_token": refresh_token_hash,
        "auth_method": auth_method,
        "ip_address": ip_address,
        "user_agent": user_agent,
        "created_at": now.isoformat(),
        # Preserved so token rotation on /auth/refresh keeps the same lifetime.
        "remember": remember,
    }

    key = f"{SESSION_PREFIX}{refresh_token_hash}"
    await valkey.valkey_client.set(key, json.dumps(session_data), ex=ttl_seconds)
    await valkey.valkey_client.sadd(f"{USER_SESSIONS_PREFIX}{user_id}", refresh_token_hash)

    logger.info("Session created", session_id=session_data["id"], user_id=user_id)
    return session_data


async def get_session_by_token(refresh_token_hash: str) -> dict | None:
    """Retrieve a session from Valkey by refresh token hash."""
    key = f"{SESSION_PREFIX}{refresh_token_hash}"
    raw = await valkey.valkey_client.get(key)
    if not raw:
        return None
    return json.loads(raw)


async def revoke_session(refresh_token_hash: str, user_id: str) -> bool:
    """Delete a session from Valkey."""
    key = f"{SESSION_PREFIX}{refresh_token_hash}"
    deleted = await valkey.valkey_client.delete(key)
    await valkey.valkey_client.srem(f"{USER_SESSIONS_PREFIX}{user_id}", refresh_token_hash)
    return deleted > 0


async def revoke_all_user_sessions(user_id: str) -> int:
    """Revoke all sessions for a user (force logout everywhere)."""
    set_key = f"{USER_SESSIONS_PREFIX}{user_id}"
    token_hashes = await valkey.valkey_client.smembers(set_key)
    if not token_hashes:
        return 0

    keys = [f"{SESSION_PREFIX}{h}" for h in token_hashes]
    deleted = await valkey.valkey_client.delete(*keys)
    await valkey.valkey_client.delete(set_key)
    return deleted
