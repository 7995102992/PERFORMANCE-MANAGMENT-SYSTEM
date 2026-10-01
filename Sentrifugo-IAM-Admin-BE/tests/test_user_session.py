"""Tests for src/auth/utils/user_session.py and its integration with auth flows.

Resolution model (after Chunk 5):
  - Walk `user.policy_ids` → filter active (non-deleted, active status)
    policies → batch-load ModuleAclPermissionDocument rows for them → fold
    into the {module: {acl, policy_ids, actions}} shape.
  - Role per module is the highest-ranked acl_id seen across contributing
    grants (admin > editor > viewer). Actions are OR'd across grants.
"""

import json
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from src.auth.utils import user_session
from tests.conftest import TEST_USER_DOC, TEST_USER_EMAIL, TEST_USER_ID, TEST_USER_PASSWORD


EDITOR_RW  = {"create": False, "read": True, "update": True, "delete": False, "export": False}
VIEWER_READ = {"create": False, "read": True, "update": False, "delete": False, "export": False}


def _user_doc(policy_ids: list[str] | None = None, **overrides) -> dict:
    """Build a user document for resolution tests."""
    doc = {**TEST_USER_DOC, "policy_ids": policy_ids or []}
    doc.update(overrides)
    return doc


def _active_policy(policy_id: str) -> dict:
    return {
        "id": policy_id,
        "name": f"{policy_id}-policy",
        "status": "active",
        "organisation_id": None,
    }


def _grant(policy_id: str, module_id: str, acl_id: str, permission_id: str) -> dict:
    return {
        "policy_id": policy_id,
        "module_id": module_id,
        "acl_id": acl_id,
        "permission_id": permission_id,
    }


# ---------------------------------------------------------------------------
# build_session_payload — pure shape tests
# ---------------------------------------------------------------------------
class TestBuildSessionPayload:
    def test_super_admin_payload_has_empty_permissions(self):
        doc = {**TEST_USER_DOC, "is_super_admin": True, "organisation_id": None}
        payload = user_session.build_session_payload(doc, permissions={})
        assert payload == {
            "user_id":        TEST_USER_ID,
            "email":          TEST_USER_EMAIL,
            "full_name":      "Test User",
            "first_name":     "Test",
            "last_name":      "User",
            "org_id":         "",
            "is_super_admin": True,
            "is_org_admin":   False,
            "auth_method":    doc["auth_method"],
            "permissions":    {},
        }

    def test_regular_user_payload_with_permissions_and_org(self):
        doc = {**TEST_USER_DOC, "is_super_admin": False, "organisation_id": "org-acme"}
        perms = {
            "core_hr": {
                "acl": "editor",
                "policy_ids": ["p-hr"],
                "actions": EDITOR_RW,
            }
        }
        payload = user_session.build_session_payload(doc, permissions=perms)
        assert payload["is_super_admin"] is False
        assert payload["org_id"] == "org-acme"
        assert payload["permissions"] == perms

    def test_missing_names_defaults_to_empty(self):
        doc = {**TEST_USER_DOC, "first_name": None, "last_name": None}
        payload = user_session.build_session_payload(doc, permissions={})
        assert payload["full_name"] == ""
        assert payload["first_name"] == ""
        assert payload["last_name"] == ""

    def test_auth_method_defaults_to_local_when_missing(self):
        doc = {k: v for k, v in TEST_USER_DOC.items() if k != "auth_method"}
        payload = user_session.build_session_payload(doc, permissions={})
        assert payload["auth_method"] == "local"


# ---------------------------------------------------------------------------
# resolve_user_permissions — new algorithm walking user.policy_ids
# ---------------------------------------------------------------------------
class TestResolveUserPermissions:
    @pytest.mark.asyncio
    async def test_empty_when_user_missing(self):
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=None,
        ):
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)
        assert perms == {}

    @pytest.mark.asyncio
    async def test_empty_when_no_policies(self):
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=_user_doc(policy_ids=[]),
        ):
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)
        assert perms == {}

    @pytest.mark.asyncio
    async def test_single_policy_single_module(self):
        """User holds one policy granting editor read+update on core_hr."""
        grants = [
            _grant("p-hr", "core_hr", "editor", "read"),
            _grant("p-hr", "core_hr", "editor", "update"),
        ]
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=_user_doc(policy_ids=["p-hr"]),
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.get_active_policies_by_ids",
            new_callable=AsyncMock, return_value=[_active_policy("p-hr")],
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.list_grants_for_policies",
            new_callable=AsyncMock, return_value=grants,
        ):
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)

        assert set(perms.keys()) == {"core_hr"}
        entry = perms["core_hr"]
        assert entry["acl"] == "editor"
        assert entry["actions"]["read"] is True
        assert entry["actions"]["update"] is True
        assert entry["actions"]["create"] is False
        assert entry["actions"]["delete"] is False

    @pytest.mark.asyncio
    async def test_different_modules_are_separate_entries(self):
        grants = [
            _grant("p-hr",    "core_hr",          "editor", "update"),
            _grant("p-leave", "leave_management", "admin",  "delete"),
        ]
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=_user_doc(policy_ids=["p-hr", "p-leave"]),
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.get_active_policies_by_ids",
            new_callable=AsyncMock,
            return_value=[_active_policy("p-hr"), _active_policy("p-leave")],
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.list_grants_for_policies",
            new_callable=AsyncMock, return_value=grants,
        ):
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)

        assert set(perms.keys()) == {"core_hr", "leave_management"}
        assert perms["core_hr"]["acl"] == "editor"
        assert perms["leave_management"]["acl"] == "admin"
        assert perms["leave_management"]["actions"]["delete"] is True

    @pytest.mark.asyncio
    async def test_multiple_policies_same_module_merge_with_highest_role(self):
        """Editor + viewer grants on core_hr: role=editor, actions OR'd."""
        grants = [
            # Policy A — editor row
            _grant("p-edit", "core_hr", "editor", "read"),
            _grant("p-edit", "core_hr", "editor", "update"),
            # Policy B — viewer row
            _grant("p-view", "core_hr", "viewer", "read"),
        ]
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=_user_doc(policy_ids=["p-edit", "p-view"]),
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.get_active_policies_by_ids",
            new_callable=AsyncMock,
            return_value=[_active_policy("p-edit"), _active_policy("p-view")],
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.list_grants_for_policies",
            new_callable=AsyncMock, return_value=grants,
        ):
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)

        entry = perms["core_hr"]
        assert entry["acl"] == "editor"  # higher of editor/viewer
        assert entry["actions"]["read"] is True
        assert entry["actions"]["update"] is True
        assert entry["actions"]["delete"] is False

    @pytest.mark.asyncio
    async def test_inactive_policy_filtered_before_grants_fetched(self):
        """Active filter runs before grants lookup; inactive policy contributes nothing."""
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=_user_doc(policy_ids=["p-a", "p-inactive"]),
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.get_active_policies_by_ids",
            new_callable=AsyncMock, return_value=[_active_policy("p-a")],
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.list_grants_for_policies",
            new_callable=AsyncMock,
            return_value=[_grant("p-a", "core_hr", "viewer", "read")],
        ) as mock_grants:
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)

        # grants query only sees the active policy id
        ids_arg = mock_grants.call_args.args[0]
        assert ids_arg == ["p-a"]
        assert "core_hr" in perms

    @pytest.mark.asyncio
    async def test_all_dangling_policy_ids_skipped(self):
        """User has three policy_ids, all soft-deleted → empty result, no grants query."""
        with patch(
            "src.auth.utils.user_session.user_repo.get_user_by_id",
            new_callable=AsyncMock, return_value=_user_doc(policy_ids=["gone-1", "gone-2", "gone-3"]),
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.get_active_policies_by_ids",
            new_callable=AsyncMock, return_value=[],
        ), patch(
            "src.auth.utils.user_session.policy_grants_repo.list_grants_for_policies",
            new_callable=AsyncMock,
        ) as mock_grants:
            perms = await user_session.resolve_user_permissions(TEST_USER_ID)

        assert perms == {}
        mock_grants.assert_not_called()


# ---------------------------------------------------------------------------
# create_user_session — Valkey interactions
# ---------------------------------------------------------------------------
class TestCreateUserSession:
    @pytest.mark.asyncio
    async def test_super_admin_gets_full_grid(self):
        """Super admin: no repo lookup; session has is_super_admin=True + full permissions grid."""
        fake_valkey = AsyncMock()
        fake_valkey.set = AsyncMock()
        fake_valkey.sadd = AsyncMock()

        doc = {**TEST_USER_DOC, "is_super_admin": True, "organisation_id": None}

        with patch("src.auth.utils.user_session.valkey.valkey_client", fake_valkey), \
             patch(
                 "src.auth.utils.user_session.user_repo.get_user_by_id",
                 new_callable=AsyncMock,
             ) as mock_user_lookup:
            await user_session.create_user_session("tok-super", doc)

        mock_user_lookup.assert_not_awaited()  # skipped entirely

        key, value = fake_valkey.set.await_args.args
        assert key == "session:tok-super"
        parsed = json.loads(value)
        assert parsed["is_super_admin"] is True
        perms = parsed["permissions"]
        assert len(perms) > 0
        for entry in perms.values():
            assert entry["acl"] == "admin"
            assert all(v is True for v in entry["actions"].values())

    @pytest.mark.asyncio
    async def test_org_admin_gets_full_grid(self):
        fake_valkey = AsyncMock()
        fake_valkey.set = AsyncMock()
        fake_valkey.sadd = AsyncMock()

        doc = {
            **TEST_USER_DOC,
            "is_super_admin": False,
            "is_org_admin": True,
            "organisation_id": "acme-org",
        }

        with patch("src.auth.utils.user_session.valkey.valkey_client", fake_valkey), \
             patch(
                 "src.auth.utils.user_session.user_repo.get_user_by_id",
                 new_callable=AsyncMock,
             ) as mock_user_lookup:
            await user_session.create_user_session("tok-orgadmin", doc)

        mock_user_lookup.assert_not_awaited()

        key, value = fake_valkey.set.await_args.args
        parsed = json.loads(value)
        assert parsed["is_org_admin"] is True
        assert parsed["is_super_admin"] is False
        assert parsed["org_id"] == "acme-org"
        perms = parsed["permissions"]
        assert len(perms) > 0
        for entry in perms.values():
            assert entry["acl"] == "admin"
            assert all(v is True for v in entry["actions"].values())

    @pytest.mark.asyncio
    async def test_regular_user_resolves_and_stores(self):
        fake_valkey = AsyncMock()
        fake_valkey.set = AsyncMock()
        fake_valkey.sadd = AsyncMock()

        doc = {
            **TEST_USER_DOC,
            "is_super_admin": False,
            "organisation_id": "org-x",
            "policy_ids": ["p-hr"],
        }
        grants = [
            _grant("p-hr", "core_hr", "editor", "read"),
            _grant("p-hr", "core_hr", "editor", "update"),
        ]

        with patch("src.auth.utils.user_session.valkey.valkey_client", fake_valkey), \
             patch(
                 "src.auth.utils.user_session.user_repo.get_user_by_id",
                 new_callable=AsyncMock, return_value=doc,
             ), patch(
                 "src.auth.utils.user_session.policy_grants_repo.get_active_policies_by_ids",
                 new_callable=AsyncMock, return_value=[_active_policy("p-hr")],
             ), patch(
                 "src.auth.utils.user_session.policy_grants_repo.list_grants_for_policies",
                 new_callable=AsyncMock, return_value=grants,
             ):
            await user_session.create_user_session("tok-regular", doc)

        _, value = fake_valkey.set.await_args.args
        parsed = json.loads(value)
        assert parsed["is_super_admin"] is False
        assert parsed["permissions"]["core_hr"]["acl"] == "editor"
        assert parsed["permissions"]["core_hr"]["actions"]["update"] is True

        fake_valkey.sadd.assert_awaited_once_with(f"user:access_tokens:{TEST_USER_ID}", "tok-regular")


# ---------------------------------------------------------------------------
# Simple get/delete Valkey ops (unchanged, but still sanity-checked)
# ---------------------------------------------------------------------------
class TestValkeySimpleOps:
    @pytest.mark.asyncio
    async def test_get_user_session_returns_parsed_payload(self):
        payload = {"user_id": "u-1", "email": "e@x", "is_super_admin": False, "permissions": {}}
        fake = AsyncMock()
        fake.get = AsyncMock(return_value=json.dumps(payload))
        with patch("src.auth.utils.user_session.valkey.valkey_client", fake):
            result = await user_session.get_user_session("tok-abc")
        assert result == payload

    @pytest.mark.asyncio
    async def test_get_user_session_returns_none_when_missing(self):
        fake = AsyncMock()
        fake.get = AsyncMock(return_value=None)
        with patch("src.auth.utils.user_session.valkey.valkey_client", fake):
            assert await user_session.get_user_session("nope") is None

    @pytest.mark.asyncio
    async def test_delete_user_session_removes_key_and_index_entry(self):
        fake = AsyncMock()
        fake.delete = AsyncMock()
        fake.srem = AsyncMock()
        with patch("src.auth.utils.user_session.valkey.valkey_client", fake):
            await user_session.delete_user_session("tok-abc", user_id=TEST_USER_ID)
        fake.delete.assert_awaited_once_with("session:tok-abc")
        fake.srem.assert_awaited_once_with(f"user:access_tokens:{TEST_USER_ID}", "tok-abc")

    @pytest.mark.asyncio
    async def test_delete_all_user_sessions_removes_every_token(self):
        fake = AsyncMock()
        fake.smembers = AsyncMock(return_value={"tok-1", "tok-2"})
        fake.delete = AsyncMock(return_value=2)
        with patch("src.auth.utils.user_session.valkey.valkey_client", fake):
            deleted = await user_session.delete_all_user_sessions_for_user(TEST_USER_ID)
        assert deleted == 2
        assert fake.delete.await_count == 2

    @pytest.mark.asyncio
    async def test_delete_all_user_sessions_noop_when_empty(self):
        fake = AsyncMock()
        fake.smembers = AsyncMock(return_value=set())
        with patch("src.auth.utils.user_session.valkey.valkey_client", fake):
            deleted = await user_session.delete_all_user_sessions_for_user(TEST_USER_ID)
        assert deleted == 0


# ---------------------------------------------------------------------------
# Integration — /auth/login creates a user session via _issue_tokens
# ---------------------------------------------------------------------------
class TestLoginCreatesSession:
    @pytest.mark.asyncio
    async def test_login_populates_user_session(self, client: AsyncClient):
        with patch("src.auth.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=TEST_USER_DOC), \
             patch("src.auth.service.repository.update_user", new_callable=AsyncMock), \
             patch("src.auth.service.create_session", new_callable=AsyncMock, return_value={"id": "s"}), \
             patch("src.auth.service.create_user_session", new_callable=AsyncMock) as mock_create:
            response = await client.post("/auth/login", json={
                "email": TEST_USER_EMAIL,
                "password": TEST_USER_PASSWORD,
            })
        assert response.status_code == 200
        mock_create.assert_awaited_once()
        called_token, called_user = mock_create.await_args.args
        assert isinstance(called_token, str) and len(called_token) > 0
        assert called_user["id"] == TEST_USER_ID


# ---------------------------------------------------------------------------
# Integration — /auth/change-password tears down every user session
# ---------------------------------------------------------------------------
class TestChangePasswordRevokesSessions:
    @pytest.mark.asyncio
    async def test_change_password_deletes_all_user_sessions(
        self, client: AsyncClient, auth_headers: dict
    ):
        from src.auth.schemas import UserBase

        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=UserBase(
                id=TEST_USER_ID, email=TEST_USER_EMAIL, first_name="Test", last_name="User", is_super_admin=True
            ),
        ), patch(
            "src.auth.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=TEST_USER_DOC
        ), patch(
            "src.auth.service.repository.update_user", new_callable=AsyncMock
        ), patch(
            "src.auth.service.PasswordHistoryDocument"
        ) as mock_phd, patch(
            "src.auth.service.revoke_all_user_sessions", new_callable=AsyncMock
        ), patch(
            "src.auth.service.delete_all_user_sessions_for_user", new_callable=AsyncMock
        ) as mock_delete_all:
            mock_q = AsyncMock()
            mock_q.sort = lambda *a: mock_q
            mock_q.limit = lambda *a: mock_q
            mock_q.to_list = AsyncMock(return_value=[])
            mock_phd.find = lambda *a: mock_q
            mock_phd.return_value.insert = AsyncMock()

            response = await client.post("/auth/change-password", json={
                "current_password": TEST_USER_PASSWORD,
                "new_password": "BrandNew@9999",
            }, headers=auth_headers)

        assert response.status_code == 200
        mock_delete_all.assert_awaited_once_with(TEST_USER_ID)
