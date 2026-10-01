from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from ..audit import emit_activity, emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.access import hidden_project_ids
from ..notifications.service import notify_timesheet_resubmitted, notify_timesheet_submitted, notify_timesheet_updated
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow
from ..exceptions import (
    AssignmentEnded,
    AssignmentNotStarted,
    AttachmentNotFound,
    AttachmentsNotAllowed,
    PastSubmissionLocked,
    DailyComplianceMissing,
    DailyDeadlineMissed,
    DailyHoursExceeded,
    EmployeeNotAssignedToProject,
    EntriesNoLongerAssigned,
    FutureDateEntryNotAllowed,
    MinDailyHoursNotMet,
    OnlyZeroHourDaysEditable,
    PastDueTimesheetsBlocked,
    SubmissionDeadlinePassed,
    TaskNotAvailableForProject,
    TimesheetAlreadyExists,
    TimesheetNotEditable,
    TimesheetNotFound,
    TimesheetNotSubmittable,
    TimeOffEntriesRestricted,
    WeeklyHoursExceeded,
    ProjectNotStarted,
    ProjectAlreadyEnded,
)
from ..common.cutoff import current_cutoff_boundary
from ..models import (
    ACTED_PROJECT_STATUSES,
    EDITABLE_STATUSES,
    PENDING_STATUSES,
    Client,
    Project,
    ProjectApprovalStatusEnum,
    RESUBMITTABLE_STATUSES,
    SUBMITTABLE_STATUSES,
    PastSubmissionOverride,
    ProjectTask,
    ResourceAssignment,
    StatusEnum,
    Task,
    TimesheetAttachment,
    TimesheetEntry,
    TimesheetProjectApproval,
    TimesheetSettings,
    TimesheetStatusEnum,
    WeeklyTimesheet,
)
from ..common.user_resolver import resolve_user_names
from .schemas import AttachmentAdd, TimesheetCreate, TimesheetEntryBulkSave, TimesheetEntryCreate

logger = logging.getLogger(__name__)


def _ts_to_out(
    doc: WeeklyTimesheet,
    entries: list[dict] | None = None,
    project_names: list[str] | None = None,
    project_tasks: list[dict] | None = None,
    daily_entries: dict[str, list[dict]] | None = None,
) -> dict[str, Any]:
    out = {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "user_id": str(doc.user_id),
        "week_start_date": doc.week_start_date,
        "week_end_date": doc.week_end_date,
        "total_hours": doc.total_hours,
        "billable_hours": doc.billable_hours,
        "non_billable_hours": doc.non_billable_hours,
        "shortage_hours": doc.shortage_hours,
        "penalty_hours": doc.penalty_hours,
        "timesheet_status": doc.timesheet_status,
        "submitted_at": doc.submitted_at,
        "notes": doc.notes,
        "attachments": [_attachment_to_out(a) for a in doc.attachments],
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_on": doc.created_on,
        "modified_on": doc.modified_on,
    }
    if entries is not None:
        out["entries"] = entries
    if project_names is not None:
        out["project_names"] = project_names
    if project_tasks is not None:
        out["project_tasks"] = project_tasks
    if daily_entries is not None:
        out["daily_entries"] = daily_entries
    return out


def _attachment_to_out(a: Any) -> dict[str, Any]:
    return {
        "id": a.id,
        "filename": a.filename,
        "url": a.url,
        "uploaded_by": str(a.uploaded_by) if a.uploaded_by else None,
        "uploaded_at": a.uploaded_at,
    }


def _entry_to_out(doc: TimesheetEntry) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "weekly_timesheet_id": str(doc.weekly_timesheet_id),
        "project_id": str(doc.project_id),
        "task_id": str(doc.task_id),
        "entry_date": doc.entry_date,
        "hours": doc.hours,
        "notes": doc.notes,
        "is_billable": doc.is_billable,
        "created_on": doc.created_on,
        "modified_on": doc.modified_on,
    }


async def _load_timesheet(timesheet_id: str, user_id: str, organisation_id: str) -> WeeklyTimesheet:
    doc = await WeeklyTimesheet.get(timesheet_id)
    if not doc or doc.deleted_on or doc.user_id != user_id or doc.organisation_id != organisation_id:
        raise TimesheetNotFound()
    return doc



async def _get_settings(organisation_id: str, project_id: str | None = None) -> TimesheetSettings | None:
    from ..settings.service import get_effective_settings
    return await get_effective_settings(organisation_id, project_id)


async def _get_leave_hours_for_week(
    user_id: str, week_start: datetime, organisation_id: str,
) -> dict[str, float]:
    # Stub: returns 0.0 for all days — awaiting leave service integration.
    # When a leave service exists, return approved leave hours keyed by "YYYY-MM-DD".
    return {}


def _compute_shortage_and_penalty(
    total_hours: float, leave_total: float, settings: TimesheetSettings,
) -> tuple[float, float]:
    effective = total_hours + leave_total
    expected = settings.standard_hours_per_day * 5
    shortage = max(0.0, expected - effective)
    penalty = (shortage * settings.penalty_percentage / 100) if settings.shortage_penalty_enabled and shortage > 0 else 0.0
    return shortage, penalty


async def _fill_zero_hour_entries(
    doc: WeeklyTimesheet,
    user_id: str,
    organisation_id: str,
    now: datetime,
) -> None:
    """Before submission, for every day in the week that has no entries at all,
    create 0-hour entries for every unique (project_id, task_id) pair found
    anywhere else in that week's entries."""
    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).to_list()

    if not entries:
        return  # nothing to base 0-hour fills on

    # Collect unique (project_id, task_id) → is_billable; keep as PydanticObjectId
    from beanie import PydanticObjectId
    pt_map: dict[tuple, bool] = {}
    dates_with_entries: set[str] = set()
    for e in entries:
        key = (e.project_id, e.task_id)
        if key not in pt_map:
            pt_map[key] = e.is_billable
        dates_with_entries.add(e.entry_date.strftime("%Y-%m-%d"))

    # Walk all 7 days of the week
    for i in range(7):
        day = doc.week_start_date + timedelta(days=i)
        day_key = day.strftime("%Y-%m-%d")
        if day_key in dates_with_entries:
            continue  # day already has entries

        # Create a 0-hour entry for every project-task pair used this week
        for (project_id, task_id), is_billable in pt_map.items():
            day_start = day.replace(hour=0, minute=0, second=0, microsecond=0)
            day_end = day_start + timedelta(days=1)
            exists = await TimesheetEntry.find_one({
                "weekly_timesheet_id": doc.id,
                "project_id": project_id,
                "task_id": task_id,
                "entry_date": {"$gte": day_start, "$lt": day_end},
                "deleted_on": None,
            })
            if not exists:
                zero_entry = TimesheetEntry(
                    organisation_id=organisation_id,
                    weekly_timesheet_id=doc.id,
                    project_id=project_id,
                    task_id=task_id,
                    entry_date=day_start,
                    hours=0.0,
                    is_billable=is_billable,
                    created_by=user_id,
                    created_on=now,
                )
                await zero_entry.insert()


async def _create_project_approvals(
    doc: WeeklyTimesheet,
    project_ids: list,
    now: datetime,
) -> None:
    """Create TimesheetProjectApproval records for each project on initial submission."""
    from beanie import PydanticObjectId
    for project_id in project_ids:
        pid_oid = PydanticObjectId(project_id) if isinstance(project_id, str) else project_id
        existing = await TimesheetProjectApproval.find_one({
            "weekly_timesheet_id": doc.id,
            "project_id": pid_oid,
            "deleted_on": None,
        })
        if not existing:
            tpa = TimesheetProjectApproval(
                organisation_id=doc.organisation_id,
                weekly_timesheet_id=doc.id,
                project_id=pid_oid,
                status=ProjectApprovalStatusEnum.SUBMITTED,
                created_by=doc.user_id,
                created_on=now,
            )
            await tpa.insert()


async def _assert_editable(doc: WeeklyTimesheet) -> None:
    """Allow edits while the work is still waiting on its first approval decision.

    Draft and rejected timesheets are editable as before. A submitted or resubmitted
    one stays editable too — an employee who left a day at 0 can still correct it —
    but only until an approver acts: the moment any project on the week is approved
    or rejected, the whole timesheet freezes and only a rejection reopens it.

    Raises:
        TimesheetNotEditable: the timesheet is approved, or partly acted on.
    """
    if doc.timesheet_status in EDITABLE_STATUSES:
        return
    if doc.timesheet_status not in PENDING_STATUSES:
        raise TimesheetNotEditable()

    acted = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "status": {"$in": [s.value for s in ACTED_PROJECT_STATUSES]},
        "deleted_on": None,
    }).count()
    if acted:
        raise TimesheetNotEditable()


async def _assert_only_zero_hour_days_change(doc: WeeklyTimesheet, body: TimesheetEntryBulkSave) -> None:
    """On a submitted timesheet, confine edits to the days that logged no hours.

    A day already carrying hours has been submitted for approval and must arrive at
    the approver unchanged. Days sitting at zero are still open: the employee may add
    rows for them against any project and task they are assigned to.

    Args:
        doc: The submitted timesheet being edited.
        body: The incoming full-week payload.

    Raises:
        OnlyZeroHourDaysEditable: naming the days whose logged hours would change.
    """
    if doc.timesheet_status not in PENDING_STATUSES:
        return

    existing = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).to_list()

    # Days that carry hours are settled; days at zero remain open.
    settled_days = {e.entry_date.strftime("%Y-%m-%d") for e in existing if e.hours}
    if not settled_days:
        return

    def _key(project_id, task_id, day: str) -> tuple:
        return (str(project_id), str(task_id), day)

    before = {
        _key(e.project_id, e.task_id, e.entry_date.strftime("%Y-%m-%d")): e.hours
        for e in existing
        if e.entry_date.strftime("%Y-%m-%d") in settled_days
    }
    after = {
        _key(e.project_id, e.task_id, datetime.fromisoformat(e.entry_date).strftime("%Y-%m-%d")): e.hours
        for e in body.entries
        if datetime.fromisoformat(e.entry_date).strftime("%Y-%m-%d") in settled_days
    }

    touched = sorted({
        day for key, hours in {**before, **after}.items()
        for day in [key[2]]
        if before.get(key) != after.get(key)
    })
    if touched:
        raise OnlyZeroHourDaysEditable(touched)


async def _sync_pending_project_approvals(doc: WeeklyTimesheet, now: datetime) -> None:
    """Keep the pending approval records in step with an edited submitted timesheet.

    Editing after submission can add a project to the week — which would otherwise
    never reach its approver — or empty one out, leaving an approver a project with
    nothing in it. Only untouched (submitted / resubmitted) records are adjusted;
    anything an approver has acted on is left alone.
    """
    if doc.timesheet_status not in PENDING_STATUSES:
        return

    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).to_list()
    live_project_ids = {e.project_id for e in entries}

    records = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    tracked = {r.project_id for r in records}

    for record in records:
        if record.project_id in live_project_ids or record.status in ACTED_PROJECT_STATUSES:
            continue
        record.deleted_on = now
        record.modified_on = now
        await record.save()

    status = (
        ProjectApprovalStatusEnum.RESUBMITTED
        if doc.timesheet_status == TimesheetStatusEnum.RESUBMITTED
        else ProjectApprovalStatusEnum.SUBMITTED
    )
    for project_id in live_project_ids - tracked:
        await TimesheetProjectApproval(
            organisation_id=doc.organisation_id,
            weekly_timesheet_id=doc.id,
            project_id=project_id,
            status=status,
            created_by=doc.user_id,
            created_on=now,
        ).insert()


async def _submission_project_ids(doc: WeeklyTimesheet) -> list:
    """The projects a submission needs approval records for.

    Normally the projects of the week's own entries. A week submitted with nothing
    logged still has to reach an approver, so it falls back to the employee's live
    project assignments — without a TimesheetProjectApproval record the timesheet is
    invisible to every manager, and the submission goes into a void.
    """
    entries = await TimesheetEntry.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    project_ids = list({e.project_id for e in entries})
    if project_ids:
        return project_ids

    assignments = await ResourceAssignment.find({
        "user_id": doc.user_id,
        "organisation_id": doc.organisation_id,
        "deleted_on": None,
        "status": StatusEnum.ACTIVE.value,
    }).to_list()
    return list({a.project_id for a in assignments})


async def _reset_rejected_project_approvals(
    doc: WeeklyTimesheet,
    now: datetime,
) -> None:
    """On resubmit, reset rejected project approvals to resubmitted.
    Leave l1_approved / client_approved ones untouched.
    Create TPA records for any new projects added since last submission."""
    # Projects to track on this resubmission (falls back to the employee's live
    # assignments when the week carries no entries).
    current_project_ids = set(await _submission_project_ids(doc))

    # Fetch existing TPA records
    tpa_records = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    tpa_by_project = {tpa.project_id: tpa for tpa in tpa_records}

    rejected_statuses = {
        ProjectApprovalStatusEnum.L1_REJECTED,
        ProjectApprovalStatusEnum.CLIENT_REJECTED,
    }
    for tpa in tpa_records:
        if tpa.status in rejected_statuses:
            tpa.status = ProjectApprovalStatusEnum.RESUBMITTED
            tpa.modified_by = doc.user_id
            tpa.modified_on = now
            await tpa.save()

    # Create TPA for any new projects added since original submission
    for project_id in current_project_ids:
        if project_id not in tpa_by_project:
            tpa = TimesheetProjectApproval(
                organisation_id=doc.organisation_id,
                weekly_timesheet_id=doc.id,
                project_id=project_id,
                status=ProjectApprovalStatusEnum.RESUBMITTED,
                created_by=doc.user_id,
                created_on=now,
            )
            await tpa.insert()


async def _validate_entry(entry: TimesheetEntryCreate, user_id: str, organisation_id: str) -> bool:
    from beanie import PydanticObjectId
    proj_oid = PydanticObjectId(entry.project_id)
    task_oid = PydanticObjectId(entry.task_id)
    project_ra = await ResourceAssignment.find_one({
        "project_id": proj_oid,
        "task_id": None,
        "user_id": user_id,
        "organisation_id": organisation_id,
        "deleted_on": None,
        "status": "active",
    })
    task_ra = await ResourceAssignment.find_one({
        "project_id": proj_oid,
        "task_id": task_oid,
        "user_id": user_id,
        "organisation_id": organisation_id,
        "deleted_on": None,
        "status": "active",
    })
    if not project_ra and not task_ra:
        raise EmployeeNotAssignedToProject()

    pt = await ProjectTask.find_one({
        "project_id": proj_oid,
        "task_id": task_oid,
        "organisation_id": organisation_id,
        "deleted_on": None,
        "is_active": True,
    })
    if not pt:
        raise TaskNotAvailableForProject()

    # If the task has task-specific assignments, a user WITHOUT a project-level
    # assignment must be one of those assignees. Project-level members are
    # assigned to the whole project and can log any task (consistent with
    # get_assigned_project_tasks, which lists every task for them).
    task_assignments_exist = await ResourceAssignment.find_one({
        "project_id": proj_oid,
        "task_id": task_oid,
        "organisation_id": organisation_id,
        "deleted_on": None,
        "status": "active",
    })
    if task_assignments_exist and not task_ra and not project_ra:
        raise EmployeeNotAssignedToProject()

    # Restrict the entry date to the assignment's active window when set.
    # resource_assignments.start_date / end_date are optional; a task-level
    # assignment governs if present, otherwise the project-level one.
    governing_ra = task_ra or project_ra
    if governing_ra is not None and (governing_ra.start_date or governing_ra.end_date):
        entry_d = datetime.fromisoformat(entry.entry_date).replace(tzinfo=None).date()
        if governing_ra.start_date and entry_d < governing_ra.start_date.replace(tzinfo=None).date():
            proj = await Project.get(proj_oid)
            raise AssignmentNotStarted(
                proj.name if proj else str(proj_oid),
                governing_ra.start_date.strftime("%b %d, %Y"),
            )
        if governing_ra.end_date and entry_d > governing_ra.end_date.replace(tzinfo=None).date():
            proj = await Project.get(proj_oid)
            raise AssignmentEnded(
                proj.name if proj else str(proj_oid),
                governing_ra.end_date.strftime("%b %d, %Y"),
            )

    if task_ra:
        return task_ra.is_billable
    return project_ra.is_billable


async def _recalculate_hours(timesheet_id: str) -> tuple[float, float, float]:
    from beanie import PydanticObjectId
    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": PydanticObjectId(timesheet_id), "deleted_on": None}
    ).to_list()

    total = sum(e.hours for e in entries)
    billable = sum(e.hours for e in entries if e.is_billable)
    non_billable = total - billable
    return total, billable, non_billable


async def get_assigned_projects(user: UserBase) -> list[dict[str, Any]]:
    from beanie import PydanticObjectId

    # Return all of the user's assignments regardless of active/inactive/deleted
    # state — assigned-projects shows inactive projects too (status is included
    # in the response so the UI can label them). Scoped to the caller's own
    # organisation so a foreign identity can never see or log against its projects.
    assignments = await ResourceAssignment.find(
        {"user_id": user.id, "organisation_id": user.organisation_id}
    ).to_list()
    if not assignments:
        return []

    # What may be logged against is decided by the LIVE assignments only. A removed
    # or deactivated row must not keep granting access — it would also disagree with
    # _validate_entry, which rejects such an entry on save. This matters when a
    # resource is switched from project-level to specific tasks: the old
    # project-level row is soft-removed, and counting it would still expose every task.
    # An allocation whose end date has passed is dropped for the same reason: offering
    # a project the employee can no longer log against only earns them a rejection.
    today = utcnow().date()
    live = [
        a for a in assignments
        if a.deleted_on is None
        and a.status == StatusEnum.ACTIVE
        and (a.end_date is None or a.end_date.replace(tzinfo=None).date() >= today)
    ]

    # project-level assignment (task_id=None) → user can log to any task
    # task-level assignment → user can only log to those specific tasks
    # a.project_id is PydanticObjectId; use PydanticObjectId keys for sets/dicts
    project_level: set = {a.project_id for a in live if a.task_id is None}
    task_level: dict = {}
    for a in live:
        if a.task_id is not None:
            task_level.setdefault(a.project_id, set()).add(a.task_id)

    all_project_ids = list({a.project_id for a in assignments})
    projects = await Project.find(
        {"_id": {"$in": all_project_ids}}
    ).to_list()

    # Hard business-unit/department filter — can't log on a project whose client
    # is outside the employee's business unit / department.
    hidden = set(await hidden_project_ids(user))
    if hidden:
        projects = [p for p in projects if p.id not in hidden]

    # A project belongs to exactly one client, and anything that lets somebody pick
    # a project has to be able to say which. Resolved here, in one query over the
    # clients actually referenced, rather than left to the caller: every consumer of
    # this endpoint is by definition an employee without `manage_clients`, so the
    # clients list is unreachable to them. Sending the id alone would be no better —
    # an id is not something anyone can read off a form.
    client_names: dict = {}
    client_ids = {p.client_id for p in projects if p.client_id}
    if client_ids:
        client_names = {c.id: c.name for c in await Client.find({"_id": {"$in": list(client_ids)}}).to_list()}

    results = []
    for p in projects:
        pid_oid = p.id  # PydanticObjectId
        pid = str(p.id)
        try:
            if pid_oid in project_level:
                # Project-level assignment: expose all active tasks
                pts = await ProjectTask.find(
                    {"project_id": pid_oid, "deleted_on": None, "is_active": True}
                ).to_list()
                task_ids = [pt.task_id for pt in pts]
            else:
                # Task-level only: expose only the assigned tasks
                assigned_task_ids = list(task_level.get(pid_oid, set()))
                pts = await ProjectTask.find(
                    {"project_id": pid_oid, "task_id": {"$in": assigned_task_ids}, "deleted_on": None, "is_active": True}
                ).to_list()
                task_ids = [pt.task_id for pt in pts]

            task_meta: dict[str, dict] = {}
            if task_ids:
                tasks_docs = await Task.find(
                    {"_id": {"$in": task_ids}, "deleted_on": None}
                ).to_list()
                task_meta = {str(t.id): {"name": t.name, "is_frequent": t.is_frequent} for t in tasks_docs}
            results.append({
                "id": pid,
                "name": p.name,
                "code": p.code,
                "project_status": p.project_status,
                "status": p.status,
                "client_id": str(p.client_id) if p.client_id else None,
                "client_name": client_names.get(p.client_id),
                "tasks": [
                    {
                        "task_id": str(pt.task_id),
                        "task_name": task_meta.get(str(pt.task_id), {}).get("name", str(pt.task_id)),
                        "is_frequent": task_meta.get(str(pt.task_id), {}).get("is_frequent", False),
                    }
                    for pt in pts
                ],
            })
        except Exception as e:
            logger.exception("Error loading tasks for project %s: %s", pid, e)
            results.append({
                "id": pid,
                "name": p.name,
                "code": p.code,
                "project_status": p.project_status,
                "status": p.status,
                "client_id": str(p.client_id) if p.client_id else None,
                "client_name": client_names.get(p.client_id),
                "tasks": [],
            })
    return results


async def get_assigned_project_tasks(project_id: str, user: UserBase) -> list[dict[str, Any]]:
    from beanie import PydanticObjectId

    proj_oid = PydanticObjectId(project_id)
    ras = await ResourceAssignment.find(
        {
            "project_id": proj_oid,
            "user_id": user.id,
            "organisation_id": user.organisation_id,
            "deleted_on": None,
            "status": "active",
        }
    ).to_list()
    # An allocation past its end date no longer permits time entry, so it must not
    # offer tasks either.
    today = utcnow().date()
    ras = [
        ra for ra in ras
        if ra.end_date is None or ra.end_date.replace(tzinfo=None).date() >= today
    ]
    if not ras:
        raise EmployeeNotAssignedToProject()

    # Hard business-unit/department filter.
    if proj_oid in set(await hidden_project_ids(user)):
        raise EmployeeNotAssignedToProject()

    project_level = any(ra.task_id is None for ra in ras)

    if project_level:
        pts = await ProjectTask.find(
            {"project_id": proj_oid, "deleted_on": None, "is_active": True}
        ).to_list()
    else:
        assigned_task_ids = [ra.task_id for ra in ras if ra.task_id]
        pts = await ProjectTask.find(
            {"project_id": proj_oid, "task_id": {"$in": assigned_task_ids}, "deleted_on": None, "is_active": True}
        ).to_list()

    task_ids = [pt.task_id for pt in pts]
    tasks_docs = await Task.find({"_id": {"$in": task_ids}, "deleted_on": None}).to_list()
    t_map = {str(t.id): t.name for t in tasks_docs}

    return [
        {"task_id": str(pt.task_id), "task_name": t_map.get(str(pt.task_id), str(pt.task_id))}
        for pt in pts
    ]


async def create_timesheet(body: TimesheetCreate, user: UserBase) -> dict[str, Any]:
    week_start = datetime.fromisoformat(body.week_start_date).replace(tzinfo=timezone.utc)

    if week_start.weekday() != 0:
        from ..exceptions import DomainException
        raise DomainException("week_start_date must be a Monday", "TSM-011")

    week_end = week_start + timedelta(days=6)

    existing = await WeeklyTimesheet.find_one({
        "user_id": user.id,
        "week_start_date": week_start,
        "deleted_on": None,
    })
    if existing:
        raise TimesheetAlreadyExists()

    now = utcnow()
    doc = WeeklyTimesheet(
        organisation_id=user.organisation_id,
        user_id=user.id,
        week_start_date=week_start,
        week_end_date=week_end,
        timesheet_status=TimesheetStatusEnum.DRAFT,
        notes=body.notes,
        created_by=user.id,
        created_on=now,
    )
    await doc.insert()

    await emit_activity(
        action="timesheet.created",
        resource=f"timesheet:{str(doc.id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"timesheet_id": str(doc.id), "week_start": str(doc.week_start_date.date())},
    )

    return _ts_to_out(doc, entries=[])


async def list_timesheets(
    user: UserBase,
    p: PageParams,
    *,
    timesheet_status: str | None = None,
) -> dict[str, Any]:
    filt: dict[str, Any] = {
        "user_id": user.id,
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }
    if timesheet_status:
        filt["timesheet_status"] = timesheet_status

    skip = compute_skip(p)
    total = await WeeklyTimesheet.find(filt).count()
    items = await WeeklyTimesheet.find(filt).sort("-week_start_date").skip(skip).limit(p.page_size).to_list()

    from beanie import PydanticObjectId

    ts_oids = [ts.id for ts in items]  # PydanticObjectId list for queries
    ts_ids = [str(ts.id) for ts in items]  # str list for dict keys
    all_entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": {"$in": ts_oids}, "deleted_on": None}
    ).to_list()

    ts_project_ids: dict[str, set[str]] = {}
    ts_task_ids: dict[str, set[str]] = {}
    ts_project_task_pairs: dict[str, set[tuple[str, str]]] = {}
    for e in all_entries:
        ts_key = str(e.weekly_timesheet_id)
        p_key = str(e.project_id)
        t_key = str(e.task_id)
        ts_project_ids.setdefault(ts_key, set()).add(p_key)
        ts_task_ids.setdefault(ts_key, set()).add(t_key)
        ts_project_task_pairs.setdefault(ts_key, set()).add((p_key, t_key))

    all_project_ids: set[str] = set()
    all_task_ids: set[str] = set()
    for pids in ts_project_ids.values():
        all_project_ids.update(pids)
    for tids in ts_task_ids.values():
        all_task_ids.update(tids)

    # No deleted_on filter so names resolve even for deleted projects/tasks
    # (past timesheets show names instead of ids).
    project_name_map: dict[str, str] = {}
    if all_project_ids:
        projects = await Project.find(
            {"_id": {"$in": [PydanticObjectId(pid) for pid in all_project_ids]}}
        ).to_list()
        project_name_map = {str(p.id): p.name for p in projects}

    task_name_map: dict[str, str] = {}
    if all_task_ids:
        tasks_docs = await Task.find(
            {"_id": {"$in": [PydanticObjectId(tid) for tid in all_task_ids]}}
        ).to_list()
        task_name_map = {str(t.id): t.name for t in tasks_docs}

    ts_daily_entries: dict[str, dict[str, list[dict]]] = {}
    for e in all_entries:
        ts_key = str(e.weekly_timesheet_id)
        p_key = str(e.project_id)
        t_key = str(e.task_id)
        day_key = e.entry_date.strftime("%Y-%m-%d")
        ts_daily_entries.setdefault(ts_key, {}).setdefault(day_key, []).append({
            "project_name": project_name_map.get(p_key, p_key),
            "task_name": task_name_map.get(t_key, t_key),
            "hours": e.hours,
        })

    # Per-project approval status with full actor data
    tpa_by_ts: dict[str, list[dict]] = {ts_id: [] for ts_id in ts_ids}
    if ts_oids:
        page_tpa = await TimesheetProjectApproval.find({
            "weekly_timesheet_id": {"$in": ts_oids},
            "deleted_on": None,
        }).to_list()

        # Batch-resolve all approver names in one call
        actor_ids: list[str] = [user.id]  # submitter always the current user
        for tpa in page_tpa:
            if tpa.l1_approver_id:
                actor_ids.append(tpa.l1_approver_id)
            if tpa.client_approver_id:
                actor_ids.append(tpa.client_approver_id)
        actor_name_map = await resolve_user_names(list(set(actor_ids)), user.organisation_id)

        for tpa in page_tpa:
            tpa_ts_key = str(tpa.weekly_timesheet_id)
            tpa_p_key = str(tpa.project_id)
            tpa_by_ts.setdefault(tpa_ts_key, []).append({
                "project_id": tpa_p_key,
                "project_name": project_name_map.get(tpa_p_key, tpa_p_key),
                "status": tpa.status,
                "submitted_by_id": str(user.id),
                "submitted_by_name": actor_name_map.get(user.id),
                "l1_approver_id": str(tpa.l1_approver_id) if tpa.l1_approver_id else None,
                "l1_approver_name": actor_name_map.get(tpa.l1_approver_id) if tpa.l1_approver_id else None,
                "l1_acted_at": tpa.l1_acted_at,
                "l1_comments": tpa.l1_comments,
                "client_approver_id": str(tpa.client_approver_id) if tpa.client_approver_id else None,
                "client_approver_name": actor_name_map.get(tpa.client_approver_id) if tpa.client_approver_id else None,
                "client_acted_at": tpa.client_acted_at,
                "client_comments": tpa.client_comments,
            })

    result_items = []
    for ts in items:
        ts_id = str(ts.id)
        pids = ts_project_ids.get(ts_id, set())
        names = sorted(project_name_map.get(pid, pid) for pid in pids)
        pairs = ts_project_task_pairs.get(ts_id, set())
        project_tasks = [
            {
                "project_id": pid,
                "task_id": tid,
                "project_name": project_name_map.get(pid, pid),
                "task_name": task_name_map.get(tid, tid),
            }
            for pid, tid in sorted(pairs, key=lambda x: (project_name_map.get(x[0], x[0]), task_name_map.get(x[1], x[1])))
        ]
        daily = ts_daily_entries.get(ts_id, {})
        ts_out = _ts_to_out(ts, project_names=names, project_tasks=project_tasks, daily_entries=daily)
        ts_out["project_approvals"] = tpa_by_ts.get(ts_id, [])
        result_items.append(ts_out)

    return {
        "items": result_items,
        "total": total,
        "page": p.page,
        "page_size": p.page_size,
    }


async def get_timesheet(timesheet_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)
    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("entry_date").to_list()

    out = _ts_to_out(doc, entries=[_entry_to_out(e) for e in entries])

    # Work calendar (weekoff / half-day) for the week, from the LMS shift calendar
    from ..common.work_calendar import fetch_work_calendars
    cal_by_user = await fetch_work_calendars(
        [str(doc.user_id)],
        doc.week_start_date.date().isoformat(),
        doc.week_end_date.date().isoformat(),
    )
    out["work_calendar"] = cal_by_user.get(str(doc.user_id)) or {
        "weekoffs": [], "weekend_matrix": None, "week_config": None,
    }
    return out


async def save_entries(timesheet_id: str, body: TimesheetEntryBulkSave, user: UserBase) -> dict[str, Any]:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)

    await _assert_editable(doc)
    # Past submission, only the days left at zero are still open.
    await _assert_only_zero_hour_days_change(doc, body)

    # Hard business-unit/department filter — block logging on projects whose
    # client is outside the employee's business unit / department.
    hidden = set(await hidden_project_ids(user))
    if hidden:
        from beanie import PydanticObjectId as _OID0
        for entry_data in body.entries:
            if _OID0(entry_data.project_id) in hidden:
                raise EmployeeNotAssignedToProject()

    settings = await _get_settings(user.organisation_id)
    now = utcnow()

    # Two settings cap entries at today; the check is the same, only the reason
    # differs. Zero-hour rows are exempt — the grid posts a placeholder for every day
    # of the week, and reserving a future day without logging time against it is not
    # what either rule is guarding.
    if settings and (settings.daily_time_entry_enabled or not settings.allow_future_entries):
        reason = (
            "Daily entry mode is on: time can only be logged up to today."
            if settings.daily_time_entry_enabled
            else "Logging time for future dates is turned off: entries can only be made up to today."
        )
        today = now.date()
        for entry_data in body.entries:
            if not entry_data.hours:
                continue
            if datetime.fromisoformat(entry_data.entry_date).date() > today:
                raise FutureDateEntryNotAllowed(reason)

    # Payroll cutoff: days on or before the boundary are settled. Passing the payload
    # lets the check compare against what is stored, so a week straddling the cutoff
    # stays writable on its open days while its closed ones are frozen.
    await _assert_period_open(doc, settings, now, body=body)

    if settings and settings.restrict_time_off_entries:
        from beanie import PydanticObjectId
        task_ids = list({e.task_id for e in body.entries})
        time_off_count = await Task.find({
            "_id": {"$in": [PydanticObjectId(tid) for tid in task_ids]},
            "is_time_off": True,
            "deleted_on": None,
        }).count()
        if time_off_count > 0:
            raise TimeOffEntriesRestricted()

    # Validate entry dates against project start/end dates
    from beanie import PydanticObjectId as _OID
    unique_pids = list({e.project_id for e in body.entries})
    proj_docs = await Project.find(
        {"_id": {"$in": [_OID(pid) for pid in unique_pids]}, "deleted_on": None}
    ).to_list()
    proj_date_map = {str(p.id): p for p in proj_docs}
    for entry_data in body.entries:
        proj = proj_date_map.get(entry_data.project_id)
        if proj:
            entry_dt = datetime.fromisoformat(entry_data.entry_date).replace(tzinfo=None).date()
            if proj.start_date:
                proj_start = proj.start_date.replace(tzinfo=None).date()
                if entry_dt < proj_start:
                    raise ProjectNotStarted(proj.name, proj_start.strftime("%b %d, %Y"))
            if proj.end_date:
                proj_end = proj.end_date.replace(tzinfo=None).date()
                if entry_dt > proj_end:
                    raise ProjectAlreadyEnded(proj.name, proj_end.strftime("%b %d, %Y"))

    billable_map: dict[tuple[str, str], bool] = {}
    for entry_data in body.entries:
        is_billable = await _validate_entry(entry_data, user.id, user.organisation_id)
        billable_map[(entry_data.project_id, entry_data.task_id)] = is_billable

    if settings and settings.daily_restrictions_enabled:
        # The save replaces the timesheet's content, so a day's total after saving is
        # exactly what the payload carries for it — no need to fold in existing rows.
        daily_totals: dict[str, float] = {}
        for entry_data in body.entries:
            day_key = datetime.fromisoformat(entry_data.entry_date).strftime("%Y-%m-%d")
            daily_totals[day_key] = daily_totals.get(day_key, 0) + entry_data.hours

        leave_by_day: dict[str, float] = {}
        if settings.deduct_leave_daily:
            leave_by_day = await _get_leave_hours_for_week(user.id, doc.week_start_date, user.organisation_id)

        for day, total in daily_totals.items():
            effective = total - leave_by_day.get(day, 0.0)
            if effective > settings.max_hours_per_day:
                raise DailyHoursExceeded(settings.max_hours_per_day)

    for entry_data in body.entries:
        is_billable = billable_map[(entry_data.project_id, entry_data.task_id)]
        entry_date = datetime.fromisoformat(entry_data.entry_date).replace(tzinfo=timezone.utc)

        from beanie import PydanticObjectId
        proj_oid = PydanticObjectId(entry_data.project_id)
        task_oid = PydanticObjectId(entry_data.task_id)
        existing = await TimesheetEntry.find_one({
            "weekly_timesheet_id": doc.id,
            "project_id": proj_oid,
            "task_id": task_oid,
            "entry_date": entry_date,
            "deleted_on": None,
        })

        if existing:
            existing.hours = entry_data.hours
            existing.notes = entry_data.notes
            existing.is_billable = is_billable
            existing.modified_by = user.id
            existing.modified_on = now
            await existing.save()
            await emit_activity(
                action="timesheet.entry_updated",
                resource=f"timesheet:{str(doc.id)}",
                actor_id=str(user.id),
                organisation_id=str(user.organisation_id),
                details={"entry_id": str(existing.id), "timesheet_id": str(doc.id), "project_id": str(proj_oid), "hours": entry_data.hours},
            )
        else:
            entry = TimesheetEntry(
                organisation_id=user.organisation_id,
                weekly_timesheet_id=doc.id,
                project_id=proj_oid,
                task_id=task_oid,
                entry_date=entry_date,
                hours=entry_data.hours,
                notes=entry_data.notes,
                is_billable=is_billable,
                created_by=user.id,
                created_on=now,
            )
            await entry.insert()
            await emit_activity(
                action="timesheet.entry_added",
                resource=f"timesheet:{str(doc.id)}",
                actor_id=str(user.id),
                organisation_id=str(user.organisation_id),
                details={"entry_id": str(entry.id), "timesheet_id": str(doc.id), "project_id": str(proj_oid)},
            )

    # The payload is the authoritative content of the timesheet: anything it no
    # longer carries is removed. Without this, a row whose task was swapped out
    # (e.g. after a rejection and a reassignment) lingers and is counted twice.
    submitted_keys = {
        (e.project_id, e.task_id, datetime.fromisoformat(e.entry_date).strftime("%Y-%m-%d"))
        for e in body.entries
    }
    for stale in await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).to_list():
        key = (str(stale.project_id), str(stale.task_id), stale.entry_date.strftime("%Y-%m-%d"))
        if key in submitted_keys:
            continue
        stale.deleted_on = now
        stale.deleted_by = user.id
        stale.modified_by = user.id
        stale.modified_on = now
        await stale.save()
        await emit_activity(
            action="timesheet.entry_removed",
            resource=f"timesheet:{str(doc.id)}",
            actor_id=str(user.id),
            organisation_id=str(user.organisation_id),
            details={"entry_id": str(stale.id), "timesheet_id": str(doc.id), "project_id": str(stale.project_id)},
        )

    total, billable, non_billable = await _recalculate_hours(str(doc.id))
    doc.total_hours = total
    doc.billable_hours = billable
    doc.non_billable_hours = non_billable
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    # Editing an already-submitted week can add or empty a project; keep the pending
    # approval records in step so every project still reaches its approver, then tell
    # them the week they are about to review has changed.
    await _sync_pending_project_approvals(doc, now)
    if doc.timesheet_status in PENDING_STATUSES:
        actor_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.display_name or str(user.id)
        await notify_timesheet_updated(doc, actor_name)

    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("entry_date").to_list()

    return _ts_to_out(doc, entries=[_entry_to_out(e) for e in entries])


async def delete_entry(timesheet_id: str, entry_id: str, user: UserBase) -> None:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)
    await _assert_editable(doc)

    entry = await TimesheetEntry.get(entry_id)
    if not entry or entry.deleted_on or entry.weekly_timesheet_id != doc.id:
        from ..exceptions import NotFound
        raise NotFound("Timesheet entry not found")

    now = utcnow()
    entry.deleted_on = now
    entry.deleted_by = user.id
    entry.modified_on = now
    await entry.save()

    total, billable, non_billable = await _recalculate_hours(str(doc.id))
    doc.total_hours = total
    doc.billable_hours = billable
    doc.non_billable_hours = non_billable
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    await _sync_pending_project_approvals(doc, now)

    await emit_activity(
        action="timesheet.entry_removed",
        resource=f"timesheet:{str(doc.id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"entry_id": str(entry.id), "timesheet_id": str(doc.id)},
    )


WEEKDAY_MAP = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6}


async def _closed_day_changes(
    doc: WeeklyTimesheet,
    body: TimesheetEntryBulkSave,
    boundary,
) -> set:
    """Projects whose closed-day hours this save would add, change or remove.

    The cutoff closes days, not weeks, and the boundary usually falls mid-week — so a
    straddling week stays writable on its open days while its closed ones are frozen.
    Saving replaces the whole week, and the grid posts a row for every day, so the
    payload always restates the closed days: comparing against what is stored is what
    separates "still filling this week" from "editing a settled day".

    Zero-hour rows are ignored on both sides — they are the grid's placeholders, and
    reserving an empty closed day changes nothing about payroll.

    Returns:
        The projects involved in the difference, empty when the closed part of the
        week is untouched.
    """
    stored = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).to_list()

    def _closed_stored() -> dict:
        return {
            (str(e.project_id), str(e.task_id), e.entry_date.replace(tzinfo=None).date()): e.hours
            for e in stored
            if e.hours and e.entry_date.replace(tzinfo=None).date() <= boundary
        }

    def _closed_incoming() -> dict:
        out = {}
        for e in body.entries:
            day = datetime.fromisoformat(e.entry_date).date()
            if e.hours and day <= boundary:
                out[(str(e.project_id), str(e.task_id), day)] = e.hours
        return out

    before, after = _closed_stored(), _closed_incoming()
    changed = {k for k in before | after.keys() if before.get(k) != after.get(k)}
    return {pid for pid, _task, _day in changed}


async def _assert_period_open(
    doc: WeeklyTimesheet,
    settings: TimesheetSettings | None,
    now: datetime,
    *,
    body: TimesheetEntryBulkSave | None = None,
) -> None:
    """Enforce the monthly payroll cutoff.

    The cutoff closes *days*: on the 25th, the 25th and everything before it are
    settled, and only the 26th onward may still be filled. A week that straddles the
    boundary is therefore half open — its later days accept time, its earlier ones do
    not. A project manager can reopen the week's month for their own project, so the
    block only applies to projects with no live override.

    Args:
        doc: The weekly timesheet being written to or submitted.
        settings: Effective timesheet settings; the rule is off when disabled.
        now: Current time, for resolving the boundary.
        body: The save payload, when saving. Only its changes to closed days are
            blocked. None means submission, where the whole week is pushed at once
            and so must have at least one day still open.

    Raises:
        PastSubmissionLocked: naming the cutoff date and the still-closed projects.
    """
    if not settings or not settings.past_submission_cutoff_enabled:
        return

    boundary = current_cutoff_boundary(now.replace(tzinfo=None).date(), settings.past_submission_cutoff_day)

    if body is not None:
        project_ids = await _closed_day_changes(doc, body, boundary)
        if not project_ids:
            return
    else:
        # Submitting pushes the whole week, so it needs a day that is still open.
        # The boundary week stays submittable: its post-cutoff days are live work.
        if doc.week_end_date.replace(tzinfo=None).date() > boundary:
            return
        entries = await TimesheetEntry.find(
            {"weekly_timesheet_id": doc.id, "deleted_on": None}
        ).to_list()
        project_ids = {e.project_id for e in entries}

    if not project_ids:
        raise PastSubmissionLocked(boundary.strftime("%b %d, %Y"))

    from beanie import PydanticObjectId

    from ..past_submissions.service import reopened_project_ids

    # Reopening is granted to the employee for a month, and covers only the granting
    # manager's projects — so the exemption is looked up by person, then narrowed to
    # the projects it actually covers.
    # The month a week belongs to is the month it starts in.
    week_start = doc.week_start_date.replace(tzinfo=None).date()
    reopened = await reopened_project_ids(doc.user_id, week_start.year, week_start.month)

    oids = [PydanticObjectId(p) if isinstance(p, str) else p for p in project_ids]
    if reopened is None:
        still_closed = oids
    else:
        still_closed = [pid for pid in oids if str(pid) not in reopened]
    if not still_closed:
        return

    projects = await Project.find({"_id": {"$in": still_closed}}).to_list()
    names = [p.name for p in projects] or None
    raise PastSubmissionLocked(boundary.strftime("%b %d, %Y"), names)


async def _assert_entries_still_assignable(doc: WeeklyTimesheet, user_id, organisation_id) -> None:
    """Every logged entry must still be covered by a live assignment.

    An assignment can change between saving and submitting — a manager reassigns the
    task, or narrows a project-level assignment to specific tasks. The entry stays in
    the timesheet, so it is caught here rather than reaching an approver.

    Raises:
        EntriesNoLongerAssigned: naming the task and date of each orphaned entry.
    """
    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None, "hours": {"$gt": 0}}
    ).to_list()
    if not entries:
        return

    assignments = await ResourceAssignment.find({
        "user_id": user_id,
        "organisation_id": organisation_id,
        "deleted_on": None,
        "status": StatusEnum.ACTIVE.value,
    }).to_list()
    project_level = {a.project_id for a in assignments if a.task_id is None}
    task_level = {(a.project_id, a.task_id) for a in assignments if a.task_id is not None}

    orphans = [
        e for e in entries
        if e.project_id not in project_level and (e.project_id, e.task_id) not in task_level
    ]
    if not orphans:
        return

    task_docs = await Task.find({"_id": {"$in": [e.task_id for e in orphans]}}).to_list()
    task_names = {str(t.id): t.name for t in task_docs}
    raise EntriesNoLongerAssigned([
        f"'{task_names.get(str(e.task_id), str(e.task_id))}' on {e.entry_date.strftime('%b %d, %Y')}"
        for e in sorted(orphans, key=lambda e: e.entry_date)
    ])


async def _deadlines_waived_by_reopen(
    doc: WeeklyTimesheet, settings: TimesheetSettings | None, now: datetime,
) -> bool:
    """Whether a live reopen should waive this week's punctuality rules.

    Reopening a closed month says, in as many words, "file this late". Leaving the
    lateness rules in force would then refuse the very submission the manager just
    authorised — the employee would be handed an open month they still cannot submit
    into, which is not an exception at all.

    Deliberately narrow on both sides:

    * only when the cutoff has actually closed the week, so a grant on a current
      month cannot be used to duck that week's ordinary deadline;
    * only the timing rules. What the timesheet must *contain* — minimum daily hours,
      daily completeness, assignment windows — is unaffected, because reopening
      forgives being late, not being wrong.
    """
    if not settings or not settings.past_submission_cutoff_enabled:
        return False

    boundary = current_cutoff_boundary(
        now.replace(tzinfo=None).date(), settings.past_submission_cutoff_day,
    )
    if doc.week_end_date.replace(tzinfo=None).date() > boundary:
        return False  # not late by the cutoff's own reckoning

    from ..past_submissions.service import reopened_project_ids

    week_start = doc.week_start_date.replace(tzinfo=None).date()
    reopened = await reopened_project_ids(doc.user_id, week_start.year, week_start.month)
    return reopened is not None


async def _validate_submission_rules(
    doc: WeeklyTimesheet, settings: TimesheetSettings, user_id: str, now: datetime,
    leave_by_day: dict[str, float] | None = None,
    waive_deadlines: bool = False,
) -> None:
    """Rules a week must satisfy to be submitted.

    Args:
        waive_deadlines: Set when a reopen has authorised this late submission. Skips
            the punctuality rules only — see ``_deadlines_waived_by_reopen``.
    """
    leave_by_day = leave_by_day or {}
    # Stored dates are naive UTC; strip tzinfo so comparisons don't raise TypeError
    now = now.replace(tzinfo=None)
    # 1. Block if past timesheets are unsubmitted.
    #    Waived by a reopen: an older week may itself be closed and not reopened, so
    #    enforcing submit-oldest-first would deadlock the one that was authorised.
    if not settings.allow_past_due_submission and not waive_deadlines:
        older_drafts = await WeeklyTimesheet.find({
            "user_id": user_id,
            "week_start_date": {"$lt": doc.week_start_date},
            "timesheet_status": {"$in": list(EDITABLE_STATUSES)},
            "deleted_on": None,
        }).count()
        if older_drafts > 0:
            raise PastDueTimesheetsBlocked()

    # 2. Check submission deadline (weekly mode) — the rule a reopen most obviously
    #    has to waive, since the week is late by construction.
    if (not waive_deadlines
            and settings.submission_compliance_type == "weekly"
            and settings.submission_deadline_hours > 0):
        sub_day = WEEKDAY_MAP.get(settings.submission_day, 4)
        hour, minute = (int(x) for x in settings.submission_time.split(":"))
        days_since_sub_day = (now.weekday() - sub_day) % 7
        last_submission_day = now - timedelta(days=days_since_sub_day)
        deadline = last_submission_day.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(hours=settings.submission_deadline_hours)
        if doc.week_end_date <= last_submission_day and now > deadline:
            raise SubmissionDeadlinePassed()

    # 3. Minimum daily hours check (weekdays Mon-Fri)
    if settings.daily_restrictions_enabled and settings.min_hours_per_day > 0:
        all_entries = await TimesheetEntry.find(
            {"weekly_timesheet_id": doc.id, "deleted_on": None}
        ).to_list()

        daily_totals: dict[str, float] = {}
        for e in all_entries:
            day_key = e.entry_date.strftime("%Y-%m-%d")
            daily_totals[day_key] = daily_totals.get(day_key, 0) + e.hours

        below_min = []
        for i in range(5):
            day = doc.week_start_date + timedelta(days=i)
            day_key = day.strftime("%Y-%m-%d")
            # When deduct_leave_daily is on, leave hours count toward the daily requirement
            effective = daily_totals.get(day_key, 0) + (leave_by_day.get(day_key, 0.0) if settings.deduct_leave_daily else 0.0)
            if effective < settings.min_hours_per_day:
                below_min.append(day_key)
        if below_min:
            raise MinDailyHoursNotMet(settings.min_hours_per_day, below_min)

    # 4. Daily compliance checks
    if settings.submission_compliance_type == "daily":
        all_entries = await TimesheetEntry.find(
            {"weekly_timesheet_id": doc.id, "deleted_on": None}
        ).to_list()

        entry_dates = {e.entry_date.strftime("%Y-%m-%d") for e in all_entries}

        # 4a. All 7 days must have at least one entry
        all_week_dates = [(doc.week_start_date + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
        missing = [d for d in all_week_dates if d not in entry_dates]
        if missing:
            raise DailyComplianceMissing(missing)

        # 4b. Each day's entries must have been submitted before its daily deadline.
        #     Timing again, so a reopen waives it — 4a above is completeness and stays.
        if settings.submission_deadline_hours > 0 and not waive_deadlines:
            missed = []
            for i in range(7):
                day = doc.week_start_date + timedelta(days=i)
                day_end = day.replace(hour=23, minute=59, second=59, microsecond=0)
                daily_deadline = day_end + timedelta(hours=settings.submission_deadline_hours)
                if now > daily_deadline and day.strftime("%Y-%m-%d") in entry_dates:
                    day_entries = [e for e in all_entries if e.entry_date.strftime("%Y-%m-%d") == day.strftime("%Y-%m-%d")]
                    latest_modified = max(e.modified_on or e.created_on for e in day_entries)
                    if latest_modified and latest_modified > daily_deadline:
                        missed.append(day.strftime("%Y-%m-%d"))
            if missed:
                raise DailyDeadlineMissed(missed)

    # 5. Resource-assignment date window: any LOGGED hours must fall within the
    #    user's assignment start/end window for that project/task (when set).
    #    0-hour rows are skipped — the pre-submit auto-fill inserts placeholder
    #    entries on every day and those bypass per-entry validation.
    hour_entries = [
        e for e in await TimesheetEntry.find(
            {"weekly_timesheet_id": doc.id, "deleted_on": None}
        ).to_list()
        if e.hours and e.hours > 0
    ]
    if hour_entries:
        project_ids = list({e.project_id for e in hour_entries})
        assignments = await ResourceAssignment.find({
            "user_id": user_id,
            "project_id": {"$in": project_ids},
            "deleted_on": None,
            "status": "active",
        }).to_list()
        proj_level: dict = {}
        task_level: dict = {}
        for a in assignments:
            if a.task_id is None:
                proj_level[a.project_id] = a
            else:
                task_level[(a.project_id, a.task_id)] = a

        for e in hour_entries:
            # task-level assignment governs if present, otherwise project-level
            ra = task_level.get((e.project_id, e.task_id)) or proj_level.get(e.project_id)
            if ra is None or not (ra.start_date or ra.end_date):
                continue
            entry_d = e.entry_date.replace(tzinfo=None).date()
            if ra.start_date and entry_d < ra.start_date.replace(tzinfo=None).date():
                proj = await Project.get(e.project_id)
                raise AssignmentNotStarted(
                    proj.name if proj else str(e.project_id),
                    ra.start_date.strftime("%b %d, %Y"),
                )
            if ra.end_date and entry_d > ra.end_date.replace(tzinfo=None).date():
                proj = await Project.get(e.project_id)
                raise AssignmentEnded(
                    proj.name if proj else str(e.project_id),
                    ra.end_date.strftime("%b %d, %Y"),
                )


async def submit_timesheet(timesheet_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)

    if doc.timesheet_status not in SUBMITTABLE_STATUSES:
        raise TimesheetNotSubmittable()

    settings = await _get_settings(user.organisation_id)

    leave_by_day: dict[str, float] = {}
    leave_total = 0.0
    if settings and (settings.deduct_leave_daily or settings.deduct_leave_weekly):
        leave_by_day = await _get_leave_hours_for_week(user.id, doc.week_start_date, user.organisation_id)
        leave_total = sum(leave_by_day.values())

    if settings and settings.weekly_restrictions_enabled:
        effective_weekly = doc.total_hours + (leave_total if settings.deduct_leave_weekly else 0.0)
        if effective_weekly > settings.max_hours_per_week:
            raise WeeklyHoursExceeded(settings.max_hours_per_week)

    now = utcnow()

    # Submitting pushes every project in the week, so all of them must be open.
    await _assert_period_open(doc, settings, now)
    await _assert_entries_still_assignable(doc, user.id, user.organisation_id)

    # Auto-fill 0-hour entries for any day in the week with no entries
    await _fill_zero_hour_entries(doc, user.id, user.organisation_id, now)

    if settings:
        await _validate_submission_rules(
            doc, settings, user.id, now, leave_by_day=leave_by_day,
            waive_deadlines=await _deadlines_waived_by_reopen(doc, settings, now),
        )

    shortage, penalty = 0.0, 0.0
    if settings:
        leave_for_penalty = leave_total if settings.deduct_leave_weekly else 0.0
        shortage, penalty = _compute_shortage_and_penalty(doc.total_hours, leave_for_penalty, settings)

    doc.shortage_hours = shortage
    doc.penalty_hours = penalty
    doc.timesheet_status = TimesheetStatusEnum.SUBMITTED
    doc.submitted_at = now
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    project_ids = await _submission_project_ids(doc)

    # Create per-project approval tracking records
    await _create_project_approvals(doc, project_ids, now)

    for pid in project_ids:
        try:
            await emit_activity(
                action="timesheet.submitted",
                resource=f"timesheet:{str(doc.id)}",
                actor_id=str(user.id),
                organisation_id=str(user.organisation_id),
                details={"timesheet_id": str(doc.id), "project_id": str(pid), "week_start": str(doc.week_start_date.date()), "total_hours": doc.total_hours},
            )
        except Exception:
            logger.exception("emit_activity failed for project %s (non-blocking)", pid)

    # Compliance audit record (one per state change; emit_audit is bypass-proof)
    await emit_audit(
        action="timesheet.submitted",
        resource=f"timesheet:{str(doc.id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={
            "timesheet_id": str(doc.id),
            "week_start": str(doc.week_start_date.date()),
            "total_hours": doc.total_hours,
            "project_ids": [str(p) for p in project_ids],
        },
    )

    try:
        actor_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.display_name or str(user.id)
        await notify_timesheet_submitted(doc, actor_name)
    except Exception:
        logger.exception("notify_timesheet_submitted failed (non-blocking)")

    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("entry_date").to_list()
    return _ts_to_out(doc, entries=[_entry_to_out(e) for e in entries])


async def get_my_limits(user: UserBase) -> dict[str, Any]:
    """The weekly hour cap that applies to this employee's own timesheets.

    ``max_hours_per_week`` is null when the organisation has not enabled the weekly
    restriction, so the UI can hide the indicator rather than invent a default.

    Deliberately read from the organisation's settings, not a project's: the cap is
    enforced on submit against the whole week's hours using the organisation-level
    document, so anything else here would advertise a limit that is not the one
    applied.
    """
    settings = await _get_settings(user.organisation_id)
    enabled = bool(settings and settings.weekly_restrictions_enabled)
    return {
        "max_hours_per_week": settings.max_hours_per_week if enabled else None,
    }


async def get_my_summary(user: UserBase) -> dict[str, Any]:
    filt = {
        "user_id": user.id,
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }
    all_ts = await WeeklyTimesheet.find(filt).to_list()

    counts: dict[str, int] = {}
    for ts in all_ts:
        key = ts.timesheet_status.value
        counts[key] = counts.get(key, 0) + 1

    return {
        "total": len(all_ts),
        "draft": counts.get("draft", 0),
        "submitted": counts.get("submitted", 0),
        "l1_approved": counts.get("l1_approved", 0),
        "l1_rejected": counts.get("l1_rejected", 0),
        "client_approved": counts.get("client_approved", 0),
        "client_rejected": counts.get("client_rejected", 0),
        "resubmitted": counts.get("resubmitted", 0),
        "pending_approval": counts.get("submitted", 0) + counts.get("resubmitted", 0),
    }


_COMPLIANT_STATUSES = {
    TimesheetStatusEnum.SUBMITTED.value,
    TimesheetStatusEnum.L1_APPROVED.value,
    TimesheetStatusEnum.CLIENT_APPROVED.value,
    TimesheetStatusEnum.RESUBMITTED.value,
}
_DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"]
_WORKING_WEEKDAYS = {0, 1, 2, 3, 4}  # Mon–Fri


async def get_my_dashboard(user: UserBase) -> dict[str, Any]:
    """Compact view for the employee dashboard: today's logged hours and the
    current week's day-by-day fill status, plus a compliance streak."""
    now = utcnow()
    today = now.date()
    week_start = today - timedelta(days=today.weekday())  # Monday
    week_start_dt = datetime(week_start.year, week_start.month, week_start.day, tzinfo=timezone.utc)

    settings = await _get_settings(user.organisation_id)
    target_hours = float(settings.standard_hours_per_day) if settings else 8.0

    doc = await WeeklyTimesheet.find_one(
        {
            "user_id": user.id,
            "organisation_id": user.organisation_id,
            "week_start_date": week_start_dt,
            "deleted_on": None,
        }
    )

    hours_by_day: dict[str, float] = {}
    today_key = today.strftime("%Y-%m-%d")
    last_entry_at: datetime | None = None
    if doc:
        entries = await TimesheetEntry.find(
            {"weekly_timesheet_id": doc.id, "deleted_on": None}
        ).to_list()
        for e in entries:
            key = e.entry_date.strftime("%Y-%m-%d")
            hours_by_day[key] = hours_by_day.get(key, 0.0) + (e.hours or 0.0)
            if key == today_key:
                ts = e.modified_on or e.created_on
                if ts and (last_entry_at is None or ts > last_entry_at):
                    last_entry_at = ts

    days: list[dict[str, Any]] = []
    filled_days = 0
    expected_days = 0
    for i in range(7):
        d = week_start + timedelta(days=i)
        key = d.strftime("%Y-%m-%d")
        hours = round(hours_by_day.get(key, 0.0), 2)
        is_working = i in _WORKING_WEEKDAYS
        if not is_working:
            day_status = "weekend"
        elif d > today:
            day_status = "future"
        elif d == today:
            day_status = "today"
        elif hours >= target_hours:
            day_status = "filled"
        elif hours > 0:
            day_status = "partial"
        else:
            day_status = "missing"
        if is_working and d <= today:
            # Today only counts toward "expected" once something is logged, so a
            # compliant employee doesn't read "0 / 1" every morning.
            if d < today or hours > 0:
                expected_days += 1
            if hours > 0:
                filled_days += 1
        days.append(
            {"date": key, "label": _DAY_LABELS[i], "weekday": i, "hours": hours, "status": day_status}
        )

    streak_weeks = await _compliance_streak(user, week_start_dt)

    return {
        "today": {
            "date": today_key,
            "logged_hours": round(hours_by_day.get(today_key, 0.0), 2),
            "target_hours": target_hours,
            "last_entry_at": last_entry_at,
        },
        "week": {
            "week_start_date": week_start.strftime("%Y-%m-%d"),
            "days": days,
            "filled_days": filled_days,
            "expected_days": expected_days,
            "total_hours": round(doc.total_hours if doc else sum(hours_by_day.values()), 2),
            "timesheet_id": str(doc.id) if doc else None,
            "status": doc.timesheet_status.value if doc else None,
        },
        "streak_weeks": streak_weeks,
    }


_SUBMITTED_STATUS_VALUES = {
    TimesheetStatusEnum.SUBMITTED.value,
    TimesheetStatusEnum.RESUBMITTED.value,
    TimesheetStatusEnum.L1_APPROVED.value,
    TimesheetStatusEnum.CLIENT_APPROVED.value,
}


async def get_org_compliance(user: UserBase) -> dict[str, Any]:
    """Org-wide timesheet status for the current week (admin dashboard).

    Returns the count of distinct users who submitted this week and a status
    breakdown. The caller divides ``submitted_users`` by the org headcount
    (from IAM) to get a compliance percentage — this service has no headcount.
    """
    now = utcnow()
    today = now.date()
    week_start = today - timedelta(days=today.weekday())
    week_start_dt = datetime(week_start.year, week_start.month, week_start.day, tzinfo=timezone.utc)

    docs = await WeeklyTimesheet.find(
        {
            "organisation_id": user.organisation_id,
            "week_start_date": week_start_dt,
            "deleted_on": None,
        }
    ).to_list()

    by_status: dict[str, int] = {}
    submitted_users: set[str] = set()
    for d in docs:
        st = d.timesheet_status.value
        by_status[st] = by_status.get(st, 0) + 1
        if st in _SUBMITTED_STATUS_VALUES:
            submitted_users.add(str(d.user_id))

    return {
        "week_start_date": week_start.strftime("%Y-%m-%d"),
        "submitted_users": len(submitted_users),
        "total_timesheets": len(docs),
        "by_status": by_status,
    }


async def _compliance_streak(user: UserBase, current_week_start_dt: datetime) -> int:
    """Count consecutive prior weeks (ending last week) whose timesheet was
    submitted or approved, with no missing week in between."""
    prior = await WeeklyTimesheet.find(
        {
            "user_id": user.id,
            "organisation_id": user.organisation_id,
            "deleted_on": None,
            "week_start_date": {"$lt": current_week_start_dt},
        }
    ).sort("-week_start_date").limit(60).to_list()

    by_week = {ts.week_start_date.date(): ts.timesheet_status.value for ts in prior}
    streak = 0
    expected = (current_week_start_dt - timedelta(days=7)).date()
    while expected in by_week and by_week[expected] in _COMPLIANT_STATUSES:
        streak += 1
        expected = expected - timedelta(days=7)
    return streak


async def resubmit_timesheet(timesheet_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)

    if doc.timesheet_status not in RESUBMITTABLE_STATUSES:
        raise TimesheetNotSubmittable()

    now = utcnow()
    settings = await _get_settings(user.organisation_id)

    leave_by_day: dict[str, float] = {}
    leave_total = 0.0
    if settings and (settings.deduct_leave_daily or settings.deduct_leave_weekly):
        leave_by_day = await _get_leave_hours_for_week(user.id, doc.week_start_date, user.organisation_id)
        leave_total = sum(leave_by_day.values())

    # Submitting pushes every project in the week, so all of them must be open.
    await _assert_period_open(doc, settings, now)
    await _assert_entries_still_assignable(doc, user.id, user.organisation_id)

    # Auto-fill 0-hour entries for any day in the week with no entries
    await _fill_zero_hour_entries(doc, user.id, user.organisation_id, now)

    if settings:
        await _validate_submission_rules(
            doc, settings, user.id, now, leave_by_day=leave_by_day,
            waive_deadlines=await _deadlines_waived_by_reopen(doc, settings, now),
        )

    shortage, penalty = 0.0, 0.0
    if settings:
        leave_for_penalty = leave_total if settings.deduct_leave_weekly else 0.0
        shortage, penalty = _compute_shortage_and_penalty(doc.total_hours, leave_for_penalty, settings)

    doc.shortage_hours = shortage
    doc.penalty_hours = penalty
    doc.timesheet_status = TimesheetStatusEnum.RESUBMITTED
    doc.submitted_at = now
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    # Reset only the rejected project approvals; leave approved ones intact
    await _reset_rejected_project_approvals(doc, now)

    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("entry_date").to_list()

    project_ids = list({e.project_id for e in entries})
    for pid in project_ids:
        try:
            await emit_activity(
                action="timesheet.resubmitted",
                resource=f"timesheet:{str(doc.id)}",
                actor_id=str(user.id),
                organisation_id=str(user.organisation_id),
                details={"timesheet_id": str(doc.id), "project_id": str(pid), "week_start": str(doc.week_start_date.date()), "total_hours": doc.total_hours},
            )
        except Exception:
            logger.exception("emit_activity failed for project %s (non-blocking)", pid)

    # Compliance audit record (one per state change; emit_audit is bypass-proof)
    await emit_audit(
        action="timesheet.resubmitted",
        resource=f"timesheet:{str(doc.id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={
            "timesheet_id": str(doc.id),
            "week_start": str(doc.week_start_date.date()),
            "total_hours": doc.total_hours,
            "project_ids": [str(p) for p in project_ids],
        },
    )

    try:
        actor_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.display_name or str(user.id)
        await notify_timesheet_resubmitted(doc, actor_name)
    except Exception:
        logger.exception("notify_timesheet_resubmitted failed (non-blocking)")

    return _ts_to_out(doc, entries=[_entry_to_out(e) for e in entries])


async def add_attachment(timesheet_id: str, body: AttachmentAdd, user: UserBase) -> dict[str, Any]:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)
    settings = await _get_settings(user.organisation_id)
    if settings and not settings.allow_attachment:
        raise AttachmentsNotAllowed()

    attachment = TimesheetAttachment(
        filename=body.filename,
        url=body.url,
        uploaded_by=user.id,
        uploaded_at=utcnow(),
    )
    doc.attachments.append(attachment)
    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    await emit_activity(
        action="timesheet.attachment_added",
        resource=f"timesheet:{str(doc.id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"attachment_id": str(attachment.id), "timesheet_id": str(doc.id), "filename": attachment.filename},
    )

    return _ts_to_out(doc)


async def remove_attachment(timesheet_id: str, attachment_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_timesheet(timesheet_id, user.id, user.organisation_id)
    original_len = len(doc.attachments)
    doc.attachments = [a for a in doc.attachments if a.id != attachment_id]
    if len(doc.attachments) == original_len:
        raise AttachmentNotFound()
    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    await emit_activity(
        action="timesheet.attachment_removed",
        resource=f"timesheet:{str(doc.id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"attachment_id": str(attachment_id), "timesheet_id": str(doc.id)},
    )

    return _ts_to_out(doc)


async def auto_submit_pending() -> dict[str, Any]:
    from ..models import TimesheetSettings

    now = utcnow()
    submitted_ids: list[str] = []
    failed_ids: list[str] = []

    enabled_settings = await TimesheetSettings.find(
        {"auto_submit_enabled": True, "deleted_on": None}
    ).to_list()

    for ts_settings in enabled_settings:
        org_id = ts_settings.organisation_id

        sub_day = WEEKDAY_MAP.get(ts_settings.submission_day, 4)
        hour, minute = (int(x) for x in ts_settings.submission_time.split(":"))
        days_since_sub_day = (now.weekday() - sub_day) % 7
        last_sub_day = now - timedelta(days=days_since_sub_day)
        deadline = last_sub_day.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(hours=ts_settings.submission_deadline_hours)

        if now < deadline:
            continue

        week_start = last_sub_day - timedelta(days=last_sub_day.weekday())
        week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)

        drafts = await WeeklyTimesheet.find({
            "organisation_id": org_id,
            "week_start_date": week_start,
            "timesheet_status": {"$in": list(EDITABLE_STATUSES)},
            "deleted_on": None,
        }).to_list()

        for ts in drafts:
            try:
                if ts_settings.weekly_restrictions_enabled and ts.total_hours > ts_settings.max_hours_per_week:
                    failed_ids.append(str(ts.id))
                    logger.warning("auto_submit.weekly_exceeded ts=%s", ts.id)
                    continue

                shortage, penalty = _compute_shortage_and_penalty(ts.total_hours, 0.0, ts_settings)
                ts.shortage_hours = shortage
                ts.penalty_hours = penalty
                ts.timesheet_status = TimesheetStatusEnum.SUBMITTED
                ts.submitted_at = now
                ts.modified_on = now
                await ts.save()

                # Per-project approval tracking — mirror manual submit so the
                # approver flow works for auto-submitted timesheets too.
                ts_project_ids = await _submission_project_ids(ts)
                await _create_project_approvals(ts, ts_project_ids, now)

                submitted_ids.append(str(ts.id))
                logger.info("auto_submit.submitted ts=%s org=%s", ts.id, org_id)

                # System-driven submission — surface to the employee (activity)
                # and record for compliance (audit). Both helpers are bypass-proof.
                _auto_details = {
                    "timesheet_id": str(ts.id),
                    "week_start": str(week_start.date()),
                    "total_hours": ts.total_hours,
                }
                await emit_activity(
                    action="timesheet.auto_submitted",
                    resource=f"timesheet:{str(ts.id)}",
                    actor_id="system",
                    organisation_id=str(org_id),
                    details=_auto_details,
                )
                await emit_audit(
                    action="timesheet.auto_submitted",
                    resource=f"timesheet:{str(ts.id)}",
                    actor_id="system",
                    organisation_id=str(org_id),
                    details=_auto_details,
                )
            except Exception:
                logger.exception("auto_submit.failed ts=%s", ts.id)
                failed_ids.append(str(ts.id))

    return {"submitted": len(submitted_ids), "failed": len(failed_ids), "submitted_ids": submitted_ids, "failed_ids": failed_ids}
