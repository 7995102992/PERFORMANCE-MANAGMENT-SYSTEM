"""Shared models: base classes, mixins, enums, and the transactional outbox
document. Domain documents for expense modules should be added below and
registered in ``ALL_DOCUMENTS`` so Beanie initialises them.

Mirrors the standardised Sentrifugo patterns (IAM / SRM reference).
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import uuid4

from beanie import Document
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ASCENDING, IndexModel


# ---------------------------------------------------------------------------
# Base patterns
# ---------------------------------------------------------------------------
class CustomModel(BaseModel):
    """Shared base for request/response schemas."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class StatusEnum(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


# Sentinel actor for system-initiated writes (relay, cron, seeds) where there is
# no human user.
SYSTEM_ACTOR_ID = "system"


class MetadataMixin(BaseModel):
    """Audit/soft-delete fields attached to every persisted document."""

    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None
    deleted_by: str | None = None
    deleted_on: datetime | None = None
    status: StatusEnum = StatusEnum.ACTIVE
    correlation_id: str | None = None


# ---------------------------------------------------------------------------
# Transactional outbox
# ---------------------------------------------------------------------------
class OutboxEventDocument(Document):
    """Transactional outbox: stores events that must be relayed to RabbitMQ.

    Events are written atomically alongside the domain operation. A background
    relay picks them up and publishes to RabbitMQ, marking them as ``sent``.
    Consumers use ``idempotency_key`` to deduplicate (at-least-once delivery).
    """

    id: str = Field(default_factory=lambda: str(uuid4()))
    correlation_id: str | None = None
    idempotency_key: str = Field(description="Unique key for consumer-side deduplication")
    exchange: str = "domain_events"
    event_type: str
    payload: dict
    status: Literal["pending", "sent", "failed"] = "pending"
    retries: int = 0
    created_at: datetime
    sent_at: datetime | None = None
    dead_lettered_at: datetime | None = Field(
        default=None,
        description="Set when the event exhausts MAX_RETRIES and is abandoned",
    )

    class Settings:
        name = "outbox_events"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]


# Registry used by ``src.database.init_db``.
# Expense domain documents get appended here as modules are built — import them
# at the bottom of this file (below the shared bases) so domain modules can
# import ``CustomModel`` / ``MetadataMixin`` from here without a circular import.
ALL_DOCUMENTS = [OutboxEventDocument]
