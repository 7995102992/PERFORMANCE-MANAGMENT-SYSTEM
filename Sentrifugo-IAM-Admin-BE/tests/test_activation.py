from copy import deepcopy
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_ID, TEST_USER_PASSWORD


INACTIVE_USER_DOC = {**TEST_USER_DOC, "status": "inactive"}


# ---------------------------------------------------------------------------
# POST /auth/login — inactive user blocked
# ---------------------------------------------------------------------------
class TestLoginGate:
    @pytest.mark.asyncio
    async def test_login_inactive_user_blocked(self, client: AsyncClient):
        """Inactive (unactivated) users cannot login."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=INACTIVE_USER_DOC):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 403
        assert response.json()["code"] == "ACCOUNT_NOT_ACTIVATED"

    @pytest.mark.asyncio
    async def test_login_active_user_allowed(self, client: AsyncClient):
        """Active users can still login normally."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock, return_value={"id": "s"}):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 200
        assert "access_token" in response.json()


# ---------------------------------------------------------------------------
# POST /auth/activate
# ---------------------------------------------------------------------------
class TestActivateAccount:
    @pytest.mark.asyncio
    async def test_activate_success_sets_password(self, client: AsyncClient):
        """Valid token activates the account and sets the new password hash."""
        with patch("src.auth.service.get_user_id_by_activation_token", new_callable=AsyncMock, return_value=TEST_USER_ID), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=INACTIVE_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock) as mock_update, \
             patch("src.auth.service.delete_activation_token", new_callable=AsyncMock):
            response = await client.post("/auth/activate", json={
                "token": "valid-activation-token",
                "password": "FirstLogin@2026",
            })

        assert response.status_code == 200
        assert response.json()["message"] == "Account activated successfully"

        # Verify the update wrote password_hash (hashed, not plaintext) and
        # password_changed_at alongside the status flip.
        mock_update.assert_awaited_once()
        user_id_arg, patch_arg = mock_update.call_args.args
        assert user_id_arg == TEST_USER_ID
        assert patch_arg["status"] == "active"
        assert "password_hash" in patch_arg
        assert patch_arg["password_hash"] != "FirstLogin@2026"  # hashed
        assert "password_changed_at" in patch_arg

    @pytest.mark.asyncio
    async def test_activate_invalid_token(self, client: AsyncClient):
        """Invalid or expired token returns 400."""
        with patch("src.auth.service.get_user_id_by_activation_token", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/activate", json={
                "token": "expired-or-invalid-token",
                "password": "FirstLogin@2026",
            })

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_ACTIVATION_TOKEN"

    @pytest.mark.asyncio
    async def test_activate_password_too_short(self, client: AsyncClient):
        """Password below 8 chars is rejected at schema validation."""
        response = await client.post("/auth/activate", json={
            "token": "any-token",
            "password": "short",
        })
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_activate_missing_password(self, client: AsyncClient):
        """Omitting password is rejected at schema validation."""
        response = await client.post("/auth/activate", json={"token": "any-token"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_activate_already_active_does_not_overwrite_password(
        self, client: AsyncClient
    ):
        """A leaked token for an already-active user must NOT reset the password."""
        with patch("src.auth.service.get_user_id_by_activation_token", new_callable=AsyncMock, return_value=TEST_USER_ID), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock) as mock_update, \
             patch("src.auth.service.delete_activation_token", new_callable=AsyncMock):
            response = await client.post("/auth/activate", json={
                "token": "some-token",
                "password": "NewPassword@123",
            })

        assert response.status_code == 200
        assert response.json()["message"] == "Account is already activated"
        mock_update.assert_not_called()

    @pytest.mark.asyncio
    async def test_activate_user_not_found(self, client: AsyncClient):
        """Token points to a deleted/nonexistent user returns 404."""
        with patch("src.auth.service.get_user_id_by_activation_token", new_callable=AsyncMock, return_value="nonexistent-id"), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/activate", json={
                "token": "valid-but-user-gone",
                "password": "FirstLogin@2026",
            })

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"


# ---------------------------------------------------------------------------
# POST /auth/resend-activation
# ---------------------------------------------------------------------------
class TestResendActivation:
    @pytest.mark.asyncio
    async def test_resend_success(self, client: AsyncClient):
        """Resend activation for an inactive user succeeds."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=INACTIVE_USER_DOC), \
             patch("src.auth.service.store_activation_token", new_callable=AsyncMock), \
             patch("src.auth.service.publish_activation_email", new_callable=AsyncMock):
            response = await client.post("/auth/resend-activation", json={
                "email": TEST_USER_EMAIL,
            })

        assert response.status_code == 200
        assert "activation link has been sent" in response.json()["message"]

    @pytest.mark.asyncio
    async def test_resend_nonexistent_email_no_leak(self, client: AsyncClient):
        """Non-existent email still returns success (prevents enumeration)."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/resend-activation", json={
                "email": "nobody@example.com",
            })

        assert response.status_code == 200
        assert "activation link has been sent" in response.json()["message"]

    @pytest.mark.asyncio
    async def test_resend_already_active(self, client: AsyncClient):
        """Resend for an already-active account returns 400."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.post("/auth/resend-activation", json={
                "email": TEST_USER_EMAIL,
            })

        assert response.status_code == 400
        assert response.json()["code"] == "ALREADY_ACTIVATED"


# ---------------------------------------------------------------------------
# User creation — activation email sent
# ---------------------------------------------------------------------------
class TestUserCreationActivation:
    @pytest.mark.asyncio
    async def test_create_local_user_sends_activation(self, client: AsyncClient, auth_headers: dict):
        """Creating a local user triggers activation email."""
        from src.auth.schemas import UserBase

        new_user = {**TEST_USER_DOC, "id": str(uuid4()), "email": "new@example.com", "status": "inactive"}

        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
                    return_value=UserBase(id=TEST_USER_ID, email=TEST_USER_EMAIL, first_name="Test", last_name="User", is_super_admin=True)), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None), \
             patch("src.users.service.repository.create_user", new_callable=AsyncMock, return_value=new_user), \
             patch("src.users.service.send_activation_email", new_callable=AsyncMock) as mock_send:
            response = await client.post("/users", json={
                "email": "new@example.com",
                "password": "Secure@123",
                "auth_method": "local",
                "first_name": "New",
                "last_name": "User",
            }, headers=auth_headers)

        assert response.status_code == 201
        assert response.json()["status"] == "inactive"
        mock_send.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_sso_user_no_activation(self, client: AsyncClient, auth_headers: dict):
        """Creating an SSO user does NOT trigger activation email."""
        from src.auth.schemas import UserBase

        sso_user = {
            **TEST_USER_DOC,
            "id": str(uuid4()),
            "email": "sso@example.com",
            "auth_method": "azure_sso",
            "azure_oid": "azure-oid-123",
            "status": "active",
        }

        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
                    return_value=UserBase(id=TEST_USER_ID, email=TEST_USER_EMAIL, first_name="Test", last_name="User", is_super_admin=True)), \
             patch("src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None), \
             patch("src.users.service.repository.create_user", new_callable=AsyncMock, return_value=sso_user), \
             patch("src.users.service.send_activation_email", new_callable=AsyncMock) as mock_send:
            response = await client.post("/users", json={
                "email": "sso@example.com",
                "auth_method": "azure_sso",
                "azure_oid": "azure-oid-123",
                "first_name": "SSO",
                "last_name": "User",
            }, headers=auth_headers)

        assert response.status_code == 201
        assert response.json()["status"] == "active"
        mock_send.assert_not_called()
