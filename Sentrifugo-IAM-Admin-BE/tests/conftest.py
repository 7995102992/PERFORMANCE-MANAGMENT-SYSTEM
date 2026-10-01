from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from src.auth.utils.oauth2 import create_access_token
from src.auth.utils.tools import get_password_hash


# ---------------------------------------------------------------------------
# Mock user data shared across tests
# ---------------------------------------------------------------------------
TEST_USER_ID = str(uuid4())
TEST_USER_EMAIL = "testuser@example.com"
TEST_USER_PASSWORD = "Test@1234"
TEST_USER_FIRST_NAME = "Test"
TEST_USER_LAST_NAME = "User"

TEST_USER_DOC = {
    "id": TEST_USER_ID,
    "email": TEST_USER_EMAIL,
    "password_hash": get_password_hash(TEST_USER_PASSWORD),
    "auth_method": "local",
    "azure_oid": None,
    "first_name": TEST_USER_FIRST_NAME,
    "last_name": TEST_USER_LAST_NAME,
    "avatar_url": None,
    "status": "active",
    "last_login_at": None,
    "password_changed_at": datetime.now(timezone.utc),
    "is_super_admin": True,
    "created_by": None,
    "created_on": datetime.now(timezone.utc),
    "modified_by": None,
    "modified_on": datetime.now(timezone.utc),
    "deleted_by": None,
    "deleted_on": None,
    "correlation_id": None,
}


def _make_auth_header() -> dict[str, str]:
    """Generate a valid Authorization header for the test user."""
    token = create_access_token(data={"sub": TEST_USER_EMAIL, "uid": TEST_USER_ID})
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def auth_headers() -> dict[str, str]:
    """Valid JWT auth headers for the test user."""
    return _make_auth_header()


@pytest.fixture
def mock_mongo():
    """Patch get_mongo to return a mock database. Yields the mock db."""
    mock_db = MagicMock()
    with patch("src.database.get_mongo", return_value=mock_db):
        yield mock_db


@pytest.fixture
async def client():
    """Async test client with mocked infrastructure."""
    mock_valkey = AsyncMock()
    mock_valkey.ping = AsyncMock(return_value=True)
    mock_valkey.get = AsyncMock(return_value=None)
    # Token-revocation check (is_access_token_revoked) does EXISTS on the
    # revoked-token key. Without an explicit return value the bare AsyncMock
    # yields a truthy MagicMock, so every authenticated request 401s.
    mock_valkey.exists = AsyncMock(return_value=0)

    mock_rmq = MagicMock()
    mock_rmq.is_closed = False

    # Mock DB init/close and setup_db_context so tests don't connect to real DBs
    with patch("src.database.setup_db_context", new_callable=lambda: _noop_db_context), \
         patch("src.main.init_db", new_callable=AsyncMock), \
         patch("src.main.close_db", new_callable=AsyncMock), \
         patch("src.valkey.valkey_client", mock_valkey), \
         patch("src.rabbitmq.connection.rabbitmq_connection", mock_rmq):
        from src.main import app

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as c:
            yield c


async def _noop_db_context():
    """No-op replacement for setup_db_context in tests."""
    yield
