"""RequestType endpoints — Chapters 2, 3, 5."""
from __future__ import annotations

from typing import Annotated

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_any_permission, require_org_admin
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from ..models import PriorityEnum, StatusEnum
from . import service
from .schemas import RequestTypeCreate, RequestTypeOut, RequestTypeUpdate

router = APIRouter(tags=["request-types"])

# Reading is needed by anyone using SR; mutations require manage_catalog.
_READ = require_any_permission(
    "service_request",
    [
        "raise_request",
        "execute_request",
        "approve_request",
        "manage_request",
        "view_all_requests",
        "manage_catalog",
        "manage_workflows",
    ],
)
_CREATE = require_org_admin()
_UPDATE = require_org_admin()
_DELETE = require_org_admin()


@router.post(
    "/request-types", status_code=status.HTTP_201_CREATED, response_model=RequestTypeOut
)
async def create_request_type(
    body: RequestTypeCreate,
    user: Annotated[UserBase, Depends(_CREATE)],
) -> RequestTypeOut:
    return await service.create_request_type(body, user)  # type: ignore[return-value]


@router.get("/request-types")
async def list_request_types(
    user: Annotated[UserBase, Depends(_READ)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    priority: PriorityEnum | None = Query(None),
    status: StatusEnum | None = Query(None),
    has_active_workflow: bool = Query(False),
) -> dict:
    return await service.list_request_types(
        user, p, q=q, category_id=category_id, priority=priority,
        status=status.value if status else None,
        has_active_workflow=has_active_workflow,
    )


@router.get("/request-types/export")
async def export_request_types(
    user: Annotated[UserBase, Depends(_READ)],
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    priority: PriorityEnum | None = Query(None),
    status_: str | None = Query(None, alias="status", pattern="^(active|inactive|all)$"),
) -> StreamingResponse:
    """Download the current request-type / SLA table as an .xlsx file.

    Honors the same q / category_id / priority / status filters as GET /request-types.
    """
    import io

    xlsx_bytes = await service.export_request_types(
        user, q=q, category_id=category_id, priority=priority, status=status_
    )
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filename = f"service-request-types_{stamp}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/request-types/{id}", response_model=RequestTypeOut)
async def get_request_type(
    id: str, user: Annotated[UserBase, Depends(_READ)]
) -> RequestTypeOut:
    return await service.get_request_type(id, user)  # type: ignore[return-value]


@router.put("/request-types/{id}", response_model=RequestTypeOut)
async def update_request_type(
    id: str,
    body: RequestTypeUpdate,
    user: Annotated[UserBase, Depends(_UPDATE)],
) -> RequestTypeOut:
    return await service.update_request_type(id, body, user)  # type: ignore[return-value]


@router.delete("/request-types/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_request_type(
    id: str, user: Annotated[UserBase, Depends(_DELETE)]
) -> Response:
    await service.delete_request_type(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------- Chapter 5: support reads ----------

@router.get("/categories/active")
async def list_active_categories(
    user: Annotated[UserBase, Depends(_READ)],
) -> dict:
    items = await service.list_active_categories(user.organisation_id)
    return {"items": items, "total": len(items)}


@router.get("/categories/{id}/request-types/active")
async def list_active_rt_for_category(
    id: str, user: Annotated[UserBase, Depends(_READ)]
) -> dict:
    items = await service.list_active_request_types_for_category(
        user.organisation_id, id
    )
    return {"items": items, "total": len(items)}


@router.get("/request-types/{id}/sla-preview")
async def sla_preview(
    id: str,
    priority: Annotated[PriorityEnum, Query(...)],
    user: Annotated[UserBase, Depends(_READ)],
) -> dict:
    # Confirm the RT belongs to the caller's org first.
    await service.get_request_type(id, user)
    rule = await service.resolve_sla_for_priority(id, priority)
    if rule is None:
        from ..exceptions import NoSlaAvailable
        raise NoSlaAvailable()
    return {
        "request_type_id": id,
        "priority_requested": priority,
        "priority_matched": rule.priority,
        "first_response_minutes": rule.first_response_minutes,
        "resolution_minutes": rule.resolution_minutes,
        "business_hours_only": rule.business_hours_only,
        "description": rule.description,
    }
