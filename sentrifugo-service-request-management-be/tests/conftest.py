"""Shared fixtures for SRM tests.

Uses the real remote MongoDB (from .env) with a dedicated test database
so outbox documents, indexes, and Beanie ODM work identically to production.
Also initializes Valkey for API tests that go through the auth layer.
"""
from __future__ import annotations

from contextlib import asynccontextmanager as _acm
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorClientSession

import src.database as _db_module
from src.config import settings
from src.models import ALL_DOCUMENTS, OutboxEventDocument


TEST_DB_NAME = "sentrifugo_srm_test"

_original_start_transaction = AsyncIOMotorClientSession.start_transaction


@_acm
async def _noop_start_transaction(self, *args, **kwargs):
    yield




@pytest.fixture(autouse=True)
def force_iam_stub_mode():
    """Pin the IAM client to stub mode for the duration of every test.

    The API suites authenticate with the `X-SRM-Dev-Session` header, which
    `get_current_user` only honours when ENVIRONMENT is development AND
    `IAM_BASE_URL` is blank (auth/utils/dependencies.py). A developer whose
    .env points IAM at a real host therefore gets a 401 on every request —
    which is not a property of the code under test, just of their .env. Pin it
    here so the suites behave the same on every machine.

    `_instance` is reset either side because IAMClient reads the setting once,
    at construction, and is cached module-global.
    """
    from src.integrations import iam_client as _iam

    original_url = settings.IAM_BASE_URL
    original_env = settings.ENVIRONMENT
    settings.IAM_BASE_URL = ""
    settings.ENVIRONMENT = "development"
    _iam._instance = None
    yield
    settings.IAM_BASE_URL = original_url
    settings.ENVIRONMENT = original_env
    _iam._instance = None


@pytest_asyncio.fixture(autouse=True)
async def init_test_db():
    """Initialize Beanie + Valkey for all tests.
    Clears outbox_events and sla_deadlines between tests for isolation.
    """
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    db = client[TEST_DB_NAME]
    _db_module._client = client
    _db_module._db = db
    await init_beanie(database=db, document_models=ALL_DOCUMENTS)

    from src.valkey import init_valkey, close_valkey
    await init_valkey()

    AsyncIOMotorClientSession.start_transaction = _noop_start_transaction

    yield

    AsyncIOMotorClientSession.start_transaction = _original_start_transaction
    await db["outbox_events"].delete_many({})
    await db["sla_deadlines"].delete_many({})
    await close_valkey()
    _db_module._client = None
    _db_module._db = None
    client.close()


@pytest.fixture
def mock_rabbitmq_ready():
    with patch("src.rabbitmq.connection.ensure_ready", new_callable=AsyncMock, return_value=True) as m:
        yield m


@pytest.fixture
def mock_rabbitmq_down():
    with patch("src.rabbitmq.connection.ensure_ready", new_callable=AsyncMock, return_value=False) as m:
        yield m


@pytest.fixture
def mock_channel():
    from contextlib import asynccontextmanager

    mock_exchange = AsyncMock()
    mock_exchange.publish = AsyncMock()

    mock_ch = AsyncMock()
    mock_ch.declare_exchange = AsyncMock(return_value=mock_exchange)

    @asynccontextmanager
    async def fake_channel():
        yield mock_ch

    mock_conn = AsyncMock()
    mock_conn.channel = fake_channel

    with patch("src.rabbitmq.connection.rabbitmq_connection", mock_conn):
        yield {"connection": mock_conn, "channel": mock_ch, "exchange": mock_exchange}


@pytest.fixture
def mock_publish_fails():
    """Broker reachable, this message won't go — pair with `mock_rabbitmq_ready`.

    The distinction matters to the relay: it skips the whole batch when the
    broker is down (so an outage costs no retry budget) and only counts a retry
    when a live broker refuses an individual message. `mock_rabbitmq_down`
    cannot exercise the second path at all, because `_relay_batch` returns
    before it reads anything.
    """
    def refuse_channel(*args, **kwargs):
        raise RuntimeError("channel refused")

    mock_conn = AsyncMock()
    mock_conn.is_closed = False
    mock_conn.channel = refuse_channel

    with patch("src.rabbitmq.connection.rabbitmq_connection", mock_conn):
        yield mock_conn
