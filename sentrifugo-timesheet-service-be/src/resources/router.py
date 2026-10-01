from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import ResourceAssignmentCreate, ResourceAssignmentDelete, ResourceAssignmentOut, ResourceAssignmentUpdate

router = APIRouter(tags=["resources"])

_MOD = "timesheet_management"
_MANAGE = require_permission(_MOD, "manage_projects")


@router.post("/projects/{project_id}/resources", status_code=status.HTTP_201_CREATED, response_model=list[ResourceAssignmentOut])
async def create_resource(
    project_id: str,
    body: ResourceAssignmentCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> list[ResourceAssignmentOut]:
    return await service.create_resource(project_id, body, user)


@router.get("/projects/{project_id}/resources")
async def list_resources(
    project_id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
    p: Annotated[PageParams, Depends(page_params)],
    active_on: str | None = Query(
        None, description="ISO date; keep only allocations live on that day",
    ),
) -> dict:
    return await service.list_resources(project_id, user, p, active_on=active_on)


# ---- Task-level resource assignment ----

@router.post("/projects/{project_id}/tasks/{task_id}/resources", status_code=status.HTTP_201_CREATED, response_model=list[ResourceAssignmentOut])
async def create_task_resource(
    project_id: str,
    task_id: str,
    body: ResourceAssignmentCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> list[ResourceAssignmentOut]:
    body.task_id = task_id
    return await service.create_resource(project_id, body, user)


@router.get("/projects/{project_id}/tasks/{task_id}/resources")
async def list_task_resources(
    project_id: str,
    task_id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
    p: Annotated[PageParams, Depends(page_params)],
) -> dict:
    return await service.list_resources(project_id, user, p, task_id=task_id)


@router.put("/projects/{project_id}/tasks/{task_id}/resources/{resource_id}", response_model=list[ResourceAssignmentOut])
async def update_task_resource(
    project_id: str,
    task_id: str,
    resource_id: str,
    body: ResourceAssignmentUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> list[ResourceAssignmentOut]:
    return await service.update_resource(project_id, resource_id, body, user)


@router.delete("/projects/{project_id}/tasks/{task_id}/resources/{resource_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task_resource(
    project_id: str,
    task_id: str,
    resource_id: str,
    body: ResourceAssignmentDelete,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> Response:
    await service.delete_resource(project_id, resource_id, user, body.comment, body.end_date)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/projects/{project_id}/resources/{resource_id}", response_model=list[ResourceAssignmentOut])
async def update_resource(
    project_id: str,
    resource_id: str,
    body: ResourceAssignmentUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> list[ResourceAssignmentOut]:
    return await service.update_resource(project_id, resource_id, body, user)


@router.delete("/projects/{project_id}/resources/{resource_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_resource(
    project_id: str,
    resource_id: str,
    body: ResourceAssignmentDelete,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> Response:
    """Remove the assignment, or schedule its release when `end_date` is given."""
    await service.delete_resource(project_id, resource_id, user, body.comment, body.end_date)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
