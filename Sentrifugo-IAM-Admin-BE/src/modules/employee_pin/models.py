from datetime import datetime, timezone
from typing import Optional

from beanie import Document, PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, IndexModel


class EmployeePinDocument(Document):
    # Optional so a caller sending an empty/invalid organisation_id doesn't crash
    # PIN creation with a ValidationError (user_id is the real key).
    organisation_id: Optional[PydanticObjectId] = None
    business_unit_id: Optional[PydanticObjectId] = None
    user_id: PydanticObjectId
    cipher_text: Optional[str] = None
    iv_key: Optional[str] = None
    correlation_id: Optional[str] = None
    created_on: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_on: Optional[datetime] = None
    deleted_on: Optional[datetime] = None

    class Settings:
        name = "employee_pin"
        indexes = [
            IndexModel([("user_id", ASCENDING)], unique=True),
            IndexModel([("organisation_id", ASCENDING)]),
        ]
