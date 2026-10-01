from datetime import datetime

from src.logs.constants import DebugLevel
from src.models import CustomModel


class LogEntryIn(CustomModel):
    timestamp: str | None = None
    module: str
    # Default to "system": some producers emit actor_id=null for machine-driven
    # events. Without a default, validation would raise and the audit event would
    # be dropped. The DB column is NOT NULL, so "system" also keeps inserts valid.
    actor_id: str = "system"
    action: str
    resource: str
    debug_level: DebugLevel
    # Optional top-level org id; producers normally nest it under metadata, so
    # ingest falls back to metadata.organisation_id when this is absent.
    organisation_id: str | None = None
    metadata: dict | None = None


class LogEntryOut(CustomModel):
    timestamp: str
    module: str
    actor_id: str
    action: str
    resource: str
    debug_level: int
    organisation_id: str | None = None
    metadata: str | None = None


class PaginationInfo(CustomModel):
    limit: int
    offset: int
    total: int


class LogsResponse(CustomModel):
    data: list[LogEntryOut]
    pagination: PaginationInfo
