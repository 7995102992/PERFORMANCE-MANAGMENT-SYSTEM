"""Tests for the plan wizard's leave-type removal guard.

Step 2 picks a plan's leave types; later steps point at one of them by id
(probation funds a single type, clubbing restricts a list). Those pointers were
validated when the later step was saved but never re-checked when step 2 changed
afterwards, so going back and unselecting a type left the plan configured
against a type it no longer had.

Removal now refuses while a later step still points at the type — the user has to
repoint that step first — and the type list of an active plan is frozen on both
removal paths (bulk save and single delete).
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId
from httpx import AsyncClient

from src.exceptions import DomainException
from src.leave_plans.schemas import LeavePlanLeaveTypesPayload
from src.leave_plans.service import check_leave_type_removable, set_leave_types_on_plan
from src.leave_plan_type_mapping.service import remove_leave_type_from_plan

ORG_ID = "507f1f77bcf86cd799439011"
USER_ID = "507f1f77bcf86cd799439012"
PLAN_ID = "507f1f77bcf86cd799439013"
PROBATION_TYPE_ID = "507f1f77bcf86cd799439014"
OTHER_TYPE_ID = "507f1f77bcf86cd799439015"


def _cursor(rows):
    cur = MagicMock()
    cur.sort.return_value = cur
    cur.to_list = AsyncMock(return_value=rows)
    return cur


def _plan_doc(*, status="pending_configuration", leave_type_ids=None) -> dict:
    return {
        "_id": ObjectId(PLAN_ID),
        "org_id": ObjectId(ORG_ID),
        "name": "Corporate Plan",
        "status": status,
        "is_active": status == "active",
        "calendar_start_month": 1,
        "leave_type_ids": [ObjectId(i) for i in (leave_type_ids or [])],
        "business_unit_ids": [],
        "department_ids": [],
        "created_on": datetime(2025, 1, 1, tzinfo=timezone.utc),
    }


def _entitlement_doc(*, probation_type_id=None, restricted_ids=None) -> dict:
    return {
        "_id": ObjectId(),
        "leave_plan_id": ObjectId(PLAN_ID),
        "entitlement": {
            "probation": {
                "enabled": True,
                "probation_leave_type_id": probation_type_id,
            },
            "clubbing": {
                "restricted_leave_type_ids": [ObjectId(i) for i in (restricted_ids or [])],
            },
        },
    }


def _db(*, plan=None, entitlement=None, mappings=None):
    plans = MagicMock()
    plans.find_one = AsyncMock(return_value=plan if plan is not None else _plan_doc())
    plans.update_one = AsyncMock(return_value=MagicMock(modified_count=1))

    mapping = MagicMock()
    mapping.find = MagicMock(return_value=_cursor(mappings or []))
    mapping.find_one = AsyncMock(return_value=None)
    mapping.delete_one = AsyncMock(return_value=MagicMock(deleted_count=0))
    mapping.delete_many = AsyncMock()

    entitlements = MagicMock()
    entitlements.find_one = AsyncMock(return_value=entitlement)

    types = MagicMock()
    # Every id the caller passes exists, so the validity check always clears.
    types.count_documents = AsyncMock(
        side_effect=lambda flt, **kw: len(flt["_id"]["$in"])
    )
    types.find = MagicMock(return_value=_cursor([
        {"_id": ObjectId(PROBATION_TYPE_ID), "name": "Casual Leave"},
        {"_id": ObjectId(OTHER_TYPE_ID), "name": "Sick Leave"},
    ]))

    collections = {
        "leave_plans": plans,
        "leave_plan_type_mapping": mapping,
        "leave_entitlement_configurations": entitlements,
        "leave_types": types,
    }
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: collections[name]
    return db, collections


class TestBulkSaveRemoval:
    """POST /leave-plans/{id}/leave-types — the step 2 'Save' path."""

    @pytest.mark.asyncio
    async def test_removing_the_probation_type_is_refused(self):
        db, colls = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID, OTHER_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )
        payload = LeavePlanLeaveTypesPayload(leave_type_ids=[OTHER_TYPE_ID])

        with patch("src.leave_plans.service.emit_audit", new_callable=AsyncMock):
            with pytest.raises(DomainException) as exc:
                await set_leave_types_on_plan(db, PLAN_ID, payload, USER_ID)

        assert exc.value.code == "LEAVE_TYPE_USED_IN_PLAN_CONFIG"
        assert exc.value.status_code == 409
        assert "Casual Leave" in exc.value.message
        assert "probation" in exc.value.message
        colls["leave_plans"].update_one.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_keeping_the_probation_type_still_saves(self):
        db, colls = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )
        payload = LeavePlanLeaveTypesPayload(
            leave_type_ids=[PROBATION_TYPE_ID, OTHER_TYPE_ID]
        )

        with patch("src.leave_plans.service.emit_audit", new_callable=AsyncMock):
            await set_leave_types_on_plan(db, PLAN_ID, payload, USER_ID)

        colls["leave_plans"].update_one.assert_awaited()

    @pytest.mark.asyncio
    async def test_removing_an_unreferenced_type_also_clears_its_mapping_row(self):
        db, colls = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID, OTHER_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )
        payload = LeavePlanLeaveTypesPayload(leave_type_ids=[PROBATION_TYPE_ID])

        with patch("src.leave_plans.service.emit_audit", new_callable=AsyncMock):
            await set_leave_types_on_plan(db, PLAN_ID, payload, USER_ID)

        flt = colls["leave_plan_type_mapping"].delete_many.await_args.args[0]
        assert flt["leave_type_id"] == {"$in": [ObjectId(OTHER_TYPE_ID)]}

    @pytest.mark.asyncio
    async def test_clubbing_restriction_also_blocks_removal(self):
        db, _ = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID, OTHER_TYPE_ID]),
            entitlement=_entitlement_doc(restricted_ids=[OTHER_TYPE_ID]),
        )
        payload = LeavePlanLeaveTypesPayload(leave_type_ids=[PROBATION_TYPE_ID])

        with pytest.raises(DomainException) as exc:
            await set_leave_types_on_plan(db, PLAN_ID, payload, USER_ID)

        assert exc.value.code == "LEAVE_TYPE_USED_IN_PLAN_CONFIG"
        assert "Sick Leave" in exc.value.message

    @pytest.mark.asyncio
    async def test_a_type_attached_only_via_a_mapping_row_counts_as_removed(self):
        db, _ = _db(
            plan=_plan_doc(leave_type_ids=[]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
            mappings=[{"leave_type_id": ObjectId(PROBATION_TYPE_ID)}],
        )
        payload = LeavePlanLeaveTypesPayload(leave_type_ids=[OTHER_TYPE_ID])

        with pytest.raises(DomainException) as exc:
            await set_leave_types_on_plan(db, PLAN_ID, payload, USER_ID)

        assert exc.value.code == "LEAVE_TYPE_USED_IN_PLAN_CONFIG"


class TestSingleRemoval:
    """DELETE /leave-plans/{id}/leave-types/{type_id} — previously unguarded."""

    @pytest.mark.asyncio
    async def test_active_plan_freezes_the_type_list(self):
        db, colls = _db(
            plan=_plan_doc(status="active", leave_type_ids=[OTHER_TYPE_ID]),
            entitlement=None,
        )

        with pytest.raises(DomainException) as exc:
            await remove_leave_type_from_plan(db, PLAN_ID, OTHER_TYPE_ID, ORG_ID)

        assert exc.value.code == "LEAVE_PLAN_ALREADY_ACTIVE"
        colls["leave_plan_type_mapping"].delete_one.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_probation_dependency_blocks_the_single_delete(self):
        db, colls = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )

        with pytest.raises(DomainException) as exc:
            await remove_leave_type_from_plan(db, PLAN_ID, PROBATION_TYPE_ID, ORG_ID)

        assert exc.value.code == "LEAVE_TYPE_USED_IN_PLAN_CONFIG"
        colls["leave_plan_type_mapping"].delete_one.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_type_attached_via_the_plan_document_is_detached_not_404(self):
        """No mapping row exists — the id lives on the plan doc. Pull it there."""
        db, colls = _db(
            plan=_plan_doc(leave_type_ids=[OTHER_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )

        with patch("src.leave_plan_type_mapping.service.emit_audit", new_callable=AsyncMock):
            await remove_leave_type_from_plan(db, PLAN_ID, OTHER_TYPE_ID, ORG_ID)

        flt, update = colls["leave_plans"].update_one.await_args.args[:2]
        assert flt == {"_id": ObjectId(PLAN_ID)}
        assert update["$pull"] == {"leave_type_ids": ObjectId(OTHER_TYPE_ID)}

    @pytest.mark.asyncio
    async def test_unknown_type_still_404s(self):
        db, colls = _db(plan=_plan_doc(leave_type_ids=[]), entitlement=None)
        colls["leave_plans"].update_one = AsyncMock(return_value=MagicMock(modified_count=0))

        with pytest.raises(DomainException) as exc:
            await remove_leave_type_from_plan(db, PLAN_ID, OTHER_TYPE_ID, ORG_ID)

        assert exc.value.code == "PLAN_TYPE_MAPPING_NOT_FOUND"


class TestRemovalCheck:
    @pytest.mark.asyncio
    async def test_reports_the_blocking_setting(self):
        db, _ = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )

        result = await check_leave_type_removable(db, PLAN_ID, PROBATION_TYPE_ID)

        assert result["can_remove"] is False
        assert result["plan_is_active"] is False
        assert result["used_by"] == ["probation settings (probation leave type)"]
        assert "Casual Leave" in result["message"]

    @pytest.mark.asyncio
    async def test_reports_removable(self):
        db, _ = _db(
            plan=_plan_doc(leave_type_ids=[PROBATION_TYPE_ID, OTHER_TYPE_ID]),
            entitlement=_entitlement_doc(probation_type_id=PROBATION_TYPE_ID),
        )

        result = await check_leave_type_removable(db, PLAN_ID, OTHER_TYPE_ID)

        assert result["can_remove"] is True
        assert result["used_by"] == []

    @pytest.mark.asyncio
    async def test_active_plan_reports_not_removable(self):
        db, _ = _db(plan=_plan_doc(status="active", leave_type_ids=[OTHER_TYPE_ID]))

        result = await check_leave_type_removable(db, PLAN_ID, OTHER_TYPE_ID)

        assert result["can_remove"] is False
        assert result["plan_is_active"] is True
        assert "active" in result["message"]

    @pytest.mark.asyncio
    async def test_removal_check_endpoint(self, client: AsyncClient):
        payload = {
            "leave_plan_id": PLAN_ID,
            "leave_type_id": PROBATION_TYPE_ID,
            "name": "Casual Leave",
            "can_remove": False,
            "plan_is_active": False,
            "used_by": ["probation settings (probation leave type)"],
            "message": "'Casual Leave' is used by this plan's probation settings.",
        }
        with patch(
            "src.leave_plan_type_mapping.router.check_leave_type_removable",
            new_callable=AsyncMock,
            return_value=payload,
        ):
            resp = await client.get(
                f"/leave-plans/{PLAN_ID}/leave-types/{PROBATION_TYPE_ID}/removal-check"
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_remove"] is False
        assert body["used_by"] == ["probation settings (probation leave type)"]
