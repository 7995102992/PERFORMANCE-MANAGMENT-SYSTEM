"""Authorization dependencies — Foundation §10.

Two kinds of checks:

1. `require_permission(module, action)` — the IAM-owned policy gate. Reads
   `user.permissions` (from the session projection IAM wrote). Super admins
   bypass. See Q-001 for why this is re-implemented locally rather than
   imported from a shared package.

2. Ticket-scoped ownership guards — `require_requester`, `require_executor`,
   `require_primary_assignee`, `require_current_approver`, `require_ticket_access`.
   These read the ticket from Mongo and check the caller's relationship to it.
"""
from __future__ import annotations

from typing import Annotated, Callable

from fastapi import Depends, Path

from ...exceptions import (
    AlreadyDecided,
    Forbidden,
    NotCurrentApprover,
    NotExecutor,
    NotPrimaryAssignee,
    RequestTerminal,
)
from ...models import (
    ApprovalDecision,
    ApprovalLevel,
    Approver,
    ServiceRequest,
    TERMINAL_STATUSES,
)
from .dependencies import UserBase, get_current_user


def require_permission(module: str, action: str) -> Callable:
    """Returns a FastAPI dependency that validates `user.permissions`.

    Reads IAM's nested permission grid:
        permissions[module]["actions"][action] -> bool

    Super admin and org admin bypass.
    """
    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        if user.has_permission(module, action):
            return user
        raise Forbidden(f"Missing permission: {module}:{action}")

    return _dep


def require_org_admin() -> Callable:
    """Returns a FastAPI dependency that requires super admin or org admin.

    Use this for mutation endpoints that should be restricted to admins
    regardless of explicit permission grants.
    """
    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        raise Forbidden("Admin access required")

    return _dep


def require_any_permission(module: str, actions: list[str]) -> Callable:
    """FastAPI dependency that passes if the caller has ANY of `actions` on `module`."""
    async def _dep(
        user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if user.is_super_admin or user.is_org_admin:
            return user
        for action in actions:
            if user.has_permission(module, action):
                return user
        raise Forbidden(f"Missing any of permissions: {module}:{'|'.join(actions)}")

    return _dep


# ---------- Ticket loader ----------

async def _load_ticket(request_id: str) -> ServiceRequest:
    # Local import to avoid circular — exceptions module declares many helpers.
    from ...exceptions import DomainException
    ticket = await ServiceRequest.get(request_id)
    if ticket is None or ticket.deleted_on is not None:
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    return ticket


async def load_ticket(
    request_id: Annotated[str, Path(alias="id")],
) -> ServiceRequest:
    """Dependency that loads a ticket by path param `{id}`."""
    return await _load_ticket(request_id)


async def load_ticket_non_terminal(
    ticket: Annotated[ServiceRequest, Depends(load_ticket)],
) -> ServiceRequest:
    if ticket.request_status in TERMINAL_STATUSES:
        raise RequestTerminal()
    return ticket


# ---------- Ticket-scoped guards ----------

async def require_requester(
    ticket: Annotated[ServiceRequest, Depends(load_ticket)],
    user: Annotated[UserBase, Depends(get_current_user)],
) -> ServiceRequest:
    if user.is_super_admin or ticket.requester_user_id == user.oid:
        return ticket
    raise Forbidden("Caller is not the requester")


async def require_primary_assignee(
    ticket: Annotated[ServiceRequest, Depends(load_ticket)],
    user: Annotated[UserBase, Depends(get_current_user)],
) -> ServiceRequest:
    if user.is_super_admin or ticket.primary_assignee_user_id == user.oid:
        return ticket
    # This dependency really is the narrow check its name says — unlike
    # `reassign_executor`, which widened to primaries and managers — so keep the
    # narrow wording rather than inheriting the factory's broader default.
    raise NotPrimaryAssignee(
        "Only the ticket's primary assignee can do that."
    )


async def require_executor(
    ticket: Annotated[ServiceRequest, Depends(load_ticket)],
    user: Annotated[UserBase, Depends(get_current_user)],
) -> ServiceRequest:
    if user.is_super_admin or ticket.executor_user_id == user.oid:
        return ticket
    raise NotExecutor()


async def require_current_approver(
    ticket: Annotated[ServiceRequest, Depends(load_ticket_non_terminal)],
    user: Annotated[UserBase, Depends(get_current_user)],
) -> ServiceRequest:
    if user.is_super_admin:
        return ticket
    # The per-ticket escalation override (Q-109) replaces the current level's
    # approver list with a single user while keeping the workflow untouched.
    if ticket.escalation_override_approver_user_id == user.oid:
        # Still must not have decided already at this level.
        existing = await ApprovalDecision.find_one(
            {
                "service_request_id": ticket.id,
                "level_index": ticket.current_level_index,
                "approver_user_id": user.oid,
                "deleted_on": None,
            }
        )
        if existing is not None:
            raise AlreadyDecided()
        return ticket

    if ticket.current_level_index is None:
        raise NotCurrentApprover(
            "This ticket is not sitting at any approval level right now, so "
            "there is no decision to make on it. It may have been decided "
            "already and handed back to the executor."
        )

    # New approval model: L1/L2 are stored on the SR doc directly.
    snapshot_uid = (
        ticket.level_1_approver_user_id
        if ticket.current_level_index == 1
        else ticket.level_2_approver_user_id
        if ticket.current_level_index == 2
        else None
    )
    matched = False
    if snapshot_uid is not None:
        if snapshot_uid != user.oid:
            raise NotCurrentApprover(
                f"Level {ticket.current_level_index} approval on this ticket is "
                "assigned to a different approver, so only they can decide it. "
                "You may be seeing this ticket because you manage the person "
                "who raised it, which grants visibility but not the decision."
            )
        matched = True

    if not matched:
        # Legacy fallback: ticket was created before the IAM-driven model.
        level = await ApprovalLevel.find_one(
            {
                "workflow_id": ticket.workflow_id,
                "level_index": ticket.current_level_index,
                "deleted_on": None,
            }
        )
        if level is None:
            # Not a permission problem at all: the ticket points at a level its
            # workflow no longer defines, which happens when a workflow is
            # edited or deleted while a ticket is in flight. Nobody can approve
            # this — saying "you are not the approver" would send the caller
            # hunting for a colleague who does not exist.
            raise NotCurrentApprover(
                f"This ticket is waiting at approval level "
                f"{ticket.current_level_index}, but its workflow no longer "
                "defines that level — so there is no approver to decide it. "
                "The workflow was most likely changed after this ticket was "
                "raised. Ask an admin to restore the level or re-route the "
                "ticket."
            )
        approver = await Approver.find_one(
            {"approval_level_id": level.id, "approver_user_id": user.oid, "deleted_on": None}
        )
        if approver is None:
            raise NotCurrentApprover(
                f"You are not configured as an approver at level "
                f"{ticket.current_level_index} of this ticket's workflow, so "
                "you cannot decide it."
            )

    existing = await ApprovalDecision.find_one(
        {
            "service_request_id": ticket.id,
            "level_index": ticket.current_level_index,
            "approver_user_id": user.oid,
            "deleted_on": None,
        }
    )
    if existing is not None:
        raise AlreadyDecided()
    return ticket


async def require_ticket_access(
    ticket: Annotated[ServiceRequest, Depends(load_ticket)],
    user: Annotated[UserBase, Depends(get_current_user)],
) -> ServiceRequest:
    """Used for read endpoints — requester OR executor OR current approver OR
    dept manager for the category's dept (super admin bypasses)."""
    if user.is_super_admin:
        return ticket
    if ticket.requester_user_id == user.oid:
        return ticket
    if ticket.executor_user_id == user.oid:
        return ticket
    if ticket.primary_assignee_user_id == user.oid:
        return ticket
    # current approver?
    if ticket.current_level_index is not None:
        if ticket.escalation_override_approver_user_id == user.oid:
            return ticket
        snapshot_uid = (
            ticket.level_1_approver_user_id
            if ticket.current_level_index == 1
            else ticket.level_2_approver_user_id
            if ticket.current_level_index == 2
            else None
        )
        if snapshot_uid == user.oid:
            return ticket
        if snapshot_uid is None:
            # Legacy ticket — fall back to workflow-config lookup.
            level = await ApprovalLevel.find_one(
                {
                    "workflow_id": ticket.workflow_id,
                    "level_index": ticket.current_level_index,
                    "deleted_on": None,
                }
            )
            if level is not None:
                approver = await Approver.find_one(
                    {"approval_level_id": level.id, "approver_user_id": user.oid,
                     "deleted_on": None}
                )
                if approver is not None:
                    return ticket
    raise Forbidden("Caller cannot access this ticket")
