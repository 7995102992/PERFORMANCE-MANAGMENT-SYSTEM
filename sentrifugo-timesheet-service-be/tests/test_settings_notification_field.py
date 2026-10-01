"""The notification-exclusion list is writable from both settings tabs.

It is edited in the submission UI, beside the client-notification options, but
belongs to the approval group — the same split that already puts `client_notify_*`
on both payloads. Accepting it in both places means whichever Save the user reaches
for persists it, and neither Save silently clears it.
"""
from __future__ import annotations

import pytest

from src.settings.schemas import ApprovalSettingsUpdate, SubmissionSettingsUpdate

_IDS = ["6a53bfe5ce1edf015a76d4a9", "6a53bfe5ce1edf015a76d4aa"]

_SUBMISSION = {"submission_day": "friday", "submission_time": "18:00"}


class TestBothPayloadsAcceptIt:
    def test_submission_payload_carries_it(self):
        body = SubmissionSettingsUpdate(
            **_SUBMISSION, notification_excluded_employment_types=_IDS,
        )
        assert body.notification_excluded_employment_types == _IDS

    def test_approval_payload_carries_it(self):
        body = ApprovalSettingsUpdate(notification_excluded_employment_types=_IDS)
        assert body.notification_excluded_employment_types == _IDS

    def test_both_default_to_empty(self):
        assert SubmissionSettingsUpdate(**_SUBMISSION).notification_excluded_employment_types == []
        assert ApprovalSettingsUpdate().notification_excluded_employment_types == []

    def test_it_sits_alongside_the_field_it_mirrors(self):
        """client_notify_* is on both payloads for the same reason — keep them together."""
        shared = set(SubmissionSettingsUpdate.model_fields) & set(ApprovalSettingsUpdate.model_fields)

        assert "notification_excluded_employment_types" in shared
        assert {"client_notify_on_pending_count_enabled", "client_notify_schedule"} <= shared


class TestBothWritesPersistIt:
    @pytest.mark.asyncio
    async def test_saving_submission_settings_stores_it(self):
        from unittest.mock import AsyncMock, MagicMock, patch

        from src.settings import service

        doc = MagicMock(id="507f1f77bcf86cd799439021")
        doc.save = AsyncMock()
        user = MagicMock(id="507f1f77bcf86cd799439011", organisation_id="507f1f77bcf86cd799439012")
        with patch("src.settings.service._get_or_create_settings", AsyncMock(return_value=doc)), \
             patch("src.settings.service._get_approval_levels", AsyncMock(return_value=[])), \
             patch("src.settings.service._to_out", MagicMock(return_value={})), \
             patch("src.settings.service.emit_audit", AsyncMock()):
            await service.update_submission_settings(
                SubmissionSettingsUpdate(**_SUBMISSION, notification_excluded_employment_types=_IDS),
                user,
            )

        assert doc.notification_excluded_employment_types == _IDS
