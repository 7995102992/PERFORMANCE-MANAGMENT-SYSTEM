"""Tests for POST /auth/logout and POST /auth/confirm-email-change."""

from copy import deepcopy
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_FIRST_NAME, TEST_USER_ID, TEST_USER_LAST_NAME


def _auth_patch():
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(
            id=TEST_USER_ID, email=TEST_USER_EMAIL,
            first_name=TEST_USER_FIRST_NAME, last_name=TEST_USER_LAST_NAME, is_super_admin=True,
        ),
    )


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------
class TestLogout:
    @pytest.mark.asyncio
    async def test_logout_current_device(self, client: AsyncClient, auth_headers: dict):
        """Without refresh_token: only the current access-token cache is dropped."""
        with _auth_patch(), \
             patch("src.auth.service.delete_user_session",
                   new_callable=AsyncMock) as mock_del_session, \
             patch("src.auth.service.revoke_session",
                   new_callable=AsyncMock) as mock_revoke, \
             patch("src.auth.service.revoke_all_user_sessions",
                   new_callable=AsyncMock) as mock_revoke_all, \
             patch("src.auth.service.delete_all_user_sessions_for_user",
                   new_callable=AsyncMock) as mock_purge_cache:
            response = await client.post("/auth/logout", json={}, headers=auth_headers)

        assert response.status_code == 204
        mock_del_session.assert_awaited_once()
        # The raw access token from auth_headers should be the deletion key.
        access_token_passed = mock_del_session.call_args.args[0]
        assert auth_headers["Authorization"] == f"Bearer {access_token_passed}"
        mock_revoke.assert_not_called()
        mock_revoke_all.assert_not_called()
        mock_purge_cache.assert_not_called()

    @pytest.mark.asyncio
    async def test_logout_with_refresh_token_revokes_that_session(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), \
             patch("src.auth.service.delete_user_session",
                   new_callable=AsyncMock), \
             patch("src.auth.service.revoke_session",
                   new_callable=AsyncMock) as mock_revoke, \
             patch("src.auth.service.delete_all_user_sessions_for_user",
                   new_callable=AsyncMock):
            response = await client.post(
                "/auth/logout",
                json={"refresh_token": "raw-refresh-token-value"},
                headers=auth_headers,
            )

        assert response.status_code == 204
        mock_revoke.assert_awaited_once()
        # Second arg is the user_id
        assert mock_revoke.call_args.args[1] == TEST_USER_ID

    @pytest.mark.asyncio
    async def test_logout_all_devices_purges_everything(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), \
             patch("src.auth.service.delete_user_session",
                   new_callable=AsyncMock), \
             patch("src.auth.service.revoke_all_user_sessions",
                   new_callable=AsyncMock) as mock_revoke_all, \
             patch("src.auth.service.delete_all_user_sessions_for_user",
                   new_callable=AsyncMock) as mock_purge_cache:
            response = await client.post(
                "/auth/logout",
                json={"all_devices": True},
                headers=auth_headers,
            )

        assert response.status_code == 204
        mock_revoke_all.assert_awaited_once_with(TEST_USER_ID)
        mock_purge_cache.assert_awaited_once_with(TEST_USER_ID)

    @pytest.mark.asyncio
    async def test_logout_unauthenticated(self, client: AsyncClient):
        response = await client.post("/auth/logout", json={})
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# POST /auth/confirm-email-change
# ---------------------------------------------------------------------------
class TestConfirmEmailChange:
    @pytest.mark.asyncio
    async def test_confirm_success_swaps_email_and_revokes_sessions(
        self, client: AsyncClient,
    ):
        with_pending = {**TEST_USER_DOC, "pending_email": "new@acme.com"}

        with patch("src.auth.service.get_email_change_payload",
                   new_callable=AsyncMock,
                   return_value={"user_id": TEST_USER_ID, "new_email": "new@acme.com"}), \
             patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=with_pending), \
             patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.auth.service.repository.update_user",
                   new_callable=AsyncMock) as mock_update, \
             patch("src.auth.service.delete_email_change_token",
                   new_callable=AsyncMock) as mock_del_tok, \
             patch("src.auth.service.revoke_all_user_sessions",
                   new_callable=AsyncMock) as mock_revoke, \
             patch("src.auth.service.delete_all_user_sessions_for_user",
                   new_callable=AsyncMock) as mock_purge:
            response = await client.post("/auth/confirm-email-change",
                                          json={"token": "valid-token"})

        assert response.status_code == 200
        assert response.json()["message"] == "Email address updated successfully"

        _, patch_arg = mock_update.call_args.args
        assert patch_arg["email"] == "new@acme.com"
        assert patch_arg["pending_email"] is None
        mock_del_tok.assert_awaited_once_with("valid-token")
        mock_revoke.assert_awaited_once_with(TEST_USER_ID)
        mock_purge.assert_awaited_once_with(TEST_USER_ID)

    @pytest.mark.asyncio
    async def test_confirm_invalid_token(self, client: AsyncClient):
        with patch("src.auth.service.get_email_change_payload",
                   new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/confirm-email-change",
                                          json={"token": "bad"})

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_EMAIL_CHANGE_TOKEN"

    @pytest.mark.asyncio
    async def test_confirm_orphan_user_deletes_token(self, client: AsyncClient):
        """If the user vanished between initiate and confirm, drop the token."""
        with patch("src.auth.service.get_email_change_payload",
                   new_callable=AsyncMock,
                   return_value={"user_id": "ghost", "new_email": "new@acme.com"}), \
             patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.auth.service.delete_email_change_token",
                   new_callable=AsyncMock) as mock_del:
            response = await client.post("/auth/confirm-email-change",
                                          json={"token": "orphan"})

        assert response.status_code == 404
        mock_del.assert_awaited_once_with("orphan")

    @pytest.mark.asyncio
    async def test_confirm_race_email_now_taken(self, client: AsyncClient):
        """Another user grabbed the new email between initiate and confirm."""
        with_pending = {**TEST_USER_DOC, "pending_email": "new@acme.com"}
        other_user = {**TEST_USER_DOC, "id": str(uuid4()), "email": "new@acme.com"}

        with patch("src.auth.service.get_email_change_payload",
                   new_callable=AsyncMock,
                   return_value={"user_id": TEST_USER_ID, "new_email": "new@acme.com"}), \
             patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=with_pending), \
             patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=other_user), \
             patch("src.auth.service.delete_email_change_token",
                   new_callable=AsyncMock) as mock_del:
            response = await client.post("/auth/confirm-email-change",
                                          json={"token": "raced"})

        assert response.status_code == 409
        assert response.json()["code"] == "EMAIL_ALREADY_EXISTS"
        mock_del.assert_awaited_once_with("raced")


# ---------------------------------------------------------------------------
# initiate_email_change service
# ---------------------------------------------------------------------------
class TestInitiateEmailChange:
    @pytest.mark.asyncio
    async def test_initiate_same_email_is_noop(self):
        from src.auth import service

        with patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=None) as mock_get_email, \
             patch("src.auth.service.publish_email_change_confirmation_email",
                   new_callable=AsyncMock) as mock_publish:
            result = await service.initiate_email_change(TEST_USER_ID, TEST_USER_EMAIL)

        assert result["message"] == "Email unchanged"
        mock_get_email.assert_not_called()
        mock_publish.assert_not_called()

    @pytest.mark.asyncio
    async def test_initiate_target_email_already_taken(self):
        from src.auth import service

        other = {**TEST_USER_DOC, "id": "other-id"}
        with patch("src.auth.service.repository.get_user_by_id",
                   new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.get_user_by_email",
                   new_callable=AsyncMock, return_value=other):
            with pytest.raises(Exception) as exc:
                await service.initiate_email_change(TEST_USER_ID, "taken@x.com")

        assert getattr(exc.value, "code", "") == "EMAIL_ALREADY_EXISTS"
