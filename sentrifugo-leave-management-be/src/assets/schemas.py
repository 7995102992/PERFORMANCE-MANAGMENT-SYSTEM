from pydantic import Field, model_validator

from src.models import AuditMixin


class AssetResponse(AuditMixin):
    id: str = Field(alias="_id")
    original_filename: str
    content_type: str
    size: int
    storage_key: str

    @model_validator(mode="before")
    @classmethod
    def _coerce_object_ids(cls, data: dict) -> dict:
        from bson import ObjectId as _OID
        if isinstance(data.get("_id"), _OID):
            data["_id"] = str(data["_id"])
        return data
