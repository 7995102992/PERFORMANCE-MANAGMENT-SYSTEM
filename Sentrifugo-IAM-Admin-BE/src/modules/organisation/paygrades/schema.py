from typing import Optional
from beanie import PydanticObjectId
from pydantic import Field, field_validator
from src.models import CustomModel


class PayGradeBase(CustomModel):
    organisation_id: Optional[PydanticObjectId] = Field(None, alias="organisationId")
    name: str = Field(..., min_length=1)
    description: Optional[str] = ""
    band_ids: list[PydanticObjectId] = Field(default_factory=list, alias="bandIds")
    is_active: bool = True

    @field_validator("description", mode="before")
    @classmethod
    def description_null_to_empty(cls, v):
        return v if v is not None else ""


class PayGradeCreate(PayGradeBase):
    pass


class PayGradeResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId = Field(..., alias="organisationId")
    name: str
    description: str = ""
    band_ids: list[PydanticObjectId] = Field(default_factory=list, alias="bandIds")
    band_names: list[str] = Field(default_factory=list, alias="bandNames")
    is_active: bool = True


class PayGradeUpdate(CustomModel):
    name: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    band_ids: Optional[list[PydanticObjectId]] = Field(None, alias="bandIds")
    is_active: Optional[bool] = None

    @field_validator("description", mode="before")
    @classmethod
    def description_null_to_empty(cls, v):
        return v if v is not None else ""
