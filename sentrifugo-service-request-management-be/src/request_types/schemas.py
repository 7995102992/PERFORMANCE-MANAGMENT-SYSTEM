"""RequestType + SLA schemas — Chapters 2 + 3 + 5."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from beanie import PydanticObjectId

from ..common.validators import ObjectIdList, OptionalObjectId
from ..models import PriorityEnum, SLAViolationAction, StatusEnum


class SLARuleIn(BaseModel):
    priority: PriorityEnum
    first_response_minutes: int = Field(gt=0)
    resolution_minutes: int = Field(gt=0)
    business_hours_only: bool = True
    description: str | None = Field(None, max_length=500)
    violation_actions: list[SLAViolationAction] = Field(default_factory=list)
    notification_recipients: ObjectIdList = Field(default_factory=list, max_length=20)
    status: StatusEnum = StatusEnum.ACTIVE

    @model_validator(mode="after")
    def _check_times(self) -> "SLARuleIn":
        if self.first_response_minutes > self.resolution_minutes:
            from ..exceptions import SlaRuleInvalidTimes
            raise SlaRuleInvalidTimes()
        return self


class RequestTypeCreate(BaseModel):
    category_id: PydanticObjectId
    name: str = Field(min_length=3, max_length=100)
    description: str | None = Field(None, max_length=250)
    status: StatusEnum = StatusEnum.ACTIVE
    sla_rules: list[SLARuleIn] = Field(default_factory=list)

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()

    @field_validator("description", mode="before")
    @classmethod
    def _strip_desc(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _check_rules(self) -> "RequestTypeCreate":
        if not self.sla_rules:
            from ..exceptions import SlaRuleEmpty
            raise SlaRuleEmpty()
        seen: set[PriorityEnum] = set()
        for r in self.sla_rules:
            if r.priority in seen:
                from ..exceptions import SlaRuleDuplicatePriorityInPayload
                raise SlaRuleDuplicatePriorityInPayload()
            seen.add(r.priority)
            
        required_priorities = {PriorityEnum.LOW, PriorityEnum.MEDIUM, PriorityEnum.HIGH, PriorityEnum.URGENT}
        if seen != required_priorities:
            from ..exceptions import SlaRuleMissingPriority
            raise SlaRuleMissingPriority()
        return self


class RequestTypeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=3, max_length=100)
    description: str | None = Field(None, max_length=250)
    status: StatusEnum | None = None
    category_id: OptionalObjectId = None
    sla_rules: list[SLARuleIn] | None = None  # when sent, fully replaces

    @field_validator("name", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _check_rules(self) -> "RequestTypeUpdate":
        if self.sla_rules is None:
            return self
        if not self.sla_rules:
            from ..exceptions import SlaRuleEmpty
            raise SlaRuleEmpty()
        seen: set[PriorityEnum] = set()
        for r in self.sla_rules:
            if r.priority in seen:
                from ..exceptions import SlaRuleDuplicatePriorityInPayload
                raise SlaRuleDuplicatePriorityInPayload()
            seen.add(r.priority)
            
        required_priorities = {PriorityEnum.LOW, PriorityEnum.MEDIUM, PriorityEnum.HIGH, PriorityEnum.URGENT}
        if seen != required_priorities:
            from ..exceptions import SlaRuleMissingPriority
            raise SlaRuleMissingPriority()
        return self


class SLARuleOut(BaseModel):
    id: str
    priority: PriorityEnum
    first_response_minutes: int
    resolution_minutes: int
    business_hours_only: bool
    description: str | None = None
    violation_actions: list[SLAViolationAction]
    notification_recipients: list[PydanticObjectId]
    status: StatusEnum


class RequestTypeOut(BaseModel):
    id: str
    organisation_id: PydanticObjectId
    category_id: PydanticObjectId
    name: str
    description: str | None = None
    status: StatusEnum
    sla_rules: list[SLARuleOut] = Field(default_factory=list)
    created_by: PydanticObjectId | None = None
    created_on: datetime | None = None
    modified_by: PydanticObjectId | None = None
    modified_on: datetime | None = None


class RequestTypeListRow(BaseModel):
    # Chapter 3: one row per (request_type, priority) pair for the table.
    request_type_id: PydanticObjectId
    category_id: PydanticObjectId
    category_name: str | None = None
    request_type_name: str
    priority: PriorityEnum
    first_response_minutes: int
    resolution_minutes: int
    business_hours_only: bool
    violation_actions: list[SLAViolationAction]
    status: StatusEnum
