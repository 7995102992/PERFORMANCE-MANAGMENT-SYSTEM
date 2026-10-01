"""Reopening a closed timesheet month for one employee.

Once the monthly payroll cutoff passes, the days before it are frozen. A manager who
needs late time from someone on their team reopens that month for that person;
removing the override closes it again.

Granted per employee and month, because that is the unit a person actually fixes —
but it only lifts the cutoff on the granting manager's own projects. A manager can
invite late time onto work they are accountable for; they cannot reopen someone
else's books by reopening their own. Two managers can each grant for the same month
and each close their own again.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from beanie import PydanticObjectId
from bson import ObjectId

from ..audit import emit_activity, emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.access import is_admin
from ..common.timestamps import utcnow
from ..common.user_resolver import resolve_user_names
from ..exceptions import Forbidden, TimesheetNotFound
from ..models import PastSubmissionOverride

logger = logging.getLogger(__name__)

# How long a reopen stays open before closing itself. Long enough for someone to
# find the time and file it, short enough that a forgotten exception does not quietly
# become the rule.
REOPEN_WINDOW = timedelta(days=7)


def _to_out(doc: PastSubmissionOverride, user_name: str | None = None,
            created_by_name: str | None = None) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "user_id": str(doc.user_id),
        "user_name": user_name,
        "year": doc.year,
        "month": doc.month,
        "project_ids": [str(p) for p in doc.project_ids],
        "expires_at": doc.expires_at,
        "reason": doc.reason,
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_by_name": created_by_name,
        "created_on": doc.created_on,
    }


async def _assert_may_reopen_for(
    target_user_id: str, user: UserBase,
) -> tuple[PydanticObjectId, list[PydanticObjectId]]:
    """The employee, and the projects this user may reopen the month on.

    Allowed for admins, and for the manager who approves that employee's timesheets —
    the same team the Team Timesheets list is built from, so the reopen affordance
    appears exactly where the person can already act.

    Deliberately *not* extended to the reporting-line view: that team is assembled
    separately and is read-only, so a watcher cannot reopen a month they could not
    approve.

    Returns:
        ``(user_id, project_ids)`` — the granter's approver scope, or an empty list
        for an admin, meaning unrestricted.

    Raises:
        TimesheetNotFound: the id is unusable.
        Forbidden: a real employee, but not this manager's to act on.
    """
    if not ObjectId.is_valid(target_user_id):
        raise TimesheetNotFound()

    if is_admin(user):
        return PydanticObjectId(target_user_id), []

    from ..approvals.service import _get_manager_visible_scope, _get_team_user_ids
    team = await _get_team_user_ids(user)
    if target_user_id not in {str(uid) for uid in team}:
        raise Forbidden("Only this employee's manager can reopen a closed month")

    project_level, task_level = await _get_manager_visible_scope(user)
    scope = [
        PydanticObjectId(pid) for pid in (project_level | set(task_level.keys()))
        if ObjectId.is_valid(pid)
    ]
    if not scope:
        raise Forbidden("You have no projects to reopen this month for")
    return PydanticObjectId(target_user_id), scope


async def list_overrides(target_user_id: str, user: UserBase) -> list[dict[str, Any]]:
    """Months currently reopened for this employee, by any manager.

    Only live grants: an expired one is not a state the employee can act on, and
    listing it would read as "still open" beside a month that has in fact closed.
    """
    uid, _ = await _assert_may_reopen_for(target_user_id, user)
    docs = await PastSubmissionOverride.find({
        "user_id": uid,
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "expires_at": {"$gt": utcnow()},
    }).sort("-year", "-month").to_list()

    names = await resolve_user_names(
        [uid] + [d.created_by for d in docs if d.created_by], user.organisation_id,
    )
    return [_to_out(d, names.get(uid), names.get(d.created_by)) for d in docs]


async def open_month(target_user_id: str, body, user: UserBase) -> dict[str, Any]:
    """Reopen ``year``/``month`` for the employee, on this manager's own projects.

    Open for a week, then it closes itself. Re-granting refreshes the window and the
    project snapshot rather than returning the old row, so a manager whose employee
    needs longer — or who has since picked up another project — simply reopens again.
    """
    uid, scope = await _assert_may_reopen_for(target_user_id, user)
    names = await resolve_user_names([uid], user.organisation_id)
    now = utcnow()
    expires_at = now + REOPEN_WINDOW

    # Matched without regard to expiry: an expired grant is this manager's row to
    # renew, not a second one to create alongside it.
    existing = await PastSubmissionOverride.find_one({
        "user_id": uid,
        "year": body.year,
        "month": body.month,
        "created_by": user.id,
        "deleted_on": None,
    })
    if existing:
        existing.project_ids = scope
        existing.expires_at = expires_at
        existing.reason = body.reason or existing.reason
        existing.modified_by = user.id
        existing.modified_on = now
        await existing.save()
        return _to_out(existing, names.get(uid))

    doc = PastSubmissionOverride(
        organisation_id=user.organisation_id,
        user_id=uid,
        year=body.year,
        month=body.month,
        project_ids=scope,
        expires_at=expires_at,
        reason=body.reason,
        created_by=user.id,
        created_on=now,
    )
    await doc.insert()

    # Reopening a closed payroll month is a control the auditors care about, and the
    # team needs to see it — both streams, like other assignment-shaped actions.
    details = {
        "user_id": str(uid),
        "user_name": names.get(uid),
        "period": f"{body.year:04d}-{body.month:02d}",
        "reason": body.reason,
    }
    await emit_activity(
        action="past_submission.opened",
        resource=f"past_submission_override:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=details,
    )
    await emit_audit(
        action="past_submission.opened",
        resource=f"past_submission_override:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=details,
    )
    return _to_out(doc, names.get(uid))


async def close_month(target_user_id: str, year: int, month: int, user: UserBase) -> None:
    """Close the month again by removing this manager's own override.

    Another manager's grant for the same month is left alone — they opened their
    projects, not yours, and closing yours must not revoke theirs.
    """
    uid, _ = await _assert_may_reopen_for(target_user_id, user)

    doc = await PastSubmissionOverride.find_one({
        "user_id": uid,
        "year": year,
        "month": month,
        "created_by": user.id,
        "deleted_on": None,
    })
    if not doc:
        return

    now = utcnow()
    doc.deleted_on = now
    doc.deleted_by = user.id
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    details = {
        "user_id": str(uid),
        "period": f"{year:04d}-{month:02d}",
    }
    await emit_activity(
        action="past_submission.closed",
        resource=f"past_submission_override:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=details,
    )
    await emit_audit(
        action="past_submission.closed",
        resource=f"past_submission_override:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=details,
    )


async def can_reopen_month(user: UserBase, target_user_id: str, year: int, month: int) -> bool:
    """Whether this caller could reopen ``year``/``month`` for this employee.

    Both halves of the question the UI would otherwise have to guess at:

    * is there anything to reopen — has the cutoff actually closed that month;
    * would the call be allowed — do they manage this employee, and do they have a
      project to grant against.

    Entitlement is answered by ``_assert_may_reopen_for``, the same function the POST
    goes through, so the button and the endpoint cannot disagree about who may act.

    Says nothing about whether a grant already exists: that is what the listing is
    for, and conflating "may reopen" with "is currently open" would leave the caller
    unable to tell a closed month from an already-open one.
    """
    try:
        await _assert_may_reopen_for(target_user_id, user)
    except (Forbidden, TimesheetNotFound):
        return False

    from datetime import date

    from ..common.cutoff import current_cutoff_boundary
    from ..settings.service import get_effective_settings

    settings = await get_effective_settings(user.organisation_id)
    if not settings or not settings.past_submission_cutoff_enabled:
        return False  # nothing is closed, so there is nothing to reopen

    boundary = current_cutoff_boundary(
        utcnow().replace(tzinfo=None).date(), settings.past_submission_cutoff_day,
    )
    # The month has something to reopen once any of its days is settled.
    return date(year, month, 1) <= boundary


async def reopened_project_ids(user_id, year: int, month: int) -> set | None:
    """Projects this employee may still write to in a closed month.

    The union across every *unexpired* grant for that month, since two managers may
    each have reopened their own projects. A grant past its week is ignored here
    rather than deleted, so the audit trail keeps it.

    Returns:
        None when nothing is reopened, an empty set never — an admin's unrestricted
        grant returns the sentinel ``ALL_PROJECTS``.
    """
    docs = await PastSubmissionOverride.find({
        "user_id": user_id,
        "year": year,
        "month": month,
        "deleted_on": None,
        "expires_at": {"$gt": utcnow()},
    }).to_list()
    if not docs:
        return None
    if any(not d.project_ids for d in docs):
        return ALL_PROJECTS
    return {str(p) for d in docs for p in d.project_ids}


class _AllProjects(frozenset):
    """A set that contains everything — an admin's unrestricted reopen."""

    def __contains__(self, _item) -> bool:  # noqa: D105
        return True


ALL_PROJECTS = _AllProjects()
