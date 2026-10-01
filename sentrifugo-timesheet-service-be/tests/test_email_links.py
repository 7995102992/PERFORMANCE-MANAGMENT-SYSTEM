"""Frontend links carried by timesheet emails.

Every path here is hard-coded against the frontend router, so a typo ships a dead
button in a live email. These pin the four shapes that exist:

    approver   /timesheet/employee-timesheets?timesheet={id}
    employee   /timesheet/my-timesheet/entry?week={YYYY-MM-DD}
    reminder   /timesheet/my-timesheet
    client     /client-approval?token=…&action=…
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.notifications import email_events

_TS_ID = "6a83fb7ce4eee767ef6b3d02"


async def captured(publisher, **kwargs) -> dict:
    """Run a publisher and return the template_data it queued."""
    sent: dict = {}

    async def capture(_routing_key, envelope, **_kw):
        sent.update(envelope["payload"]["template_data"])

    with patch("src.notifications.email_events.outbox.publish", capture):
        await publisher(**kwargs)
    return sent


class TestApproverLinks:
    @pytest.mark.asyncio
    async def test_submitted_deep_links_to_the_timesheet(self):
        data = await captured(
            email_events.publish_timesheet_submitted_email,
            to="mgr@x.com", employee_name="Preethi", week_start="2026-08-17",
            week_end="2026-08-23", total_hours=40, project_names="Warehouse",
            timesheet_id=_TS_ID,
        )

        assert data["review_link"].endswith(f"/timesheet/employee-timesheets?timesheet={_TS_ID}")

    @pytest.mark.asyncio
    async def test_resubmitted_uses_the_same_target(self):
        data = await captured(
            email_events.publish_timesheet_resubmitted_email,
            to="mgr@x.com", employee_name="Preethi", week_start="2026-08-17",
            week_end="2026-08-23", total_hours=40, project_names="Warehouse",
            timesheet_id=_TS_ID,
        )

        assert data["review_link"].endswith(f"/timesheet/employee-timesheets?timesheet={_TS_ID}")


class TestEmployeeLinks:
    @pytest.mark.asyncio
    async def test_approved_opens_the_week(self):
        data = await captured(
            email_events.publish_timesheet_approved_email,
            to="emp@x.com", employee_name="Preethi", approver_name="Gopal",
            approval_level="Manager (L1)", week_start="2026-08-17",
            week_end="2026-08-23", total_hours=40, timesheet_id=_TS_ID,
        )

        assert data["view_link"].endswith("/timesheet/my-timesheet/entry?week=2026-08-17")

    @pytest.mark.asyncio
    async def test_rejected_opens_the_week(self):
        data = await captured(
            email_events.publish_timesheet_rejected_email,
            to="emp@x.com", employee_name="Preethi", approver_name="Gopal",
            rejection_level="Manager (L1)", comments="wrong task",
            week_start="2026-08-17", week_end="2026-08-23", timesheet_id=_TS_ID,
        )

        assert data["edit_link"].endswith("/timesheet/my-timesheet/entry?week=2026-08-17")

    @pytest.mark.asyncio
    async def test_an_explicit_link_wins_over_the_default(self):
        data = await captured(
            email_events.publish_timesheet_approved_email,
            to="emp@x.com", employee_name="Preethi", approver_name="Gopal",
            approval_level="Manager (L1)", week_start="2026-08-17",
            week_end="2026-08-23", total_hours=40, timesheet_id=_TS_ID,
            view_link="https://app.example/custom",
        )

        assert data["view_link"] == "https://app.example/custom"


class TestUpdateMailIsDistinct:
    """The outbox dedupes on idempotency_key permanently — a unique index with no
    TTL — so reusing the submission key silently swallows every edit after the
    first. The key is ours to choose; the event type and template are not."""

    async def _publish(self, updated_at: str) -> tuple[str, str, str]:
        seen: dict = {}

        async def capture(routing_key, envelope, *, idempotency_key, **_kw):
            seen["routing_key"] = routing_key
            seen["template_id"] = envelope["payload"]["template_id"]
            seen["idempotency_key"] = idempotency_key

        with patch("src.notifications.email_events.outbox.publish", capture):
            await email_events.publish_timesheet_updated_email(
                to="mgr@x.com", employee_name="Preethi", week_start="2026-08-17",
                week_end="2026-08-23", total_hours=40, project_names="Warehouse",
                timesheet_id=_TS_ID, updated_at=updated_at,
            )
        return seen["routing_key"], seen["template_id"], seen["idempotency_key"]

    @pytest.mark.asyncio
    async def test_rides_the_submitted_event_and_template(self):
        """Both belong to the mail service's contract, so nothing is needed there."""
        routing_key, template_id, _ = await self._publish("2026-08-19T10:00:00")

        assert routing_key == "email.timesheet_submitted"
        assert template_id == "timesheet_submitted_v1"

    @pytest.mark.asyncio
    async def test_key_cannot_collide_with_the_submission_mail(self):
        _, _, key = await self._publish("2026-08-19T10:00:00")

        assert key.startswith("email.ts_updated:")
        assert "ts_submitted" not in key

    @pytest.mark.asyncio
    async def test_each_edit_sends_but_a_retry_dedupes(self):
        _, _, first = await self._publish("2026-08-19T10:00:00")
        _, _, retry = await self._publish("2026-08-19T10:00:00")
        _, _, second_edit = await self._publish("2026-08-19T11:30:00")

        assert first == retry            # same edit → same key → deduped
        assert first != second_edit      # later edit → new key → sends


class TestNoStalePaths:
    def test_removed_frontend_routes_are_gone(self):
        """`/approvals/{id}` and `/timesheets/{id}` never existed; `employee-detail`
        was deleted when the approver list gained its slide-over sheet."""
        from pathlib import Path

        root = Path(__file__).resolve().parents[1] / "src" / "notifications"
        source = "\n".join(p.read_text(encoding="utf-8") for p in root.glob("*.py"))

        assert "/approvals/{timesheet_id}" not in source
        assert "/timesheets/{timesheet_id}" not in source
        assert "employee-detail" not in source
