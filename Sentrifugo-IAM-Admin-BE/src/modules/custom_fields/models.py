from datetime import date
from enum import Enum
from typing import Optional

from beanie import Document, PydanticObjectId
from pydantic import BaseModel, Field
from pymongo import ASCENDING, IndexModel

from src.models import AuditMixin


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class EntityType(str, Enum):
    ORGANISATION = "organisation"
    BUSINESS_UNIT = "business_unit"
    DEPARTMENT = "department"
    EMPLOYEE = "employee"
    EXIT_REQUEST = "exit_request"


class SectionType(str, Enum):
    DEFAULT = "default"
    BASIC = "basic"
    WORK = "work"
    PERSONAL = "personal"
    IDENTITY = "identity"
    CONTACT = "contact"
    EMERGENCY = "emergency"
    EXPERIENCE = "experience"
    DEPENDENTS = "dependents"
    EDUCATION = "education"
    IT_CLEARANCE = "it_clearance"
    ADMIN_CLEARANCE = "admin_clearance"
    FINANCE_CLEARANCE = "finance_clearance"
    MANAGER_CLEARANCE = "manager_clearance"
    HR_CLEARANCE = "hr_clearance"


class FieldType(str, Enum):
    TEXT = "text"
    TEXTAREA = "textarea"
    NUMBER = "number"
    DATE = "date"
    SINGLE_SELECT = "single_select"
    MULTI_SELECT = "multi_select"
    RADIO = "radio"
    CHECKBOX = "checkbox"
    FILE = "file"
    URL = "url"
    EMAIL = "email"
    PHONE = "phone"


OPTION_FIELD_TYPES = {FieldType.SINGLE_SELECT, FieldType.MULTI_SELECT, FieldType.RADIO, FieldType.CHECKBOX}
SINGLE_OPTION_TYPES = {FieldType.SINGLE_SELECT, FieldType.RADIO}
MULTI_OPTION_TYPES = {FieldType.MULTI_SELECT, FieldType.CHECKBOX}


# ---------------------------------------------------------------------------
# Embedded models
# ---------------------------------------------------------------------------

class FileSettings(BaseModel):
    max_size_mb: int = 5
    allowed_file_types: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Document 1: Definitions
# ---------------------------------------------------------------------------

class CustomFieldDefinitionDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    entity_type: EntityType
    section: SectionType = SectionType.DEFAULT
    name: str
    key: str
    field_type: FieldType
    file_settings: Optional[FileSettings] = None
    placeholder: Optional[str] = None
    help_text: Optional[str] = None
    is_required: bool = False
    sort_order: int = 0
    is_active: bool = True

    class Settings:
        name = "custom_field_definitions"
        indexes = [
            IndexModel(
                [
                    ("organisation_id", ASCENDING),
                    ("entity_type", ASCENDING),
                    ("section", ASCENDING),
                    ("is_active", ASCENDING),
                ],
            ),
            IndexModel(
                [
                    ("organisation_id", ASCENDING),
                    ("entity_type", ASCENDING),
                    ("key", ASCENDING),
                ],
                unique=True,
                partialFilterExpression={"is_active": True},
            ),
        ]


# ---------------------------------------------------------------------------
# Document 2: Options
# ---------------------------------------------------------------------------

class CustomFieldOptionDocument(Document, AuditMixin):
    field_definition_id: PydanticObjectId
    label: str
    value: str
    sort_order: int = 0
    is_active: bool = True

    class Settings:
        name = "custom_field_options"
        indexes = [
            IndexModel(
                [
                    ("field_definition_id", ASCENDING),
                    ("is_active", ASCENDING),
                    ("sort_order", ASCENDING),
                ],
            ),
            IndexModel(
                [("field_definition_id", ASCENDING), ("value", ASCENDING)],
                unique=True,
                partialFilterExpression={"is_active": True},
            ),
        ]


# ---------------------------------------------------------------------------
# Document 3: Values
# ---------------------------------------------------------------------------

class CustomFieldValueDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    field_definition_id: PydanticObjectId
    entity_id: PydanticObjectId
    entity_type: EntityType
    value: Optional[str] = None
    option_ids: list[PydanticObjectId] = Field(default_factory=list)

    class Settings:
        name = "custom_field_values"
        indexes = [
            IndexModel(
                [
                    ("organisation_id", ASCENDING),
                    ("entity_id", ASCENDING),
                    ("entity_type", ASCENDING),
                ],
            ),
            IndexModel(
                [("field_definition_id", ASCENDING), ("entity_id", ASCENDING)],
                unique=True,
            ),
        ]
