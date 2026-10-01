"""One rule, in one place: nobody handles or approves their own request.

`assign_executor` has stated and enforced this since it was written —

    "Block assigning the ticket to the requester — they can never be the
     executor of their own ticket (conflict of interest: they'd approve
     their own resolution)."   (service_assign.py)

— but it enforced it at exactly one of the doors that installs a handler.
Escalation (both phases), reassignment and the SLA tick install one too, and
none of them checked. That let a requester be escalated into being the executor
of their own ticket and then resolve it, or — via the approval-phase branch,
which validates the target only for org membership — be made the
`escalation_override_approver_user_id` and approve it. Both
`_is_current_approver` and `require_current_approver` grant rights on that field
alone.

So the rule lives here and every door calls it. Two shapes, because the doors
differ: `is_requester` for the *target* being installed (the escalation and
reassign paths, and the SLA tick, which has no acting user at all), and
`deny_requester_actor` for the *caller* of an action reserved to the handler.

The actor form now covers assign and reassign as well. It used to be withheld
from them on this reasoning:

    A department head who raises a request is usually also its
    `primary_assignee_user_id`, so denying them there would leave their own
    tickets permanently unassignable — the routing decision is not self-dealing
    as long as the person they route it *to* is not themselves.

That held while the ticket's handler was one snapshotted person. Under the
category roster it no longer does: a category has several primaries, so a
primary who raises a ticket has peers who can route it, and a requester
choosing who handles their own ticket is a routing decision they should not be
making. Reported from the field — a primary raised a ticket and still held
Reassign on it.

The stranding risk it was guarding against is now narrow rather than gone, and
worth knowing:

  - Pending assignment: no deadlock. Any other roster member can still take the
    ticket with Assign-to-me (`can_self_assign` excludes only the requester),
    and if the requester is the *only* roster member the ticket was already
    unassignable — they could never have been its executor either.
  - Already assigned: a category whose only primary is the requester has no one
    left to reassign, since Assign-to-me does not apply past
    `pending_assignment`. Super admin remains the way out, as everywhere else.

Escalate is deliberately still exempt. Its target is validated by the target
form, the executor rather than the requester is normally the one escalating,
and nobody has reported the actor case there.
"""
from __future__ import annotations

from ...exceptions import Forbidden
from ...models import ServiceRequest


def is_requester(sr: ServiceRequest, user_id) -> bool:
    """True when `user_id` raised `sr`.

    Compares as strings so the caller can pass a `PydanticObjectId`, an
    `ObjectId` or the plain string form off a session without the comparison
    silently coming back False — the failure mode that would quietly reopen
    every hole this module exists to close.
    """
    if user_id is None:
        return False
    return str(sr.requester_user_id) == str(user_id)


def deny_requester_actor(sr: ServiceRequest, user, what: str) -> None:
    """Raise when the caller is acting as handler on their own ticket.

    `what` completes the sentence "The requester cannot {what} their own
    ticket" and is surfaced to the user, so phrase it as a verb.
    """
    if getattr(user, "is_super_admin", False):
        return
    if is_requester(sr, getattr(user, "oid", None)):
        raise Forbidden(f"The requester cannot {what} their own ticket")
