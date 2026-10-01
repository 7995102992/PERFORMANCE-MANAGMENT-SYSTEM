"""Leave management email events — published via the transactional outbox.

Trigger map:
  leave_request_submitted         → employee (confirmation), first-level approver (action pending)
  leave_request_submitted_notice  → HR (third-person intimation, no action)
  leave_request_approved          → employee
  leave_request_rejected          → employee
  leave_request_*_notice          → L1 manager + HR (third-person copy)
  leave_request_cancelled         → employee
  holiday_plan_created/updated    → creator
  holiday_reminder                → employee (cron-triggered)
  work_calendar_created/updated   → creator
  work_calendar_employee_added    → added employee
  shift_employee_added            → assigned employee
"""

from datetime import datetime, timezone
from urllib.parse import quote
from uuid import uuid4

from src.config import settings
from src.logger import logger
from src.messaging.constants.exchanges import Exchanges
from src.messaging.outbox import worker as _outbox

# ── Routing keys ──────────────────────────────────────────────────────────────

_EV_SUBMITTED = "email.leave_request_submitted"
_EV_SUBMITTED_NOTICE = "email.leave_request_submitted_notice"
_EV_APPROVAL_PENDING = "email.leave_approval_pending"
_EV_APPROVED = "email.leave_request_approved"
_EV_REJECTED = "email.leave_request_rejected"
_EV_CANCELLED = "email.leave_request_cancelled"
_EV_ESCALATED_HR = "email.leave_request_escalated_hr"
_EV_APPROVED_NOTICE = "email.leave_request_approved_notice"
_EV_REJECTED_NOTICE = "email.leave_request_rejected_notice"
_EV_ALLOCATION_EXCEEDED = "email.leave_allocation_exceeded"

_EV_HOLIDAY_PLAN_CREATED = "email.holiday_plan_created"
_EV_HOLIDAY_PLAN_UPDATED = "email.holiday_plan_updated"
_EV_HOLIDAY_PLAN_EMPLOYEE_ADDED = "email.holiday_plan_employee_added"
_EV_HOLIDAY_REMINDER = "email.holiday_reminder"

_EV_WORK_CALENDAR_CREATED = "email.work_calendar_created"
_EV_WORK_CALENDAR_UPDATED = "email.work_calendar_updated"
_EV_WORK_CALENDAR_EMPLOYEE_ADDED = "email.work_calendar_employee_added"

_EV_SHIFT_EMPLOYEE_ADDED = "email.shift_employee_added"


# ── Helpers ───────────────────────────────────────────────────────────────────

# Same divisor the request document is built with (``duration_days`` is stored
# as ``duration_hours / 8.0``), so the mail can never disagree with the record.
HOURS_PER_DAY = 8.0


def _days(duration_hours: float) -> str:
    """Hours rendered as the day count the templates show.

    Returns a trimmed number — "1", "2.5", "0.5" — because the row is labelled
    DAYS: a bare ``round()`` would print "1.0 days", and the trailing zero reads
    like a precision the half-day granularity doesn't have.
    """
    try:
        days = round(float(duration_hours) / HOURS_PER_DAY, 2)
    except (TypeError, ValueError):
        return "0"
    return f"{days:.2f}".rstrip("0").rstrip(".") or "0"


def _envelope(event_type: str, tenant_id: str, payload: dict) -> dict:
    return {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": event_type,
        "correlation_id": str(uuid4()),
        "idempotency_key": str(uuid4()),
        "tenant_id": tenant_id,
        "payload": payload,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }


async def _publish(
    routing_key: str,
    template_id: str,
    to: str,
    template_data: dict,
    idempotency_key: str,
    tenant_id: str = "",
) -> None:
    if not to:
        return

    envelope = _envelope(routing_key, tenant_id, {
        "to": to,
        "template_id": template_id,
        "template_data": template_data,
    })

    await _outbox.publish(
        routing_key,
        envelope,
        idempotency_key=idempotency_key,
        exchange=Exchanges.EMAIL_EVENTS,
    )
    logger.info("Leave email event queued", routing_key=routing_key, to=to)


def _request_link(request_id: str) -> str:
    """Deep link for the employee — their own leave list, detail view open.

    ``/leave-requests/<id>`` is this service's own API path, not a page: the app
    has no route for a single leave request. The employee page opens one via its
    ``?view=detail&leaveId=`` search params, which is what this has to produce.
    """
    base = settings.FRONTEND_URL.rstrip("/")
    return (
        f"{base}/leave-management/employee-leave-management"
        f"?view=detail&leaveId={quote(request_id)}"
    )


def _approve_link(request_id: str) -> str:
    """Deep link for an approver or HR — the manager page, request opened.

    That page holds the selected request in state and fetches it by id, so
    ``?request=`` is enough for it to open whatever the mail points at,
    independent of the list's current filter.
    """
    base = settings.FRONTEND_URL.rstrip("/")
    return (
        f"{base}/leave-management/manager-leave-management"
        f"?request={quote(request_id)}"
    )


# ── Public publish functions ──────────────────────────────────────────────────

async def publish_leave_request_submitted(
    *,
    employee_email: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    duration_hours: float,
    request_id: str,
    tenant_id: str = "",
) -> None:
    """Notify employee that their leave request has been submitted."""
    await _publish(
        _EV_SUBMITTED,
        template_id="leave_request_submitted_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "duration_days": _days(duration_hours),
            "request_id": request_id,
            "request_link": _request_link(request_id),
        },
        idempotency_key=f"email.leave_submitted:{request_id}:{employee_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_approval_pending(
    *,
    approver_email: str,
    approver_name: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    duration_hours: float,
    request_id: str,
    level: int = 1,
    tenant_id: str = "",
) -> None:
    """Notify approver that a leave request is pending their action."""
    await _publish(
        _EV_APPROVAL_PENDING,
        template_id="leave_approval_pending_v1",
        to=approver_email,
        template_data={
            "display_name": approver_name,
            "employee_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "duration_days": _days(duration_hours),
            "request_id": request_id,
            "approve_link": _approve_link(request_id),
        },
        idempotency_key=f"email.leave_approval_pending:{request_id}:L{level}:{approver_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_submission_notice(
    *,
    recipient_email: str,
    recipient_name: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    duration_hours: float,
    request_id: str,
    tenant_id: str = "",
) -> None:
    """Intimate HR that an employee has applied for leave.

    Distinct from ``publish_leave_approval_pending``, which is addressed to a
    real approver ("requires your approval", CTA on the approve screen). HR sits
    outside the approval chain — it is copied on every submission for visibility
    only — so it gets the third-person ``_notice_`` wording and a read-only link,
    the same split the approve/reject path already makes via
    ``publish_leave_decision_notice``.
    """
    await _publish(
        _EV_SUBMITTED_NOTICE,
        template_id="leave_request_submitted_notice_v1",
        to=recipient_email,
        template_data={
            "display_name": recipient_name,
            "employee_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "duration_days": _days(duration_hours),
            "request_id": request_id,
            "request_link": _approve_link(request_id),
        },
        idempotency_key=f"{_EV_SUBMITTED_NOTICE}:{request_id}:{recipient_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_allocation_exceeded(
    *,
    recipient_email: str,
    recipient_name: str,
    employee_name: str,
    leave_type_name: str,
    days_used: float,
    annual_limit: float,
    period_label: str,
    start_date: str,
    end_date: str,
    request_id: str,
    is_employee: bool,
    tenant_id: str = "",
) -> None:
    """Warn that this request takes the employee past the type's yearly allocation.

    Advisory only — the request was accepted. It fires for types whose yearly
    count is not enforced by a balance (WFH and other unrestricted /
    non-deducting leave), where nothing else would tell either party the
    allocation is spent.

    One publisher for both audiences: the recipient set is the employee plus
    their approvers, and `is_employee` lets the template address them correctly
    without a second event type. The idempotency key includes the address, so a
    retry cannot double-send and an approver who is also the employee gets one
    mail.
    """
    await _publish(
        _EV_ALLOCATION_EXCEEDED,
        template_id="leave_allocation_exceeded_v1",
        to=recipient_email,
        template_data={
            "display_name": recipient_name,
            "employee_name": employee_name,
            "leave_type_name": leave_type_name,
            "days_used": days_used,
            "annual_limit": annual_limit,
            "days_over": round(days_used - annual_limit, 2),
            "period_label": period_label,
            "start_date": start_date,
            "end_date": end_date,
            "request_id": request_id,
            "is_employee": is_employee,
            "request_link": _request_link(request_id),
        },
        idempotency_key=f"email.leave_allocation_exceeded:{request_id}:{recipient_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_request_approved(
    *,
    employee_email: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    duration_hours: float,
    request_id: str,
    approver_name: str = "",
    tenant_id: str = "",
) -> None:
    """Notify employee that their leave request has been fully approved."""
    await _publish(
        _EV_APPROVED,
        template_id="leave_request_approved_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "duration_days": _days(duration_hours),
            "request_id": request_id,
            "approver_name": approver_name,
            "request_link": _request_link(request_id),
        },
        idempotency_key=f"email.leave_approved:{request_id}:{employee_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_request_rejected(
    *,
    employee_email: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    request_id: str,
    approver_name: str = "",
    comment: str = "",
    tenant_id: str = "",
) -> None:
    """Notify employee that their leave request has been rejected."""
    await _publish(
        _EV_REJECTED,
        template_id="leave_request_rejected_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "request_id": request_id,
            "approver_name": approver_name,
            "comment": comment,
            "request_link": _request_link(request_id),
        },
        idempotency_key=f"email.leave_rejected:{request_id}:{employee_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_request_cancelled(
    *,
    employee_email: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    request_id: str,
    tenant_id: str = "",
) -> None:
    """Notify employee that their leave request has been cancelled."""
    await _publish(
        _EV_CANCELLED,
        template_id="leave_request_cancelled_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "request_id": request_id,
            "request_link": _request_link(request_id),
        },
        idempotency_key=f"email.leave_cancelled:{request_id}:{employee_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_decision_notice(
    *,
    recipient_email: str,
    recipient_name: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    request_id: str,
    approved: bool,
    duration_hours: float = 0,
    approver_name: str = "",
    comment: str = "",
    tenant_id: str = "",
) -> None:
    """Notify the L1 manager / HR that a request was approved or rejected.

    Distinct from ``publish_leave_request_approved`` / ``_rejected``, which are
    addressed to the employee ("Your leave request has been approved"). These
    recipients are third parties, so they get the ``_notice_`` templates, which
    are worded in the third person and name the employee.
    """
    routing_key = _EV_APPROVED_NOTICE if approved else _EV_REJECTED_NOTICE
    template_id = (
        "leave_request_approved_notice_v1"
        if approved
        else "leave_request_rejected_notice_v1"
    )
    await _publish(
        routing_key,
        template_id=template_id,
        to=recipient_email,
        template_data={
            "display_name": recipient_name,
            "employee_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "duration_days": _days(duration_hours),
            "request_id": request_id,
            "approver_name": approver_name,
            "comment": comment,
            "request_link": _approve_link(request_id),
        },
        idempotency_key=f"{routing_key}:{request_id}:{recipient_email}",
        tenant_id=tenant_id,
    )


async def publish_leave_escalation_to_hr(
    *,
    hr_email: str,
    hr_name: str,
    employee_name: str,
    leave_type_name: str,
    start_date: str,
    end_date: str,
    days_pending: int,
    request_id: str,
    tenant_id: str = "",
) -> None:
    """Notify an HR user that a pending leave request has gone past its
    approval SLA (skip_if_no_action_days) and awaits attention.

    Idempotency keys on (request_id, day-count, recipient) so a request that
    stays overdue across multiple cron runs only pings each HR user once per
    distinct day-count rather than every cycle.
    """
    await _publish(
        _EV_ESCALATED_HR,
        template_id="leave_request_escalated_hr_v1",
        to=hr_email,
        template_data={
            "display_name": hr_name,
            "employee_name": employee_name,
            "leave_type_name": leave_type_name,
            "start_date": start_date,
            "end_date": end_date,
            "days_pending": days_pending,
            "request_id": request_id,
            "approve_link": _approve_link(request_id),
        },
        idempotency_key=f"email.leave_escalated_hr:{request_id}:{days_pending}:{hr_email}",
        tenant_id=tenant_id,
    )


# ── Holiday Plan ──────────────────────────────────────────────────────────────

async def publish_holiday_plan_created(
    *,
    creator_email: str,
    creator_name: str,
    plan_name: str,
    year: int,
    plan_id: str,
    tenant_id: str = "",
) -> None:
    """Notify creator when a holiday plan is created."""
    await _publish(
        _EV_HOLIDAY_PLAN_CREATED,
        template_id="holiday_plan_created_v1",
        to=creator_email,
        template_data={
            "display_name": creator_name,
            "plan_name": plan_name,
            "year": year,
            "plan_id": plan_id,
        },
        idempotency_key=f"email.holiday_plan_created:{plan_id}:{creator_email}",
        tenant_id=tenant_id,
    )


async def publish_holiday_plan_updated(
    *,
    updater_email: str,
    updater_name: str,
    plan_name: str,
    year: int,
    plan_id: str,
    tenant_id: str = "",
) -> None:
    """Notify updater when a holiday plan is modified."""
    await _publish(
        _EV_HOLIDAY_PLAN_UPDATED,
        template_id="holiday_plan_updated_v1",
        to=updater_email,
        template_data={
            "display_name": updater_name,
            "plan_name": plan_name,
            "year": year,
            "plan_id": plan_id,
        },
        idempotency_key=f"email.holiday_plan_updated:{plan_id}:{updater_email}",
        tenant_id=tenant_id,
    )


async def publish_holiday_plan_employee_added(
    *,
    employee_email: str,
    employee_name: str,
    plan_name: str,
    plan_id: str,
    tenant_id: str = "",
) -> None:
    """Notify an employee when they are added to a holiday plan."""
    await _publish(
        _EV_HOLIDAY_PLAN_EMPLOYEE_ADDED,
        template_id="holiday_plan_employee_added_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "plan_name": plan_name,
            "plan_id": plan_id,
        },
        idempotency_key=f"email.holiday_plan_employee_added:{plan_id}:{employee_email}",
        tenant_id=tenant_id,
    )


async def publish_holiday_reminder(
    *,
    employee_email: str,
    employee_name: str,
    holiday_name: str,
    holiday_date: str,
    plan_name: str,
    tenant_id: str = "",
) -> None:
    """Remind an employee about an upcoming holiday (call from a scheduler)."""
    await _publish(
        _EV_HOLIDAY_REMINDER,
        template_id="holiday_reminder_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "holiday_name": holiday_name,
            "holiday_date": holiday_date,
            "plan_name": plan_name,
        },
        idempotency_key=f"email.holiday_reminder:{holiday_date}:{holiday_name}:{employee_email}",
        tenant_id=tenant_id,
    )


# ── Work Calendar ─────────────────────────────────────────────────────────────

async def publish_work_calendar_created(
    *,
    creator_email: str,
    creator_name: str,
    calendar_name: str,
    calendar_id: str,
    tenant_id: str = "",
) -> None:
    """Notify creator when a work calendar is created."""
    await _publish(
        _EV_WORK_CALENDAR_CREATED,
        template_id="work_calendar_created_v1",
        to=creator_email,
        template_data={
            "display_name": creator_name,
            "calendar_name": calendar_name,
            "calendar_id": calendar_id,
        },
        idempotency_key=f"email.work_calendar_created:{calendar_id}:{creator_email}",
        tenant_id=tenant_id,
    )


async def publish_work_calendar_updated(
    *,
    updater_email: str,
    updater_name: str,
    calendar_name: str,
    calendar_id: str,
    tenant_id: str = "",
) -> None:
    """Notify updater when a work calendar is modified."""
    await _publish(
        _EV_WORK_CALENDAR_UPDATED,
        template_id="work_calendar_updated_v1",
        to=updater_email,
        template_data={
            "display_name": updater_name,
            "calendar_name": calendar_name,
            "calendar_id": calendar_id,
        },
        idempotency_key=f"email.work_calendar_updated:{calendar_id}:{updater_email}",
        tenant_id=tenant_id,
    )


async def publish_work_calendar_employee_added(
    *,
    employee_email: str,
    employee_name: str,
    calendar_name: str,
    calendar_id: str,
    tenant_id: str = "",
) -> None:
    """Notify an employee when they are added to a work calendar."""
    await _publish(
        _EV_WORK_CALENDAR_EMPLOYEE_ADDED,
        template_id="work_calendar_employee_added_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "calendar_name": calendar_name,
            "calendar_id": calendar_id,
        },
        idempotency_key=f"email.work_calendar_employee_added:{calendar_id}:{employee_email}",
        tenant_id=tenant_id,
    )


# ── Shift ─────────────────────────────────────────────────────────────────────

async def publish_shift_employee_added(
    *,
    employee_email: str,
    employee_name: str,
    shift_name: str,
    shift_id: str,
    calendar_name: str,
    calendar_id: str,
    tenant_id: str = "",
) -> None:
    """Notify an employee when they are assigned (or moved) to a shift."""
    await _publish(
        _EV_SHIFT_EMPLOYEE_ADDED,
        template_id="shift_employee_added_v1",
        to=employee_email,
        template_data={
            "display_name": employee_name,
            "shift_name": shift_name,
            "calendar_name": calendar_name,
            "calendar_id": calendar_id,
        },
        idempotency_key=f"email.shift_employee_added:{calendar_id}:{shift_id}:{employee_email}",
        tenant_id=tenant_id,
    )
