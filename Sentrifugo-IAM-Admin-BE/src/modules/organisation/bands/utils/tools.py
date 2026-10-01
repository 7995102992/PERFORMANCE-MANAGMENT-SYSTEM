import re
from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from fastapi import HTTPException, status
from src.modules.organisation.models import BandDocument, OrganisationDocument
from src.modules.organisation.bands.schema import BandCreate, BandUpdate
from src.modules.organisation.dependency_check import check_band_dependencies
from src.security.crypto import encrypt_amount, decrypt_amount
from src.location.utils import tools as location_tools
from src.correlation import audit_create, get_correlation_id, stamp_modified
from src.rabbitmq import outbox

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}


async def _validate_currency(code: str) -> None:
    rows = await location_tools.list_currencies()
    valid = {(r.get("currency") or "").upper() for r in rows if r.get("currency")}
    if code.strip().upper() not in valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid currency '{code}'.",
        )


def _decrypt_band(doc: dict) -> dict:
    for field in ("min_amount", "max_amount"):
        stored = doc.get(field)
        decrypted = decrypt_amount(stored)
        # A stored, non-empty value that decrypts to None means the ciphertext
        # could not be decrypted with the current key. Surface a clear error
        # instead of letting it become an opaque response-validation 500.
        if decrypted is None and stored not in (None, ""):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Unable to decrypt band {field}; the encryption key may have changed.",
            )
        doc[field] = decrypted
    return doc


async def _check_band_name_unique(
    organisation_id: PydanticObjectId,
    name: str,
    exclude_band_id: Optional[PydanticObjectId] = None,
) -> None:
    filters = {
        "organisation_id": organisation_id,
        "name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"},
        **NOT_DELETED,
    }
    existing = await BandDocument.find(filters).to_list()
    for band in existing:
        if exclude_band_id is None or str(band.id) != str(exclude_band_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Band name '{name.strip()}' already exists in this organisation.",
            )


def __md_lookup(field: str) -> list[dict]:
    return [
        {"$lookup": {"from": "master_data", "localField": field, "foreignField": "_id", "as": field}},
        {"$unwind": {"path": f"${field}", "preserveNullAndEmptyArrays": True}},
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    return doc


def _lookup_stages() -> list[dict]:
    return [
        *__md_lookup("class_label"),
        *__md_lookup("frequency"),
    ]


class BandTools:
    async def create(self, data: BandCreate) -> dict:
        if not await OrganisationDocument.find_one(OrganisationDocument.id == data.organisation_id, ACTIVE_NOT_DELETED):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Organisation with id {data.organisation_id} not found or inactive.",
            )

        await _check_band_name_unique(data.organisation_id, data.name)
        if data.currency:
            await _validate_currency(data.currency)
        if (
            data.min_amount is not None
            and data.max_amount is not None
            and data.max_amount < data.min_amount
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="max_amount must be greater than or equal to min_amount.",
            )

        payload = data.model_dump()
        payload["min_amount"] = encrypt_amount(payload["min_amount"])
        payload["max_amount"] = encrypt_amount(payload["max_amount"])

        band = BandDocument(**payload, **audit_create())
        await band.insert()
        await outbox.publish(
            "band.created",
            {
                "correlation_id": get_correlation_id(),
                "band_id": str(band.id),
                "organisation_id": str(band.organisation_id),
                "name": band.name,
                "is_active": band.is_active,
                "currency": band.currency,
            },
            idempotency_key=f"band.created:{band.id}",
        )
        return await self.get(band.id)

    async def get(self, band_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [{"$match": {"_id": band_id, **NOT_DELETED}}, *_lookup_stages()]
        results = await BandDocument.aggregate(pipeline).to_list()
        return _decrypt_band(_normalize(results[0])) if results else None

    async def get_all(self, organisation_id: Optional[PydanticObjectId] = None, skip: int = 0, limit: int = 20, search: str = "", is_active: Optional[bool] = None) -> List[dict]:
        match_filter: dict = {**NOT_DELETED}
        if organisation_id:
            match_filter["organisation_id"] = organisation_id
        if is_active is not None:
            match_filter["is_active"] = is_active
        if search:
            match_filter["name"] = {"$regex": re.escape(search), "$options": "i"}
        pipeline = [{"$match": match_filter}, {"$skip": skip}, {"$limit": limit}, *_lookup_stages()]
        results = await BandDocument.aggregate(pipeline).to_list()
        return [_decrypt_band(_normalize(doc)) for doc in results]

    async def update(self, band_id: PydanticObjectId, data: BandUpdate) -> Optional[dict]:
        band = await BandDocument.find_one(BandDocument.id == band_id, NOT_DELETED)
        if not band:
            return None

        update_data = data.model_dump(exclude_unset=True)

        if "is_active" in update_data and update_data["is_active"] is False and band.is_active is True:
            await check_band_dependencies(band_id)

        if "name" in update_data and update_data["name"]:
            await _check_band_name_unique(band.organisation_id, update_data["name"], exclude_band_id=band.id)

        if "currency" in update_data and update_data["currency"]:
            await _validate_currency(update_data["currency"])

        # Validate min/max coherence against the resulting state
        if "min_amount" in update_data or "max_amount" in update_data:
            new_min = update_data["min_amount"] if "min_amount" in update_data else decrypt_amount(band.min_amount)
            new_max = update_data["max_amount"] if "max_amount" in update_data else decrypt_amount(band.max_amount)
            if new_min is not None and new_max is not None and new_max < new_min:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="max_amount must be greater than or equal to min_amount.",
                )

        # Validate effective_from / effective_to coherence against the resulting state.
        # Rules: To without From → invalid; To <= From → invalid; From alone or both empty → OK.
        if "effective_from" in update_data or "effective_to" in update_data:
            new_from = update_data["effective_from"] if "effective_from" in update_data else band.effective_from
            new_to = update_data["effective_to"] if "effective_to" in update_data else band.effective_to
            if new_to is not None:
                if new_from is None:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Effective From is required when Effective To is provided.",
                    )
                if new_to <= new_from:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Effective To must be after Effective From.",
                    )

        # Encrypt amounts before persisting
        if "min_amount" in update_data:
            update_data["min_amount"] = encrypt_amount(update_data["min_amount"])
        if "max_amount" in update_data:
            update_data["max_amount"] = encrypt_amount(update_data["max_amount"])

        if update_data:
            for key, value in update_data.items():
                setattr(band, key, value)
            stamp_modified(band)
            await band.save()
        await outbox.publish(
            "band.updated",
            {
                "correlation_id": get_correlation_id(),
                "band_id": str(band.id),
                "organisation_id": str(band.organisation_id),
                "name": band.name,
                "is_active": band.is_active,
                "currency": band.currency,
                "changed_fields": list(update_data.keys()),
            },
            idempotency_key=f"band.updated:{band.id}:{get_correlation_id()}",
        )
        return await self.get(band_id)

    async def delete(self, band_id: PydanticObjectId, actor_id: str) -> bool:
        band = await BandDocument.find_one(BandDocument.id == band_id, NOT_DELETED)
        if not band:
            return False
        band.deleted_on = datetime.now(timezone.utc)
        band.deleted_by = actor_id
        band.is_active = False
        await band.save()
        await outbox.publish(
            "band.deleted",
            {"correlation_id": get_correlation_id(), "band_id": str(band_id)},
            idempotency_key=f"band.deleted:{band_id}",
        )
        return True
