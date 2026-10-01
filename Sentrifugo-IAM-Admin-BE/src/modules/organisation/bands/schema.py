from datetime import date
from typing import Optional
from beanie import PydanticObjectId
from pydantic import Field, field_validator, model_validator
from src.models import CustomModel, MasterDataCompact


class BandBase(CustomModel):
    organisation_id: Optional[PydanticObjectId] = Field(None, alias="organisationId")
    name: str = Field(..., min_length=1)
    class_label: Optional[PydanticObjectId] = Field(None, alias="classLabel")
    frequency: Optional[PydanticObjectId] = None
    # Currency / amounts are optional — the user fills them in if they want.
    currency: Optional[str] = None
    min_amount: Optional[float] = Field(None, alias="minAmount", ge=0)
    max_amount: Optional[float] = Field(None, alias="maxAmount", ge=0)
    effective_from: Optional[date] = Field(None, alias="effectiveFrom")
    effective_to: Optional[date] = Field(None, alias="effectiveTo")
    notes: Optional[str] = ""
    is_active: bool = True

    @field_validator("notes", mode="before")
    @classmethod
    def notes_null_to_empty(cls, v):
        return v if v is not None else ""


class BandCreate(BandBase):
    @model_validator(mode="after")
    def _validate_effective_dates(self):
        # To without From is nonsensical; same-day or backwards range is invalid.
        # From alone (open-ended) and both empty are both allowed.
        if self.effective_to is not None:
            if self.effective_from is None:
                raise ValueError("Effective From is required when Effective To is provided.")
            if self.effective_to <= self.effective_from:
                raise ValueError("Effective To must be after Effective From.")
        return self


class BandResponse(BandBase):
    id: PydanticObjectId
    class_label: Optional[MasterDataCompact] = Field(None, alias="classLabel")
    frequency: Optional[MasterDataCompact] = None


class BandUpdate(CustomModel):
    name: Optional[str] = Field(None, min_length=1)
    class_label: Optional[PydanticObjectId] = Field(None, alias="classLabel")
    frequency: Optional[PydanticObjectId] = None
    currency: Optional[str] = Field(None, min_length=1)
    min_amount: Optional[float] = Field(None, alias="minAmount", ge=0)
    max_amount: Optional[float] = Field(None, alias="maxAmount", ge=0)
    effective_from: Optional[date] = Field(None, alias="effectiveFrom")
    effective_to: Optional[date] = Field(None, alias="effectiveTo")
    notes: Optional[str] = None
    is_active: Optional[bool] = None

    @field_validator("notes", mode="before")
    @classmethod
    def notes_null_to_empty(cls, v):
        return v if v is not None else ""
