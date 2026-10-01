from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from fastapi import HTTPException, status
from src.modules.organisation.models import PayGradeDocument, BandDocument, OrganisationDocument
from src.modules.organisation.paygrades.schema import PayGradeCreate, PayGradeUpdate
from src.modules.organisation.dependency_check import check_pay_grade_dependencies
from src.correlation import audit_create, get_correlation_id, stamp_modified
from src.rabbitmq import outbox

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}


async def _check_paygrade_name_unique(
    organisation_id: PydanticObjectId,
    name: str,
    exclude_pg_id: Optional[PydanticObjectId] = None,
) -> None:
    filters = {
        "organisation_id": organisation_id,
        "name": {"$regex": f"^{name.strip()}$", "$options": "i"},
        **NOT_DELETED,
    }
    existing = await PayGradeDocument.find(filters).to_list()
    for pg in existing:
        if exclude_pg_id is None or str(pg.id) != str(exclude_pg_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Pay grade name '{name.strip()}' already exists in this organisation.",
            )


def _lookup_stages() -> list[dict]:
    return [
        {
            "$lookup": {
                "from": "bands",
                "localField": "band_ids",
                "foreignField": "_id",
                "as": "bands",
            }
        },
        {
            "$addFields": {
                "band_names": "$bands.name",
            }
        },
        {
            "$project": {
                "bands": 0,
            }
        },
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    return doc


class PayGradeTools:
    async def create(self, data: PayGradeCreate) -> dict:
        if not await OrganisationDocument.find_one(OrganisationDocument.id == data.organisation_id, ACTIVE_NOT_DELETED):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Organisation with id {data.organisation_id} not found or inactive.",
            )

        for band_id in data.band_ids:
            if not await BandDocument.find_one(BandDocument.id == band_id, ACTIVE_NOT_DELETED):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Band with id {band_id} not found or inactive.",
                )

        await _check_paygrade_name_unique(data.organisation_id, data.name)

        paygrade = PayGradeDocument(**data.model_dump(), **audit_create())
        await paygrade.insert()
        await outbox.publish(
            "pay_grade.created",
            {
                "correlation_id": get_correlation_id(),
                "pay_grade_id": str(paygrade.id),
                "organisation_id": str(paygrade.organisation_id),
                "name": paygrade.name,
                "band_ids": [str(b) for b in (paygrade.band_ids or [])],
                "is_active": paygrade.is_active,
            },
            idempotency_key=f"pay_grade.created:{paygrade.id}",
        )
        return await self.get(paygrade.id)

    async def get(self, paygrade_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [{"$match": {"_id": paygrade_id, **NOT_DELETED}}, *_lookup_stages()]
        results = await PayGradeDocument.aggregate(pipeline).to_list()
        return _normalize(results[0]) if results else None

    async def get_all(self, organisation_id: Optional[PydanticObjectId] = None, skip: int = 0, limit: int = 20, search: str = "", is_active: Optional[bool] = None) -> List[dict]:
        match_filter: dict = {**NOT_DELETED}
        if organisation_id:
            match_filter["organisation_id"] = organisation_id
        if is_active is not None:
            match_filter["is_active"] = is_active
        if search:
            match_filter["name"] = {"$regex": search, "$options": "i"}
        pipeline = [{"$match": match_filter}, {"$skip": skip}, {"$limit": limit}, *_lookup_stages()]
        results = await PayGradeDocument.aggregate(pipeline).to_list()
        return [_normalize(doc) for doc in results]

    async def update(self, paygrade_id: PydanticObjectId, data: PayGradeUpdate) -> Optional[dict]:
        paygrade = await PayGradeDocument.find_one(PayGradeDocument.id == paygrade_id, NOT_DELETED)
        if not paygrade:
            return None

        if data.band_ids is not None:
            for band_id in data.band_ids:
                if not await BandDocument.find_one(BandDocument.id == band_id, ACTIVE_NOT_DELETED):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Band with id {band_id} not found or inactive.",
                    )

        # Block deactivating a pay grade that's still assigned to a designation.
        if data.is_active is False and paygrade.is_active is True:
            await check_pay_grade_dependencies(paygrade_id)

        update_data = data.model_dump(exclude_unset=True)

        if "name" in update_data and update_data["name"]:
            await _check_paygrade_name_unique(paygrade.organisation_id, update_data["name"], exclude_pg_id=paygrade.id)

        if update_data:
            for key, value in update_data.items():
                setattr(paygrade, key, value)
            stamp_modified(paygrade)
            await paygrade.save()

        await outbox.publish(
            "pay_grade.updated",
            {
                "correlation_id": get_correlation_id(),
                "pay_grade_id": str(paygrade.id),
                "organisation_id": str(paygrade.organisation_id),
                "name": paygrade.name,
                "band_ids": [str(b) for b in (paygrade.band_ids or [])],
                "is_active": paygrade.is_active,
                "changed_fields": list(update_data.keys()),
            },
            idempotency_key=f"pay_grade.updated:{paygrade.id}:{get_correlation_id()}",
        )
        return await self.get(paygrade_id)

    async def delete(self, paygrade_id: PydanticObjectId, actor_id: str) -> bool:
        paygrade = await PayGradeDocument.find_one(PayGradeDocument.id == paygrade_id, NOT_DELETED)
        if not paygrade:
            return False
        await check_pay_grade_dependencies(paygrade_id)
        paygrade.deleted_on = datetime.now(timezone.utc)
        paygrade.deleted_by = actor_id
        paygrade.is_active = False
        await paygrade.save()
        await outbox.publish(
            "pay_grade.deleted",
            {"correlation_id": get_correlation_id(), "pay_grade_id": str(paygrade_id)},
            idempotency_key=f"pay_grade.deleted:{paygrade_id}",
        )
        return True
