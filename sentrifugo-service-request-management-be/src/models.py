"""Beanie documents, enums, and MetadataMixin for the SRM service.

Mirrors the patterns from the IAM service (Foundation §5).
ER per Foundation §8.1 (configuration) + §8.2 (ticket runtime).
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal, Optional
from uuid import uuid4

from beanie import Document, PydanticObjectId
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ASCENDING, IndexModel


# ---------- Base patterns (Foundation §5) ----------

class CustomModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class StatusEnum(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


# Sentinel actor for system-initiated writes (SLA tick, auto-escalation) where
# there is no human user. A real (all-zero) ObjectId so created_by/modified_by/
# deleted_by can be typed as ObjectId rather than carrying a "system" string.
SYSTEM_ACTOR_ID = PydanticObjectId("0" * 24)


class MetadataMixin(BaseModel):
    # Attached to every persisted doc. See Foundation §5.
    created_by: PydanticObjectId | None = None
    created_on: datetime | None = None
    modified_by: PydanticObjectId | None = None
    modified_on: datetime | None = None
    deleted_by: PydanticObjectId | None = None
    deleted_on: datetime | None = None
    status: StatusEnum = StatusEnum.ACTIVE
    correlation_id: str | None = None


# ---------- Global enums (Foundation §6) ----------

class PriorityEnum(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


# Ordered low→urgent for SLA fallback (Resolution #2: URGENT→HIGH if missing).
PRIORITY_ORDER: list[PriorityEnum] = [
    PriorityEnum.LOW,
    PriorityEnum.MEDIUM,
    PriorityEnum.HIGH,
    PriorityEnum.URGENT,
]


class RequestStatusEnum(StrEnum):
    SUBMITTED = "submitted"
    PENDING_APPROVAL = "pending_approval"
    REJECTED = "rejected"
    PENDING_ASSIGNMENT = "pending_assignment"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    RESOLVED = "resolved"
    CLOSED = "closed"
    # Requester pulled the ticket back before anyone began executing it.
    # Allowed in SUBMITTED / PENDING_APPROVAL / PENDING_ASSIGNMENT only.
    WITHDRAWN = "withdrawn"


TERMINAL_STATUSES: set[RequestStatusEnum] = {
    RequestStatusEnum.REJECTED,
    RequestStatusEnum.CLOSED,
    RequestStatusEnum.WITHDRAWN,
}

# Statuses an SLA timer must not fire against. RESOLVED is deliberately *not* in
# TERMINAL_STATUSES — `CLOSE_FROM` is `{RESOLVED}` and `assert_transition` rejects
# any move out of a terminal status, so widening that set would make a resolved
# ticket impossible to close. But a resolved ticket has met its resolution SLA,
# and breaching one is noise: `resolve()` already drops its deadlines, and this
# set is the backstop for the paths that re-add them in bulk (`rebuild_sla_cursor`,
# `reenrol_workflow_timers`), which select on status and would otherwise sweep
# every resolved ticket back in.
#
# SLA code only. Anything governing what a *user* may do to a ticket wants
# TERMINAL_STATUSES.
SLA_INACTIVE_STATUSES: set[RequestStatusEnum] = TERMINAL_STATUSES | {
    RequestStatusEnum.RESOLVED,
}


class DecisionEnum(StrEnum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalLogicEnum(StrEnum):
    AND = "and"
    OR = "or"


class ApproverTypeEnum(StrEnum):
    SPECIFIC_USER = "specific_user"  # v1 only


class SLAViolationAction(StrEnum):
    SEND_ALERT = "send_alert"
    SEND_NOTIFICATION = "send_notification"
    CHANGE_PRIORITY = "change_priority"
    REASSIGN = "reassign"  # alias for "escalate to configured target"


class NotificationMethodEnum(StrEnum):
    EMAIL = "email"
    SYSTEM = "system"


class NotificationTypeEnum(StrEnum):
    REQUEST_CREATED = "request_created"
    APPROVAL_PENDING = "approval_pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTOR_ASSIGNED = "executor_assigned"
    ESCALATED = "escalated"
    SLA_WARNING = "sla_warning"
    SLA_BREACHED = "sla_breached"
    RESOLVED = "resolved"
    CLOSED = "closed"
    COMMENT_ADDED = "comment_added"


class ActivityEventEnum(StrEnum):
    SUBMITTED = "submitted"
    APPROVAL_DECIDED = "approval_decided"
    ASSIGNED = "assigned"
    REASSIGNED = "reassigned"
    ESCALATED = "escalated"
    FIRST_RESPONSE = "first_response"
    SLA_WARNING = "sla_warning"
    SLA_BREACHED = "sla_breached"
    RESOLVED = "resolved"
    CLOSED = "closed"
    WITHDRAWN = "withdrawn"
    COMMENT_ADDED = "comment_added"
    INTERNAL_NOTE_ADDED = "internal_note_added"
    ATTACHMENT_ADDED = "attachment_added"
    PRIORITY_CHANGED = "priority_changed"
    STATUS_CHANGED = "status_changed"


# ---------- ER-1 — Configuration Model (Foundation §8.1) ----------

class BusinessHours(BaseModel):
    # Weekday → (start, end) in "HH:MM". v1 default Mon–Fri 09:00–18:00.
    monday: tuple[str, str] | None = ("09:00", "18:00")
    tuesday: tuple[str, str] | None = ("09:00", "18:00")
    wednesday: tuple[str, str] | None = ("09:00", "18:00")
    thursday: tuple[str, str] | None = ("09:00", "18:00")
    friday: tuple[str, str] | None = ("09:00", "18:00")
    saturday: tuple[str, str] | None = None
    sunday: tuple[str, str] | None = None


class OrgSrConfig(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    executor_can_close: bool = True
    business_hours: BusinessHours = Field(default_factory=BusinessHours)
    holidays: list[str] = Field(default_factory=list)  # ISO date strings
    timezone: str = "UTC"
    # Fiscal-year start month (1-12) used by analytics FY windows. Defaults to
    # April (India FY). Existing docs without the field fall back to this.
    fiscal_year_start_month: int = 4

    class Settings:
        name = "org_sr_config"
        indexes = [
            IndexModel([("organisation_id", 1)], unique=True),
        ]


class ExecutorRoleEnum(StrEnum):
    PRIMARY = "primary"
    SECONDARY = "secondary"


class CategoryExecutor(CustomModel):
    """A person authorised to work this category's tickets.

    `role` decides whether they also inherit the department-head powers
    (assign / reassign / escalation target). Everything below `role` is a
    display snapshot resolved at save time — same rationale as ContactSnapshot:
    the SLA tick holds no user token and IAM has no service principal.

    The snapshot also does real work on the read path. A roster can span several
    departments, so the Ticket Type page cannot label a recipient by loading one
    department's employee list — it labels them `ENG · EMP0142` straight from
    here. Same for the config form when a selection scrolls off the page.
    """

    user_id: PydanticObjectId
    role: ExecutorRoleEnum = ExecutorRoleEnum.SECONDARY
    employee_id: str | None = None   # IAM employee-record id, display only
    emp_code: str = ""               # e.g. EMP0142
    name: str = ""
    email: str = ""
    # Which of the category's departments this person came from. Kept per-entry
    # because the roster spans departments and the UI groups/labels by it.
    department_id: PydanticObjectId | None = None
    department_code: str = ""        # e.g. ENG
    department_name: str = ""


class Category(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    name: str
    name_lc: str  # lowercase mirror for case-insensitive unique index
    description: str | None = None
    # FK -> business_units._id (IAM). The main link: a category belongs to one
    # business unit, and every department below must belong to it.
    business_unit_id: PydanticObjectId
    # Departments whose employees staff this category. At least one. The union
    # of their employees is the pool the executor roster is drawn from.
    department_ids: list[PydanticObjectId] = Field(default_factory=list)
    # DEPRECATED — mirror of department_ids[0], dual-written on save.
    #
    # Kept so documents written before the multi-department change (which have
    # only this field) still read correctly, and so consumers that haven't moved
    # to the list yet keep working. Never read it directly: go through
    # `categories.service.category_department_ids`, which falls back to it.
    # Remove once the backfill has run everywhere and nothing reads it.
    department_id: PydanticObjectId | None = None
    # When True, only users whose IAM business unit + department fall within
    # the visibility scope below may see it in the catalog and raise requests
    # for it. When False (default), the category is visible org-wide.
    restricted_visibility: bool = False
    # Visibility scope used only when restricted_visibility is True. A category
    # may be shared with several business units and departments. When these are
    # empty (legacy restricted categories), the scope falls back to the single
    # home business_unit_id + department_id above.
    visibility_business_unit_ids: list[PydanticObjectId] = Field(default_factory=list)
    visibility_department_ids: list[PydanticObjectId] = Field(default_factory=list)
    # Tagged executor roster. Empty (the default, and the state of every
    # pre-existing category) means "legacy": the department heads hold the
    # primary powers and the whole of the selected departments is the executor
    # pool. Beanie defaults the field on documents saved before it existed.
    #
    # Non-empty, the roster is authoritative: it decides who may work these
    # tickets, and the service_request module ACL no longer does. That override
    # is the point of the feature — an editor acl is granted org-wide and in a
    # standard org every employee holds one, so running the two in parallel
    # hands the powers back to exactly the people left off the roster.
    executors: list[CategoryExecutor] = Field(default_factory=list)
    # Whether the roster is the *whole* truth for who may work this category.
    #
    # False (default): the roster names who holds the primary powers, but
    # anyone in the selected departments is still an eligible executor. A new
    # joiner can pick up tickets the day IAM has them — no roster edit needed.
    # True: only the people listed above may touch it. For categories where
    # that matters (payroll, legal, anything carrying PII).
    #
    # Ignored when `executors` is empty, and never consulted for the primary
    # powers — primaries are always explicit.
    roster_is_exclusive: bool = False

    class Settings:
        name = "categories"
        indexes = [
            IndexModel([("organisation_id", 1), ("status", 1)]),
            IndexModel(
                [("organisation_id", 1), ("name_lc", 1)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class RequestType(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    category_id: PydanticObjectId
    name: str
    name_lc: str
    description: str | None = None
    sla_rules: list["SLARule"] = Field(default_factory=list)

    class Settings:
        name = "request_types"
        indexes = [
            IndexModel([("organisation_id", 1), ("category_id", 1)]),
            IndexModel(
                [("organisation_id", 1), ("name_lc", 1)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class ContactSnapshot(CustomModel):
    """Email/name for a user, captured when the config that names them is saved.

    Not config — an address cache. `notification_recipients` holds user *ids*,
    and turning an id into an address means asking IAM. The SLA tick runs with
    no user token, and IAM has no service principal (its `get_current_user`
    takes only a session token or a user-subject JWT), so a lookup from the tick
    fails and the email is silently skipped. Resolving on the request path —
    where the caller's token works — and storing the result is the way around
    that. IAM still owns the user; this is a copy that goes stale if they change
    their address, and is refreshed whenever the request type is re-saved.
    """

    user_id: str
    email: str
    name: str = ""


class SLARule(CustomModel, MetadataMixin):
    id: str = Field(default_factory=lambda: str(uuid4()))
    priority: PriorityEnum
    first_response_minutes: int
    resolution_minutes: int
    business_hours_only: bool = True
    description: str | None = None
    violation_actions: list[SLAViolationAction] = Field(default_factory=list)
    notification_recipients: list[PydanticObjectId] = Field(default_factory=list)
    # Addresses for `notification_recipients`, resolved at save. Kept alongside
    # the id list rather than replacing it — the ids stay the source of truth
    # the FE reads back into the form.
    notification_recipient_contacts: list[ContactSnapshot] = Field(default_factory=list)


class Workflow(Document, MetadataMixin):
    organisation_id: PydanticObjectId
    category_id: PydanticObjectId
    request_type_id: PydanticObjectId
    primary_assignee_user_id: PydanticObjectId  # snapshot of dept head at save time
    approval_required: bool = True

    class Settings:
        name = "workflows"
        indexes = [
            IndexModel([("organisation_id", 1), ("request_type_id", 1)]),
            IndexModel(
                [("request_type_id", 1), ("status", 1)],
                unique=True,
                partialFilterExpression={
                    "status": "active",
                    "deleted_on": None,
                },
            ),
        ]


class ApprovalLevel(Document, MetadataMixin):
    workflow_id: PydanticObjectId
    level_index: int  # 1..N sequential
    logic: ApprovalLogicEnum = ApprovalLogicEnum.AND

    class Settings:
        name = "approval_levels"
        indexes = [
            IndexModel([("workflow_id", 1), ("level_index", 1)], unique=True,
                       partialFilterExpression={"deleted_on": None}),
        ]


class Approver(Document, MetadataMixin):
    approval_level_id: PydanticObjectId
    approver_type: ApproverTypeEnum = ApproverTypeEnum.SPECIFIC_USER
    approver_user_id: PydanticObjectId
    sort_order: int = 0

    class Settings:
        name = "approvers"
        indexes = [
            IndexModel([("approval_level_id", 1), ("sort_order", 1)]),
        ]


class EscalationConfig(Document, MetadataMixin):
    workflow_id: PydanticObjectId
    auto_escalate_enabled: bool = False
    escalate_after_minutes: int = 0
    escalate_to_user_id: PydanticObjectId | None = None
    pre_notify_enabled: bool = False
    pre_notify_minutes_before: int = 0
    notification_methods: list[NotificationMethodEnum] = Field(default_factory=list)
    notify_on: list[str] = Field(default_factory=list)

    class Settings:
        name = "escalation_configs"
        indexes = [
            IndexModel([("workflow_id", 1)], unique=True,
                       partialFilterExpression={"deleted_on": None}),
        ]


# ---------- ER-2 — Ticket Runtime (Foundation §8.2) ----------

class ServiceRequest(Document, MetadataMixin):
    ticket_no: str  # SR-YYYY-NNNNNN
    organisation_id: PydanticObjectId
    requester_user_id: PydanticObjectId
    category_id: PydanticObjectId
    request_type_id: PydanticObjectId
    sla_rule_id: str | None = None  # snapshot at create (SLARule.id is a UUID, not ObjectId)
    workflow_id: PydanticObjectId  # snapshot at create
    priority: PriorityEnum
    title: str
    description: str | None = None
    request_status: RequestStatusEnum = RequestStatusEnum.SUBMITTED
    is_escalated: bool = False
    escalation_count: int = 0
    primary_assignee_user_id: PydanticObjectId  # snapshot of workflow at create
    executor_user_id: PydanticObjectId | None = None
    # Set by Phase A escalation (executor → dept head). Excluded from
    # reassign candidates so dept head can't bounce the ticket back to the
    # original executor. Cleared on close/terminal — best effort, not
    # critical for terminal states.
    previous_executor_user_id: PydanticObjectId | None = None
    current_level_index: int | None = None
    # Per-ticket override — set when an approval-phase escalation redirects the
    # current level to a different approver without mutating the workflow config.
    # See Q-109.
    escalation_override_approver_user_id: PydanticObjectId | None = None
    # Snapshotted at submit-for-approval time from the requester's reporting
    # chain (employees.l1_manager_id / l2_manager_id). L1 is never overridable;
    # L2 defaults to the L2 manager but the executor may pick any user holding
    # the "leadership" IAM policy.
    level_1_approver_user_id: PydanticObjectId | None = None
    level_2_approver_user_id: PydanticObjectId | None = None
    level_2_default_user_id: PydanticObjectId | None = None
    level_2_overridden: bool = False
    level_2_override_chosen_by: PydanticObjectId | None = None

    submitted_on: datetime | None = None
    first_response_due_by: datetime | None = None
    resolution_due_by: datetime | None = None
    assigned_at: datetime | None = None
    reassigned_at: datetime | None = None
    first_response_at: datetime | None = None
    # When the FIRST approval was raised on this ticket, at either level. Every
    # consumer reads it as the boolean "has this ticket ever been through an
    # approval" — it is the only field that still answers that once `approve`
    # clears `current_level_index`. Set once and never overwritten, so an L2
    # raised after an L1 does not move it.
    approval_triggered_at: datetime | None = None
    # When level 2 specifically started waiting. `approval_triggered_at` cannot
    # answer that on an L1 -> L2 ticket: it holds the L1 trigger, so measuring
    # an L2 decision against it charges the L2 approver for the whole L1 phase.
    # Overwritten on each L2 trigger — the metrics that read it want the current
    # wait, not the first one. Null on tickets that never went to L2, and on
    # every document written before this field existed.
    level_2_triggered_at: datetime | None = None
    escalated_at: datetime | None = None
    resolved_at: datetime | None = None
    closed_at: datetime | None = None

    resolution_notes: str | None = None
    rejection_reason: str | None = None
    closing_remarks: str | None = None
    # Reason captured when the ticket was escalated (surfaced on the detail
    # page). Only set once escalation happens; null otherwise.
    escalation_reason: str | None = None

    class Settings:
        name = "service_requests"
        # Re-validate + coerce the document on every save, so PydanticObjectId
        # fields assigned a str (approver ids from IAM, user.id, etc.) persist as
        # real ObjectIds. Without this they save as strings and ObjectId-keyed
        # queries (e.g. pending-approvals on level_2_approver_user_id) silently
        # miss — which hid L2 approvals from the approver.
        validate_on_save = True
        indexes = [
            IndexModel([("organisation_id", 1), ("request_status", 1)]),
            IndexModel([("organisation_id", 1), ("requester_user_id", 1)]),
            IndexModel([("organisation_id", 1), ("executor_user_id", 1)]),
            IndexModel([("organisation_id", 1), ("submitted_on", -1)]),
            IndexModel([("organisation_id", 1), ("ticket_no", 1)], unique=True),
        ]


class ApprovalDecision(Document, MetadataMixin):
    service_request_id: PydanticObjectId
    level_index: int
    approver_user_id: PydanticObjectId
    decision: DecisionEnum
    remarks: str | None = None
    decided_at: datetime

    class Settings:
        name = "approval_decisions"
        indexes = [
            IndexModel([("service_request_id", 1), ("level_index", 1)]),
            # Prevent double-decide by the same approver at the same level (Ch 6).
            IndexModel(
                [("service_request_id", 1), ("level_index", 1), ("approver_user_id", 1)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]


class Comment(Document, MetadataMixin):
    service_request_id: PydanticObjectId
    author_user_id: PydanticObjectId
    body: str

    class Settings:
        name = "comments"
        indexes = [
            IndexModel([("service_request_id", 1), ("created_on", -1)]),
        ]


class InternalNote(Document, MetadataMixin):
    service_request_id: PydanticObjectId
    author_user_id: PydanticObjectId
    body: str  # immutable after create

    class Settings:
        name = "internal_notes"
        indexes = [
            IndexModel([("service_request_id", 1), ("created_on", -1)]),
        ]


class Attachment(Document, MetadataMixin):
    service_request_id: PydanticObjectId
    filename: str
    mime_type: str
    size_bytes: int
    storage_key: str
    uploaded_by: PydanticObjectId
    uploaded_on: datetime

    class Settings:
        name = "attachments"
        indexes = [
            IndexModel([("service_request_id", 1)]),
        ]


class HandoffKindEnum(StrEnum):
    ESCALATION = "escalation"
    REASSIGNMENT = "reassignment"


class HandoffEvent(Document, MetadataMixin):
    """Immutable snapshot of a ticket phase at the moment ownership changed —
    an escalation (executor → dept head) or a reassignment.

    Both handoffs reset the ticket's active lifecycle for the new owner; this
    row preserves the pre-handoff phase so the (on-the-fly) timeline can be reset
    without losing what happened before. One row per handoff.
    """
    service_request_id: PydanticObjectId
    organisation_id: PydanticObjectId
    kind: HandoffKindEnum
    phase_index: int  # 1-based; increments per handoff (escalation or reassign)
    from_user_id: PydanticObjectId | None = None  # owner handed off from
    to_user_id: PydanticObjectId | None = None    # owner handed off to
    reason: str | None = None  # escalation reason / reassignment notes
    # Snapshot of the closed phase's lifecycle timestamps.
    assigned_at: datetime | None = None
    first_response_at: datetime | None = None
    approval_triggered_at: datetime | None = None
    happened_at: datetime | None = None  # when the handoff occurred

    class Settings:
        name = "handoff_events"
        indexes = [
            IndexModel([("service_request_id", 1), ("created_on", 1)]),
        ]


# ---------- Supporting docs ----------

class Counter(Document):
    """Ticket-number counter — Foundation §12.

    `_id = {organisation_id}:sr:{year}`; atomic `$inc` via findOneAndUpdate.
    """
    # Beanie stores an explicit `id`; we override in queries by using Mongo `_id`
    # directly in `id_generator.py`.
    value: int = 0

    class Settings:
        name = "counters"


class IdempotencyRecord(Document):
    """24h idempotency record — Valkey primary; Mongo is only a safety net
    for cross-replica de-dup if Valkey is evicted. See Foundation §14 / Q-106."""
    key: str  # srm:idemp:<user_id>:<client_key>
    payload_hash: str
    response_json: str
    created_on: datetime

    class Settings:
        name = "idempotency_records"
        indexes = [
            IndexModel([("key", 1)], unique=True),
        ]


class DepartmentReplica(Document):
    """Local fallback copy of an IAM department.

    IAM owns departments; this is **not** a source of truth. It exists so that
    request-time lookups (notably `resolve_primary_assignee`, which snapshots
    the dept head as the workflow's primary assignee) keep working when IAM is
    unreachable. Two write paths feed it (see `integrations.department_replica`):

      * write-through — every successful live IAM read is persisted here, and
      * events — the IAM domain-events consumer applies
        department.created / .updated / .deleted.

    Ids are the IAM department ObjectId as a hex string so a cache hit matches
    the live `_id` callers already use.
    """

    id: str  # IAM department id (ObjectId hex string)
    name: str | None = None
    organisation_id: str | None = None
    head_user_id: str | None = None
    # Last-known full IAM response, returned verbatim on a fallback hit so a
    # cache hit is shaped exactly like a live read.
    raw: dict = Field(default_factory=dict)
    source: str | None = None  # "read" | "event"
    is_deleted: bool = False
    synced_at: datetime | None = None

    class Settings:
        name = "departments"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
        ]


class EmployeeReplica(Document):
    """Local fallback copy of an IAM user/employee, keyed by **user_id**.

    Not a source of truth — IAM owns users. Exists so request-time identity
    lookups (approval submit, assign/reassign, escalate) survive an IAM outage.
    Mirrors `DepartmentReplica`; fed by write-through of live reads and by IAM
    `employee.created/updated/deleted` events. `user_id` is the id SRM passes
    everywhere (approver/executor/head/requester), so a cache hit matches the
    live `_id` callers already use.
    """

    id: str  # IAM user_id (ObjectId hex string)
    employee_id: str | None = None
    name: str | None = None
    email: str | None = None
    organisation_id: str | None = None
    l1_manager_id: str | None = None
    l2_manager_id: str | None = None
    department_id: str | None = None
    policies: list = Field(default_factory=list)
    raw: dict = Field(default_factory=dict)
    source: str | None = None  # "read" | "event"
    is_deleted: bool = False
    synced_at: datetime | None = None

    class Settings:
        name = "employees"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("department_id", ASCENDING)]),
        ]


class OutboxEventDocument(Document):
    """Transactional outbox: stores events that must be relayed to RabbitMQ.

    Events are written atomically alongside the domain operation.  A background
    relay picks them up and publishes to RabbitMQ, marking them as ``sent``.
    Consumers use ``idempotency_key`` to deduplicate (at-least-once delivery).
    """

    id: str = Field(default_factory=lambda: str(uuid4()))
    idempotency_key: str = Field(
        description="Unique key for consumer-side deduplication"
    )
    exchange: str = "domain_events"
    event_type: str
    payload: dict
    status: Literal["pending", "sent", "failed"] = "pending"
    retries: int = 0
    created_at: datetime
    sent_at: Optional[datetime] = None
    dead_lettered_at: Optional[datetime] = Field(
        default=None,
        description="Set when the event exhausts MAX_RETRIES and is abandoned",
    )

    class Settings:
        name = "outbox_events"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]


class SLADeadline(Document):
    """A pending SLA / workflow timer, popped by the SLA tick when it comes due.

    Replaces the ``srm:sla:deadlines`` Valkey ZSET. A deadline is not cache —
    losing one means a ticket silently never breaches and nobody finds out —
    so it lives here, next to the ticket it refers to.

    ``member`` keeps the ZSET's ``{ticket_id}:{event_kind}`` format so the
    tick's parsing and every call site's key building stay as they were. It is
    uniquely indexed: enrolling the same member twice must *move* its deadline,
    exactly as ZADD did, and never create a second document — two documents
    would fire the same breach twice (double priority bump, double escalation
    count).

    ``claimed_at`` is what makes popping atomic, which ZRANGEBYSCORE-then-ZREM
    never was: a tick claims each entry with one findAndModify, so two replicas
    can no longer pop the same deadline.
    """

    id: str = Field(default_factory=lambda: str(uuid4()))
    member: str = Field(
        description="'{service_request_id}:{event_kind}' — unique per timer"
    )
    service_request_id: str
    event_kind: str = Field(
        description="first_response | resolution | auto_escalate | pre_notify"
    )
    due_at: datetime = Field(description="When this timer fires (UTC)")
    claimed_at: Optional[datetime] = Field(
        default=None,
        description="Set when a tick claims this entry; claimed entries are "
        "deleted once processed, so a lingering value means a tick died mid-batch",
    )
    created_at: datetime

    class Settings:
        name = "sla_deadlines"
        indexes = [
            IndexModel([("member", ASCENDING)], unique=True),
            IndexModel([("due_at", ASCENDING), ("claimed_at", ASCENDING)]),
            IndexModel([("service_request_id", ASCENDING)]),
        ]


# Registry used by `src.database.init_db`.
class ActionToken(Document, MetadataMixin):
    """A single-use bearer credential letting one person act from an email.

    Minted per (resource, recipient, capacity) when a notification is sent, so a
    forwarded mail acts as the person it was addressed to and nobody else. Never
    share one token across recipients.

    `actor_role` is not decoration: the same ticket is actioned by different
    capacities at different stages, so the role the link was minted for is
    matched at redemption. Without it a link mailed to the L1 approver would
    perform the L2 decision simply by being POSTed to the other endpoint.

    The token answers *who*, and nothing else — redemption calls the same domain
    function the UI calls, so scope, permission and state checks all still run.
    """

    organisation_id: PydanticObjectId
    token: str
    resource_id: PydanticObjectId
    actor_id: PydanticObjectId
    actor_email: str
    actor_role: str
    expires_at: datetime
    used_at: datetime | None = None
    used_action: str | None = None

    class Settings:
        name = "action_tokens"
        indexes = [
            IndexModel([("token", ASCENDING)], unique=True),
            IndexModel([("resource_id", ASCENDING)]),
            # Not a TTL index: an expired token must still resolve so redemption
            # can answer TOKEN_EXPIRED rather than the indistinguishable
            # INVALID_TOKEN. Sweep separately if the collection ever needs it.
            IndexModel([("expires_at", ASCENDING)]),
        ]


ALL_DOCUMENTS = [
    OrgSrConfig,
    Category,
    RequestType,
    Workflow,
    ApprovalLevel,
    Approver,
    EscalationConfig,
    ServiceRequest,
    ApprovalDecision,
    Comment,
    InternalNote,
    Attachment,
    HandoffEvent,
    Counter,
    IdempotencyRecord,
    OutboxEventDocument,
    SLADeadline,
    DepartmentReplica,
    EmployeeReplica,
    ActionToken,
]
