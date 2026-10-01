"""Category endpoints — Chapters 1 + 2."""
from __future__ import annotations

from typing import Annotated

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_any_permission, require_org_admin
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter(tags=["categories"])

# Reading the catalog is needed by anyone who can use SR; mutations require manage_catalog.
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


@router.get("/categories")
async def list_categories(
    user: Annotated[UserBase, Depends(_READ)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    status_: str = Query("active", alias="status", pattern="^(active|inactive|all)$"),
    department_id: str | None = Query(None),
    business_unit_id: str | None = Query(None),
    has_active_workflow: bool = Query(False),
) -> dict:
    return await service.list_categories(
        user, p, q=q, status=status_, department_id=department_id,
        business_unit_id=business_unit_id, has_active_workflow=has_active_workflow,
    )


@router.post("/categories", status_code=status.HTTP_201_CREATED, response_model=CategoryOut)
async def create_category(
    body: CategoryCreate,
    user: Annotated[UserBase, Depends(_CREATE)],
) -> CategoryOut:
    return await service.create_category(body, user)  # type: ignore[return-value]


@router.get("/categories/export")
async def export_categories(
    user: Annotated[UserBase, Depends(_READ)],
    q: str | None = Query(None),
    # Defaults to "all" (unlike the list endpoint) so an unfiltered export
    # carries every category — active rows first, then inactive.
    status_: str = Query("all", alias="status", pattern="^(active|inactive|all)$"),
    department_id: str | None = Query(None),
    business_unit_id: str | None = Query(None),
) -> StreamingResponse:
    """Download the current category list as an .xlsx file.

    Honors the same q / status / department_id / business_unit_id filters as
    GET /categories.
    """
    import io

    xlsx_bytes = await service.export_categories(
        user, q=q, status=status_, department_id=department_id,
        business_unit_id=business_unit_id,
    )
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    filename = f"service-request-categories_{stamp}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------- Chapter 2 ----------

@router.get("/categories/{id}", response_model=CategoryOut)
async def get_category(id: str, user: Annotated[UserBase, Depends(_READ)]) -> CategoryOut:
    return await service.get_category(id, user)  # type: ignore[return-value]


@router.put("/categories/{id}", response_model=CategoryOut)
async def update_category(
    id: str,
    body: CategoryUpdate,
    user: Annotated[UserBase, Depends(_UPDATE)],
) -> CategoryOut:
    return await service.update_category(id, body, user)  # type: ignore[return-value]


@router.delete("/categories/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(id: str, user: Annotated[UserBase, Depends(_DELETE)]) -> Response:
    await service.delete_category(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
