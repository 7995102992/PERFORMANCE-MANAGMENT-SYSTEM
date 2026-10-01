"""Org-admin Audit Logs read endpoints (BFF over the central Logging Service).

Admin-gated and always scoped to the caller's organisation — the org id comes
from the JWT, never the client, so one org can never read another's audit trail.
If the logging service is unavailable these return 503 (no fallback).
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.audit_logs.client import LoggingServiceError
from src.modules.audit_logs.schemas import AuditFacets, AuditLogsResponse
from src.modules.audit_logs import service

router = APIRouter(prefix="/audit-logs", tags=["audit-logs"])

# Admin-only by construction (super/org admins pass require_permission first).
_AuditReader = Annotated[UserBase, Depends(require_permission("users", "create_resource"))]


def _org(caller: UserBase) -> str:
    if not caller.organisation_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No organisation context")
    return str(caller.organisation_id)


@router.get("", response_model=AuditLogsResponse)
async def list_audit_logs(
    current_user: _AuditReader,
    start_time: datetime | None = Query(None),
    end_time: datetime | None = Query(None),
    actor_id: str | None = Query(None, description="User filter (user id)"),
    module: str | None = Query(None),
    action_type: str | None = Query(None),
    action: str | None = Query(None),
    entity_type: str | None = Query(None, alias="target_entity_type"),
    audit_status: str | None = Query(None, alias="status"),
    user_email: str | None = Query(None),
    user_role: str | None = Query(None),
    ip_address: str | None = Query(None),
    field_name: str | None = Query(None),
    search: str | None = Query(None),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> AuditLogsResponse:
    try:
        return await service.get_audit_logs(
            organisation_id=_org(current_user),
            start_time=start_time,
            end_time=end_time,
            actor_id=actor_id,
            module=module,
            action_type=action_type,
            action=action,
            entity_type=entity_type,
            status=audit_status,
            user_email=user_email,
            user_role=user_role,
            ip_address=ip_address,
            field_name=field_name,
            search=search,
            limit=limit,
            offset=offset,
        )
    except LoggingServiceError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"Audit log store unavailable: {exc}"
        )


@router.get("/facets", response_model=AuditFacets)
async def audit_facets(current_user: _AuditReader) -> AuditFacets:
    """Distinct filter values over the recent window, for the FE dropdowns."""
    try:
        result = await service.get_audit_logs(
            organisation_id=_org(current_user), limit=1, offset=0,
        )
        return result.facets
    except LoggingServiceError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"Audit log store unavailable: {exc}"
        )
