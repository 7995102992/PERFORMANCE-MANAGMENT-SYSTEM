from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, UploadFile, status

from src.assets.schemas import AssetResponse
from src.assets.service import generate_presigned_url, get_asset, upload_asset
from src.database import get_db_session
from src.dependencies import UserBase, get_current_user

router = APIRouter(tags=["assets"])


@router.post("/assets", response_model=AssetResponse, status_code=status.HTTP_201_CREATED)
async def upload_attachment(
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> AssetResponse:
    doc = await upload_asset(
        db, file, uploaded_by=current_user.user_id, organisation_id=current_user.org_id
    )
    return AssetResponse(**doc)


@router.get("/assets/{asset_id}", response_model=AssetResponse)
async def fetch_asset(
    asset_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> AssetResponse:
    doc = await get_asset(db, asset_id, current_user=current_user)
    return AssetResponse(**doc)


@router.get("/assets/{asset_id}/url")
async def get_asset_download_url(
    asset_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> dict:
    doc = await get_asset(db, asset_id, current_user=current_user)
    url = await generate_presigned_url(asset_id, doc["storage_key"])
    return {"url": url, "expires_in": 3600}
