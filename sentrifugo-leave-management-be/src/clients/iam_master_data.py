"""IAM master-data client with Valkey as the primary data source.

Both IAM and LMS share the same Valkey instance.  Domain events from IAM
(via RabbitMQ) are consumed by LMS, stored in the local MongoDB
``employment_statuses`` collection, and then synced to Valkey so that
subsequent reads are served from Valkey without an HTTP round-trip.

Read order:
  1. Valkey  (fast, shared cache — primary)
  2. IAM HTTP API  (fallback when Valkey is empty)
  3. Local MongoDB  (last resort when IAM is also unreachable)

Any successful fallback read also back-fills Valkey so future reads hit
the fast path.
"""

import json
from typing import Optional

import httpx

from src.config import settings
from src.logger import logger
from src.redis import get_redis

# No TTL on the master-data cache — it persists until explicitly refreshed (a domain
# event via sync_*_to_valkey, invalidate_master_data_cache(), or a force_refresh read)
# or manually cleared. Master data changes rarely and only through IAM events, so an
# expiry would only cause needless IAM round-trips and risk an empty cache window if
# IAM is briefly unreachable.
_CACHE_KEY_PREFIX = "iam:master_data"


def _cache_key(category: str, organisation_id: Optional[str], include_inactive: bool) -> str:
    return (
        f"{_CACHE_KEY_PREFIX}:{category}:"
        f"{organisation_id or 'global'}:{int(include_inactive)}"
    )


async def _write_to_valkey(key: str, data: dict[str, dict]) -> None:
    try:
        redis = await get_redis()
        await redis.set(key, json.dumps(data))  # no expiry — persists until refreshed/cleared
    except Exception as exc:
        logger.warning("Valkey write failed for master_data", key=key, error=str(exc))


async def _purge_category(category: str) -> int:
    """Drop every cached variant of a category — all orgs, both include_inactive flags.

    Reads pass the caller's organisation_id, so the keys actually hit are per-org
    (``...:<org_id>:1``); the ``global`` key is only read when no org is in scope.
    Rewriting just the global key on a domain event therefore left every per-org
    entry frozen at whatever the first read cached — and since these keys carry no
    TTL, a master-data reseed in IAM (which mints new status ids) left that org's
    employees resolving to an "unknown" employment status forever, silently
    dropping all of them from the leave-plan overview. Purging the whole category
    makes the next read re-fetch each org from IAM.
    """
    try:
        redis = await get_redis()
    except RuntimeError:
        return 0
    purged = 0
    try:
        async for key in redis.scan_iter(f"{_CACHE_KEY_PREFIX}:{category}:*"):
            await redis.delete(key)
            purged += 1
    except Exception as exc:
        logger.warning(
            "Valkey purge failed for master_data", category=category, error=str(exc)
        )
    return purged


async def fetch_master_data_by_category(
    category: str,
    *,
    organisation_id: Optional[str] = None,
    include_inactive: bool = False,
    force_refresh: bool = False,
) -> dict[str, dict]:
    """Fetch a master-data category, keyed by string id.

    Returns ``{id_str: {"key": ..., "value": ..., "is_active": ...}}``.
    """
    key = _cache_key(category, organisation_id, include_inactive)

    # ── 1. Valkey (primary) ──────────────────────────────────────────────
    try:
        redis = await get_redis()
    except RuntimeError:
        redis = None

    if redis is not None and not force_refresh:
        try:
            cached = await redis.get(key)
            if cached:
                return json.loads(cached)
        except Exception as exc:
            logger.warning("Valkey read failed for master_data", key=key, error=str(exc))

    # ── 2. IAM HTTP API (fallback) ───────────────────────────────────────
    params: dict[str, object] = {"category": category}
    if organisation_id:
        params["organisation_id"] = organisation_id
    if include_inactive:
        params["include_inactive"] = "true"

    url = f"{settings.IAM_BASE_URL.rstrip('/')}/master-data/"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            raw = resp.json()

        result: dict[str, dict] = {}
        for item in raw:
            item_id = item.get("id")
            if not item_id:
                continue
            result[str(item_id)] = {
                "key": item.get("key"),
                "value": item.get("value"),
                "is_active": item.get("is_active", True),
            }

        if result:
            await _write_to_valkey(key, result)
        return result

    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "IAM master_data fetch failed, will try local MongoDB",
            category=category,
            url=url,
            error=str(exc),
        )

    # ── 3. Local MongoDB (last resort) ───────────────────────────────────
    _LOCAL_FALLBACK_COLLECTIONS = {
        "EMPLOYMENT_STATUSES": "employment_statuses",
        "EMPLOYMENT_TYPES": "employment_types",
    }
    try:
        from src.database import get_db

        collection_name = _LOCAL_FALLBACK_COLLECTIONS.get(category)
        if collection_name:
            db = get_db()
            docs = await db[collection_name].find({}).to_list(length=None)
            result = {}
            for doc in docs:
                sid = str(doc["_id"])
                result[sid] = {
                    "key": doc.get("key"),
                    "value": doc.get("value"),
                    "is_active": doc.get("is_active", True),
                }
            if result:
                await _write_to_valkey(key, result)
            return result
    except Exception as exc:
        logger.warning(
            "Local MongoDB fallback also failed",
            category=category,
            error=str(exc),
        )

    return {}


async def fetch_employment_statuses(
    *, organisation_id: Optional[str] = None
) -> dict[str, dict]:
    """Convenience wrapper for the EMPLOYMENT_STATUSES category."""
    return await fetch_master_data_by_category(
        "EMPLOYMENT_STATUSES",
        organisation_id=organisation_id,
        include_inactive=True,
    )


async def fetch_employment_types(
    *, organisation_id: Optional[str] = None
) -> dict[str, dict]:
    """Convenience wrapper for the EMPLOYMENT_TYPES category."""
    return await fetch_master_data_by_category(
        "EMPLOYMENT_TYPES",
        organisation_id=organisation_id,
        include_inactive=True,
    )


async def sync_employment_statuses_to_valkey() -> None:
    """Rebuild the Valkey cache for employment statuses from local MongoDB.

    Called by the domain-events consumer after any employment_status
    create / update / delete so Valkey stays in sync without waiting for
    the TTL to expire or an IAM HTTP call.
    """
    try:
        from src.database import get_db
        from src.employment_status import EMPLOYMENT_STATUSES_COLLECTION

        db = get_db()
        docs = await db[EMPLOYMENT_STATUSES_COLLECTION].find({}).to_list(length=None)

        result: dict[str, dict] = {}
        for doc in docs:
            sid = str(doc["_id"])
            result[sid] = {
                "key": doc.get("key"),
                "value": doc.get("value"),
                "is_active": doc.get("is_active", True),
            }

        purged = await _purge_category("EMPLOYMENT_STATUSES")
        key = _cache_key("EMPLOYMENT_STATUSES", None, True)
        await _write_to_valkey(key, result)
        logger.info(
            "Employment statuses synced to Valkey",
            count=len(result),
            purged_keys=purged,
        )
    except Exception as exc:
        logger.warning("Failed to sync employment statuses to Valkey", error=str(exc))


async def sync_employment_types_to_valkey() -> None:
    """Rebuild the Valkey cache for employment types from local MongoDB.

    Mirrors sync_employment_statuses_to_valkey — invoked by the domain-events
    consumer after any employment_type create / update / delete so Valkey
    stays in sync without waiting for the TTL to expire.
    """
    try:
        from src.database import get_db
        from src.employment_type import EMPLOYMENT_TYPES_COLLECTION

        db = get_db()
        docs = await db[EMPLOYMENT_TYPES_COLLECTION].find({}).to_list(length=None)

        result: dict[str, dict] = {}
        for doc in docs:
            sid = str(doc["_id"])
            result[sid] = {
                "key": doc.get("key"),
                "value": doc.get("value"),
                "is_active": doc.get("is_active", True),
            }

        purged = await _purge_category("EMPLOYMENT_TYPES")
        key = _cache_key("EMPLOYMENT_TYPES", None, True)
        await _write_to_valkey(key, result)
        logger.info(
            "Employment types synced to Valkey",
            count=len(result),
            purged_keys=purged,
        )
    except Exception as exc:
        logger.warning("Failed to sync employment types to Valkey", error=str(exc))


async def invalidate_master_data_cache(
    category: str,
    *,
    organisation_id: Optional[str] = None,
) -> None:
    """Drop both cache variants (active-only and include-inactive) for a category.

    Without an ``organisation_id`` this drops the category for every org, not just
    the ``global`` key — an unscoped invalidation means "this category changed",
    and leaving the per-org entries (which is what org-scoped reads actually hit)
    behind would make the call a no-op for every real caller.
    """
    if organisation_id is None:
        await _purge_category(category)
        return

    try:
        redis = await get_redis()
    except RuntimeError:
        return

    for inactive_flag in (False, True):
        try:
            await redis.delete(_cache_key(category, organisation_id, inactive_flag))
        except Exception as exc:
            logger.warning(
                "Valkey invalidate failed for master_data",
                category=category,
                error=str(exc),
            )
