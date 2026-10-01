"""Tests for the leave-type deletion guard.

A leave type that a leave plan is built on must not silently disappear:

  * assigned to an ACTIVE plan            -> deletion refused
  * assigned only to not-yet-active plans -> deletion allowed after the caller
    confirms, and the type is detached from those plans
  * assigned nowhere                      -> deletion proceeds

``GET /leave-types/{id}/usage`` reports which of the three applies so the UI can
disable the action or raise a confirmation dialog; ``DELETE`` re-enforces it.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId
from httpx import AsyncClient

from src.exceptions import DomainException
from src.leave_types.service import delete_leave_type, get_leave_type_usage

ORG_ID = "507f1f77bcf86cd799439011"
USER_ID = "507f1f77bcf86cd799439012"
TYPE_ID = "507f1f77bcf86cd799439014"
ACTIVE_PLAN_ID = "507f1f77bcf86cd799439031"
DRAFT_PLAN_ID = "507f1f77bcf86cd799439032"


def _cursor(rows):
    cur = MagicMock()
    cur.sort.return_value = cur
    cur.to_list = AsyncMock(return_value=rows)
    return cur


def _leave_type_doc() -> dict:
    return {
        "_id": ObjectId(TYPE_ID),
        "org_id": ObjectId(ORG_ID),
        "name": "Study Leave",
        "code": "STL",
        "is_custom": True,
        "deleted_on": None,
        "created_on": datetime(2025, 1, 1, tzinfo=timezone.utc),
    }


def _plan_doc(plan_id: str, name: str, active: bool) -> dict:
    return {
        "_id": ObjectId(plan_id),
        "name": name,
        "status": "active" if active else "pending_configuration",
        "is_active": active,
    }


def _db(*, plans=None, mappings=None, request_count=0):
    """A db mock wired for the four collections the guard reads."""
    types = MagicMock()
    types.find_one = AsyncMock(return_value=_leave_type_doc())
    types.update_one = AsyncMock()

    plans_coll = MagicMock()
    plans_coll.find = MagicMock(return_value=_cursor(plans or []))
    plans_coll.update_many = AsyncMock()

    mapping_coll = MagicMock()
    mapping_coll.find = MagicMock(return_value=_cursor(mappings or []))
    mapping_coll.delete_many = AsyncMock()

    requests_coll = MagicMock()
    requests_coll.count_documents = AsyncMock(return_value=request_count)

    collections = {
        "leave_types": types,
        "leave_plans": plans_coll,
        "leave_plan_type_mapping": mapping_coll,
        "leave_requests": requests_coll,
    }
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: collections[name]
    return db, collections


class TestLeaveTypeUsage:
    @pytest.mark.asyncio
    async def test_unassigned_type_is_free_to_delete(self):
        db, _ = _db()

        usage = await get_leave_type_usage(db, TYPE_ID, ORG_ID)

        assert usage["in_use"] is False
        assert usage["can_delete"] is True
        assert usage["requires_confirmation"] is False
        assert usage["active_plans"] == []
        assert usage["inactive_plans"] == []

    @pytest.mark.asyncio
    async def test_active_plan_blocks_deletion(self):
        db, _ = _db(plans=[_plan_doc(ACTIVE_PLAN_ID, "Corporate Plan", active=True)])

        usage = await get_leave_type_usage(db, TYPE_ID, ORG_ID)

        assert usage["in_use"] is True
        assert usage["can_delete"] is False
        assert usage["requires_confirmation"] is False
        assert usage["active_plans"][0]["name"] == "Corporate Plan"
        assert "Corporate Plan" in usage["message"]

    @pytest.mark.asyncio
    async def test_inactive_plan_only_asks_for_confirmation(self):
        db, _ = _db(plans=[_plan_doc(DRAFT_PLAN_ID, "Interns Plan", active=False)])

        usage = await get_leave_type_usage(db, TYPE_ID, ORG_ID)

        assert usage["can_delete"] is True
        assert usage["requires_confirmation"] is True
        assert usage["inactive_plans"][0]["id"] == DRAFT_PLAN_ID
        assert "Interns Plan" in usage["message"]

    @pytest.mark.asyncio
    async def test_plans_linked_only_via_mapping_collection_are_found(self):
        """Plans reference types two ways — both must be consulted."""
        db, colls = _db(
            plans=[_plan_doc(ACTIVE_PLAN_ID, "Corporate Plan", active=True)],
            mappings=[{"leave_plan_id": ObjectId(ACTIVE_PLAN_ID)}],
        )

        await get_leave_type_usage(db, TYPE_ID, ORG_ID)

        query = colls["leave_plans"].find.call_args.args[0]
        or_clauses = query["$or"]
        assert {"leave_type_ids": ObjectId(TYPE_ID)} in or_clauses
        assert {"_id": {"$in": [ObjectId(ACTIVE_PLAN_ID)]}} in or_clauses
        assert query["deleted_on"] is None


class TestDeleteLeaveType:
    @pytest.mark.asyncio
    async def test_refuses_when_an_active_plan_uses_the_type(self):
        db, colls = _db(plans=[_plan_doc(ACTIVE_PLAN_ID, "Corporate Plan", active=True)])

        with patch("src.leave_types.service.emit_audit", new_callable=AsyncMock):
            with pytest.raises(DomainException) as exc:
                await delete_leave_type(db, TYPE_ID, USER_ID, ORG_ID, confirm=True)

        assert exc.value.code == "LEAVE_TYPE_IN_USE_BY_ACTIVE_PLAN"
        assert exc.value.status_code == 409
        colls["leave_types"].update_one.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_requires_confirmation_when_assigned_to_an_inactive_plan(self):
        db, colls = _db(plans=[_plan_doc(DRAFT_PLAN_ID, "Interns Plan", active=False)])

        with patch("src.leave_types.service.emit_audit", new_callable=AsyncMock):
            with pytest.raises(DomainException) as exc:
                await delete_leave_type(db, TYPE_ID, USER_ID, ORG_ID)

        assert exc.value.code == "LEAVE_TYPE_DELETE_CONFIRMATION_REQUIRED"
        assert "Interns Plan" in exc.value.message
        colls["leave_types"].update_one.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_confirmed_delete_detaches_from_inactive_plans(self):
        db, colls = _db(plans=[_plan_doc(DRAFT_PLAN_ID, "Interns Plan", active=False)])

        with patch("src.leave_types.service.emit_audit", new_callable=AsyncMock):
            await delete_leave_type(db, TYPE_ID, USER_ID, ORG_ID, confirm=True)

        flt, update = colls["leave_plans"].update_many.await_args.args[:2]
        assert flt == {"_id": {"$in": [ObjectId(DRAFT_PLAN_ID)]}}
        assert update["$pull"] == {"leave_type_ids": ObjectId(TYPE_ID)}
        colls["leave_plan_type_mapping"].delete_many.assert_awaited_once()

        soft_delete = colls["leave_types"].update_one.await_args.args[1]["$set"]
        assert soft_delete["deleted_on"] is not None

    @pytest.mark.asyncio
    async def test_unassigned_delete_needs_no_confirmation(self):
        db, colls = _db()

        with patch("src.leave_types.service.emit_audit", new_callable=AsyncMock):
            await delete_leave_type(db, TYPE_ID, USER_ID, ORG_ID)

        colls["leave_plans"].update_many.assert_not_awaited()
        colls["leave_types"].update_one.assert_awaited_once()


class TestLeaveTypeUsageEndpoint:
    @pytest.mark.asyncio
    async def test_usage_endpoint_returns_the_verdict(self, client: AsyncClient):
        usage = {
            "leave_type_id": TYPE_ID,
            "name": "Study Leave",
            "code": "STL",
            "in_use": True,
            "can_delete": False,
            "requires_confirmation": False,
            "message": "'Study Leave' is assigned to the active leave plan(s): Corporate Plan.",
            "active_plans": [
                {"id": ACTIVE_PLAN_ID, "name": "Corporate Plan", "status": "active", "is_active": True}
            ],
            "inactive_plans": [],
            "leave_request_count": 3,
        }
        with patch("src.leave_types.router.get_leave_type_usage", new_callable=AsyncMock, return_value=usage):
            resp = await client.get(f"/leave-types/{TYPE_ID}/usage")

        assert resp.status_code == 200
        body = resp.json()
        assert body["can_delete"] is False
        assert body["active_plans"][0]["name"] == "Corporate Plan"
        assert body["leave_request_count"] == 3

    @pytest.mark.asyncio
    async def test_delete_forwards_the_confirm_flag(self, client: AsyncClient):
        with patch("src.leave_types.router.delete_leave_type", new_callable=AsyncMock) as mock_delete:
            resp = await client.delete(f"/leave-types/{TYPE_ID}?confirm=true")

        assert resp.status_code == 204
        assert mock_delete.await_args.kwargs["confirm"] is True

    @pytest.mark.asyncio
    async def test_delete_defaults_to_unconfirmed(self, client: AsyncClient):
        with patch("src.leave_types.router.delete_leave_type", new_callable=AsyncMock) as mock_delete:
            resp = await client.delete(f"/leave-types/{TYPE_ID}")

        assert resp.status_code == 204
        assert mock_delete.await_args.kwargs["confirm"] is False
