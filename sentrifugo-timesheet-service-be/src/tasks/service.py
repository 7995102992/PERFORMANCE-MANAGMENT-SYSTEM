from __future__ import annotations

import io
import logging
from typing import Any

from beanie import PydanticObjectId
from beanie.exceptions import RevisionIdWasChanged
from openpyxl import Workbook, load_workbook
from pymongo.errors import DuplicateKeyError

from ..audit import emit_activity, emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.excel import add_list_dropdown, col_letter_for, parse_header, write_header_row
from ..common.names import normalize_name, to_name_lc
from ..common.object_id import is_valid_object_id
from ..common.pagination import PageParams, compute_skip
from ..common.search import regex_contains
from ..common.timestamps import utcnow
from ..exceptions import (
    ProjectNotFound,
    ProjectTaskHasTimesheets,
    ProjectTaskNotFound,
    TaskHasTimesheets,
    TaskInUse,
    TaskNameExists,
    TaskNotFound,
)
from ..models import Project, ProjectTask, StatusEnum, Task, TimesheetEntry

logger = logging.getLogger(__name__)

# Upper bound on the timesheet entries scanned when naming the projects that block a delete.
_TIMESHEET_SCAN_LIMIT = 100

# Editing a task from inside a project splits across two documents: these fields
# belong to the shared Task record, ...
_TASK_LEVEL_FIELDS = ("description", "is_global", "is_billable", "is_time_off", "is_frequent")
# ... while these are per-project overrides stored on the ProjectTask link.
_LINK_LEVEL_FIELDS = ("estimated_hours", "billable_rate", "notes")


def _to_out(doc: Task) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "project_id": str(doc.project_id) if doc.project_id else None,
        "name": doc.name,
        "description": doc.description,
        "is_global": doc.is_global,
        "is_billable": doc.is_billable,
        "is_time_off": doc.is_time_off,
        "is_frequent": doc.is_frequent,
        "estimated_hours": doc.estimated_hours,
        "billable_rate": doc.billable_rate,
        "notes": doc.notes,
        "status": doc.status,
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_on": doc.created_on,
        "modified_by": str(doc.modified_by) if doc.modified_by else None,
        "modified_on": doc.modified_on,
    }


async def _load_or_404(task_id: str, organisation_id: str) -> Task:
    if not is_valid_object_id(task_id):
        raise TaskNotFound()
    doc = await Task.get(task_id)
    if doc is None or doc.deleted_on is not None or doc.organisation_id != organisation_id:
        raise TaskNotFound()
    return doc


async def _persist_task(task: Task, *, insert: bool = False) -> None:
    """Write a task, turning a unique-index violation into the domain error.

    The application checks the name first, but the database has the final say — a
    concurrent write, or an index that has not been migrated yet, still collides.
    Beanie re-raises a DuplicateKeyError from ``save()`` as ``RevisionIdWasChanged``;
    revisions are off for this model, so that exception can only mean a duplicate.
    """
    try:
        await (task.insert() if insert else task.save())
    except (DuplicateKeyError, RevisionIdWasChanged) as exc:
        raise TaskNameExists() from exc


async def _assert_task_name_free(
    name_lc: str,
    organisation_id: PydanticObjectId,
    *,
    project_id: PydanticObjectId | None = None,
    exclude_id: Any = None,
) -> None:
    """Reject a task name that would be ambiguous where it appears.

    Shared tasks (``project_id is None``) are visible to every project, so a
    project-owned task may not reuse one of their names, and a shared task may not
    take a name a project already owns. Two different projects may each own a task of
    the same name — that is the point of project ownership.

    Args:
        name_lc: Normalised, lower-cased candidate name.
        organisation_id: Organisation the check is scoped to.
        project_id: Owning project of the task being named; None for a shared task.
        exclude_id: Task id to ignore, when renaming an existing task.

    Raises:
        TaskNameExists: the name is already taken in the relevant scope.
    """
    scopes: list[dict[str, Any]] = [{"project_id": None}]
    scopes.append({"project_id": project_id} if project_id is not None else {"project_id": {"$ne": None}})

    clashes = await Task.find({
        "organisation_id": organisation_id,
        "name_lc": name_lc,
        "deleted_on": None,
        "$or": scopes,
    }).to_list()
    for other in clashes:
        if exclude_id is None or str(other.id) != str(exclude_id):
            raise TaskNameExists()


async def create_task(body, user: UserBase) -> dict[str, Any]:
    name = normalize_name(body.name)
    name_lc = to_name_lc(name)

    # /tasks always creates a shared, organisation-level task.
    await _assert_task_name_free(name_lc, user.organisation_id)

    now = utcnow()
    doc = Task(
        organisation_id=user.organisation_id,
        name=name,
        name_lc=name_lc,
        description=body.description,
        is_global=body.is_global,
        is_billable=body.is_billable,
        is_time_off=body.is_time_off,
        is_frequent=body.is_frequent,
        estimated_hours=body.estimated_hours,
        billable_rate=body.billable_rate,
        notes=body.notes,
        status=StatusEnum.ACTIVE,
        created_by=user.id,
        created_on=now,
    )
    await _persist_task(doc, insert=True)

    await emit_audit(
        action="task.created",
        resource=f"task:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": doc.name},
    )

    return _to_out(doc)


async def list_tasks(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    status: str = "active",
    is_global: bool | None = None,
    is_frequent: bool | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    """List the organisation's shared tasks.

    Project-owned tasks are excluded by default — they belong to one project and are
    listed by ``GET /projects/{id}/tasks``. Pass ``project_id`` to include the tasks
    that project owns alongside the shared ones.
    """
    filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    if project_id and is_valid_object_id(project_id):
        filt["$or"] = [{"project_id": None}, {"project_id": PydanticObjectId(project_id)}]
    else:
        filt["project_id"] = None
    if status and status != "all":
        filt["status"] = status
    if is_global is not None:
        filt["is_global"] = is_global
    if is_frequent is not None:
        filt["is_frequent"] = is_frequent
    term = regex_contains(q)
    if term:
        filt["name_lc"] = term

    skip = compute_skip(p)
    total = await Task.find(filt).count()
    items = await Task.find(filt).sort("-created_on").skip(skip).limit(p.page_size).to_list()
    return {"items": [_to_out(c) for c in items], "total": total, "page": p.page, "page_size": p.page_size}


async def get_task(task_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(task_id, user.organisation_id)
    return _to_out(doc)


async def _apply_task_name(task: Task, raw_name: str, organisation_id: PydanticObjectId) -> bool:
    """Rename ``task`` in place, keeping task names unique within the organisation.

    Args:
        task: The task being renamed.
        raw_name: New name as supplied by the caller (normalised here).
        organisation_id: Organisation the uniqueness check is scoped to.

    Returns:
        True when the stored name actually changed.

    Raises:
        TaskNameExists: another live task in the organisation already uses the name.
    """
    new_name = normalize_name(raw_name)
    new_name_lc = to_name_lc(new_name)
    if new_name_lc != task.name_lc:
        await _assert_task_name_free(
            new_name_lc, organisation_id, project_id=task.project_id, exclude_id=task.id,
        )
    if task.name == new_name and task.name_lc == new_name_lc:
        return False
    task.name = new_name
    task.name_lc = new_name_lc
    return True


async def update_task(task_id: str, body, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(task_id, user.organisation_id)
    update_data = body.model_dump(exclude_unset=True)

    if update_data.get("name"):
        await _apply_task_name(doc, update_data["name"], user.organisation_id)

    for field in ("description", "is_global", "is_billable", "is_time_off", "is_frequent", "estimated_hours", "billable_rate", "notes"):
        if field in update_data:
            setattr(doc, field, update_data[field])

    if "status" in update_data and update_data["status"] is not None:
        doc.status = StatusEnum(update_data["status"])

    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await _persist_task(doc)

    await emit_audit(
        action="task.updated",
        resource=f"task:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": doc.name},
        changed_fields=list(update_data.keys()),
    )

    return _to_out(doc)


async def _timesheet_usage(
    task_oid: PydanticObjectId,
    organisation_id: PydanticObjectId,
    *,
    project_oid: PydanticObjectId | None = None,
) -> tuple[bool, list[str]]:
    """Check whether timesheet entries were logged against a task.

    Args:
        task_oid: Identifier of the task the entries must reference.
        organisation_id: Organisation the lookup is scoped to.
        project_oid: When given, restrict the lookup to this single project.

    Returns:
        Tuple of (entries_exist, project_names) where project_names holds the names of the
        projects whose timesheets reference the task, capped at `_TIMESHEET_SCAN_LIMIT` entries.
    """
    filt: dict[str, Any] = {
        "organisation_id": organisation_id,
        "task_id": task_oid,
        "deleted_on": None,
    }
    if project_oid is not None:
        filt["project_id"] = project_oid

    entries = await TimesheetEntry.find(filt).limit(_TIMESHEET_SCAN_LIMIT).to_list()
    if not entries:
        return False, []

    names: list[str] = []
    # dict.fromkeys keeps first-seen order while dropping duplicate projects.
    for proj_oid in dict.fromkeys(entry.project_id for entry in entries):
        project = await Project.get(proj_oid)
        if project and project.name:
            names.append(project.name)
    return True, names


async def delete_task(task_id: str, user: UserBase) -> None:
    doc = await _load_or_404(task_id, user.organisation_id)

    has_timesheets, project_names = await _timesheet_usage(doc.id, user.organisation_id)
    if has_timesheets:
        raise TaskHasTimesheets(doc.name, project_names)

    in_use = await ProjectTask.find(
        {"task_id": doc.id, "deleted_on": None}
    ).count()
    if in_use > 0:
        raise TaskInUse()

    now = utcnow()
    doc.deleted_on = now
    doc.deleted_by = user.id
    doc.status = StatusEnum.INACTIVE
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    await emit_audit(
        action="task.deleted",
        resource=f"task:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": doc.name},
    )


# --- Project-Task assignment ---

async def _create_task_for_project(proj_oid: PydanticObjectId, body, user: UserBase) -> Task:
    """Create the task a project is adding to itself.

    Global and frequent tasks are shared organisation-wide — they are offered to (and
    auto-linked into) every project, so their names stay unique across the
    organisation. Everything else belongs to this project alone, which is what lets
    two projects each have their own task of the same name.
    """
    shared = body.is_global or body.is_frequent
    owner = None if shared else proj_oid

    name = normalize_name(body.name)
    name_lc = to_name_lc(name)
    await _assert_task_name_free(name_lc, user.organisation_id, project_id=owner)

    now = utcnow()
    task = Task(
        organisation_id=user.organisation_id,
        project_id=owner,
        name=name,
        name_lc=name_lc,
        description=body.description,
        is_global=body.is_global,
        is_billable=body.is_billable,
        is_time_off=body.is_time_off,
        is_frequent=body.is_frequent,
        estimated_hours=body.estimated_hours,
        billable_rate=body.billable_rate,
        notes=body.notes,
        status=StatusEnum.ACTIVE,
        created_by=user.id,
        created_on=now,
    )
    await _persist_task(task, insert=True)

    await emit_audit(
        action="task.created",
        resource=f"task:{task.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": task.name, "project_id": str(owner) if owner else None},
    )
    return task


async def assign_task_to_project(
    project_id: str,
    body,
    user: UserBase,
) -> dict[str, Any]:
    """Add a task to a project — either linking an existing shared task (``task_id``)
    or creating one that belongs to this project (``name``)."""
    if not is_valid_object_id(project_id):
        raise ProjectNotFound()
    project = await Project.get(project_id)
    if not project or project.deleted_on or project.organisation_id != user.organisation_id:
        raise ProjectNotFound()

    proj_oid = PydanticObjectId(project_id)

    if body.task_id:
        if not is_valid_object_id(body.task_id):
            raise TaskNotFound()
        task = await Task.get(body.task_id)
        if not task or task.deleted_on or task.organisation_id != user.organisation_id:
            raise TaskNotFound()
        # A task owned by another project is not linkable here.
        if task.project_id is not None and task.project_id != proj_oid:
            raise TaskNotFound()
    else:
        task = await _create_task_for_project(proj_oid, body, user)

    task_id = str(task.id)
    estimated_hours = body.estimated_hours
    billable_rate = body.billable_rate
    notes = body.notes

    result = await _assign_single(
        project_id, task_id, user, estimated_hours=estimated_hours,
        billable_rate=billable_rate, notes=notes,
    )

    # Keep Task-level fields in sync so /tasks returns meaningful defaults
    updated = False
    if estimated_hours is not None and task.estimated_hours is None:
        task.estimated_hours = estimated_hours
        updated = True
    if billable_rate is not None and task.billable_rate is None:
        task.billable_rate = billable_rate
        updated = True
    if notes is not None and task.notes is None:
        task.notes = notes
        updated = True
    if updated:
        task.modified_by = user.id
        task.modified_on = utcnow()
        await _persist_task(task)

    # Dual-stream: user-facing activity feed + compliance audit record.
    _pt_details = {"task_id": task_id, "task_name": task.name, "project_id": project_id}
    await emit_activity(
        action="project_task.assigned",
        resource=f"project_task:{result.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=_pt_details,
    )
    await emit_audit(
        action="project_task.assigned",
        resource=f"project_task:{result.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=_pt_details,
    )

    # Only a shared task can be fanned out; a project-owned one belongs here alone.
    if body.add_to_all_existing and task.project_id is None:
        projects = await Project.find(
            {"organisation_id": user.organisation_id, "deleted_on": None}
        ).to_list()
        for p in projects:
            if str(p.id) == project_id:
                continue
            try:
                await _assign_single(
                    str(p.id), task_id, user, estimated_hours=estimated_hours,
                    billable_rate=billable_rate, notes=notes,
                )
            except Exception:
                pass

    return _pt_out(result, task)


async def _assign_single(
    project_id: str,
    task_id: str,
    user: UserBase,
    *,
    estimated_hours: float | None = None,
    billable_rate: float | None = None,
    notes: str | None = None,
) -> ProjectTask:
    from beanie import PydanticObjectId
    proj_oid = PydanticObjectId(project_id)
    task_oid = PydanticObjectId(task_id)
    existing = await ProjectTask.find_one(
        {"project_id": proj_oid, "task_id": task_oid, "deleted_on": None}
    )
    if existing:
        existing.is_active = True
        existing.estimated_hours = estimated_hours
        existing.billable_rate = billable_rate
        existing.notes = notes
        existing.modified_by = user.id
        existing.modified_on = utcnow()
        await existing.save()
        return existing

    now = utcnow()
    pt = ProjectTask(
        organisation_id=user.organisation_id,
        project_id=proj_oid,
        task_id=task_oid,
        is_active=True,
        estimated_hours=estimated_hours,
        billable_rate=billable_rate,
        notes=notes,
        created_by=user.id,
        created_on=now,
    )
    await pt.insert()
    return pt


async def list_project_tasks(project_id: str, user: UserBase, *, search: str | None = None) -> list[dict[str, Any]]:
    if not is_valid_object_id(project_id):
        raise ProjectNotFound()
    project = await Project.get(project_id)
    if not project or project.deleted_on or project.organisation_id != user.organisation_id:
        raise ProjectNotFound()

    from beanie import PydanticObjectId
    pts = await ProjectTask.find(
        {"project_id": PydanticObjectId(project_id), "deleted_on": None, "is_active": True}
    ).to_list()

    results = []
    q = search.strip().lower() if search else None
    for pt in pts:
        task = await Task.get(pt.task_id)
        task_name = task.name if task else None
        if q and not (task_name and q in task_name.lower()):
            continue
        results.append(_pt_out(pt, task))
    return results


async def remove_task_from_project(project_id: str, task_id: str, user: UserBase) -> None:
    if not is_valid_object_id(project_id) or not is_valid_object_id(task_id):
        raise ProjectTaskNotFound()
    from beanie import PydanticObjectId
    pt = await ProjectTask.find_one(
        {
            "organisation_id": user.organisation_id,
            "project_id": PydanticObjectId(project_id),
            "task_id": PydanticObjectId(task_id),
            "deleted_on": None,
        }
    )
    if not pt:
        raise ProjectTaskNotFound()

    task = await Task.get(task_id)

    has_timesheets, _ = await _timesheet_usage(
        pt.task_id, user.organisation_id, project_oid=pt.project_id,
    )
    if has_timesheets:
        project = await Project.get(project_id)
        raise ProjectTaskHasTimesheets(
            task.name if task else None,
            project.name if project else None,
        )

    now = utcnow()
    pt.deleted_on = now
    pt.deleted_by = user.id
    pt.is_active = False
    pt.modified_by = user.id
    pt.modified_on = now
    await pt.save()

    # Dual-stream: user-facing activity feed + compliance audit record.
    _pt_details = {"task_id": task_id, "task_name": task.name if task else None, "project_id": project_id}
    await emit_activity(
        action="project_task.removed",
        resource=f"project_task:{pt.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=_pt_details,
    )
    await emit_audit(
        action="project_task.removed",
        resource=f"project_task:{pt.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details=_pt_details,
    )


async def update_project_task(
    project_id: str, task_id: str, body: dict[str, Any], user: UserBase,
) -> dict[str, Any]:
    if not is_valid_object_id(project_id) or not is_valid_object_id(task_id):
        raise ProjectTaskNotFound()
    from beanie import PydanticObjectId
    pt = await ProjectTask.find_one(
        {
            "organisation_id": user.organisation_id,
            "project_id": PydanticObjectId(project_id),
            "task_id": PydanticObjectId(task_id),
            "deleted_on": None,
        }
    )
    if not pt:
        raise ProjectTaskNotFound()

    task = await Task.get(pt.task_id)
    if task is None or task.deleted_on is not None or task.organisation_id != user.organisation_id:
        raise TaskNotFound()

    now = utcnow()

    # Everything is applied in memory first: a name clash must abort the whole
    # edit rather than leave the link updated and the task untouched.
    task_fields: list[str] = []

    # Marking a project-owned task global or frequent shares it with the whole
    # organisation, so it has to be promoted — and its name re-checked org-wide —
    # exactly as if it had been created that way. Shared tasks are never demoted:
    # they may already be linked to other projects.
    becomes_shared = task.project_id is not None and (
        body.get("is_global") is True or body.get("is_frequent") is True
    )
    if becomes_shared:
        await _assert_task_name_free(task.name_lc, user.organisation_id, exclude_id=task.id)
        task.project_id = None
        task_fields.append("project_id")

    if body.get("name") and await _apply_task_name(task, body["name"], user.organisation_id):
        task_fields.append("name")
    for field in _TASK_LEVEL_FIELDS:
        if field in body and getattr(task, field) != body[field]:
            setattr(task, field, body[field])
            task_fields.append(field)

    for field in _LINK_LEVEL_FIELDS:
        if field in body:
            setattr(pt, field, body[field])
            # Seed the Task-level default from this project when it is still unset.
            if body[field] is not None and getattr(task, field) is None:
                setattr(task, field, body[field])
                task_fields.append(field)

    pt.modified_by = user.id
    pt.modified_on = now
    await pt.save()

    if task_fields:
        task.modified_by = user.id
        task.modified_on = now
        await _persist_task(task)

    await emit_audit(
        action="project_task.updated",
        resource=f"project_task:{pt.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"project_id": project_id, "task_id": task_id},
        changed_fields=[f for f in _LINK_LEVEL_FIELDS if f in body],
    )
    if task_fields:
        await emit_audit(
            action="task.updated",
            resource=f"task:{task.id}",
            actor_id=str(user.id),
            organisation_id=str(user.organisation_id),
            details={"name": task.name, "project_id": project_id},
            changed_fields=task_fields,
        )

    return _pt_out(pt, task)


def _pt_out(pt: ProjectTask, task: Task | None) -> dict[str, Any]:
    return {
        "id": str(pt.id),
        "project_id": str(pt.project_id),
        "task_id": str(pt.task_id),
        "task_name": task.name if task else None,
        "description": task.description if task else None,
        "is_global": task.is_global if task else False,
        "is_billable": task.is_billable if task else None,
        "is_time_off": task.is_time_off if task else False,
        "is_frequent": task.is_frequent if task else False,
        "is_active": pt.is_active,
        "estimated_hours": pt.estimated_hours,
        "billable_rate": pt.billable_rate,
        "notes": pt.notes,
        "created_on": pt.created_on,
    }


# ── Template / Import / Export ────────────────────────────────

TEMPLATE_COLUMNS = [
    "Task Name",
    "Description",
    "Billable",
]

COLUMN_FIELD_MAP = {
    "task name": "name",
    "description": "description",
    "billable": "is_billable",
}

# Columns whose value is mandatory for task creation (marked with " *").
TEMPLATE_REQUIRED_COLUMNS = {
    "Task Name",
}

# Header tooltips with format hints (keyed by column label).
TEMPLATE_COLUMN_HINTS = {
    "Billable": "Yes or No",
}

BILLABLE_OPTIONS = ["Yes", "No"]


def generate_template() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Tasks"
    write_header_row(
        ws,
        TEMPLATE_COLUMNS,
        required_columns=TEMPLATE_REQUIRED_COLUMNS,
        hints=TEMPLATE_COLUMN_HINTS,
    )
    add_list_dropdown(ws, col_letter_for(TEMPLATE_COLUMNS, "Billable"), BILLABLE_OPTIONS)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


EXPORT_COLUMNS = [
    "Task Name",
    "Description",
    "Billable",
    "Global",
    "Status",
    "Created On",
]


async def export_tasks(user: UserBase) -> bytes:
    docs = await Task.find(
        {"organisation_id": user.organisation_id, "deleted_on": None}
    ).sort("-created_on").to_list()

    wb = Workbook()
    ws = wb.active
    ws.title = "Tasks"
    ws.append(EXPORT_COLUMNS)
    for d in docs:
        ws.append([
            d.name,
            d.description or "",
            "Yes" if d.is_billable else "No",
            "Yes" if d.is_global else "No",
            d.status.value if hasattr(d.status, "value") else str(d.status),
            d.created_on.strftime("%Y-%m-%d %H:%M") if d.created_on else "",
        ])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


PROJECT_TASK_EXPORT_COLUMNS = [
    "Task Name",
    "Estimated Hours",
    "Billable Rate",
    "Billable",
    "Notes",
]


async def export_project_tasks(project_id: str, user: UserBase) -> bytes:
    if not is_valid_object_id(project_id):
        raise ProjectNotFound()
    project = await Project.get(project_id)
    if not project or project.deleted_on or project.organisation_id != user.organisation_id:
        raise ProjectNotFound()

    from beanie import PydanticObjectId as _OID2
    pts = await ProjectTask.find(
        {"project_id": _OID2(project_id), "deleted_on": None, "is_active": True}
    ).to_list()

    wb = Workbook()
    ws = wb.active
    ws.title = "Project Tasks"
    ws.append(PROJECT_TASK_EXPORT_COLUMNS)
    for pt in pts:
        task = await Task.get(pt.task_id)
        task_name = task.name if task else pt.task_id
        is_billable = "Yes" if (task and task.is_billable) else "No"
        ws.append([
            task_name,
            pt.estimated_hours or "",
            pt.billable_rate or "",
            is_billable,
            pt.notes or "",
        ])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _parse_bool(val: str, default: bool = True) -> bool:
    return val.strip().lower() in ("yes", "true", "1") if val else default


async def _find_task_in_scope(
    name_lc: str,
    organisation_id: PydanticObjectId,
    proj_oid: PydanticObjectId | None = None,
) -> Task | None:
    """The task a name refers to from a project's point of view: the project's own
    task, or a shared organisation-level one. A task owned by a *different* project
    is invisible here, which is what lets an import create a same-named task."""
    scopes: list[dict[str, Any]] = [{"project_id": None}]
    if proj_oid is not None:
        scopes.append({"project_id": proj_oid})
    return await Task.find_one({
        "organisation_id": organisation_id,
        "name_lc": name_lc,
        "deleted_on": None,
        "$or": scopes,
    })


async def validate_import_tasks(file_bytes: bytes, user: UserBase, *, project_id: str | None = None) -> dict[str, Any]:
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True)
    ws = wb.active

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if not rows:
        return {"total": 0, "rows": [{"row": 0, "status": "error", "reason": "Empty file", "data": {}}]}

    header = parse_header(rows[0])

    required_headers = {col.lower() for col in TEMPLATE_COLUMNS}
    found_headers = {h for h in header if h}
    missing = required_headers - found_headers
    if missing:
        missing_display = ", ".join(sorted(col for col in TEMPLATE_COLUMNS if col.lower() in missing))
        return {"total": 0, "rows": [{"row": 1, "status": "error", "reason": f"Missing required columns: {missing_display}", "data": {}}]}

    field_map: list[str | None] = [COLUMN_FIELD_MAP.get(h) for h in header]
    result_rows: list[dict[str, Any]] = []

    for row_idx, row in enumerate(rows[1:], start=2):
        record: dict[str, Any] = {}
        for col_idx, cell in enumerate(row):
            if col_idx < len(field_map) and field_map[col_idx] and cell is not None:
                record[field_map[col_idx]] = str(cell).strip()

        name = record.get("name", "").strip()
        if not name:
            result_rows.append({"row": row_idx, "status": "error", "reason": "Task Name is required", "data": record})
            continue

        name = normalize_name(name)
        name_lc = to_name_lc(name)

        existing = await _find_task_in_scope(
            name_lc,
            user.organisation_id,
            PydanticObjectId(project_id) if project_id and is_valid_object_id(project_id) else None,
        )

        if existing:
            if project_id:
                from beanie import PydanticObjectId as _OID3
                already_linked = await ProjectTask.find_one(
                    {"project_id": _OID3(project_id), "task_id": existing.id, "deleted_on": None}
                )
                if already_linked:
                    result_rows.append({"row": row_idx, "status": "existing", "reason": f"Task '{name}' already exists and is already linked to this project", "data": {**record, "name": name}})
                else:
                    result_rows.append({"row": row_idx, "status": "existing", "reason": f"Task '{name}' already exists and will be linked to this project", "data": {**record, "name": name}})
            else:
                result_rows.append({"row": row_idx, "status": "existing", "reason": f"Task '{name}' already exists", "data": {**record, "name": name}})
        else:
            result_rows.append({"row": row_idx, "status": "new", "reason": None, "data": {**record, "name": name}})

    wb.close()
    return {"total": len(rows) - 1, "rows": result_rows}


async def bulk_import_tasks(file_bytes: bytes, user: UserBase, *, project_id: str | None = None) -> dict[str, Any]:
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True)
    ws = wb.active

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if not rows:
        return {"total": 0, "created": 0, "errors": [{"row": 0, "error": "Empty file"}]}

    header = parse_header(rows[0])

    required_headers = {col.lower() for col in TEMPLATE_COLUMNS}
    found_headers = {h for h in header if h}
    missing = required_headers - found_headers
    if missing:
        missing_display = ", ".join(sorted(col for col in TEMPLATE_COLUMNS if col.lower() in missing))
        return {"total": 0, "created": 0, "errors": [{"row": 1, "error": f"Missing required columns: {missing_display}"}]}

    field_map: list[str | None] = [COLUMN_FIELD_MAP.get(h) for h in header]

    created = 0
    linked = 0
    errors: list[dict[str, Any]] = []
    now = utcnow()

    for row_idx, row in enumerate(rows[1:], start=2):
        record: dict[str, Any] = {}
        for col_idx, cell in enumerate(row):
            if col_idx < len(field_map) and field_map[col_idx] and cell is not None:
                record[field_map[col_idx]] = str(cell).strip()

        name = record.get("name", "").strip()
        if not name:
            errors.append({"row": row_idx, "error": "Task Name is required"})
            continue

        name = normalize_name(name)
        name_lc = to_name_lc(name)

        owner = PydanticObjectId(project_id) if project_id and is_valid_object_id(project_id) else None
        existing = await _find_task_in_scope(name_lc, user.organisation_id, owner)
        if existing:
            doc = existing
        else:
            is_billable = _parse_bool(record.get("is_billable", ""), True)

            # Imported into a project → the task belongs to that project, so another
            # project may already have one of the same name.
            doc = Task(
                organisation_id=user.organisation_id,
                project_id=owner,
                name=name,
                name_lc=name_lc,
                description=record.get("description"),
                is_global=False,
                is_billable=is_billable,
                status=StatusEnum.ACTIVE,
                created_by=user.id,
                created_on=now,
            )
            await _persist_task(doc, insert=True)
            created += 1

        if project_id:
            from beanie import PydanticObjectId as _OID4
            existing_pt = await ProjectTask.find_one({
                "project_id": _OID4(project_id),
                "task_id": doc.id,
                "deleted_on": None,
            })
            if not existing_pt:
                pt = ProjectTask(
                    organisation_id=user.organisation_id,
                    project_id=_OID4(project_id),
                    task_id=doc.id,
                    is_active=True,
                    created_by=user.id,
                    created_on=now,
                )
                await pt.insert()
                linked += 1

    wb.close()

    await emit_audit(
        action="task.imported",
        resource=f"project:{project_id}" if project_id else f"organisation:{user.organisation_id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"count": created, "linked": linked, "total": len(rows) - 1},
    )

    return {"total": len(rows) - 1, "created": created, "linked": linked, "errors": errors}
