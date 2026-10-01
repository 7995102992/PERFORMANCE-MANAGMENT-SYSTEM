import time
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

VALID_API_KEY = "my-api-key-1"
MANAGER_API_KEY = "my-api-key-2"
INVALID_API_KEY = "bad-key"

MODULES = ["auth", "hr", "payroll", "attendance", "leave"]
ACTIONS = ["login", "logout", "create", "update", "delete", "view", "export"]
RESOURCES = ["/auth/login", "/employees", "/payroll/run", "/leave/apply", "/reports"]


def _generate_log_batch(count: int) -> list[dict]:
    """Generate a batch of log entries matching the curl format."""
    base_time = datetime(2026, 4, 6, 10, 30, 0, tzinfo=timezone.utc)
    return [
        {
            "module": MODULES[i % len(MODULES)],
            "actor_id": f"user-{i % 100}",
            "action": ACTIONS[i % len(ACTIONS)],
            "resource": RESOURCES[i % len(RESOURCES)],
            "debug_level": (i % 4) + 1,
            "timestamp": (base_time + timedelta(seconds=i)).isoformat(),
            "metadata": {"batch_index": i},
        }
        for i in range(count)
    ]


# ---------------------------------------------------------------------------
# Functional tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_logs_success(client: AsyncClient):
    response = await client.post(
        "/logs",
        json=[
            {
                "module": "auth",
                "actor_id": "user-42",
                "action": "login",
                "resource": "/auth/login",
                "debug_level": 1,
                "timestamp": "2026-04-06T10:30:00Z",
            }
        ],
        headers={"X-API-KEY": VALID_API_KEY},
    )
    assert response.status_code == 200
    assert response.json()["ingested"] == 1


@pytest.mark.asyncio
async def test_post_logs_with_metadata(client: AsyncClient):
    response = await client.post(
        "/logs",
        json=[
            {
                "module": "hr",
                "actor_id": "user-10",
                "action": "update",
                "resource": "/employees/10",
                "debug_level": 2,
                "metadata": {"field": "salary", "old": 50000, "new": 55000},
                "timestamp": "2026-04-06T10:30:00Z",
            }
        ],
        headers={"X-API-KEY": VALID_API_KEY},
    )
    assert response.status_code == 200
    assert response.json()["ingested"] == 1


@pytest.mark.asyncio
async def test_post_logs_invalid_api_key(client: AsyncClient):
    response = await client.post(
        "/logs",
        json=[
            {
                "module": "auth",
                "actor_id": "user-1",
                "action": "login",
                "resource": "/auth/login",
                "debug_level": 1,
                "timestamp": "2026-04-06T10:30:00Z",
            }
        ],
        headers={"X-API-KEY": INVALID_API_KEY},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_post_logs_bad_debug_level(client: AsyncClient):
    response = await client.post(
        "/logs",
        json=[
            {
                "module": "auth",
                "actor_id": "user-1",
                "action": "login",
                "resource": "/auth/login",
                "debug_level": 99,
                "timestamp": "2026-04-06T10:30:00Z",
            }
        ],
        headers={"X-API-KEY": VALID_API_KEY},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_get_logs_success(client: AsyncClient):
    response = await client.get(
        "/logs",
        params={
            "start_time": "2024-01-01T00:00:00Z",
            "end_time": "2026-12-31T23:59:59Z",
            "limit": 1000,
            "offset": 0,
        },
        headers={"X-API-KEY": VALID_API_KEY},
    )
    assert response.status_code == 200
    data = response.json()
    assert "data" in data
    assert "pagination" in data
    assert "limit" in data["pagination"]
    assert "offset" in data["pagination"]
    assert "total" in data["pagination"]


@pytest.mark.asyncio
async def test_get_logs_enforces_debug_level(client: AsyncClient):
    """Manager-level key should only see logs with debug_level <= 2."""
    response = await client.get(
        "/logs",
        params={
            "start_time": "2024-01-01T00:00:00Z",
            "end_time": "2026-12-31T23:59:59Z",
        },
        headers={"X-API-KEY": MANAGER_API_KEY},
    )
    assert response.status_code == 200
    data = response.json()
    for entry in data["data"]:
        assert entry["debug_level"] <= 2


@pytest.mark.asyncio
async def test_get_logs_missing_time_params(client: AsyncClient):
    response = await client.get(
        "/logs",
        headers={"X-API-KEY": VALID_API_KEY},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Bulk ingestion & latency tests (100,000 logs)
# ---------------------------------------------------------------------------

BULK_COUNT = 100_000
BATCH_SIZE = 1_000


@pytest.mark.asyncio
async def test_bulk_ingest_100k_logs(client: AsyncClient):
    """Ingest 100,000 logs in batches and measure total + per-log latency."""
    logs = _generate_log_batch(BULK_COUNT)
    total_ingested = 0

    start = time.perf_counter()

    for batch_start in range(0, BULK_COUNT, BATCH_SIZE):
        batch = logs[batch_start : batch_start + BATCH_SIZE]
        response = await client.post(
            "/logs",
            json=batch,
            headers={"X-API-KEY": VALID_API_KEY},
        )
        assert response.status_code == 200
        total_ingested += response.json()["ingested"]

    elapsed = time.perf_counter() - start

    assert total_ingested == BULK_COUNT

    per_log_us = (elapsed / BULK_COUNT) * 1_000_000
    throughput = BULK_COUNT / elapsed

    print(f"\n--- Bulk Ingest: {BULK_COUNT:,} logs ---")
    print(f"  Total time     : {elapsed:.3f}s")
    print(f"  Per-log latency: {per_log_us:.1f}us")
    print(f"  Throughput     : {throughput:,.0f} logs/s")
    print(f"  Batch size     : {BATCH_SIZE}")
    print(f"  Batches sent   : {BULK_COUNT // BATCH_SIZE}")


@pytest.mark.asyncio
async def test_single_large_batch_latency(client: AsyncClient):
    """Send 100,000 logs in a single request and measure latency."""
    logs = _generate_log_batch(BULK_COUNT)

    start = time.perf_counter()
    response = await client.post(
        "/logs",
        json=logs,
        headers={"X-API-KEY": VALID_API_KEY},
    )
    elapsed = time.perf_counter() - start

    assert response.status_code == 200
    assert response.json()["ingested"] == BULK_COUNT

    per_log_us = (elapsed / BULK_COUNT) * 1_000_000
    throughput = BULK_COUNT / elapsed

    print(f"\n--- Single Batch Ingest: {BULK_COUNT:,} logs ---")
    print(f"  Total time     : {elapsed:.3f}s")
    print(f"  Per-log latency: {per_log_us:.1f}us")
    print(f"  Throughput     : {throughput:,.0f} logs/s")


@pytest.mark.asyncio
async def test_get_logs_query_latency(client: AsyncClient):
    """Measure query latency for fetching logs after bulk ingestion."""
    logs = _generate_log_batch(BULK_COUNT)
    for batch_start in range(0, BULK_COUNT, BATCH_SIZE):
        batch = logs[batch_start : batch_start + BATCH_SIZE]
        await client.post("/logs", json=batch, headers={"X-API-KEY": VALID_API_KEY})

    iterations = 10
    latencies = []

    for _ in range(iterations):
        start = time.perf_counter()
        response = await client.get(
            "/logs",
            params={
                "start_time": "2024-01-01T00:00:00Z",
                "end_time": "2026-12-31T23:59:59Z",
                "limit": 1000,
            },
            headers={"X-API-KEY": VALID_API_KEY},
        )
        elapsed = time.perf_counter() - start
        assert response.status_code == 200
        latencies.append(elapsed)

    avg_ms = (sum(latencies) / len(latencies)) * 1000
    min_ms = min(latencies) * 1000
    max_ms = max(latencies) * 1000
    p50_ms = sorted(latencies)[len(latencies) // 2] * 1000

    print(f"\n--- GET /logs Query Latency ({iterations} iterations) ---")
    print(f"  Avg : {avg_ms:.2f}ms")
    print(f"  Min : {min_ms:.2f}ms")
    print(f"  Max : {max_ms:.2f}ms")
    print(f"  P50 : {p50_ms:.2f}ms")
