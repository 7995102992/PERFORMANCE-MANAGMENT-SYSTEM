"""Tests for src.audit — domain-shaped audit helpers via outbox.

Both helpers publish through ``outbox.publish_audit_log``, which is where the
canonical cross-service envelope is assembled (module / action / resource /
debug_level / metadata — see the module docstring in ``src/audit.py``). Two of
its properties are load-bearing enough to be asserted directly rather than
through a round number:

  * ``event_type`` is the AMQP routing key, and the Logging Service binds
    ``audit.*`` — one segment. So the dotted action is flattened with
    underscores on the way in (``request.submitted`` → ``audit.request_submitted``)
    while ``payload["action"]`` keeps the dotted form for display. Assert the
    two separately; asserting only one lets the other drift and the events are
    then silently dropped by the broker rather than failing anywhere.
  * activity events are request-scoped, so their action is namespaced
    ``request.<verb>`` and the id they carry lives in ``metadata.details``.
"""
from __future__ import annotations

import pytest

from src.audit import emit_activity, emit_audit
from src.models import ActivityEventEnum, OutboxEventDocument
from src.rabbitmq.constants import audit_logging_config


class TestEmitActivity:
    async def test_activity_event_published_to_outbox(self, mock_rabbitmq_down):
        await emit_activity(
            event=ActivityEventEnum.SUBMITTED,
            service_request_id="req_001",
            actor_user_id="user_123",
            organisation_id="org_456",
            details={"priority": "high"},
            correlation_id="corr_789",
        )
        docs = await OutboxEventDocument.find(
            {"event_type": "audit.request_submitted"}
        ).to_list()
        assert len(docs) >= 1
        doc = docs[-1]
        assert doc.exchange == audit_logging_config.EXCHANGE_NAME
        assert doc.payload["module"] == "srm"
        assert doc.payload["actor_id"] == "user_123"
        assert doc.payload["action"] == "request.submitted"
        assert doc.payload["resource"] == "request:req_001"
        assert doc.payload["debug_level"] == 1  # EMPLOYEE
        assert doc.payload["metadata"]["stream"] == "activity"
        assert doc.payload["metadata"]["organisation_id"] == "org_456"
        # The ticket id rides inside `details`, not beside it: the envelope has
        # a fixed shape across services and `service_request_id` is not one of
        # its fields.
        assert doc.payload["metadata"]["details"] == {
            "service_request_id": "req_001",
            "priority": "high",
        }
        assert doc.payload["metadata"]["correlation_id"] == "corr_789"

    async def test_activity_defaults_empty_details(self, mock_rabbitmq_down):
        await emit_activity(
            event=ActivityEventEnum.CLOSED,
            service_request_id="req_002",
            actor_user_id="user_001",
            organisation_id="org_001",
        )
        docs = await OutboxEventDocument.find(
            {"event_type": "audit.request_closed"}
        ).to_list()
        doc = docs[-1]
        # No caller details — the ticket id is still there on its own.
        assert doc.payload["metadata"]["details"] == {"service_request_id": "req_002"}

    async def test_every_activity_routing_key_is_a_single_segment(
        self, mock_rabbitmq_down
    ):
        """The Logging Service binds `audit.*`, which matches exactly one
        segment. An event value that ever picks up a dot would produce a
        three-segment key and be dropped by the broker with nothing raised
        anywhere — invisible until someone goes looking for the audit trail."""
        for event in ActivityEventEnum:
            await emit_activity(
                event=event,
                service_request_id=f"req_{event.value}",
                actor_user_id="user_test",
                organisation_id="org_test",
            )
        docs = await OutboxEventDocument.find(
            {"exchange": audit_logging_config.EXCHANGE_NAME}
        ).to_list()
        assert len(docs) >= len(ActivityEventEnum)
        for doc in docs:
            assert doc.event_type.count(".") == 1, doc.event_type
            assert doc.event_type.startswith("audit.")

    async def test_all_activity_events_publishable(self, mock_rabbitmq_down):
        for event in ActivityEventEnum:
            await emit_activity(
                event=event,
                service_request_id=f"req_{event.value}",
                actor_user_id="user_test",
                organisation_id="org_test",
            )
        count = await OutboxEventDocument.count()
        assert count >= len(ActivityEventEnum)


class TestEmitAudit:
    async def test_audit_event_published_to_outbox(self, mock_rabbitmq_down):
        await emit_audit(
            event="category.created",
            actor_user_id="admin_001",
            organisation_id="org_001",
            details={"category_name": "IT"},
            correlation_id="corr_001",
        )
        docs = await OutboxEventDocument.find(
            {"event_type": "audit.category_created"}
        ).to_list()
        assert len(docs) >= 1
        doc = docs[-1]
        assert doc.exchange == audit_logging_config.EXCHANGE_NAME
        assert doc.payload["module"] == "srm"
        assert doc.payload["actor_id"] == "admin_001"
        # The dotted form survives in the payload — only the routing key is
        # flattened.
        assert doc.payload["action"] == "category.created"
        assert doc.payload["debug_level"] == 4  # ADMIN
        assert doc.payload["metadata"]["stream"] == "audit"
        assert doc.payload["metadata"]["organisation_id"] == "org_001"
        assert doc.payload["metadata"]["details"] == {"category_name": "IT"}

    async def test_the_entity_id_is_lifted_into_the_resource(
        self, mock_rabbitmq_down
    ):
        """`details["id"]` is the instance the event is about, and the envelope
        carries it as `resource = "<entity>:<id>"`. It is popped on the way, so
        it must not also remain in details."""
        await emit_audit(
            event="category.updated",
            actor_user_id="admin_001",
            organisation_id="org_001",
            details={"id": "cat_77", "fields": ["name"], "category_name": "IT"},
        )
        doc = (
            await OutboxEventDocument.find(
                {"event_type": "audit.category_updated"}
            ).to_list()
        )[-1]
        assert doc.payload["resource"] == "category:cat_77"
        assert doc.payload["metadata"]["changed_fields"] == ["name"]
        assert doc.payload["metadata"]["details"] == {"category_name": "IT"}

    async def test_no_entity_id_falls_back_to_the_event_name(
        self, mock_rabbitmq_down
    ):
        """Nothing to point at — the resource still has to be non-empty for the
        Logging Service, so it names the event itself."""
        await emit_audit(
            event="category.created",
            actor_user_id="admin_001",
            organisation_id="org_001",
        )
        doc = (
            await OutboxEventDocument.find(
                {"event_type": "audit.category_created"}
            ).to_list()
        )[-1]
        assert doc.payload["resource"] == "srm:category.created"

    async def test_audit_with_none_actor(self, mock_rabbitmq_down):
        await emit_audit(
            event="system.cleanup",
            actor_user_id=None,
            organisation_id=None,
        )
        docs = await OutboxEventDocument.find(
            {"event_type": "audit.system_cleanup"}
        ).to_list()
        doc = docs[-1]
        assert doc.payload["actor_id"] == "system"

    async def test_audit_with_none_details(self, mock_rabbitmq_down):
        await emit_audit(
            event="workflow.updated",
            actor_user_id="user_x",
            organisation_id="org_x",
        )
        docs = await OutboxEventDocument.find(
            {"event_type": "audit.workflow_updated"}
        ).to_list()
        doc = docs[-1]
        assert doc.payload["metadata"]["details"] == {}
        # Absent, not None: the consumer treats the key's presence as "this was
        # an update and here is what changed".
        assert "changed_fields" not in doc.payload["metadata"]
