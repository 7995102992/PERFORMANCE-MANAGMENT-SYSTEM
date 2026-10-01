"""Tests for src.rabbitmq.outbox — transactional outbox pattern."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.models import OutboxEventDocument
from src.rabbitmq.constants import domain_events_config, audit_logging_config
from src.rabbitmq.outbox import (
    publish,
    publish_event,
    publish_audit_log,
    _relay_batch,
    _try_publish,
    ROUTING_KEYS,
)


# ── publish() ────────────────────────────────────────────────────────────────

class TestPublish:
    async def test_persists_event_to_outbox(self, mock_rabbitmq_down):
        event_id = await publish(
            "test.event",
            {"key": "value"},
            idempotency_key="test-key-1",
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc is not None
        assert doc.event_type == "test.event"
        assert doc.payload == {"key": "value"}
        assert doc.idempotency_key == "test-key-1"
        assert doc.status == "pending"
        assert doc.exchange == domain_events_config.EXCHANGE_NAME
        assert doc.retries == 0

    async def test_eager_publish_marks_sent_on_success(
        self, mock_rabbitmq_ready, mock_channel
    ):
        event_id = await publish(
            "test.event",
            {"key": "value"},
            idempotency_key="test-key-2",
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc.status == "sent"
        assert doc.sent_at is not None

    async def test_stays_pending_when_broker_down(self, mock_rabbitmq_down):
        event_id = await publish(
            "test.event",
            {"key": "value"},
            idempotency_key="test-key-3",
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc.status == "pending"
        assert doc.sent_at is None

    async def test_custom_exchange(self, mock_rabbitmq_down):
        event_id = await publish(
            "email.activation",
            {"to": "user@example.com"},
            idempotency_key="email-key-1",
            exchange="email_events",
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc.exchange == "email_events"

    async def test_a_duplicate_idempotency_key_is_absorbed(self, mock_rabbitmq_down):
        """The unique index is still there, but `publish` catches the
        DuplicateKeyError and hands back the id of the row already in the
        outbox. Raising instead would push the decision onto every call site —
        and those are audit emits, SLA breach mails and domain events, none of
        which should fail the operation they are recording because a retry or a
        replay reused the key.
        """
        first = await publish("ev1", {"a": 1}, idempotency_key="dup-key")
        second = await publish("ev2", {"b": 2}, idempotency_key="dup-key")

        assert second == first
        docs = await OutboxEventDocument.find(
            {"idempotency_key": "dup-key"}
        ).to_list()
        assert len(docs) == 1
        # The first write wins — the duplicate is dropped, not merged.
        assert docs[0].event_type == "ev1"
        assert docs[0].payload == {"a": 1}


# ── publish_event() (drop-in replacement) ────────────────────────────────────

class TestPublishEvent:
    async def test_resolves_known_routing_key(self, mock_rabbitmq_down):
        event_id = await publish_event("submitted", {"ticket": "SR-2026-000001"})
        doc = await OutboxEventDocument.get(event_id)
        assert doc.event_type == "srm.request.submitted"

    async def test_falls_back_to_default_routing_key(self, mock_rabbitmq_down):
        event_id = await publish_event("custom_action", {"data": 1})
        doc = await OutboxEventDocument.get(event_id)
        assert doc.event_type == "srm.request.custom_action"

    async def test_all_known_routing_keys_mapped(self, mock_rabbitmq_down):
        for key, expected_rk in ROUTING_KEYS.items():
            eid = await publish_event(key, {"test": key})
            doc = await OutboxEventDocument.get(eid)
            assert doc.event_type == expected_rk, f"Mismatch for {key}"


# ── publish_audit_log() ──────────────────────────────────────────────────────

class TestPublishAuditLog:
    async def test_audit_event_structure(self, mock_rabbitmq_down):
        event_id = await publish_audit_log(
            module="srm",
            actor_id="user_123",
            action="created",
            resource="request:req_456",
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc.event_type == "audit.created"
        assert doc.exchange == audit_logging_config.EXCHANGE_NAME
        assert doc.payload["module"] == "srm"
        assert doc.payload["actor_id"] == "user_123"
        assert doc.payload["action"] == "created"
        assert doc.payload["resource"] == "request:req_456"
        assert doc.payload["debug_level"] == 4  # ADMIN default
        assert "timestamp" in doc.payload
        assert doc.idempotency_key.startswith("audit:")

    async def test_audit_with_metadata(self, mock_rabbitmq_down):
        event_id = await publish_audit_log(
            module="categories",
            actor_id="user_789",
            action="deleted",
            resource="category:cat_001",
            metadata={"category_name": "IT Support"},
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc.payload["metadata"] == {"category_name": "IT Support"}

    async def test_audit_custom_debug_level(self, mock_rabbitmq_down):
        from src.rabbitmq.constants import DebugLevel

        event_id = await publish_audit_log(
            module="requests",
            actor_id="user_001",
            action="submitted",
            resource="request:req_001",
            debug_level=DebugLevel.EMPLOYEE,
        )
        doc = await OutboxEventDocument.get(event_id)
        assert doc.payload["debug_level"] == 1


# ── _try_publish() ───────────────────────────────────────────────────────────

class TestTryPublish:
    async def test_returns_false_when_broker_down(self, mock_rabbitmq_down):
        event = OutboxEventDocument(
            idempotency_key="try-pub-1",
            event_type="test.event",
            payload={"x": 1},
            status="pending",
            retries=0,
            created_at="2026-04-27T00:00:00Z",
        )
        assert await _try_publish(event) is False

    async def test_returns_true_on_success(self, mock_rabbitmq_ready, mock_channel):
        event = OutboxEventDocument(
            idempotency_key="try-pub-2",
            event_type="test.event",
            payload={"x": 1},
            status="pending",
            retries=0,
            created_at="2026-04-27T00:00:00Z",
        )
        assert await _try_publish(event) is True
        mock_channel["exchange"].publish.assert_called_once()

    async def test_returns_false_on_publish_error(self, mock_rabbitmq_ready, mock_channel):
        mock_channel["exchange"].publish.side_effect = Exception("broker error")
        event = OutboxEventDocument(
            idempotency_key="try-pub-3",
            event_type="test.event",
            payload={"x": 1},
            status="pending",
            retries=0,
            created_at="2026-04-27T00:00:00Z",
        )
        assert await _try_publish(event) is False


# ── _relay_batch() ───────────────────────────────────────────────────────────

class TestRelayBatch:
    async def test_relay_sends_pending_events(self, mock_rabbitmq_ready, mock_channel):
        await publish("relay.test", {"n": 1}, idempotency_key="relay-1")
        # Force status back to pending (eager publish would've sent it)
        doc = await OutboxEventDocument.find_one({"idempotency_key": "relay-1"})
        doc.status = "pending"
        doc.sent_at = None
        await doc.save()

        await _relay_batch()

        doc = await OutboxEventDocument.find_one({"idempotency_key": "relay-1"})
        assert doc.status == "sent"
        assert doc.sent_at is not None

    async def test_relay_skips_the_whole_batch_when_the_broker_is_down(
        self, mock_rabbitmq_down
    ):
        """A broker outage is not a per-message failure. `_relay_batch` returns
        before it reads anything, so an hour of downtime costs no retries —
        otherwise every queued event would burn its budget and dead-letter
        itself while perfectly valid."""
        eid = await publish("relay.down", {"n": 2}, idempotency_key="relay-down-1")

        await _relay_batch()

        doc = await OutboxEventDocument.get(eid)
        assert doc.status == "pending"
        assert doc.retries == 0

    async def test_relay_increments_retries_but_stays_pending_below_the_cap(
        self, mock_rabbitmq_ready, mock_publish_fails
    ):
        """Broker up, this one message won't go. That is the genuine failure the
        retry budget is for — count it, but leave the event eligible for the
        next tick."""
        eid = await publish("relay.fail", {"n": 2}, idempotency_key="relay-fail-1")

        await _relay_batch()

        doc = await OutboxEventDocument.get(eid)
        assert doc.retries == 1
        assert doc.status == "pending"
        assert doc.dead_lettered_at is None

    async def test_relay_dead_letters_once_the_cap_is_reached(
        self, mock_rabbitmq_ready, mock_publish_fails
    ):
        """`failed` means dead, not "failed once" — it is the terminal state, and
        the relay query excludes it via `retries < MAX_RETRIES` so nothing picks
        the row up again. The row survives for replay."""
        eid = await publish("relay.dead", {"n": 3}, idempotency_key="relay-dead-1")
        doc = await OutboxEventDocument.get(eid)
        doc.retries = domain_events_config.MAX_RETRIES - 1
        await doc.save()

        await _relay_batch()

        doc = await OutboxEventDocument.get(eid)
        assert doc.retries == domain_events_config.MAX_RETRIES
        assert doc.status == "failed"
        assert doc.dead_lettered_at is not None

    async def test_relay_skips_events_at_max_retries(
        self, mock_rabbitmq_ready, mock_publish_fails
    ):
        eid = await publish("relay.max", {"n": 4}, idempotency_key="relay-max-1")
        doc = await OutboxEventDocument.get(eid)
        doc.retries = domain_events_config.MAX_RETRIES
        await doc.save()

        await _relay_batch()

        doc = await OutboxEventDocument.get(eid)
        # retries should not have incremented further
        assert doc.retries == domain_events_config.MAX_RETRIES

    async def test_relay_processes_failed_events(self, mock_rabbitmq_ready, mock_channel):
        eid = await publish("relay.retry", {"n": 4}, idempotency_key="relay-retry-1")
        doc = await OutboxEventDocument.get(eid)
        doc.status = "failed"
        doc.retries = 3
        doc.sent_at = None
        await doc.save()

        await _relay_batch()

        doc = await OutboxEventDocument.get(eid)
        assert doc.status == "sent"

    async def test_relay_ignores_already_sent(self, mock_rabbitmq_ready, mock_channel):
        eid = await publish("relay.sent", {"n": 5}, idempotency_key="relay-sent-1")
        # Already sent by eager publish; reset mock to verify relay doesn't re-publish
        mock_channel["exchange"].publish.reset_mock()

        await _relay_batch()

        mock_channel["exchange"].publish.assert_not_called()
