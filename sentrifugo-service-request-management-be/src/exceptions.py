"""Domain exception + FastAPI handlers.

All domain errors serialise to `{"detail": str, "code": str}` per Foundation §15.
FE keys on `code`.
"""
from __future__ import annotations

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class DomainException(Exception):
    def __init__(self, message: str, code: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code


# ---------- Foundation §15 codes (pre-declared helpers) ----------
# Chapters extend this with their own codes — all registered here from day one
# (see Q-007 in SRM_Implementation_Queries.txt).

def Forbidden(msg: str = "Forbidden") -> DomainException:
    return DomainException(msg, "FORBIDDEN", status.HTTP_403_FORBIDDEN)


def Unauthorized(msg: str = "Unauthorized") -> DomainException:
    return DomainException(msg, "UNAUTHORIZED", status.HTTP_401_UNAUTHORIZED)


def CategoryNotFound() -> DomainException:
    return DomainException("Category not found", "CATEGORY_NOT_FOUND", 404)


def CategoryNameExists() -> DomainException:
    return DomainException("A category with this name already exists", "CATEGORY_NAME_EXISTS", 409)


def CategoryHasRequestTypes() -> DomainException:
    return DomainException(
        "Cannot delete — linked request types exist", "CATEGORY_HAS_REQUEST_TYPES", 409
    )


def DepartmentNotFound() -> DomainException:
    return DomainException(
        "Department not found or does not belong to your organisation",
        "DEPARTMENT_NOT_FOUND",
        400,
    )


def ExecutorNotInDepartment() -> DomainException:
    return DomainException(
        "Every executor must belong to the category's department",
        "EXECUTOR_NOT_IN_DEPARTMENT",
        400,
    )


def BusinessUnitDepartmentMismatch() -> DomainException:
    return DomainException(
        "Selected department does not belong to the selected business unit",
        "BUSINESS_UNIT_DEPARTMENT_MISMATCH",
        400,
    )


def RequestTypeNotFound() -> DomainException:
    return DomainException("Request type not found", "REQUEST_TYPE_NOT_FOUND", 404)


def RequestTypeNameExists() -> DomainException:
    return DomainException(
        "A request type with this name already exists", "REQUEST_TYPE_NAME_EXISTS", 409
    )


def RequestTypeInUse() -> DomainException:
    return DomainException(
        "Cannot delete — active workflow or open tickets exist",
        "REQUEST_TYPE_IN_USE",
        409,
    )


def SlaRulePriorityExists() -> DomainException:
    return DomainException(
        "An SLA rule for this priority already exists", "SLA_RULE_PRIORITY_EXISTS", 409
    )


def SlaRuleInvalidTimes() -> DomainException:
    return DomainException(
        "first_response_minutes must be > 0 and <= resolution_minutes",
        "SLA_RULE_INVALID_TIMES",
        400,
    )


def SlaRuleEmpty() -> DomainException:
    return DomainException("At least one SLA rule is required", "SLA_RULE_EMPTY", 400)


def NotificationRecipientUnresolved(user_ids: list[str]) -> DomainException:
    """A notification recipient's email address could not be resolved from IAM.

    Deliberately fatal rather than best-effort. The SLA tick emails these people
    on breach and cannot look them up itself (no user token, and IAM has no
    service principal), so an address we fail to capture *here* is an address
    that never gets captured — the rule would save looking configured while
    quietly notifying nobody. Better to reject the save and let the caller retry
    or drop the recipient.
    """
    return DomainException(
        "Could not verify notification recipient(s): "
        f"{', '.join(user_ids)}. They may no longer exist. Remove them, or try "
        "again if this persists.",
        "NOTIFICATION_RECIPIENT_UNRESOLVED",
        422,
    )


def SlaRuleMissingPriority() -> DomainException:
    return DomainException(
        "SLA rules must include all 4 priorities (low, medium, high, urgent)",
        "SLA_RULE_MISSING_PRIORITY",
        400,
    )

def SlaRuleDuplicatePriorityInPayload() -> DomainException:
    return DomainException(
        "Duplicate priority in sla_rules payload",
        "SLA_RULE_DUPLICATE_PRIORITY_IN_PAYLOAD",
        400,
    )


def WorkflowNotFound() -> DomainException:
    return DomainException("Workflow not found", "WORKFLOW_NOT_FOUND", 404)


def WorkflowAlreadyActive() -> DomainException:
    return DomainException(
        "Another workflow is already active for this request type",
        "WORKFLOW_ALREADY_ACTIVE",
        409,
    )


def WorkflowLevelsNotSequential() -> DomainException:
    return DomainException(
        "approval_levels must use level_index = 1..N with no gaps",
        "WORKFLOW_LEVELS_NOT_SEQUENTIAL",
        400,
    )


def WorkflowApproverDuplicateInLevel() -> DomainException:
    return DomainException(
        "Same approver appears more than once in a level",
        "WORKFLOW_APPROVER_DUPLICATE_IN_LEVEL",
        400,
    )


def WorkflowApproverDuplicateAcrossLevels() -> DomainException:
    return DomainException(
        "Level 2 approver must be different from Level 1",
        "WORKFLOW_APPROVER_DUPLICATE_ACROSS_LEVELS",
        400,
    )


def WorkflowApproverInvalidUser() -> DomainException:
    return DomainException(
        "One or more approver_user_ids could not be resolved via IAM",
        "WORKFLOW_APPROVER_INVALID_USER",
        400,
    )


def WorkflowEscalationTargetNotPrimary(category_name: str = "") -> DomainException:
    """Auto-escalation was pointed at someone who is not a category primary.

    The manual escalate path resolves its targets through
    `_eligible_escalation_targets` — the category's primaries and nobody else.
    The workflow's stored `escalate_to_user_id` had no such constraint, so a
    workflow could be configured to auto-escalate to a user the manual path
    would refuse: the SLA tick would hand them a ticket they cannot assign,
    reassign or resolve, and that never appears in their queue.
    """
    where = f' "{category_name}"' if category_name else ""
    return DomainException(
        f"The auto-escalation target must be a primary executor on the "
        f"category{where}. Escalated tickets go to the category's primaries, "
        "so anyone else would receive a ticket they hold no rights over. Pick "
        "a primary, or add this person to the category's roster as one.",
        "WORKFLOW_ESCALATION_TARGET_NOT_PRIMARY",
        422,
    )


def WorkflowEscalationRequired() -> DomainException:
    return DomainException(
        "Escalation config is required when auto_escalate_enabled is true",
        "WORKFLOW_ESCALATION_REQUIRED",
        400,
    )


def WorkflowApprovalFieldsForbidden() -> DomainException:
    return DomainException(
        "approval_levels must be empty when approval_required is false",
        "WORKFLOW_APPROVAL_FIELDS_FORBIDDEN",
        400,
    )


def WorkflowPreNotifyTooLate() -> DomainException:
    return DomainException(
        "pre_notify_minutes_before must be less than escalate_after_minutes",
        "WORKFLOW_PRE_NOTIFY_TOO_LATE",
        400,
    )


def WorkflowActiveCannotDelete() -> DomainException:
    return DomainException(
        "Active workflow cannot be deleted — deactivate it first",
        "WORKFLOW_ACTIVE_CANNOT_DELETE",
        409,
    )


def WorkflowInUse() -> DomainException:
    return DomainException(
        "Workflow has open tickets — cannot delete", "WORKFLOW_IN_USE", 409
    )


def DeptHeadMissing() -> DomainException:
    return DomainException(
        "Category's department has no head in IAM", "DEPT_HEAD_MISSING", 400
    )


def ApproverRequired() -> DomainException:
    return DomainException(
        "approval_required is true but no approvers are configured",
        "APPROVER_REQUIRED",
        400,
    )


def InvalidStateTransition(detail: str = "") -> DomainException:
    """Wrong-status refusal. Pass `detail` naming the rule that actually blocked.

    Raised from ~20 places, and with no argument every one of them produced the
    same sentence — "Action not allowed from current status" — which names the
    category of problem and nothing else. The caller cannot tell whether the
    ticket moved on, someone else acted first, or they are looking at a stale
    tab, and the three have different fixes.

    `detail` replaces the generic sentence rather than appending to it: this
    lands in a toast, where the specific clause is the only part worth the
    width. The bare form stays valid so untouched call sites still compile —
    treat it as a TODO, not a default.
    """
    return DomainException(
        detail or "Action not allowed from current status",
        "INVALID_STATE_TRANSITION",
        409,
    )


def RequestTerminal() -> DomainException:
    return DomainException(
        "Ticket is in a terminal state (REJECTED or CLOSED)", "REQUEST_TERMINAL", 409
    )


def NotCurrentApprover(detail: str = "") -> DomainException:
    """Not your decision to make. Pass `detail` saying whose it is.

    "Caller is not the current-level approver" restates the check and withholds
    the one fact that resolves the situation — who *is* holding it. Someone
    looking at a ticket in their Team Tickets list needs to know whether to wait
    for L1, chase a named person, or ask for the escalation override.
    """
    return DomainException(
        detail or "Caller is not the current-level approver",
        "NOT_CURRENT_APPROVER",
        403,
    )


def AlreadyDecided() -> DomainException:
    return DomainException(
        "You have already decided at this level", "ALREADY_DECIDED", 409
    )


def NotExecutor() -> DomainException:
    return DomainException("Caller is not the executor", "NOT_EXECUTOR", 403)


def NotRequester() -> DomainException:
    return DomainException(
        "Only the requester can withdraw their own ticket",
        "NOT_REQUESTER",
        403,
    )


def WithdrawalNotAllowed() -> DomainException:
    return DomainException(
        "This ticket can no longer be withdrawn — it has already been "
        "assigned, started, or is in a terminal state.",
        "WITHDRAWAL_NOT_ALLOWED",
        409,
    )


def NotPrimaryAssignee(detail: str = "") -> DomainException:
    """Caller may not assign/reassign this ticket.

    The old text — "Caller is not the primary assignee" — described the gate as
    it stood before the roster model, when the ticket's snapshotted primary
    assignee really was the only one who passed. Three roles pass it now (see
    `reassign_executor`): that assignee, any primary executor on the ticket's
    category, and a manager with rights over it. Naming only the first sends
    a category primary looking for a permission they already hold.
    """
    return DomainException(
        detail
        or (
            "You cannot assign or reassign this ticket. That is limited to the "
            "ticket's current primary assignee, a primary executor on its "
            "category, or a manager with rights over it."
        ),
        "NOT_PRIMARY_ASSIGNEE",
        403,
    )


def AttachmentTooLarge() -> DomainException:
    return DomainException("Attachment exceeds 10 MB", "ATTACHMENT_TOO_LARGE", 413)


def AttachmentFormat() -> DomainException:
    return DomainException("Unsupported attachment format", "ATTACHMENT_FORMAT", 415)


def AttachmentCountExceeded() -> DomainException:
    return DomainException(
        "Maximum 10 attachments per ticket reached",
        "ATTACHMENT_COUNT_EXCEEDED",
        409,
    )


def ExportForbidden() -> DomainException:
    return DomainException(
        "Employees cannot export requests", "EXPORT_FORBIDDEN", 403
    )


def ExportRangeTooWide() -> DomainException:
    return DomainException(
        "Export date range exceeds the maximum of 366 days",
        "EXPORT_RANGE_TOO_WIDE",
        400,
    )


def InvalidDateRange() -> DomainException:
    return DomainException("Invalid date range — end must be after start", "INVALID_DATE_RANGE", 400)


def IdempotencyMismatch() -> DomainException:
    return DomainException(
        "Idempotency-Key reused with a different payload",
        "IDEMPOTENCY_MISMATCH",
        409,
    )


def NoActiveWorkflow() -> DomainException:
    return DomainException(
        "No active workflow for this request type",
        "NO_ACTIVE_WORKFLOW",
        400,
    )


def NoSlaAvailable() -> DomainException:
    return DomainException(
        "No SLA rule available for the chosen priority",
        "NO_SLA_AVAILABLE",
        400,
    )


def CommentBodyRequired() -> DomainException:
    return DomainException("Comment body is required", "COMMENT_BODY_REQUIRED", 400)


def RejectReasonRequired() -> DomainException:
    return DomainException("Rejection reason is required", "REJECT_REASON_REQUIRED", 400)


def ResolutionNotesRequired() -> DomainException:
    return DomainException(
        "Resolution notes are required", "RESOLUTION_NOTES_REQUIRED", 400
    )


def ExecutorCannotClose() -> DomainException:
    return DomainException(
        "Executor is not permitted to close tickets in this organisation",
        "EXECUTOR_CANNOT_CLOSE",
        403,
    )


def EscalationTargetInvalid() -> DomainException:
    return DomainException(
        "Escalation target user is not eligible", "ESCALATION_TARGET_INVALID", 400
    )


def EscalationReasonRequired() -> DomainException:
    return DomainException(
        "Escalation reason is required", "ESCALATION_REASON_REQUIRED", 400
    )


def CategoryRosterNotConfigured(category_name: str = "") -> DomainException:
    """Raised at ticket creation — the category names nobody to work it.

    Checked here rather than left to the escalation path, which is where the
    gap used to surface. A category with no roster (or a roster with no
    primary) has no one holding the assign / reassign / escalation-target
    powers, so escalation had to fall back on the department head — the one
    route the roster model was meant to close, since a head who is off the
    roster holds nothing else on the category.

    Blocking the ticket instead means the fallback has nothing left to catch:
    every ticket raised from now on has a real primary behind it.
    """
    where = f' "{category_name}"' if category_name else ""
    return DomainException(
        f"The category{where} has no primary executor configured, so there "
        "would be nobody to assign, reassign or escalate this ticket to. Ask "
        "an admin to add an executor roster with at least one primary before "
        "raising a request here.",
        "CATEGORY_ROSTER_NOT_CONFIGURED",
        422,
    )


def NoEscalationPrimaryAvailable(detail: str) -> DomainException:
    """Raised by `escalate` when the category's primaries cannot supply a target.

    Distinct from `EscalationTargetInvalid` (the caller named someone who isn't
    eligible): here nobody is eligible at all, and the fix is a config change
    rather than a different choice, so the message has to say so.
    """
    return DomainException(
        f"This ticket cannot be escalated — {detail} Ask an admin to add "
        "another primary executor to the category.",
        "NO_ESCALATION_PRIMARY",
        422,
    )


def ExecutorInvalid(detail: str = "") -> DomainException:
    """The named executor fails an eligibility rule the caller can correct."""
    return DomainException(
        detail or "Executor user is not eligible", "EXECUTOR_INVALID", 400
    )


def ExecutorUnresolved(user_id: str = "") -> DomainException:
    """The named executor does not exist in IAM at all.

    Split out of `ExecutorInvalid` because it is a different kind of problem
    with a different fix. "Not eligible" reads as a rule the caller broke —
    wrong department, already the executor, is the requester — and invites them
    to pick someone else from the same list. But this fires when IAM cannot
    resolve the id, and the ids in that dropdown come off the category's
    executor roster: the usual cause is a roster entry still pointing at an
    employee who has since been deleted or deactivated. Picking again from the
    same stale list will not help; an admin has to prune the roster.

    Kept as a 422 rather than 400 for the same reason as
    `CategoryRosterNotConfigured` — the payload is well-formed, the stored
    configuration behind it is not.
    """
    who = f" ({user_id})" if user_id else ""
    return DomainException(
        f"The selected executor{who} no longer exists in IAM, so this ticket "
        "cannot be assigned to them. This usually means the category's executor "
        "roster still lists someone whose employee record was deleted or "
        "deactivated. Ask an admin to remove them from the roster — picking "
        "again from the same list will hit the same problem.",
        "EXECUTOR_UNRESOLVED",
        422,
    )


def ExecutorSameAsCurrent() -> DomainException:
    return DomainException(
        "New executor is the same as the current executor",
        "EXECUTOR_SAME_AS_CURRENT",
        400,
    )


def InternalNoteForbidden() -> DomainException:
    return DomainException(
        "Only executor, manager, or super admin may add internal notes",
        "INTERNAL_NOTE_FORBIDDEN",
        403,
    )


def InternalNoteBodyRequired() -> DomainException:
    return DomainException(
        "Internal note body is required", "INTERNAL_NOTE_BODY_REQUIRED", 400
    )


def LoggingUnavailable() -> DomainException:
    return DomainException(
        "Logging Service is unavailable — please try again later",
        "LOGGING_UNAVAILABLE",
        503,
    )


def InvalidInternalToken() -> DomainException:
    return DomainException(
        "Invalid or missing X-Internal-Token", "INVALID_INTERNAL_TOKEN", 401
    )


def NoL1ManagerConfigured() -> DomainException:
    return DomainException(
        "Requester has no L1 manager configured in their employee record. "
        "Ask an admin to update the hierarchy before submitting for approval.",
        "NO_L1_MANAGER",
        422,
    )


def NoL2ManagerConfigured() -> DomainException:
    """Raised by `trigger_l2` when the requester's employee record has no L2.

    The message used to end "Pick an L2 approver from the leadership pool to
    proceed" — advice the caller cannot act on. The picker's candidate list
    comes from `iam.list_leadership_users`, which filters employees on a policy
    literally named `dev-leadership`; no such policy exists in this environment
    (the policy set is Administrator / Manager / Employee plus the per-function
    Executive/Manager pairs), so the pool is always empty and the dropdown has
    nothing to offer. Pointing at it sends the tester hunting for a control that
    is not there.

    The only real route forward is fixing the hierarchy, so name that instead —
    and say plainly that the ticket is fine and the employee record is not, or
    it reads as a bug in the ticket.
    """
    return DomainException(
        "This ticket cannot be sent for L2 approval — the requester has no L2 "
        "manager set in their employee record, so there is nobody to send it "
        "to. This is a gap in the reporting hierarchy, not a problem with the "
        "ticket itself. Ask an admin to set the L2 manager on the requester's "
        "employee record in IAM, then try again.",
        "NO_L2_MANAGER",
        422,
    )


def L2OverrideNotLeadership() -> DomainException:
    return DomainException(
        "Selected L2 approver is not in the leadership pool",
        "L2_OVERRIDE_NOT_LEADERSHIP",
        400,
    )


def L2OverrideInvalid() -> DomainException:
    return DomainException(
        "L2 approver cannot be the requester or the L1 approver",
        "L2_OVERRIDE_INVALID",
        400,
    )


# ---------- Handlers ----------

async def domain_exception_handler(request: Request, exc: DomainException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "code": exc.code},
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    # Chapter 1 §19.1.7 and Q-111: remap Pydantic 422 to {detail, code=VALIDATION_ERROR}.
    detail_msgs = [
        f"{'.'.join(str(p) for p in err['loc'] if p != 'body')}: {err['msg']}"
        for err in exc.errors()
    ]
    # Only loc / msg / type are echoed back. `exc.errors()` also carries `input`
    # (the submitted value — credentials, PII) and `ctx`/`url`, none of which the
    # client needs to fix its payload.
    errors = [
        {
            "loc": [str(p) for p in err.get("loc", ())],
            "msg": err.get("msg"),
            "type": err.get("type"),
        }
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "detail": "; ".join(detail_msgs) if detail_msgs else "Validation error",
            "code": "VALIDATION_ERROR",
            "errors": errors,
        },
    )


def register_exception_handlers(app) -> None:
    app.add_exception_handler(DomainException, domain_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)

def InvalidActionToken(msg: str = "This link is no longer valid — it may already have been used.") -> DomainException:
    """Missing, already redeemed, or minted for a different resource/capacity.

    Deliberately one code for all three: telling a bearer *which* of those it is
    would let them probe. The landing page shows one message and an app link.
    """
    return DomainException(msg, "INVALID_TOKEN", 403)


def ActionTokenExpired(msg: str = "This link has expired. Please act in the app.") -> DomainException:
    """Past `expires_at`. Distinct from INVALID_TOKEN so the page can say so."""
    return DomainException(msg, "TOKEN_EXPIRED", 410)
