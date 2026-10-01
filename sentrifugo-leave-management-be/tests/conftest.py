from contextlib import ExitStack

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from httpx import ASGITransport, AsyncClient

from src.main import app
from src.dependencies import UserBase, get_current_user
from src.database import get_db_session
from src.rabbitmq import get_rabbitmq_channel_dep
from src.redis import get_redis

TEST_ORG_ID = "507f1f77bcf86cd799439011"
TEST_USER_ID = "507f1f77bcf86cd799439012"

TEST_USER = UserBase(
    user_id=TEST_USER_ID,
    email="test@example.com",
    full_name="Test User",
    first_name="Test",
    last_name="User",
    org_id=TEST_ORG_ID,
    is_super_admin=True,
    is_org_admin=True,
)

MOCK_DB = MagicMock()


async def _mock_db_session():
    yield MOCK_DB


async def _mock_redis():
    """/health depends on get_redis, which raises when Redis isn't initialized.
    Nothing is really running in tests, so hand the route a stub client."""
    client = AsyncMock()
    client.ping = AsyncMock(return_value=True)
    return client


async def _mock_rabbitmq_channel():
    """Same for the /health RabbitMQ dependency — check_health only reads
    ``is_closed``."""
    channel = MagicMock()
    channel.is_closed = False
    return channel


@pytest.fixture
async def client():
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[get_db_session] = _mock_db_session
    app.dependency_overrides[get_redis] = _mock_redis
    app.dependency_overrides[get_rabbitmq_channel_dep] = _mock_rabbitmq_channel

    # Mock the entire lifespan so no real infra/cron starts. Keep this list in
    # sync with src/main.py's lifespan — patch() raises AttributeError if a name
    # no longer exists on src.main (which is what previously broke this fixture).
    # ExitStack (not a parenthesized with) because CPython caps statically nested
    # with-items at 20 and there are more patches than that.
    _async_lifespan_symbols = [
        "init_redis", "init_rabbitmq",
        "declare_dlq_infrastructure", "declare_iam_infrastructure",
        "declare_domain_events_infrastructure",
        "declare_leave_calendar_rpc_infrastructure",
        "declare_shift_details_rpc_infrastructure",
        "start_iam_consumer", "start_domain_events_consumer",
        "start_leave_calendar_rpc_consumer", "start_shift_details_rpc_consumer",
        "start_relay", "stop_relay",
        "run_leave_balance_cron", "run_year_end_cron",
        "run_holiday_reminder_cron", "run_leave_escalation_cron",
        "close_db", "close_redis", "close_rabbitmq",
    ]
    with ExitStack() as stack:
        stack.enter_context(patch("src.main.init_db"))  # sync, plain MagicMock
        for _sym in _async_lifespan_symbols:
            stack.enter_context(patch(f"src.main.{_sym}", new_callable=AsyncMock))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c

    app.dependency_overrides.clear()
