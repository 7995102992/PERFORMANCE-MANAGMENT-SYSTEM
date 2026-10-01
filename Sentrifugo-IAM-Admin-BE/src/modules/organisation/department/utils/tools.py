import re
from datetime import datetime, timezone
from typing import List, Optional
from uuid import uuid4
from beanie import PydanticObjectId
from fastapi import HTTPException, status
from src.correlation import get_correlation_id, audit_create, stamp_modified
from src.modules.organisation.models import DepartmentDocument, BusinessUnitDocument
from src.modules.organisation.department.schema import DepartmentCreate, DepartmentUpdate
from src.modules.organisation.dependency_check import check_department_dependencies
from src.modules.custom_fields.models import EntityType
from src.modules.custom_fields.utils.tools import ValueTools
from src.rabbitmq import DebugLevel, outbox

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}


async def _check_dept_name_unique(
    organisation_id: PydanticObjectId,
    name: str,
    business_unit_ids: list[PydanticObjectId],
    exclude_dept_id: Optional[PydanticObjectId] = None,
) -> None:
    filters = {
        "organisation_id": organisation_id,
        "department_name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"},
        "business_units": {"$in": business_unit_ids},
        **NOT_DELETED,
    }
    existing = await DepartmentDocument.find(filters).to_list()
    for dept in existing:
        if exclude_dept_id is None or str(dept.id) != str(exclude_dept_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Department name '{name.strip()}' already exists in one of the selected business units.",
            )


def _head_lookup_stages() -> list[dict]:
    return [
        {"$lookup": {"from": "users", "localField": "department_head", "foreignField": "_id", "as": "_head_user"}},
        {"$unwind": {"path": "$_head_user", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {"department_head_name": {"$concat": [{"$ifNull": ["$_head_user.first_name", ""]}, " ", {"$ifNull": ["$_head_user.last_name", ""]}]}}},
        {"$project": {"_head_user": 0}},
        {"$lookup": {"from": "business_units", "localField": "business_units", "foreignField": "_id", "as": "_bu_docs"}},
        {"$lookup": {"from": "business_units", "localField": "primary_business_unit", "foreignField": "_id", "as": "_primary_bu"}},
        {"$unwind": {"path": "$_primary_bu", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
            "business_unit_names": {"$map": {"input": "$_bu_docs", "as": "bu", "in": "$$bu.business_unit_name"}},
            "primary_business_unit_data": {
                "$cond": {
                    "if": "$_primary_bu",
                    "then": {"_id": "$_primary_bu._id", "businessUnitName": "$_primary_bu.business_unit_name"},
                    "else": None,
                }
            },
        }},
        {"$project": {"_bu_docs": 0, "_primary_bu": 0}},
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    return doc


class DeptsTools:
    async def create(self, data: DepartmentCreate) -> dict:
        for bu_id in data.business_units:
            if not await BusinessUnitDocument.find_one(
                BusinessUnitDocument.id == bu_id, BusinessUnitDocument.organisation_id == data.organisation_id, ACTIVE_NOT_DELETED
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Business unit with id {bu_id} not found or inactive."
                )

        if len(data.business_units) > 1:
            if not data.primary_business_unit:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Primary business unit is required when multiple business units are selected.",
                )
            if data.primary_business_unit not in data.business_units:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Primary business unit must be one of the selected business units.",
                )
        elif data.primary_business_unit and data.primary_business_unit not in data.business_units:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Primary business unit must be one of the selected business units.",
            )

        await _check_dept_name_unique(data.organisation_id, data.department_name, data.business_units)

        payload = data.model_dump()
        if len(data.business_units) == 1:
            payload["primary_business_unit"] = data.business_units[0]
        dept = DepartmentDocument(**payload, **audit_create(), correlation_id=get_correlation_id())
        await dept.insert()

        await outbox.publish(
            "department.created",
            {
                "correlation_id": get_correlation_id(),
                "department_id": str(dept.id),
                "organisation_id": str(data.organisation_id),
                "name": data.department_name,
                # Downstream services (e.g. the LMS) key their BU<->dept logic off
                # these — without them a dept looks like it belongs to no BU.
                "business_unit_ids": [str(b) for b in (dept.business_units or [])],
                "business_unit_id": str(dept.primary_business_unit) if dept.primary_business_unit else None,
                "is_active": dept.is_active,
                "department_head": str(dept.department_head) if dept.department_head else None,
                "department_code": dept.department_code,
            },
            idempotency_key=f"department.created:{dept.id}",
        )
        await outbox.publish_audit_log(
            module="departments",
            actor_id="system",
            action="created",
            resource=f"department:{dept.id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(data.organisation_id) if data.organisation_id else None,
        )
        return await self.get(dept.id)

    async def get(self, dept_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [{"$match": {"_id": dept_id, **NOT_DELETED}}, *_head_lookup_stages()]
        results = await DepartmentDocument.aggregate(pipeline).to_list()
        return _normalize(results[0]) if results else None

    async def get_all(
        self,
        organisation_id: Optional[PydanticObjectId] = None,
        business_unit_ids: Optional[list[PydanticObjectId]] = None,
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
        if business_unit_ids:
            filters["business_units"] = {"$in": business_unit_ids}
        if search:
            filters["department_name"] = {"$regex": re.escape(search), "$options": "i"}
        pipeline: list[dict] = [{"$match": filters}, {"$skip": skip}, {"$limit": limit}, *_head_lookup_stages()]
        results = await DepartmentDocument.aggregate(pipeline).to_list()
        return [_normalize(doc) for doc in results]

    async def update(self, dept_id: PydanticObjectId, data: DepartmentUpdate) -> Optional[dict]:
        dept = await DepartmentDocument.find_one({"_id": dept_id, **NOT_DELETED})
        if not dept:
            return None

        update_data_raw = data.model_dump(exclude_unset=True)
        if "is_active" in update_data_raw and update_data_raw["is_active"] is False and dept.is_active is True:
            await check_department_dependencies(dept_id)

        if data.business_units:
            for bu_id in data.business_units:
                if not await BusinessUnitDocument.find_one(
                    BusinessUnitDocument.id == bu_id, BusinessUnitDocument.organisation_id == dept.organisation_id, ACTIVE_NOT_DELETED
                ):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Business unit with id {bu_id} not found or inactive."
                    )

        update_data = data.model_dump(exclude_unset=True)

        effective_bus = update_data.get("business_units") or dept.business_units
        effective_primary = update_data.get("primary_business_unit", dept.primary_business_unit)

        if len(effective_bus) > 1:
            if not effective_primary or effective_primary not in effective_bus:
                if "primary_business_unit" not in update_data and dept.primary_business_unit in effective_bus:
                    pass
                else:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Primary business unit is required when multiple business units are selected.",
                    )
        elif len(effective_bus) == 1:
            update_data["primary_business_unit"] = effective_bus[0]
        elif "primary_business_unit" in update_data and update_data["primary_business_unit"]:
            if update_data["primary_business_unit"] not in effective_bus:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Primary business unit must be one of the selected business units.",
                )

        if "department_name" in update_data and update_data["department_name"]:
            await _check_dept_name_unique(dept.organisation_id, update_data["department_name"], effective_bus, exclude_dept_id=dept.id)

        dept.correlation_id = get_correlation_id()
        if update_data:
            for key, value in update_data.items():
                setattr(dept, key, value)
        stamp_modified(dept)
        await dept.save()

        changed_fields = list(update_data.keys())
        # Departments previously emitted no domain event on update, so downstream
        # services never saw edits (BU links, rename, etc.). Publish one now,
        # mirroring business_unit.updated, so the LMS stays in sync.
        await outbox.publish(
            "department.updated",
            {
                "correlation_id": get_correlation_id(),
                "department_id": str(dept.id),
                "organisation_id": str(dept.organisation_id),
                "name": dept.department_name,
                "business_unit_ids": [str(b) for b in (dept.business_units or [])],
                "business_unit_id": str(dept.primary_business_unit) if dept.primary_business_unit else None,
                "is_active": dept.is_active,
                "department_head": str(dept.department_head) if dept.department_head else None,
                "department_code": dept.department_code,
                "changed_fields": changed_fields,
            },
            idempotency_key=f"department.updated:{dept.id}:{get_correlation_id()}",
        )

        await outbox.publish_audit_log(
            module="departments",
            actor_id="system",
            action="updated",
            resource=f"department:{dept_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(dept.organisation_id) if dept.organisation_id else None,
            metadata={"changed_fields": changed_fields},
        )
        return await self.get(dept_id)

    async def delete(self, dept_id: PydanticObjectId, actor_id: str) -> bool:
        dept = await DepartmentDocument.find_one({"_id": dept_id, **NOT_DELETED})
        if not dept:
            return False
        dept.deleted_on = datetime.now(timezone.utc)
        dept.deleted_by = actor_id
        dept.is_active = False
        dept.correlation_id = get_correlation_id()
        await dept.save()

        await ValueTools().delete_entity_values(
            dept_id,
            actor_id,
            organisation_id=dept.organisation_id,
            entity_type=EntityType.DEPARTMENT,
        )

        await outbox.publish(
            "department.deleted",
            {"correlation_id": get_correlation_id(), "department_id": str(dept_id)},
            idempotency_key=f"department.deleted:{dept_id}",
        )
        await outbox.publish_audit_log(
            module="departments",
            actor_id=actor_id,
            action="deleted",
            resource=f"department:{dept_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(dept.organisation_id) if dept.organisation_id else None,
        )
        return True
