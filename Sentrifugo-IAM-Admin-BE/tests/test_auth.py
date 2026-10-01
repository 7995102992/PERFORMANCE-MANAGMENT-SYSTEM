from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.auth.utils.oauth2 import hash_refresh_token
from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_ID, TEST_USER_PASSWORD, TEST_USER_FIRST_NAME, TEST_USER_LAST_NAME

MOCK_CURRENT_USER = UserBase(id=TEST_USER_ID, email=TEST_USER_EMAIL, first_name="Test", last_name="User", is_super_admin=True)


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------
class TestLogin:
    @pytest.mark.asyncio
    async def test_login_success(self, client: AsyncClient):
        """Valid email + password returns access and refresh tokens."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock, return_value={"id": "mock-session"}):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"

    @pytest.mark.asyncio
    async def test_login_wrong_email(self, client: AsyncClient):
        """Non-existent email returns 401."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/login", json={
                "email": "nobody@example.com",
                "password": "whatever123",
            })

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"

    @pytest.mark.asyncio
    async def test_login_wrong_password(self, client: AsyncClient):
        """Correct email but wrong password returns 401."""
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": "wrongpassword123",
            })

        assert response.status_code == 401
        assert response.json()["code"] == "UNAUTHORIZED"

    @pytest.mark.asyncio
    async def test_login_sso_user_blocked(self, client: AsyncClient):
        """Azure SSO user cannot login with password endpoint."""
        sso_user = {**TEST_USER_DOC, "auth_method": "azure_sso"}
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=sso_user):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 400
        assert response.json()["code"] == "SSO_REQUIRED"


# ---------------------------------------------------------------------------
# POST /auth/refresh
# ---------------------------------------------------------------------------
class TestRefresh:
    @pytest.mark.asyncio
    async def test_refresh_success(self, client: AsyncClient):
        """Valid refresh token returns new tokens."""
        raw_token = "test-refresh-token-value"
        session_doc = {
            "id": str(uuid4()),
            "user_id": TEST_USER_DOC["id"],
            "refresh_token": hash_refresh_token(raw_token),
            "refresh_token_expires_at": datetime.now(timezone.utc) + timedelta(days=7),
            "auth_method": "local",
            "ip_address": "127.0.0.1",
            "user_agent": "test",
            "is_revoked": False,
            "created_at": datetime.now(timezone.utc),
        }

        with patch("src.auth.service.get_session_by_token", new_callable=AsyncMock, return_value=session_doc), \
             patch("src.auth.service.revoke_session", new_callable=AsyncMock, return_value=True), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock, return_value={"id": "mock-session"}):
            response = await client.post("/auth/refresh", json={
                "refresh_token": raw_token,
            })

        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert "refresh_token" in data

    @pytest.mark.asyncio
    async def test_refresh_invalid_token(self, client: AsyncClient):
        """Invalid refresh token returns 401."""
        with patch("src.auth.service.get_session_by_token", new_callable=AsyncMock, return_value=None):
            response = await client.post("/auth/refresh", json={
                "refresh_token": "invalid-token",
            })

        assert response.status_code == 401
        assert response.json()["code"] == "INVALID_REFRESH_TOKEN"


# ---------------------------------------------------------------------------
# POST /auth/change-password
# ---------------------------------------------------------------------------
class TestChangePassword:
    @pytest.mark.asyncio
    async def test_change_password_success(self, client: AsyncClient, auth_headers):
        """Changing password with correct current password succeeds."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.PasswordHistoryDocument") as mock_phd, \
             patch("src.auth.service.revoke_all_user_sessions", new_callable=AsyncMock):
            mock_query = AsyncMock()
            mock_query.sort = lambda *a: mock_query
            mock_query.limit = lambda *a: mock_query
            mock_query.to_list = AsyncMock(return_value=[])
            mock_phd.find = lambda *a: mock_query
            mock_phd.return_value.insert = AsyncMock()

            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": "NewSecure@9999",
            }, headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["message"] == "Password changed successfully"

    @pytest.mark.asyncio
    async def test_change_password_wrong_current(self, client: AsyncClient, auth_headers):
        """Wrong current password returns 400."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC):
            response = await client.post("/auth/change-password", json={
                "current_password": "WrongPassword@123",
                "new_password": "NewSecure@9999",
            }, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "INCORRECT_PASSWORD"

    @pytest.mark.asyncio
    async def test_change_password_no_auth(self, client: AsyncClient):
        """Change password without auth returns 401."""
        response = await client.post("/auth/change-password", json={
            "current_password": TEST_USER_PASSWORD,
            "new_password": "NewSecure@9999",
        })
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# Password expiry
# ---------------------------------------------------------------------------
class TestPasswordExpiry:
    @pytest.mark.asyncio
    async def test_login_expired_password(self, client: AsyncClient):
        """Expired password returns 403 PASSWORD_EXPIRED."""
        expired_user = {
            **TEST_USER_DOC,
            "password_changed_at": datetime.now(timezone.utc) - timedelta(days=365),
        }
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=expired_user):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 403
        assert response.json()["code"] == "PASSWORD_EXPIRED"

    @pytest.mark.asyncio
    async def test_login_seeded_user_first_login_allowed(self, client: AsyncClient):
        """Seeded user with no password_changed_at can still login (first login)."""
        seeded_user = {
            **TEST_USER_DOC,
            "auth_method": "seeded",
            "password_changed_at": None,
        }
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=seeded_user), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock, return_value={"id": "mock-session"}):
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })

        assert response.status_code == 200
        assert "access_token" in response.json()


# ---------------------------------------------------------------------------
# GET /auth/azure/login
# ---------------------------------------------------------------------------
class TestAzureLogin:
    @pytest.mark.asyncio
    async def test_azure_login_not_configured(self, client: AsyncClient):
        """Returns 501 when Azure credentials are not set."""
        response = await client.get("/auth/azure/login")
        assert response.status_code == 501
        assert response.json()["code"] == "SSO_NOT_CONFIGURED"


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------
class TestMe:
    @pytest.mark.asyncio
    async def test_me_success(self, client: AsyncClient, auth_headers):
        """Authenticated user gets their full profile and permissions."""
        mock_permissions = {
            "core_hr": {
                "acl": "admin",
                "actions": {"create": True, "read": True, "update": True, "delete": True, "export": True},
            }
        }
        mock_session = {
            "user_id": TEST_USER_ID,
            "email": TEST_USER_EMAIL,
            "full_name": f"{TEST_USER_FIRST_NAME} {TEST_USER_LAST_NAME}",
            "first_name": TEST_USER_FIRST_NAME,
            "last_name": TEST_USER_LAST_NAME,
            "org_id": "",
            "is_super_admin": True,
            "is_org_admin": False,
            "auth_method": "local",
            "permissions": mock_permissions,
        }

        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.router.user_repo.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.router.get_user_session", new_callable=AsyncMock, return_value=mock_session):
            response = await client.get("/auth/me", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == TEST_USER_ID
        assert data["email"] == TEST_USER_EMAIL
        assert data["first_name"] == TEST_USER_FIRST_NAME
        assert data["last_name"] == TEST_USER_LAST_NAME
        assert data["is_super_admin"] is True
        assert data["permissions"] == mock_permissions

    @pytest.mark.asyncio
    async def test_me_without_session_returns_empty_permissions(self, client: AsyncClient, auth_headers):
        """When Valkey session is missing, permissions default to empty."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.auth.router.user_repo.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.router.get_user_session", new_callable=AsyncMock, return_value=None):
            response = await client.get("/auth/me", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == TEST_USER_ID
        assert data["permissions"] == {}

    @pytest.mark.asyncio
    async def test_me_no_auth(self, client: AsyncClient):
        """Unauthenticated request returns 401."""
        response = await client.get("/auth/me")
        assert response.status_code == 401


class TestUpdateMe:
    @pytest.mark.asyncio
    async def test_update_me_success(self, client: AsyncClient, auth_headers):
        """Self-service profile update succeeds and returns updated user."""
        updated_doc = {**TEST_USER_DOC, "first_name": "Newname", "phone": "+1234567890"}
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.users.service.repository.update_user", new_callable=AsyncMock, return_value=updated_doc), \
             patch("src.users.service.outbox.publish_audit_log", new_callable=AsyncMock):
            response = await client.put(
                "/auth/me",
                headers=auth_headers,
                json={"first_name": "Newname", "phone": "+1234567890"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["first_name"] == "Newname"
        assert data["phone"] == "+1234567890"

    @pytest.mark.asyncio
    async def test_update_me_rejects_protected_fields(self, client: AsyncClient, auth_headers):
        """email/status/is_org_admin/policy_ids are not on MeUpdate — silently ignored by Pydantic."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.users.service.repository.update_user", new_callable=AsyncMock, return_value=TEST_USER_DOC) as upd, \
             patch("src.users.service.outbox.publish_audit_log", new_callable=AsyncMock):
            response = await client.put(
                "/auth/me",
                headers=auth_headers,
                json={"first_name": "X", "email": "evil@x.com", "is_org_admin": True, "status": "inactive"},
            )

        assert response.status_code == 200
        sent_fields = upd.await_args.args[1]
        assert "email" not in sent_fields
        assert "is_org_admin" not in sent_fields
        assert "status" not in sent_fields
        assert sent_fields["first_name"] == "X"

    @pytest.mark.asyncio
    async def test_update_me_empty_body(self, client: AsyncClient, auth_headers):
        """Empty payload returns 400."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER):
            response = await client.put("/auth/me", headers=auth_headers, json={})
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_update_me_no_auth(self, client: AsyncClient):
        response = await client.put("/auth/me", json={"first_name": "X"})
        assert response.status_code == 401


class TestUploadProfilePhoto:
    @pytest.mark.asyncio
    async def test_upload_success(self, client: AsyncClient, auth_headers):
        """Valid JPEG upload updates avatar_url and avatar_asset_id."""
        fake_asset = MagicMock()
        fake_asset.file_url = "https://cdn.example.com/profile-photos/abc123.jpg"
        fake_asset.id = "asset-id-123"

        updated_doc = {
            **TEST_USER_DOC,
            "avatar_url": fake_asset.file_url,
            "avatar_asset_id": str(fake_asset.id),
        }

        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER), \
             patch("src.assets.asset_service") as mock_asset_svc, \
             patch("src.users.service.repository.update_user", new_callable=AsyncMock, return_value=updated_doc), \
             patch("src.users.service.outbox.publish_audit_log", new_callable=AsyncMock):
            mock_asset_svc.upload = AsyncMock(return_value=fake_asset)
            response = await client.post(
                "/auth/me/profile-photo",
                headers=auth_headers,
                files={"file": ("photo.jpg", b"\xff\xd8\xff\xe0" + b"\x00" * 100, "image/jpeg")},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["avatar_url"] == fake_asset.file_url
        assert data["avatar_asset_id"] == str(fake_asset.id)

    @pytest.mark.asyncio
    async def test_upload_rejects_non_image(self, client: AsyncClient, auth_headers):
        """Non-image MIME type returns 400."""
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER):
            response = await client.post(
                "/auth/me/profile-photo",
                headers=auth_headers,
                files={"file": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
            )
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_upload_rejects_oversized(self, client: AsyncClient, auth_headers):
        """File exceeding 2MB returns 400."""
        large_data = b"\x00" * (3 * 1024 * 1024)
        with patch("src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock, return_value=MOCK_CURRENT_USER):
            response = await client.post(
                "/auth/me/profile-photo",
                headers=auth_headers,
                files={"file": ("big.png", large_data, "image/png")},
            )
        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_upload_no_auth(self, client: AsyncClient):
        """Unauthenticated request returns 401."""
        response = await client.post(
            "/auth/me/profile-photo",
            files={"file": ("photo.jpg", b"\xff\xd8", "image/jpeg")},
        )
        assert response.status_code == 401
