"""Breach mail to the SLA rule's configured notification recipients.

Two failures here are silent in production, which is why they get tests:

  * every recipient sharing one outbox idempotency key. The key is uniquely
    indexed and `outbox.publish` treats a duplicate as already-sent, so a fan-out
    that does not vary the key mails the first person and drops the rest without
    raising. It also has to differ from the assignee's mail for the same ticket
    and deadline, or whichever is written first wins and the other vanishes.
  * describing the wrong deadline. Violation actions run for a first_response
    breach exactly as they do for resolution, so a hardcoded breach_type quotes
    the wrong kind and the wrong due date to real people.
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
    ContactSnapshot,
    OutboxEventDocument,
    PriorityEnum,
    RequestStatusEnum,
    ServiceRequest,
    SLARule,
    SLAViolationAction,
)
from src.requests.service_sla_tick import _notify_recipients


pytestmark = pytest.mark.asyncio


ORG = PydanticObjectId()
_ticket_seq = count(1)


@pytest_asyncio.fixture(autouse=True)
async def clean_slate():
    yield
    await ServiceRequest.get_motor_collection().delete_many({})


async def _make_ticket():
    now = utcnow()
    sr = ServiceRequest(
        ticket_no=f"SR-2026-{next(_ticket_seq):06d}",
        organisation_id=ORG,
        requester_user_id=PydanticObjectId(),
        category_id=PydanticObjectId(),
        request_type_id=PydanticObjectId(),
        workflow_id=PydanticObjectId(),
        priority=PriorityEnum.HIGH,
        title="Printer is on fire",
        request_status=RequestStatusEnum.IN_PROGRESS,
        primary_assignee_user_id=PydanticObjectId(),
        executor_user_id=PydanticObjectId(),
        first_response_due_by=now - timedelta(hours=6),
        resolution_due_by=now - timedelta(hours=1),
        created_on=now,
    )
    await sr.insert()
    return sr


def _rule(*emails):
    return SLARule(
        priority=PriorityEnum.HIGH,
        first_response_minutes=60,
        resolution_minutes=480,
        violation_actions=[SLAViolationAction.CHANGE_PRIORITY],
        notification_recipient_contacts=[
            ContactSnapshot(user_id=str(PydanticObjectId()), email=e, name=e.split("@")[0])
            for e in emails
        ],
    )


class TestEveryRecipientIsMailed:
    async def test_three_recipients_produce_three_emails(self):
        """The regression: one shared key meant only the first was published."""
        sr = await _make_ticket()
        rule = _rule("a@example.com", "b@example.com", "c@example.com")

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            await _notify_recipients(sr, rule, "resolution")

        assert pub.await_count == 3
        assert {c.kwargs["to"] for c in pub.await_args_list} == {
            "a@example.com",
            "b@example.com",
            "c@example.com",
        }

    async def test_each_recipient_gets_a_distinct_idempotency_key(self):
        sr = await _make_ticket()
        rule = _rule("a@example.com", "b@example.com")

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            await _notify_recipients(sr, rule, "resolution")

        suffixes = [c.kwargs["idempotency_suffix"] for c in pub.await_args_list]
        assert len(set(suffixes)) == 2

    async def test_the_keys_survive_the_outbox_uniqueness_constraint(self):
        """End-to-end through the real outbox, since the constraint is what
        actually swallowed the duplicates — a distinct-strings assertion alone
        would not have caught the original bug's consequence."""
        sr = await _make_ticket()
        rule = _rule("a@example.com", "b@example.com", "c@example.com")

        await _notify_recipients(sr, rule, "resolution")

        published = await OutboxEventDocument.find(
            {"event_type": "email.srm.sla_breached"}
        ).to_list()
        # The outbox row holds the envelope; the email itself is nested inside it.
        assert len({e.payload["payload"]["to"] for e in published}) == 3

    async def test_recipient_keys_do_not_collide_with_the_assignee_mail(self):
        """The assignee is mailed separately for the same ticket and deadline."""
        from src.email_events import notify_sla_breached

        sr = await _make_ticket()
        rule = _rule("recipient@example.com")

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            # No discriminator — this is the assignee path.
            await notify_sla_breached(
                assignee_email="assignee@example.com",
                assignee_name="Assignee",
                ticket_no=sr.ticket_no,
                title=sr.title,
                breach_type="resolution",
            )
            await _notify_recipients(sr, rule, "resolution")

        suffixes = [c.kwargs["idempotency_suffix"] for c in pub.await_args_list]
        assert len(set(suffixes)) == 2

    async def test_the_assignee_mail_still_dedupes_per_ticket_and_kind(self):
        """Widening the key must not cost the dedupe we do want."""
        from src.email_events import notify_sla_breached

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            for _ in range(2):
                await notify_sla_breached(
                    assignee_email="assignee@example.com",
                    assignee_name="Assignee",
                    ticket_no="SR-2026-999999",
                    title="t",
                    breach_type="resolution",
                )

        a, b = [c.kwargs["idempotency_suffix"] for c in pub.await_args_list]
        assert a == b


class TestTheMailDescribesTheRightDeadline:
    async def test_a_first_response_breach_says_so(self):
        sr = await _make_ticket()
        rule = _rule("a@example.com")

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            await _notify_recipients(sr, rule, "first_response")

        data = pub.await_args_list[0].kwargs["template_data"]
        assert data["sla_due_at"] == sr.first_response_due_by.isoformat()
        assert "first_response" in pub.await_args_list[0].kwargs["idempotency_suffix"]

    async def test_a_resolution_breach_quotes_the_resolution_deadline(self):
        sr = await _make_ticket()
        rule = _rule("a@example.com")

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            await _notify_recipients(sr, rule, "resolution")

        data = pub.await_args_list[0].kwargs["template_data"]
        assert data["sla_due_at"] == sr.resolution_due_by.isoformat()

    async def test_the_two_kinds_do_not_share_a_key(self):
        """Same ticket can breach first_response and later resolution; both
        must reach the recipient."""
        sr = await _make_ticket()
        rule = _rule("a@example.com")

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            await _notify_recipients(sr, rule, "first_response")
            await _notify_recipients(sr, rule, "resolution")

        a, b = [c.kwargs["idempotency_suffix"] for c in pub.await_args_list]
        assert a != b


class TestNoContacts:
    async def test_a_rule_with_no_contacts_mails_nobody(self):
        """Rules saved before the snapshot existed. Documented behaviour — the
        warning log is the remediation path, not an error."""
        sr = await _make_ticket()
        rule = SLARule(
            priority=PriorityEnum.HIGH,
            first_response_minutes=60,
            resolution_minutes=480,
            notification_recipients=[PydanticObjectId()],
        )

        with patch(
            "src.email_events._publish_email", new_callable=AsyncMock
        ) as pub:
            await _notify_recipients(sr, rule, "resolution")

        pub.assert_not_awaited()
