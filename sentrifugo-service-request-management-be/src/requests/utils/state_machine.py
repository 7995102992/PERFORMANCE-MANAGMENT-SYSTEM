"""State machine guard tables — Foundation §9.

The per-endpoint transitions land in Chapter 6/7/8 service layers; this
module centralises the allowed-source-statuses tables + a helper to raise
`INVALID_STATE_TRANSITION` when violated.
"""
from __future__ import annotations

from ...exceptions import InvalidStateTransition, RequestTerminal
from ...models import RequestStatusEnum as S, TERMINAL_STATUSES


# Allowed source statuses per transition. A transition is allowed if the
# ticket's current status is in this set.
APPROVE_REJECT_FROM: frozenset[S] = frozenset({S.PENDING_APPROVAL})
ASSIGN_FROM: frozenset[S] = frozenset({S.PENDING_ASSIGNMENT})
REASSIGN_FROM: frozenset[S] = frozenset({S.ASSIGNED, S.IN_PROGRESS})
FIRST_RESPONSE_FROM: frozenset[S] = frozenset({S.ASSIGNED})
RESOLVE_FROM: frozenset[S] = frozenset({S.ASSIGNED, S.IN_PROGRESS})
CLOSE_FROM: frozenset[S] = frozenset({S.RESOLVED})
ESCALATE_FROM: frozenset[S] = frozenset(
    {S.PENDING_APPROVAL, S.ASSIGNED, S.IN_PROGRESS}
)
# Executor-triggered approval flow: the executor pushes their assigned
# ticket into PENDING_APPROVAL when they need a sign-off.
SUBMIT_FOR_APPROVAL_FROM: frozenset[S] = frozenset({S.ASSIGNED, S.IN_PROGRESS})
# Requester pulls a ticket back before anyone starts work. Single source of
# truth: service_actions.withdraw enforces it and compute_capabilities reports
# it as `can_withdraw`, so the FE never has to keep its own copy of this set.
WITHDRAW_FROM: frozenset[S] = frozenset(
    {S.SUBMITTED, S.PENDING_APPROVAL, S.PENDING_ASSIGNMENT}
)


# Status → the phrase that reads naturally after "the ticket is ...". Lives
# here because the enum does, and because every InvalidStateTransition message
# needs to name the status the caller is actually looking at — the one fact the
# old blanket "Action not allowed from current status" left out.
_STATUS_PHRASE: dict[S, str] = {
    S.SUBMITTED: "still awaiting approval routing",
    S.PENDING_APPROVAL: "waiting on an approval decision",
    S.REJECTED: "rejected",
    S.PENDING_ASSIGNMENT: "not assigned to anyone yet",
    S.ASSIGNED: "assigned but not started",
    S.IN_PROGRESS: "in progress",
    S.RESOLVED: "already resolved",
    S.CLOSED: "closed",
    S.WITHDRAWN: "withdrawn by the requester",
}


def status_phrase(status: S | None) -> str:
    """Readable form of a ticket status, for error messages."""
    if status is None:
        return "in an unknown state"
    return _STATUS_PHRASE.get(status, str(status).replace("_", " "))


def assert_transition(current: S, allowed: frozenset[S]) -> None:
    if current in TERMINAL_STATUSES:
        raise RequestTerminal()
    if current not in allowed:
        # Name what the ticket actually is and what would have been acceptable.
        # This helper backs several endpoints, so it cannot say which action was
        # attempted — the caller knows that; what it could never see is the
        # status, which is exactly what the old bare raise withheld.
        wanted = ", ".join(sorted(status_phrase(s) for s in allowed))
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(current)}, so that action is not "
            f"available. It would need to be: {wanted}."
        )
