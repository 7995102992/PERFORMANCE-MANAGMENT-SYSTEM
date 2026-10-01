from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.exceptions import DomainException
from src.holiday_classifications.schemas import ClassificationCreate, ClassificationUpdate
from src.logger import logger
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update
from src.utils import to_oid

COLLECTION = "holiday_classifications"


async def create_classification(
    db: AsyncIOMotorDatabase, payload: ClassificationCreate, org_id: str, user_id: str
) -> dict:
    existing = await db[COLLECTION].find_one(
        {"org_id": to_oid(org_id), "name": payload.name, "deleted_on": None}
    )
    if existing:
        raise DomainException(
            message=f"Classification '{payload.name}' already exists",
            code="DUPLICATE_CLASSIFICATION",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "org_id": to_oid(org_id),
        "name": payload.name,
        "color": payload.color,
        **audit_fields_create(user_id),
    }
    await db[COLLECTION].insert_one(doc)
    logger.info("Classification created", classification_id=doc["_id"], name=payload.name)
    await emit_audit(
        action="classification.created",
        resource=f"classification:{doc['_id']}",
        actor_id=user_id,
        organisation_id=org_id,
        details={"name": payload.name},
    )
    return doc


async def list_classifications(
    db: AsyncIOMotorDatabase, org_id: str
) -> list[dict]:
    cursor = db[COLLECTION].find(
        {"org_id": to_oid(org_id), "deleted_on": None}
    ).sort("name", 1)
    return await cursor.to_list(length=None)


async def get_classification(
    db: AsyncIOMotorDatabase,
    classification_id: str,
    *,
    expected_org_id=None,
) -> dict:
    query: dict = {"_id": to_oid(classification_id), "deleted_on": None}
    if expected_org_id:
        query["org_id"] = {"$in": [to_oid(expected_org_id), str(expected_org_id)]}
    doc = await db[COLLECTION].find_one(query)
    if not doc:
        raise DomainException(
            message="Classification not found",
            code="CLASSIFICATION_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def update_classification(
    db: AsyncIOMotorDatabase,
    classification_id: str,
    payload: ClassificationUpdate,
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    existing = await get_classification(db, classification_id, expected_org_id=current_user_org_id)

    update_data = payload.model_dump(exclude_none=True)
    if not update_data:
        return existing

    if "name" in update_data:
        dup = await db[COLLECTION].find_one({
            "org_id": existing["org_id"],
            "name": update_data["name"],
            "deleted_on": None,
            "_id": {"$ne": to_oid(classification_id)},
        })
        if dup:
            raise DomainException(
                message=f"Classification '{update_data['name']}' already exists",
                code="DUPLICATE_CLASSIFICATION",
                status_code=status.HTTP_409_CONFLICT,
            )

    changed_fields = list(update_data.keys())
    update_data.update(audit_fields_update(user_id))
    await db[COLLECTION].update_one({"_id": to_oid(classification_id)}, {"$set": update_data})
    logger.info("Classification updated", classification_id=classification_id)
    await emit_audit(
        action="classification.updated",
        resource=f"classification:{classification_id}",
        actor_id=user_id,
        organisation_id=existing.get("org_id"),
        changed_fields=changed_fields,
    )
    return await get_classification(db, classification_id, expected_org_id=current_user_org_id)


async def delete_classification(
    db: AsyncIOMotorDatabase,
    classification_id: str,
    user_id: str,
    *,
    current_user_org_id=None,
) -> None:
    existing = await get_classification(db, classification_id, expected_org_id=current_user_org_id)
    await db[COLLECTION].update_one(
        {"_id": to_oid(classification_id)}, {"$set": audit_fields_delete(user_id)}
    )
    logger.info("Classification soft-deleted", classification_id=classification_id)
    await emit_audit(
        action="classification.deleted",
        resource=f"classification:{classification_id}",
        actor_id=user_id,
        organisation_id=existing.get("org_id"),
    )
