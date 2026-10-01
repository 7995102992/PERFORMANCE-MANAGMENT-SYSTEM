from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import (
    ClientProjectHeadCreate,
    ClientProjectHeadOut,
    ClientProjectHeadUpdate,
    ProjectHeadBulkAssign,
)

router = APIRouter(tags=["client-project-heads"])

_MOD = "timesheet_management"
_MANAGE = require_permission(_MOD, "manage_clients")


@router.get("/client-project-heads")
async def list_project_heads(
    user: Annotated[UserBase, Depends(_MANAGE)],
    p: Annotated[PageParams, Depends(page_params)],
    client_id: str | None = Query(None),
) -> dict:
    return await service.list_project_heads(user, p, client_id=client_id)


@router.post("/client-project-heads", status_code=status.HTTP_201_CREATED, response_model=ClientProjectHeadOut)
async def create_project_head(
    body: ClientProjectHeadCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ClientProjectHeadOut:
    return await service.create_project_head(body, user)


@router.get("/client-project-heads/available")
async def list_available_project_heads(
    user: Annotated[UserBase, Depends(_MANAGE)],
    client_id: str | None = Query(
        None, description="Scope employees to this client's BU+department, and exclude "
                          "anyone already heading it",
    ),
    q: str | None = Query(
        None, description="Filter both groups on first name, last name, full name, "
                          "email, or emp code (employees). Omit for everything.",
    ),
) -> dict:
    """Candidates for the project-head picker, in two groups: `employees` (internal,
    within the client's business unit + department) and `external_heads`.

    Neither group is paginated or capped; `q` narrows both server-side, and `total`
    always counts what was returned.
    """
    return await service.list_available_project_heads(user, client_id=client_id, q=q)


@router.post("/client-project-heads/bulk-assign", status_code=status.HTTP_201_CREATED)
async def bulk_assign_project_heads(
    body: ProjectHeadBulkAssign,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> dict:
    """Assign several project heads (employees and/or external contacts) to one client."""
    return await service.bulk_assign_project_heads(body, user)


@router.get("/client-project-heads/{id}", response_model=ClientProjectHeadOut)
async def get_project_head(
    id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ClientProjectHeadOut:
    return await service.get_project_head(id, user)


@router.put("/client-project-heads/{id}", response_model=ClientProjectHeadOut)
async def update_project_head(
    id: str,
    body: ClientProjectHeadUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ClientProjectHeadOut:
    return await service.update_project_head(id, body, user)


@router.delete("/client-project-heads/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_head(
    id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> Response:
    await service.delete_project_head(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
