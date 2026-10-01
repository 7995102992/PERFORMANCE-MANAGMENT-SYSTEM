from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import BulkImportResult, ProjectTaskCreate, ProjectTaskOut, ProjectTaskUpdate, TaskCreate, TaskOut, TaskUpdate, ValidateResult

router = APIRouter(tags=["tasks"])

_MOD = "timesheet_management"
_MANAGE = require_permission(_MOD, "manage_projects")


@router.get("/tasks")
async def list_tasks(
    user: Annotated[UserBase, Depends(_MANAGE)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    status_: str = Query("active", alias="status", pattern="^(active|inactive|all)$"),
    is_global: bool | None = Query(None),
    is_frequent: bool | None = Query(None),
    project_id: str | None = Query(None, description="Also include the tasks this project owns"),
) -> dict:
    return await service.list_tasks(
        user, p, q=q, status=status_, is_global=is_global,
        is_frequent=is_frequent, project_id=project_id,
    )


@router.post("/tasks", status_code=status.HTTP_201_CREATED, response_model=TaskOut)
async def create_task(
    body: TaskCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> TaskOut:
    return await service.create_task(body, user)


@router.get("/tasks/template")
async def download_template(
    _user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = service.generate_template()
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=task_import_template.xlsx"},
    )


@router.post("/tasks/validate/{project_id}", response_model=ValidateResult)
async def validate_tasks(
    project_id: str,
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ValidateResult:
    contents = await file.read()
    return await service.validate_import_tasks(contents, user, project_id=project_id)


@router.post("/tasks/validate", response_model=ValidateResult)
async def validate_tasks_query(
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
    project_id: str = Query(...),
) -> ValidateResult:
    contents = await file.read()
    return await service.validate_import_tasks(contents, user, project_id=project_id)


@router.post("/tasks/import/{project_id}", response_model=BulkImportResult)
async def import_tasks(
    project_id: str,
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> BulkImportResult:
    contents = await file.read()
    return await service.bulk_import_tasks(contents, user, project_id=project_id)


@router.post("/tasks/import", response_model=BulkImportResult)
async def import_tasks_query(
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
    project_id: str = Query(...),
) -> BulkImportResult:
    contents = await file.read()
    return await service.bulk_import_tasks(contents, user, project_id=project_id)


@router.get("/tasks/export")
async def export_tasks(
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = await service.export_tasks(user)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=tasks_export.xlsx"},
    )


@router.get("/tasks/{id}", response_model=TaskOut)
async def get_task(id: str, user: Annotated[UserBase, Depends(_MANAGE)]) -> TaskOut:
    return await service.get_task(id, user)


@router.put("/tasks/{id}", response_model=TaskOut)
async def update_task(
    id: str,
    body: TaskUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> TaskOut:
    return await service.update_task(id, body, user)


@router.delete("/tasks/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(id: str, user: Annotated[UserBase, Depends(_MANAGE)]) -> Response:
    await service.delete_task(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Project-Task assignment ---

@router.post("/projects/{project_id}/tasks", status_code=status.HTTP_201_CREATED, response_model=ProjectTaskOut)
async def assign_task_to_project(
    project_id: str,
    body: ProjectTaskCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ProjectTaskOut:
    return await service.assign_task_to_project(project_id, body, user)


@router.get("/projects/{project_id}/tasks/export")
async def export_project_tasks(
    project_id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = await service.export_project_tasks(project_id, user)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=project_tasks_export.xlsx"},
    )


@router.get("/projects/{project_id}/tasks")
async def list_project_tasks(
    project_id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
    q: str | None = Query(None, description="Filter by task name"),
) -> list:
    return await service.list_project_tasks(project_id, user, search=q)


@router.put("/projects/{project_id}/tasks/{task_id}", response_model=ProjectTaskOut)
async def update_project_task(
    project_id: str,
    task_id: str,
    body: ProjectTaskUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ProjectTaskOut:
    return await service.update_project_task(
        project_id, task_id, body.model_dump(exclude_unset=True), user,
    )


@router.delete("/projects/{project_id}/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_task_from_project(
    project_id: str,
    task_id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> Response:
    await service.remove_task_from_project(project_id, task_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
