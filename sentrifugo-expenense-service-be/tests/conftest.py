"""Shared pytest fixtures.

The async client drives the app in-process via ASGITransport. The app's
infrastructure (Mongo/Valkey/RabbitMQ) is intentionally NOT started here, so
these tests run fully offline and exercise the resilience paths — health reports
``degraded`` rather than crashing when dependencies are absent. Integration tests
that need live infra should spin it up explicitly (see docker-compose.yml).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from src.main import app


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as c:
        yield c
