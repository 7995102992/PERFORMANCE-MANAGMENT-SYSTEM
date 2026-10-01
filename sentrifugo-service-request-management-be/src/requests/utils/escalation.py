"""Escalation helper — shared between manual (Ch 7) and SLA-tick (Ch 8) paths.

Foundation §9 says escalation is a *side-transition*: `is_escalated=true`,
`escalation_count += 1`, executor/approver replaced, status UNCHANGED.

Chapter 7 adds `escalation_override_approver_user_id` for approval-phase
escalation (Q-109). Chapter 8 drives SLA-triggered reassign via the same
function.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ...models import ServiceRequest, RequestStatusEnum


async def apply_escalation(
    ticket: ServiceRequest,
    *,
    new_executor_user_id: str | None = None,
    new_approval_override_user_id: str | None = None,
    actor_user_id: str,
) -> ServiceRequest:
    """Apply a side-transition escalation. Status is NOT changed."""
    ticket.is_escalated = True
    ticket.escalation_count += 1
    now = datetime.now(timezone.utc)
    ticket.escalated_at = now
    ticket.modified_by = actor_user_id
    ticket.modified_on = now

    if ticket.request_status == RequestStatusEnum.PENDING_APPROVAL:
        if new_approval_override_user_id:
            ticket.escalation_override_approver_user_id = new_approval_override_user_id
    elif ticket.request_status in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS):
        if new_executor_user_id:
            ticket.executor_user_id = new_executor_user_id

    await ticket.save()
    return ticket
