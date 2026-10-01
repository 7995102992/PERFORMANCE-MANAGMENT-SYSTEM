from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
from uuid import UUID

from pydantic import field_validator

from src.models import CustomModel


class InboxEventStatus(str, Enum):
    RECEIVED = "received"
    PROCESSED = "processed"
    FAILED = "failed"


class EmailPriority(str, Enum):
    HIGH = "high"
    NORMAL = "normal"
    LOW = "low"


class EmailPayload(CustomModel):
    to: str
    template_id: str
    template_data: dict[str, Any] = {}
    priority: EmailPriority = EmailPriority.NORMAL
    scheduled_at: Optional[datetime] = None

    @field_validator("scheduled_at")
    @classmethod
    def _ensure_aware(cls, v: Optional[datetime]) -> Optional[datetime]:
        # Producers may send a naive timestamp (no offset/"Z"). Comparing a naive
        # datetime against a tz-aware datetime.now(timezone.utc) raises TypeError,
        # which would turn the message into a poison/requeue loop. Coerce naive
        # values to UTC so all downstream comparisons are safe.
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class EmailEventMessage(CustomModel):
    event_id: UUID
    event_type: str
    correlation_id: UUID
    idempotency_key: UUID
    tenant_id: UUID
    payload: EmailPayload
    published_at: datetime


class InboxEventRecord(CustomModel):
    id: UUID
    tenant_id: UUID
    idempotency_key: UUID
    event_type: str
    correlation_id: UUID
    payload: dict[str, Any]
    status: InboxEventStatus
    error_detail: Optional[str] = None
    received_at: datetime
    processed_at: Optional[datetime] = None
