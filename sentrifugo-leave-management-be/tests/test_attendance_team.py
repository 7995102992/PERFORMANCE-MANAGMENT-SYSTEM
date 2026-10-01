"""Tests for the manager team-attendance surface.

Covers the two things that broke before it existed:
  - the permission gate — a manager needs the dedicated `manager_attendance`
    permission, NOT `approve_as_hr` (the HR daily view's gate);
  - the roster-first shaping in ``get_team_day`` — every L1 reportee gets a row,
    punches left-join, and a no-punch day falls back to leave (if approved) or
    Absent.

Auth pattern: get_current_user is overridden via dependency_overrides.
DB pattern: the service reads the global get_db(), so it is patched per test.
"""

from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId

from src.attendance import service
from src.dependencies import (
    LeaveManagementActions,
    LeaveModulePermission,
    UserBase,
    UserPermissions,
    get_current_user,
)
from src.main import app

ORG_ID = "507f1f77bcf86cd799439011"
MANAGER_ID = "507f1f77bcf86cd799439012"
R1 = ObjectId("507f1f77bcf86cd799439021")  # reportee with punches
R2 = ObjectId("507f1f77bcf86cd799439022")  # reportee on approved leave


def _user_with_manager_attendance(flag: bool) -> UserBase:
    return UserBase(
        user_id=MANAGER_ID,
        org_id=ORG_ID,
        is_super_admin=False,
        is_org_admin=False,
        permissions=UserPermissions(
            leave_management=LeaveModulePermission(
                actions=LeaveManagementActions(manager_attendance=flag)
            )
        ),
    )


class _Coll:
    """Minimal async collection stub dispatching find / find_one / aggregate."""

    def __init__(self, *, find_rows=None, find_one_row=None, aggregate_rows=None):
        self._find_rows = find_rows or []
        self._find_one_row = find_one_row
        self._aggregate_rows = aggregate_rows or []

    def find(self, *args, **kwargs):
        cur = MagicMock()
        cur.sort.return_value = cur
        cur.to_list = AsyncMock(return_value=self._find_rows)
        return cur

    async def find_one(self, *args, **kwargs):
        return self._find_one_row

    def aggregate(self, *args, **kwargs):
        cur = MagicMock()
        cur.to_list = AsyncMock(return_value=self._aggregate_rows)
        return cur


def _fake_db(collections: dict) -> MagicMock:
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: collections[name]
    return db


@pytest.mark.asyncio
async def test_team_daily_requires_manager_attendance_permission(client):
    """Without the manager_attendance permission the route is 403 — a manager
    who only lacks approve_as_hr must not be locked out by the wrong gate, and
    someone with neither must not get in."""
    app.dependency_overrides[get_current_user] = lambda: _user_with_manager_attendance(False)
    resp = await client.get("/attendance/team/daily", params={"punch_date": "2026-08-05"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_team_daily_returns_roster_when_permitted(client):
    """With the permission the route returns whatever the service produces."""
    app.dependency_overrides[get_current_user] = lambda: _user_with_manager_attendance(True)
    canned = [
        {
            "employee_user_id": str(R1),
            "terminal_user_id": "T1",
            "user_name": "Alice",
            "punch_date": "2026-08-05",
            "status": "full",
            "punches": [],
        }
    ]
    with patch.object(service, "get_team_day", new=AsyncMock(return_value=canned)):
        resp = await client.get("/attendance/team/daily", params={"punch_date": "2026-08-05"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["user_name"] == "Alice"
    assert body[0]["status"] == "full"


@pytest.mark.asyncio
async def test_get_team_day_roster_first_with_leave_and_absent():
    """R1 punched a full day, R2 is on approved leave — both appear, plus the
    roster defaults an unpunched-unleaved reportee to Absent (no-time)."""
    day = date(2026, 8, 5)
    punch_dt = datetime.combine(day, datetime.min.time())

    employees = _Coll(
        # find_one in _manager_refs → manager not found as employee, refs=[user_id]
        find_one_row=None,
        # find in _get_l1_reportee_ids AND _reportee_name_map — one row set that
        # satisfies both (carries user_id and name fields).
        find_rows=[
            {"user_id": R1, "first_name": "Alice", "last_name": "Anders"},
            {"user_id": R2, "first_name": "Bob", "last_name": "Brown"},
        ],
    )
    users = _Coll(find_rows=[])  # no users-collection override; fall back to emp names
    leave_requests = _Coll(
        aggregate_rows=[{"user_id": R2, "leave_type_name": "Earned Leave"}]
    )
    punches = _Coll(
        find_rows=[
            {
                "employee_user_id": str(R1),
                "terminal_user_id": "T1",
                "user_name": "Alice Anders",
                "group_name": "Eng",
                "punch_type": "in",
                "event_time": punch_dt.replace(hour=9),
            },
            {
                "employee_user_id": str(R1),
                "terminal_user_id": "T1",
                "user_name": "Alice Anders",
                "group_name": "Eng",
                "punch_type": "out",
                "event_time": punch_dt.replace(hour=18),
            },
        ]
    )
    fake = _fake_db(
        {
            "employees": employees,
            "users": users,
            "leave_requests": leave_requests,
            "attendance_punches": punches,
            # No employment_status flagged inactive → active-filter is a no-op.
            "employment_statuses": _Coll(find_rows=[]),
        }
    )

    with patch.object(service, "get_db", return_value=fake):
        rows = await service.get_team_day(ORG_ID, MANAGER_ID, day)

    by_uid = {r.employee_user_id: r for r in rows}
    assert set(by_uid) == {str(R1), str(R2)}
    assert by_uid[str(R1)].status == "full"
    assert by_uid[str(R1)].terminal_user_id == "T1"
    assert by_uid[str(R2)].status == "leave"
    assert by_uid[str(R2)].leave_type_name == "Earned Leave"


@pytest.mark.asyncio
async def test_get_team_day_empty_when_no_reportees():
    employees = _Coll(find_one_row=None, find_rows=[])
    fake = _fake_db(
        {"employees": employees, "employment_statuses": _Coll(find_rows=[])}
    )
    with patch.object(service, "get_db", return_value=fake):
        rows = await service.get_team_day(ORG_ID, MANAGER_ID, date(2026, 8, 5))
    assert rows == []
