from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from pymongo.errors import DuplicateKeyError
from fastapi import HTTPException, status
from src.assets import asset_service
from src.auth.models import UserDocument
from src.correlation import get_correlation_id, audit_create, stamp_modified
from src.models import StatusEnum
from src.utils import hash_default_password
from src.modules.organisation.models import OrganisationDocument, AddressDocument
from src.modules.organisation.organisation.schema import OrganisationCreate, OrganisationUpdate
from src.modules.organisation.dependency_check import check_organisation_dependencies
from src.modules.custom_fields.models import EntityType
from src.modules.custom_fields.utils.tools import attach_custom_fields
from src.rabbitmq import DebugLevel, outbox

NOT_DELETED = {"deleted_on": None}


def _org_event_payload(org: OrganisationDocument) -> dict:
    return {
        "organisation_id": str(org.id),
        "correlation_id": get_correlation_id(),
        "legal_name": org.legal_name,
        "head_user_id": str(org.head_user_id) if org.head_user_id else None,
        "financial_year": org.financial_year,
        "currency": org.currency,
        "timezone": org.timezone,
        "is_multiple_business_units": org.is_multiple_business_units,
        "is_active": org.is_active,
        "enabled_modules": [{"code": m.code.value, "is_active": m.is_active} for m in org.enabled_modules],
        "setup_status": org.setup_status,
        "created_by": org.created_by,
        "created_on": org.created_on.isoformat() if org.created_on else None,
        "modified_by": org.modified_by,
        "modified_on": org.modified_on.isoformat() if org.modified_on else None,
        "deleted_by": org.deleted_by,
        "deleted_on": org.deleted_on.isoformat() if org.deleted_on else None,
    }


def _lookup_stages() -> list[dict]:
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
        {
            "$lookup": {
                "from": "assets",
                "localField": "logo_asset_id",
                "foreignField": "_id",
                "as": "_logo_asset",
            }
        },
        {"$unwind": {"path": "$_logo_asset", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {"logo_url": "$_logo_asset.file_url"}},
        {"$project": {"_logo_asset": 0}},
        {"$lookup": {"from": "users", "localField": "head_user_id", "foreignField": "_id", "as": "_head_user"}},
        {"$unwind": {"path": "$_head_user", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": "employees", "localField": "head_user_id", "foreignField": "user_id", "as": "_head_emp"}},
        {"$unwind": {"path": "$_head_emp", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
            "head_employee_name": {"$concat": [{"$ifNull": ["$_head_user.first_name", ""]}, " ", {"$ifNull": ["$_head_user.last_name", ""]}]},
            "head_emp_code": "$_head_emp.emp_code",
        }},
        {"$project": {"_head_user": 0, "_head_emp": 0}},
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    if doc.get("address"):
        doc["address"]["id"] = doc["address"].pop("_id")
    return doc


class OrgTools:
    async def create(self, data: OrganisationCreate) -> dict:
        existing_user = await UserDocument.find_one(
            UserDocument.email == (data.admin_email or "").strip().lower()
        )
        if existing_user and existing_user.deleted_on is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A user with email '{data.admin_email}' already exists.",
            )

        address = AddressDocument(**data.address.model_dump(), **audit_create())
        await address.insert()
        try:
            org_fields = data.model_dump(exclude={"address", "admin_email", "admin_first_name", "admin_last_name"})
            org = OrganisationDocument(
                address_id=address.id,
                **audit_create(),
                correlation_id=get_correlation_id(),
                **org_fields,
            )
            await org.insert()
        except Exception:
            await address.delete()
            raise

        try:
            admin_user = UserDocument(
                email=data.admin_email,
                password_hash=hash_default_password(),
                auth_method="local",
                first_name=data.admin_first_name,
                last_name=data.admin_last_name,
                status=StatusEnum.ACTIVE,
                is_org_admin=True,
                organisation_id=org.id,
                **audit_create(),
            )
            await admin_user.insert()
        except Exception:
            await org.delete()
            await address.delete()
            raise

        await outbox.publish(
            "organisation.created",
            _org_event_payload(org),
            idempotency_key=f"organisation.created:{org.id}",
        )
        await outbox.publish_audit_log(
            module="organisations",
            actor_id="system",
            action="created",
            resource=f"organisation:{org.id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(org.id),
        )
        return await self.get(org.id)

    async def get(self, org_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [{"$match": {"_id": org_id, **NOT_DELETED}}, *_lookup_stages()]
        results = await OrganisationDocument.aggregate(pipeline).to_list()
        if not results:
            return None
        doc = _normalize(results[0])
        await attach_custom_fields(doc["id"], EntityType.ORGANISATION, [doc])
        return doc

    async def get_all(
        self,
        skip: int = 0,
        limit: int = 20,
        search: str = "",
    ) -> List[dict]:
        match_filter: dict = {**NOT_DELETED}
        if search:
            match_filter["legal_name"] = {"$regex": search, "$options": "i"}
        pipeline: list[dict] = [
            {"$match": match_filter},
            {"$skip": skip},
            {"$limit": limit},
            *_lookup_stages(),
        ]
        results = await OrganisationDocument.aggregate(pipeline).to_list()
        docs = [_normalize(doc) for doc in results]
        for doc in docs:
            await attach_custom_fields(doc["id"], EntityType.ORGANISATION, [doc])
        return docs

    async def update(self, org_id: PydanticObjectId, data: OrganisationUpdate) -> Optional[dict]:
        org = await OrganisationDocument.find_one(
            OrganisationDocument.id == org_id,
            NOT_DELETED,
        )
        if not org:
            return None

        update_data = data.model_dump(exclude_unset=True)

        if "is_active" in update_data and update_data["is_active"] is False and org.is_active is True:
            await check_organisation_dependencies(org_id)

        address_payload = update_data.pop("address", None)

        new_logo_asset_id = update_data.get("logo_asset_id")
        if new_logo_asset_id and org.logo_asset_id and new_logo_asset_id != org.logo_asset_id:
            await asset_service.soft_delete(org.logo_asset_id)

        if address_payload is not None:
            address = await AddressDocument.get(org.address_id) if org.address_id else None
            if address:
                for key, value in address_payload.items():
                    setattr(address, key, value)
                await address.save()
            else:
                # Org was created without an address (e.g. via super-admin portal) — create one now
                address = AddressDocument(**address_payload)
                await address.insert()
                org.address_id = address.id
                update_data["address_id"] = address.id

        # Pre-save uniqueness check: ensure no *other* organisation already uses this legal_name.
        new_legal_name = update_data.get("legal_name")
        if new_legal_name and new_legal_name.lower() != (org.legal_name or "").lower():
            duplicate = await OrganisationDocument.find_one({
                "legal_name": new_legal_name,
                "_id": {"$ne": org_id},
                **NOT_DELETED,
            })
            if duplicate:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"An organisation with legal name '{new_legal_name}' already exists.",
                )

        stamp_modified(org)
        org.correlation_id = get_correlation_id()
        if update_data:
            for key, value in update_data.items():
                setattr(org, key, value)
        try:
            await org.save()
        except DuplicateKeyError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"An organisation with legal name '{org.legal_name}' already exists.",
            )

        await outbox.publish(
            "organisation.updated",
            {**_org_event_payload(org), "changed_fields": list(data.model_dump(exclude_unset=True).keys())},
            idempotency_key=f"organisation.updated:{org_id}:{datetime.now(timezone.utc).isoformat()}",
        )
        await outbox.publish_audit_log(
            module="organisations",
            actor_id="system",
            action="updated",
            resource=f"organisation:{org_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(org_id),
            metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
        )
        return await self.get(org_id)

    async def delete(self, org_id: PydanticObjectId, actor_id: str) -> bool:
        org = await OrganisationDocument.find_one(
            OrganisationDocument.id == org_id,
            NOT_DELETED,
        )
        if not org:
            return False
        org.deleted_on = datetime.now(timezone.utc)
        org.deleted_by = actor_id
        org.is_active = False
        org.correlation_id = get_correlation_id()
        await org.save()

        await outbox.publish(
            "organisation.deleted",
            _org_event_payload(org),
            idempotency_key=f"organisation.deleted:{org_id}",
        )
        await outbox.publish_audit_log(
            module="organisations",
            actor_id=actor_id,
            action="deleted",
            resource=f"organisation:{org_id}",
            debug_level=DebugLevel.ADMIN,
            organisation_id=str(org_id),
        )
        return True
