"""Tests for OutboxEventDocument model."""
from datetime import datetime, timezone

import pytest

from src.models import OutboxEventDocument


class TestOutboxEventDocument:
    async def test_create_and_retrieve(self, mock_rabbitmq_down):
        doc = OutboxEventDocument(
            idempotency_key="model-test-1",
            exchange="domain_events",
            event_type="test.model",
            payload={"foo": "bar"},
            status="pending",
            retries=0,
            created_at=datetime.now(timezone.utc),
        )
        await doc.insert()

        found = await OutboxEventDocument.get(doc.id)
        assert found is not None
        assert found.idempotency_key == "model-test-1"
        assert found.payload == {"foo": "bar"}
        assert found.status == "pending"

    async def test_auto_generated_id(self, mock_rabbitmq_down):
        doc1 = OutboxEventDocument(
            idempotency_key="id-test-1",
            event_type="test",
            payload={},
            created_at=datetime.now(timezone.utc),
        )
        doc2 = OutboxEventDocument(
            idempotency_key="id-test-2",
            event_type="test",
            payload={},
            created_at=datetime.now(timezone.utc),
        )
        assert doc1.id != doc2.id

    async def test_status_transitions(self, mock_rabbitmq_down):
        doc = OutboxEventDocument(
            idempotency_key="status-test-1",
            event_type="test",
            payload={},
            created_at=datetime.now(timezone.utc),
        )
        await doc.insert()
        assert doc.status == "pending"

        doc.status = "sent"
        doc.sent_at = datetime.now(timezone.utc)
        await doc.save()

        refreshed = await OutboxEventDocument.get(doc.id)
        assert refreshed.status == "sent"
        assert refreshed.sent_at is not None

    async def test_query_pending_events(self, mock_rabbitmq_down):
        now = datetime.now(timezone.utc)
        for i in range(3):
            await OutboxEventDocument(
                idempotency_key=f"query-test-{i}",
                event_type="test",
                payload={},
                status="pending" if i < 2 else "sent",
                created_at=now,
            ).insert()

        pending = await OutboxEventDocument.find(
            {"status": {"$in": ["pending", "failed"]}, "retries": {"$lt": 10}}
        ).to_list()
        assert len(pending) >= 2
