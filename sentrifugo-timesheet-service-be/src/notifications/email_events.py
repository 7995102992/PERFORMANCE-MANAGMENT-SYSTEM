"""Publish timesheet email events via the transactional outbox.

Routes through ``src.rabbitmq.outbox`` so email events survive a RabbitMQ
outage — the relay will forward them once the broker is back up.

The schedule-service consumes these events from the ``email_events``
exchange, renders HTML templates, and delivers via the configured provider.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from src.config import settings
from src.rabbitmq import outbox
from src.rabbitmq.constants import email_events_config

SUBMITTED_ROUTING_KEY = "email.timesheet_submitted"
RESUBMITTED_ROUTING_KEY = "email.timesheet_resubmitted"
APPROVED_ROUTING_KEY = "email.timesheet_approved"
REJECTED_ROUTING_KEY = "email.timesheet_rejected"
BUDGET_ALERT_ROUTING_KEY = "email.budget_threshold_alert"
CLIENT_REVIEW_REQUEST_ROUTING_KEY = "email.client_review_request"
EMPLOYEE_REMINDER_ROUTING_KEY = "email.employee_timesheet_reminder"


def _build_task_envelope(
    event_type: str,
    tenant_id: str,
    payload: dict,
) -> dict:
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


async def publish_timesheet_submitted_email(
    *,
    to: str,
    employee_name: str,
    week_start: str,
    week_end: str,
    total_hours: float,
    project_names: str,
    timesheet_id: str,
    tenant_id: str = "",
) -> None:
    # Team Timesheets list; ?timesheet= opens that week's detail sheet directly.
    review_link = f"{settings.FRONTEND_URL}/timesheet/employee-timesheets?timesheet={timesheet_id}"

    envelope = _build_task_envelope(
        SUBMITTED_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "timesheet_submitted_v1",
            "template_data": {
                "employee_name": employee_name,
                "week_start": week_start,
                "week_end": week_end,
                "total_hours": total_hours,
                "project_names": project_names,
                "review_link": review_link,
            },
        },
    )

    await outbox.publish(
        SUBMITTED_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.ts_submitted:{timesheet_id}:{to}:{week_start}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_timesheet_resubmitted_email(
    *,
    to: str,
    employee_name: str,
    week_start: str,
    week_end: str,
    total_hours: float,
    project_names: str,
    timesheet_id: str,
    tenant_id: str = "",
) -> None:
    # Team Timesheets list; ?timesheet= opens that week's detail sheet directly.
    review_link = f"{settings.FRONTEND_URL}/timesheet/employee-timesheets?timesheet={timesheet_id}"

    envelope = _build_task_envelope(
        RESUBMITTED_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "timesheet_resubmitted_v1",
            "template_data": {
                "employee_name": employee_name,
                "week_start": week_start,
                "week_end": week_end,
                "total_hours": total_hours,
                "project_names": project_names,
                "review_link": review_link,
            },
        },
    )

    await outbox.publish(
        RESUBMITTED_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.ts_resubmitted:{timesheet_id}:{to}:{week_start}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_timesheet_updated_email(
    *,
    to: str,
    employee_name: str,
    week_start: str,
    week_end: str,
    total_hours: float,
    project_names: str,
    timesheet_id: str,
    updated_at: str,
    tenant_id: str = "",
) -> None:
    """Tell an approver that a week they have yet to act on has changed.

    Deliberately rides the submission event type and template: both are the mail
    service's contract, and reusing them means this needs no binding or template
    registered over there. Only the idempotency key differs — the outbox dedupes on
    it with a permanent unique index, so sharing the submission key would silently
    swallow every edit after the first mail.

    Args:
        updated_at: The timesheet's modification timestamp. It makes each distinct
            edit send exactly once while a retry of the same edit still dedupes.
    """
    # Team Timesheets list; ?timesheet= opens that week's detail sheet directly.
    review_link = f"{settings.FRONTEND_URL}/timesheet/employee-timesheets?timesheet={timesheet_id}"

    envelope = _build_task_envelope(
        SUBMITTED_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "timesheet_submitted_v1",
            "template_data": {
                "employee_name": employee_name,
                "week_start": week_start,
                "week_end": week_end,
                "total_hours": total_hours,
                "project_names": project_names,
                "review_link": review_link,
            },
        },
    )

    await outbox.publish(
        SUBMITTED_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.ts_updated:{timesheet_id}:{to}:{week_start}:{updated_at}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_timesheet_approved_email(
    *,
    to: str,
    employee_name: str,
    approver_name: str,
    approval_level: str,
    week_start: str,
    week_end: str,
    total_hours: float,
    timesheet_id: str,
    view_link: str = "",
    tenant_id: str = "",
) -> None:
    if not view_link:
        view_link = f"{settings.FRONTEND_URL}/timesheet/my-timesheet/entry?week={week_start}"

    envelope = _build_task_envelope(
        APPROVED_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "timesheet_approved_v1",
            "template_data": {
                "employee_name": employee_name,
                "approver_name": approver_name,
                "approval_level": approval_level,
                "week_start": week_start,
                "week_end": week_end,
                "total_hours": total_hours,
                "view_link": view_link,
            },
        },
    )

    await outbox.publish(
        APPROVED_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.ts_approved:{timesheet_id}:{approval_level}:{to}:{int(datetime.now(timezone.utc).timestamp())}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_timesheet_rejected_email(
    *,
    to: str,
    employee_name: str,
    approver_name: str,
    rejection_level: str,
    comments: str,
    week_start: str,
    week_end: str,
    timesheet_id: str,
    edit_link: str = "",
    button_label: str = "Edit & Resubmit",
    tenant_id: str = "",
) -> None:
    if not edit_link:
        edit_link = f"{settings.FRONTEND_URL}/timesheet/my-timesheet/entry?week={week_start}"

    envelope = _build_task_envelope(
        REJECTED_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "timesheet_rejected_v1",
            "template_data": {
                "employee_name": employee_name,
                "approver_name": approver_name,
                "rejection_level": rejection_level,
                "comments": comments,
                "week_start": week_start,
                "week_end": week_end,
                "edit_link": edit_link,
                "button_label": button_label,
            },
        },
    )

    await outbox.publish(
        REJECTED_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.ts_rejected:{timesheet_id}:{rejection_level}:{to}:{int(datetime.now(timezone.utc).timestamp())}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_budget_threshold_email(
    *,
    to: str,
    project_name: str,
    budget_label: str,
    used_label: str,
    budget_percent: float,
    threshold_percent: int,
    currency: str,
    project_id: str,
    tenant_id: str = "",
) -> None:
    envelope = _build_task_envelope(
        BUDGET_ALERT_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "budget_threshold_alert_v1",
            "template_data": {
                "project_name": project_name,
                "budget_label": budget_label,    # e.g. "USD 50,000.00" or "400 hrs"
                "used_label": used_label,         # e.g. "USD 42,000.00" or "340 hrs"
                "budget_percent": budget_percent,
                "threshold_percent": threshold_percent,
                "currency": currency,
                "project_link": f"{settings.FRONTEND_URL}/projects/{project_id}",
            },
        },
    )

    # Re-alert per 10 % bracket so repeated approvals don't flood inboxes
    bracket = (int(budget_percent) // 10) * 10
    await outbox.publish(
        BUDGET_ALERT_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.budget_alert:{project_id}:{bracket}:{to}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_client_review_request_email(
    *,
    to: str,
    week_range: str,
    employee_rows: str,       # pre-rendered <tr>...</tr> HTML for all employees
    grand_total_row: str,     # pre-rendered grand total <tr> HTML
    grand_total_hours: float,
    approve_all_link: str,
    reject_all_link: str,
    timesheet_count: int,
    idempotency_suffix: str,
    tenant_id: str = "",
) -> None:
    envelope = _build_task_envelope(
        CLIENT_REVIEW_REQUEST_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "client_review_request_v1",
            "template_data": {
                "week_range": week_range,
                "employee_rows": employee_rows,
                "grand_total_row": grand_total_row,
                "grand_total_hours": grand_total_hours,
                "approve_all_link": approve_all_link,
                "reject_all_link": reject_all_link,
                "timesheet_count": timesheet_count,
            },
        },
    )
    await outbox.publish(
        CLIENT_REVIEW_REQUEST_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.client_review:{idempotency_suffix}:{to}",
        exchange=email_events_config.EXCHANGE_NAME,
    )


async def publish_employee_timesheet_reminder_email(
    *,
    to: str,
    employee_name: str,
    week_start: str,
    week_end: str,
    fill_link: str,
    idempotency_suffix: str,
    tenant_id: str = "",
) -> None:
    envelope = _build_task_envelope(
        EMPLOYEE_REMINDER_ROUTING_KEY,
        tenant_id,
        {
            "to": to,
            "template_id": "employee_timesheet_reminder_v1",
            "template_data": {
                "employee_name": employee_name,
                "week_start": week_start,
                "week_end": week_end,
                "fill_link": fill_link,
            },
        },
    )
    await outbox.publish(
        EMPLOYEE_REMINDER_ROUTING_KEY,
        envelope,
        idempotency_key=f"email.emp_reminder:{idempotency_suffix}:{to}",
        exchange=email_events_config.EXCHANGE_NAME,
    )
