"""The historical-deadline cutoff — settings.SLA_ENFORCE_FROM.

The tick had never run before the in-process ticker was added, so every ticket
in an existing database carries a long-past deadline. Enrol that backlog — which
``rebuild_sla_cursor`` does wholesale — and the next few ticks would mail a
breach notice for each one. These tests pin the guard that stops it, and the
resolved-ticket exclusion that stops the sweep collecting the backlog in the
first place.

The failure being guarded against is a mailshot to real people, so "no email was
sent" is asserted directly rather than inferred from a summary counter.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from itertools import count
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.config import GlobalConfig
from src.models import (
    PriorityEnum,
    RequestStatusEnum,
    RequestType,
    SLADeadline,
    SLARule,
    SLA_INACTIVE_STATUSES,
    ServiceRequest,
    TERMINAL_STATUSES,
)
from src.requests.service_sla_tick import rebuild_sla_cursor, run_sla_tick
from src.sla_store import enrol


pytestmark = pytest.mark.asyncio


ORG = PydanticObjectId()
_ticket_seq = count(1)


@pytest_asyncio.fixture(autouse=True)
async def clean_slate():
    yield
    await ServiceRequest.get_motor_collection().delete_many({})
    await SLADeadline.get_motor_collection().delete_many({})
    # The tick resolves the ticket's request type on every entry, so the
    # factory below persists one per ticket. Left behind they accumulate
    # against the (organisation_id, name_lc) unique index.
    await RequestType.get_motor_collection().delete_many({})


async def _make_ticket(
    *,
    status=RequestStatusEnum.IN_PROGRESS,
    resolution_due_by=None,
    first_response_at=None,
):
    """A ticket whose SLA rule is actually in force.

    The tick discards any claimed deadline it cannot trace back to a live rule
    — an active, non-deleted request type carrying an active rule with the
    ticket's ``sla_rule_id`` — and discards it *before* deciding anything is a
    breach. A ticket with no `sla_rule_id` therefore never breaches, so a
    factory that skipped this could only ever assert `breaches == 0`, including
    in the tests whose whole point is that live deadlines still fire.
    """
    now = utcnow()
    seq = next(_ticket_seq)
    rule = SLARule(
        priority=PriorityEnum.LOW,
        first_response_minutes=60,
        resolution_minutes=480,
        # Deliberately empty: violation actions mutate the ticket (priority
        # bump, reassign) and these tests are about whether the breach fires at
        # all, not what it then does.
        violation_actions=[],
    )
    rt = RequestType(
        organisation_id=ORG,
        category_id=PydanticObjectId(),
        name=f"Test type {seq}",
        name_lc=f"test type {seq}",
        sla_rules=[rule],
    )
    await rt.insert()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{seq:06d}",
        organisation_id=ORG,
        requester_user_id=PydanticObjectId(),
        category_id=PydanticObjectId(),
        request_type_id=rt.id,
        sla_rule_id=rule.id,
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.LOW,
        title="Printer is on fire",
        request_status=status,
        primary_assignee_user_id=PydanticObjectId(),
        executor_user_id=PydanticObjectId(),
        assigned_at=now - timedelta(hours=3),
        first_response_at=first_response_at,
        resolution_due_by=resolution_due_by or (now - timedelta(days=30)),
        created_on=now,
    )
    await sr.insert()
    return sr


@pytest.fixture
def spy():
    """Watch the outbound edges without letting anything actually leave."""
    with (
        patch(
            "src.requests.service_sla_tick.publish_event", new_callable=AsyncMock
        ) as publish,
        patch(
            "src.requests.service_sla_tick.notify_watcher_if_subscribed",
            new_callable=AsyncMock,
        ),
        patch(
            "src.requests.service_sla_tick.emit_activity", new_callable=AsyncMock
        ) as activity,
        patch(
            "src.email_events.notify_sla_breached", new_callable=AsyncMock
        ) as email,
        patch(
            "src.common.email_resolver.resolve_user_info",
            new_callable=AsyncMock,
            return_value={"email": "exec@example.com", "name": "Executor"},
        ),
    ):
        yield {"publish": publish, "activity": activity, "email": email}


def _cutoff(dt):
    """Patch the cutoff for one test. Set on the live settings object because
    the tick reads ``settings.SLA_ENFORCE_FROM`` at call time."""
    return patch("src.requests.service_sla_tick.settings.SLA_ENFORCE_FROM", dt)


class TestCutoff:
    async def test_a_deadline_older_than_the_cutoff_is_discarded_silently(self, spy):
        """The whole point: a backlog deadline must not mail anyone."""
        sr = await _make_ticket()
        due = utcnow() - timedelta(days=30)
        await enrol({f"{sr.id}:resolution": due.timestamp()})

        with _cutoff(utcnow() - timedelta(days=1)):
            summary = await run_sla_tick()

        assert summary["skipped_historical"] == 1
        assert summary["breaches"] == 0
        spy["email"].assert_not_awaited()
        spy["publish"].assert_not_awaited()
        spy["activity"].assert_not_awaited()

    async def test_the_discarded_entry_is_gone_for_good(self, spy):
        """Claim deletes before the cutoff check, so a skip consumes the entry.
        Worth pinning: it means moving the cutoff back later does not resurrect
        the backlog, which is a property people will assume the other way."""
        sr = await _make_ticket()
        await enrol({f"{sr.id}:resolution": (utcnow() - timedelta(days=30)).timestamp()})

        with _cutoff(utcnow() - timedelta(days=1)):
            await run_sla_tick()

        assert await SLADeadline.find({"service_request_id": str(sr.id)}).count() == 0

    async def test_a_deadline_after_the_cutoff_still_breaches(self, spy):
        """The guard must not be a blanket off-switch — live tickets still fire."""
        sr = await _make_ticket()
        due = utcnow() - timedelta(minutes=5)
        await enrol({f"{sr.id}:resolution": due.timestamp()})

        with _cutoff(utcnow() - timedelta(days=1)):
            summary = await run_sla_tick()

        assert summary["skipped_historical"] == 0
        assert summary["breaches"] == 1
        spy["email"].assert_awaited()

    async def test_no_cutoff_configured_enforces_everything(self, spy):
        """Default is None — behaviour has to be unchanged for anyone who never
        sets it."""
        sr = await _make_ticket()
        await enrol({f"{sr.id}:resolution": (utcnow() - timedelta(days=30)).timestamp()})

        with _cutoff(None):
            summary = await run_sla_tick()

        assert summary["skipped_historical"] == 0
        assert summary["breaches"] == 1

    async def test_a_mixed_batch_splits_correctly(self, spy):
        """The realistic shape after a rebuild: backlog and live entries in one
        claim. A guard that dropped the whole batch would be just as wrong."""
        old = await _make_ticket()
        live = await _make_ticket()
        await enrol({
            f"{old.id}:resolution": (utcnow() - timedelta(days=30)).timestamp(),
            f"{live.id}:resolution": (utcnow() - timedelta(minutes=5)).timestamp(),
        })

        with _cutoff(utcnow() - timedelta(days=1)):
            summary = await run_sla_tick()

        assert summary["skipped_historical"] == 1
        assert summary["breaches"] == 1
        assert summary["processed"] == 2


class TestCutoffParsing:
    async def test_a_naive_cutoff_is_read_as_utc(self):
        """An aware/naive mismatch raises TypeError inside the tick's per-entry
        try, which would read as a processing failure rather than a bad setting."""
        cfg = GlobalConfig(SLA_ENFORCE_FROM=datetime(2026, 7, 20, 12, 0, 0))
        assert cfg.SLA_ENFORCE_FROM.tzinfo is not None
        assert cfg.SLA_ENFORCE_FROM.utcoffset() == timedelta(0)

    async def test_an_aware_cutoff_is_left_alone(self):
        aware = datetime(2026, 7, 20, 12, 0, 0, tzinfo=timezone.utc)
        assert GlobalConfig(SLA_ENFORCE_FROM=aware).SLA_ENFORCE_FROM == aware

    async def test_it_defaults_to_off(self):
        assert GlobalConfig().SLA_ENFORCE_FROM is None

    async def test_an_empty_env_value_means_no_cutoff(self):
        """`SLA_ENFORCE_FROM=` is how .env.example and the DevOps env files list
        an optional setting. Parsing "" as a datetime raises, and
        `settings = GlobalConfig()` runs at module scope — so getting this wrong
        does not disable the cutoff, it stops the service booting."""
        assert GlobalConfig(SLA_ENFORCE_FROM="").SLA_ENFORCE_FROM is None
        assert GlobalConfig(SLA_ENFORCE_FROM="   ").SLA_ENFORCE_FROM is None

    async def test_a_date_only_value_is_accepted(self):
        cfg = GlobalConfig(SLA_ENFORCE_FROM="2026-07-21")
        assert cfg.SLA_ENFORCE_FROM.utcoffset() == timedelta(0)


class TestResolvedTicketsStayOut:
    async def test_rebuild_skips_resolved_tickets(self):
        """RESOLVED is not terminal (a ticket has to leave it to be closed), so
        the sweep used to collect every resolved ticket and breach it."""
        await _make_ticket(status=RequestStatusEnum.RESOLVED)

        summary = await rebuild_sla_cursor()

        assert summary["reconciled"] == 0
        assert await SLADeadline.find({}).count() == 0

    async def test_rebuild_still_collects_open_tickets(self):
        sr = await _make_ticket(status=RequestStatusEnum.IN_PROGRESS)

        summary = await rebuild_sla_cursor()

        assert summary["reconciled"] >= 1
        assert await SLADeadline.find({"service_request_id": str(sr.id)}).count() >= 1

    async def test_the_tick_ignores_a_resolved_ticket(self, spy):
        """Belt and braces: resolve() drops the deadlines, but anything that
        re-adds one must not breach a ticket that already met its SLA."""
        sr = await _make_ticket(status=RequestStatusEnum.RESOLVED)
        await enrol({f"{sr.id}:resolution": (utcnow() - timedelta(minutes=5)).timestamp()})

        with _cutoff(None):
            summary = await run_sla_tick()

        assert summary["breaches"] == 0
        spy["email"].assert_not_awaited()

    async def test_resolved_is_sla_inactive_but_not_terminal(self):
        """Guards the reason this is a separate set. Putting RESOLVED in
        TERMINAL_STATUSES would make `assert_transition` reject CLOSE_FROM =
        {RESOLVED} and leave every resolved ticket uncloseable."""
        assert RequestStatusEnum.RESOLVED in SLA_INACTIVE_STATUSES
        assert RequestStatusEnum.RESOLVED not in TERMINAL_STATUSES
        assert TERMINAL_STATUSES < SLA_INACTIVE_STATUSES
