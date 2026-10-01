"""Valkey (Redis-compatible) async client bootstrap.

Key scheme per Foundation §14:

  session:<access_token>         (hash, IAM-written; SRM reads)
  srm:workflow:active:<rt_id>    (str, 5min TTL — see Q-009)
  srm:idemp:<user_id>:<key>      (str, 24h TTL — see Q-106)
  srm:user:<id>                  (hash, short-lived IAM user cache)
  srm:dept:<id>                  (hash, short-lived IAM dept cache)
"""
from __future__ import annotations

import logging

from redis.asyncio import Redis, from_url

from .config import settings

logger = logging.getLogger(__name__)

_client: Redis | None = None


def _log_target() -> str:
    """Host/port/db only — never the URL, which embeds user:password."""
    if not settings.VALKEY_HOST:
        return "localhost:6379/0"
    return f"{settings.VALKEY_HOST}:{settings.VALKEY_PORT}/{settings.VALKEY_DB}"


async def init_valkey() -> None:
    global _client
    _client = from_url(settings.VALKEY_URL, decode_responses=True)
    # Light ping — failure should NOT kill the app; IAM may not have seeded yet.
    try:
        await _client.ping()
        logger.info("valkey.init target=%s", _log_target())
    except Exception as e:  # noqa: BLE001
        logger.warning("valkey.init.failed target=%s err=%s", _log_target(), e)


async def close_valkey() -> None:
    global _client
    if _client:
        await _client.close()
        _client = None
        logger.info("valkey.closed")


def get_valkey() -> Redis:
    if _client is None:
        raise RuntimeError("Valkey not initialised — call init_valkey() first")
    return _client


# ---------- Key builders (typed helpers) ----------

def session_key(access_token: str) -> str:
    return f"session:{access_token}"


def workflow_active_cache_key(request_type_id: str) -> str:
    return f"srm:workflow:active:{request_type_id}"


def idempotency_key(user_id: str, client_key: str) -> str:
    return f"srm:idemp:{user_id}:{client_key}"


def user_cache_key(user_id: str) -> str:
    return f"srm:user:{user_id}"


def dept_cache_key(department_id: str) -> str:
    return f"srm:dept:{department_id}"
