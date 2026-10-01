"""Tests for src/auth/utils/authorization.py — the require_permission dependency.

Resolution model (Valkey-first):
  1. Super admin → allow.
  2. Org admin → allow (role-based, tenant-wide).
  3. Read Valkey session cache → inspect permissions grid → allow/deny.
  4. Cache miss → resolve_user_permissions from source-of-truth → allow/deny.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.exceptions import DomainException
from tests.conftest import TEST_USER_EMAIL, TEST_USER_ID


def _user(is_super: bool = False, is_org_admin: bool = False, organisation_id: str | None = None) -> UserBase:
    return UserBase(
        id=TEST_USER_ID,
        email=TEST_USER_EMAIL,
        first_name="Test",
        last_name="User",
        is_super_admin=is_super,
        is_org_admin=is_org_admin,
        organisation_id=organisation_id,
    )


def _session_with_perms(perms: dict) -> dict:
    return {
        "user_id": TEST_USER_ID,
        "email": TEST_USER_EMAIL,
        "permissions": perms,
    }


# ---------------------------------------------------------------------------
# Unit tests on the dependency callable
# ---------------------------------------------------------------------------
class TestRequirePermissionUnit:
    @pytest.mark.asyncio
    async def test_super_admin_bypasses_all_checks(self):
        """Super admin never hits the session or resolve path."""
        dep = require_permission("users", "delete")
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock,
        ) as mock_session, patch(
            "src.auth.utils.authorization.resolve_user_permissions",
            new_callable=AsyncMock,
        ) as mock_resolve:
            result = await dep(current_user=_user(is_super=True), access_token="tok")
        assert result.is_super_admin is True
        mock_session.assert_not_called()
        mock_resolve.assert_not_called()

    @pytest.mark.asyncio
    async def test_org_admin_bypasses_policy_lookup(self):
        dep = require_permission("users", "delete")
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock,
        ) as mock_session:
            result = await dep(
                current_user=_user(is_org_admin=True, organisation_id="acme-org"),
                access_token="tok",
            )
        assert result.is_org_admin is True
        mock_session.assert_not_called()

    @pytest.mark.asyncio
    async def test_org_admin_passes_without_any_assignments(self):
        """The point of the short-circuit: zero policies, still works."""
        for action in ("create", "read", "update", "delete", "export"):
            dep = require_permission("users", action)
            result = await dep(
                current_user=_user(is_org_admin=True, organisation_id="acme-org"),
                access_token="tok",
            )
            assert result.id == TEST_USER_ID

    @pytest.mark.asyncio
    async def test_cached_session_grants_permission(self):
        """Valkey cache hit with matching permission → allow."""
        dep = require_permission("users", "read")
        session = _session_with_perms({
            "users": {"acl": "editor", "actions": {"create": False, "read": True, "update": False, "delete": False, "export": False}},
        })
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=session,
        ):
            result = await dep(current_user=_user(), access_token="tok")
        assert result.id == TEST_USER_ID

    @pytest.mark.asyncio
    async def test_cached_session_denies_missing_permission(self):
        """Valkey cache hit without matching permission → 403."""
        dep = require_permission("users", "delete")
        session = _session_with_perms({
            "users": {"acl": "viewer", "actions": {"create": False, "read": True, "update": False, "delete": False, "export": False}},
        })
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=session,
        ):
            with pytest.raises(DomainException) as exc:
                await dep(current_user=_user(), access_token="tok")
        assert exc.value.code == "FORBIDDEN"
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_cache_miss_falls_through_to_resolve(self):
        """Valkey returns None → resolve_user_permissions is called."""
        dep = require_permission("users", "read")
        resolved = {
            "users": {"acl": "editor", "actions": {"create": False, "read": True, "update": False, "delete": False, "export": False}},
        }
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=None,
        ), patch(
            "src.auth.utils.authorization.resolve_user_permissions",
            new_callable=AsyncMock, return_value=resolved,
        ) as mock_resolve:
            result = await dep(current_user=_user(), access_token="tok")
        assert result.id == TEST_USER_ID
        mock_resolve.assert_awaited_once_with(TEST_USER_ID)

    @pytest.mark.asyncio
    async def test_cache_miss_no_permissions_forbidden(self):
        """Valkey miss + empty resolve → 403."""
        dep = require_permission("users", "read")
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=None,
        ), patch(
            "src.auth.utils.authorization.resolve_user_permissions",
            new_callable=AsyncMock, return_value={},
        ):
            with pytest.raises(DomainException) as exc:
                await dep(current_user=_user(), access_token="tok")
        assert exc.value.code == "FORBIDDEN"

    @pytest.mark.asyncio
    async def test_empty_cached_permissions_forbidden(self):
        """Valkey returns session with empty permissions grid → 403."""
        dep = require_permission("users", "read")
        session = _session_with_perms({})
        with patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=session,
        ):
            with pytest.raises(DomainException) as exc:
                await dep(current_user=_user(), access_token="tok")
        assert exc.value.code == "FORBIDDEN"

    def test_factory_rejects_unknown_action(self):
        with pytest.raises(ValueError):
            require_permission("users", "bogus_action")


# ---------------------------------------------------------------------------
# Route-level smoke tests (/dashboard/stats)
# ---------------------------------------------------------------------------
class TestRouteLevelEnforcement:
    @pytest.mark.asyncio
    async def test_dashboard_super_admin_allowed(self, client: AsyncClient, auth_headers: dict):
        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=_user(is_super=True),
        ), patch(
            "src.dashboard.service.get_dashboard_stats", new_callable=AsyncMock,
            return_value={"total_users": 0, "total_policies": 0, "total_assignments": 0},
        ):
            response = await client.get("/dashboard/stats", headers=auth_headers)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_dashboard_non_admin_no_permissions_forbidden(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=_user(is_super=False),
        ), patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=None,
        ), patch(
            "src.auth.utils.authorization.resolve_user_permissions",
            new_callable=AsyncMock, return_value={},
        ):
            response = await client.get("/dashboard/stats", headers=auth_headers)
        assert response.status_code == 403
        assert response.json()["code"] == "FORBIDDEN"

    @pytest.mark.asyncio
    async def test_dashboard_non_admin_with_cached_permission_allowed(
        self, client: AsyncClient, auth_headers: dict,
    ):
        session = _session_with_perms({
            "dashboard": {"acl": "admin", "actions": {"create": True, "read": True, "update": True, "delete": True, "export": True}},
        })
        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=_user(is_super=False),
        ), patch(
            "src.auth.utils.authorization.get_user_session",
            new_callable=AsyncMock, return_value=session,
        ), patch(
            "src.dashboard.service.get_dashboard_stats", new_callable=AsyncMock,
            return_value={"total_users": 0, "total_policies": 0, "total_assignments": 0},
        ):
            response = await client.get("/dashboard/stats", headers=auth_headers)
        assert response.status_code == 200


# ---------------------------------------------------------------------------
# Org-admin cross-cutting guarantees (Option B wiring)
# ---------------------------------------------------------------------------
class TestOrgAdminAccess:
    @pytest.mark.asyncio
    async def test_org_admin_can_list_users_without_any_policy(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Org admin hits /users with zero policies and still gets 200,
        scoped to their own org."""
        acme_user = {
            "id": "acme-user-1",
            "email": "bob@acme.com",
            "auth_method": "local",
            "first_name": "Bob",
            "last_name": "User",
            "status": "active",
            "organisation_id": "acme-org",
            "is_org_admin": False,
            "is_super_admin": False,
            "created_on": datetime.now(timezone.utc),
            "modified_on": datetime.now(timezone.utc),
        }
        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=_user(is_org_admin=True, organisation_id="acme-org"),
        ), patch(
            "src.users.service.repository.list_users",
            new_callable=AsyncMock, return_value=[acme_user],
        ) as mock_list:
            response = await client.get("/users", headers=auth_headers)

        assert response.status_code == 200
        mock_list.assert_awaited_once_with(0, 20, organisation_id="acme-org")

    @pytest.mark.asyncio
    async def test_org_admin_cannot_reach_super_admin_routes(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """/super-admin/organisations/* still requires is_super_admin."""
        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=_user(is_org_admin=True, organisation_id="acme-org"),
        ):
            response = await client.get("/super-admin/organisations", headers=auth_headers)

        assert response.status_code == 403
        assert response.json()["code"] == "FORBIDDEN"
