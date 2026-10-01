"""Exit management email events — published via the transactional outbox.

Trigger map:
  exit_request_raised        → manager, HR (org admins)
  exit_manager_approved      → employee, HR
  exit_manager_rejected      → employee, HR
  exit_clearances_initiated  → employee, manager
  exit_clearances_assigned   → clearance team (IT/admin/finance org admins), HR
  exit_completed             → employee, manager, HR
"""

from datetime import datetime, timezone
from uuid import uuid4

from beanie import PydanticObjectId
from beanie.operators import In

from src.auth.models import UserDocument
from src.correlation import get_correlation_id
from src.logger import logger
from src.models import ACCESS_STATUSES
from src.modules.organisation.models import EmployeeDocument
from src.rabbitmq import outbox
from src.rabbitmq.constants import email_events_config

# ── Routing keys ─────────────────────────────────────────────────────────────
_EV_RAISED = "email.exit_request_raised"
_EV_APPROVED = "email.exit_manager_approved"
_EV_REJECTED = "email.exit_manager_rejected"
_EV_CLEARANCES_INITIATED = "email.exit_clearances_initiated"
_EV_CLEARANCES_ASSIGNED = "email.exit_clearances_assigned"
_EV_COMPLETED = "email.exit_completed"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _envelope(event_type: str, tenant_id: str, payload: dict) -> dict:
    return {
        "task_type": "email.send",
        "event_id": str(uuid4()),
        "event_type": event_type,
        "correlation_id": get_correlation_id(),
        "idempotency_key": str(uuid4()),
        "tenant_id": tenant_id,
        "payload": payload,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }


async def _get_manager_email(emp: EmployeeDocument) -> tuple[str, str] | None:
    """Return (email, display_name) for the employee's l1 manager, or None."""
    if not emp.l1_manager_id:
        return None
    mgr_emp = await EmployeeDocument.get(emp.l1_manager_id)
    if not mgr_emp or not mgr_emp.user_id:
        return None
    mgr_user = await UserDocument.get(mgr_emp.user_id)
    if not mgr_user:
        return None
    return mgr_user.email, f"{mgr_user.first_name or ''} {mgr_user.last_name or ''}".strip()


async def _get_hr_recipients(org_id: PydanticObjectId) -> list[tuple[str, str]]:
    """Return [(email, display_name)] for active org admin users in this org."""
    users = await UserDocument.find(
        UserDocument.organisation_id == org_id,
        UserDocument.is_org_admin == True,
        In(UserDocument.status, list(ACCESS_STATUSES)),
    ).to_list()
    return [
        (u.email, f"{u.first_name or ''} {u.last_name or ''}".strip())
        for u in users
    ]


async def _send(
    event_type: str,
    template_id: str,
    recipients: list[tuple[str, str]],
    template_data: dict,
    idempotency_prefix: str,
    tenant_id: str,
) -> None:
    """Publish one outbox event per recipient. Errors are logged, not raised."""
    for email, display_name in recipients:
        if not email:
            continue
        data = {**template_data, "display_name": display_name}
        try:
            await outbox.publish(
                event_type,
                _envelope(event_type, tenant_id, {"to": email, "template_id": template_id, "template_data": data}),
                idempotency_key=f"{idempotency_prefix}:{email}",
                exchange=email_events_config.EXCHANGE_NAME,
            )
        except Exception as exc:
            logger.warning("Failed to publish exit email", event_type=event_type, to=email, error=repr(exc))


# ── Public publish functions ──────────────────────────────────────────────────

async def publish_exit_request_raised(
    request_code: str,
    request_id: str,
    employee_name: str,
    last_working_day: str,
    reason: str,
    org_id: PydanticObjectId,
    emp: EmployeeDocument,
    tenant_id: str = "",
) -> None:
    """Notify manager + HR when an exit request is raised."""
    base_data = {
        "request_code": request_code,
        "request_id": request_id,
        "employee_name": employee_name,
        "last_working_day": last_working_day,
        "reason": reason,
    }
    recipients: list[tuple[str, str]] = []

    mgr = await _get_manager_email(emp)
    if mgr:
        recipients.append(mgr)

    hr_list = await _get_hr_recipients(org_id)
    recipients.extend(hr_list)

    await _send(
        _EV_RAISED, "exit_request_raised_v1",
        recipients, base_data,
        f"email.exit_raised:{request_id}",
        tenant_id,
    )


async def publish_exit_manager_approved(
    request_code: str,
    request_id: str,
    employee_name: str,
    employee_email: str,
    last_working_day: str,
    manager_name: str,
    org_id: PydanticObjectId,
    tenant_id: str = "",
) -> None:
    """Notify employee + HR when a manager approves an exit request."""
    base_data = {
        "request_code": request_code,
        "request_id": request_id,
        "employee_name": employee_name,
        "last_working_day": last_working_day,
        "manager_name": manager_name,
    }
    recipients: list[tuple[str, str]] = [(employee_email, employee_name)]
    hr_list = await _get_hr_recipients(org_id)
    recipients.extend(hr_list)

    await _send(
        _EV_APPROVED, "exit_manager_approved_v1",
        recipients, base_data,
        f"email.exit_approved:{request_id}",
        tenant_id,
    )


async def publish_exit_manager_rejected(
    request_code: str,
    request_id: str,
    employee_name: str,
    employee_email: str,
    rejection_reason: str,
    manager_name: str,
    org_id: PydanticObjectId,
    tenant_id: str = "",
) -> None:
    """Notify employee + HR when a manager rejects an exit request."""
    base_data = {
        "request_code": request_code,
        "request_id": request_id,
        "employee_name": employee_name,
        "rejection_reason": rejection_reason,
        "manager_name": manager_name,
    }
    recipients: list[tuple[str, str]] = [(employee_email, employee_name)]
    hr_list = await _get_hr_recipients(org_id)
    recipients.extend(hr_list)

    await _send(
        _EV_REJECTED, "exit_manager_rejected_v1",
        recipients, base_data,
        f"email.exit_rejected:{request_id}",
        tenant_id,
    )


async def publish_exit_clearances_initiated(
    request_code: str,
    request_id: str,
    employee_name: str,
    employee_email: str,
    last_working_day: str,
    org_id: PydanticObjectId,
    emp: EmployeeDocument,
    tenant_id: str = "",
) -> None:
    """Notify employee + manager that clearances have been initiated by HR."""
    base_data = {
        "request_code": request_code,
        "request_id": request_id,
        "employee_name": employee_name,
        "last_working_day": last_working_day,
    }
    recipients: list[tuple[str, str]] = [(employee_email, employee_name)]

    mgr = await _get_manager_email(emp)
    if mgr:
        recipients.append(mgr)

    await _send(
        _EV_CLEARANCES_INITIATED, "exit_clearances_initiated_v1",
        recipients, base_data,
        f"email.exit_clearances_initiated:{request_id}",
        tenant_id,
    )


async def publish_exit_clearances_assigned(
    request_code: str,
    request_id: str,
    employee_name: str,
    last_working_day: str,
    org_id: PydanticObjectId,
    tenant_id: str = "",
) -> None:
    """Notify clearance team (org admins) + HR that clearance tasks are assigned."""
    base_data = {
        "request_code": request_code,
        "request_id": request_id,
        "employee_name": employee_name,
        "last_working_day": last_working_day,
    }
    hr_list = await _get_hr_recipients(org_id)

    await _send(
        _EV_CLEARANCES_ASSIGNED, "exit_clearances_assigned_v1",
        hr_list, base_data,
        f"email.exit_clearances_assigned:{request_id}",
        tenant_id,
    )


async def publish_exit_completed(
    request_code: str,
    request_id: str,
    employee_name: str,
    employee_email: str,
    last_working_day: str,
    org_id: PydanticObjectId,
    emp: EmployeeDocument,
    tenant_id: str = "",
) -> None:
    """Notify employee + manager + HR when all clearances are complete."""
    base_data = {
        "request_code": request_code,
        "request_id": request_id,
        "employee_name": employee_name,
        "last_working_day": last_working_day,
    }
    recipients: list[tuple[str, str]] = [(employee_email, employee_name)]

    mgr = await _get_manager_email(emp)
    if mgr:
        recipients.append(mgr)

    hr_list = await _get_hr_recipients(org_id)
    recipients.extend(hr_list)

    await _send(
        _EV_COMPLETED, "exit_completed_v1",
        recipients, base_data,
        f"email.exit_completed:{request_id}",
        tenant_id,
    )
