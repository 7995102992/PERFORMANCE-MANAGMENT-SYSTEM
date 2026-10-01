"""Whether a ticket's SLA rule is still in force — and still findable.

Two defects sit behind one symptom: a breach firing for a ticket whose SLA an
admin had switched off.

  * ``update_request_type`` rebuilds ``rt.sla_rules`` from the payload, and
    ``SLARule.id`` defaults to a fresh uuid4, so every save re-minted all four
    ids. ``sr.sla_rule_id`` is a snapshot taken at ticket creation, so from the
    next save onwards no in-flight ticket could resolve its rule — violation
    actions stopped running, silently, for a reason no admin had chosen.
  * the tick resolved that rule without the active/deleted filters
    ``resolve_sla_for_priority`` applies, so a rule switched to INACTIVE — the
    only per-priority off switch there is, since ``_check_rules`` makes all four
    priorities mandatory and a rule can never be removed — still read as live.

Together they meant "SLA inactive" changed nothing about what the tick did, and
"SLA active" changed nothing either once anyone had saved the request type.

The third piece is the gate itself: the breach branch was never conditional on
the rule — only violation actions were — so even once resolution was correct the
assignee still got mailed about an SLA nobody was enforcing.
``TestNoRuleNoBreach`` covers that, including the control that proves the gate
did not simply switch breaches off wholesale.
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
    Category,
    PriorityEnum,
    RequestStatusEnum,
    RequestType,
    ServiceRequest,
    SLADeadline,
    SLARule,
    SLAViolationAction,
    StatusEnum,
)
from src.request_types.schemas import RequestTypeUpdate
from src.request_types.service import update_request_type
from src.requests.service_sla_tick import run_sla_tick
from src.sla_store import enrol


pytestmark = pytest.mark.asyncio


ORG = PydanticObjectId()
_ticket_seq = count(1)

ALL_PRIORITIES = [
    PriorityEnum.LOW,
    PriorityEnum.MEDIUM,
    PriorityEnum.HIGH,
    PriorityEnum.URGENT,
]


@pytest_asyncio.fixture(autouse=True)
async def clean_slate():
    yield
    await ServiceRequest.get_motor_collection().delete_many({})
    await SLADeadline.get_motor_collection().delete_many({})
    await RequestType.get_motor_collection().delete_many({})
    await Category.get_motor_collection().delete_many({})


class _User:
    """The admin doing the save. `update_request_type` reads only these."""

    id = PydanticObjectId()
    organisation_id = str(ORG)  # `_load_rt` compares this as a string
    is_super_admin = True


def _rules(*, resolution_minutes: int = 480) -> list[SLARule]:
    """One rule per priority — the shape the schema validator enforces."""
    now = utcnow()
    return [
        SLARule(
            priority=p,
            first_response_minutes=60,
            resolution_minutes=resolution_minutes,
            violation_actions=[SLAViolationAction.CHANGE_PRIORITY],
            created_by=_User.id,
            created_on=now,
        )
        for p in ALL_PRIORITIES
    ]


def _payload_rules(*, resolution_minutes: int = 480) -> list[dict]:
    return [
        {
            "priority": p.value,
            "first_response_minutes": 60,
            "resolution_minutes": resolution_minutes,
            "business_hours_only": True,
            "violation_actions": ["change_priority"],
        }
        for p in ALL_PRIORITIES
    ]


async def _make_request_type(rules: list[SLARule] | None = None) -> RequestType:
    now = utcnow()
    seq = next(_ticket_seq)
    cat = Category(
        organisation_id=ORG,
        department_id=PydanticObjectId(),
        business_unit_id=PydanticObjectId(),
        name=f"Hardware {seq}",
        name_lc=f"hardware {seq}",
        created_on=now,
    )
    await cat.insert()
    rt = RequestType(
        organisation_id=ORG,
        category_id=cat.id,
        name=f"Laptop {seq}",
        name_lc=f"laptop {seq}",
        sla_rules=rules if rules is not None else _rules(),
        created_on=now,
    )
    await rt.insert()
    return rt


async def _make_ticket(rt: RequestType, rule: SLARule) -> ServiceRequest:
    """A HIGH ticket, past its resolution deadline, raised under *rule*."""
    now = utcnow()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=ORG,
        requester_user_id=PydanticObjectId(),
        category_id=rt.category_id,
        request_type_id=rt.id,
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.HIGH,
        title="Printer is on fire",
        request_status=RequestStatusEnum.IN_PROGRESS,
        primary_assignee_user_id=PydanticObjectId(),
        executor_user_id=PydanticObjectId(),
        sla_rule_id=str(rule.id),
        resolution_due_by=now - timedelta(hours=1),
        created_on=now,
    )
    await sr.insert()
    await enrol({f"{sr.id}:resolution": sr.resolution_due_by.timestamp()})
    return sr


def _high(rt: RequestType) -> SLARule:
    return next(r for r in rt.sla_rules if r.priority == PriorityEnum.HIGH)


@pytest.fixture
def spy():
    """Hold every outbound edge, so a tick reaches no broker and no mailbox."""
    with (
        patch("src.requests.service_sla_tick.publish_event", new_callable=AsyncMock),
        patch(
            "src.requests.service_sla_tick.notify_watcher_if_subscribed",
            new_callable=AsyncMock,
        ),
        patch("src.requests.service_sla_tick.emit_activity", new_callable=AsyncMock),
        patch("src.email_events.notify_sla_breached", new_callable=AsyncMock) as email,
        patch(
            "src.common.email_resolver.resolve_user_info",
            new_callable=AsyncMock,
            return_value={"email": "exec@example.com", "name": "Executor"},
        ),
    ):
        yield {"email": email}


# ── Rule ids survive a save ──────────────────────────────────────────────


class TestRuleIdsSurviveASave:
    async def test_ids_are_unchanged_by_an_update(self):
        rt = await _make_request_type()
        before = {r.priority: r.id for r in rt.sla_rules}

        await update_request_type(
            str(rt.id),
            RequestTypeUpdate(sla_rules=_payload_rules()),
            _User(),
        )

        saved = await RequestType.get(rt.id)
        assert {r.priority: r.id for r in saved.sla_rules} == before

    async def test_ids_survive_an_edit_to_the_values(self):
        """The point of the id is continuity across a *change*, not a no-op."""
        rt = await _make_request_type()
        before = {r.priority: r.id for r in rt.sla_rules}

        await update_request_type(
            str(rt.id),
            RequestTypeUpdate(sla_rules=_payload_rules(resolution_minutes=999)),
            _User(),
        )

        saved = await RequestType.get(rt.id)
        assert {r.priority: r.id for r in saved.sla_rules} == before
        assert _high(saved).resolution_minutes == 999

    async def test_an_in_flight_ticket_still_resolves_its_rule(self):
        """The regression, stated as the thing that actually broke."""
        rt = await _make_request_type()
        sr = await _make_ticket(rt, _high(rt))

        await update_request_type(
            str(rt.id),
            RequestTypeUpdate(sla_rules=_payload_rules(resolution_minutes=999)),
            _User(),
        )

        saved = await RequestType.get(rt.id)
        assert any(str(r.id) == sr.sla_rule_id for r in saved.sla_rules)

    async def test_creation_metadata_belongs_to_the_original_rule(self):
        rt = await _make_request_type()
        # Read it back before comparing: Mongo truncates to milliseconds and
        # returns naive UTC, so the in-memory value never equals the stored one.
        created_on = _high(await RequestType.get(rt.id)).created_on

        await update_request_type(
            str(rt.id),
            RequestTypeUpdate(sla_rules=_payload_rules(resolution_minutes=999)),
            _User(),
        )

        saved = _high(await RequestType.get(rt.id))
        assert saved.created_on == created_on
        assert saved.modified_on is not None

    async def test_ids_are_minted_for_rules_that_never_had_one(self):
        """A request type saved before this change carries no reusable ids."""
        rt = await _make_request_type(rules=[])

        await update_request_type(
            str(rt.id),
            RequestTypeUpdate(sla_rules=_payload_rules()),
            _User(),
        )

        saved = await RequestType.get(rt.id)
        ids = [r.id for r in saved.sla_rules]
        assert len(ids) == 4
        assert all(ids) and len(set(ids)) == 4


# ── The tick honours "not in force" ──────────────────────────────────────


class TestTheTickHonoursInactive:
    async def test_an_active_rule_still_applies_its_actions(self, spy):
        """Control. Without this the others pass for the wrong reason."""
        rt = await _make_request_type()
        sr = await _make_ticket(rt, _high(rt))

        await run_sla_tick()

        assert (await ServiceRequest.get(sr.id)).priority == PriorityEnum.URGENT

    async def test_an_inactive_rule_applies_nothing(self, spy):
        rules = _rules()
        next(r for r in rules if r.priority == PriorityEnum.HIGH).status = (
            StatusEnum.INACTIVE
        )
        rt = await _make_request_type(rules)
        sr = await _make_ticket(rt, _high(rt))

        await run_sla_tick()

        assert (await ServiceRequest.get(sr.id)).priority == PriorityEnum.HIGH

    async def test_a_soft_deleted_rule_applies_nothing(self, spy):
        rules = _rules()
        next(r for r in rules if r.priority == PriorityEnum.HIGH).deleted_on = utcnow()
        rt = await _make_request_type(rules)
        sr = await _make_ticket(rt, _high(rt))

        await run_sla_tick()

        assert (await ServiceRequest.get(sr.id)).priority == PriorityEnum.HIGH

    async def test_an_inactive_request_type_applies_nothing(self, spy):
        rt = await _make_request_type()
        rt.status = StatusEnum.INACTIVE
        await rt.save()
        sr = await _make_ticket(rt, _high(rt))

        await run_sla_tick()

        assert (await ServiceRequest.get(sr.id)).priority == PriorityEnum.HIGH

    async def test_a_deleted_request_type_applies_nothing(self, spy):
        rt = await _make_request_type()
        rt.deleted_on = utcnow()
        await rt.save()
        sr = await _make_ticket(rt, _high(rt))

        await run_sla_tick()

        assert (await ServiceRequest.get(sr.id)).priority == PriorityEnum.HIGH

    async def test_a_dangling_rule_id_applies_nothing(self, spy):
        """What every in-flight ticket looked like before the id fix."""
        rt = await _make_request_type()
        sr = await _make_ticket(rt, _high(rt))
        sr.sla_rule_id = str(PydanticObjectId())
        await sr.save()

        await run_sla_tick()

        assert (await ServiceRequest.get(sr.id)).priority == PriorityEnum.HIGH


class TestNoRuleNoBreach:
    """The reported symptom: SLA switched off, breach email still arriving.

    The email was never gated on the rule — only violation actions were — so
    every expression of "SLA inactive" left it sending. These assert the whole
    branch is skipped, not merely the actions: no breach counted, and nothing
    in the assignee's mailbox.
    """

    async def test_an_inactive_rule_emails_nobody(self, spy):
        rules = _rules()
        next(r for r in rules if r.priority == PriorityEnum.HIGH).status = (
            StatusEnum.INACTIVE
        )
        rt = await _make_request_type(rules)
        await _make_ticket(rt, _high(rt))

        summary = await run_sla_tick()

        assert summary["breaches"] == 0
        assert summary["skipped_no_rule"] == 1
        assert spy["email"].await_count == 0

    async def test_a_deleted_request_type_emails_nobody(self, spy):
        rt = await _make_request_type()
        rt.deleted_on = utcnow()
        await rt.save()
        await _make_ticket(rt, _high(rt))

        summary = await run_sla_tick()

        assert summary["breaches"] == 0
        assert summary["skipped_no_rule"] == 1
        assert spy["email"].await_count == 0

    async def test_an_active_rule_still_emails(self, spy):
        """Control — the gate must not have switched breaches off wholesale."""
        rt = await _make_request_type()
        await _make_ticket(rt, _high(rt))

        summary = await run_sla_tick()

        assert summary["breaches"] == 1
        assert summary["skipped_no_rule"] == 0
        assert spy["email"].await_count == 1

    async def test_one_ticket_going_quiet_does_not_silence_another(self, spy):
        """Per-entry, not per-tick: the gate `continue`s one member only."""
        live_rt = await _make_request_type()
        await _make_ticket(live_rt, _high(live_rt))

        rules = _rules()
        next(r for r in rules if r.priority == PriorityEnum.HIGH).status = (
            StatusEnum.INACTIVE
        )
        off_rt = await _make_request_type(rules)
        await _make_ticket(off_rt, _high(off_rt))

        summary = await run_sla_tick()

        assert summary["processed"] == 2
        assert summary["breaches"] == 1
        assert summary["skipped_no_rule"] == 1
        assert spy["email"].await_count == 1
