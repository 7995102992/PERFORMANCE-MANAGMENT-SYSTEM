import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

# Set test environment variables before importing the app
os.environ["REDIS_URL"] = "redis://localhost:6379/0"
os.environ["RABBITMQ_URL"] = "amqp://guest:guest@localhost:5672/"
os.environ["TIMESCALEDB_DSN"] = "postgresql://postgres:password@localhost:5432/sentrifugo"
os.environ["VALID_API_KEYS"] = json.dumps({"my-api-key-1": "ADMIN", "my-api-key-2": "MANAGER"})


def _make_mock_pg_pool():
    pool = AsyncMock()
    conn = AsyncMock()
    conn.fetchval = AsyncMock(return_value=0)
    conn.fetch = AsyncMock(return_value=[])
    conn.execute = AsyncMock()
    conn.executemany = AsyncMock()

    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=ctx)
    return pool


def _make_mock_redis():
    redis = AsyncMock()
    redis.ping = AsyncMock(return_value=True)
    redis.get = AsyncMock(return_value=None)
    redis.setex = AsyncMock()
    return redis


def _make_mock_rabbitmq_channel():
    channel = MagicMock()
    channel.is_closed = False
    return channel


@pytest.fixture
async def client():
    mock_pg_pool = _make_mock_pg_pool()
    mock_redis = _make_mock_redis()
    mock_rabbitmq = _make_mock_rabbitmq_channel()

    with (
        patch("src.timescaledb.init_timescaledb", new_callable=AsyncMock),
        patch("src.timescaledb.close_timescaledb", new_callable=AsyncMock),
        patch("src.redis.init_redis", new_callable=AsyncMock),
        patch("src.redis.close_redis", new_callable=AsyncMock),
        patch("src.rabbitmq.init_rabbitmq", new_callable=AsyncMock),
        patch("src.rabbitmq.close_rabbitmq", new_callable=AsyncMock),
        patch("src.timescaledb.get_pg_pool", return_value=mock_pg_pool),
        patch("src.redis.get_redis", return_value=mock_redis),
        patch("src.rabbitmq.get_rabbitmq_channel", return_value=mock_rabbitmq),
    ):
        from src.main import app

        # Override dependencies with mocks
        from src.timescaledb import get_pg_pool
        from src.rabbitmq import get_rabbitmq_channel
        from src.redis import get_redis

        app.dependency_overrides[get_pg_pool] = lambda: mock_pg_pool
        app.dependency_overrides[get_redis] = lambda: mock_redis
        app.dependency_overrides[get_rabbitmq_channel] = lambda: mock_rabbitmq

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as c:
            yield c

        app.dependency_overrides.clear()
