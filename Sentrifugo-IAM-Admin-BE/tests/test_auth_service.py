"""Service-layer tests for src/auth/service.py — gap coverage beyond test_auth.py/test_activation.py."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.auth.utils.oauth2 import hash_refresh_token
from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_ID, TEST_USER_PASSWORD


MOCK_CURRENT_USER = UserBase(id=TEST_USER_ID, email=TEST_USER_EMAIL, first_name="Test", last_name="User", is_super_admin=True)


# ---------------------------------------------------------------------------
# authenticate_user — remaining edge cases
# ---------------------------------------------------------------------------
class TestAuthenticateUserEdges:
    @pytest.mark.asyncio
    async def test_login_user_with_null_password_hash(self, client: AsyncClient):
        """Local user with no password_hash returns 401 (not 500)."""
        user = {**TEST_USER_DOC, "password_hash": None}
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=user):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })
        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"

    @pytest.mark.asyncio
    async def test_login_non_seeded_missing_password_changed_at(self, client: AsyncClient):
        """Non-seeded user with password_changed_at=None → PASSWORD_EXPIRED."""
        user = {**TEST_USER_DOC, "auth_method": "local", "password_changed_at": None}
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=user):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })
        assert response.status_code == 403
        assert response.json()["code"] == "PASSWORD_EXPIRED"


# ---------------------------------------------------------------------------
# refresh_access_token — user-gone case
# ---------------------------------------------------------------------------
class TestRefreshEdges:
    @pytest.mark.asyncio
    async def test_refresh_user_not_found(self, client: AsyncClient):
        """Valid session but user has been deleted → 401 USER_NOT_FOUND."""
        raw_token = "valid-refresh-but-user-gone"
        session_doc = {
            "id": str(uuid4()),
            "user_id": "ghost-user-id",
            "refresh_token": hash_refresh_token(raw_token),
            "auth_method": "local",
            "ip_address": "127.0.0.1",
            "user_agent": "test",
            "created_at": datetime.now(timezone.utc),
        }
        with patch("src.auth.service.get_session_by_token", new_callable=AsyncMock, return_value=session_doc), \
             patch("src.auth.service.revoke_session", new_callable=AsyncMock, return_value=True), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/refresh", json={"refresh_token": raw_token})

        assert response.status_code == 401
        assert response.json()["code"] == "USER_NOT_FOUND"


# ---------------------------------------------------------------------------
# change_password — gap coverage
# ---------------------------------------------------------------------------
class TestChangePasswordEdges:
    @pytest.mark.asyncio
    async def test_user_not_found(self, client: AsyncClient, auth_headers: dict):
        """JWT points to a deleted user → 404."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": "NewSecure@9999",
            }, headers=auth_headers)

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_user_has_no_password_hash(self, client: AsyncClient, auth_headers: dict):
        """SSO-only user with no password_hash → 400 INCORRECT_PASSWORD."""
        sso_user = {**TEST_USER_DOC, "password_hash": None, "auth_method": "azure_sso"}
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=sso_user):
            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": "NewSecure@9999",
            }, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "INCORRECT_PASSWORD"

    @pytest.mark.asyncio
    async def test_new_password_in_history(self, client: AsyncClient, auth_headers: dict):
        """New password matching a historical hash is rejected."""
        from src.auth.utils.tools import get_password_hash

        reused_password = "Previously@Used1"
        history_entry = AsyncMock()
        history_entry.password_hash = get_password_hash(reused_password)

        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.PasswordHistoryDocument") as mock_phd:
            mock_query = AsyncMock()
            mock_query.sort = lambda *a: mock_query
            mock_query.limit = lambda *a: mock_query
            mock_query.to_list = AsyncMock(return_value=[history_entry])
            mock_phd.find = lambda *a: mock_query

            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": reused_password,
            }, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "PASSWORD_RECENTLY_USED"

    @pytest.mark.asyncio
    async def test_new_password_equals_current(self, client: AsyncClient, auth_headers: dict):
        """New password identical to current is rejected."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.PasswordHistoryDocument") as mock_phd:
            mock_query = AsyncMock()
            mock_query.sort = lambda *a: mock_query
            mock_query.limit = lambda *a: mock_query
            mock_query.to_list = AsyncMock(return_value=[])
            mock_phd.find = lambda *a: mock_query

            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": TEST_USER_PASSWORD,
            }, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "PASSWORD_RECENTLY_USED"

    @pytest.mark.asyncio
    async def test_successful_change_revokes_sessions(self, client: AsyncClient, auth_headers: dict):
        """Successful change calls revoke_all_user_sessions."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.PasswordHistoryDocument") as mock_phd, \
             patch("src.auth.service.revoke_all_user_sessions", new_callable=AsyncMock) as mock_revoke:
            mock_query = AsyncMock()
            mock_query.sort = lambda *a: mock_query
            mock_query.limit = lambda *a: mock_query
            mock_query.to_list = AsyncMock(return_value=[])
            mock_phd.find = lambda *a: mock_query
            mock_phd.return_value.insert = AsyncMock()

            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": "BrandNew@9999",
            }, headers=auth_headers)

        assert response.status_code == 200
        mock_revoke.assert_awaited_once_with(TEST_USER_ID)


# ---------------------------------------------------------------------------
# get_user_by_email — direct service call
# ---------------------------------------------------------------------------
class TestGetUserByEmail:
    @pytest.mark.asyncio
    async def test_returns_userbase_when_found(self):
        from src.auth.service import get_user_by_email

        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            user = await get_user_by_email(TEST_USER_EMAIL)

        assert isinstance(user, UserBase)
        assert user.id == TEST_USER_ID
        assert user.email == TEST_USER_EMAIL

    @pytest.mark.asyncio
    async def test_returns_none_when_missing(self):
        from src.auth.service import get_user_by_email

        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None):
            user = await get_user_by_email("missing@example.com")

        assert user is None


# ---------------------------------------------------------------------------
# send_activation_email — wiring
# ---------------------------------------------------------------------------
class TestSendActivationEmail:
    @pytest.mark.asyncio
    async def test_stores_token_and_publishes_email(self):
        """send_activation_email generates a token, stores it, and publishes the email event."""
        from src.auth.service import send_activation_email

        with patch("src.auth.service.store_activation_token", new_callable=AsyncMock) as mock_store, \
             patch("src.auth.service.publish_activation_email", new_callable=AsyncMock) as mock_publish:
            await send_activation_email(TEST_USER_ID, TEST_USER_EMAIL, "Test User")

        mock_store.assert_awaited_once()
        stored_user_id, stored_token = mock_store.await_args.args
        assert stored_user_id == TEST_USER_ID
        assert isinstance(stored_token, str) and len(stored_token) > 0

        mock_publish.assert_awaited_once()
        pub_email, pub_name, pub_token = mock_publish.await_args.args
        assert pub_email == TEST_USER_EMAIL
        assert pub_name == "Test User"
        assert pub_token == stored_token


# ---------------------------------------------------------------------------
# JWT token generators (post-refactor) — shape + claims + expiry
# ---------------------------------------------------------------------------
class TestJWTTokenGenerators:
    def test_refresh_token_is_signed_jwt_with_expected_claims(self):
        import jwt
        from src.auth.config import auth_settings
        from src.auth.utils.oauth2 import ALGORITHM, generate_refresh_token

        token = generate_refresh_token(TEST_USER_ID)
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])

        assert claims["sub"] == TEST_USER_ID
        assert claims["typ"] == "refresh"
        assert "jti" in claims and len(claims["jti"]) > 0
        assert "exp" in claims

    def test_refresh_token_expires_roughly_7_days_out(self):
        import jwt
        from src.auth.config import auth_settings
        from src.auth.utils.oauth2 import ALGORITHM, generate_refresh_token

        before = datetime.now(timezone.utc)
        token = generate_refresh_token(TEST_USER_ID)
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
        exp = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
        delta = exp - before
        assert timedelta(days=7) - timedelta(seconds=5) <= delta <= timedelta(days=7) + timedelta(seconds=5)

    def test_refresh_tokens_are_unique_per_call(self):
        from src.auth.utils.oauth2 import generate_refresh_token

        assert generate_refresh_token(TEST_USER_ID) != generate_refresh_token(TEST_USER_ID)

    def test_activation_token_is_signed_jwt_with_expected_claims(self):
        import jwt
        from src.auth.config import auth_settings
        from src.auth.utils.activation import ALGORITHM, generate_activation_token

        token = generate_activation_token(TEST_USER_ID)
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])

        assert claims["sub"] == TEST_USER_ID
        assert claims["typ"] == "activation"
        assert "jti" in claims and len(claims["jti"]) > 0
        assert "exp" in claims

    def test_activation_token_expires_at_the_configured_ttl(self):
        # Follows ACTIVATION_TOKEN_EXPIRE_HOURS rather than pinning a number —
        # the setting is the source of truth and the email copy is derived from
        # it, so a hardcoded expectation here would just have to be edited every
        # time the window changes.
        import jwt
        from src.auth.config import auth_settings
        from src.auth.utils.activation import ALGORITHM, generate_activation_token

        before = datetime.now(timezone.utc)
        token = generate_activation_token(TEST_USER_ID)
        claims = jwt.decode(token, auth_settings.JWT_SECRET_KEY, algorithms=[ALGORITHM])
        exp = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
        delta = exp - before
        expected = timedelta(hours=auth_settings.ACTIVATION_TOKEN_EXPIRE_HOURS)
        assert expected - timedelta(seconds=5) <= delta <= expected + timedelta(seconds=5)

    def test_activation_token_rejected_with_wrong_secret(self):
        import jwt
        from src.auth.utils.activation import ALGORITHM, generate_activation_token

        token = generate_activation_token(TEST_USER_ID)
        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(token, "wrong-secret", algorithms=[ALGORITHM])
