from typing import Optional

from beanie import PydanticObjectId
from pydantic import Field, field_validator

from src.models import CustomModel
from src.modules.custom_fields.models import EntityType, FieldType, FileSettings, SectionType


# ---------------------------------------------------------------------------
# Definition schemas
# ---------------------------------------------------------------------------

class DefinitionCreate(CustomModel):
    entity_type: EntityType
    section: SectionType = SectionType.DEFAULT
    name: str = Field(min_length=1, max_length=100)
    field_type: FieldType
    file_settings: Optional[FileSettings] = None
    placeholder: Optional[str] = Field(None, max_length=200)
    help_text: Optional[str] = Field(None, max_length=500)
    is_required: bool = False
    sort_order: int = 0

    @field_validator("file_settings")
    @classmethod
    def validate_file_settings(cls, v, info):
        ft = info.data.get("field_type")
        if ft == FieldType.FILE and v is None:
            raise ValueError("file_settings is required for file field type")
        if ft != FieldType.FILE and v is not None:
            raise ValueError("file_settings is only allowed for file field type")
        return v

    @field_validator("section")
    @classmethod
    def validate_section(cls, v, info):
        et = info.data.get("entity_type")
        exit_sections = {SectionType.DEFAULT, SectionType.IT_CLEARANCE, SectionType.ADMIN_CLEARANCE, SectionType.FINANCE_CLEARANCE, SectionType.MANAGER_CLEARANCE, SectionType.HR_CLEARANCE}
        if et == EntityType.EXIT_REQUEST and v not in exit_sections:
            raise ValueError("section must be 'default', 'it_clearance', 'admin_clearance', 'finance_clearance', 'manager_clearance', or 'hr_clearance' for exit_request")
        elif et != EntityType.EMPLOYEE and et != EntityType.EXIT_REQUEST and v != SectionType.DEFAULT:
            raise ValueError("section must be 'default' for non-employee entity types")
        return v


class DefinitionUpdate(CustomModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    field_type: Optional[FieldType] = None
    section: Optional[SectionType] = None
    file_settings: Optional[FileSettings] = None
    placeholder: Optional[str] = Field(None, max_length=200)
    help_text: Optional[str] = Field(None, max_length=500)
    is_required: Optional[bool] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class DefinitionResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId
    entity_type: EntityType
    section: SectionType
    name: str
    key: str
    field_type: FieldType
    file_settings: Optional[FileSettings] = None
    placeholder: Optional[str] = None
    help_text: Optional[str] = None
    is_required: bool
    sort_order: int
    is_active: bool


# ---------------------------------------------------------------------------
# Option schemas
# ---------------------------------------------------------------------------

class OptionCreate(CustomModel):
    label: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=100)
    sort_order: int = 0


class OptionUpdate(CustomModel):
    label: Optional[str] = Field(None, min_length=1, max_length=100)
    value: Optional[str] = Field(None, min_length=1, max_length=100)
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class OptionResponse(CustomModel):
    id: PydanticObjectId
    field_definition_id: PydanticObjectId
    label: str
    value: str
    sort_order: int
    is_active: bool


# ---------------------------------------------------------------------------
# Value schemas
# ---------------------------------------------------------------------------

class ValueUpsert(CustomModel):
    field_definition_id: PydanticObjectId
    value: Optional[str] = None
    option_ids: list[PydanticObjectId] = Field(default_factory=list)


class ValueResponse(CustomModel):
    id: PydanticObjectId
    field_definition_id: PydanticObjectId
    value: Optional[str] = None
    option_ids: list[PydanticObjectId] = Field(default_factory=list)


class FieldWithValue(CustomModel):
    definition: DefinitionResponse
    options: list[OptionResponse] = Field(default_factory=list)
    value: Optional[ValueResponse] = None


class EntityValuesResponse(CustomModel):
    entity_id: PydanticObjectId
    entity_type: EntityType
    fields: list[FieldWithValue] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Reorder schemas
# ---------------------------------------------------------------------------

class ReorderItem(CustomModel):
    id: PydanticObjectId
    sort_order: int


class ReorderRequest(CustomModel):
    items: list[ReorderItem] = Field(min_length=1)
