import re
from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from fastapi import HTTPException, status
from src.correlation import get_correlation_id, audit_create, stamp_modified
from src.modules.organisation.models import BusinessUnitDocument, AddressDocument, EmployeeDocument, OrganisationDocument
from src.modules.organisation.businessunit.schema import BusinessUnitCreate, BusinessUnitUpdate
from src.modules.organisation.dependency_check import check_business_unit_dependencies
from src.modules.custom_fields.models import EntityType
from src.modules.custom_fields.utils.tools import attach_custom_fields, ValueTools
from src.rabbitmq import DebugLevel, outbox

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}

_START_FROM_LETTERS = (("F", "full_time"), ("C", "contract"), ("I", "internship"))


def _split_start_from(payload) -> tuple[dict, dict]:
    """Split per-type start strings into (number map, padding-width map).

    Accepts an EmpCodeStartFrom model or a plain dict. A value like "006" yields
    number 6 and width 3; "1" yields 1 and width 0 (no padding).
    """
    def _get(key: str) -> str:
        raw = getattr(payload, key, None) if not isinstance(payload, dict) else payload.get(key)
        return str(raw if raw is not None else "0").strip() or "0"

    start_map, pad_map = {}, {}
    for letter, key in _START_FROM_LETTERS:
        s = _get(key)
        start_map[letter] = int(s)
        # A leading zero means the org wants fixed-width codes; bare "6" → no padding.
        pad_map[letter] = len(s) if (len(s) > 1 and s[0] == "0") else 0
    return start_map, pad_map


def _format_start_from(start_map: dict, pad_map: dict) -> dict:
    """Rebuild padded display strings (e.g. {"F": "006"}) for the response."""
    out = {}
    for letter, _ in _START_FROM_LETTERS:
        n = int((start_map or {}).get(letter, 0))
        w = int((pad_map or {}).get(letter, 0))
        out[letter] = f"{n:0{w}d}" if w > 0 else str(n)
    return out


async def _check_prefix_unique(
    organisation_id: PydanticObjectId,
    prefix: str,
    exclude_bu_id: Optional[PydanticObjectId] = None,
) -> None:
    """Raise 409 if another non-deleted BU in this org already uses this prefix."""
    normalized = prefix.strip().upper()
    filters = {"organisation_id": organisation_id, "emp_code_prefix": normalized, **NOT_DELETED}
    existing = await BusinessUnitDocument.find(filters).to_list()
    for bu in existing:
        if exclude_bu_id is None or str(bu.id) != str(exclude_bu_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Employee code prefix '{normalized}' is already used by another business unit.",
            )


async def _check_name_unique(
    organisation_id: PydanticObjectId,
    name: str,
    exclude_bu_id: Optional[PydanticObjectId] = None,
) -> None:
    filters = {
        "organisation_id": organisation_id,
        "business_unit_name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"},
        **NOT_DELETED,
    }
    existing = await BusinessUnitDocument.find(filters).to_list()
    for bu in existing:
        if exclude_bu_id is None or str(bu.id) != str(exclude_bu_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Business unit name '{name.strip()}' already exists in this organisation.",
            )


def __md_lookup(field: str) -> list[dict]:
    return [
        {"$lookup": {"from": "master_data", "localField": field, "foreignField": "_id", "as": field}},
        {"$unwind": {"path": f"${field}", "preserveNullAndEmptyArrays": True}},
    ]


def _address_lookup_stages() -> list[dict]:
    return [
        {
            "$lookup": {
                "from": "addresses",
                "localField": "address_id",
                "foreignField": "_id",
                "as": "address",
            }
        },
        {"$unwind": {"path": "$address", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "users", "localField": "head_user_id", "foreignField": "_id", "as": "_head_user"}},
        {"$unwind": {"path": "$_head_user", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "employees", "localField": "head_user_id", "foreignField": "user_id", "as": "_head_emp"}},
        {"$unwind": {"path": "$_head_emp", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "employees", "localField": "_id", "foreignField": "business_unit_id",
            "pipeline": [{"$match": {"deleted_on": None}}, {"$limit": 1}, {"$project": {"_id": 1}}],
            "as": "_emp_check",
        }},
        {"$addFields": {
            "head_employee_name": {"$concat": [{"$ifNull": ["$_head_user.first_name", ""]}, " ", {"$ifNull": ["$_head_user.last_name", ""]}]},
            "head_emp_code": "$_head_emp.emp_code",
            "has_employees": {"$gt": [{"$size": "$_emp_check"}, 0]},
        }},
        {"$project": {"_head_user": 0, "_head_emp": 0, "_emp_check": 0}},
        *__md_lookup("sector"),
        *__md_lookup("type_of_business"),
        *__md_lookup("nature_of_business"),
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    if doc.get("address"):
        doc["address"]["id"] = doc["address"].pop("_id")
    if doc.get("emp_code_start_from"):
        doc["emp_code_start_from"] = _format_start_from(
            doc.get("emp_code_start_from"), doc.get("emp_code_padding")
        )
    return doc


class BuTools:
    async def create(self, data: BusinessUnitCreate) -> dict:
        if not await OrganisationDocument.find_one(OrganisationDocument.id == data.organisation_id, ACTIVE_NOT_DELETED):
            raise HTTPException(status_code=400, detail="Organisation not found or inactive.")

        # Normalize + uniqueness checks
        normalized_prefix = data.emp_code_prefix.strip().upper()
        await _check_prefix_unique(data.organisation_id, normalized_prefix)
        await _check_name_unique(data.organisation_id, data.business_unit_name)

        address = AddressDocument(**data.address.model_dump(), **audit_create())
        await address.insert()
        try:
            bu_fields = data.model_dump(exclude={"address", "emp_code_start_from"})
            bu_fields["emp_code_prefix"] = normalized_prefix
            if data.emp_code_start_from:
                sf = data.emp_code_start_from
                start_map, pad_map = _split_start_from(sf)
                bu_fields["emp_code_start_from"] = start_map
                bu_fields["emp_code_padding"] = pad_map
            bu = BusinessUnitDocument(address_id=address.id, **audit_create(), correlation_id=get_correlation_id(), **bu_fields)
            await bu.insert()
        except Exception:
            await address.delete()
            raise

        await outbox.publish(
            "business_unit.created",
            {
                "correlation_id": get_correlation_id(),
                "business_unit_id": str(bu.id),
                "organisation_id": str(data.organisation_id),
                "name": data.business_unit_name,
                "is_subsidiary": bu.is_subsidiary,
                "is_active": bu.is_active,
                "head_user_id": str(bu.head_user_id) if bu.head_user_id else None,
                "time_zone": bu.time_zone,
                "currency": bu.currency,
            },
            idempotency_key=f"business_unit.created:{bu.id}",
        )
        await outbox.publish_audit_log(
            module="business_units",
            actor_id="system",
            action="created",
            resource=f"business_unit:{bu.id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(data.organisation_id) if data.organisation_id else None,
        )
        return await self.get(bu.id)

    async def get(self, bu_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [{"$match": {"_id": bu_id, **NOT_DELETED}}, *_address_lookup_stages()]
        results = await BusinessUnitDocument.aggregate(pipeline).to_list()
        if not results:
            return None
        doc = _normalize(results[0])
        await attach_custom_fields(doc["organisation_id"], EntityType.BUSINESS_UNIT, [doc])
        return doc

    async def get_all(
        self,
        organisation_id: Optional[PydanticObjectId] = None,
        skip: int = 0,
        limit: int = 20,
        search: str = "",
        is_active: Optional[bool] = None,
        is_subsidiary: Optional[bool] = None,
    ) -> List[dict]:
        match_filter: dict = {**NOT_DELETED}
        if organisation_id:
            match_filter["organisation_id"] = organisation_id
        if is_active is not None:
            match_filter["is_active"] = is_active
        if is_subsidiary is not None:
            match_filter["is_subsidiary"] = is_subsidiary
        if search:
            match_filter["business_unit_name"] = {"$regex": re.escape(search), "$options": "i"}
        pipeline: list[dict] = [
            {"$match": match_filter},
            {"$skip": skip},
            {"$limit": limit},
            *_address_lookup_stages(),
        ]
        results = await BusinessUnitDocument.aggregate(pipeline).to_list()
        docs = [_normalize(doc) for doc in results]
        if docs:
            if organisation_id:
                await attach_custom_fields(organisation_id, EntityType.BUSINESS_UNIT, docs)
            else:
                groups: dict = {}
                for doc in docs:
                    groups.setdefault(doc["organisation_id"], []).append(doc)
                for gorg_id, gdocs in groups.items():
                    await attach_custom_fields(gorg_id, EntityType.BUSINESS_UNIT, gdocs)
        return docs

    async def update(self, bu_id: PydanticObjectId, data: BusinessUnitUpdate) -> Optional[dict]:
        bu = await BusinessUnitDocument.find_one(BusinessUnitDocument.id == bu_id, NOT_DELETED)
        if not bu:
            return None

        update_data = data.model_dump(exclude_unset=True)

        if "is_active" in update_data and update_data["is_active"] is False and bu.is_active is True:
            await check_business_unit_dependencies(bu_id)

        address_payload = update_data.pop("address", None)

        has_employees = await EmployeeDocument.find_one(
            EmployeeDocument.business_unit_id == bu_id, NOT_DELETED
        ) is not None

        start_from_payload = update_data.pop("emp_code_start_from", None)
        if start_from_payload is not None:
            new_start_from, new_padding = _split_start_from(start_from_payload)
            if bu.emp_code_start_from != new_start_from or (bu.emp_code_padding or {}) != new_padding:
                if has_employees:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Employee code start numbers cannot be changed after employees have been created in this business unit.",
                    )
                bu.emp_code_start_from = new_start_from
                bu.emp_code_padding = new_padding

        if "business_unit_name" in update_data and update_data["business_unit_name"]:
            await _check_name_unique(bu.organisation_id, update_data["business_unit_name"], exclude_bu_id=bu.id)

        if "emp_code_prefix" in update_data and update_data["emp_code_prefix"]:
            normalized_prefix = update_data["emp_code_prefix"].strip().upper()
            if normalized_prefix != bu.emp_code_prefix:
                if has_employees:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Employee code prefix cannot be changed after employees have been created in this business unit.",
                    )
                await _check_prefix_unique(bu.organisation_id, normalized_prefix, exclude_bu_id=bu.id)
                update_data["emp_code_prefix"] = normalized_prefix
            else:
                # No-op: same value; drop so save() doesn't touch the field unnecessarily
                update_data.pop("emp_code_prefix", None)

        if address_payload is not None:
            address = await AddressDocument.get(bu.address_id)
            if not address:
                raise HTTPException(status_code=400, detail="Linked address not found.")
            for key, value in address_payload.items():
                setattr(address, key, value)
            stamp_modified(address)
            await address.save()

        bu.correlation_id = get_correlation_id()
        if update_data:
            for key, value in update_data.items():
                setattr(bu, key, value)
        stamp_modified(bu)
        await bu.save()

        changed_fields = list(data.model_dump(exclude_unset=True).keys())
        await outbox.publish(
            "business_unit.updated",
            {
                "correlation_id": get_correlation_id(),
                "business_unit_id": str(bu.id),
                "organisation_id": str(bu.organisation_id),
                "name": bu.business_unit_name,
                "is_subsidiary": bu.is_subsidiary,
                "is_active": bu.is_active,
                "head_user_id": str(bu.head_user_id) if bu.head_user_id else None,
                "time_zone": bu.time_zone,
                "currency": bu.currency,
                "changed_fields": changed_fields,
            },
            idempotency_key=f"business_unit.updated:{bu.id}:{get_correlation_id()}",
        )
        await outbox.publish_audit_log(
            module="business_units",
            actor_id="system",
            action="updated",
            resource=f"business_unit:{bu_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(bu.organisation_id) if bu.organisation_id else None,
            metadata={"changed_fields": changed_fields},
        )
        return await self.get(bu_id)

    async def delete(self, bu_id: PydanticObjectId, actor_id: str) -> bool:
        bu = await BusinessUnitDocument.find_one(BusinessUnitDocument.id == bu_id, NOT_DELETED)
        if not bu:
            return False
        await check_business_unit_dependencies(bu_id)
        now = datetime.now(timezone.utc)
        bu.deleted_on = now
        bu.deleted_by = actor_id
        bu.is_active = False
        bu.correlation_id = get_correlation_id()
        await bu.save()

        if bu.address_id:
            address = await AddressDocument.get(bu.address_id)
            if address and address.deleted_on is None:
                address.deleted_on = now
                address.deleted_by = actor_id
                await address.save()

        await ValueTools().delete_entity_values(
            bu_id,
            actor_id,
            organisation_id=bu.organisation_id,
            entity_type=EntityType.BUSINESS_UNIT,
        )

        await outbox.publish(
            "business_unit.deleted",
            {"correlation_id": get_correlation_id(), "business_unit_id": str(bu_id)},
            idempotency_key=f"business_unit.deleted:{bu_id}",
        )
        await outbox.publish_audit_log(
            module="business_units",
            actor_id=actor_id,
            action="deleted",
            resource=f"business_unit:{bu_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(bu.organisation_id) if bu.organisation_id else None,
        )
        return True

    async def bulk_delete(self, bu_ids: list[PydanticObjectId], actor_id: str) -> int:
        now = datetime.now(timezone.utc)
        cid = get_correlation_id()
        org_ids: set[PydanticObjectId] = set()
        deleted_count = 0

        bus = await BusinessUnitDocument.find(
            {"_id": {"$in": bu_ids}, **NOT_DELETED}
        ).to_list()

        for bu in bus:
            await check_business_unit_dependencies(bu.id)

        for bu in bus:
            bu.deleted_on = now
            bu.deleted_by = actor_id
            bu.is_active = False
            bu.correlation_id = cid
            await bu.save()
            org_ids.add(bu.organisation_id)
            deleted_count += 1

            if bu.address_id:
                address = await AddressDocument.get(bu.address_id)
                if address and address.deleted_on is None:
                    address.deleted_on = now
                    address.deleted_by = actor_id
                    await address.save()

            await ValueTools().delete_entity_values(
                bu.id,
                actor_id,
                organisation_id=bu.organisation_id,
                entity_type=EntityType.BUSINESS_UNIT,
            )

            await outbox.publish(
                "business_unit.deleted",
                {"correlation_id": cid, "business_unit_id": str(bu.id)},
                idempotency_key=f"business_unit.deleted:{bu.id}",
            )

        await outbox.publish_audit_log(
            module="business_units",
            actor_id=actor_id,
            action="bulk_deleted",
            resource=f"business_units:{[str(b.id) for b in bus]}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(next(iter(org_ids))) if len(org_ids) == 1 else None,
            metadata={"count": deleted_count},
        )

        return deleted_count
