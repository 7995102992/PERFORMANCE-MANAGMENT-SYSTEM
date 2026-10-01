from __future__ import annotations

import logging

from redis.asyncio import Redis, from_url

from .config import settings

logger = logging.getLogger(__name__)

_client: Redis | None = None


async def init_valkey() -> None:
    global _client
    url = settings.VALKEY_URL
    _client = from_url(
        url,
        decode_responses=True,
        socket_keepalive=True,
        socket_connect_timeout=5,
        health_check_interval=30,
        retry_on_timeout=True,
    )
    try:
        await _client.ping()
        logger.info("valkey.init url=%s", url)
    except Exception as e:
        logger.warning("valkey.init.failed url=%s err=%s", url, e)


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


def session_key(access_token: str) -> str:
    return f"session:{access_token}"


def tsm_cache_key(prefix: str, *parts: str) -> str:
    return f"tsm:{prefix}:{':'.join(parts)}"
