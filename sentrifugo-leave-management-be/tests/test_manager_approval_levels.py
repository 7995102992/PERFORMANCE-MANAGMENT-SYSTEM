"""The manager leave-request surfaces must honour the plan's approval config.

An L2 manager is only part of an employee's approval chain when the request's
leave plan configures a second approval level (``approval_levels`` on
``leave_approval_policies``). Before this, ``/manager/leave-requests`` and
``/manager/leave-requests/pending-approvals`` returned every request from every
L1 *or* L2 reportee regardless of plan, so an L2 saw — and could approve —
requests under single-level plans they were never notified about.

DB pattern: a per-collection stub, since the service takes ``db`` as an arg.
"""

from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId

from src.exceptions import DomainException
from src.manager import service

MANAGER = ObjectId("507f1f77bcf86cd799439012")
EMP_L1 = ObjectId("507f1f77bcf86cd799439021")   # MANAGER is their L1
EMP_L2 = ObjectId("507f1f77bcf86cd799439022")   # MANAGER is only their L2
OTHER_MGR = ObjectId("507f1f77bcf86cd799439099")

PLAN_1LVL = ObjectId("507f1f77bcf86cd7994390a1")
PLAN_2LVL = ObjectId("507f1f77bcf86cd7994390a2")

EMPLOYEES = [
    {"user_id": EMP_L1, "l1_manager_id": MANAGER, "l2_manager_id": OTHER_MGR,
     "department_id": ObjectId("507f1f77bcf86cd7994390d1")},
    {"user_id": EMP_L2, "l1_manager_id": OTHER_MGR, "l2_manager_id": MANAGER,
     "department_id": ObjectId("507f1f77bcf86cd7994390d2")},
]

ORG_ID = "507f1f77bcf86cd799439011"

POLICIES = [
    {"leave_plan_id": PLAN_1LVL, "approval_levels": [{"level": 1}]},
    {"leave_plan_id": PLAN_2LVL, "approval_levels": [{"level": 1}, {"level": 2}]},
]


def _req(user_id, plan_id, rid="r1"):
    return {
        "_id": ObjectId("507f1f77bcf86cd7994390b1"),
        "user_id": user_id,
        "leave_plan_id": plan_id,
        "status": "PENDING",
        "approval_state": {"current_level": 1, "approved_by": []},
        "_label": rid,
    }


class _Coll:
    """Async collection stub. Honours a ``user_id: {"$in": [...]}`` clause so the
    roster restriction is observable — the team surfaces re-query employees and
    requests by the filtered roster, and a stub that ignored it would report the
    dropped employee back into the headcount."""

    def __init__(self, rows, find_one_row=None):
        self._rows = rows
        self._find_one_row = find_one_row

    def find(self, query=None, *args, **kwargs):
        rows = list(self._rows)
        wanted = (query or {}).get("user_id")
        if isinstance(wanted, dict) and "$in" in wanted:
            allowed = {str(v) for v in wanted["$in"]}
            rows = [r for r in rows if str(r.get("user_id")) in allowed]
        cur = MagicMock()
        cur.sort.return_value = cur
        cur.to_list = AsyncMock(return_value=rows)
        return cur

    async def find_one(self, *args, **kwargs):
        return self._find_one_row


def _db(requests):
    colls = {
        "employees": _Coll(EMPLOYEES, find_one_row=None),
        "leave_approval_policies": _Coll(POLICIES),
        service.REQUESTS_COLLECTION: _Coll(requests),
    }
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: colls.get(name, _Coll([]))
    return db


@pytest.fixture(autouse=True)
def _no_enrichment():
    """Display/aging enrichment hits collections this test doesn't model."""
    with patch.object(service, "_enrich_request_display_fields", AsyncMock()), \
         patch.object(service, "enrich_aging", AsyncMock()):
        yield


@pytest.mark.asyncio
async def test_l2_hidden_from_single_level_plan():
    db = _db([_req(EMP_L2, PLAN_1LVL)])
    assert await service.list_managed_leave_requests(db, str(MANAGER)) == []
    assert await service.list_pending_approvals(db, str(MANAGER)) == []


@pytest.mark.asyncio
async def test_l2_sees_two_level_plan():
    db = _db([_req(EMP_L2, PLAN_2LVL)])
    assert len(await service.list_managed_leave_requests(db, str(MANAGER))) == 1
    assert len(await service.list_pending_approvals(db, str(MANAGER))) == 1


@pytest.mark.asyncio
async def test_l1_sees_single_level_plan():
    db = _db([_req(EMP_L1, PLAN_1LVL)])
    assert len(await service.list_managed_leave_requests(db, str(MANAGER))) == 1


@pytest.mark.asyncio
async def test_plan_without_policy_defaults_to_l1_only():
    """Mirrors _get_all_approvers_info, which only emails L2 when the policy
    declares a second level — an unconfigured plan notifies L1 alone."""
    unknown_plan = ObjectId("507f1f77bcf86cd7994390a9")
    db = _db([_req(EMP_L1, unknown_plan), _req(EMP_L2, unknown_plan)])
    docs = await service.list_managed_leave_requests(db, str(MANAGER))
    assert [d["user_id"] for d in docs] == [EMP_L1]


@pytest.mark.asyncio
async def test_l2_cannot_act_on_single_level_plan():
    doc = _req(EMP_L2, PLAN_1LVL)
    db = _db([doc])
    with patch.object(service, "get_leave_request", AsyncMock(return_value=doc)):
        with pytest.raises(DomainException) as exc:
            await service._assert_manager_access(db, "r1", str(MANAGER), capability="act")
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_l2_can_act_on_two_level_plan():
    doc = _req(EMP_L2, PLAN_2LVL)
    db = _db([doc])
    with patch.object(service, "get_leave_request", AsyncMock(return_value=doc)):
        assert await service._assert_manager_access(
            db, "r1", str(MANAGER), capability="act"
        ) is doc


# ─── Team surfaces: the roster follows the same rule ──────────────────────────
#
# Hiding an L2-only reportee's leave while leaving them on the roster would make
# get_team_availability report them as AVAILABLE on a day they are out, so they
# drop off the roster entirely when their plan configures a single level.


@pytest.fixture
def _no_iam():
    """IAM employment statuses and the deactivated-user check are network /
    collection reads this test doesn't model."""
    with patch.object(service, "fetch_employment_statuses", AsyncMock(return_value={})),          patch.object(service, "deactivated_user_ids", AsyncMock(return_value=set())):
        yield


def _patch_plan_resolution(plan_id):
    return patch.object(
        service,
        "resolve_employee_plan",
        AsyncMock(return_value={"leave_plan_id": plan_id} if plan_id else None),
    )


@pytest.mark.asyncio
async def test_roster_drops_l2_only_on_single_level_plan(_no_iam):
    db = _db([])
    with _patch_plan_resolution(PLAN_1LVL):
        ids, levels = await service._active_managed_roster(
            db, str(MANAGER), org_id=ORG_ID
        )
    assert ids == [EMP_L1]
    assert levels[str(EMP_L2)] == {2}


@pytest.mark.asyncio
async def test_roster_keeps_l2_only_on_two_level_plan(_no_iam):
    db = _db([])
    with _patch_plan_resolution(PLAN_2LVL):
        ids, _ = await service._active_managed_roster(
            db, str(MANAGER), org_id=ORG_ID
        )
    assert sorted(map(str, ids)) == sorted([str(EMP_L1), str(EMP_L2)])


@pytest.mark.asyncio
async def test_roster_drops_l2_only_when_plan_unresolvable(_no_iam):
    """No resolvable plan counts as single-level, matching _plan_max_levels."""
    db = _db([])
    with _patch_plan_resolution(None):
        ids, _ = await service._active_managed_roster(
            db, str(MANAGER), org_id=ORG_ID
        )
    assert ids == [EMP_L1]


@pytest.mark.asyncio
async def test_availability_excludes_l2_only_from_headcount(_no_iam):
    """total_team_size must not count someone whose leave is hidden — otherwise
    available_count reports them at work on a day they are on leave."""
    db = _db([])
    with _patch_plan_resolution(PLAN_1LVL):
        result = await service.get_team_availability(
            db, str(MANAGER), date(2026, 8, 20), date(2026, 8, 20), org_id=ORG_ID
        )
    assert result["total_team_size"] == 1
    assert [m["user_id"] for m in result["team_members"]] == [str(EMP_L1)]


@pytest.mark.asyncio
async def test_roster_without_org_id_drops_l2_only(_no_iam):
    """Plan resolution is org-scoped; with no org we cannot show the plan routes
    to L2, so the unconfigured-plan default applies."""
    db = _db([])
    ids, _ = await service._active_managed_roster(db, str(MANAGER), org_id=None)
    assert ids == [EMP_L1]
