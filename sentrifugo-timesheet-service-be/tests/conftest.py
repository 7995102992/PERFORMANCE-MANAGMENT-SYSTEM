from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from src.main import app


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as c:
        yield c


# ---------------------------------------------------------------------------
# Shared mock factories
# ---------------------------------------------------------------------------

def make_settings(**overrides):
    """Return a MagicMock that quacks like TimesheetSettings."""
    defaults = dict(
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
        submission_deadline_hours=0,
        submission_day="friday",
        submission_time="18:00",
        auto_submit_enabled=False,
        approval_required=True,
        allow_future_entries=False,
        past_submission_cutoff_enabled=False,
        past_submission_cutoff_day=25,
    )
    defaults.update(overrides)
    s = MagicMock()
    for k, v in defaults.items():
        setattr(s, k, v)
    return s


def make_timesheet(**overrides):
    """Return a MagicMock that quacks like WeeklyTimesheet."""
    from src.models import TimesheetStatusEnum
    week_start = datetime(2026, 5, 4, tzinfo=timezone.utc)
    defaults = dict(
        id="ts1",
        organisation_id="org1",
        user_id="u1",
        week_start_date=week_start,
        week_end_date=datetime(2026, 5, 10, tzinfo=timezone.utc),
        total_hours=0.0,
        billable_hours=0.0,
        non_billable_hours=0.0,
        shortage_hours=0.0,
        penalty_hours=0.0,
        timesheet_status=TimesheetStatusEnum.DRAFT,
        submitted_at=None,
        notes=None,
        attachments=[],
        created_by="u1",
        created_on=datetime(2026, 5, 4, tzinfo=timezone.utc),
        modified_on=None,
    )
    defaults.update(overrides)
    ts = MagicMock()
    ts.save = AsyncMock()
    ts.insert = AsyncMock()
    for k, v in defaults.items():
        setattr(ts, k, v)
    return ts


def make_entry(**overrides):
    """Return a MagicMock that quacks like TimesheetEntry."""
    defaults = dict(
        id="e1",
        organisation_id="org1",
        weekly_timesheet_id="ts1",
        project_id="p1",
        task_id="task1",
        entry_date=datetime(2026, 5, 4, tzinfo=timezone.utc),
        hours=8.0,
        notes=None,
        is_billable=True,
        created_on=datetime(2026, 5, 4, tzinfo=timezone.utc),
        modified_on=datetime(2026, 5, 4, tzinfo=timezone.utc),
    )
    defaults.update(overrides)
    e = MagicMock()
    e.save = AsyncMock()
    e.insert = AsyncMock()
    for k, v in defaults.items():
        setattr(e, k, v)
    return e


def make_user(**overrides):
    """Return a MagicMock that quacks like UserBase."""
    defaults = dict(
        id="u1",
        organisation_id="org1",
        first_name="Test",
        last_name="User",
        display_name="Test User",
        email="test@example.com",
    )
    defaults.update(overrides)
    u = MagicMock()
    for k, v in defaults.items():
        setattr(u, k, v)
    return u


def make_query_mock(items=None, count=0):
    """Return a mock for Beanie query chains: .find(...).sort(...).skip(...).limit(...).to_list()"""
    items = items or []
    q = MagicMock()
    q.to_list = AsyncMock(return_value=items)
    q.count = AsyncMock(return_value=count)
    q.sort = MagicMock(return_value=q)
    q.skip = MagicMock(return_value=q)
    q.limit = MagicMock(return_value=q)
    return q
