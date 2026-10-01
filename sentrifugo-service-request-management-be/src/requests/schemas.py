"""Service-request schemas — Chapters 4–8."""
from __future__ import annotations

from datetime import datetime

from beanie import PydanticObjectId
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..common.validators import ObjectIdList, OptionalObjectId

from ..models import PriorityEnum, RequestStatusEnum


class RequestListRow(BaseModel):
    id: str
    ticket_no: str
    request_type_name: str | None = None
    request_type_id: PydanticObjectId
    requester_user_id: PydanticObjectId
    requester_name: str | None = None
    category_id: PydanticObjectId
    category_name: str | None = None
    priority: PriorityEnum
    created_on: datetime | None = None
    status: RequestStatusEnum
    is_escalated: bool


class RaiseRequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category_id: PydanticObjectId
    request_type_id: PydanticObjectId
    title: str = Field(min_length=5, max_length=200)
    description: str | None = Field(None, max_length=5000)
    priority: PriorityEnum
    attachment_ids: ObjectIdList = Field(default_factory=list, max_length=10)
    # Optional: requester picks an executor up-front. When set + no approval
    # required, the request lands directly in ASSIGNED. When approval is
    # required, the pick is stored and applied after final approval.
    executor_user_id: OptionalObjectId = None

    @field_validator("title", "description", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v


class ApproveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    remarks: str | None = Field(None, max_length=1000)


class RejectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class ResolveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resolution_notes: str = Field(min_length=1, max_length=3000)

    @field_validator("resolution_notes", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class CloseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    closing_remarks: str | None = Field(None, max_length=3000)


class WithdrawBody(BaseModel):
    """Optional free-text reason. Captured in audit trail but not required."""
    model_config = ConfigDict(extra="forbid")
    reason: str | None = Field(None, max_length=2000)


class CommentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str = Field(min_length=1, max_length=3000)

    @field_validator("body", mode="before")
    @classmethod
    def _strip(cls, v: str | None) -> str:
        return (v or "").strip()


class InternalNoteBody(CommentBody):
    pass


class AssignExecutorBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    executor_user_id: PydanticObjectId
    notes: str | None = Field(None, max_length=1000)


class EscalateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    escalate_to_user_id: OptionalObjectId = None
    reason: str = Field(min_length=10, max_length=2000)


class SubmitForApprovalBody(BaseModel):
    """Optional L2 override at submit-for-approval time.

    L1 is always the requester's L1 manager (not overridable). L2 defaults to
    the requester's L2 manager; the executor can pick any leadership-policy
    holder instead.
    """
    model_config = ConfigDict(extra="forbid")
    level_2_approver_user_id: OptionalObjectId = None
