"""Employee Journey collections (IAM is the aggregator / sink).

Other services (Timesheet, Leave, SRM) and IAM itself publish domain events;
the journey consumer reacts and writes:

  - journey_timeline  → discrete lifecycle events (the timeline "dots")
  - journey_metrics   → running per-employee, per-FY aggregates (worked hours,
                        service-request count)
  - journey_processed_events → idempotency guard (delivery is at-least-once)
"""
from datetime import datetime
from typing import Optional

from beanie import Document, PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel


class JourneyTimelineDocument(Document):
    user_id: PydanticObjectId
    organisation_id: PydanticObjectId
    event_type: str                       # onboarded | project_assigned | l1_changed | ...
    title: str
    description: Optional[str] = None
    occurred_at: datetime                 # business time → drives ordering
    source_service: str                   # iam | timesheet | leave | srm
    metadata: dict = Field(default_factory=dict)
    idempotency_key: str
    created_at: datetime

    class Settings:
        name = "journey_timeline"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("occurred_at", DESCENDING)]),
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]


class JourneyMetricsDocument(Document):
    user_id: PydanticObjectId
    organisation_id: PydanticObjectId
    period: str                           # FY bucket label, e.g. "2024-2025" or "2024"
    worked_hours: float = 0.0
    service_requests_count: int = 0
    updated_at: datetime

    class Settings:
        name = "journey_metrics"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("period", ASCENDING)], unique=True),
        ]


class JourneyProcessedEventDocument(Document):
    """Idempotency guard — one row per consumed domain event."""
    idempotency_key: str
    event_type: str
    processed_at: datetime

    class Settings:
        name = "journey_processed_events"
        indexes = [
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]
