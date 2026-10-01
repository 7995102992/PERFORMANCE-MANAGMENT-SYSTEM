from typing import Annotated, List

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import Response

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.auth.utils.dependencies import get_current_user
from src.modules.organisation.orgdocuments import service
from src.modules.organisation.orgdocuments.schema import (
    AcknowledgeRequest,
    AcknowledgeResponse,
    BulkDocumentCreate,
    BulkFolderCreate,
    DocumentCreate,
    DocumentResponse,
    DocumentUpdate,
    DocumentVersionResponse,
    FolderCreate,
    FolderResponse,
    FolderUpdate,
    MyDocumentResponse,
    NewVersionRequest,
)

router = APIRouter(prefix="/org-documents", tags=["org-documents"])


# ---------------------------------------------------------------------------
# Folder endpoints
# ---------------------------------------------------------------------------

@router.post("/folders/", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    data: FolderCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_folder(data, caller=current_user)


@router.post("/folders/bulk", response_model=List[FolderResponse], status_code=status.HTTP_201_CREATED)
async def create_folders_bulk(
    data: BulkFolderCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_folders_bulk(data, caller=current_user)


@router.get("/folders/", response_model=List[FolderResponse])
async def list_folders(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    parent_id: PydanticObjectId | None = Query(
        default=None, description="List this folder's sub-folders. Omit for top-level folders."
    ),
    all_levels: bool = Query(
        default=False, description="Ignore the hierarchy and return a flat list (search across all folders)."
    ),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
):
    return await service.list_folders(
        caller=current_user,
        parent_id=parent_id,
        all_levels=all_levels,
        skip=skip,
        limit=limit,
        search=search,
    )


@router.get("/folders/{folder_id}", response_model=FolderResponse)
async def get_folder(
    folder_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_folder(folder_id, caller=current_user)


@router.put("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: PydanticObjectId,
    data: FolderUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_folder(folder_id, data, caller=current_user)


@router.patch("/folders/{folder_id}/deactivate-all-documents", status_code=status.HTTP_200_OK)
async def deactivate_all_documents_in_folder(
    folder_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    count = await service.deactivate_all_documents_in_folder(folder_id, caller=current_user)
    return {"deactivated": count}


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_folder(folder_id, caller=current_user)


# ---------------------------------------------------------------------------
# Document endpoints
# ---------------------------------------------------------------------------

@router.post("/documents/", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def create_document(
    data: DocumentCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_document(data, caller=current_user)


@router.post("/documents/bulk", response_model=List[DocumentResponse], status_code=status.HTTP_201_CREATED)
async def create_documents_bulk(
    data: BulkDocumentCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_documents_bulk(data, caller=current_user)


@router.get("/documents/", response_model=List[DocumentResponse])
async def list_documents(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
    folder_id: PydanticObjectId | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
):
    return await service.list_documents(
        caller=current_user, folder_id=folder_id, skip=skip, limit=limit, search=search,
    )


@router.get("/documents/{doc_id}", response_model=DocumentResponse)
async def get_document(
    doc_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_document(doc_id, caller=current_user)


@router.get("/documents/{doc_id}/content")
async def get_document_content(
    doc_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    """File bytes for the admin in-app viewer (CORS-safe)."""
    data, mime, file_name = await service.get_document_content(doc_id, caller=current_user)
    safe_name = file_name.replace('"', "")
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.put("/documents/{doc_id}", response_model=DocumentResponse)
async def update_document(
    doc_id: PydanticObjectId,
    data: DocumentUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_document(doc_id, data, caller=current_user)


# ---------------------------------------------------------------------------
# Version endpoints — replacing a document's file appends a revision rather
# than overwriting it, and re-opens acknowledgement for everyone.
# ---------------------------------------------------------------------------

@router.post(
    "/documents/{doc_id}/versions",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_document_version(
    doc_id: PydanticObjectId,
    data: NewVersionRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.add_document_version(doc_id, data, caller=current_user)


@router.get("/documents/{doc_id}/versions", response_model=List[DocumentVersionResponse])
async def list_document_versions(
    doc_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.list_document_versions(doc_id, caller=current_user)


@router.get("/documents/{doc_id}/versions/{version_no}/content")
async def get_document_version_content(
    doc_id: PydanticObjectId,
    version_no: int,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    """File bytes for a specific revision (admin in-app viewer)."""
    data, mime, file_name = await service.get_document_version_content(
        doc_id, version_no, caller=current_user
    )
    safe_name = file_name.replace('"', "")
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.delete("/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    doc_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    await service.delete_document(doc_id, caller=current_user)


# ---------------------------------------------------------------------------
# Employee-facing endpoints (user portal) — read-only + acknowledgement.
# Auth: any authenticated user; folder visibility is scoped server-side to the
# caller's BU / department / worker type when the folder has custom access.
# ---------------------------------------------------------------------------

@router.get("/my/folders", response_model=List[FolderResponse])
async def list_my_folders(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    parent_id: PydanticObjectId | None = Query(
        default=None, description="List this folder's sub-folders. Omit for top-level folders."
    ),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=100),
    search: str = Query(default=""),
):
    return await service.list_my_folders(
        caller=current_user, parent_id=parent_id, skip=skip, limit=limit, search=search,
    )


@router.get("/my/documents", response_model=List[MyDocumentResponse])
async def list_my_documents(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    folder_id: PydanticObjectId,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=100),
    search: str = Query(default=""),
):
    return await service.list_my_documents(
        caller=current_user, folder_id=folder_id, skip=skip, limit=limit, search=search,
    )


@router.get("/my/documents/{doc_id}/content")
async def get_my_document_content(
    doc_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    """File bytes for the in-app viewer (CORS-safe, access-checked)."""
    data, mime, file_name = await service.get_my_document_content(doc_id, caller=current_user)
    safe_name = file_name.replace('"', "")
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.post("/my/documents/{doc_id}/acknowledge", response_model=AcknowledgeResponse)
async def acknowledge_document(
    doc_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    data: AcknowledgeRequest | None = None,
):
    return await service.acknowledge_document(
        doc_id,
        caller=current_user,
        acknowledged_at=data.acknowledged_at if data else None,
    )
