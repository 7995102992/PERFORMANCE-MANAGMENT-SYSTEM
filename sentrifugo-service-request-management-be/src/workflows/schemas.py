"""Workflow schemas — Chapters 3 + 4."""
from __future__ import annotations

from datetime import datetime

from beanie import PydanticObjectId
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..common.validators import OptionalObjectId

from ..models import (
    ApprovalLogicEnum,
    ApproverTypeEnum,
    NotificationMethodEnum,
    StatusEnum,
)


class ApproverIn(BaseModel):
    approver_type: ApproverTypeEnum = ApproverTypeEnum.SPECIFIC_USER
    approver_user_id: PydanticObjectId
    sort_order: int = 0


class ApprovalLevelIn(BaseModel):
    level_index: int = Field(ge=1)
    logic: ApprovalLogicEnum = ApprovalLogicEnum.AND
    approvers: list[ApproverIn] = Field(default_factory=list)


class EscalationConfigIn(BaseModel):
    auto_escalate_enabled: bool = False
    escalate_after_minutes: int | None = None
    escalate_to_user_id: OptionalObjectId = None
    pre_notify_enabled: bool = False
    pre_notify_minutes_before: int | None = None
    notification_methods: list[NotificationMethodEnum] = Field(default_factory=list)
    notify_on: list[str] = Field(default_factory=list)


class WorkflowCreate(BaseModel):
    category_id: PydanticObjectId
    request_type_id: PydanticObjectId
    approval_required: bool
    approval_levels: list[ApprovalLevelIn] = Field(default_factory=list)
    escalation_config: EscalationConfigIn | None = None

    @model_validator(mode="after")
    def _check(self) -> "WorkflowCreate":
        """Validate the workflow payload.

        Approval routing is now resolved per-ticket from the requester's
        reporting chain (L1 = L1 manager, L2 = L2 manager / leadership pick),
        so the workflow doc no longer carries level/approver configuration.
        The validator only enforces escalation-config consistency now.
        Any legacy `approval_levels` sent by older clients is ignored
        downstream; we don't reject the payload.
        """
        from ..exceptions import (
            WorkflowApproverDuplicateInLevel,
            WorkflowEscalationRequired,
            WorkflowLevelsNotSequential,
            WorkflowPreNotifyTooLate,
        )

        # If a client still sends approval_levels (legacy payload), keep the
        # sanity checks on shape so bad data can't sneak in. Empty is fine.
        if self.approval_levels:
            indices = sorted(l.level_index for l in self.approval_levels)
            if indices != list(range(1, len(indices) + 1)):
                raise WorkflowLevelsNotSequential()
            for level in self.approval_levels:
                seen: set[str] = set()
                for a in level.approvers:
                    if a.approver_user_id in seen:
                        raise WorkflowApproverDuplicateInLevel()
                    seen.add(a.approver_user_id)

        # Escalation is optional. Validate only if it was sent.
        ec = self.escalation_config
        if ec is not None:
            if ec.auto_escalate_enabled:
                if not ec.escalate_after_minutes or ec.escalate_after_minutes <= 0:
                    raise WorkflowEscalationRequired()
                if not ec.escalate_to_user_id:
                    raise WorkflowEscalationRequired()
            if ec.pre_notify_enabled:
                if not ec.pre_notify_minutes_before or ec.pre_notify_minutes_before <= 0:
                    raise WorkflowPreNotifyTooLate()
                if ec.escalate_after_minutes and ec.pre_notify_minutes_before >= ec.escalate_after_minutes:
                    raise WorkflowPreNotifyTooLate()
        return self


class WorkflowUpdate(WorkflowCreate):
    # Same shape as create; category_id + request_type_id pinned after create
    # but allowed in PUT for parity with FE. Service will enforce invariants.
    status: StatusEnum | None = None
    model_config = ConfigDict(extra="forbid")


class ApproverOut(BaseModel):
    user_id: PydanticObjectId
    name: str | None = None
    role: str | None = None
    sort_order: int = 0


class ApprovalLevelOut(BaseModel):
    level_index: int
    logic: ApprovalLogicEnum
    approvers: list[ApproverOut] = Field(default_factory=list)


class EscalationConfigOut(BaseModel):
    auto_escalate_enabled: bool
    escalate_after_minutes: int | None = None
    escalate_to_user_id: PydanticObjectId | None = None
    escalate_to_name: str | None = None
    pre_notify_enabled: bool = False
    pre_notify_minutes_before: int | None = None
    notification_methods: list[NotificationMethodEnum] = Field(default_factory=list)
    notify_on: list[str] = Field(default_factory=list)


class WorkflowOut(BaseModel):
    id: str
    organisation_id: PydanticObjectId
    category_id: PydanticObjectId
    request_type_id: PydanticObjectId
    primary_assignee_user_id: PydanticObjectId
    primary_assignee_name: str | None = None
    approval_required: bool
    status: StatusEnum
    approval_levels: list[ApprovalLevelOut] = Field(default_factory=list)
    escalation_config: EscalationConfigOut | None = None
    created_on: datetime | None = None
    modified_on: datetime | None = None


class WorkflowListRow(BaseModel):
    id: str
    category_id: PydanticObjectId
    category_name: str | None = None
    request_type_id: PydanticObjectId
    request_type_name: str | None = None
    primary_assignee_user_id: PydanticObjectId
    primary_assignee_name: str | None = None
    # The category's current primaries. `primary_assignee_*` above is the
    # workflow's frozen single-user snapshot and drifts when the roster is
    # edited; this is read live off the category, so the list agrees with the
    # category screen.
    primary_executor_names: list[str] = Field(default_factory=list)
    # The auto-escalation target, if configured. Needed by the category screen
    # to warn before a primary who is someone's escalation target is removed.
    escalate_to_user_id: PydanticObjectId | None = None
    total_approval_levels: int
    approvers_summary: str | None = None
    approvers_count: int
    escalation_summary: str | None = None
    status: StatusEnum
