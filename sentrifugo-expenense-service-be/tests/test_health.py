"""Health endpoint smoke tests.

These run without any backing infrastructure, proving the service degrades
gracefully instead of crashing when Mongo/Valkey/RabbitMQ are unreachable.
"""

import pytest


@pytest.mark.asyncio
async def test_health_responds(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("ok", "degraded")
    # The shape is always present, even when dependencies are down.
    assert "mongo_connected" in body
    assert "valkey_connected" in body
    assert "rabbitmq_connected" in body


@pytest.mark.asyncio
async def test_health_degrades_without_infra(client):
    """With no infra started, dependency flags are False but the endpoint
    still answers 200 (liveness independent of readiness)."""
    resp = await client.get("/health")
    body = resp.json()
    assert body["valkey_connected"] is False
    assert body["rabbitmq_connected"] is False


@pytest.mark.asyncio
async def test_correlation_id_echoed(client):
    resp = await client.get("/health", headers={"X-Correlation-ID": "test-cid-123"})
    assert resp.headers.get("X-Correlation-ID") == "test-cid-123"


@pytest.mark.asyncio
async def test_me_requires_auth(client):
    resp = await client.get("/me")
    assert resp.status_code == 401
