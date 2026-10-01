import uuid
from datetime import datetime, timezone
from typing import Optional
from bson import ObjectId
from pydantic import BaseModel, ConfigDict, field_serializer, model_validator
from src.utils import to_oid

class CustomModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
        arbitrary_types_allowed=True
    )


class AuditMixin(CustomModel):
    """Mixin for all persisted documents. Soft-delete is indicated by deleted_on/deleted_by being set."""
    created_on: datetime
    created_by: Optional[ObjectId] = None
    updated_on: Optional[datetime] = None
    updated_by: Optional[ObjectId] = None
    deleted_on: Optional[datetime] = None
    deleted_by: Optional[ObjectId] = None
    correlation_id: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_audit_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("created_by", "updated_by", "deleted_by"):
            v = data.get(field)
            if v is not None and not isinstance(v, ObjectId):
                data[field] = ObjectId(v)
        return data

    @field_serializer("created_by", "updated_by", "deleted_by")
    def serialize_objectid(self, v: Optional[ObjectId]) -> Optional[str]:
        return str(v) if v is not None else None


def audit_fields_create(user_id: str, correlation_id: Optional[str] = None) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "created_on": now,
        "created_by": to_oid(user_id),
        "updated_on": None,
        "updated_by": None,
        "deleted_on": None,
        "deleted_by": None,
        "correlation_id": correlation_id or str(uuid.uuid4()),
    }


def audit_fields_update(user_id: str) -> dict:
    return {
        "updated_on": datetime.now(timezone.utc),
        "updated_by": to_oid(user_id),
    }


def audit_fields_delete(user_id: str) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "deleted_on": now,
        "deleted_by": to_oid(user_id),
        "updated_on": now,
        "updated_by": to_oid(user_id),
    }
