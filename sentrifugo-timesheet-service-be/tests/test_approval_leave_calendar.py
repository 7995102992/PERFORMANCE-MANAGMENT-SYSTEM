"""Leave and holiday data on the approver's timesheet detail.

An approver needs to tell an empty day the employee should have worked from one
they were on leave or that was a public holiday. LMS owns both, and the view has
to render whether or not LMS answers.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.rabbitmq.lms_rpc import LMSUnavailable

_USER = "507f1f77bcf86cd799439011"
_LEAVES = [{"date": "2026-08-19", "type": "casual", "duration": "full_day"}]
_HOLIDAYS = [{"date": "2026-08-21", "name": "Independence Day"}]


class TestFetchLeaveCalendar:
    @pytest.mark.asyncio
    async def test_returns_leaves_and_holidays_for_the_employee(self):
        from src.approvals import service

        payload = {"data": {_USER: {"leaves": _LEAVES, "holidays": _HOLIDAYS}}}
        rpc = AsyncMock(return_value=payload)
        with patch("src.approvals.service.get_employee_leave_calendar", rpc):
            leaves, holidays = await service._fetch_leave_calendar(
                _USER, "2026-08-17", "2026-08-23",
            )

        assert leaves == _LEAVES
        assert holidays == _HOLIDAYS
        assert rpc.call_args.args == ([_USER], "2026-08-17", "2026-08-23")

    @pytest.mark.asyncio
    async def test_empty_when_the_employee_is_absent_from_the_reply(self):
        from src.approvals import service

        with patch("src.approvals.service.get_employee_leave_calendar",
                   AsyncMock(return_value={"data": {}})):
            assert await service._fetch_leave_calendar(_USER, "a", "b") == ([], [])

    @pytest.mark.asyncio
    async def test_degrades_when_lms_is_unavailable(self):
        from src.approvals import service

        with patch("src.approvals.service.get_employee_leave_calendar",
                   AsyncMock(side_effect=LMSUnavailable("down"))):
            assert await service._fetch_leave_calendar(_USER, "a", "b") == ([], [])

    @pytest.mark.asyncio
    async def test_a_hanging_rpc_does_not_hang_the_request(self):
        """The RPC declares no timeout of its own — the caller bounds it."""
        from src.approvals import service

        async def never_answers(*_a, **_k):
            await asyncio.sleep(3600)

        with patch("src.approvals.service.get_employee_leave_calendar", never_answers), \
             patch("src.approvals.service._LEAVE_RPC_TIMEOUT", 0.01):
            assert await service._fetch_leave_calendar(_USER, "a", "b") == ([], [])

    @pytest.mark.asyncio
    async def test_missing_keys_default_to_empty_lists(self):
        from src.approvals import service

        with patch("src.approvals.service.get_employee_leave_calendar",
                   AsyncMock(return_value={"data": {_USER: {}}})):
            assert await service._fetch_leave_calendar(_USER, "a", "b") == ([], [])
