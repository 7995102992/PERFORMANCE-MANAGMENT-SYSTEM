"""Tests for the Forgot Password + Reset Password flow.

Covers:
  - POST /auth/forgot-password anti-enumeration (nonexistent, SSO, inactive
    all return the same success response; only eligible users get an email).
  - POST /auth/reset-password success path, expired/invalid token, password
    reuse, missing-user race, session revocation.
  - POST /auth/portal/login gating (super-admin-only portal).
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from src.auth.utils.tools import get_password_hash, verify_password
from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_ID, TEST_USER_PASSWORD


FORGOT_URL = "/auth/forgot-password"
RESET_URL = "/auth/reset-password"
PORTAL_LOGIN_URL = "/auth/portal/login"

GENERIC_FORGOT_MESSAGE = "If the email exists, a password reset link has been sent"


# ---------------------------------------------------------------------------
# POST /auth/forgot-password
# ---------------------------------------------------------------------------
class TestForgotPassword:
    @pytest.mark.asyncio
    async def test_eligible_user_gets_email(self, client: AsyncClient):
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.generate_password_reset_token",
                   return_value="reset-token"), \
             patch("src.auth.service.store_password_reset_token",
                   new_callable=AsyncMock) as mock_store, \
             patch("src.auth.service.publish_password_reset_email",
                   new_callable=AsyncMock) as mock_publish:
            response = await client.post(FORGOT_URL, json={"email": TEST_USER_EMAIL})

        assert response.status_code == 200
        assert response.json()["message"] == GENERIC_FORGOT_MESSAGE
        mock_store.assert_awaited_once_with(TEST_USER_ID, "reset-token")
        mock_publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_unknown_email_returns_same_response_without_email(
        self, client: AsyncClient,
    ):
        """Anti-enumeration: unknown email must be indistinguishable from known."""
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.auth.service.store_password_reset_token",
                   new_callable=AsyncMock) as mock_store, \
             patch("src.auth.service.publish_password_reset_email",
                   new_callable=AsyncMock) as mock_publish:
            response = await client.post(FORGOT_URL, json={"email": "ghost@example.com"})

        assert response.status_code == 200
        assert response.json()["message"] == GENERIC_FORGOT_MESSAGE
        mock_store.assert_not_called()
        mock_publish.assert_not_called()

    @pytest.mark.asyncio
    async def test_sso_user_silently_skipped(self, client: AsyncClient):
        """SSO users can't reset a local password — silently do nothing."""
        sso_user = {**TEST_USER_DOC, "auth_method": "azure_sso"}
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=sso_user), \
             patch("src.auth.service.store_password_reset_token",
                   new_callable=AsyncMock) as mock_store, \
             patch("src.auth.service.publish_password_reset_email",
                   new_callable=AsyncMock) as mock_publish:
            response = await client.post(FORGOT_URL, json={"email": TEST_USER_EMAIL})

        assert response.status_code == 200
        assert response.json()["message"] == GENERIC_FORGOT_MESSAGE
        mock_store.assert_not_called()
        mock_publish.assert_not_called()

    @pytest.mark.asyncio
    async def test_inactive_user_silently_skipped(self, client: AsyncClient):
        """Unactivated accounts go through activation, not reset."""
        inactive = {**TEST_USER_DOC, "status": "inactive"}
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=inactive), \
             patch("src.auth.service.store_password_reset_token",
                   new_callable=AsyncMock) as mock_store, \
             patch("src.auth.service.publish_password_reset_email",
                   new_callable=AsyncMock) as mock_publish:
            response = await client.post(FORGOT_URL, json={"email": TEST_USER_EMAIL})

        assert response.status_code == 200
        assert response.json()["message"] == GENERIC_FORGOT_MESSAGE
        mock_store.assert_not_called()
        mock_publish.assert_not_called()


# ---------------------------------------------------------------------------
# POST /auth/reset-password
# ---------------------------------------------------------------------------
class TestResetPassword:
    @pytest.mark.asyncio
    async def test_reset_success_writes_hash_and_revokes_sessions(
        self, client: AsyncClient,
    ):
        user = {**TEST_USER_DOC}
        with patch("src.auth.service.get_user_id_by_password_reset_token",
                   new_callable=AsyncMock, return_value=TEST_USER_ID), \
             patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user), \
             patch("src.auth.service.PasswordHistoryDocument") as mock_hist_model, \
             patch("src.auth.service.repository.update_user",
                   new_callable=AsyncMock) as mock_update, \
             patch("src.auth.service.delete_password_reset_token",
                   new_callable=AsyncMock) as mock_delete_token, \
             patch("src.auth.service.revoke_all_user_sessions",
                   new_callable=AsyncMock) as mock_revoke, \
             patch("src.auth.service.delete_all_user_sessions_for_user",
                   new_callable=AsyncMock) as mock_purge_cache:
            # PasswordHistoryDocument.find(...).sort(...).limit(...).to_list()
            mock_hist_model.find.return_value.sort.return_value.limit.return_value.to_list = AsyncMock(return_value=[])
            mock_hist_model.return_value.insert = AsyncMock()

            response = await client.post(RESET_URL, json={
                "token": "valid-reset-token",
                "new_password": "BrandNewP@ss1",
            })

        assert response.status_code == 200
        assert response.json()["message"] == "Password reset successfully"

        mock_update.assert_awaited_once()
        user_id_arg, patch_arg = mock_update.call_args.args
        assert user_id_arg == TEST_USER_ID
        assert "password_hash" in patch_arg
        assert verify_password("BrandNewP@ss1", patch_arg["password_hash"])
        assert "password_changed_at" in patch_arg

        mock_delete_token.assert_awaited_once_with("valid-reset-token")
        mock_revoke.assert_awaited_once_with(TEST_USER_ID)
        mock_purge_cache.assert_awaited_once_with(TEST_USER_ID)

    @pytest.mark.asyncio
    async def test_reset_invalid_token(self, client: AsyncClient):
        with patch("src.auth.service.get_user_id_by_password_reset_token",
                   new_callable=AsyncMock, return_value=None):
            response = await client.post(RESET_URL, json={
                "token": "expired-or-fake",
                "new_password": "BrandNewP@ss1",
            })

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_RESET_TOKEN"

    @pytest.mark.asyncio
    async def test_reset_user_not_found_deletes_token(self, client: AsyncClient):
        """A valid token pointing to a gone user must delete the token."""
        with patch("src.auth.service.get_user_id_by_password_reset_token",
                   new_callable=AsyncMock, return_value="ghost-id"), \
             patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.auth.service.delete_password_reset_token",
                   new_callable=AsyncMock) as mock_delete:
            response = await client.post(RESET_URL, json={
                "token": "orphan-token",
                "new_password": "BrandNewP@ss1",
            })

        assert response.status_code == 404
        assert response.json()["code"] == "USER_NOT_FOUND"
        mock_delete.assert_awaited_once_with("orphan-token")

    @pytest.mark.asyncio
    async def test_reset_password_too_short_rejected(self, client: AsyncClient):
        response = await client.post(RESET_URL, json={
            "token": "any-token",
            "new_password": "short",
        })
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_reset_rejects_current_password_reuse(self, client: AsyncClient):
        """Cannot reuse the current password."""
        existing_hash = get_password_hash("SamePass@123")
        user = {**TEST_USER_DOC, "password_hash": existing_hash}

        with patch("src.auth.service.get_user_id_by_password_reset_token",
                   new_callable=AsyncMock, return_value=TEST_USER_ID), \
             patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=user), \
             patch("src.auth.service.PasswordHistoryDocument") as mock_hist_model:
            mock_hist_model.find.return_value.sort.return_value.limit.return_value.to_list = AsyncMock(return_value=[])
            response = await client.post(RESET_URL, json={
                "token": "valid-token",
                "new_password": "SamePass@123",
            })

        assert response.status_code == 400
        assert response.json()["code"] == "PASSWORD_RECENTLY_USED"


# ---------------------------------------------------------------------------
# POST /auth/portal/login — super-admin-only gating (#3)
# ---------------------------------------------------------------------------
class TestPortalLogin:
    @pytest.mark.asyncio
    async def test_portal_login_super_admin_allowed(self, client: AsyncClient):
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock,
                   return_value={"id": "s"}):
            response = await client.post(PORTAL_LOGIN_URL, json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 200
        assert "access_token" in response.json()

    @pytest.mark.asyncio
    async def test_portal_login_non_super_admin_forbidden(self, client: AsyncClient):
        """Valid credentials but not a super admin → 403."""
        org_admin = {**TEST_USER_DOC, "is_super_admin": False, "is_org_admin": True}
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=org_admin):
            response = await client.post(PORTAL_LOGIN_URL, json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 403
        assert response.json()["code"] == "FORBIDDEN"

    @pytest.mark.asyncio
    async def test_portal_login_bad_password_same_error_as_tenant_login(
        self, client: AsyncClient,
    ):
        """Portal endpoint must not leak whether email is a super admin by
        returning a different code for wrong-password vs wrong-role."""
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.post(PORTAL_LOGIN_URL, json={
                "email": TEST_USER_EMAIL,
                "password": "WrongPassword",
            })

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"

    @pytest.mark.asyncio
    async def test_tenant_login_still_accepts_org_admin(self, client: AsyncClient):
        """The tenant /auth/login must keep accepting non-super-admins."""
        org_admin = {**TEST_USER_DOC, "is_super_admin": False, "is_org_admin": True}
        with patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=org_admin), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock,
                   return_value={"id": "s"}), \
             patch("src.auth.service.create_user_session", new_callable=AsyncMock):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 200
