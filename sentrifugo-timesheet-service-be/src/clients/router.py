from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from . import service
from .schemas import BulkImportResult, ClientCreate, ClientOut, ClientUpdate, ValidateResult

router = APIRouter(tags=["clients"])

_MOD = "timesheet_management"
_MANAGE = require_permission(_MOD, "manage_clients")


@router.get("/clients")
async def list_clients(
    user: Annotated[UserBase, Depends(_MANAGE)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    status_: str = Query("active", alias="status", pattern="^(active|inactive|all)$"),
) -> dict:
    return await service.list_clients(user, p, q=q, status=status_)


@router.post("/clients", status_code=status.HTTP_201_CREATED, response_model=ClientOut)
async def create_client(
    body: ClientCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ClientOut:
    return await service.create_client(body, user)


@router.get("/clients/template")
async def download_template(
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = await service.generate_template(user)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=client_import_template.xlsx"},
    )


@router.post("/clients/validate", response_model=ValidateResult)
async def validate_clients(
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ValidateResult:
    contents = await file.read()
    return await service.validate_import_clients(contents, user)


@router.post("/clients/import", response_model=BulkImportResult)
async def import_clients(
    file: UploadFile,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> BulkImportResult:
    contents = await file.read()
    return await service.bulk_import_clients(contents, user)


@router.get("/clients/export")
async def export_clients(
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> StreamingResponse:
    data = await service.export_clients(user)
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=clients_export.xlsx"},
    )


@router.get("/clients/{id}", response_model=ClientOut)
async def get_client(id: str, user: Annotated[UserBase, Depends(_MANAGE)]) -> ClientOut:
    return await service.get_client(id, user)


@router.put("/clients/{id}", response_model=ClientOut)
async def update_client(
    id: str,
    body: ClientUpdate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> ClientOut:
    return await service.update_client(id, body, user)


@router.delete("/clients/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(id: str, user: Annotated[UserBase, Depends(_MANAGE)]) -> Response:
    await service.delete_client(id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
