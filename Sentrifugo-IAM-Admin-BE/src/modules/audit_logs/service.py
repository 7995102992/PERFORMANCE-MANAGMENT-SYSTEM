"""Audit-logs read-proxy orchestration.

Pipeline: fetch a time+org(+actor)-scoped window from the logging service →
normalize each row → enrich actor_id into name/email/role from IAM's user store →
apply the remaining (derived-field) filters and free-text search in-proxy →
paginate → compute facets for the FE dropdowns.

The logging API can only push down time/org/actor, so the rest of the wireframe's
filters are applied here over a bounded window (``LOGGING_SERVICE_FETCH_CAP``).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from beanie import PydanticObjectId

from src.auth.models import UserDocument
from src.config import settings
from src.logger import logger
from src.modules.audit_logs.client import fetch_logs
from src.modules.audit_logs.schemas import (
    AuditFacets,
    AuditLogRow,
    AuditLogsResponse,
    PaginationInfo,
)
from src.modules.audit_logs.transform import to_row
from src.policies.models import PolicyDocument

_DEFAULT_WINDOW_DAYS = 30


def _looks_like_object_id(value: str | None) -> bool:
    return bool(value) and len(value) == 24 and all(c in "0123456789abcdef" for c in value.lower())


async def _enrich_actors(rows: list[AuditLogRow]) -> None:
    """Resolve distinct actor ids into user name / email / role, in place.

    IAM owns the users collection, so this fills three otherwise-missing columns
    with no producer changes. Two bounded queries: users by id, then role
    policies by id."""
    ids = {r.user_id for r in rows if _looks_like_object_id(r.user_id)}
    if not ids:
        return

    users = await UserDocument.find(
        {"_id": {"$in": [PydanticObjectId(i) for i in ids]}}
    ).to_list()
    if not users:
        return

    # Resolve role-policy names in one batch so we can label non-admin actors by
    # their assigned role (is_role policy) rather than a generic "User".
    policy_ids = {pid for u in users for pid in (u.policy_ids or [])}
    role_names: dict[PydanticObjectId, str] = {}
    if policy_ids:
        policies = await PolicyDocument.find(
            {"_id": {"$in": list(policy_ids)}, "is_role": True}
        ).to_list()
        role_names = {p.id: p.name for p in policies}

    def _role(user: UserDocument) -> str:
        if user.is_super_admin:
            return "Super Admin"
        if user.is_org_admin:
            return "Org Admin"
        for pid in user.policy_ids or []:
            if pid in role_names:
                return role_names[pid]
        return "User"

    by_id = {str(u.id): u for u in users}
    for r in rows:
        user = by_id.get(r.user_id or "")
        if not user:
            continue
        name = " ".join(x for x in (user.first_name, user.last_name) if x) or None
        r.user_name = name
        r.user_email = user.email
        r.user_role = _role(user)


def _matches(row: AuditLogRow, *, module, action_type, action, entity_type,
             status, user_email, user_role, ip_address, field_name, search) -> bool:
    if module and row.module != module:
        return False
    if action_type and row.action_type != action_type:
        return False
    if action and row.action != action:
        return False
    if entity_type and row.target_entity_type != entity_type:
        return False
    if status and row.status != status:
        return False
    if user_email and (row.user_email or "").lower() != user_email.lower():
        return False
    if user_role and row.user_role != user_role:
        return False
    if ip_address and (row.ip_address or "") != ip_address:
        return False
    if field_name and field_name not in row.field_names:
        return False
    if search:
        s = search.lower()
        haystack = " ".join(str(x) for x in (
            row.action, row.module, row.target_entity_type, row.target_entity_name,
            row.target_entity_id, row.user_name, row.user_email, row.user_id,
            row.failure_reason, row.ip_address, *row.field_names,
        ) if x).lower()
        if s not in haystack:
            return False
    return True


def _facets(rows: list[AuditLogRow]) -> AuditFacets:
    return AuditFacets(
        modules=sorted({r.module for r in rows if r.module}),
        action_types=sorted({r.action_type for r in rows if r.action_type}),
        actions=sorted({r.action for r in rows if r.action}),
        entity_types=sorted({r.target_entity_type for r in rows if r.target_entity_type}),
        statuses=sorted({r.status for r in rows if r.status}),
    )


async def get_audit_logs(
    *,
    organisation_id: str,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    actor_id: str | None = None,
    module: str | None = None,
    action_type: str | None = None,
    action: str | None = None,
    entity_type: str | None = None,
    status: str | None = None,
    user_email: str | None = None,
    user_role: str | None = None,
    ip_address: str | None = None,
    field_name: str | None = None,
    search: str | None = None,
    limit: int = 25,
    offset: int = 0,
) -> AuditLogsResponse:
    end_time = end_time or datetime.now(timezone.utc)
    start_time = start_time or (end_time - timedelta(days=_DEFAULT_WINDOW_DAYS))

    raw = await fetch_logs(
        start_time=start_time,
        end_time=end_time,
        organisation_id=organisation_id,
        actor_id=actor_id,
        limit=settings.LOGGING_SERVICE_FETCH_CAP,
        offset=0,
    )
    upstream_total = (raw.get("pagination") or {}).get("total", 0)
    if upstream_total > settings.LOGGING_SERVICE_FETCH_CAP:
        # The in-proxy filter/paginate window is capped; rows beyond the cap are
        # not considered. Surfaced as a log so we know when to push filters down
        # into the logging service (Phase 2).
        logger.warning(
            "Audit window exceeds fetch cap — narrow the date range",
            upstream_total=upstream_total,
            cap=settings.LOGGING_SERVICE_FETCH_CAP,
        )

    rows = [to_row(r) for r in (raw.get("data") or [])]
    await _enrich_actors(rows)

    facets = _facets(rows)

    filtered = [
        r for r in rows
        if _matches(
            r, module=module, action_type=action_type, action=action,
            entity_type=entity_type, status=status, user_email=user_email,
            user_role=user_role, ip_address=ip_address, field_name=field_name,
            search=search,
        )
    ]

    total = len(filtered)
    page = filtered[offset:offset + limit]

    return AuditLogsResponse(
        data=page,
        pagination=PaginationInfo(limit=limit, offset=offset, total=total),
        facets=facets,
    )
