"""SRM email event publisher — publishes to the ``email_events`` exchange.

Uses the same transactional outbox as IAM so emails survive broker downtime.
A downstream email worker (shared with IAM) consumes these events and sends
the actual emails via SMTP.

Template IDs follow the convention ``srm_<event>_v1``.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid4, uuid5

from .config import settings
from .rabbitmq.outbox import publish
from .rabbitmq.constants import email_events_config

logger = logging.getLogger(__name__)


def _envelope(event_type: str, tenant_id: str, payload: dict, idempotency_key: str = "") -> dict:
    return {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": event_type,
        "correlation_id": str(uuid4()),
        "idempotency_key": idempotency_key or str(uuid4()),
        "tenant_id": tenant_id,
        "payload": payload,
        # Z-suffixed, whole seconds — the wire format the email worker expects.
        # `.isoformat()` alone yields microseconds and a "+00:00" offset.
        "published_at": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
    }


# Field names the email renderer auto-formats: it parses the ISO value,
# converts UTC -> EMAIL_DISPLAY_TIMEZONE (Asia/Kolkata) and prints
# DD-MM-YYYY HH:MM:SS. Anything in this set MUST be sent as ISO-8601 — a
# pre-formatted human string will not parse, so it passes through unconverted
# and lands in the mail as UTC in the wrong format. Formatting is the email
# service's job, not ours.
_ISO_DATE_FIELDS = frozenset({
    "submitted_at", "approved_on", "decided_on", "sla_due_at", "closed_at",
    "last_working_day", "holiday_date", "start_date", "end_date",
    "week_start", "week_end", "week_range",
})


def _iso(value: str | datetime | None) -> str:
    """ISO-8601 for a renderer-formatted date field. Empty stays empty."""
    if not value:
        return ""
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return value


async def _publish_email(
    routing_key: str,
    to: str,
    template_id: str,
    template_data: dict,
    tenant_id: str = "",
    idempotency_suffix: str = "",
    dispatch_priority: str = "normal",
) -> None:
    outbox_idemp = f"{routing_key}:{idempotency_suffix or uuid4()}"
    # Deterministic per (request, recipient), but hashed into a real UUID:
    # `TaskMessage.idempotency_key` is typed UUID, so a raw colon-string fails
    # validation on the consumer and the message dead-letters instead of being
    # sent. uuid5 keeps the determinism the contract asks for while satisfying
    # the type. Only event_id / correlation_id / idempotency_key are UUIDs —
    # tenant_id stays the org ObjectId.
    envelope_idemp = (
        str(uuid5(NAMESPACE_URL, outbox_idemp)) if idempotency_suffix else str(uuid4())
    )
    envelope = _envelope(
        routing_key,
        tenant_id,
        {
            "to": to,
            "template_id": template_id,
            "template_data": template_data,
            # Dispatch hint for the email worker's queue, not ticket priority.
            "priority": dispatch_priority,
        },
        idempotency_key=envelope_idemp,
    )
    try:
        await publish(
            routing_key,
            envelope,
            idempotency_key=outbox_idemp,
            exchange=email_events_config.EXCHANGE_NAME,
        )
    except Exception:
        # Kept: these publishes are fire-and-forget, so without this a failure
        # is indistinguishable from a mail that was never triggered.
        logger.warning(
            "email_event.publish_failed routing_key=%s to=%s outbox_key=%s",
            routing_key, to, outbox_idemp, exc_info=True,
        )


# Which phone tab the deep link should open. Desktop ignores `tab` entirely —
# `mobileView` is only consulted on a mobile shell — so one link serves both and
# we never have to know the recipient's device.
TAB_MY = "my"            # My Tickets      — the recipient raised it
TAB_EXECUTE = "execute"  # To Execute      — the recipient works it
TAB_TEAM = "team"        # Team Tickets    — the recipient approves it


def _ticket_link(sr_id: str, tab: str = TAB_MY, *, ticket_no: str = "") -> str:
    """Deep link to the ticket's detail sheet.

    Only `my-requests/list` honours `?tab=`, and its detail sheet is driven by
    `selectedId` alone — so it opens a ticket the recipient did not raise just
    as happily as one they did. That makes it the single route for every mail.

    `request` is the ticket's **Mongo id**, not `ticket_no`; the sheet looks up
    by id. Both params are consumed on mount and stripped, so a refresh or back
    gesture won't reopen the sheet.

    Entitlement is not enforced by the route — the guard is auth-only. GET
    /requests/{id} decides whether the recipient actually sees the ticket, and
    shows an error if not, which is the correct outcome.
    """
    if not sr_id:
        # A link built without the id would 404 the sheet silently; say so.
        logger.warning(
            "email.link.missing_sr_id ticket_no=%s tab=%s — link will not open",
            ticket_no or "?", tab,
        )
    return (
        f"{settings.FRONTEND_URL}/service-request/my-requests/list"
        f"?request={sr_id}&tab={tab}"
    )


def _action_links(resource_id: str, token: str | None) -> dict[str, str]:
    """approve/reject deep links for act-from-email, or blanks when unavailable.

    Both keys are ALWAYS present. The template hides the buttons on empty rather
    than failing on a missing variable, so a ticket whose token could not be
    minted still sends — just without the buttons.

    These point at a *page*, never at the action endpoint. Some mail clients and
    security scanners prefetch links; the page POSTs, so a GET can never cast a
    decision. Making the action a GET is the single most common way this pattern
    goes wrong.
    """
    if not token:
        return {"approve_link": "", "reject_link": ""}
    base = (
        f"{settings.FRONTEND_URL}{settings.EMAIL_ACTION_PATH}"
        f"?token={token}&resource_id={resource_id}"
    )
    return {
        "approve_link": f"{base}&action=approve",
        "reject_link": f"{base}&action=reject",
    }


# ── Public email triggers ─────────────────────────────────────────────────


async def notify_request_submitted(
    *,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    priority: str,
    category_name: str,
    submitted_at: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.request_submitted",
        to=requester_email,
        template_id="srm_request_submitted_v1",
        template_data={
            "display_name": requester_name,
            "request_id": ticket_no,
            "category": category_name,
            "subject": title,
            "description": description,
            # tab=my: all three land on the requester. Sent explicitly rather
            # than omitted so every trigger reads the same at the call site.
            "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            "priority": priority,
            "submitted_at": _iso(submitted_at),
        },
        tenant_id=tenant_id,
        idempotency_suffix=f"submitted:{ticket_no}",
    )


async def notify_request_intimation(
    *,
    recipient_email: str,
    recipient_name: str,
    ticket_no: str,
    title: str,
    priority: str,
    category_name: str,
    department_name: str,
    requester_name: str,
    submitted_at: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    """Tell one rostered executor that a new request has landed in their category.

    Recipients are the category's executor roster — primary and secondary alike,
    and nobody else. This used to mail every employee of every department the
    category names, which put a ticket in the inbox of dozens of people who
    would never touch it; the roster is the authoritative answer to "who works
    this category" (see `categories.service.resolve_workforce`), so it is the
    right audience for "a ticket arrived".

    The routing key and template id still say *department*. They are the wire
    contract with the shared email worker, which owns the template registry and
    lives outside this repo — renaming them here would publish an event that
    renders as nothing. `department_name` now carries the recipient's own
    department off their roster snapshot.

    One event per recipient; idempotency keyed on (ticket_no, email) so
    re-publishes don't double-send.
    """
    await _publish_email(
        "email.srm.department_intimation",
        to=recipient_email,
        template_id="srm_department_intimation_v1",
        # Key set fixed by the agreed contract with the email worker.
        # `submitted_at` goes out as ISO-8601: the renderer auto-formats that
        # field name, converting UTC -> EMAIL_DISPLAY_TIMEZONE and printing
        # DD-MM-YYYY HH:MM:SS. Pre-formatting it here would not parse, so the
        # string would pass through unconverted and out of step with every
        # other email. See _ISO_DATE_FIELDS.
        template_data={
            "display_name": recipient_name,
            "request_id": ticket_no,
            "category": category_name,
            "requester_name": requester_name,
            "subject": title,
            "description": description,
            "priority": priority,
            "submitted_at": _iso(submitted_at),
            "request_link": _ticket_link(sr_id, TAB_EXECUTE, ticket_no=ticket_no),
        },
        tenant_id=tenant_id,
        idempotency_suffix=f"intimation:{ticket_no}:{recipient_email}",
    )


async def notify_approval_pending(
    *,
    approver_email: str,
    approver_name: str,
    ticket_no: str,
    title: str,
    level_index: int,
    requester_name: str,
    category_name: str = "",
    priority: str = "",
    comments_text: str = "",
    sr_id: str = "",
    action_token: str | None = None,
    description: str = "",
    tenant_id: str = "",
) -> None:
    """Ask an approver to decide.

    `action_token` turns on the Approve / Reject buttons in the mail. Omit it
    and both link fields go out empty, which hides the buttons — the "open in
    app" link below is always present as the fallback for every failure path.

    `comments_text` carries the conversation so far as pre-formatted plain text
    — an approver deciding off the subject line alone has no idea what was
    already discussed. It must be a string, not a list: the renderer does
    literal substitution with no loops, so a structured value cannot become a
    thread. Build it with `notify_helpers.comment_thread_text`. Empty or
    omitted simply hides the Conversation section, which is right for a ticket
    nobody has commented on.

    `approval_level` is sent explicitly so the template can say which level is
    being asked for.
    """
    await _publish_email(
        "email.srm.approval_pending",
        to=approver_email,
        template_id="srm_approval_pending_v1",
        template_data={
            "display_name": approver_name,
            "request_id": ticket_no,
            "requester_name": requester_name,
            "category": category_name,
            "subject": title,
            "description": description,
            "priority": priority,
            "approval_level": f"L{level_index}",
            "comments_text": comments_text,
            "approval_link": _ticket_link(sr_id, TAB_TEAM, ticket_no=ticket_no),
            **_action_links(sr_id, action_token),
        },
        tenant_id=tenant_id,
        idempotency_suffix=f"approval_pending:{ticket_no}:L{level_index}:{approver_email}",
    )


async def notify_request_approved(
    *,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    level_index: int,
    approver_name: str = "",
    category_name: str = "",
    remarks: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.request_approved",
        to=requester_email,
        template_id="srm_request_approved_v1",
        template_data={
            "display_name": requester_name,
            "request_id": ticket_no,
            "category": category_name,
            "subject": title,
            "description": description,
            # tab=my: the decision mail goes to the requester.
            "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            "approver_name": approver_name,
            "remarks": remarks,
        },
        tenant_id=tenant_id,
        # Per (level, recipient) — the same shape notify_approval_pending uses.
        # `approve` fans this out over `ticket_recipients`, and the level matters
        # as well as the recipient: without it an L2 approval collides with the
        # L1 approval already recorded for the same ticket and reaches nobody at
        # all. Outbox rows are never purged, so a taken key stays taken.
        idempotency_suffix=f"approved:{ticket_no}:L{level_index}:{requester_email}",
    )


async def notify_request_rejected(
    *,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    reason: str,
    level_index: int,
    approver_name: str = "",
    category_name: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.request_rejected",
        to=requester_email,
        template_id="srm_request_rejected_v1",
        template_data={
            "display_name": requester_name,
            "request_id": ticket_no,
            "category": category_name,
            "subject": title,
            "description": description,
            # tab=my: the decision mail goes to the requester.
            "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            "approver_name": approver_name,
            "remarks": reason,
        },
        tenant_id=tenant_id,
        # Per (level, recipient) — see notify_request_approved.
        idempotency_suffix=f"rejected:{ticket_no}:L{level_index}:{requester_email}",
    )


async def notify_executor_assigned(
    *,
    executor_email: str,
    executor_name: str,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    category_name: str = "",
    priority: str = "",
    sla_due_at: str = "",
    sr_id: str = "",
    notify_requester: bool = True,
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.executor_assigned",
        to=executor_email,
        template_id="srm_executor_assigned_v1",
        template_data={
            "display_name": executor_name,
            "request_id": ticket_no,
            "requester_name": requester_name,
            "category": category_name,
            "subject": title,
            "description": description,
            "priority": priority,
            "sla_due_at": _iso(sla_due_at),
            "request_link": _ticket_link(sr_id, TAB_EXECUTE, ticket_no=ticket_no),
        },
        tenant_id=tenant_id,
        idempotency_suffix=f"exec_assigned:{ticket_no}:{executor_email}",
    )
    if notify_requester:
        await _publish_email(
            "email.srm.executor_assigned_requester",
            to=requester_email,
            template_id="srm_executor_assigned_requester_v1",
            template_data={
                "display_name": requester_name,
                "request_id": ticket_no,
                "executor_name": executor_name,
                "category": category_name,
                "subject": title,
                "description": description,
                "sla_due_at": _iso(sla_due_at),
                # tab=my: this send goes to the requester, even though the
                # trigger's primary recipient is the executor/escalation target.
                "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            },
            tenant_id=tenant_id,
            idempotency_suffix=f"exec_assigned_req:{ticket_no}",
        )


async def notify_request_escalated(
    *,
    escalation_target_email: str,
    escalation_target_name: str,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    reason: str,
    category_name: str = "",
    priority: str = "",
    sr_id: str = "",
    notify_requester: bool = True,
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.request_escalated",
        to=escalation_target_email,
        template_id="srm_request_escalated_v1",
        template_data={
            "display_name": escalation_target_name,
            "request_id": ticket_no,
            "requester_name": requester_name,
            "category": category_name,
            "subject": title,
            "description": description,
            "priority": priority,
            "escalation_reason": reason,
            "request_link": _ticket_link(sr_id, TAB_EXECUTE, ticket_no=ticket_no),
        },
        tenant_id=tenant_id,
        idempotency_suffix=f"escalated:{ticket_no}:{escalation_target_email}",
    )
    if notify_requester:
        await _publish_email(
            "email.srm.request_escalated_requester",
            to=requester_email,
            template_id="srm_request_escalated_requester_v1",
            template_data={
                "display_name": requester_name,
                "request_id": ticket_no,
                "category": category_name,
                "subject": title,
                "description": description,
                "escalated_to_name": escalation_target_name,
                # tab=my: this send goes to the requester, even though the
                # trigger's primary recipient is the executor/escalation target.
                "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            },
            tenant_id=tenant_id,
            idempotency_suffix=f"escalated_req:{ticket_no}",
        )


async def notify_request_resolved(
    *,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    resolution_notes: str | None = None,
    executor_name: str = "",
    category_name: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.request_resolved",
        to=requester_email,
        template_id="srm_request_resolved_v1",
        template_data={
            "display_name": requester_name,
            "request_id": ticket_no,
            "category": category_name,
            "subject": title,
            "description": description,
            # tab=my: all three land on the requester. Sent explicitly rather
            # than omitted so every trigger reads the same at the call site.
            "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            "executor_name": executor_name,
            "resolution_notes": resolution_notes or "",
        },
        tenant_id=tenant_id,
        # Keyed per recipient. `resolve` fans this out over `ticket_recipients`
        # (the roster and the approvers, not just the requester), and the outbox
        # uniquely indexes `idempotency_key` and swallows the duplicate — so a
        # ticket-only key silently delivered to whoever came first and dropped
        # everyone after them.
        idempotency_suffix=f"resolved:{ticket_no}:{requester_email}",
    )


async def notify_request_closed(
    *,
    requester_email: str,
    requester_name: str,
    ticket_no: str,
    title: str,
    closed_at: str = "",
    category_name: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    await _publish_email(
        "email.srm.request_closed",
        to=requester_email,
        template_id="srm_request_closed_v1",
        template_data={
            "display_name": requester_name,
            "request_id": ticket_no,
            "category": category_name,
            "subject": title,
            "description": description,
            # tab=my: all three land on the requester. Sent explicitly rather
            # than omitted so every trigger reads the same at the call site.
            "request_link": _ticket_link(sr_id, TAB_MY, ticket_no=ticket_no),
            "closed_at": _iso(closed_at),
        },
        tenant_id=tenant_id,
        # Per recipient — see notify_request_resolved. `close` fans out too.
        idempotency_suffix=f"closed:{ticket_no}:{requester_email}",
    )


async def notify_comment_added(
    *,
    recipient_email: str,
    recipient_name: str,
    commenter_name: str,
    ticket_no: str,
    title: str,
    comments_text: str,
    comment_id: str,
    tab: str = TAB_MY,
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
) -> None:
    """Tell one recipient a comment was added, quoting the whole thread.

    `comments_text` is the entire conversation as pre-formatted plain text —
    the template renders a Conversation card of past *and* present, so sending
    only the new comment leaves it empty. Build it with
    `notify_helpers.comment_thread_text` once per comment and pass the same
    string to every recipient; the renderer substitutes literally and escapes
    HTML, so it must stay plain text.

    `comment_id` makes the idempotency key unique per (ticket, comment,
    recipient) and deterministic — a re-publish of the same comment will not
    double-send, while a second comment on the same ticket still goes out.
    """
    await _publish_email(
        "email.srm.comment_added",
        to=recipient_email,
        template_id="srm_comment_added_v1",
        template_data={
            "display_name": recipient_name,
            "request_id": ticket_no,
            "subject": title,
            "description": description,
            "comment_by": commenter_name,
            "comments_text": comments_text,
            "request_link": _ticket_link(sr_id, tab, ticket_no=ticket_no),
        },
        tenant_id=tenant_id,
        idempotency_suffix=f"{ticket_no}:{comment_id}:{recipient_email}",
    )


async def notify_sla_breached(
    *,
    assignee_email: str,
    assignee_name: str,
    ticket_no: str,
    title: str,
    breach_type: str,
    requester_name: str = "",
    category_name: str = "",
    priority: str = "",
    sla_due_at: str = "",
    executor_name: str = "",
    sr_id: str = "",
    description: str = "",
    tenant_id: str = "",
    idempotency_discriminator: str = "",
) -> None:
    """Mail one person that a ticket breached its SLA.

    ``idempotency_discriminator`` widens the dedupe key. One breach can produce
    several of these — one to the assignee, one per configured notification
    recipient — and the outbox key is uniquely indexed, so without something to
    tell them apart only the first would ever be published. Pass the recipient's
    address when fanning out; leave it empty for the single assignee mail, whose
    per-ticket-per-deadline dedupe is the behaviour we want.
    """
    suffix = f"sla_breach:{ticket_no}:{breach_type}"
    if idempotency_discriminator:
        suffix = f"{suffix}:{idempotency_discriminator}"
    await _publish_email(
        "email.srm.sla_breached",
        to=assignee_email,
        template_id="srm_sla_breached_v1",
        template_data={
            "display_name": assignee_name,
            "request_id": ticket_no,
            "requester_name": requester_name,
            "category": category_name,
            "subject": title,
            "description": description,
            "priority": priority,
            "sla_due_at": _iso(sla_due_at),
            "executor_name": executor_name,
            "request_link": _ticket_link(sr_id, TAB_EXECUTE, ticket_no=ticket_no),
        },
        tenant_id=tenant_id,
        idempotency_suffix=suffix,
    )
