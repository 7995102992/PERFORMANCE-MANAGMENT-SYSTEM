"""Workflow auto-escalation — the trail it has to leave behind.

This path moves a ticket between people on a timer, with no human in the loop.
It was switched off precisely because it used to do that silently: no email to
the new owner, no HandoffEvent, no reason, and no ``previous_executor_user_id``
to stop a reassign bouncing the ticket straight back. These tests pin down each
of those, since a regression here is invisible until someone loses a ticket.
"""
from __future__ import annotations

from datetime import timedelta
from itertools import count
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from beanie import PydanticObjectId

from src.common.timestamps import utcnow
from src.models import (
    EscalationConfig,
    HandoffEvent,
    HandoffKindEnum,
    PriorityEnum,
    RequestStatusEnum,
    ServiceRequest,
    SYSTEM_ACTOR_ID,
)
from src.requests.service_sla_tick import (
    AUTO_ESCALATION_REASON,
    _apply_workflow_auto_escalate,
)


pytestmark = pytest.mark.asyncio


ORG = PydanticObjectId()
EXECUTOR = PydanticObjectId()
TARGET = PydanticObjectId()
REQUESTER = PydanticObjectId()

# ticket_no is unique per organisation, so each ticket needs its own.
_ticket_seq = count(1)


@pytest_asyncio.fixture(autouse=True)
async def clean_slate():
    """These tests write real documents; the shared fixture only clears the
    outbox and the deadline store, so tidy up after ourselves."""
    yield
    for doc in (ServiceRequest, EscalationConfig, HandoffEvent):
        await doc.get_motor_collection().delete_many({})


async def _make_ticket(status=RequestStatusEnum.IN_PROGRESS, executor=EXECUTOR):
    now = utcnow()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=ORG,
        requester_user_id=REQUESTER,
        category_id=PydanticObjectId(),
        request_type_id=PydanticObjectId(),
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.LOW,
        title="Printer is on fire",
        request_status=status,
        primary_assignee_user_id=PydanticObjectId(),
        executor_user_id=executor,
        assigned_at=now - timedelta(hours=3),
        first_response_at=now - timedelta(hours=2),
        created_on=now,
    )
    await sr.insert()
    return sr


async def _make_ec(workflow_id, *, enabled=True, target=TARGET):
    ec = EscalationConfig(
        workflow_id=workflow_id,
        auto_escalate_enabled=enabled,
        escalate_after_minutes=30,
        escalate_to_user_id=target,
        created_on=utcnow(),
    )
    await ec.insert()
    return ec


@pytest.fixture
def quiet():
    """Silence the outbound edges — events, watchers, activity, email."""
    with (
        patch("src.requests.service_sla_tick.publish_event", new_callable=AsyncMock),
        patch(
            "src.requests.service_sla_tick.notify_watcher_if_subscribed",
            new_callable=AsyncMock,
        ),
        patch("src.requests.service_sla_tick.emit_activity", new_callable=AsyncMock),
        patch(
            "src.email_events.notify_request_escalated", new_callable=AsyncMock
        ) as email,
        patch(
            "src.common.email_resolver.resolve_user_info",
            new_callable=AsyncMock,
            return_value={"email": "head@example.com", "name": "Dept Head"},
        ),
    ):
        yield {"email": email}


class TestExecutorPhaseEscalation:
    async def test_moves_the_ticket_to_the_configured_target(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == TARGET
        assert after.is_escalated is True
        assert after.escalation_count == 1
        assert after.escalated_at is not None
        assert after.modified_by == SYSTEM_ACTOR_ID

    async def test_records_who_it_was_taken_from(self, quiet):
        """Without this, reassign can bounce the ticket back to the same person."""
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.previous_executor_user_id == EXECUTOR

    async def test_records_a_reason(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.escalation_reason == AUTO_ESCALATION_REASON

    async def test_writes_a_handoff_event(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        handoffs = await HandoffEvent.find({"service_request_id": sr.id}).to_list()
        assert len(handoffs) == 1
        h = handoffs[0]
        assert h.kind == HandoffKindEnum.ESCALATION
        assert h.phase_index == 1
        assert h.from_user_id == EXECUTOR
        assert h.to_user_id == TARGET
        assert h.reason == AUTO_ESCALATION_REASON
        assert h.first_response_at is not None  # phase snapshot carried over

    async def test_emails_the_new_owner(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        quiet["email"].assert_awaited_once()
        kwargs = quiet["email"].await_args.kwargs
        assert kwargs["escalation_target_email"] == "head@example.com"
        assert kwargs["ticket_no"] == sr.ticket_no
        assert kwargs["reason"] == AUTO_ESCALATION_REASON

    async def test_handoff_phase_index_increments(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id)
        await HandoffEvent(
            service_request_id=sr.id,
            organisation_id=ORG,
            kind=HandoffKindEnum.REASSIGNMENT,
            phase_index=1,
            happened_at=utcnow(),
            created_on=utcnow(),
        ).insert()

        await _apply_workflow_auto_escalate(sr)

        handoffs = await HandoffEvent.find({"service_request_id": sr.id}).to_list()
        assert sorted(h.phase_index for h in handoffs) == [1, 2]


class TestGuards:
    async def test_does_nothing_when_escalation_is_disabled(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id, enabled=False)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == EXECUTOR
        assert after.is_escalated is False
        quiet["email"].assert_not_awaited()

    async def test_does_nothing_without_a_target(self, quiet):
        sr = await _make_ticket()
        await _make_ec(sr.workflow_id, target=None)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.is_escalated is False

    async def test_does_nothing_with_no_escalation_config(self, quiet):
        sr = await _make_ticket()

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.is_escalated is False

    async def test_skips_when_already_owned_by_the_target(self, quiet):
        """No self-handoff, and no spurious HandoffEvent."""
        sr = await _make_ticket(executor=TARGET)
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.is_escalated is False
        assert await HandoffEvent.find({"service_request_id": sr.id}).count() == 0

    async def test_ignores_terminal_tickets(self, quiet):
        sr = await _make_ticket(status=RequestStatusEnum.CLOSED)
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.executor_user_id == EXECUTOR
        assert after.is_escalated is False


class TestOtherPhases:
    async def test_unassigned_ticket_jumps_to_assigned(self, quiet):
        sr = await _make_ticket(
            status=RequestStatusEnum.PENDING_ASSIGNMENT, executor=None
        )
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.request_status == RequestStatusEnum.ASSIGNED
        assert after.executor_user_id == TARGET

    async def test_approval_phase_sets_the_override_approver(self, quiet):
        sr = await _make_ticket(status=RequestStatusEnum.PENDING_APPROVAL)
        await _make_ec(sr.workflow_id)

        await _apply_workflow_auto_escalate(sr)

        after = await ServiceRequest.get(sr.id)
        assert after.escalation_override_approver_user_id == TARGET
        # Executor is untouched — this is an approver redirect, not a handoff.
        assert after.executor_user_id == EXECUTOR
        assert await HandoffEvent.find({"service_request_id": sr.id}).count() == 0
