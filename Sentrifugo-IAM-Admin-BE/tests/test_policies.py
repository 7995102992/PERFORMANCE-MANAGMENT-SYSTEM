"""Policy CRUD + grid tests for the new PolicyDocument / ModuleAclPermissionDocument model.

Assignment CRUD tests are gone — assignments are replaced by user.policy_ids
attachment in Chunk 4.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.models import AclRoleEnum, ModuleEnum, PermissionCodeEnum
from tests.conftest import TEST_USER_EMAIL, TEST_USER_FIRST_NAME, TEST_USER_ID, TEST_USER_LAST_NAME


TEST_POLICY_ID = str(uuid4())
TEST_POLICY_DOC = {
    "id": TEST_POLICY_ID,
    "name": "Core HR Policy",
    "is_active": True,
    "organisation_id": None,
    "seed_module_codes": ["core_hr"],
    "created_by": None,
    "created_on": datetime.now(timezone.utc),
    "modified_by": None,
    "modified_on": datetime.now(timezone.utc),
}


def _auth_patch(is_super_admin=True):
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(
            id=TEST_USER_ID, email=TEST_USER_EMAIL,
            first_name=TEST_USER_FIRST_NAME, last_name=TEST_USER_LAST_NAME, is_super_admin=is_super_admin,
        ),
    )


def _no_cache_holders():
    """Stub for _invalidate_cache_for_policy_holders — no users hold this policy."""
    return patch(
        "src.policies.service.user_repo.get_users_with_policy",
        new_callable=AsyncMock, return_value=[],
    )


# ===========================================================================
# POST /policies
# ===========================================================================
class TestCreatePolicy:
    @pytest.mark.asyncio
    async def test_create_without_seed_has_no_grants(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """No seed_module_code -> policy row, zero grants seeded."""
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.policies.service.repo.create_policy",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.insert_grants_bulk",
                   new_callable=AsyncMock) as mock_bulk:
            response = await client.post("/policies", json={
                "name": "Core HR Policy",
            }, headers=auth_headers)

        assert response.status_code == 201
        assert response.json()["name"] == "Core HR Policy"
        mock_bulk.assert_not_called()

    @pytest.mark.asyncio
    async def test_create_with_single_seed_populates_default_grid(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Single seed module triggers default admin=all, editor=rw, viewer=r grants."""
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.policies.service.repo.create_policy",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.insert_grants_bulk",
                   new_callable=AsyncMock) as mock_bulk:
            response = await client.post("/policies", json={
                "name": "Core HR Policy",
                "seed_module_codes": ["core_hr"],
            }, headers=auth_headers)

        assert response.status_code == 201
        mock_bulk.assert_awaited_once()
        seed_rows = mock_bulk.call_args.args[0]
        # 5 (admin) + 2 (editor r+u) + 1 (viewer r) = 8 grants
        assert len(seed_rows) == 8
        by_role = {}
        for r in seed_rows:
            by_role.setdefault(r["acl_id"], set()).add(r["permission_id"])
        assert by_role["admin"]  == {"create", "read", "update", "delete", "export"}
        assert by_role["editor"] == {"read", "update"}
        assert by_role["viewer"] == {"read"}
        assert {r["module_id"] for r in seed_rows} == {"core_hr"}

    @pytest.mark.asyncio
    async def test_create_with_multiple_seeds_populates_grid_for_each(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Multiple seed modules each get the default admin/editor/viewer grid."""
        multi_seed_doc = {**TEST_POLICY_DOC, "seed_module_codes": ["core_hr", "payroll"]}
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.policies.service.repo.create_policy",
                   new_callable=AsyncMock, return_value=multi_seed_doc), \
             patch("src.policies.service.repo.insert_grants_bulk",
                   new_callable=AsyncMock) as mock_bulk:
            response = await client.post("/policies", json={
                "name": "Core HR Policy",
                "seed_module_codes": ["core_hr", "payroll"],
            }, headers=auth_headers)

        assert response.status_code == 201
        mock_bulk.assert_awaited_once()
        seed_rows = mock_bulk.call_args.args[0]
        # 8 grants per module × 2 modules = 16
        assert len(seed_rows) == 16
        assert {r["module_id"] for r in seed_rows} == {"core_hr", "payroll"}

    @pytest.mark.asyncio
    async def test_duplicate_name_rejected(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC):
            response = await client.post("/policies", json={
                "name": "Core HR Policy",
            }, headers=auth_headers)

        assert response.status_code == 409
        assert response.json()["code"] == "POLICY_NAME_EXISTS"

    @pytest.mark.asyncio
    async def test_invalid_seed_module_rejected(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Unknown seed module fails validation at 422."""
        with _auth_patch():
            response = await client.post("/policies", json={
                "name": "Policy",
                "seed_module_codes": ["not_a_module"],
            }, headers=auth_headers)

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_unauthenticated(self, client: AsyncClient):
        response = await client.post("/policies", json={"name": "X"})
        assert response.status_code == 401


# ===========================================================================
# GET /policies
# ===========================================================================
class TestListPolicies:
    @pytest.mark.asyncio
    async def test_list_returns_items_and_total(
        self, client: AsyncClient, auth_headers: dict,
    ):
        docs = [
            {**TEST_POLICY_DOC, "id": "p1", "name": "A"},
            {**TEST_POLICY_DOC, "id": "p2", "name": "B"},
        ]
        with _auth_patch(), \
             patch("src.policies.service.repo.list_policies",
                   new_callable=AsyncMock, return_value=docs), \
             patch("src.policies.service.repo.count_policies",
                   new_callable=AsyncMock, return_value=2):
            response = await client.get("/policies", headers=auth_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 2
        assert len(body["items"]) == 2
        # Grid not included in list view (slim shape).
        assert "permissions" not in body["items"][0]

    @pytest.mark.asyncio
    async def test_list_filters_forwarded(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), \
             patch("src.policies.service.repo.list_policies",
                   new_callable=AsyncMock, return_value=[]) as mock_list, \
             patch("src.policies.service.repo.count_policies",
                   new_callable=AsyncMock, return_value=0):
            response = await client.get(
                "/policies?skip=10&limit=5&search=hr&is_active=true",
                headers=auth_headers,
            )

        assert response.status_code == 200
        mock_list.assert_awaited_once_with(
            10, 5, "hr", is_active=True, organisation_id=None,
        )


# ===========================================================================
# GET /policies/{id}
# ===========================================================================
class TestGetPolicy:
    @pytest.mark.asyncio
    async def test_get_success(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC):
            response = await client.get(f"/policies/{TEST_POLICY_ID}", headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["id"] == TEST_POLICY_ID

    @pytest.mark.asyncio
    async def test_get_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.get("/policies/missing", headers=auth_headers)

        assert response.status_code == 404
        assert response.json()["code"] == "POLICY_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_get_cross_org_hidden(self, client: AsyncClient, auth_headers: dict):
        """Policy in Acme; caller is an org admin in Beta -> 404 (hide existence).

        Caller is an org admin so require_permission short-circuits past the
        legacy assignment-lookup path; the service-level _scope_org then
        enforces tenant isolation.
        """
        acme_policy = {**TEST_POLICY_DOC, "organisation_id": "acme"}
        with patch(
            "src.auth.utils.dependencies.get_user_by_email", new_callable=AsyncMock,
            return_value=UserBase(
                id=TEST_USER_ID, email=TEST_USER_EMAIL,
                first_name=TEST_USER_FIRST_NAME, last_name=TEST_USER_LAST_NAME,
                is_super_admin=False, is_org_admin=True, organisation_id="beta",
            ),
        ), patch(
            "src.policies.service.repo.get_policy_by_id",
            new_callable=AsyncMock, return_value=acme_policy,
        ):
            response = await client.get(f"/policies/{TEST_POLICY_ID}", headers=auth_headers)

        assert response.status_code == 404
        assert response.json()["code"] == "POLICY_NOT_FOUND"


# ===========================================================================
# PUT /policies/{id}
# ===========================================================================
class TestUpdatePolicy:
    @pytest.mark.asyncio
    async def test_rename(self, client: AsyncClient, auth_headers: dict):
        renamed = {**TEST_POLICY_DOC, "name": "Renamed"}
        with _auth_patch(), _no_cache_holders(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.policies.service.repo.update_policy",
                   new_callable=AsyncMock, return_value=renamed):
            response = await client.put(f"/policies/{TEST_POLICY_ID}", json={
                "name": "Renamed",
            }, headers=auth_headers)

        assert response.status_code == 200
        assert response.json()["name"] == "Renamed"

    @pytest.mark.asyncio
    async def test_rename_collision(self, client: AsyncClient, auth_headers: dict):
        other = {**TEST_POLICY_DOC, "id": str(uuid4()), "name": "Taken"}
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=other):
            response = await client.put(f"/policies/{TEST_POLICY_ID}", json={
                "name": "Taken",
            }, headers=auth_headers)

        assert response.status_code == 409
        assert response.json()["code"] == "POLICY_NAME_EXISTS"

    @pytest.mark.asyncio
    async def test_empty_body_rejected(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC):
            response = await client.put(f"/policies/{TEST_POLICY_ID}", json={}, headers=auth_headers)

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_INPUT"


# ===========================================================================
# DELETE /policies/{id}
# ===========================================================================
class TestDeletePolicy:
    @pytest.mark.asyncio
    async def test_delete_success(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), _no_cache_holders(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.soft_delete_policy",
                   new_callable=AsyncMock, return_value=True) as mock_del:
            response = await client.delete(f"/policies/{TEST_POLICY_ID}", headers=auth_headers)

        assert response.status_code == 204
        mock_del.assert_awaited_once_with(TEST_POLICY_ID, current_user_id=TEST_USER_ID)

    @pytest.mark.asyncio
    async def test_delete_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.delete("/policies/missing", headers=auth_headers)

        assert response.status_code == 404


# ===========================================================================
# GET /policies/{id}/permissions
# ===========================================================================
class TestGetPolicyPermissions:
    @pytest.mark.asyncio
    async def test_empty_grid_when_no_grants(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Fresh policy with no grants -> full grid of False."""
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, return_value=[]):
            response = await client.get(
                f"/policies/{TEST_POLICY_ID}/permissions", headers=auth_headers,
            )

        assert response.status_code == 200
        grid = response.json()["permissions"]
        # All 9 modules present
        assert set(grid.keys()) == {m.value for m in ModuleEnum}
        # All 3 roles per module
        assert set(grid["core_hr"].keys()) == {r.value for r in AclRoleEnum}
        # All 5 perms per role; all False
        for role in grid["core_hr"].values():
            assert set(role.keys()) == {p.value for p in PermissionCodeEnum}
            assert all(v is False for v in role.values())

    @pytest.mark.asyncio
    async def test_granted_cells_reflect_live_rows(
        self, client: AsyncClient, auth_headers: dict,
    ):
        grants = [
            {"id": "g1", "module_id": "core_hr", "acl_id": "admin",  "permission_id": "read"},
            {"id": "g2", "module_id": "core_hr", "acl_id": "admin",  "permission_id": "update"},
            {"id": "g3", "module_id": "payroll", "acl_id": "viewer", "permission_id": "read"},
        ]
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, return_value=grants):
            response = await client.get(
                f"/policies/{TEST_POLICY_ID}/permissions", headers=auth_headers,
            )

        grid = response.json()["permissions"]
        assert grid["core_hr"]["admin"]["read"] is True
        assert grid["core_hr"]["admin"]["update"] is True
        assert grid["core_hr"]["admin"]["create"] is False  # not granted
        assert grid["payroll"]["viewer"]["read"] is True
        assert grid["payroll"]["viewer"]["create"] is False
        # Untouched modules still have all-False cells
        assert grid["attendance_management"]["admin"]["read"] is False


# ===========================================================================
# PUT /policies/{id}/permissions
# ===========================================================================
class TestReplacePolicyPermissions:
    @pytest.mark.asyncio
    async def test_put_forwards_desired_set_to_repo(
        self, client: AsyncClient, auth_headers: dict,
    ):
        """Submitted grid is converted to a desired-set and passed to the repo diff."""
        body = {
            "permissions": {
                "core_hr": {
                    "admin":  {"create": True,  "read": True,  "update": False, "delete": False, "export": False},
                    "editor": {"create": False, "read": True,  "update": False, "delete": False, "export": False},
                    "viewer": {"create": False, "read": False, "update": False, "delete": False, "export": False},
                },
            },
        }
        with _auth_patch(), _no_cache_holders(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.replace_policy_grants",
                   new_callable=AsyncMock, return_value=(2, 0)) as mock_replace, \
             patch("src.policies.service.repo.update_policy",
                   new_callable=AsyncMock), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, return_value=[]):
            response = await client.put(
                f"/policies/{TEST_POLICY_ID}/permissions",
                json=body, headers=auth_headers,
            )

        assert response.status_code == 200
        mock_replace.assert_awaited_once()
        policy_id_arg, desired_arg = mock_replace.call_args.args
        assert policy_id_arg == TEST_POLICY_ID
        # Only the True cells should be in `desired`.
        assert desired_arg == {
            ("core_hr", "admin", "create"),
            ("core_hr", "admin", "read"),
            ("core_hr", "editor", "read"),
        }

    @pytest.mark.asyncio
    async def test_put_empty_grid_clears_all(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), _no_cache_holders(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.replace_policy_grants",
                   new_callable=AsyncMock, return_value=(0, 8)) as mock_replace, \
             patch("src.policies.service.repo.update_policy",
                   new_callable=AsyncMock), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, return_value=[]):
            response = await client.put(
                f"/policies/{TEST_POLICY_ID}/permissions",
                json={"permissions": {}}, headers=auth_headers,
            )

        assert response.status_code == 200
        _, desired_arg = mock_replace.call_args.args
        assert desired_arg == set()

    @pytest.mark.asyncio
    async def test_put_on_missing_policy(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.put(
                "/policies/missing/permissions",
                json={"permissions": {}}, headers=auth_headers,
            )

        assert response.status_code == 404


# ===========================================================================
# POST /policies/{id}/copy
# ===========================================================================
class TestCopyPolicy:
    @pytest.mark.asyncio
    async def test_copy_success(self, client: AsyncClient, auth_headers: dict):
        """Copies source policy metadata and all grant rows into a new policy."""
        new_id = str(uuid4())
        new_doc = {**TEST_POLICY_DOC, "id": new_id, "name": "Copied Policy"}
        source_grants = [
            {"id": "g1", "module_id": "core_hr", "acl_id": "admin", "permission_id": "create"},
            {"id": "g2", "module_id": "core_hr", "acl_id": "admin", "permission_id": "read"},
            {"id": "g3", "module_id": "core_hr", "acl_id": "viewer", "permission_id": "read"},
        ]

        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.policies.service.repo.create_policy",
                   new_callable=AsyncMock, return_value=new_doc), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, return_value=source_grants), \
             patch("src.policies.service.repo.insert_grants_bulk",
                   new_callable=AsyncMock) as mock_bulk:
            response = await client.post(
                f"/policies/{TEST_POLICY_ID}/copy",
                json={"name": "Copied Policy"},
                headers=auth_headers,
            )

        assert response.status_code == 201
        assert response.json()["name"] == "Copied Policy"
        assert response.json()["id"] == new_id
        mock_bulk.assert_awaited_once()
        copied_rows = mock_bulk.call_args.args[0]
        assert len(copied_rows) == 3
        assert all(r["policy_id"] == new_id for r in copied_rows)

    @pytest.mark.asyncio
    async def test_copy_duplicate_name_rejected(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC):
            response = await client.post(
                f"/policies/{TEST_POLICY_ID}/copy",
                json={"name": "Core HR Policy"},
                headers=auth_headers,
            )

        assert response.status_code == 409
        assert response.json()["code"] == "POLICY_NAME_EXISTS"

    @pytest.mark.asyncio
    async def test_copy_source_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=None):
            response = await client.post(
                "/policies/missing/copy",
                json={"name": "New Name"},
                headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "POLICY_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_copy_with_no_grants(self, client: AsyncClient, auth_headers: dict):
        """Copying a policy with zero grants creates an empty policy."""
        new_id = str(uuid4())
        new_doc = {**TEST_POLICY_DOC, "id": new_id, "name": "Empty Copy"}

        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC), \
             patch("src.policies.service.repo.get_policy_by_name",
                   new_callable=AsyncMock, return_value=None), \
             patch("src.policies.service.repo.create_policy",
                   new_callable=AsyncMock, return_value=new_doc), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, return_value=[]), \
             patch("src.policies.service.repo.insert_grants_bulk",
                   new_callable=AsyncMock) as mock_bulk:
            response = await client.post(
                f"/policies/{TEST_POLICY_ID}/copy",
                json={"name": "Empty Copy"},
                headers=auth_headers,
            )

        assert response.status_code == 201
        mock_bulk.assert_not_called()


# ===========================================================================
# GET /policies/by-module/{module_id}
# ===========================================================================
class TestListPoliciesByModule:
    @pytest.mark.asyncio
    async def test_returns_policies_with_module_grants(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_ids_with_module",
                   new_callable=AsyncMock, return_value=[TEST_POLICY_ID]), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, return_value=TEST_POLICY_DOC):
            response = await client.get(
                "/policies/by-module/core_hr", headers=auth_headers,
            )

        assert response.status_code == 200
        assert len(response.json()) == 1
        assert response.json()[0]["id"] == TEST_POLICY_ID

    @pytest.mark.asyncio
    async def test_empty_when_no_policies_have_module(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_ids_with_module",
                   new_callable=AsyncMock, return_value=[]):
            response = await client.get(
                "/policies/by-module/payroll", headers=auth_headers,
            )

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_invalid_module_rejected(
        self, client: AsyncClient, auth_headers: dict,
    ):
        with _auth_patch():
            response = await client.get(
                "/policies/by-module/not_a_module", headers=auth_headers,
            )

        assert response.status_code == 400
        assert response.json()["code"] == "INVALID_MODULE"


# ===========================================================================
# POST /policies/{id}/copy-module-permissions
# ===========================================================================
class TestCopyModulePermissions:
    @pytest.mark.asyncio
    async def test_copies_selected_modules_from_source(
        self, client: AsyncClient, auth_headers: dict,
    ):
        source_id = str(uuid4())
        source_doc = {**TEST_POLICY_DOC, "id": source_id, "name": "Source"}
        source_grants = [
            {"id": "g1", "module_id": "core_hr", "acl_id": "admin", "permission_id": "create"},
            {"id": "g2", "module_id": "core_hr", "acl_id": "admin", "permission_id": "read"},
            {"id": "g3", "module_id": "payroll", "acl_id": "viewer", "permission_id": "read"},
        ]
        target_grants = [
            {"id": "g4", "module_id": "leave_management", "acl_id": "editor", "permission_id": "read"},
        ]

        with _auth_patch(), _no_cache_holders(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, side_effect=lambda pid: TEST_POLICY_DOC if pid == TEST_POLICY_ID else source_doc), \
             patch("src.policies.service.repo.list_grants_for_policy",
                   new_callable=AsyncMock, side_effect=lambda pid: source_grants if pid == source_id else target_grants), \
             patch("src.policies.service.repo.replace_policy_grants",
                   new_callable=AsyncMock, return_value=(2, 0)) as mock_replace, \
             patch("src.policies.service.repo.update_policy",
                   new_callable=AsyncMock):
            response = await client.post(
                f"/policies/{TEST_POLICY_ID}/copy-module-permissions",
                json={"source_policy_id": source_id, "modules": ["core_hr"]},
                headers=auth_headers,
            )

        assert response.status_code == 200
        mock_replace.assert_awaited_once()
        _, desired = mock_replace.call_args.args
        # Should have core_hr from source + leave_management from target (untouched)
        assert ("core_hr", "admin", "create") in desired
        assert ("core_hr", "admin", "read") in desired
        assert ("leave_management", "editor", "read") in desired
        # payroll was NOT requested, so source payroll grants should NOT be included
        assert ("payroll", "viewer", "read") not in desired

    @pytest.mark.asyncio
    async def test_source_not_found(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.policies.service.repo.get_policy_by_id",
                   new_callable=AsyncMock, side_effect=lambda pid: TEST_POLICY_DOC if pid == TEST_POLICY_ID else None):
            response = await client.post(
                f"/policies/{TEST_POLICY_ID}/copy-module-permissions",
                json={"source_policy_id": "missing", "modules": ["core_hr"]},
                headers=auth_headers,
            )

        assert response.status_code == 404
        assert response.json()["code"] == "SOURCE_POLICY_NOT_FOUND"
