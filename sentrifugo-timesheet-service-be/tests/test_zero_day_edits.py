"""Post-submission edits are confined to the days that logged no hours.

A day already carrying hours has gone to the approver and must reach them
unchanged. Days sitting at zero stay open — the employee can fill them against any
project and task they are assigned to — and the pending approvers are told the week
changed, each hearing only about their own projects.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import OnlyZeroHourDaysEditable
from src.models import TimesheetStatusEnum
from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate

from .conftest import make_query_mock, make_timesheet

_P1 = "507f1f77bcf86cd799439011"
_P2 = "507f1f77bcf86cd799439012"
_T1 = "507f1f77bcf86cd7994390a1"
_T2 = "507f1f77bcf86cd7994390a2"

_MON = "2026-08-17"   # worked, 8h
_TUE = "2026-08-18"   # left at zero


def stored(project_id=_P1, task_id=_T1, day=_MON, hours=8.0):
    entry = MagicMock()
    entry.project_id = PydanticObjectId(project_id)
    entry.task_id = PydanticObjectId(task_id)
    entry.entry_date = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    entry.hours = hours
    return entry


def payload(*rows):
    return TimesheetEntryBulkSave(entries=[
        TimesheetEntryCreate(project_id=p, task_id=t, entry_date=d, hours=h)
        for p, t, d, h in rows
    ])


def submitted_ts():
    return make_timesheet(timesheet_status=TimesheetStatusEnum.SUBMITTED)


async def check(existing, body, doc=None):
    from src.timesheets import service

    with patch("src.timesheets.service.TimesheetEntry.find",
               MagicMock(return_value=make_query_mock(existing))):
        await service._assert_only_zero_hour_days_change(doc or submitted_ts(), body)


class TestZeroDayEditsOnly:
    @pytest.mark.asyncio
    async def test_filling_a_zero_day_is_allowed(self):
        await check(
            [stored(day=_MON, hours=8.0), stored(day=_TUE, hours=0.0)],
            payload((_P1, _T1, _MON, 8.0), (_P1, _T1, _TUE, 8.0)),
        )

    @pytest.mark.asyncio
    async def test_a_zero_day_may_use_a_different_project_and_task(self):
        """The employee picks whatever they are assigned to for the open day."""
        await check(
            [stored(day=_MON, hours=8.0), stored(day=_TUE, hours=0.0)],
            payload((_P1, _T1, _MON, 8.0), (_P2, _T2, _TUE, 6.0)),
        )

    @pytest.mark.asyncio
    async def test_changing_a_worked_day_is_rejected(self):
        with pytest.raises(OnlyZeroHourDaysEditable) as exc:
            await check(
                [stored(day=_MON, hours=8.0)],
                payload((_P1, _T1, _MON, 9.0)),
            )

        assert exc.value.code == "TSM-036"
        assert _MON in exc.value.message

    @pytest.mark.asyncio
    async def test_dropping_a_worked_day_is_rejected(self):
        with pytest.raises(OnlyZeroHourDaysEditable):
            await check([stored(day=_MON, hours=8.0)], payload())

    @pytest.mark.asyncio
    async def test_adding_a_row_to_a_worked_day_is_rejected(self):
        with pytest.raises(OnlyZeroHourDaysEditable):
            await check(
                [stored(day=_MON, hours=8.0)],
                payload((_P1, _T1, _MON, 8.0), (_P2, _T2, _MON, 2.0)),
            )

    @pytest.mark.asyncio
    async def test_draft_is_unrestricted(self):
        await check(
            [stored(day=_MON, hours=8.0)],
            payload((_P1, _T1, _MON, 2.0)),
            doc=make_timesheet(timesheet_status=TimesheetStatusEnum.DRAFT),
        )

    @pytest.mark.asyncio
    async def test_an_all_zero_week_is_fully_open(self):
        await check(
            [stored(day=_MON, hours=0.0), stored(day=_TUE, hours=0.0)],
            payload((_P2, _T2, _MON, 8.0), (_P2, _T2, _TUE, 8.0)),
        )


class TestUpdateNotification:
    @pytest.mark.asyncio
    async def test_each_manager_hears_only_about_their_own_projects(self):
        from src.notifications import service

        doc = make_timesheet()
        doc.id = "ts1"
        by_manager = {"mgr_a": {_P1}, "mgr_b": {_P2}}
        sent: list[tuple] = []

        async def capture(**kwargs):
            sent.append((kwargs["to"], kwargs["project_names"]))

        with patch("src.notifications.service._get_timesheet_project_ids",
                   AsyncMock(return_value=[_P1, _P2])), \
             patch("src.notifications.service._managers_by_project",
                   AsyncMock(return_value=by_manager)), \
             patch("src.notifications.service._notifiable",
                   AsyncMock(side_effect=lambda ids, _org: list(ids))), \
             patch("src.notifications.service.resolve_user_emails",
                   AsyncMock(return_value={"mgr_a": "a@x.com", "mgr_b": "b@x.com"})), \
             patch("src.notifications.service._get_project_names_str",
                   AsyncMock(side_effect=lambda pids: f"names:{','.join(pids)}")), \
             patch("src.notifications.service.publish_timesheet_updated_email", capture):
            await service.notify_timesheet_updated(doc, "Preethi Sundaram")

        assert ("a@x.com", f"names:{_P1}") in sent
        assert ("b@x.com", f"names:{_P2}") in sent

    @pytest.mark.asyncio
    async def test_no_managers_means_no_mail(self):
        from src.notifications import service

        publish = AsyncMock()
        with patch("src.notifications.service._get_timesheet_project_ids",
                   AsyncMock(return_value=[_P1])), \
             patch("src.notifications.service._managers_by_project", AsyncMock(return_value={})), \
             patch("src.notifications.service.publish_timesheet_updated_email", publish):
            await service.notify_timesheet_updated(make_timesheet(), "Preethi")

        publish.assert_not_awaited()
