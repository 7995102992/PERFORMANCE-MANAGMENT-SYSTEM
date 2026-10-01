"""The payroll cutoff, read by Team Timesheets.

That screen greys out its reopen affordance for months the cutoff has closed, so it
needs the two cutoff fields on load. It is gated by manage_timesheet and must not be
made to hold manage_settings just to render — hence a separate, read-only endpoint
on the Team Timesheets routes that exposes nothing else from the settings record.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.models import TimesheetSettings

from .conftest import make_settings, make_user


async def cutoff(settings):
    from src.approvals import service

    with patch("src.settings.service.get_effective_settings",
               AsyncMock(return_value=settings)) as get:
        result = await service.get_past_submission_cutoff(make_user())
    return result, get


class TestGetPastSubmissionCutoff:
    @pytest.mark.asyncio
    async def test_it_reports_the_configured_cutoff(self):
        result, _ = await cutoff(
            make_settings(past_submission_cutoff_enabled=True, past_submission_cutoff_day=20)
        )

        assert result == {"enabled": True, "cutoff_day": 20}

    @pytest.mark.asyncio
    async def test_the_day_survives_the_toggle_being_off(self):
        """The client renders the day whether or not the rule is live, so it is
        never blanked out — `enabled` alone says whether it applies."""
        result, _ = await cutoff(
            make_settings(past_submission_cutoff_enabled=False, past_submission_cutoff_day=20)
        )

        assert result == {"enabled": False, "cutoff_day": 20}

    @pytest.mark.asyncio
    async def test_an_unconfigured_organisation_gets_the_default_day(self):
        """Never null: the client should not have to carry its own fallback."""
        result, _ = await cutoff(None)

        assert result["cutoff_day"] == TimesheetSettings.model_fields[
            "past_submission_cutoff_day"].default
        assert result["enabled"] is False

    @pytest.mark.asyncio
    async def test_reading_does_not_create_a_settings_document(self):
        """`get_settings` inserts on first read; a manager opening a screen must not."""
        from src.approvals import service

        create = AsyncMock()
        with patch("src.settings.service.get_effective_settings", AsyncMock(return_value=None)), \
             patch("src.settings.service._get_or_create_settings", create):
            await service.get_past_submission_cutoff(make_user())

        create.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_it_reads_the_organisation_record_with_no_project_override(self):
        """Enforcement resolves the org-level document, so advertise that one."""
        user = make_user()
        _, get = await cutoff(make_settings(past_submission_cutoff_enabled=True))

        assert get.await_args.args == (user.organisation_id,)
        assert not get.await_args.kwargs


class TestRouteGate:
    def test_it_lives_on_the_team_timesheets_routes(self):
        """Not under /settings: that router is gated by manage_settings wholesale,
        which would 403 the very managers who need the cutoff to render."""
        from src.approvals import router as approvals_router
        from src.settings import router as settings_router

        assert not any(
            "past-submission-cutoff" in getattr(r, "path", "")
            for r in settings_router.router.routes
        )
        route = next(
            r for r in approvals_router.router.routes
            if getattr(r, "path", None) == "/approvals/past-submission-cutoff"
        )
        gates = [d.call for d in route.dependant.dependencies]
        assert approvals_router._MANAGER in gates
