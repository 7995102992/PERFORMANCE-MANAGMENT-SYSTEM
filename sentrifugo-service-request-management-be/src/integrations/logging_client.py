"""Thin async client for the Logging Service (Foundation §17).

Two logical streams, one physical pipe:
  - user-visible activity (ActivityEventEnum)  — powers the Activity tab
  - ops / compliance audit                     — actor + correlation + diffs

`src/audit.py` wraps this with domain-shaped helpers (emit_category_created,
emit_ticket_submitted, ...).

If `LOGGING_BASE_URL` is unset we run in **stub mode** — events are logged
to local logger at INFO level instead of POSTed. Reads return empty. See Q-003.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx

from ..exceptions import LoggingUnavailable

logger = logging.getLogger("srm.audit")


class LoggingServiceError(Exception):
    pass


class LoggingClient:
    def __init__(self) -> None:
        from ..config import settings
        self.base_url = settings.LOGGING_BASE_URL.rstrip("/")
        self.token = settings.LOGGING_SERVICE_TOKEN
        self.stub_mode = not self.base_url
        self._http: httpx.AsyncClient | None = None
        if self.stub_mode:
            logger.info("logging_client.stub_mode LOGGING_BASE_URL not set")

    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            headers = {}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            self._http = httpx.AsyncClient(
                base_url=self.base_url, headers=headers, timeout=httpx.Timeout(3.0, connect=1.0)
            )
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ---------- Write (fire-and-forget) ----------
    async def emit(
        self,
        *,
        stream: str,  # "activity" | "audit"
        event: str,  # enum string value, e.g. "submitted" or "category.created"
        actor_user_id: str | None,
        organisation_id: str | None,
        service_request_id: str | None = None,
        details: dict[str, Any] | None = None,
        correlation_id: str | None = None,
        occurred_on: datetime | None = None,
    ) -> None:
        payload = {
            "stream": stream,
            "event": event,
            "actor_user_id": actor_user_id,
            "organisation_id": organisation_id,
            "service_request_id": service_request_id,
            "details": details or {},
            "correlation_id": correlation_id,
            "occurred_on": (occurred_on or datetime.now(timezone.utc)).isoformat(),
        }
        if self.stub_mode:
            logger.info("logging.emit %s", payload)
            return
        try:
            client = await self._client()
            resp = await client.post("/events", json=payload)
            if resp.status_code >= 400:
                logger.warning("logging.emit.failed status=%s body=%s", resp.status_code, resp.text)
        except httpx.HTTPError as e:
            # Fire-and-forget: do NOT raise on transport errors. Foundation §17 allows drop.
            logger.warning("logging.emit.transport_error err=%s", e)

    # ---------- Read (Activity tab proxy) ----------
    async def query_activity(
        self,
        *,
        service_request_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        if self.stub_mode:
            logger.debug("logging.query_activity.stub sr=%s", service_request_id)
            return []
        try:
            client = await self._client()
            resp = await client.get(
                "/events",
                params={
                    "service_request_id": service_request_id,
                    "stream": "activity",
                    "limit": limit,
                    "order": "desc",
                },
            )
            if resp.status_code >= 500:
                raise LoggingUnavailable()
            if resp.status_code >= 400:
                raise LoggingServiceError(f"Logging /events -> {resp.status_code}")
            return resp.json().get("items", [])
        except httpx.HTTPError as e:
            # Read path surfaces the error — Activity tab must not silently show empty.
            raise LoggingUnavailable() from e


# Singleton.
_instance: LoggingClient | None = None


def get_logging_client() -> LoggingClient:
    global _instance
    if _instance is None:
        _instance = LoggingClient()
    return _instance


async def close_logging_client() -> None:
    global _instance
    if _instance is not None:
        await _instance.aclose()
        _instance = None
