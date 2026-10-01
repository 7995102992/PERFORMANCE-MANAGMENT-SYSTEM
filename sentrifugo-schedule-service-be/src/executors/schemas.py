from datetime import datetime
from typing import Any
from uuid import UUID

from src.models import CustomModel


class TaskMessage(CustomModel):
    task_type: str
    event_id: UUID
    event_type: str
    correlation_id: UUID
    idempotency_key: UUID
    tenant_id: str
    payload: dict[str, Any]
    published_at: datetime
