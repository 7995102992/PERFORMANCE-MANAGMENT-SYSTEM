"""Tests for src/policies/utils/grants.py and the new Beanie documents.

Focus is on the `replace_policy_grants` diff logic — the rest of the
repository is thin Beanie pass-through that'll be covered indirectly
by service-level tests in Chunk 3.
"""

from unittest.mock import AsyncMock, patch

import pytest

from src.policies.models import ModuleAclPermissionDocument, PolicyDocument
from src.policies.utils import grants


# ---------------------------------------------------------------------------
# Document shape (introspected — no init_beanie in unit tests)
# ---------------------------------------------------------------------------
class TestPolicyDocumentShape:
    def test_required_and_optional_fields(self):
        fields = PolicyDocument.model_fields
        assert "name" in fields
        assert "status" in fields
        assert "organisation_id" in fields
        assert "seed_module_codes" in fields
        for audit in ("created_by", "created_on", "modified_by", "modified_on",
                      "deleted_by", "deleted_on", "correlation_id"):
            assert audit in fields

    def test_collection_name(self):
        assert PolicyDocument.Settings.name == "policies"

    def test_no_embedded_permission_rows(self):
        """Slim policy: no admin/editor/viewer sub-objects like the old doc."""
        fields = PolicyDocument.model_fields
        for removed in ("admin", "editor", "viewer", "module"):
            assert removed not in fields, f"unexpected legacy field: {removed}"


class TestModuleAclPermissionDocumentShape:
    def test_required_foreign_keys(self):
        fields = ModuleAclPermissionDocument.model_fields
        for fk in ("policy_id", "module_id", "acl_id", "permission_id"):
            assert fk in fields

    def test_collection_name(self):
        assert ModuleAclPermissionDocument.Settings.name == "module_acl_permissions"

    def test_no_granted_flag(self):
        """Presence-based: a row existing IS the grant. No `granted: bool`."""
        assert "granted" not in ModuleAclPermissionDocument.model_fields


# ---------------------------------------------------------------------------
# replace_policy_grants — the core diff algorithm
# ---------------------------------------------------------------------------
class TestReplacePolicyGrants:
    @pytest.mark.asyncio
    async def test_no_existing_grants_all_inserts(self):
        """Empty policy + desired grants -> pure insert pass."""
        desired = {
            ("core_hr", "admin", "create"),
            ("core_hr", "admin", "read"),
            ("payroll", "viewer", "read"),
        }
        with patch(
            "src.policies.utils.grants.list_grants_for_policy",
            new_callable=AsyncMock, return_value=[],
        ), patch(
            "src.policies.utils.grants.insert_grants_bulk",
            new_callable=AsyncMock,
        ) as mock_insert, patch(
            "src.policies.utils.grants.soft_delete_grant",
            new_callable=AsyncMock,
        ) as mock_delete:
            inserts, removes = await grants.replace_policy_grants(
                "pol-1", desired, current_user_id="admin",
            )

        assert inserts == 3
        assert removes == 0
        mock_delete.assert_not_called()
        mock_insert.assert_awaited_once()
        rows = mock_insert.call_args.args[0]
        assert len(rows) == 3
        keys = {(r["module_id"], r["acl_id"], r["permission_id"]) for r in rows}
        assert keys == desired
        for r in rows:
            assert r["policy_id"] == "pol-1"
            assert r["created_by"] == "admin"

    @pytest.mark.asyncio
    async def test_desired_empty_removes_all(self):
        """Emptying the grid soft-deletes every live row."""
        live = [
            {"id": "g1", "module_id": "core_hr", "acl_id": "admin", "permission_id": "create"},
            {"id": "g2", "module_id": "core_hr", "acl_id": "admin", "permission_id": "read"},
        ]
        with patch(
            "src.policies.utils.grants.list_grants_for_policy",
            new_callable=AsyncMock, return_value=live,
        ), patch(
            "src.policies.utils.grants.insert_grants_bulk",
            new_callable=AsyncMock,
        ) as mock_insert, patch(
            "src.policies.utils.grants.soft_delete_grant",
            new_callable=AsyncMock,
        ) as mock_delete:
            inserts, removes = await grants.replace_policy_grants(
                "pol-1", set(), current_user_id="admin",
            )

        assert inserts == 0
        assert removes == 2
        mock_insert.assert_not_called()
        assert mock_delete.await_count == 2
        deleted_ids = {call.args[0] for call in mock_delete.await_args_list}
        assert deleted_ids == {"g1", "g2"}

    @pytest.mark.asyncio
    async def test_diff_adds_and_removes(self):
        """Mix of new + retained + dropped combinations."""
        live = [
            # keep
            {"id": "k1", "module_id": "core_hr", "acl_id": "admin", "permission_id": "read"},
            # drop
            {"id": "d1", "module_id": "core_hr", "acl_id": "admin", "permission_id": "delete"},
            # drop
            {"id": "d2", "module_id": "payroll", "acl_id": "viewer", "permission_id": "read"},
        ]
        desired = {
            ("core_hr", "admin", "read"),    # kept
            ("core_hr", "admin", "create"),  # added
            ("leave_management", "editor", "update"),  # added
        }
        with patch(
            "src.policies.utils.grants.list_grants_for_policy",
            new_callable=AsyncMock, return_value=live,
        ), patch(
            "src.policies.utils.grants.insert_grants_bulk",
            new_callable=AsyncMock,
        ) as mock_insert, patch(
            "src.policies.utils.grants.soft_delete_grant",
            new_callable=AsyncMock,
        ) as mock_delete:
            inserts, removes = await grants.replace_policy_grants(
                "pol-1", desired, current_user_id="admin",
            )

        assert inserts == 2
        assert removes == 2

        # Kept grant wasn't re-inserted or deleted.
        inserted_keys = {
            (r["module_id"], r["acl_id"], r["permission_id"])
            for r in mock_insert.call_args.args[0]
        }
        assert ("core_hr", "admin", "read") not in inserted_keys
        deleted_ids = {call.args[0] for call in mock_delete.await_args_list}
        assert deleted_ids == {"d1", "d2"}

    @pytest.mark.asyncio
    async def test_unchanged_grid_is_noop(self):
        """Saving with no changes writes nothing."""
        live = [
            {"id": "g1", "module_id": "core_hr", "acl_id": "admin", "permission_id": "read"},
            {"id": "g2", "module_id": "core_hr", "acl_id": "admin", "permission_id": "create"},
        ]
        desired = {
            ("core_hr", "admin", "read"),
            ("core_hr", "admin", "create"),
        }
        with patch(
            "src.policies.utils.grants.list_grants_for_policy",
            new_callable=AsyncMock, return_value=live,
        ), patch(
            "src.policies.utils.grants.insert_grants_bulk",
            new_callable=AsyncMock,
        ) as mock_insert, patch(
            "src.policies.utils.grants.soft_delete_grant",
            new_callable=AsyncMock,
        ) as mock_delete:
            inserts, removes = await grants.replace_policy_grants(
                "pol-1", desired,
            )

        assert inserts == 0
        assert removes == 0
        mock_insert.assert_not_called()
        mock_delete.assert_not_called()


# ---------------------------------------------------------------------------
# soft_delete_policy — cascade to grants
# ---------------------------------------------------------------------------
class TestSoftDeletePolicy:
    @pytest.mark.asyncio
    async def test_cascade_soft_deletes_grants(self):
        """Deleting a policy soft-deletes all its live grant rows."""
        grant_mock_1 = AsyncMock()
        grant_mock_1.set = AsyncMock()
        grant_mock_2 = AsyncMock()
        grant_mock_2.set = AsyncMock()

        # list_grants_for_policy returns two live rows
        with patch(
            "src.policies.utils.grants.update_policy",
            new_callable=AsyncMock, return_value={"id": "pol-1"},
        ) as mock_update_policy, patch(
            "src.policies.utils.grants.ModuleAclPermissionDocument"
        ) as MAPDoc:
            # Chain: MAPDoc.find(...).to_list() returns [grant_mock_1, grant_mock_2]
            find_chain = MAPDoc.find.return_value
            find_chain.to_list = AsyncMock(return_value=[grant_mock_1, grant_mock_2])

            ok = await grants.soft_delete_policy("pol-1", current_user_id="admin")

        assert ok is True
        mock_update_policy.assert_awaited_once()
        # Both grants got their soft-delete patch applied.
        grant_mock_1.set.assert_awaited_once()
        grant_mock_2.set.assert_awaited_once()
        patch_arg = grant_mock_1.set.call_args.args[0]
        assert patch_arg["deleted_by"] == "admin"
        assert "deleted_on" in patch_arg

    @pytest.mark.asyncio
    async def test_nonexistent_policy_returns_false(self):
        with patch(
            "src.policies.utils.grants.update_policy",
            new_callable=AsyncMock, return_value=None,
        ):
            ok = await grants.soft_delete_policy("missing")

        assert ok is False
