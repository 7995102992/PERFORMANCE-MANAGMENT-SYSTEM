"""Removing a resource from a project, effective on a date.

A removal closes the allocation rather than deleting it: the row stays live so time
can still be logged up to the end date, it reads as removed with the manager's
comment, and it accepts no further edits. Assigning the person again reopens it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import ResourceReleased
from src.models import StatusEnum
from src.resources.schemas import ResourceAssignmentUpdate

from .conftest import make_query_mock, make_user

_PROJECT = "507f1f77bcf86cd799439011"
_EMPLOYEE = "507f1f77bcf86cd799439012"
_YESTERDAY = datetime.now(timezone.utc) - timedelta(days=1)
_TOMORROW = datetime.now(timezone.utc) + timedelta(days=1)
_NEXT_MONTH = (datetime.now(timezone.utc) + timedelta(days=30)).strftime("%Y-%m-%d")


def make_ra(task_id=None, *, released_on=None, end_date=None):
    ra = MagicMock()
    ra.id = f"ra-{task_id or 'project'}"
    ra.organisation_id = "org1"
    ra.project_id = PydanticObjectId(_PROJECT)
    ra.task_id = PydanticObjectId(task_id) if task_id else None
    ra.user_id = PydanticObjectId(_EMPLOYEE)
    ra.status = StatusEnum.ACTIVE
    ra.deleted_on = None
    ra.released_on = released_on
    ra.end_date = end_date
    ra.start_date = None
    ra.role = "dev"
    ra.allocation_percentage = 100
    ra.billable_rate = None
    ra.is_billable = True
    ra.removal_comment = None
    ra.removal_history = []
    ra.save = AsyncMock()
    return ra


def patched(addressed, live):
    return [
        patch("src.resources.service.ResourceAssignment.get", AsyncMock(return_value=addressed)),
        patch("src.resources.service._active_assignments", AsyncMock(return_value=live)),
        # No timesheets by default, so the start-date backfill finds nothing to fill
        # from; TestStartDateBackfill overrides these.
        patch("src.resources.service.WeeklyTimesheet.find",
              MagicMock(return_value=make_query_mock([]))),
        patch("src.resources.service.emit_activity", AsyncMock()),
        patch("src.resources.service.emit_audit", AsyncMock()),
    ]


class _Patches:
    def __init__(self, patches):
        self._patches = patches

    def __enter__(self):
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()
        return False


class TestRemoveResource:
    @pytest.mark.asyncio
    async def test_it_closes_the_allocation_instead_of_deleting_it(self):
        from src.resources import service

        ra = make_ra()
        with _Patches(patched(ra, [ra])):
            await service.delete_resource(_PROJECT, "ra1", make_user(), "rolling off", _NEXT_MONTH)

        assert ra.deleted_on is None            # still live: time can be logged to the end date
        assert ra.status == StatusEnum.ACTIVE
        assert ra.released_on is not None
        assert ra.end_date.date().isoformat() == _NEXT_MONTH
        assert ra.removal_comment == "rolling off"
        ra.save.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_it_closes_every_task_row_for_that_employee(self):
        from src.resources import service

        addressed, sibling = make_ra("507f1f77bcf86cd7994390a1"), make_ra("507f1f77bcf86cd7994390a2")
        with _Patches(patched(addressed, [addressed, sibling])):
            await service.delete_resource(_PROJECT, "ra1", make_user(), "rolling off", _NEXT_MONTH)

        assert sibling.released_on is not None
        assert sibling.end_date.date().isoformat() == _NEXT_MONTH

    @pytest.mark.asyncio
    async def test_the_comment_is_kept_in_history(self):
        from src.resources import service

        ra = make_ra()
        with _Patches(patched(ra, [ra])):
            await service.delete_resource(_PROJECT, "ra1", make_user(), "rolling off", _NEXT_MONTH)

        assert ra.removal_history[-1]["comment"] == "rolling off"
        assert ra.removal_history[-1]["effective_from"] == ra.end_date

    @pytest.mark.asyncio
    async def test_removing_twice_is_refused(self):
        from src.resources import service

        ra = make_ra(released_on=_YESTERDAY, end_date=_TOMORROW)
        with _Patches(patched(ra, [ra])):
            with pytest.raises(ResourceReleased) as exc:
                await service.delete_resource(_PROJECT, "ra1", make_user(), "again", _NEXT_MONTH)

        assert exc.value.code == "TSM-037"


class TestStartDateBackfill:
    """A closing allocation with no start date has no window to report on, so it is
    dated from the employee's first logged day on the project."""

    def _entry(self, day: str):
        return MagicMock(entry_date=datetime.fromisoformat(day))

    def _patches(self, ra, oldest_entry):
        query = make_query_mock([MagicMock(id="ts1")])
        query.first_or_none = AsyncMock(return_value=oldest_entry)
        return patched(ra, [ra]) + [
            patch("src.resources.service.WeeklyTimesheet.find",
                  MagicMock(return_value=make_query_mock([MagicMock(id="ts1")]))),
            patch("src.resources.service.TimesheetEntry.find", MagicMock(return_value=query)),
        ]

    @pytest.mark.asyncio
    async def test_it_fills_from_the_oldest_entry(self):
        from src.resources import service

        ra = make_ra()
        assert ra.start_date is None
        with _Patches(self._patches(ra, self._entry("2026-05-04"))):
            await service.delete_resource(_PROJECT, "ra1", make_user(), "off", _NEXT_MONTH)

        assert ra.start_date == datetime(2026, 5, 4)

    @pytest.mark.asyncio
    async def test_an_existing_start_date_is_left_alone(self):
        from src.resources import service

        ra = make_ra()
        ra.start_date = datetime(2026, 1, 1)
        with _Patches(self._patches(ra, self._entry("2026-05-04"))):
            await service.delete_resource(_PROJECT, "ra1", make_user(), "off", _NEXT_MONTH)

        assert ra.start_date == datetime(2026, 1, 1)

    @pytest.mark.asyncio
    async def test_no_logged_time_leaves_it_open_ended(self):
        from src.resources import service

        ra = make_ra()
        with _Patches(self._patches(ra, None)):
            await service.delete_resource(_PROJECT, "ra1", make_user(), "off", _NEXT_MONTH)

        assert ra.start_date is None
        assert ra.released_on is not None   # the removal still goes through


class TestReleasedAllocationsAreFinal:
    @pytest.mark.asyncio
    async def test_editing_a_removed_resource_is_refused(self):
        from src.resources import service

        ra = make_ra(released_on=_YESTERDAY, end_date=_TOMORROW)
        with patch("src.resources.service.ResourceAssignment.get", AsyncMock(return_value=ra)):
            with pytest.raises(ResourceReleased):
                await service.update_resource(
                    _PROJECT, "ra1", ResourceAssignmentUpdate(role="lead"), make_user(),
                )

    @pytest.mark.asyncio
    async def test_a_live_allocation_still_edits(self):
        from src.resources import service

        ra = make_ra()
        with patch("src.resources.service.ResourceAssignment.get", AsyncMock(return_value=ra)), \
             patch("src.resources.service._active_assignments", AsyncMock(return_value=[ra])), \
             patch("src.resources.service.emit_audit", AsyncMock()):
            await service.update_resource(
                _PROJECT, "ra1", ResourceAssignmentUpdate(role="lead"), make_user(),
            )

        assert ra.role == "lead"


class TestAllocationStatus:
    def test_a_live_allocation_reads_allocated(self):
        from src.resources import service

        assert service._allocation_status(make_ra()) == "allocated"

    def test_released_but_not_yet_ended_reads_ending(self):
        from src.resources import service

        ra = make_ra(released_on=_YESTERDAY, end_date=_TOMORROW)
        assert service._allocation_status(ra) == "ending"

    def test_released_and_past_its_date_reads_removed(self):
        from src.resources import service

        ra = make_ra(released_on=_YESTERDAY, end_date=_YESTERDAY)
        assert service._allocation_status(ra) == "removed"


class TestReassignReopens:
    @pytest.mark.asyncio
    async def test_a_released_row_is_reopened_not_duplicated(self):
        from src.resources import service

        released = make_ra(released_on=_YESTERDAY, end_date=_YESTERDAY)
        find = MagicMock(return_value=make_query_mock([]))
        find.return_value.first_or_none = AsyncMock(return_value=None)

        with patch("src.resources.service.ResourceAssignment.find", find), \
             patch("src.resources.service.ResourceAssignment.find_one",
                   AsyncMock(return_value=released)):
            doc = await service._upsert_assignment(
                PydanticObjectId(_PROJECT), None, PydanticObjectId(_EMPLOYEE),
                {"role": "dev"}, make_user(), datetime.now(timezone.utc),
            )

        assert doc is released
        assert doc.released_on is None
        assert doc.removal_comment is None
