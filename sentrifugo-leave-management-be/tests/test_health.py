import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    response = await client.get("/health")
    
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "db_connected" in data
    assert "redis_connected" in data
    assert "rabbitmq_connected" in data
