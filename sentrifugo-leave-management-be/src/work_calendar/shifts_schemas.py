from typing import Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class ShiftCreate(CustomModel):
    calendar_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=80)
    start_time: str = Field(pattern=TIME_PATTERN)
    end_time: str = Field(pattern=TIME_PATTERN)
    break_minutes: int = Field(default=0, ge=0, le=24 * 60)

    @model_validator(mode="after")
    def _validate(self) -> "ShiftCreate":
        if self.start_time == self.end_time:
            raise ValueError("start_time and end_time must differ")
        return self


class ShiftUpdate(CustomModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    start_time: Optional[str] = Field(default=None, pattern=TIME_PATTERN)
    end_time: Optional[str] = Field(default=None, pattern=TIME_PATTERN)
    break_minutes: Optional[int] = Field(default=None, ge=0, le=24 * 60)

    @model_validator(mode="after")
    def _validate(self) -> "ShiftUpdate":
        if self.start_time and self.end_time and self.start_time == self.end_time:
            raise ValueError("start_time and end_time must differ")
        return self


class ShiftResponse(AuditMixin):
    id: str = Field(alias="_id")
    calendar_id: str
    name: str
    start_time: str
    end_time: str
    break_minutes: int

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "calendar_id"):
            if data.get(field) is not None and not isinstance(data[field], str):
                data[field] = str(data[field])
        return data
