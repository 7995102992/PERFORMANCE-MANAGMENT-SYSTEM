from redis.asyncio import Redis, from_url

from src.config import settings
from src.logger import logger

valkey_client: Redis | None = None

async def init_valkey():
    global valkey_client
    # Assign the client BEFORE pinging: from_url returns a lazy, auto-reconnecting
    # connection pool, so the client is usable even if Valkey is down right now —
    # it will start working the moment Valkey comes up, no process restart and no
    # lazy-reconnect machinery needed. The ping is just a boot-time health probe;
    # its failure must NOT kill the app.
    valkey_client = from_url(settings.VALKEY_URL, decode_responses=True)
    try:
        await valkey_client.ping()
        logger.info("Valkey connection initialized")
    except Exception as exc:
        logger.warning("Valkey ping failed at init (will self-heal)", error=str(exc))

async def close_valkey():
    global valkey_client
    if valkey_client:
        await valkey_client.aclose()
        valkey_client = None
        logger.info("Valkey connection closed")

async def get_valkey():
    """Dependency to inject the Valkey client.

    No reconnect logic needed: ``init_valkey`` always assigns an auto-reconnecting
    client, so a live connection is never required here — the pool re-establishes
    itself on the next command once Valkey is reachable.
    """
    if valkey_client is None:
        raise RuntimeError("Valkey not initialised — call init_valkey() first")
    return valkey_client
