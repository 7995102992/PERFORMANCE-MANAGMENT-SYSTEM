"""Tests for the seeded lookup collections + GET /lookups/{acl,modules,permissions} routes.

Seeder idempotency is checked at the repo level (upsert_* should not create
duplicates on re-run). Route tests mock the repo reads.
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from src.auth.schemas import UserBase
from src.models import AclRoleEnum, ModuleEnum, PermissionCodeEnum
from tests.conftest import TEST_USER_EMAIL, TEST_USER_FIRST_NAME, TEST_USER_ID, TEST_USER_LAST_NAME


def _auth_patch():
    """Any authenticated user can hit the lookups — they're product-wide."""
    return patch(
        "src.auth.utils.dependencies.get_user_by_email",
        new_callable=AsyncMock,
        return_value=UserBase(
            id=TEST_USER_ID, email=TEST_USER_EMAIL,
            first_name=TEST_USER_FIRST_NAME, last_name=TEST_USER_LAST_NAME, is_super_admin=False,
        ),
    )


# ---------------------------------------------------------------------------
# GET /lookups/acl
# ---------------------------------------------------------------------------
class TestAclRoute:
    @pytest.mark.asyncio
    async def test_returns_all_roles_in_rank_order(
        self, client: AsyncClient, auth_headers: dict,
    ):
        rows = [
            {"id": "viewer", "role": "viewer", "label": "Viewer", "rank": 0},
            {"id": "editor", "role": "editor", "label": "Editor", "rank": 1},
            {"id": "admin",  "role": "admin",  "label": "Administrator", "rank": 2},
        ]
        with _auth_patch(), \
             patch("src.lookups.service.repo.list_acl",
                   new_callable=AsyncMock, return_value=rows):
            response = await client.get("/lookups/acl", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert [r["role"] for r in data] == ["viewer", "editor", "admin"]
        assert {r["role"] for r in data} == {e.value for e in AclRoleEnum}

    @pytest.mark.asyncio
    async def test_requires_auth(self, client: AsyncClient):
        response = await client.get("/lookups/acl")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /lookups/modules
# ---------------------------------------------------------------------------
class TestModulesRoute:
    @pytest.mark.asyncio
    async def test_returns_modules_with_description_and_mandatory(
        self, client: AsyncClient, auth_headers: dict,
    ):
        rows = [
            {
                "id": "core_hr", "code": "core_hr", "label": "Core HR",
                "description": "Employee database, org structure, and basic HR functions",
                "mandatory": True,
            },
            {
                "id": "training_and_development",
                "code": "training_and_development",
                "label": "Training & Development",
                "description": "Learning programs, courses, and skill development",
                "mandatory": False,
            },
        ]
        with _auth_patch(), \
             patch("src.lookups.service.repo.list_modules",
                   new_callable=AsyncMock, return_value=rows):
            response = await client.get("/lookups/modules", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        core_hr = next(m for m in data if m["code"] == "core_hr")
        assert core_hr["mandatory"] is True
        assert "Employee database" in core_hr["description"]

        # Label fix verified — wireframe uses '&', not 'and'.
        tnd = next(m for m in data if m["code"] == "training_and_development")
        assert tnd["label"] == "Training & Development"

    @pytest.mark.asyncio
    async def test_requires_auth(self, client: AsyncClient):
        response = await client.get("/lookups/modules")
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET /lookups/permissions
# ---------------------------------------------------------------------------
class TestPermissionsRoute:
    @pytest.mark.asyncio
    async def test_returns_module_scoped_permissions(
        self, client: AsyncClient, auth_headers: dict,
    ):
        rows = [
            {"id": "core_hr:create", "module": "core_hr", "code": "create", "label": "Create"},
            {"id": "leave_management:holiday_plan", "module": "leave_management",
             "code": "holiday_plan", "label": "Holiday Plan"},
        ]
        with _auth_patch(), \
             patch("src.lookups.service.repo.list_permissions",
                   new_callable=AsyncMock, return_value=rows):
            response = await client.get("/lookups/permissions", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert {(r["module"], r["code"]) for r in data} == {
            ("core_hr", "create"), ("leave_management", "holiday_plan"),
        }

    @pytest.mark.asyncio
    async def test_filters_by_module(self, client: AsyncClient, auth_headers: dict):
        with _auth_patch(), \
             patch("src.lookups.service.repo.list_permissions",
                   new_callable=AsyncMock, return_value=[]) as repo_mock:
            response = await client.get(
                "/lookups/permissions?module=leave_management", headers=auth_headers,
            )
        assert response.status_code == 200
        repo_mock.assert_awaited_once_with("leave_management")


# ---------------------------------------------------------------------------
# MODULE_PERMISSIONS registry + label/id helpers
# ---------------------------------------------------------------------------
class TestModulePermissionRegistry:
    def test_leave_management_has_feature_codes(self):
        from src.models import MODULE_PERMISSIONS, ModuleEnum, PermissionCodeEnum

        leave = MODULE_PERMISSIONS[ModuleEnum.LEAVE_MANAGEMENT]
        assert PermissionCodeEnum.HOLIDAY_PLAN in leave
        assert PermissionCodeEnum.MANAGE_LEAVE_REQUEST in leave
        assert PermissionCodeEnum.CREATE not in leave  # no generic CRUD

    def test_core_hr_has_generic_crud(self):
        from src.models import MODULE_PERMISSIONS, ModuleEnum, PermissionCodeEnum

        assert PermissionCodeEnum.CREATE in MODULE_PERMISSIONS[ModuleEnum.CORE_HR]
        assert PermissionCodeEnum.HOLIDAY_PLAN not in MODULE_PERMISSIONS[ModuleEnum.CORE_HR]

    def test_doc_id_and_label(self):
        from src.models import ModuleEnum, PermissionCodeEnum, permission_doc_id, permission_label

        assert permission_doc_id(ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.HOLIDAY_PLAN) \
            == "leave_management:holiday_plan"
        assert permission_label(ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.HOLIDAY_PLAN) \
            == "Holiday Plan"
        assert permission_label(ModuleEnum.CORE_HR, PermissionCodeEnum.CREATE) == "Create"


# ---------------------------------------------------------------------------
# require_permission rejects cross-module action mismatch
# ---------------------------------------------------------------------------
class TestRequirePermissionValidation:
    def test_rejects_invalid_module_action_pair(self):
        from src.auth.utils.authorization import require_permission

        with pytest.raises(ValueError):
            require_permission("core_hr", "holiday_plan")

    def test_accepts_valid_pair(self):
        from src.auth.utils.authorization import require_permission

        require_permission("leave_management", "holiday_plan")
        require_permission("core_hr", "create")


# ---------------------------------------------------------------------------
# Seeder idempotency — upserts never duplicate
# ---------------------------------------------------------------------------
class TestSeederUpserts:
    @pytest.mark.asyncio
    async def test_upsert_module_updates_existing(self):
        """Running the seeder twice updates the row, not inserts a duplicate."""
        from src.lookups.utils import tools

        existing = AsyncMock()
        existing.set = AsyncMock()

        get_returns = [existing, existing]  # simulate 'already exists'
        with patch("src.lookups.utils.tools.ModuleDocument") as ModDoc:
            ModDoc.get = AsyncMock(side_effect=get_returns)
            # upsert twice
            await tools.upsert_module({
                "id": "core_hr", "code": "core_hr", "label": "Core HR",
                "description": "v1", "mandatory": True,
            })
            await tools.upsert_module({
                "id": "core_hr", "code": "core_hr", "label": "Core HR",
                "description": "v2",  # changed
                "mandatory": True,
            })

        # Never instantiated a new doc — went through .set() both times.
        ModDoc.assert_not_called()
        # Second call's payload propagated
        assert existing.set.await_count == 2
        last_patch = existing.set.await_args.args[0]
        assert last_patch["description"] == "v2"

    @pytest.mark.asyncio
    async def test_upsert_inserts_when_missing(self):
        """First seed run inserts a fresh row."""
        from src.lookups.utils import tools

        with patch("src.lookups.utils.tools.AclDocument") as AclDoc:
            AclDoc.get = AsyncMock(return_value=None)
            instance = AsyncMock()
            instance.insert = AsyncMock()
            AclDoc.return_value = instance
            await tools.upsert_acl({
                "id": "admin", "role": "admin", "label": "Administrator", "rank": 2,
            })

        AclDoc.assert_called_once()
        instance.insert.assert_awaited_once()
