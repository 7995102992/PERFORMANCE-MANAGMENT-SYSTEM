import re
from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from fastapi import HTTPException, status
from src.correlation import get_correlation_id, audit_create, stamp_modified
from src.modules.organisation.models import DesignationDocument, PayGradeDocument
from src.modules.organisation.designation.schema import DesignationCreate, DesignationUpdate
from src.modules.organisation.dependency_check import check_designation_dependencies
from src.rabbitmq import DebugLevel, outbox

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}


async def _validate_pay_grades(
    organisation_id: PydanticObjectId, pay_grade_ids: list[PydanticObjectId]
) -> None:
    """Ensure every assigned pay grade exists, is active, and belongs to the org."""
    for pg_id in pay_grade_ids:
        if not await PayGradeDocument.find_one(
            PayGradeDocument.id == pg_id,
            PayGradeDocument.organisation_id == organisation_id,
            ACTIVE_NOT_DELETED,
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Pay grade with id {pg_id} not found or inactive.",
            )


def _lookup_stages() -> list[dict]:
    return [
        # Resolve assigned pay grades → compact {_id, name} for display.
        {"$lookup": {
            "from": "paygrades",
            "let": {"pgids": {"$ifNull": ["$pay_grade_ids", []]}},
            "pipeline": [
                {"$match": {"$expr": {"$in": ["$_id", "$$pgids"]}, "deleted_on": None}},
                {"$project": {"_id": 1, "name": 1}},
            ],
            "as": "pay_grades",
        }},
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    return doc


class DesignationTools:
    async def create(self, data: DesignationCreate) -> dict:
        # Designation names are NOT required to be unique — roles are separate now.
        await _validate_pay_grades(data.organisation_id, data.pay_grade_ids)
        doc_fields = data.model_dump()
        designation = DesignationDocument(
            **doc_fields,
            **audit_create(),
            correlation_id=get_correlation_id(),
        )
        await designation.insert()

        await outbox.publish(
            "designation.created",
            {
                "correlation_id": get_correlation_id(),
                "designation_id": str(designation.id),
                "organisation_id": str(data.organisation_id),
                "name": data.designation_name,
                "is_active": designation.is_active,
                "department_id": str(designation.department_id) if designation.department_id else None,
                "pay_grade_ids": [str(pid) for pid in (designation.pay_grade_ids or [])],
            },
            idempotency_key=f"designation.created:{designation.id}",
        )
        await outbox.publish_audit_log(
            module="designations",
            actor_id="system",
            action="created",
            resource=f"designation:{designation.id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(data.organisation_id) if data.organisation_id else None,
        )
        return await self.get(designation.id)

    async def get(self, desg_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [{"$match": {"_id": desg_id, **NOT_DELETED}}, *_lookup_stages()]
        results = await DesignationDocument.aggregate(pipeline).to_list()
        return _normalize(results[0]) if results else None

    async def get_all(
        self,
        organisation_id: Optional[PydanticObjectId] = None,
        skip: int = 0,
        limit: int = 20,
        search: str = "",
        is_active: Optional[bool] = None,
    ) -> List[dict]:
        filters: dict = {**NOT_DELETED}
        if organisation_id:
            filters["organisation_id"] = organisation_id
        if is_active is not None:
            filters["is_active"] = is_active
        if search:
            filters["designation_name"] = {"$regex": re.escape(search), "$options": "i"}
        pipeline: list[dict] = [
            {"$match": filters},
            # Deterministic order — without it pagination is natural-order and
            # dropdowns consuming this list are effectively random.
            {"$sort": {"designation_name": 1}},
            {"$skip": skip},
            {"$limit": limit},
            *_lookup_stages(),
        ]
        results = await DesignationDocument.aggregate(pipeline).to_list()
        return [_normalize(doc) for doc in results]

    async def update(self, desg_id: PydanticObjectId, data: DesignationUpdate) -> Optional[dict]:
        designation = await DesignationDocument.find_one(DesignationDocument.id == desg_id, NOT_DELETED)
        if not designation:
            return None

        update_data_raw = data.model_dump(exclude_unset=True)
        if "is_active" in update_data_raw and update_data_raw["is_active"] is False and designation.is_active is True:
            await check_designation_dependencies(desg_id)

        if data.pay_grade_ids is not None:
            await _validate_pay_grades(designation.organisation_id, data.pay_grade_ids)

        update_data = data.model_dump(exclude_unset=True)

        # Designation names need not be unique → no duplicate-name check on rename.

        designation.correlation_id = get_correlation_id()
        if update_data:
            for key, value in update_data.items():
                setattr(designation, key, value)
            stamp_modified(designation)
        await designation.save()

        changed_fields = list(update_data.keys())
        # Designations previously emitted no domain event on update, so downstream
        # services never saw edits (rename, dept move, activate/deactivate).
        # Publish one now, mirroring department.updated / business_unit.updated.
        await outbox.publish(
            "designation.updated",
            {
                "correlation_id": get_correlation_id(),
                "designation_id": str(designation.id),
                "organisation_id": str(designation.organisation_id),
                "name": designation.designation_name,
                "is_active": designation.is_active,
                "department_id": str(designation.department_id) if designation.department_id else None,
                "pay_grade_ids": [str(pid) for pid in (designation.pay_grade_ids or [])],
                "changed_fields": changed_fields,
            },
            idempotency_key=f"designation.updated:{designation.id}:{get_correlation_id()}",
        )

        await outbox.publish_audit_log(
            module="designations",
            actor_id="system",
            action="updated",
            resource=f"designation:{desg_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(designation.organisation_id) if designation.organisation_id else None,
            metadata={"changed_fields": changed_fields},
        )
        return await self.get(desg_id)

    async def delete(self, desg_id: PydanticObjectId, actor_id: str) -> bool:
        designation = await DesignationDocument.find_one(DesignationDocument.id == desg_id, NOT_DELETED)
        if not designation:
            return False

        # Block the delete if anything still depends on this designation.
        await check_designation_dependencies(desg_id)

        designation.deleted_on = datetime.now(timezone.utc)
        designation.deleted_by = actor_id
        designation.is_active = False
        designation.correlation_id = get_correlation_id()
        await designation.save()

        await outbox.publish(
            "designation.deleted",
            {"correlation_id": get_correlation_id(), "designation_id": str(desg_id)},
            idempotency_key=f"designation.deleted:{desg_id}",
        )
        await outbox.publish_audit_log(
            module="designations",
            actor_id=actor_id,
            action="deleted",
            resource=f"designation:{desg_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(designation.organisation_id) if designation.organisation_id else None,
        )
        return True
