"""Workflow endpoints — Chapters 3 + 4."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_org_admin, require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import WorkflowCreate, WorkflowOut, WorkflowUpdate

router = APIRouter(tags=["workflows"])

_READ = require_permission("service_request", "manage_workflows")
_CREATE = require_org_admin()
_UPDATE = require_org_admin()
_DELETE = require_org_admin()


@router.get("/request-types/{id}/primary-assignee-preview")
async def primary_assignee_preview(
    id: str, user: Annotated[UserBase, Depends(_READ)]
) -> dict:
    return await service.preview_primary_assignee(id, user)


@router.post("/workflows", status_code=status.HTTP_201_CREATED, response_model=WorkflowOut)
async def create_workflow(
    body: WorkflowCreate,
    user: Annotated[UserBase, Depends(_CREATE)],
) -> WorkflowOut:
    return await service.create_workflow(body, user)  # type: ignore[return-value]


@router.get("/workflows")
async def list_workflows(
    user: Annotated[UserBase, Depends(_READ)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    request_type_id: str | None = Query(None),
    primary_assignee_user_id: str | None = Query(None),
    approver_user_id: str | None = Query(None),
    status_: str = Query("all", alias="status", pattern="^(active|inactive|all)$"),
) -> dict:
    return await service.list_workflows(
        user, p,
        q=q,
        category_id=category_id,
        request_type_id=request_type_id,
        primary_assignee_user_id=primary_assignee_user_id,
        approver_user_id=approver_user_id,
        status=status_,
    )


@router.get("/workflows/export")
async def export_workflows(
    user: Annotated[UserBase, Depends(_READ)],
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    request_type_id: str | None = Query(None),
    primary_assignee_user_id: str | None = Query(None),
    approver_user_id: str | None = Query(None),
    status_: str = Query("all", alias="status", pattern="^(active|inactive|all)$"),
) -> StreamingResponse:
    """Download the current workflow table as an .xlsx file.

    Honours the same filters as GET /workflows.
    """
    import io

    xlsx_bytes = await service.export_workflows(
        user,
        q=q,
        category_id=category_id,
        request_type_id=request_type_id,
        primary_assignee_user_id=primary_assignee_user_id,
        approver_user_id=approver_user_id,
        status=status_,
    )
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filename = f"service-request-workflows_{stamp}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/workflows/{id}", response_model=WorkflowOut)
async def get_workflow(id: str, user: Annotated[UserBase, Depends(_READ)]) -> WorkflowOut:
    return await service.get_workflow(id, user)  # type: ignore[return-value]


@router.put("/workflows/{id}", response_model=WorkflowOut)
async def update_workflow(
    id: str, body: WorkflowUpdate, user: Annotated[UserBase, Depends(_UPDATE)]
) -> WorkflowOut:
    return await service.update_workflow(id, body, user)  # type: ignore[return-value]


@router.delete("/workflows/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(
    id: str, user: Annotated[UserBase, Depends(_DELETE)]
) -> Response:
    await service.delete_workflow(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/workflows/{id}/activate")
async def activate_workflow(id: str, user: Annotated[UserBase, Depends(_UPDATE)]) -> dict:
    return await service.activate_workflow(id, user)


@router.post("/workflows/{id}/deactivate")
async def deactivate_workflow(
    id: str, user: Annotated[UserBase, Depends(_UPDATE)]
) -> dict:
    return await service.deactivate_workflow(id, user)
