"""Valkey (Redis-compatible) async client bootstrap.

The client returned by ``from_url`` is a lazy, auto-reconnecting connection
pool: it is usable even if Valkey is down right now and starts working the
moment Valkey comes up — no process restart, no manual reconnect machinery. The
boot-time ping is only a health probe and must never kill the app.

Key scheme (shared convention with the other services):

  session:<access_token>     (hash, IAM-written; this service reads)
  expense:<...>              (service-local caches, namespaced with the
                              ``expense:`` prefix)
"""

from redis.asyncio import Redis, from_url

from src.config import settings
from src.logger import logger

valkey_client: Redis | None = None


async def init_valkey() -> None:
    global valkey_client
    # Assign BEFORE pinging — see module docstring.
    valkey_client = from_url(settings.VALKEY_URL, decode_responses=True)
    try:
        await valkey_client.ping()
        logger.info("Valkey connection initialized")
    except Exception as exc:
        logger.warning("Valkey ping failed at init (will self-heal)", error=str(exc))


async def close_valkey() -> None:
    global valkey_client
    if valkey_client:
        await valkey_client.aclose()
        valkey_client = None
        logger.info("Valkey connection closed")


def get_valkey() -> Redis:
    """Dependency to inject the Valkey client.

    No reconnect logic needed: ``init_valkey`` always assigns an auto-reconnecting
    client, so a live connection is never required here — the pool re-establishes
    itself on the next command once Valkey is reachable.
    """
    if valkey_client is None:
        raise RuntimeError("Valkey not initialised — call init_valkey() first")
    return valkey_client


# ---------- Key builders ----------


def session_key(access_token: str) -> str:
    """IAM-written session blob keyed by the bearer token."""
    return f"session:{access_token}"


def cache_key(*parts: str) -> str:
    """Service-local cache key, namespaced under ``expense:``."""
    return "expense:" + ":".join(parts)
