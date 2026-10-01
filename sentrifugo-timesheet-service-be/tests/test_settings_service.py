"""Unit tests for src/settings/service.py"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.settings import service as settings_service

from .conftest import make_query_mock, make_user


def _make_settings_doc(**kwargs):
    defaults = dict(
        id="settings1",
        organisation_id="org1",
        project_id=None,
        daily_restrictions_enabled=True,
        min_hours_per_day=0.0,
        max_hours_per_day=24.0,
        deduct_leave_daily=False,
        weekly_restrictions_enabled=True,
        standard_hours_per_day=8.0,
        max_hours_per_week=40.0,
        deduct_leave_weekly=False,
        show_hours_type="gross",
        shortage_penalty_enabled=False,
        penalty_percentage=5.0,
        daily_time_entry_enabled=False,
        allow_past_due_submission=True,
        restrict_time_off_entries=False,
        allow_attachment=True,
        submission_compliance_type="weekly",
        submission_deadline_hours=15,
        submission_day="friday",
        submission_time="18:00",
        auto_submit_enabled=False,
        approval_required=True,
        allow_future_entries=False,
        allow_past_entries_days=30,
        created_on=None,
        modified_on=None,
    )
    defaults.update(kwargs)
    doc = MagicMock()
    doc.save = AsyncMock()
    doc.insert = AsyncMock()
    for k, v in defaults.items():
        setattr(doc, k, v)
    return doc


# ---------------------------------------------------------------------------
# get_effective_settings
# ---------------------------------------------------------------------------

class TestGetEffectiveSettings:
    @pytest.mark.asyncio
    async def test_returns_project_settings_when_exists(self):
        proj_settings = _make_settings_doc(project_id="p1")
        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=proj_settings)):
            result = await settings_service.get_effective_settings("org1", "p1")
        assert result is proj_settings

    @pytest.mark.asyncio
    async def test_falls_back_to_org_settings(self):
        org_settings = _make_settings_doc(project_id=None)
        # First call (project lookup) returns None, second (org lookup) returns org_settings
        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(side_effect=[None, org_settings])):
            result = await settings_service.get_effective_settings("org1", "p1")
        assert result is org_settings

    @pytest.mark.asyncio
    async def test_no_settings_returns_none(self):
        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=None)):
            result = await settings_service.get_effective_settings("org1")
        assert result is None


# ---------------------------------------------------------------------------
# get_settings (get_or_create)
# ---------------------------------------------------------------------------

class TestGetSettings:
    @pytest.mark.asyncio
    async def test_returns_existing_settings(self):
        user = make_user()
        doc = _make_settings_doc()
        levels_query = make_query_mock([])

        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=doc)), \
             patch("src.settings.service.ApprovalLevelConfig.find", return_value=levels_query):
            result = await settings_service.get_settings(user)

        assert result["organisation_id"] == "org1"
        assert result["weekly_restrictions_enabled"] is True

    @pytest.mark.asyncio
    async def test_creates_default_when_missing(self):
        user = make_user()
        new_doc = _make_settings_doc()
        levels_query = make_query_mock([])

        MockTS = MagicMock()
        MockTS.find_one = AsyncMock(return_value=None)
        MockTS.return_value = new_doc
        with patch("src.settings.service.TimesheetSettings", MockTS), \
             patch("src.settings.service.ApprovalLevelConfig.find", return_value=levels_query):
            result = await settings_service.get_settings(user)

        assert new_doc.insert.called


# ---------------------------------------------------------------------------
# update_hour_settings
# ---------------------------------------------------------------------------

class TestUpdateHourSettings:
    @pytest.mark.asyncio
    async def test_updates_hour_fields(self):
        user = make_user()
        doc = _make_settings_doc()
        levels_query = make_query_mock([])

        from src.settings.schemas import HourSettingsUpdate
        body = HourSettingsUpdate(
            daily_restrictions_enabled=True,
            min_hours_per_day=4.0,
            max_hours_per_day=12.0,
            deduct_leave_daily=True,
            weekly_restrictions_enabled=True,
            standard_hours_per_day=8.0,
            max_hours_per_week=45.0,
            deduct_leave_weekly=False,
            show_hours_type="net",
            shortage_penalty_enabled=True,
            penalty_percentage=10.0,
        )

        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=doc)), \
             patch("src.settings.service.ApprovalLevelConfig.find", return_value=levels_query):
            result = await settings_service.update_hour_settings(body, user)

        assert doc.min_hours_per_day == 4.0
        assert doc.max_hours_per_day == 12.0
        assert doc.deduct_leave_daily is True
        assert doc.show_hours_type == "net"
        assert doc.shortage_penalty_enabled is True
        assert doc.penalty_percentage == 10.0
        assert doc.save.called


# ---------------------------------------------------------------------------
# update_submission_settings
# ---------------------------------------------------------------------------

class TestUpdateSubmissionSettings:
    @pytest.mark.asyncio
    async def test_updates_submission_fields(self):
        user = make_user()
        doc = _make_settings_doc()
        levels_query = make_query_mock([])

        from src.settings.schemas import SubmissionSettingsUpdate
        body = SubmissionSettingsUpdate(
            daily_time_entry_enabled=True,
            allow_past_due_submission=False,
            restrict_time_off_entries=True,
            allow_attachment=False,
            submission_compliance_type="daily",
            submission_deadline_hours=24,
            submission_day="thursday",
            submission_time="17:00",
            auto_submit_enabled=True,
        )

        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=doc)), \
             patch("src.settings.service.ApprovalLevelConfig.find", return_value=levels_query):
            result = await settings_service.update_submission_settings(body, user)

        assert doc.daily_time_entry_enabled is True
        assert doc.allow_past_due_submission is False
        assert doc.restrict_time_off_entries is True
        assert doc.allow_attachment is False
        assert doc.submission_compliance_type == "daily"
        assert doc.auto_submit_enabled is True
        assert doc.save.called


# ---------------------------------------------------------------------------
# update_approval_settings
# ---------------------------------------------------------------------------

class TestUpdateApprovalSettings:
    @pytest.mark.asyncio
    async def test_updates_approval_fields(self):
        user = make_user()
        doc = _make_settings_doc()
        levels_query = make_query_mock([])

        from src.settings.schemas import ApprovalLevelConfigIn, ApprovalSettingsUpdate
        body = ApprovalSettingsUpdate(
            approval_required=False,
            allow_future_entries=True,
            allow_past_entries_days=60,
            levels=[ApprovalLevelConfigIn(level=1, approver_role="manager", approver_id="mgr1")],
        )

        new_level = MagicMock()
        new_level.insert = AsyncMock()
        MockALC = MagicMock()
        MockALC.find = MagicMock(return_value=levels_query)
        MockALC.return_value = new_level
        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=doc)), \
             patch("src.settings.service.ApprovalLevelConfig", MockALC):
            result = await settings_service.update_approval_settings(body, user)

        assert doc.approval_required is False
        assert doc.allow_future_entries is True
        assert doc.allow_past_entries_days == 60
        assert doc.save.called

    @pytest.mark.asyncio
    async def test_existing_levels_soft_deleted(self):
        user = make_user()
        doc = _make_settings_doc()
        existing_level = MagicMock()
        existing_level.save = AsyncMock()
        levels_query = make_query_mock([existing_level])

        from src.settings.schemas import ApprovalSettingsUpdate
        body = ApprovalSettingsUpdate(
            approval_required=True,
            allow_future_entries=False,
            allow_past_entries_days=30,
            levels=[],
        )

        with patch("src.settings.service.TimesheetSettings.find_one", AsyncMock(return_value=doc)), \
             patch("src.settings.service.ApprovalLevelConfig.find", return_value=levels_query):
            await settings_service.update_approval_settings(body, user)

        assert existing_level.deleted_on is not None
        assert existing_level.save.called
