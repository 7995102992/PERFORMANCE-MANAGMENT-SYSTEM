"""Employment types that are excluded from timesheet emails.

Contractors and interns fill and view timesheets like anyone else — they just are
not mailed. Which types those are is configuration: the setting holds the master-data ids
that employee records already point at.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

_FULL_TIME = PydanticObjectId("507f1f77bcf86cd799439011")
_CONTRACTOR = PydanticObjectId("507f1f77bcf86cd799439012")
_INTERN = PydanticObjectId("507f1f77bcf86cd799439013")
_EXTERNAL = PydanticObjectId("507f1f77bcf86cd799439014")   # no employee record

# employees.employment_type holds the master-data id — what the setting stores
_ID_FULL_TIME = "6a53bfe5ce1edf015a76d4a8"
_ID_CONTRACT = "6a53bfe5ce1edf015a76d4a9"
_ID_INTERNSHIP = "6a53bfe5ce1edf015a76d4aa"
# resolve_employment_type_ids keys by str(user_id) — see the note there.
_TYPES = {str(_FULL_TIME): _ID_FULL_TIME, str(_CONTRACTOR): _ID_CONTRACT,
          str(_INTERN): _ID_INTERNSHIP}


def settings_with(excluded):
    return MagicMock(notification_excluded_employment_types=excluded)


async def notifiable(user_ids, excluded, types=None):
    from src.notifications import service

    with patch("src.notifications.service.get_effective_settings",
               AsyncMock(return_value=settings_with(excluded))), \
         patch("src.notifications.service.resolve_employment_type_ids",
               AsyncMock(return_value=_TYPES if types is None else types)) as resolver:
        result = await service._notifiable(user_ids, "org1")
    return result, resolver


class TestNotifiable:
    @pytest.mark.asyncio
    async def test_nothing_configured_means_everyone_is_notified(self):
        result, resolver = await notifiable([_FULL_TIME, _CONTRACTOR, _INTERN], [])

        assert result == [_FULL_TIME, _CONTRACTOR, _INTERN]
        resolver.assert_not_awaited()  # no IAM round trip when there is nothing to apply

    @pytest.mark.asyncio
    async def test_excluded_types_are_dropped(self):
        result, _ = await notifiable(
            [_FULL_TIME, _CONTRACTOR, _INTERN], [_ID_CONTRACT, _ID_INTERNSHIP],
        )

        assert result == [_FULL_TIME]

    @pytest.mark.asyncio
    async def test_only_the_configured_types_are_dropped(self):
        result, _ = await notifiable([_FULL_TIME, _CONTRACTOR, _INTERN], [_ID_INTERNSHIP])

        assert result == [_FULL_TIME, _CONTRACTOR]

    @pytest.mark.asyncio
    async def test_someone_without_an_employee_record_is_kept(self):
        """External project heads have no employment type and must still be mailed."""
        result, _ = await notifiable([_EXTERNAL, _CONTRACTOR], [_ID_CONTRACT])

        assert result == [_EXTERNAL]

    @pytest.mark.asyncio
    async def test_the_id_type_of_a_recipient_does_not_matter(self):
        """Callers hold ids as PydanticObjectId, ObjectId or str depending on where
        they came from; a type mismatch must never silently un-filter someone."""
        from bson import ObjectId

        as_pydantic, _ = await notifiable([_CONTRACTOR], [_ID_CONTRACT])
        as_objectid, _ = await notifiable([ObjectId(str(_CONTRACTOR))], [_ID_CONTRACT])
        as_string, _ = await notifiable([str(_CONTRACTOR)], [_ID_CONTRACT])

        assert as_pydantic == as_objectid == as_string == []

    @pytest.mark.asyncio
    async def test_an_objectid_in_the_setting_is_matched_too(self):
        """The setting normally holds strings, but must not depend on it."""
        from bson import ObjectId

        result, _ = await notifiable([_CONTRACTOR], [ObjectId(_ID_CONTRACT)])

        assert result == []

    @pytest.mark.asyncio
    async def test_a_lookup_failure_notifies_everyone(self):
        """The filter must never be the reason a notification goes missing."""
        from src.notifications import service

        with patch("src.notifications.service.get_effective_settings",
                   AsyncMock(side_effect=RuntimeError("settings unavailable"))):
            assert await service._notifiable([_CONTRACTOR], "org1") == [_CONTRACTOR]

        with patch("src.notifications.service.get_effective_settings",
                   AsyncMock(return_value=settings_with([_ID_CONTRACT]))), \
             patch("src.notifications.service.resolve_employment_type_ids",
                   AsyncMock(side_effect=RuntimeError("IAM unavailable"))):
            assert await service._notifiable([_CONTRACTOR], "org1") == [_CONTRACTOR]

    @pytest.mark.asyncio
    async def test_an_empty_recipient_list_short_circuits(self):
        from src.notifications import service

        get_settings = AsyncMock()
        with patch("src.notifications.service.get_effective_settings", get_settings):
            assert await service._notifiable([], "org1") == []
        get_settings.assert_not_awaited()


class TestFillRemindersAreExempt:
    @pytest.mark.asyncio
    async def test_everyone_is_reminded_to_fill_their_timesheet(self):
        """Contractors and interns fill timesheets, so they get reminded to."""
        from src.notifications import service

        publish = AsyncMock()
        notifiable = AsyncMock(side_effect=AssertionError("reminders must not be filtered"))

        with patch("src.notifications.service._notifiable", notifiable), \
             patch("src.notifications.service.resolve_user_emails",
                   AsyncMock(return_value={_CONTRACTOR: "contractor@x.com"})), \
             patch("src.notifications.service.resolve_user_names",
                   AsyncMock(return_value={_CONTRACTOR: "Priya"})), \
             patch("src.notifications.service.publish_employee_timesheet_reminder_email", publish):
            await service.notify_employee_fill_reminder(
                "org1", [_CONTRACTOR], week_start="2026-08-17",
                week_end="2026-08-23", period_key="utc:2026-08-17",
            )

        notifiable.assert_not_awaited()
        publish.assert_awaited_once()
        assert publish.await_args.kwargs["to"] == "contractor@x.com"


class TestSubmissionRespectsIt:
    @pytest.mark.asyncio
    async def test_a_contractor_manager_is_not_mailed(self):
        from src.notifications import service

        doc = MagicMock(id="ts1", organisation_id="org1", user_id="emp1", total_hours=40)
        doc.week_start_date = MagicMock()
        doc.week_end_date = MagicMock()
        publish = AsyncMock()

        with patch("src.notifications.service._get_timesheet_project_ids",
                   AsyncMock(return_value=["p1"])), \
             patch("src.notifications.service._get_project_manager_ids",
                   AsyncMock(return_value=[_CONTRACTOR])), \
             patch("src.notifications.service.get_effective_settings",
                   AsyncMock(return_value=settings_with([_ID_CONTRACT]))), \
             patch("src.notifications.service.resolve_employment_type_ids",
                   AsyncMock(return_value=_TYPES)), \
             patch("src.notifications.service.resolve_user_emails",
                   AsyncMock(return_value={})) as emails, \
             patch("src.notifications.service.publish_timesheet_submitted_email", publish):
            await service.notify_timesheet_submitted(doc, "Preethi")

        assert emails.await_args.args[0] == []   # filtered before the email lookup
        publish.assert_not_awaited()
