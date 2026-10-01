from typing import Optional
from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from src.master_data.models import MasterDataDocument

router = APIRouter(prefix="/master-data", tags=["master-data"])


# ─── Schemas ──────────────────────────────────────────────────────────────────

class MasterDataCreate(BaseModel):
    category: str = Field(..., min_length=1)
    key: str = Field(..., min_length=1)
    value: str = Field(..., min_length=1)
    organisation_id: PydanticObjectId


class MasterDataUpdate(BaseModel):
    value: Optional[str] = Field(None, min_length=1)
    is_active: Optional[bool] = None


class MasterDataResponse(BaseModel):
    id: str
    category: str
    key: str
    value: str
    organisation_id: Optional[str] = None
    is_active: bool
    is_custom: bool


def _to_response(d: MasterDataDocument) -> MasterDataResponse:
    return MasterDataResponse(
        id=str(d.id),
        category=d.category,
        key=d.key,
        value=d.value,
        organisation_id=str(d.organisation_id) if d.organisation_id else None,
        is_active=d.is_active,
        is_custom=d.is_custom,
    )


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[MasterDataResponse])
async def list_master_data(
    category: str = Query(..., description="Category to filter (e.g. SECTORS, BUSINESS_TYPES)"),
    organisation_id: Optional[PydanticObjectId] = Query(None, description="Organisation ID to include org-specific entries"),
    include_inactive: bool = Query(False, description="Include inactive entries"),
):
    org_filter = [{"organisation_id": None}]
    if organisation_id:
        org_filter.append({"organisation_id": organisation_id})

    query: dict = {"category": category, "$or": org_filter}
    if not include_inactive:
        query["is_active"] = True

    docs = await MasterDataDocument.find(query).sort("value").to_list()

    return [_to_response(d) for d in docs]


@router.post("/", response_model=MasterDataResponse, status_code=status.HTTP_201_CREATED)
async def create_master_data(payload: MasterDataCreate):
    existing = await MasterDataDocument.find_one({
        "category": payload.category,
        "key": payload.key,
        "organisation_id": payload.organisation_id,
    })
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Entry with key '{payload.key}' already exists in '{payload.category}' for this organisation.",
        )

    doc = MasterDataDocument(
        category=payload.category,
        key=payload.key,
        value=payload.value,
        organisation_id=payload.organisation_id,
        is_active=True,
        is_custom=True,
    )
    await doc.insert()
    return _to_response(doc)


@router.put("/{item_id}", response_model=MasterDataResponse)
async def update_master_data(item_id: PydanticObjectId, payload: MasterDataUpdate):
    doc = await MasterDataDocument.get(item_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Master data entry not found.")

    update_data = payload.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(doc, key, value)
    await doc.save()

    return _to_response(doc)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_master_data(item_id: PydanticObjectId):
    doc = await MasterDataDocument.get(item_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Master data entry not found.")
    if doc.organisation_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Global master data entries cannot be deleted.",
        )
    await doc.delete()
