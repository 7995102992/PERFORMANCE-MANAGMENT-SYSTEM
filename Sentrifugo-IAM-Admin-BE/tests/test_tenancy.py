"""Row-level tenancy tests: services scope reads/writes by caller.organisation_id.

These tests exercise the service layer directly (bypassing HTTP + the authz
dependency) since tenancy is a service-layer concern. Super admins bypass
scoping; non-admins are confined to their own org; cross-org assignments are
rejected with ORG_MISMATCH.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from src.auth.schemas import UserBase
from src.exceptions import DomainException
from src.policies import service as policy_service
from src.policies.schemas import PolicyCreate
from src.users import service as user_service
from src.users.schemas import UserCreate


ORG_A = "org-aaaa"
ORG_B = "org-bbbb"


def _non_admin_in(org_id: str) -> UserBase:
    return UserBase(
        id=f"user-in-{org_id}",
        email=f"alice@{org_id}.example",
        first_name="Alice",
        last_name="User",
        is_super_admin=False,
        organisation_id=org_id,
    )


def _super_admin() -> UserBase:
    return UserBase(
        id="super-1",
        email="root@example.com",
        first_name="Root",
        last_name="Admin",
        is_super_admin=True,
        organisation_id=None,
    )


def _user_doc(user_id: str, org_id: str | None) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "id": user_id,
        "email": f"{user_id}@example.com",
        "first_name": user_id,
        "last_name": "",
        "auth_method": "local",
        "azure_oid": None,
        "avatar_url": None,
        "status": "active",
        "is_super_admin": False,
        "organisation_id": org_id,
        "last_login_at": None,
        "password_changed_at": now,
        "created_on": now,
        "modified_on": now,
    }


def _policy_doc(policy_id: str, org_id: str | None) -> dict:
    """Slim policy shape — grants live on ModuleAclPermissionDocument rows, not here."""
    now = datetime.now(timezone.utc)
    return {
        "id": policy_id,
        "name": f"{policy_id}-policy",
        "status": "active",
        "organisation_id": org_id,
        "seed_module_codes": [],
        "created_on": now,
        "modified_on": now,
    }


# ---------------------------------------------------------------------------
# Users — list/get/create scoping
# ---------------------------------------------------------------------------
class TestUserListScoping:
    @pytest.mark.asyncio
    async def test_non_admin_list_passes_own_org(self):
        with patch(
            "src.users.service.repository.list_users", new_callable=AsyncMock, return_value=[]
        ) as mock_list:
            await user_service.list_users(0, 20, caller=_non_admin_in(ORG_A))
        mock_list.assert_called_once_with(0, 20, organisation_id=ORG_A)

    @pytest.mark.asyncio
    async def test_super_admin_list_unfiltered(self):
        with patch(
            "src.users.service.repository.list_users", new_callable=AsyncMock, return_value=[]
        ) as mock_list:
            await user_service.list_users(0, 20, caller=_super_admin())
        mock_list.assert_called_once_with(0, 20, organisation_id=None)

    @pytest.mark.asyncio
    async def test_non_admin_search_passes_own_org(self):
        with patch(
            "src.users.service.repository.search_users", new_callable=AsyncMock, return_value=[]
        ) as mock_search:
            await user_service.search_users("foo", 0, 20, caller=_non_admin_in(ORG_A))
        mock_search.assert_called_once_with("foo", 0, 20, organisation_id=ORG_A)


class TestUserGetScoping:
    @pytest.mark.asyncio
    async def test_cross_org_get_returns_404(self):
        """Alice in org A fetching Bob in org B → 404 (hide existence)."""
        bob = _user_doc("bob", ORG_B)
        with patch(
            "src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=bob
        ):
            with pytest.raises(DomainException) as exc:
                await user_service.get_user(bob["id"], caller=_non_admin_in(ORG_A))
        assert exc.value.code == "USER_NOT_FOUND"
        assert exc.value.status_code == 404

    @pytest.mark.asyncio
    async def test_same_org_get_allowed(self):
        bob = _user_doc("bob", ORG_A)
        with patch(
            "src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=bob
        ):
            result = await user_service.get_user(bob["id"], caller=_non_admin_in(ORG_A))
        assert result.id == bob["id"]

    @pytest.mark.asyncio
    async def test_super_admin_cross_org_get_allowed(self):
        bob = _user_doc("bob", ORG_B)
        with patch(
            "src.users.service.repository.get_user_by_id", new_callable=AsyncMock, return_value=bob
        ):
            result = await user_service.get_user(bob["id"], caller=_super_admin())
        assert result.id == bob["id"]


class TestUserCreateOrgStamping:
    @pytest.mark.asyncio
    async def test_non_admin_ignores_requested_org_and_uses_own(self):
        """Non-admin trying to place a user in a different org has it overridden."""
        captured = {}

        async def capture_create(doc):
            captured.update(doc)
            return {**doc, "id": "new-user-id"}

        data = UserCreate(
            email="new@example.com",
            password="Secure@123",
            auth_method="local",
            first_name="New",
            last_name="User",
            organisation_id=ORG_B,
        )
        with patch(
            "src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None
        ), patch(
            "src.users.service.repository.create_user", side_effect=capture_create
        ), patch(
            "src.users.service.send_activation_email", new_callable=AsyncMock
        ):
            await user_service.create_user(data, caller=_non_admin_in(ORG_A))

        assert captured["organisation_id"] == ORG_A  # forced to caller's org

    @pytest.mark.asyncio
    async def test_super_admin_can_specify_any_org(self):
        captured = {}

        async def capture_create(doc):
            captured.update(doc)
            return {**doc, "id": "new-user-id"}

        data = UserCreate(
            email="new@example.com",
            password="Secure@123",
            auth_method="local",
            first_name="New",
            last_name="User",
            organisation_id=ORG_B,
        )
        with patch(
            "src.users.service.repository.get_user_by_email", new_callable=AsyncMock, return_value=None
        ), patch(
            "src.users.service.repository.create_user", side_effect=capture_create
        ), patch(
            "src.users.service.send_activation_email", new_callable=AsyncMock
        ):
            await user_service.create_user(data, caller=_super_admin())

        assert captured["organisation_id"] == ORG_B


# ---------------------------------------------------------------------------
# Policies — scoping on list/get + stamping on create
#
# User-policy attachment is covered by the attach/detach tests in
# test_users.py (via user.policy_ids).
# ---------------------------------------------------------------------------
class TestPolicyScoping:
    @pytest.mark.asyncio
    async def test_non_admin_cannot_see_policy_from_other_org(self):
        policy_b = _policy_doc("p-b", ORG_B)
        with patch(
            "src.policies.service.repo.get_policy_by_id",
            new_callable=AsyncMock, return_value=policy_b,
        ):
            with pytest.raises(DomainException) as exc:
                await policy_service.get_policy(policy_b["id"], caller=_non_admin_in(ORG_A))
        assert exc.value.code == "POLICY_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_non_admin_list_filters_by_own_org(self):
        with patch(
            "src.policies.service.repo.list_policies",
            new_callable=AsyncMock, return_value=[],
        ) as mock_list, patch(
            "src.policies.service.repo.count_policies",
            new_callable=AsyncMock, return_value=0,
        ):
            await policy_service.list_policies(caller=_non_admin_in(ORG_A))
        mock_list.assert_called_once_with(0, 20, None, None, organisation_id=ORG_A)

    @pytest.mark.asyncio
    async def test_policy_create_stamps_non_admins_org(self):
        """Non-admin's requested org is overridden with their own on create."""
        captured = {}

        async def capture_create(doc):
            captured.update(doc)
            return {**doc, "id": "new-policy-id"}

        data = PolicyCreate(
            name="X",
            organisation_id=ORG_B,  # caller tries org B
        )
        with patch(
            "src.policies.service.repo.get_policy_by_name",
            new_callable=AsyncMock, return_value=None,
        ), patch(
            "src.policies.service.repo.create_policy", side_effect=capture_create
        ):
            await policy_service.create_policy(data, caller=_non_admin_in(ORG_A))

        assert captured["organisation_id"] == ORG_A

    @pytest.mark.asyncio
    async def test_super_admin_can_specify_any_org_on_policy_create(self):
        captured = {}

        async def capture_create(doc):
            captured.update(doc)
            return {**doc, "id": "new-policy-id"}

        data = PolicyCreate(name="Y", organisation_id=ORG_B)
        with patch(
            "src.policies.service.repo.get_policy_by_name",
            new_callable=AsyncMock, return_value=None,
        ), patch(
            "src.policies.service.repo.create_policy", side_effect=capture_create
        ):
            await policy_service.create_policy(data, caller=_super_admin())

        assert captured["organisation_id"] == ORG_B
