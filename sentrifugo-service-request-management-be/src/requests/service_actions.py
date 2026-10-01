"""Request action endpoints — Chapter 6."""
from __future__ import annotations

import logging
from typing import Any

from pymongo.errors import DuplicateKeyError

from ..audit import emit_activity, emit_audit
from ..common.iam_helpers import user_name
from ..auth.utils.dependencies import UserBase
from ..common.timestamps import utcnow
from ..exceptions import (
    AlreadyDecided,
    CommentBodyRequired,
    ExecutorCannotClose,
    Forbidden,
    InvalidStateTransition,
    L2OverrideInvalid,
    L2OverrideNotLeadership,
    NoL1ManagerConfigured,
    NoL2ManagerConfigured,
    NotCurrentApprover,
    NotExecutor,
    NotRequester,
    RejectReasonRequired,
    RequestTerminal,
    ResolutionNotesRequired,
    WithdrawalNotAllowed,
)
from ..integrations.iam_client import get_iam_client
from ..models import (
    ActivityEventEnum,
    ApprovalDecision,
    ApprovalLevel,
    Approver,
    Comment,
    DecisionEnum,
    OrgSrConfig,
    RequestStatusEnum,
    ServiceRequest,
    TERMINAL_STATUSES,
)
from ..rabbitmq import publish_event
from ..sla_store import drop
from .schemas import (
    ApproveBody,
    CommentBody,
    RejectBody,
    ResolveBody,
    SubmitForApprovalBody,
    WithdrawBody,
)
from .utils.self_dealing import deny_requester_actor
from .utils.state_machine import status_phrase
from .utils.watcher import notify_watcher_if_subscribed
from .service_detail import (
    _is_current_approver,
    _is_executor_of,
    get_request_detail,
    require_ticket_access,
)

logger = logging.getLogger(__name__)


async def _load_non_terminal(sr_id: str, organisation_id: str) -> ServiceRequest:
    sr = await ServiceRequest.get(sr_id)
    if sr is None or sr.deleted_on is not None or str(sr.organisation_id) != organisation_id:
        from ..exceptions import DomainException
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    if sr.request_status in TERMINAL_STATUSES:
        raise RequestTerminal()
    return sr


def _snapshot_approver_for_level(
    sr: ServiceRequest, level_index: int | None
) -> str | None:
    if level_index == 1:
        return sr.level_1_approver_user_id
    if level_index == 2:
        return sr.level_2_approver_user_id
    return None


async def _current_approver_hint(sr: ServiceRequest, user: UserBase) -> str:
    """Who is actually holding this decision — the body of `NotCurrentApprover`.

    Best-effort by design: the name is a nicety, the refusal is not, so an IAM
    hiccup degrades the sentence rather than turning a 403 into a 500.

    Worth the extra call because Team Tickets lists tickets an L2 can see but
    not act on (the queue includes everything raised by their reports, at any
    level), so "you are not the current approver" is a message L2 managers meet
    routinely — and the useful half is which of their colleagues to chase.
    """
    level = sr.current_level_index
    if level is None:
        return (
            "This ticket is not waiting on an approval decision right now, so "
            "there is nothing here for you to approve or reject."
        )
    holder = sr.escalation_override_approver_user_id or _snapshot_approver_for_level(
        sr, level
    )
    if not holder:
        return (
            f"Level {level} approval on this ticket belongs to someone else — "
            "only the current approver can decide it."
        )
    name = ""
    try:
        from ..common.email_resolver import resolve_user_info

        info = await resolve_user_info(str(holder), access_token=user.access_token)
        name = info.get("name") or ""
    except Exception:  # noqa: BLE001 — never let a display name break the refusal
        name = ""
    who = name or "another user"
    if sr.escalation_override_approver_user_id:
        return (
            f"Level {level} approval on this ticket was escalated to {who}, so "
            "the decision is theirs now rather than yours."
        )
    return (
        f"Level {level} approval on this ticket is with {who}. Only they can "
        "approve or reject it."
    )


async def approve(sr_id: str, body: ApproveBody, user: UserBase) -> dict[str, Any]:
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status != RequestStatusEnum.PENDING_APPROVAL:
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so there is no "
            "approval pending on it. It may have been decided, withdrawn, or "
            "sent back to the executor since this page loaded — refresh to see "
            "where it stands."
        )
    if not await _is_current_approver(sr, user):
        raise NotCurrentApprover(await _current_approver_hint(sr, user))

    now = utcnow()
    try:
        decision = ApprovalDecision(
            service_request_id=str(sr.id),
            level_index=sr.current_level_index or 0,
            approver_user_id=user.id,
            decision=DecisionEnum.APPROVED,
            remarks=body.remarks,
            decided_at=now,
            created_by=user.id,
            created_on=now,
        )
        await decision.insert()
    except DuplicateKeyError as e:
        raise AlreadyDecided() from e

    # New flow: every approval (L1 or L2) returns the ticket to the executor
    # so they can decide what to do next — trigger the next level (only valid
    # after L1 approved), resolve, or close. No auto-advance L1→L2.
    sr.request_status = RequestStatusEnum.IN_PROGRESS
    sr.current_level_index = None
    sr.escalation_override_approver_user_id = None
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    await publish_event(
        "approval_decided",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "level_index": decision.level_index,
            "decision": "approved",
            "actor_user_id": user.id,
        },
    )
    await notify_watcher_if_subscribed(
        sr.workflow_id,
        "approval",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "level_index": decision.level_index,
            "decision": "approved",
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.APPROVAL_DECIDED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"level_index": decision.level_index, "decision": "approved"},
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_request_approved
        from ..models import Category
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        approver_display = user.display_name or user.first_name or ""
        # Approval (L1 or L2) just returns the ticket to the executor — no
        # auto-advance.
        # Everyone involved hears the decision: the roster is working the ticket
        # and the other approver may still be asked to sign off.
        from .notify_helpers import ticket_recipients
        for r in await ticket_recipients(
            sr, exclude_user_ids={str(user.id)}, access_token=user.access_token
        ):
            await notify_request_approved(
                requester_email=r["email"],
                requester_name=r["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                level_index=decision.level_index,
                sr_id=str(sr.id),
                description=sr.description or "",
                approver_name=approver_display,
                category_name=cat_name,
                tenant_id=sr.organisation_id,
            )
    except Exception:
        logger.warning("email.approve.failed sr=%s", sr_id)

    return await get_request_detail(str(sr.id), user)


async def reject(sr_id: str, body: RejectBody, user: UserBase) -> dict[str, Any]:
    if not body.reason or not body.reason.strip():
        raise RejectReasonRequired()
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status != RequestStatusEnum.PENDING_APPROVAL:
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so there is no "
            "approval pending on it to reject. It may have been decided, "
            "withdrawn, or sent back to the executor since this page loaded — "
            "refresh to see where it stands."
        )
    if not await _is_current_approver(sr, user):
        raise NotCurrentApprover(await _current_approver_hint(sr, user))

    now = utcnow()
    # Captured before `sr.current_level_index` is cleared below. `approve` has
    # the level to hand via its `decision` variable; this path inserts the
    # decision without binding one, and the email fan-out further down needs the
    # level for its per-(level, recipient) idempotency key.
    decided_level = sr.current_level_index or 0
    try:
        await ApprovalDecision(
            service_request_id=str(sr.id),
            level_index=decided_level,
            approver_user_id=user.id,
            decision=DecisionEnum.REJECTED,
            remarks=body.reason,
            decided_at=now,
            created_by=user.id,
            created_on=now,
        ).insert()
    except DuplicateKeyError as e:
        raise AlreadyDecided() from e

    # Reject is no longer terminal — the executor still needs to close the
    # ticket out. Return it to IN_PROGRESS so they can resolve+close. The
    # rejection is recorded on the ApprovalDecision row and surfaces in the
    # approvals timeline as "Rejected".
    sr.request_status = RequestStatusEnum.IN_PROGRESS
    sr.current_level_index = None
    sr.escalation_override_approver_user_id = None
    sr.rejection_reason = body.reason  # last rejection reason, displayed on detail
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    await publish_event(
        "rejected",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "actor_user_id": user.id,
            "reason": body.reason,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.APPROVAL_DECIDED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"decision": "rejected", "reason": body.reason},
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_request_rejected
        from ..models import Category
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        # Rejection stops the ticket, so the roster and the other approver need
        # to know as much as the requester does.
        from .notify_helpers import ticket_recipients
        for r in await ticket_recipients(
            sr, exclude_user_ids={str(user.id)}, access_token=user.access_token
        ):
            await notify_request_rejected(
                requester_email=r["email"],
                requester_name=r["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                level_index=decided_level,
                sr_id=str(sr.id),
                description=sr.description or "",
                reason=body.reason or "",
                approver_name=user.display_name or user.first_name or "",
                category_name=cat_name,
                tenant_id=sr.organisation_id,
            )
    except Exception:
        logger.warning("email.reject.failed sr=%s", sr_id)

    return await get_request_detail(str(sr.id), user)


async def first_response(sr_id: str, user: UserBase) -> dict[str, Any]:
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status != RequestStatusEnum.ASSIGNED:
        raise InvalidStateTransition(
            f"A first response can only be recorded on a newly assigned ticket, "
            f"and this one is {status_phrase(sr.request_status)}. If work has "
            "already started, the first response was recorded then."
        )
    if not _is_executor_of(sr, user) and not user.is_super_admin:
        raise NotExecutor()
    # Belt and braces. The target-side guards mean a requester can no longer
    # BECOME the executor of their own ticket, so this is unreachable for
    # anything created after them — but tickets escalated to their requester
    # before the fix still carry that state, and this is what stops those from
    # being worked by the person who raised them.
    deny_requester_actor(sr, user, "file the first response on")
    now = utcnow()
    sr.request_status = RequestStatusEnum.IN_PROGRESS
    sr.first_response_at = now
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()
    # Drop the first_response deadline — it has been met.
    try:
        await drop(f"{sr.id}:first_response")
    except Exception:  # noqa: BLE001
        pass
    try:
        await emit_activity(
            event=ActivityEventEnum.FIRST_RESPONSE,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
        )
    except Exception:  # noqa: BLE001
        pass
    return await get_request_detail(str(sr.id), user)


async def resolve(sr_id: str, body: ResolveBody, user: UserBase) -> dict[str, Any]:
    if not body.resolution_notes or not body.resolution_notes.strip():
        raise ResolutionNotesRequired()
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status not in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS):
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so it cannot "
            "be resolved. Only a ticket that is assigned or in progress can be."
        )
    if not _is_executor_of(sr, user) and not user.is_super_admin:
        raise NotExecutor()
    # See `first_response` — same reasoning. Resolving is the step that makes
    # closing possible, so leaving this one open would route straight back to
    # the conflict the close guard exists to prevent.
    deny_requester_actor(sr, user, "resolve")
    # Executor must file first response before resolving — super admin bypasses.
    if sr.first_response_at is None and not user.is_super_admin:
        raise InvalidStateTransition(
            "This ticket has no first response recorded yet. Record one before "
            "resolving — the SLA measures the first response separately, and "
            "resolving straight away would leave that milestone unmet."
        )
    # If approval was triggered, it must have completed before resolve.
    if (
        sr.approval_triggered_at is not None
        and sr.current_level_index is not None
        and not user.is_super_admin
    ):
        raise InvalidStateTransition(
            f"This ticket is still waiting on its Level {sr.current_level_index} "
            "approval decision, so it cannot be resolved yet. Resolve it once "
            "the approver has decided."
        )
    now = utcnow()
    sr.request_status = RequestStatusEnum.RESOLVED
    sr.resolved_at = now
    sr.resolution_notes = body.resolution_notes
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()
    try:
        await drop(
            f"{sr.id}:resolution",
            f"{sr.id}:auto_escalate",
            f"{sr.id}:pre_notify",
        )
    except Exception:  # noqa: BLE001
        pass
    await publish_event(
        "resolved",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "actor_user_id": user.id,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.RESOLVED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_request_resolved
        from ..models import Category
        from .notify_helpers import ticket_recipients
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        # Everyone involved, not just the requester: the category roster works
        # this ticket and the L1/L2 approvers signed off on it, so both have a
        # stake in it being resolved. The resolver is excluded.
        for r in await ticket_recipients(
            sr, exclude_user_ids={str(user.id)}, access_token=user.access_token
        ):
            await notify_request_resolved(
                requester_email=r["email"],
                requester_name=r["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                resolution_notes=body.resolution_notes,
                executor_name=user.display_name or user.first_name or "",
                category_name=cat_name,
                tenant_id=sr.organisation_id,
            )
    except Exception:
        logger.warning("email.resolve.failed sr=%s", sr_id)

    return await get_request_detail(str(sr.id), user)


async def close(sr_id: str, user: UserBase, closing_remarks: str | None = None) -> dict[str, Any]:
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status != RequestStatusEnum.RESOLVED:
        raise InvalidStateTransition(
            f"Only a resolved ticket can be closed, and this one is "
            f"{status_phrase(sr.request_status)}. Resolve it first."
        )
    # Requesters may not close their own ticket — they have Withdraw, not Close.
    #
    # This used to be stated here as a fact but implemented nowhere: the ladder
    # below is a pure allow-list, so a requester was excluded only when they
    # happened to fail every branch of it. Two branches are satisfied by
    # construction on a self-raised ticket:
    #
    #   * `_is_category_primary` — with no roster configured (the default) it
    #     falls back to the department head, who is an implicit primary (D3).
    #     A head's own requests route to their own department's categories, so
    #     every department head could close every ticket they raised.
    #   * the manager check — intersects the org-wide editor/admin ACL with the
    #     ticket's departments, which is likewise automatic when the requester
    #     is a manager in the department they raised into.
    #
    # Neither branch can tell "manager of this ticket" apart from "the person
    # who asked for it", so the check has to sit in front of both rather than
    # inside either. Super admin still bypasses, as everywhere else.
    deny_requester_actor(sr, user, "close")
    # Who may close? Super admin / a primary executor of the ticket's category
    # (the dept head, when no roster is configured) / a dept-head-tier manager /
    # executor (when OrgSrConfig.executor_can_close is true).
    #
    # `_can_manage_ticket`, not the raw `_is_manager_of_ticket` this used to
    # call: that one intersects an ACL granted org-wide with the ticket's
    # departments, which let a manager close any resolved ticket in the
    # organisation. The roster-aware helper answers that — with a roster
    # configured it returns False for a bare ACL holder (D7) — while leaving
    # un-rostered legacy categories closing exactly as they do today.
    #
    # One helper, not two: `_can_manage_ticket` tests `_is_category_primary` as
    # its own second rung, so a separate primary branch here would repeat a
    # Category load and an IAM department sweep to reach an answer this call has
    # already given. Awaited inside the ladder rather than before it, so the
    # super-admin path costs nothing.
    #
    # Kept in lockstep with `can_close` in compute_capabilities: narrowing one
    # without the other shows an enabled button that this then rejects.
    from .service_detail import _can_manage_ticket
    is_executor = _is_executor_of(sr, user)
    if user.is_super_admin:
        pass
    elif await _can_manage_ticket(sr, user):
        pass
    elif is_executor:
        cfg = await OrgSrConfig.find_one({"organisation_id": sr.organisation_id})
        if not (cfg and cfg.executor_can_close):
            raise ExecutorCannotClose()
    else:
        raise Forbidden("Caller cannot close this ticket")

    now = utcnow()
    sr.request_status = RequestStatusEnum.CLOSED
    sr.closed_at = now
    sr.closing_remarks = closing_remarks
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()
    await publish_event(
        "closed",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "actor_user_id": user.id,
            "closing_remarks": closing_remarks,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.CLOSED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_request_closed
        from ..models import Category
        from .notify_helpers import ticket_recipients
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        # Same audience as resolve — roster and approvers included, closer
        # excluded.
        for r in await ticket_recipients(
            sr, exclude_user_ids={str(user.id)}, access_token=user.access_token
        ):
            await notify_request_closed(
                requester_email=r["email"],
                requester_name=r["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                closed_at=sr.closed_at.isoformat() if sr.closed_at else "",
                category_name=cat_name,
                tenant_id=sr.organisation_id,
            )
    except Exception:
        logger.warning("email.close.failed sr=%s", sr_id)

    return await get_request_detail(str(sr.id), user)


# ---------- Comments ----------

async def list_comments(sr_id: str, user: UserBase) -> dict[str, Any]:
    sr = await ServiceRequest.get(sr_id)
    if sr is None or str(sr.organisation_id) != user.organisation_id or sr.deleted_on is not None:
        from ..exceptions import DomainException
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    await require_ticket_access(sr, user)
    rows = (
        await Comment.find({"service_request_id": sr.id, "deleted_on": None})
        .sort("+created_on")
        .to_list()
    )
    iam = get_iam_client()
    authors = await iam.get_users(list({str(c.author_user_id) for c in rows}), access_token=user.access_token)
    return {
        "items": [
            {
                "id": str(c.id),
                "author_user_id": str(c.author_user_id),
                "author_name": user_name(authors.get(str(c.author_user_id))),
                "author_role": None,
                "body": c.body,
                "created_on": c.created_on,
            }
            for c in rows
        ],
        "total": len(rows),
    }


# Shared with compute_capabilities (`can_withdraw`) so the rule is stated once.
from .utils.state_machine import WITHDRAW_FROM as _WITHDRAWABLE_STATUSES


async def withdraw(sr_id: str, body: WithdrawBody, user: UserBase) -> dict[str, Any]:
    """Requester pulls a ticket back before anyone starts working on it.

    Allowed only in SUBMITTED / PENDING_APPROVAL / PENDING_ASSIGNMENT.
    The moment a ticket is ASSIGNED, IN_PROGRESS, or in any terminal state,
    withdrawal is no longer permitted.
    """
    sr = await _load_non_terminal(sr_id, user.organisation_id)

    # Only the requester (or a super admin) may withdraw.
    if not user.is_super_admin and str(sr.requester_user_id) != user.id:
        raise NotRequester()

    if sr.request_status not in _WITHDRAWABLE_STATUSES:
        raise WithdrawalNotAllowed()

    now = utcnow()
    reason = (body.reason or "").strip() or None

    sr.request_status = RequestStatusEnum.WITHDRAWN
    sr.closed_at = now  # use the same terminal timestamp as close/reject
    if reason:
        sr.closing_remarks = reason
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    # Wipe every SLA / workflow-timer entry — ticket is terminal.
    try:
        await drop(
            f"{sr.id}:first_response",
            f"{sr.id}:resolution",
            f"{sr.id}:auto_escalate",
            f"{sr.id}:pre_notify",
        )
    except Exception:  # noqa: BLE001
        pass

    await publish_event(
        "withdrawn",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "actor_user_id": user.id,
            "reason": reason,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.WITHDRAWN,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"reason": reason} if reason else None,
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await emit_audit(
            event="request.withdrawn",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(sr.id), "ticket_no": sr.ticket_no, "reason": reason},
        )
    except Exception:  # noqa: BLE001
        pass

    return await get_request_detail(str(sr.id), user)


async def add_comment(sr_id: str, body: CommentBody, user: UserBase) -> dict[str, Any]:
    if not body.body or not body.body.strip():
        raise CommentBodyRequired()
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    await require_ticket_access(sr, user)
    # Access alone is read-only: a caller holding just the org-wide manager ACL
    # (or viewing as the requester's manager) can open the ticket but not post.
    # compute_capabilities owns the rule; enforce the same answer here so the
    # endpoint can't be called past a hidden button.
    from .service_detail import compute_capabilities
    caps = await compute_capabilities(sr, user)
    if not caps["can_add_comment"]:
        raise Forbidden("Caller cannot comment on this ticket")
    now = utcnow()
    c = Comment(
        service_request_id=str(sr.id),
        author_user_id=user.id,
        body=body.body,
        created_by=user.id,
        created_on=now,
    )
    await c.insert()
    await publish_event(
        "comment_added",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "comment_id": str(c.id),
            "actor_user_id": user.id,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.COMMENT_ADDED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"comment_id": str(c.id)},
        )
    except Exception:  # noqa: BLE001
        pass

    # Fan out to everyone involved, minus the commenter: the requester, the
    # executor and primary assignee, the category's executor roster, and — once
    # the executor has raised the ticket — the L1/L2 approvers. Previously only
    # the requester was mailed, so a requester's own comment reached nobody and
    # the people working the ticket never heard about it.
    try:
        from ..email_events import notify_comment_added
        from .notify_helpers import comment_thread_text, tab_for_role, ticket_recipients

        commenter_name = user.display_name or user.first_name or "Someone"
        # One read of the thread for the whole fan-out — the Conversation card
        # is identical for every recipient, and re-reading it per person would
        # multiply the query by the size of the audience.
        # The omission note carries a link, and the thread is built once for
        # everyone — so it uses the canonical tab. That is safe: `tab` only
        # picks which queue sits behind the sheet on mobile, and the sheet is
        # what the note is pointing at.
        from ..email_events import TAB_MY, _ticket_link

        comments_text = await comment_thread_text(
            sr,
            access_token=user.access_token,
            full_thread_link=_ticket_link(
                str(sr.id), TAB_MY, ticket_no=sr.ticket_no
            ),
        )
        recipients = await ticket_recipients(
            sr,
            exclude_user_ids={str(user.id)},
            access_token=user.access_token,
        )
        for r in recipients:
            await notify_comment_added(
                recipient_email=r["email"],
                recipient_name=r["name"],
                commenter_name=commenter_name,
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                # Each recipient lands on the tab their relationship implies.
                tab=tab_for_role(r["role"]),
                description=sr.description or "",
                comments_text=comments_text,
                comment_id=str(c.id),
                tenant_id=sr.organisation_id,
            )
    except Exception:  # noqa: BLE001
        logger.warning("email.comment_added.failed sr=%s", str(sr.id))

    return {
        "id": str(c.id),
        "author_user_id": user.id,
        "body": c.body,
        "created_on": c.created_on,
    }


async def list_eligible_l2_approvers(
    sr_id: str, user: UserBase
) -> dict[str, Any]:
    """Drive the FE L2 picker on the submit-for-approval dialog.

    Returns the requester's default L2 manager (prefill) and the leadership
    pool the executor may pick from. Available to the executor (or super
    admin) on tickets still pre-approval.
    """
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if not _is_executor_of(sr, user) and not user.is_super_admin:
        raise NotExecutor()
    iam = get_iam_client()
    managers = await iam.get_reporting_managers(
        str(sr.requester_user_id), access_token=user.access_token
    )
    l1_user_id = managers.get("l1_user_id")
    l2_default_user_id = managers.get("l2_user_id")

    leaders = await iam.list_leadership_users(
        str(sr.organisation_id), access_token=user.access_token
    )
    # Drop the requester and the L1 approver from the picker.
    excluded = {str(sr.requester_user_id)}
    if l1_user_id:
        excluded.add(l1_user_id)
    candidates = [c for c in leaders if c.get("user_id") not in excluded]

    # Resolve default L2 display name (it may not be a leadership member).
    default_name = None
    default_email = None
    if l2_default_user_id:
        u = await iam.get_user(l2_default_user_id, access_token=user.access_token)
        if u:
            default_name = user_name(u)
            default_email = u.get("email")

    return {
        "level_1_approver_user_id": l1_user_id,
        "default_l2_user_id": l2_default_user_id,
        "default_l2_name": default_name,
        "default_l2_email": default_email,
        "candidates": candidates,
    }


async def submit_for_approval(
    sr_id: str,
    body: SubmitForApprovalBody | None,  # kept for FE compat; ignored
    user: UserBase,
) -> dict[str, Any]:
    """Executor triggers L1 approval.

    L1 = requester's L1 manager (`employees.l1_manager_id`); snapshotted on
    the ticket so manager changes after this point don't redirect in-flight
    approvals. L2 is NOT decided here — after L1 returns, the executor can
    either resolve/close or call /trigger-l2-approval separately.
    """
    del body  # legacy field; ignore so old clients don't break
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status not in (
        RequestStatusEnum.ASSIGNED,
        RequestStatusEnum.IN_PROGRESS,
    ):
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so it cannot "
            "be sent for approval. Only a ticket you are actively working — "
            "assigned or in progress — can be."
        )
    if not _is_executor_of(sr, user) and not user.is_super_admin:
        raise NotExecutor()
    # L1 is the requester's own reporting manager, so a requester triggering
    # this would be sending their own request to their own manager as though
    # an executor had finished work on it.
    deny_requester_actor(sr, user, "submit for approval")
    if sr.first_response_at is None and not user.is_super_admin:
        raise InvalidStateTransition(
            "This ticket has no first response recorded yet. Record one before "
            "sending it for approval."
        )
    # L1 can only be triggered once per ticket — if there's already a level-1
    # decision, the executor's next step is either trigger-l2 or resolve.
    existing_l1 = await ApprovalDecision.find_one(
        {
            "service_request_id": sr.id,
            "level_index": 1,
            "deleted_on": None,
        }
    )
    if existing_l1 is not None:
        raise InvalidStateTransition(
            "This ticket has already been through Level 1 approval — that "
            "decision is recorded and cannot be requested twice. If it needs a "
            "second sign-off, send it for L2 approval instead."
        )

    iam = get_iam_client()
    managers = await iam.get_reporting_managers(
        str(sr.requester_user_id), access_token=user.access_token
    )
    l1_user_id = managers.get("l1_user_id")
    if not l1_user_id:
        raise NoL1ManagerConfigured()

    now = utcnow()
    sr.request_status = RequestStatusEnum.PENDING_APPROVAL
    sr.current_level_index = 1
    sr.escalation_override_approver_user_id = None
    sr.level_1_approver_user_id = l1_user_id
    if sr.approval_triggered_at is None:
        sr.approval_triggered_at = now
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    await publish_event(
        "submitted_for_approval",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "level_index": 1,
            "actor_user_id": user.id,
            "level_1_approver_user_id": l1_user_id,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.SUBMITTED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={
                "reason": "submitted_for_approval",
                "level_index": 1,
                "level_1_approver_user_id": l1_user_id,
            },
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_approval_pending
        from ..common.email_resolver import resolve_user_info
        from ..models import Category
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        req_info = await resolve_user_info(
            str(sr.requester_user_id), access_token=user.access_token
        )
        a_info = await resolve_user_info(
            l1_user_id, access_token=user.access_token
        )
        # Quote the thread so the approver decides with the discussion in hand.
        # Plain text, not a list — the renderer substitutes literally.
        from ..email_events import TAB_TEAM, _ticket_link
        from .notify_helpers import comment_thread_text
        thread = await comment_thread_text(
            sr,
            access_token=user.access_token,
            full_thread_link=_ticket_link(str(sr.id), TAB_TEAM, ticket_no=sr.ticket_no),
        )
        # Act-from-email: one single-use token for this approver at this level.
        # Fail-soft — no token just means the mail ships without the buttons.
        from .action_tokens import mint_action_token, role_for_level
        action_token = await mint_action_token(
            sr,
            actor_id=l1_user_id,
            actor_email=a_info["email"],
            actor_role=role_for_level(1),
        )
        if a_info["email"]:
            await notify_approval_pending(
                approver_email=a_info["email"],
                approver_name=a_info["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                level_index=1,
                action_token=action_token,
                requester_name=req_info["name"],
                category_name=cat_name,
                priority=sr.priority.value if sr.priority else "",
                comments_text=thread,
                tenant_id=sr.organisation_id,
            )
    except Exception:  # noqa: BLE001
        logger.warning("email.submit_for_approval.failed sr=%s", sr_id)

    return await get_request_detail(str(sr.id), user)


async def trigger_l2_approval(
    sr_id: str,
    body: SubmitForApprovalBody | None,
    user: UserBase,
) -> dict[str, Any]:
    """Executor pushes ticket into L2 PENDING_APPROVAL.

    L1 and L2 are independent — the executor may trigger L2 without ever
    going through L1, or in any order. Only blocked once L2 has already been
    decided on this ticket.  L2 default = requester's L2 manager; the
    executor may override with any leadership-policy user.
    """
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status not in (
        RequestStatusEnum.ASSIGNED,
        RequestStatusEnum.IN_PROGRESS,
    ):
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so it cannot "
            "be sent for L2 approval. It has to be back with you — assigned or "
            "in progress — which happens once L1 has decided."
        )
    if not _is_executor_of(sr, user) and not user.is_super_admin:
        raise NotExecutor()
    if sr.first_response_at is None and not user.is_super_admin:
        raise InvalidStateTransition(
            "This ticket has no first response recorded yet. Record one before "
            "sending it for L2 approval."
        )
    # L2 can only be triggered once.
    existing_l2 = await ApprovalDecision.find_one(
        {
            "service_request_id": sr.id,
            "level_index": 2,
            "deleted_on": None,
        }
    )
    if existing_l2 is not None:
        raise InvalidStateTransition(
            "This ticket has already been through Level 2 approval — that "
            "decision is recorded and cannot be requested twice."
        )

    iam = get_iam_client()
    managers = await iam.get_reporting_managers(
        str(sr.requester_user_id), access_token=user.access_token
    )
    l2_default_user_id = managers.get("l2_user_id")
    override_user_id = (body.level_2_approver_user_id if body else None) or None
    if override_user_id:
        if override_user_id in (
            sr.requester_user_id,
            sr.level_1_approver_user_id,
        ):
            raise L2OverrideInvalid()
        leaders = await iam.list_leadership_users(
            str(sr.organisation_id), access_token=user.access_token
        )
        leader_ids = {str(l.get("user_id")) for l in leaders}
        if str(override_user_id) not in leader_ids:
            raise L2OverrideNotLeadership()
        l2_user_id = override_user_id
        l2_overridden = True
    else:
        if not l2_default_user_id:
            raise NoL2ManagerConfigured()
        l2_user_id = l2_default_user_id
        l2_overridden = False

    now = utcnow()
    sr.request_status = RequestStatusEnum.PENDING_APPROVAL
    sr.current_level_index = 2
    sr.escalation_override_approver_user_id = None
    sr.level_2_approver_user_id = l2_user_id
    sr.level_2_default_user_id = l2_default_user_id
    sr.level_2_overridden = l2_overridden
    sr.level_2_override_chosen_by = user.id if l2_overridden else None
    # Mirrors submit_for_approval (L1). Without it a ticket sent straight to L2
    # — which this endpoint explicitly allows, L1 and L2 being independent —
    # carries no record that an approval was ever raised, because `approve`
    # clears `current_level_index` the moment the decision lands. Every gate
    # that asks "was this ticket approved" then reads False: the timeline drops
    # the approval rows entirely (service_detail `_build_timeline`, which
    # renders them "hidden" while active and "Skipped — approval not triggered"
    # once terminal), and `approver_engaged` stops recognising the approver.
    #
    # Guarded, not a plain assignment: on an L1 -> L2 ticket this must NOT
    # overwrite the L1 trigger. Doing so would leave the L1 decision measured
    # against a timestamp later than itself, feeding negative hours into the
    # decision-latency average in analytics.metrics.descriptive.
    if sr.approval_triggered_at is None:
        sr.approval_triggered_at = now
    # Unguarded, unlike the above: this is level 2's own clock, and a re-trigger
    # genuinely restarts the wait it measures.
    sr.level_2_triggered_at = now
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    await publish_event(
        "submitted_for_approval",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "level_index": 2,
            "actor_user_id": user.id,
            "level_2_approver_user_id": str(l2_user_id),
            "level_2_overridden": l2_overridden,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.SUBMITTED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={
                "reason": "trigger_l2_approval",
                "level_index": 2,
                "level_2_approver_user_id": str(l2_user_id),
                "level_2_default_user_id": str(l2_default_user_id) if l2_default_user_id else None,
                "level_2_overridden": l2_overridden,
            },
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_approval_pending
        from ..common.email_resolver import resolve_user_info
        from ..models import Category
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        req_info = await resolve_user_info(
            str(sr.requester_user_id), access_token=user.access_token
        )
        a_info = await resolve_user_info(
            str(l2_user_id), access_token=user.access_token
        )
        from ..email_events import TAB_TEAM, _ticket_link
        from .notify_helpers import comment_thread_text
        thread = await comment_thread_text(
            sr,
            access_token=user.access_token,
            full_thread_link=_ticket_link(str(sr.id), TAB_TEAM, ticket_no=sr.ticket_no),
        )
        # Act-from-email: one single-use token for this approver at this level.
        # Fail-soft — no token just means the mail ships without the buttons.
        from .action_tokens import mint_action_token, role_for_level
        action_token = await mint_action_token(
            sr,
            actor_id=l2_user_id,
            actor_email=a_info["email"],
            actor_role=role_for_level(2),
        )
        if a_info["email"]:
            await notify_approval_pending(
                approver_email=a_info["email"],
                approver_name=a_info["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                level_index=2,
                action_token=action_token,
                requester_name=req_info["name"],
                category_name=cat_name,
                priority=sr.priority.value if sr.priority else "",
                comments_text=thread,
                tenant_id=sr.organisation_id,
            )
    except Exception:  # noqa: BLE001
        logger.warning("email.trigger_l2.failed sr=%s", sr_id)

    return await get_request_detail(str(sr.id), user)
