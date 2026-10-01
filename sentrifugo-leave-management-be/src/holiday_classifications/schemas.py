from typing import Optional

from pydantic import Field

from src.models import AuditMixin, CustomModel


class ClassificationCreate(CustomModel):
    name: str
    color: str = Field(default="#6b7280", pattern=r"^#[0-9a-fA-F]{6}$")


class ClassificationUpdate(CustomModel):
    name: Optional[str] = None
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class ClassificationResponse(AuditMixin):
    id: str = Field(alias="_id")
    org_id: str
    name: str
    color: str

    @classmethod
    def from_doc(cls, doc: dict) -> "ClassificationResponse":
        for field in ("_id", "org_id"):
            if doc.get(field) is not None:
                doc[field] = str(doc[field])
        return cls(**doc)
