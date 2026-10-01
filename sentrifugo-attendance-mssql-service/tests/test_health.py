from httpx import AsyncClient


async def test_health_reports_degraded_when_db_uninitialized(client: AsyncClient):
    # ASGITransport does not run the lifespan, so the DB is uninitialized here.
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["db_connected"] is False
    assert body["crawler_running"] is False


async def test_crawl_status_before_any_run(client: AsyncClient):
    resp = await client.get("/attendance/crawl/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_running"] is False
    assert body["last_run"] is None
