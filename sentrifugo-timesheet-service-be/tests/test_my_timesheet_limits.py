"""The weekly hour cap an employee is held to.

Exposed on the employee's own timesheet routes so the grid can show the limit
without granting sight of the settings screen. Null when the organisation has not
enabled the restriction — the UI hides the indicator rather than guessing 40.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from .conftest import make_settings, make_user


async def limits(settings):
    from src.timesheets import service

    with patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)) as get:
        result = await service.get_my_limits(make_user())
    return result, get


class TestGetMyLimits:
    @pytest.mark.asyncio
    async def test_it_reports_the_cap_when_enabled(self):
        result, _ = await limits(
            make_settings(weekly_restrictions_enabled=True, max_hours_per_week=45.0)
        )

        assert result == {"max_hours_per_week": 45.0}

    @pytest.mark.asyncio
    async def test_it_reports_null_when_the_restriction_is_off(self):
        """The stored number is meaningless while the toggle is off."""
        result, _ = await limits(
            make_settings(weekly_restrictions_enabled=False, max_hours_per_week=40.0)
        )

        assert result == {"max_hours_per_week": None}

    @pytest.mark.asyncio
    async def test_it_reports_null_when_there_are_no_settings(self):
        result, _ = await limits(None)

        assert result == {"max_hours_per_week": None}

    @pytest.mark.asyncio
    async def test_it_reads_organisation_settings_not_a_project_override(self):
        """Submit enforces the cap from the org document — advertise the same one."""
        user = make_user()
        with patch("src.timesheets.service._get_settings",
                   AsyncMock(return_value=make_settings(weekly_restrictions_enabled=True,
                                                        max_hours_per_week=40.0))) as get:
            from src.timesheets import service
            await service.get_my_limits(user)

        assert get.await_args.args == (user.organisation_id,)
        assert not get.await_args.kwargs
