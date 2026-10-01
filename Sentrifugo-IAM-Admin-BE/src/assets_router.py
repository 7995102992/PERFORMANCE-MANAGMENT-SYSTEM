"""Asset endpoints — upload, get, delete files.

All file uploads in the system go through POST /assets/upload.
Modules then reference the returned asset_id.

Every route requires an authenticated caller (H2); reads/deletes and new
uploads are scoped to the caller's organisation.
"""

from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from src.assets import asset_service
from src.auth.schemas import UserBase
from src.auth.utils.dependencies import get_current_user
from src.models import CustomModel
from src.rabbitmq import DebugLevel, outbox

router = APIRouter(prefix="/assets", tags=["assets"])


# ---------------------------------------------------------------------------
# Response schema
# ---------------------------------------------------------------------------

class AssetResponse(CustomModel):
    id: PydanticObjectId
    file_name: str
    file_size: int
    mime_type: str
    file_url: str
    folder: str
    is_active: bool


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/upload", response_model=AssetResponse, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    file: UploadFile = File(...),
    folder: str = Form("general"),
):
    """Upload a file to DO Spaces and return asset metadata.

    - **file**: The file to upload (max 2MB, allowed types: pdf, doc, xls, csv, ppt, jpg, png, txt)
    - **folder**: Logical group name — must be one of the allowed folders
      (e.g. "org-documents", "org-logos", "employee-photos", "profile-photos", "general")
    """
    asset = await asset_service.upload(
        file,
        folder,
        organisation_id=current_user.organisation_id,
        actor_id=str(current_user.id),
    )
    await outbox.publish_audit_log(
        module="assets",
        actor_id=str(current_user.id),
        action="uploaded",
        resource=f"asset:{asset.id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=current_user.organisation_id,
        metadata={"file_name": asset.file_name, "folder": asset.folder, "mime_type": asset.mime_type},
    )
    return asset


@router.get("/{asset_id}", response_model=AssetResponse)
async def get_asset(
    asset_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    """Get asset metadata by ID (scoped to the caller's organisation)."""
    asset = await asset_service.get(asset_id, organisation_id=current_user.organisation_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    return asset


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    """Delete asset — removes file from DO Spaces and metadata from DB
    (scoped to the caller's organisation)."""
    deleted = await asset_service.delete(asset_id, organisation_id=current_user.organisation_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    await outbox.publish_audit_log(
        module="assets",
        actor_id=str(current_user.id),
        action="deleted",
        resource=f"asset:{asset_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=current_user.organisation_id,
    )
