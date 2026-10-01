"""Thin async client for the central Logging Service ``GET /logs``.

Only the params the logging API can actually push down are sent here
(time window — required — plus org and actor). Every other wireframe filter is
applied in-proxy over the returned window (see ``service``).
"""
from __future__ import annotations

from datetime import datetime

import httpx

from src.config import settings
from src.logger import logger

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class LoggingServiceError(RuntimeError):
    """Raised when the logging service is unreachable or returns a non-2xx."""


async def fetch_logs(
    *,
    start_time: datetime,
    end_time: datetime,
    organisation_id: str,
    actor_id: str | None = None,
    limit: int = 1000,
    offset: int = 0,
) -> dict:
    """Call the logging service and return its raw ``{data, pagination}`` body."""
    params: dict = {
        "start_time": start_time.isoformat(),
        "end_time": end_time.isoformat(),
        "organisation_id": organisation_id,
        "limit": limit,
        "offset": offset,
    }
    if actor_id:
        params["actor_id"] = actor_id

    url = f"{settings.LOGGING_SERVICE_URL.rstrip('/')}/logs"
    headers = {"x-api-key": settings.LOGGING_SERVICE_API_KEY}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url, params=params, headers=headers)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as exc:
        logger.warning(
            "Logging service returned an error",
            status_code=exc.response.status_code,
            body=exc.response.text[:500],
        )
        raise LoggingServiceError(
            f"logging service responded {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning("Logging service request failed", error=repr(exc))
        raise LoggingServiceError("logging service unreachable") from exc
