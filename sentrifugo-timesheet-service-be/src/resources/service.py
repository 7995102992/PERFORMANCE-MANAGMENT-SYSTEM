from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from ..audit import emit_activity, emit_audit
from ..auth.utils.dependencies import UserBase
from ..rabbitmq import outbox
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow
from ..common.user_resolver import resolve_emp_codes, resolve_user_names, user_belongs_to_organisation
from ..exceptions import EmployeeNotInOrganisation, ProjectNotFound, ResourceAlreadyAssigned, ResourceAssignmentNotFound, ResourceReleased, TaskNotAvailableForProject
from ..models import Project, ProjectTask, ResourceAssignment, StatusEnum, TimesheetEntry, WeeklyTimesheet
from .schemas import ResourceAssignmentCreate, ResourceAssignmentUpdate

logger = logging.getLogger(__name__)


def _allocation_status(doc: ResourceAssignment) -> str:
    """How the allocation reads in a list.

    ``removed``  — released and its end date has passed; nothing more can be logged.
    ``ending``   — released, but still accepting time until the end date.
    ``allocated`` — a live allocation.
    """
    if not doc.released_on:
        return "allocated"
    if doc.end_date and doc.end_date.replace(tzinfo=None).date() >= utcnow().date():
        return "ending"
    return "removed"


def _to_out(doc: ResourceAssignment) -> dict[str, Any]:
    return {
        "_id": str(doc.id),
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "project_id": str(doc.project_id),
        "task_id": str(doc.task_id) if doc.task_id is not None else None,
        "user_id": str(doc.user_id),
        "role": doc.role,
        "allocation_percentage": doc.allocation_percentage,
        "billable_rate": doc.billable_rate,
        "is_billable": doc.is_billable,
        "start_date": doc.start_date,
        "end_date": doc.end_date,
        "status": doc.status,
        "allocation_status": _allocation_status(doc),
        "released_on": doc.released_on,
        "removal_comment": doc.removal_comment,
        "removal_history": doc.removal_history,
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_on": doc.created_on,
        "modified_by": str(doc.modified_by) if doc.modified_by else None,
        "modified_on": doc.modified_on,
    }


async def _assert_tasks_in_project(proj_oid: Any, task_oids: list[Any]) -> None:
    """Every task must be actively linked to the project before anyone is put on it."""
    for task_oid in task_oids:
        pt = await ProjectTask.find_one({
            "project_id": proj_oid, "task_id": task_oid,
            "deleted_on": None, "is_active": True,
        })
        if not pt:
            raise TaskNotAvailableForProject()


async def _active_assignments(proj_oid: Any, user_oid: Any) -> list[ResourceAssignment]:
    """The employee's live assignments on a project — project-level row and task rows."""
    return await ResourceAssignment.find({
        "project_id": proj_oid,
        "user_id": user_oid,
        "deleted_on": None,
        "status": StatusEnum.ACTIVE.value,
    }).to_list()


async def _earliest_entry_date(proj_oid: Any, user_oid: Any, organisation_id: Any) -> datetime | None:
    """The first date this employee logged time on this project.

    Used to complete an open-ended allocation when it closes: a released assignment
    with no start date has no window at all, which makes it useless for reporting.
    Entries carry no user, so the lookup goes through the employee's weekly
    timesheets. Returns None when they never logged anything on the project.
    """
    timesheets = await WeeklyTimesheet.find({
        "user_id": user_oid,
        "organisation_id": organisation_id,
        "deleted_on": None,
    }).to_list()
    if not timesheets:
        return None

    oldest = await TimesheetEntry.find({
        "weekly_timesheet_id": {"$in": [t.id for t in timesheets]},
        "project_id": proj_oid,
        "deleted_on": None,
    }).sort("+entry_date").first_or_none()
    return oldest.entry_date if oldest else None


def _deactivate(ra: ResourceAssignment, user: UserBase, now: datetime) -> None:
    """Soft-remove an assignment as a side effect of an edit.

    Unlike ``delete_resource`` this records no removal note: the manager did not
    remove a person, they narrowed a task selection.
    """
    ra.deleted_on = now
    ra.deleted_by = user.id
    ra.status = StatusEnum.INACTIVE
    ra.modified_by = user.id
    ra.modified_on = now


async def _upsert_assignment(
    proj_oid: Any,
    task_oid: Any | None,
    user_oid: Any,
    fields: dict[str, Any],
    user: UserBase,
    now: datetime,
) -> ResourceAssignment:
    """Create the (project, task, employee) assignment, or revive a removed one.

    Reviving keeps the original document so its ``removal_history`` survives a
    remove/re-add cycle; the active ``removal_comment`` is cleared.
    """
    prior = (
        await ResourceAssignment.find({
            "project_id": proj_oid, "task_id": task_oid, "user_id": user_oid,
            "deleted_on": {"$ne": None},
        }).sort("-deleted_on").first_or_none()
    )
    if not prior:
        # A released row is still live, so it is reopened rather than duplicated.
        prior = await ResourceAssignment.find_one({
            "project_id": proj_oid, "task_id": task_oid, "user_id": user_oid,
            "deleted_on": None, "released_on": {"$ne": None},
        })

    if prior:
        doc = prior
        for field, value in fields.items():
            setattr(doc, field, value)
        doc.status = StatusEnum.ACTIVE
        doc.deleted_on = None
        doc.deleted_by = None
        doc.released_on = None
        doc.removal_comment = None
        doc.modified_by = user.id
        doc.modified_on = now
        await doc.save()
        return doc

    doc = ResourceAssignment(
        organisation_id=user.organisation_id,
        project_id=proj_oid,
        task_id=task_oid,
        user_id=user_oid,
        status=StatusEnum.ACTIVE,
        created_by=user.id,
        created_on=now,
        **fields,
    )
    await doc.insert()
    return doc


async def _emit_assignment_event(action: str, doc: ResourceAssignment, user: UserBase, **extra: Any) -> None:
    """Assignment ops go to both streams: activity feed + compliance audit."""
    details = {
        "user_id": str(doc.user_id),
        "task_id": str(doc.task_id) if doc.task_id is not None else None,
        **extra,
    }
    for emit in (emit_activity, emit_audit):
        await emit(
            action=action,
            resource=f"resource:{doc.id}",
            actor_id=str(user.id),
            organisation_id=str(user.organisation_id),
            details=details,
        )


async def create_resource(project_id: str, body: ResourceAssignmentCreate, user: UserBase) -> list[dict[str, Any]]:
    """Assign an employee to a project, either to specific tasks or to the whole project.

    Args:
        project_id: Project the employee is being added to.
        body: Assignment details; ``task_ids`` (or the legacy ``task_id``) selects
            the tasks, an empty selection means a project-level assignment.
        user: The acting manager / admin.

    Returns:
        Every live assignment the employee now holds on the project, one per task
        (a single entry with ``task_id: null`` for a project-level assignment).
    """
    from beanie import PydanticObjectId
    project = await Project.get(project_id)
    if not project or project.deleted_on or project.organisation_id != user.organisation_id:
        raise ProjectNotFound()

    # body.user_id comes straight from the request: only an IAM user of the
    # caller's own organisation may be assigned (fail closed otherwise).
    if not await user_belongs_to_organisation(body.user_id, user.organisation_id):
        raise EmployeeNotInOrganisation()

    proj_oid = PydanticObjectId(project_id)
    user_oid = PydanticObjectId(body.user_id)
    task_oids = [PydanticObjectId(t) for t in body.selected_task_ids()]
    await _assert_tasks_in_project(proj_oid, task_oids)

    current = await _active_assignments(proj_oid, user_oid)
    # Task-level and project-level assignments are mutually exclusive: the new
    # selection replaces whichever form the employee currently holds.
    targets: list[Any | None] = list(task_oids) if task_oids else [None]
    # Assigning again is how a released allocation is reopened, so a released row
    # is not treated as an existing assignment.
    if any(ra.task_id in targets and not ra.released_on for ra in current):
        raise ResourceAlreadyAssigned()

    now = utcnow()
    fields = {
        "role": body.role,
        "allocation_percentage": body.allocation_percentage,
        "billable_rate": body.billable_rate,
        "is_billable": body.is_billable,
        "start_date": datetime.fromisoformat(body.start_date) if body.start_date else None,
        "end_date": datetime.fromisoformat(body.end_date) if body.end_date else None,
    }

    superseded = [ra for ra in current if ra.task_id not in targets]
    for ra in superseded:
        _deactivate(ra, user, now)
        await ra.save()

    created: list[ResourceAssignment] = []
    for task_oid in targets:
        created.append(await _upsert_assignment(proj_oid, task_oid, user_oid, fields, user, now))

    for ra in superseded:
        await _emit_assignment_event("resource.removed", ra, user, reason="superseded by a new task selection")
    for doc in created:
        await _emit_assignment_event("resource.assigned", doc, user, role=body.role)

    # Journey timeline event (IAM consumes this off the shared domain_events bus).
    # One event per employee/project, not per task.
    await outbox.publish(
        "project.assigned",
        {
            "user_id": str(body.user_id),
            "organisation_id": str(user.organisation_id),
            "project_id": project_id,
            "project_name": project.name,
            "assigned_on": now.isoformat(),
        },
        idempotency_key=f"project.assigned:{created[0].id}",
    )

    return [_to_out(doc) for doc in created]


async def list_resources(
    project_id: str,
    user: UserBase,
    p: PageParams,
    *,
    task_id: str | None = None,
    active_on: str | None = None,
) -> dict[str, Any]:
    """List a project's assignments.

    Args:
        active_on: ISO date; keep only allocations live on that day — those that had
            started and had not yet ended. A scheduled release stays in the list
            until its end date passes, so pass today's date for "who is on this
            project now".
    """
    project = await Project.get(project_id)
    if not project or project.deleted_on or project.organisation_id != user.organisation_id:
        raise ProjectNotFound()

    from beanie import PydanticObjectId
    proj_oid_list = PydanticObjectId(project_id)
    filt: dict[str, Any] = {"project_id": proj_oid_list, "deleted_on": None}
    if task_id is not None:
        filt["task_id"] = PydanticObjectId(task_id)
    if active_on:
        on_date = datetime.fromisoformat(active_on)
        filt["$and"] = [
            {"$or": [{"start_date": None}, {"start_date": {"$lte": on_date}}]},
            {"$or": [{"end_date": None}, {"end_date": {"$gte": on_date}}]},
        ]
    skip = compute_skip(p)
    total = await ResourceAssignment.find(filt).count()
    items = await ResourceAssignment.find(filt).sort("-created_on").skip(skip).limit(p.page_size).to_list()

    user_ids = [r.user_id for r in items]
    name_map = await resolve_user_names(user_ids, user.organisation_id)
    emp_code_map = await resolve_emp_codes(user_ids, user.organisation_id)
    out = []
    for r in items:
        row = _to_out(r)
        row["user_name"] = name_map.get(r.user_id)
        row["emp_code"] = emp_code_map.get(r.user_id)
        out.append(row)
    return {"items": out, "total": total, "page": p.page, "page_size": p.page_size}


async def update_resource(
    project_id: str, resource_id: str, body: ResourceAssignmentUpdate, user: UserBase,
) -> list[dict[str, Any]]:
    """Edit an employee's assignment on a project, tasks included.

    The addressed row identifies the employee; the edit then applies to their whole
    assignment on that project. When the payload carries a task selection it
    *replaces* the current one — newly selected tasks are assigned, deselected ones
    are removed (silently, without a removal note), and an empty selection converts
    the employee to a project-level assignment covering every task.

    Returns:
        Every live assignment the employee holds on the project after the edit.
    """
    from beanie import PydanticObjectId
    doc = await ResourceAssignment.get(resource_id)
    if not doc or doc.deleted_on or str(doc.project_id) != project_id or doc.organisation_id != user.organisation_id:
        raise ResourceAssignmentNotFound()

    if doc.released_on:
        raise ResourceReleased(doc.end_date.date().isoformat() if doc.end_date else None)

    update_data = body.model_dump(exclude_unset=True)
    proj_oid = doc.project_id
    user_oid = doc.user_id
    now = utcnow()

    scalar_fields: dict[str, Any] = {}
    for field in ("role", "allocation_percentage", "billable_rate", "is_billable"):
        if field in update_data:
            scalar_fields[field] = update_data[field]
    for field in ("start_date", "end_date"):
        if field in update_data:
            val = update_data[field]
            scalar_fields[field] = datetime.fromisoformat(val) if isinstance(val, str) else val
    if update_data.get("status") is not None:
        scalar_fields["status"] = StatusEnum(update_data["status"])

    current = await _active_assignments(proj_oid, user_oid)

    # Reconcile the task selection when the payload carries one; otherwise the
    # employee keeps whatever tasks they already have.
    added: list[ResourceAssignment] = []
    removed: list[ResourceAssignment] = []
    if body.selects_tasks():
        task_oids = [PydanticObjectId(t) for t in body.selected_task_ids()]
        await _assert_tasks_in_project(proj_oid, task_oids)
        targets: list[Any | None] = list(task_oids) if task_oids else [None]

        held = {ra.task_id for ra in current}
        removed = [ra for ra in current if ra.task_id not in targets]
        current = [ra for ra in current if ra.task_id in targets]
        for ra in removed:
            _deactivate(ra, user, now)
            await ra.save()

        base = {
            "role": doc.role,
            "allocation_percentage": doc.allocation_percentage,
            "billable_rate": doc.billable_rate,
            "is_billable": doc.is_billable,
            "start_date": doc.start_date,
            "end_date": doc.end_date,
            **scalar_fields,
        }
        base.pop("status", None)  # status is a lifecycle flag, not a seedable default
        for task_oid in targets:
            if task_oid not in held:
                added.append(await _upsert_assignment(proj_oid, task_oid, user_oid, base, user, now))

    # Field edits apply to the employee's whole assignment on this project.
    for ra in current:
        for field, value in scalar_fields.items():
            setattr(ra, field, value)
        ra.modified_by = user.id
        ra.modified_on = now
        await ra.save()

    await emit_audit(
        action="resource.updated",
        resource=f"resource:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={
            "project_id": project_id,
            "user_id": str(user_oid),
            "task_ids": [str(ra.task_id) if ra.task_id is not None else None for ra in current + added],
        },
        changed_fields=list(update_data.keys()),
    )
    for ra in removed:
        await _emit_assignment_event("resource.removed", ra, user, reason="unassigned via resource edit")
    for ra in added:
        await _emit_assignment_event("resource.assigned", ra, user, role=ra.role)

    live = sorted(current + added, key=lambda ra: str(ra.task_id or ""))
    return [_to_out(ra) for ra in live]


async def delete_resource(
    project_id: str,
    resource_id: str,
    user: UserBase,
    comment: str,
    end_date: str,
) -> None:
    """Remove a resource from a project, effective on ``end_date``.

    The allocation closes rather than disappearing: the row stays active so time can
    still be logged up to that date, and entry validation refuses anything after it.
    Soft-deleting instead would make the date unreachable, since a deleted assignment
    matches nothing at entry time. A release is final — the allocation accepts no
    further edits, and reads as removed with the manager's comment attached.
    """
    doc = await ResourceAssignment.get(resource_id)
    if not doc or doc.deleted_on or str(doc.project_id) != project_id or doc.organisation_id != user.organisation_id:
        raise ResourceAssignmentNotFound()

    if doc.released_on:
        raise ResourceReleased(doc.end_date.date().isoformat() if doc.end_date else None)

    now = utcnow()
    ends_on = datetime.fromisoformat(end_date)

    # The whole allocation closes, not just the addressed row — the same unit the
    # edit endpoint operates on.
    live = await _active_assignments(doc.project_id, doc.user_id)

    # An allocation closing without a start date has no window to report on, so it
    # is dated from the employee's first logged day on the project.
    started_on = None
    if any(ra.start_date is None for ra in live):
        started_on = await _earliest_entry_date(doc.project_id, doc.user_id, doc.organisation_id)

    for ra in live:
        if ra.start_date is None and started_on is not None:
            ra.start_date = started_on
        ra.end_date = ends_on
        ra.released_on = now
        ra.removal_comment = comment
        ra.removal_history = (ra.removal_history or []) + [{
            "comment": comment,
            "removed_by": str(user.id),
            "removed_at": now,
            "effective_from": ends_on,
        }]
        ra.modified_by = user.id
        ra.modified_on = now
        await ra.save()

        await _emit_assignment_event(
            "resource.removed", ra, user,
            comment=comment, end_date=ends_on.date().isoformat(),
        )
