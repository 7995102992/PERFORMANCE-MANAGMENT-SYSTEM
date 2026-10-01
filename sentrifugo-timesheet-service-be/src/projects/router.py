from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import BulkImportResult, ProjectCreate, ProjectOut, ProjectUpdate, ValidateResult

router = APIRouter(tags=["projects"])

_MOD = "timesheet_management"
_MANAGE = require_permission(_MOD, "manage_projects")


@router.get("/projects")
async def list_projects(
    user: Annotated[UserBase, Depends(_MANAGE)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    status_: str = Query("active", alias="status", pattern="^(active|inactive|all)$"),
    client_id: str | None = Query(None),
    project_type: str | None = Query(None),
) -> dict:
    return await service.list_projects(
        user, p, q=q, status=status_, client_id=client_id, project_type=project_type,
    )


@router.post("/projects", status_code=status.HTTP_201_CREATED, response_model=ProjectOut)
async def create_project(
    body: ProjectCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ProjectOut:
    return await service.create_project(body, user)


@router.get("/projects/template")
async def download_template(
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = await service.generate_template(user)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=project_import_template.xlsx"},
    )


@router.post("/projects/validate", response_model=ValidateResult)
async def validate_projects(
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ValidateResult:
    contents = await file.read()
    return await service.validate_import_projects(contents, user)


@router.post("/projects/import", response_model=BulkImportResult)
async def import_projects(
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> BulkImportResult:
    contents = await file.read()
    return await service.bulk_import_projects(contents, user)


@router.get("/projects/export")
async def export_projects(
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = await service.export_projects(user)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=projects_export.xlsx"},
    )


@router.get("/projects/generate-code")
async def generate_project_code(
    user: Annotated[UserBase, Depends(_MANAGE)],
    name: str = Query(..., min_length=1, description="Project name to derive the code from"),
) -> dict:
    code = await service.generate_project_code(name, user.organisation_id)
    return {"code": code}


@router.get("/projects/{id}", response_model=ProjectOut)
async def get_project(id: str, user: Annotated[UserBase, Depends(_MANAGE)]) -> ProjectOut:
    return await service.get_project(id, user)


@router.put("/projects/{id}", response_model=ProjectOut)
async def update_project(
    id: str,
    body: ProjectUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ProjectOut:
    return await service.update_project(id, body, user)


@router.delete("/projects/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(id: str, user: Annotated[UserBase, Depends(_MANAGE)]) -> Response:
    await service.delete_project(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/projects/{id}/timeline")
async def get_project_timeline(
    id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
    limit: int = Query(50, ge=1, le=200),
) -> list:
    return await service.get_project_timeline(id, user, limit=limit)
