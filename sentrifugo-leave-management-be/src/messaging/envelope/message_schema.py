import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class MessageEnvelope(BaseModel):
    """Standard message envelope. ALL messages must follow this schema."""

    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    event_type: str
    routing_key: str
    source: str
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    payload: dict[str, Any] = Field(default_factory=dict)
