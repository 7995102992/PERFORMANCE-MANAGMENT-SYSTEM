"""Unit tests for src.audit — audit outbox publishing for the schedule service.

Covers the behaviour that matters for events actually reaching the central
Logging Service:
  * routing-key sanitization (dotted actions must collapse to a single segment
    so they match the consumer's ``audit.*`` binding),
  * outbox document shape / standard payload contract,
  * eager-publish success vs. broker-down (stays pending for the relay),
  * emit_audit defaults, and the relay loop draining pending/failed events.

These tests use in-memory fakes for both the motor DB and the RabbitMQ
connection, so no live Mongo/RabbitMQ is required.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from pymongo.errors import DuplicateKeyError

from src import audit
from src.audit import (
    AUDIT_EXCHANGE,
    DebugLevel,
    _relay_batch,
    emit_audit,
    emit_audit_safe,
    publish_audit_log,
)


# ── Fakes ──────────────────────────────────────────────────────────────────────
class FakeExchange:
    def __init__(self) -> None:
        self.name: str | None = None
        self.published: list[dict] = []

    async def publish(self, message, routing_key):
        self.published.append({"message": message, "routing_key": routing_key})


class _ChannelCtx:
    def __init__(self, exchange: FakeExchange) -> None:
        self._exchange = exchange

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def declare_exchange(self, name, type_, durable):
        self._exchange.name = name
        return self._exchange


class FakeConnection:
    def __init__(self, exchange: FakeExchange, *, is_closed: bool = False) -> None:
        self._exchange = exchange
        self.is_closed = is_closed

    def channel(self):
        return _ChannelCtx(self._exchange)


def _matches(doc: dict, flt: dict) -> bool:
    for key, cond in flt.items():
        value = doc.get(key)
        if isinstance(cond, dict):
            if "$in" in cond and value not in cond["$in"]:
                return False
            if "$lt" in cond and not (value < cond["$lt"]):
                return False
        elif value != cond:
            return False
    return True


class FakeCursor:
    def __init__(self, docs: list[dict]) -> None:
        self._docs = list(docs)

    def sort(self, field, direction):
        self._docs.sort(key=lambda d: d.get(field), reverse=direction == -1)
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return list(self._docs if length is None else self._docs[:length])


class FakeCollection:
    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}

    async def insert_one(self, doc):
        if any(d["idempotency_key"] == doc["idempotency_key"] for d in self.docs.values()):
            raise DuplicateKeyError("duplicate idempotency_key")
        self.docs[doc["_id"]] = dict(doc)

    async def update_one(self, flt, update):
        doc = self.docs.get(flt["_id"])
        if doc is None:
            return
        for k, v in update.get("$set", {}).items():
            doc[k] = v
        for k, v in update.get("$inc", {}).items():
            doc[k] = doc.get(k, 0) + v

    def find(self, flt):
        return FakeCursor([d for d in self.docs.values() if _matches(d, flt)])


class FakeDB:
    def __init__(self) -> None:
        self._collections: dict[str, FakeCollection] = {}

    def __getitem__(self, name) -> FakeCollection:
        return self._collections.setdefault(name, FakeCollection())


# ── Fixtures ────────────────────────────────────────────────────────────────────
@pytest.fixture
def fake_db(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(audit, "get_db", lambda: db)
    return db


@pytest.fixture
def broker_ready(monkeypatch):
    exchange = FakeExchange()
    monkeypatch.setattr("src.rabbitmq.rabbitmq_connection", FakeConnection(exchange))
    return exchange


@pytest.fixture
def broker_down(monkeypatch):
    monkeypatch.setattr("src.rabbitmq.rabbitmq_connection", None)


def _only_doc(db: FakeDB) -> dict:
    coll = db["audit_outbox_events"]
    assert len(coll.docs) == 1
    return next(iter(coll.docs.values()))


def _outbox_doc(
    _id: str,
    *,
    status: str = "pending",
    retries: int = 0,
    routing_key: str = "audit.task_failed",
) -> dict:
    return {
        "_id": _id,
        "idempotency_key": f"audit:{_id}",
        "exchange": AUDIT_EXCHANGE,
        "routing_key": routing_key,
        "payload": {"action": "task.failed"},
        "status": status,
        "retries": retries,
        "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "sent_at": None,
        "correlation_id": None,
    }


# ── Routing-key sanitization (the whole point) ──────────────────────────────────
class TestRoutingKeySanitization:
    async def test_dotted_action_collapsed_to_single_segment(self, fake_db, broker_down):
        await publish_audit_log(
            module="schedule", actor_id="system",
            action="task.succeeded", resource="task:email.send",
        )
        doc = _only_doc(fake_db)
        assert doc["routing_key"] == "audit.task_succeeded"
        # Exactly one segment after "audit." so it matches the "audit.*" binding.
        assert doc["routing_key"].count(".") == 1

    async def test_payload_action_keeps_original_dotted_value(self, fake_db, broker_down):
        await publish_audit_log(
            module="schedule", actor_id="system",
            action="task.succeeded", resource="task:x",
        )
        assert _only_doc(fake_db)["payload"]["action"] == "task.succeeded"

    async def test_single_word_action_unchanged(self, fake_db, broker_down):
        await publish_audit_log(
            module="schedule", actor_id="system",
            action="login", resource="user:1",
        )
        assert _only_doc(fake_db)["routing_key"] == "audit.login"


# ── Outbox document shape / payload contract ────────────────────────────────────
class TestOutboxDocShape:
    async def test_doc_and_payload_shape(self, fake_db, broker_down):
        await publish_audit_log(
            module="schedule", actor_id="u1",
            action="auth.login_failed", resource="user:u1",
            debug_level=DebugLevel.ADMIN, metadata={"reason": "bad_password"},
        )
        doc = _only_doc(fake_db)
        assert doc["exchange"] == AUDIT_EXCHANGE == "audit_events"
        assert doc["idempotency_key"].startswith("audit:")
        assert doc["status"] == "pending"
        assert doc["retries"] == 0
        assert doc["sent_at"] is None

        payload = doc["payload"]
        assert set(payload) == {
            "timestamp", "module", "actor_id", "action",
            "resource", "debug_level", "metadata",
        }
        assert payload["module"] == "schedule"
        assert payload["actor_id"] == "u1"
        assert payload["resource"] == "user:u1"
        assert payload["debug_level"] == 4  # ADMIN, serialized as int
        assert isinstance(payload["debug_level"], int)
        assert payload["metadata"] == {"reason": "bad_password"}

    async def test_duplicate_idempotency_key_is_swallowed(self, fake_db, broker_down, monkeypatch):
        monkeypatch.setattr(audit, "uuid4", lambda: "fixed-id")
        await publish_audit_log(module="m", actor_id="a", action="x", resource="r")
        # Second call collides on idempotency_key -> insert raises, handled gracefully.
        await publish_audit_log(module="m", actor_id="a", action="x", resource="r")
        assert len(fake_db["audit_outbox_events"].docs) == 1


# ── Eager publish ───────────────────────────────────────────────────────────────
class TestEagerPublish:
    async def test_marks_sent_on_success(self, fake_db, broker_ready):
        await publish_audit_log(
            module="schedule", actor_id="system",
            action="task.succeeded", resource="task:x",
        )
        doc = _only_doc(fake_db)
        assert doc["status"] == "sent"
        assert doc["sent_at"] is not None
        assert len(broker_ready.published) == 1
        assert broker_ready.published[0]["routing_key"] == "audit.task_succeeded"
        assert broker_ready.name == "audit_events"

    async def test_stays_pending_when_broker_down(self, fake_db, broker_down):
        await publish_audit_log(
            module="schedule", actor_id="system",
            action="task.failed", resource="task:x",
        )
        doc = _only_doc(fake_db)
        assert doc["status"] == "pending"
        assert doc["sent_at"] is None

    async def test_stays_pending_when_connection_closed(self, fake_db, monkeypatch):
        exchange = FakeExchange()
        monkeypatch.setattr(
            "src.rabbitmq.rabbitmq_connection", FakeConnection(exchange, is_closed=True),
        )
        await publish_audit_log(
            module="schedule", actor_id="system",
            action="task.failed", resource="task:x",
        )
        assert _only_doc(fake_db)["status"] == "pending"
        assert exchange.published == []


# ── emit_audit convenience wrapper ──────────────────────────────────────────────
class TestEmitAudit:
    async def test_defaults(self, fake_db, broker_down):
        await emit_audit(action="credentials.loaded")
        payload = _only_doc(fake_db)["payload"]
        assert payload["actor_id"] == "system"
        assert payload["resource"] == "schedule:credentials.loaded"
        assert payload["debug_level"] == int(DebugLevel.ADMIN)
        assert payload["module"] == "schedule"
        assert payload["metadata"]["stream"] == "audit"
        assert payload["metadata"]["details"] == {}

    async def test_passes_through_fields(self, fake_db, broker_down):
        await emit_audit(
            action="email.sent", actor_id="u9", tenant_id="t1",
            resource="email:welcome", debug_level=DebugLevel.EMPLOYEE,
            details={"to": "x@y.z"}, correlation_id="corr-1",
        )
        doc = _only_doc(fake_db)
        assert doc["routing_key"] == "audit.email_sent"
        assert doc["correlation_id"] == "corr-1"
        meta = doc["payload"]["metadata"]
        assert meta["organisation_id"] == "t1"
        assert meta["details"] == {"to": "x@y.z"}
        assert meta["correlation_id"] == "corr-1"
        assert doc["payload"]["debug_level"] == 1

    async def test_emit_audit_safe_swallows_errors(self, monkeypatch):
        def boom():
            raise RuntimeError("db down")

        monkeypatch.setattr(audit, "get_db", boom)
        # Must not raise — audit failures never break the audited work.
        await emit_audit_safe(action="task.succeeded")


# ── Relay loop ──────────────────────────────────────────────────────────────────
class TestRelay:
    async def test_resends_pending(self, fake_db, broker_ready):
        coll = fake_db["audit_outbox_events"]
        coll.docs["e1"] = _outbox_doc("e1")
        await _relay_batch()
        assert coll.docs["e1"]["status"] == "sent"
        assert coll.docs["e1"]["sent_at"] is not None
        assert len(broker_ready.published) == 1

    async def test_increments_retries_on_failure(self, fake_db, broker_down):
        coll = fake_db["audit_outbox_events"]
        coll.docs["e2"] = _outbox_doc("e2")
        await _relay_batch()
        assert coll.docs["e2"]["status"] == "failed"
        assert coll.docs["e2"]["retries"] == 1

    async def test_skips_events_at_max_retries(self, fake_db, broker_down):
        coll = fake_db["audit_outbox_events"]
        coll.docs["e3"] = _outbox_doc("e3", status="failed", retries=audit.MAX_RETRIES)
        await _relay_batch()
        # At the retry ceiling -> not selected, left untouched.
        assert coll.docs["e3"]["retries"] == audit.MAX_RETRIES
