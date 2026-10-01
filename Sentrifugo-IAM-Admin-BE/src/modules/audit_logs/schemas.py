"""DTOs for the audit-logs read-proxy."""
from __future__ import annotations

from src.models import CustomModel


class AuditLogRow(CustomModel):
    """One normalized audit row, shaped for the wireframe table.

    Fields marked (derived) are computed from the raw stored row; (enriched) are
    resolved from IAM's user store; (unavailable) are not yet captured by any
    producer and are always None in Phase 1.
    """
    timestamp: str
    action: str | None = None              # (derived) verb, e.g. "created"
    action_type: str | None = None         # (derived) category: create/update/delete/auth/export/other
    module: str | None = None              # (derived) domain, e.g. "users" (NOT the always-"iam" column)
    target_entity_type: str | None = None  # (derived) prefix of resource, e.g. "user"
    target_entity_id: str | None = None    # (derived) id part of resource
    target_entity_name: str | None = None  # (unavailable in Phase 1 unless present in details)
    field_names: list[str] = []            # (derived) metadata.changed_fields
    old_value: str | None = None           # (unavailable)
    new_value: str | None = None           # (unavailable)
    status: str = "success"                # (derived) from the verb (e.g. *_failed -> failed)
    failure_reason: str | None = None      # (partial) metadata.details.reason
    user_id: str | None = None             # actor_id
    user_name: str | None = None           # (enriched)
    user_email: str | None = None          # (enriched)
    user_role: str | None = None           # (enriched)
    source: str | None = None              # (unavailable)
    user_agent: str | None = None          # (unavailable)
    ip_address: str | None = None          # (partial) metadata.details.ip_address
    correlation_id: str | None = None


class PaginationInfo(CustomModel):
    limit: int
    offset: int
    total: int


class AuditFacets(CustomModel):
    """Distinct values for the FE filter dropdowns, computed over the fetched
    window. Phase 1: derived from the same rows, so they reflect recent activity
    rather than an exhaustive catalogue."""
    modules: list[str] = []
    action_types: list[str] = []
    actions: list[str] = []
    entity_types: list[str] = []
    statuses: list[str] = []


class AuditLogsResponse(CustomModel):
    data: list[AuditLogRow]
    pagination: PaginationInfo
    facets: AuditFacets
