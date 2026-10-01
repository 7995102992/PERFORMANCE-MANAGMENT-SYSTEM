from __future__ import annotations

import asyncio
import calendar
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId

from ..audit import emit_activity
from ..auth.utils.dependencies import UserBase
from ..rabbitmq import outbox
from ..common.access import hidden_project_ids, is_scope_exempt
from ..notifications.service import notify_budget_threshold_alert, notify_l1_approved_to_client, notify_timesheet_approved, notify_timesheet_rejected
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow
from ..exceptions import (
    TimesheetNotApprovable,
    TimesheetNotFound,
)
from ..models import (
    ApprovalActionEnum,
    ApprovalRecord,
    ApproverRoleEnum,
    Client,
    ClientProjectHead,
    Project,
    ProjectApprovalStatusEnum,
    ResourceAssignment,
    Task,
    TimesheetEntry,
    TimesheetProjectApproval,
    TimesheetSettings,
    TimesheetStatusEnum,
    WeeklyTimesheet,
)
from ..common.user_resolver import (
    fetch_reportee_user_ids,
    resolve_emp_codes,
    resolve_user_names,
    resolve_user_scope,
    resolve_users_org_units,
)
from ..rabbitmq.lms_rpc import LMSUnavailable, get_employee_leave_calendar
from ..common.work_calendar import fetch_work_calendars
from .schemas import ApprovalAction, BulkApprovalAction, BulkRejectionAction, RejectionAction

logger = logging.getLogger(__name__)



MANAGER_ROLES = {"manager", "lead", "project_manager", "team_lead"}

# The leave-calendar RPC declares no timeout of its own; bound it where it is used.
_LEAVE_RPC_TIMEOUT = 10.0  # seconds


def _month_range(year: int, month: int) -> tuple[datetime, datetime]:
    _, last_day = calendar.monthrange(year, month)
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year, month, last_day, 23, 59, 59, tzinfo=timezone.utc)
    return start, end


def _matches_login_scope(placement, mgr_bu, mgr_dept) -> bool:
    """True if a (business_unit_id, department_id) tuple matches the login user's
    department AND business unit (each checked only when the login user has it)."""
    bu, dept = placement if placement else (None, None)
    if mgr_dept and dept != mgr_dept:
        return False
    if mgr_bu and bu != mgr_bu:
        return False
    return True


async def _filter_users_to_login_scope(user: UserBase, user_ids: set) -> set:
    """Keep only users in the login user's department AND business unit.

    Admins (scope-exempt) are not restricted. Everyone else must have a
    resolvable scope: when the login user has neither a department nor a business
    unit on their IAM employee record the scope is unknown, so nothing is
    visible (fail closed) rather than everything.
    """
    if is_scope_exempt(user) or not user_ids:
        return user_ids
    mgr_bu, mgr_dept = await resolve_user_scope(str(user.id))
    if not mgr_bu and not mgr_dept:
        return set()
    placements = await resolve_users_org_units([str(u) for u in user_ids])
    return {u for u in user_ids if _matches_login_scope(placements.get(str(u)), mgr_bu, mgr_dept)}


async def _assert_employee_in_login_scope(user: UserBase, employee_user_id) -> None:
    """Raise TimesheetNotFound if the employee isn't in the login user's
    department AND business unit.

    Fails closed: an unresolvable login scope (no business unit and no department
    on the login user's IAM employee record) denies access instead of waiving the
    restriction.
    """
    if is_scope_exempt(user):
        return
    mgr_bu, mgr_dept = await resolve_user_scope(str(user.id))
    if not mgr_bu and not mgr_dept:
        raise TimesheetNotFound()
    placements = await resolve_users_org_units([str(employee_user_id)])
    if not _matches_login_scope(placements.get(str(employee_user_id)), mgr_bu, mgr_dept):
        raise TimesheetNotFound()


async def _approver_assignments(user: UserBase) -> tuple[list, set]:
    """What makes this user an approver, and for which projects.

    Two things qualify, and nothing else: an active resource assignment carrying a
    manager role, or being named among a project's heads. A plain assignment with no
    role is an employee working on the project — it must not confer sight of anyone
    else's timesheet.

    Returns:
        Tuple of (manager-role assignments, project ids where the user is a head).
    """
    assignments = await ResourceAssignment.find({
        "user_id": user.id,
        "organisation_id": user.organisation_id,
        "role": {"$in": list(MANAGER_ROLES)},
        "deleted_on": None,
        "status": "active",
    }).to_list()

    headed = await Project.find({
        "organisation_id": user.organisation_id,
        "project_head_ids": user.id,
        "deleted_on": None,
    }).to_list()
    return assignments, {p.id for p in headed}


async def _get_team_user_ids(user: UserBase) -> list[str]:
    manager_id = user.id
    manager_assignments, headed_project_ids = await _approver_assignments(user)

    if not manager_assignments and not headed_project_ids:
        return []

    # Split into project-level (task_id=None) and task-level assignments
    # a.project_id is PydanticObjectId — keep as-is for direct use in queries
    # A project head sees the whole project, like a project-level assignment.
    project_level_ids = {a.project_id for a in manager_assignments if a.task_id is None}
    project_level_ids |= headed_project_ids
    # task_id grouped by project for task-level-only projects
    task_level: dict = {}
    for a in manager_assignments:
        if a.task_id is not None and a.project_id not in project_level_ids:
            task_level.setdefault(a.project_id, []).append(a.task_id)

    # Hard business-unit/department filter: drop projects whose client is out
    # of the manager's scope, so their team only spans in-scope projects.
    hidden = set(await hidden_project_ids(user))
    if hidden:
        project_level_ids = {pid for pid in project_level_ids if pid not in hidden}
        task_level = {pid: tids for pid, tids in task_level.items() if pid not in hidden}

    team_user_ids: set[str] = set()

    # Project-level: manager sees all team members in those projects
    if project_level_ids:
        project_team = await ResourceAssignment.find({
            "project_id": {"$in": list(project_level_ids)},
            "user_id": {"$ne": manager_id},
            "deleted_on": None,
            "status": "active",
        }).to_list()
        team_user_ids.update(a.user_id for a in project_team)

    # Task-level: manager sees only members assigned to those specific tasks
    for project_id, task_ids in task_level.items():
        task_team = await ResourceAssignment.find({
            "project_id": project_id,
            "task_id": {"$in": task_ids},
            "user_id": {"$ne": manager_id},
            "deleted_on": None,
            "status": "active",
        }).to_list()
        team_user_ids.update(a.user_id for a in task_team)

    # Restrict to employees in the login user's business unit.
    team_user_ids = await _filter_users_to_login_scope(user, team_user_ids)

    return list(team_user_ids)


async def _reporting_line_scope(user: UserBase) -> tuple[list, set[str]]:
    """Whose timesheets this user can *watch* through their reporting line.

    A senior manager is not an approver on their reports' projects — no assignment,
    no headship — so those timesheets are invisible to them in the normal view. This
    opens the projects headed by their direct L1/L2 reports, and the people booking
    time to those projects.

    Read-only by construction: the approval endpoints resolve the actor's own
    approver scope, which this deliberately does not touch, so a timesheet reachable
    only through here cannot be approved or rejected.

    Returns:
        ``(employee_user_ids, project_ids)`` — both empty when nobody reports to
        this user, or when no reportee heads a project.
    """
    reportees = await fetch_reportee_user_ids(user.id, user.organisation_id)
    if not reportees:
        return [], set()

    projects = await Project.find({
        "organisation_id": user.organisation_id,
        "project_head_ids": {"$in": reportees},
        "deleted_on": None,
    }).to_list()
    if not projects:
        return [], set()

    hidden = set(await hidden_project_ids(user))
    project_ids = {p.id for p in projects if p.id not in hidden}
    if not project_ids:
        return [], set()

    assignments = await ResourceAssignment.find({
        "project_id": {"$in": list(project_ids)},
        "organisation_id": user.organisation_id,
        "user_id": {"$ne": user.id},
        "deleted_on": None,
        "status": "active",
    }).to_list()

    team = await _filter_users_to_login_scope(user, {a.user_id for a in assignments})
    return list(team), {str(pid) for pid in project_ids}


async def _get_manager_visible_scope(
    user: UserBase,
) -> tuple[set[str], dict[str, set[str]]]:
    """Return the set of projects/tasks the manager can see entries for.

    Returns:
        project_level_ids  – projects where manager has full visibility (all tasks visible) as str set
        task_level_map     – {project_id str: {task_id str, …}} for task-scoped access only

    Projects whose client is outside the manager's business unit / department are
    excluded (hard filter), so this scope drives BU/department-restricted views.
    """
    assignments, headed_project_ids = await _approver_assignments(user)

    # Convert PydanticObjectId → str for uniform downstream str comparisons
    project_level: set[str] = {str(a.project_id) for a in assignments if a.task_id is None}
    project_level |= {str(pid) for pid in headed_project_ids}
    task_level: dict[str, set[str]] = {}
    for a in assignments:
        pid_str = str(a.project_id)
        if a.task_id is not None and pid_str not in project_level:
            task_level.setdefault(pid_str, set()).add(str(a.task_id))

    hidden = {str(pid) for pid in await hidden_project_ids(user)}
    if hidden:
        project_level = {p for p in project_level if p not in hidden}
        task_level = {p: t for p, t in task_level.items() if p not in hidden}

    return project_level, task_level


def _scope_entries(
    entries: list,
    project_level: set[str],
    task_level: dict[str, set[str]],
) -> list:
    """Keep the entries on any project the viewer is assigned to.

    Scope is deliberately project-wide, matching how a week becomes visible in the
    first place (``project_level | task_level.keys()``) and how approval works —
    TimesheetProjectApproval is per project, so approve/reject always acts on the
    whole project slice of a timesheet.

    Narrowing entries further to the viewer's *own* tasks used to hide every entry
    of a task-level manager whose employee logged a different task in the same
    project: the week still listed, still carried Approve/Reject, and showed
    "No entries for this week".

    project_level and task_level keys are str; e.project_id is PydanticObjectId.
    """
    scope = project_level | set(task_level.keys())
    return [e for e in entries if str(e.project_id) in scope]


async def _scoped_tpa_statuses_by_week(
    week_oids: list,
    scope_project_ids: list[str],
) -> dict[str, list[str]]:
    """Map weekly_timesheet_id (str) → per-project approval statuses, restricted to
    the manager's scope projects.

    A week absent from the returned map has no project in the manager's scope —
    i.e. it is not relevant to this manager and is hidden from their views.
    """
    tpa_by_ts: dict[str, list[str]] = {}
    if not week_oids or not scope_project_ids:
        return tpa_by_ts
    from beanie import PydanticObjectId
    scope_oids = [PydanticObjectId(pid) for pid in scope_project_ids if ObjectId.is_valid(pid)]
    if not scope_oids:
        return tpa_by_ts
    records = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": {"$in": week_oids},
        "project_id": {"$in": scope_oids},
        "deleted_on": None,
    }).to_list()
    for tpa in records:
        tpa_by_ts.setdefault(str(tpa.weekly_timesheet_id), []).append(tpa.status.value)
    return tpa_by_ts


def _ts_summary(
    doc: WeeklyTimesheet,
    name_map: dict[str, str] | None = None,
    emp_code_map: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "user_id": str(doc.user_id),
        "user_name": (name_map or {}).get(doc.user_id),
        "emp_code": (emp_code_map or {}).get(doc.user_id),
        "week_start_date": doc.week_start_date,
        "week_end_date": doc.week_end_date,
        "total_hours": doc.total_hours,
        "submitted_at": doc.submitted_at,
        "timesheet_status": doc.timesheet_status,
    }


# A past week the employee never submitted — either no timesheet exists at all, or
# one exists but is still a draft. Not a TimesheetStatusEnum member: nothing is
# stored in this state, it is derived from a week's absence at read time.
NOT_SUBMITTED = "not_submitted"

# Priority used to roll a month's per-week (manager-scoped) statuses into one
# headline status for the monthly views. Earlier entries win, so work still
# needing manager action surfaces ahead of already-decided weeks. A missing week
# outranks everything — it is the only one nobody can act on until the employee
# does something.
_MONTH_STATUS_PRIORITY = [
    NOT_SUBMITTED,
    "submitted",
    "resubmitted",
    "l1_rejected",
    "client_rejected",
    "l1_approved",
    "client_approved",
]

# The coarse filter the Team Timesheets screen offers, mapped onto week statuses.
# ``all`` is absence of a filter, so it is not listed here.
STATUS_FILTER_GROUPS: dict[str, set[str]] = {
    "pending": {"submitted", "resubmitted"},
    "approved": {"l1_approved", "client_approved"},
    "rejected": {"l1_rejected", "client_rejected"},
    "not_submitted": {NOT_SUBMITTED},
}


def _monday_of(d: datetime) -> datetime:
    d = d.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    return d - timedelta(days=d.weekday())


def _past_weeks_between(start: datetime, end: datetime) -> list[datetime]:
    """Week-start Mondays that fall inside ``[start, end]`` and have already ended.

    A week belongs to the month it *starts* in — the same rule the stored-timesheet
    query uses (``week_start_date`` between the month bounds) and the same one the
    payroll cutoff applies. Matching on overlap instead would pull the week spanning
    a month boundary into both months, and it would then be bucketed by its start
    date: asking for August would return a July row.

    The current week and anything later are excluded on purpose: a week still being
    worked has not been missed, so reporting it as not-submitted would mark every
    employee delinquent every Monday morning.
    """
    this_monday = _monday_of(datetime.now(timezone.utc))
    start, end = start.replace(tzinfo=None), end.replace(tzinfo=None)
    cur = _monday_of(start)
    if cur < start:
        cur += timedelta(weeks=1)  # the period starts mid-week; that week is not ours
    out: list[datetime] = []
    while cur <= end and cur < this_monday:
        out.append(cur)
        cur += timedelta(weeks=1)
    return out


def _rollup_month_status(week_statuses: list[str]) -> str:
    """Collapse a month's per-week statuses into a single headline status."""
    present = set(week_statuses)
    for status in _MONTH_STATUS_PRIORITY:
        if status in present:
            return status
    return TimesheetStatusEnum.SUBMITTED.value


async def get_past_submission_cutoff(user: UserBase) -> dict[str, Any]:
    """The monthly payroll cutoff, for the Team Timesheets screen.

    Read-only and deliberately narrow: the screen greys out its reopen affordance
    for months the cutoff has closed, so a manager has to be able to read these two
    fields — but not the rest of the settings record, which stays behind
    manage_settings.

    Read at the organisation level with no project override, because that is exactly
    what the enforcement in ``timesheets.service._assert_period_open`` resolves;
    anything else would advertise a boundary that is not the one applied. Per-project
    variation happens through PastSubmissionOverride records, not a different day.

    Unlike ``settings.service.get_settings`` this never creates a settings document:
    opening a screen must not write config, so an unconfigured organisation falls
    back to the model defaults instead.
    """
    from ..settings.service import get_effective_settings

    doc = await get_effective_settings(user.organisation_id)
    if doc is None:
        defaults = TimesheetSettings.model_fields
        return {
            "enabled": defaults["past_submission_cutoff_enabled"].default,
            "cutoff_day": defaults["past_submission_cutoff_day"].default,
        }
    return {
        "enabled": doc.past_submission_cutoff_enabled,
        "cutoff_day": doc.past_submission_cutoff_day,
    }


async def get_dashboard(
    user: UserBase,
    *,
    month: int | None = None,
    year: int | None = None,
) -> dict[str, Any]:
    user_ids = await _get_team_user_ids(user)

    if not user_ids:
        return {
            "total": 0, "submitted": 0, "resubmitted": 0,
            "l1_approved": 0, "l1_rejected": 0,
            "client_approved": 0, "client_rejected": 0,
        }

    filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "user_id": {"$in": user_ids},
        "deleted_on": None,
        "timesheet_status": {"$ne": TimesheetStatusEnum.DRAFT},
    }
    if month and year:
        start, end = _month_range(year, month)
        filt["week_start_date"] = {"$gte": start, "$lte": end}

    all_ts = await WeeklyTimesheet.find(filt).to_list()

    if not all_ts:
        return {
            "total": 0, "submitted": 0, "resubmitted": 0,
            "l1_approved": 0, "l1_rejected": 0,
            "client_approved": 0, "client_rejected": 0,
        }

    # Count only weeks that touch one of this manager's projects, using their
    # scoped per-project statuses (consistent with the team-timesheets list).
    # Every counted week resolves to one of the six buckets below, so `total`
    # always equals their sum.
    project_level, task_level = await _get_manager_visible_scope(user)
    scope_project_ids = list(project_level | set(task_level.keys()))
    tpa_by_ts = await _scoped_tpa_statuses_by_week([ts.id for ts in all_ts], scope_project_ids)

    counts: dict[str, int] = {}
    total = 0
    for ts in all_ts:
        statuses = tpa_by_ts.get(str(ts.id))
        if not statuses:
            continue  # no project in this manager's scope → not their timesheet
        key = _compute_manager_scoped_status(statuses, ts.timesheet_status.value)
        counts[key] = counts.get(key, 0) + 1
        total += 1

    return {
        "total": total,
        "submitted": counts.get("submitted", 0),
        "resubmitted": counts.get("resubmitted", 0),
        "l1_approved": counts.get("l1_approved", 0),
        "l1_rejected": counts.get("l1_rejected", 0),
        "client_approved": counts.get("client_approved", 0),
        "client_rejected": counts.get("client_rejected", 0),
    }


NOT_SUBMITTED_LOOKBACK_MONTHS = 6


async def _missing_weeks(
    user: UserBase,
    team_ids: list,
    period_start: datetime,
    period_end: datetime,
    scope_project_ids: list[str],
    *,
    covered: set[tuple],
) -> list[tuple]:
    """``(user_id, monday)`` for past weeks a team member never submitted.

    A week is missing when no submitted timesheet of that employee's covers it —
    either nothing was ever created, or what exists is still a draft. Both read the
    same way to a manager chasing time, so both surface as ``not_submitted``.

    Bounded on both sides so the gap list stays truthful:

    * only weeks that have already ended (see ``_past_weeks_between``);
    * only weeks on or after the employee's earliest active assignment to one of
      this manager's projects, so nobody is shown as missing time for weeks before
      they joined the work.

    Args:
        covered: ``(user_id_str, week_start_date)`` pairs already accounted for by a
            stored timesheet, so a week is never reported both ways.
    """
    weeks = _past_weeks_between(period_start, period_end)
    if not weeks or not team_ids or not scope_project_ids:
        return []

    from beanie import PydanticObjectId
    scope_oids = [PydanticObjectId(pid) for pid in scope_project_ids if ObjectId.is_valid(pid)]
    if not scope_oids:
        return []

    assignments = await ResourceAssignment.find({
        "user_id": {"$in": team_ids},
        "project_id": {"$in": scope_oids},
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "status": "active",
    }).to_list()

    # Earliest date each employee could have logged time on this manager's work.
    joined: dict[str, datetime | None] = {}
    for a in assignments:
        key = str(a.user_id)
        start = a.start_date.replace(tzinfo=None) if a.start_date else None
        if key not in joined:
            joined[key] = start
        elif start and joined[key]:
            joined[key] = min(joined[key], start)
        else:
            joined[key] = None  # an assignment with no start date covers everything

    out: list[tuple] = []
    for uid in team_ids:
        key = str(uid)
        if key not in joined:
            continue  # not assigned to any of this manager's projects
        floor = joined[key]
        for monday in weeks:
            if floor and monday + timedelta(days=6) < floor:
                continue
            if (key, monday.date()) in covered:
                continue
            out.append((uid, monday))
    return out


async def list_team_timesheets(
    user: UserBase,
    p: PageParams,
    *,
    timesheet_status: str | None = None,
    status_filter: str | None = None,
    scope: str = "own",
    user_id: str | None = None,
    month: int | None = None,
    year: int | None = None,
    search: str | None = None,
) -> dict[str, Any]:
    """List team timesheets aggregated to one row per employee per month.

    Each item carries the month's scoped total hours, a status rollup + counts,
    and a nested ``weeks`` list (one summary per weekly timesheet) so the UI can
    expand a month without an extra request. Pagination is over employee-months.

    Weeks an employee never submitted are included as ``not_submitted`` rows with no
    ``id`` and zero hours — a manager chasing missing time needs to see the gap, and
    a week with no record is invisible to a query over stored timesheets. Only weeks
    that have *ended* are filled in, and only back as far as the employee was
    actually assigned to one of this manager's projects.

    Args:
        timesheet_status: Exact stored status, unchanged.
        status_filter: The screen's coarse filter — ``pending``, ``approved``,
            ``rejected``, ``not_submitted``, or ``all`` (the default).
        scope: ``own`` (default) for the timesheets this user approves, or
            ``reporting`` for those of employees on projects headed by their L1/L2
            reports. The reporting view is read-only — see ``read_only`` on the
            response — because approval scope is resolved independently by the
            approve/reject endpoints and never consults the reporting line. It also
            omits the ``not_submitted`` rows: an unfiled week is something to chase,
            and chasing it belongs to the manager who can act on it.
    """
    read_only = scope == "reporting"
    if read_only:
        team_ids, reporting_project_ids = await _reporting_line_scope(user)
    else:
        team_ids = await _get_team_user_ids(user)
        reporting_project_ids = set()
    if user_id:
        team_ids = [eid for eid in team_ids if str(eid) == user_id]

    name_map = await resolve_user_names(team_ids, user.organisation_id)
    emp_code_map = await resolve_emp_codes(team_ids, user.organisation_id)

    if search:
        q = search.lower()
        team_ids = [
            uid for uid in team_ids
            if q in str(uid).lower() or q in (name_map.get(uid, "")).lower()
        ]

    if not team_ids:
        return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size,
                "read_only": read_only}

    filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "user_id": {"$in": team_ids},
        "deleted_on": None,
        "timesheet_status": {"$ne": TimesheetStatusEnum.DRAFT},
    }
    if timesheet_status:
        filt["timesheet_status"] = timesheet_status
    if month and year:
        period_start, period_end = _month_range(year, month)
        filt["week_start_date"] = {"$gte": period_start, "$lte": period_end}
    else:
        # No month picked: fill gaps over a bounded recent window rather than the
        # whole of history, which would invent rows back to the epoch.
        period_end = datetime.now(timezone.utc)
        period_start = period_end - timedelta(days=NOT_SUBMITTED_LOOKBACK_MONTHS * 31)

    all_weeks = await WeeklyTimesheet.find(filt).sort("-week_start_date").to_list()

    # Keep only weeks that actually touch one of THIS manager's projects, and use
    # the scoped per-project statuses to drive the displayed status. In the reporting
    # view the projects come from the reporting line instead, so the same downstream
    # code renders both without knowing which it is looking at.
    if read_only:
        project_level, task_level = reporting_project_ids, {}
    else:
        project_level, task_level = await _get_manager_visible_scope(user)
    scope_project_ids = list(project_level | set(task_level.keys()))
    tpa_by_ts = await _scoped_tpa_statuses_by_week([w.id for w in all_weeks], scope_project_ids)
    relevant_weeks = [w for w in all_weeks if str(w.id) in tpa_by_ts]

    # Displayed status per week, resolved once: the coarse filter below and the
    # month rollup both need it, and it is derived, not stored.
    status_of = {
        str(w.id): _compute_manager_scoped_status(
            tpa_by_ts.get(str(w.id), []), w.timesheet_status.value,
        )
        for w in relevant_weeks
    }

    # The screen's Pending / Approved / Rejected filter. Applied before paging so
    # `total` counts what the caller will actually receive.
    allowed = STATUS_FILTER_GROUPS.get((status_filter or "all").lower())
    if allowed is not None:
        relevant_weeks = [w for w in relevant_weeks if status_of[str(w.id)] in allowed]

    # Bucket the relevant weeks by employee-month.
    buckets: dict[tuple, dict[str, Any]] = {}
    for w in relevant_weeks:
        key = (str(w.user_id), w.week_start_date.year, w.week_start_date.month)
        bucket = buckets.setdefault(
            key,
            {"user_id": w.user_id, "year": key[1], "month": key[2],
             "weeks": [], "missing": []},
        )
        bucket["weeks"].append(w)

    # `covered` is deliberately built from every stored week, not the filtered set:
    # a week that exists but was filtered out is still not missing.
    #
    # Skipped entirely in the reporting view: chasing unfiled time is the approving
    # manager's job, and a viewer who cannot act on the gap does not need it listed.
    missing = []
    if not read_only and (allowed is None or NOT_SUBMITTED in allowed):
        missing = await _missing_weeks(
            user, team_ids, period_start, period_end, scope_project_ids,
            covered={(str(w.user_id), w.week_start_date.date()) for w in all_weeks},
        )
    for uid, monday in missing:
        key = (str(uid), monday.year, monday.month)
        bucket = buckets.setdefault(
            key,
            {"user_id": uid, "year": key[1], "month": key[2],
             "weeks": [], "missing": []},
        )
        bucket["missing"].append(monday)

    # Latest month first, then by employee name for stable ordering.
    ordered = sorted(
        buckets.values(),
        key=lambda b: (name_map.get(b["user_id"], "") or str(b["user_id"])),
    )
    ordered.sort(key=lambda b: (b["year"], b["month"]), reverse=True)

    total = len(ordered)
    skip = compute_skip(p)
    page_buckets = ordered[skip : skip + p.page_size]

    # Compute scoped hours for the weeks on this page only.
    page_week_docs = [w for b in page_buckets for w in b["weeks"]]
    ts_oids = [w.id for w in page_week_docs]
    scoped_hours: dict[str, float] = {str(w.id): 0.0 for w in page_week_docs}
    if ts_oids:
        page_entries = await TimesheetEntry.find({
            "weekly_timesheet_id": {"$in": ts_oids},
            "deleted_on": None,
        }).to_list()
        for e in _scope_entries(page_entries, project_level, task_level):
            scoped_hours[str(e.weekly_timesheet_id)] = scoped_hours.get(str(e.weekly_timesheet_id), 0.0) + e.hours

    result_items = []
    for b in page_buckets:
        uid = b["user_id"]
        week_rows = []
        week_statuses: list[str] = []
        month_total = 0.0
        for w in b["weeks"]:
            wid = str(w.id)
            w_status = status_of[wid]
            w_hours = scoped_hours.get(wid, 0.0)
            month_total += w_hours
            week_statuses.append(w_status)
            week_rows.append({
                "id": wid,
                "week_start_date": w.week_start_date,
                "week_end_date": w.week_end_date,
                "total_hours": w_hours,
                "submitted_at": w.submitted_at,
                "timesheet_status": w_status,
            })

        # Weeks with nothing behind them. `id` is null because there is no document
        # to open — the row exists to show the gap, not to link to a timesheet.
        for monday in b["missing"]:
            week_statuses.append(NOT_SUBMITTED)
            week_rows.append({
                "id": None,
                "week_start_date": monday,
                "week_end_date": monday + timedelta(days=6),
                "total_hours": 0.0,
                "submitted_at": None,
                "timesheet_status": NOT_SUBMITTED,
            })

        week_rows.sort(key=lambda r: r["week_start_date"], reverse=True)

        status_counts: dict[str, int] = {}
        for s in week_statuses:
            status_counts[s] = status_counts.get(s, 0) + 1

        period_start, period_end = _month_range(b["year"], b["month"])
        result_items.append({
            "user_id": str(uid),
            "user_name": name_map.get(uid),
            "emp_code": emp_code_map.get(uid),
            "year": b["year"],
            "month": b["month"],
            "month_label": f"{b['year']:04d}-{b['month']:02d}",
            "period_start": period_start,
            "period_end": period_end,
            "total_hours": month_total,
            "week_count": len(week_rows),
            "timesheet_status": _rollup_month_status(week_statuses),
            "status_counts": status_counts,
            "weeks": week_rows,
        })

    return {
        "items": result_items,
        "total": total,
        "page": p.page,
        "page_size": p.page_size,
        # The reporting view is for oversight, not action. Advisory for the UI only:
        # the approve/reject endpoints resolve approver scope themselves and reject
        # anything reachable only through the reporting line.
        "read_only": read_only,
    }


async def list_team_resources(
    user: UserBase,
    from_date: str,
    to_date: str,
) -> list[dict[str, Any]]:
    team_ids = await _get_team_user_ids(user)
    if not team_ids:
        return []

    assignments = await ResourceAssignment.find({
        "user_id": {"$in": team_ids},
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "status": "active",
    }).to_list()

    resource_user_ids = list(dict.fromkeys(a.user_id for a in assignments))

    if not resource_user_ids:
        return []

    name_map = await resolve_user_names(resource_user_ids, user.organisation_id)
    emp_code_map = await resolve_emp_codes(resource_user_ids, user.organisation_id)

    id_strs = [str(uid) for uid in resource_user_ids]

    lms_data: dict[str, Any] = {}
    try:
        result = await get_employee_leave_calendar(id_strs, from_date, to_date)
        lms_data = result.get("data", {})
    except LMSUnavailable:
        pass

    # Work-calendar (weekoffs + raw matrix/config) from the LMS shift details
    cal_by_user = await fetch_work_calendars(id_strs, from_date, to_date)
    _empty_cal = {"weekoffs": [], "weekend_matrix": None, "week_config": None}

    return [
        {
            "user_id": str(uid),
            "name": name_map.get(uid),
            "emp_code": emp_code_map.get(uid),
            "leaves": lms_data.get(str(uid), {}).get("leaves", []),
            "holidays": lms_data.get(str(uid), {}).get("holidays", []),
            "work_calendar": cal_by_user.get(str(uid)) or _empty_cal,
        }
        for uid in resource_user_ids
    ]


async def _fetch_leave_calendar(user_id, from_date: str, to_date: str) -> tuple[list, list]:
    """One employee's approved leaves and holidays for a date range, from LMS.

    Degrades to empty lists when LMS is unavailable — an approver's view of a
    timesheet must still render without the leave service. The RPC has no timeout of
    its own, so one is applied here rather than letting the request hang.

    Returns:
        Tuple of (leaves, holidays) exactly as LMS reports them.
    """
    try:
        result = await asyncio.wait_for(
            get_employee_leave_calendar([str(user_id)], from_date, to_date),
            timeout=_LEAVE_RPC_TIMEOUT,
        )
    except (LMSUnavailable, asyncio.TimeoutError) as exc:
        logger.warning("leave_calendar unavailable (%s) — empty leaves/holidays", exc)
        return [], []
    entry = (result.get("data", {}) or {}).get(str(user_id), {}) or {}
    return entry.get("leaves", []), entry.get("holidays", [])


async def _load_for_approval(timesheet_id: str, organisation_id: str) -> WeeklyTimesheet:
    doc = await WeeklyTimesheet.get(timesheet_id)
    if not doc or doc.deleted_on or doc.organisation_id != organisation_id:
        raise TimesheetNotFound()
    return doc


def _compute_manager_scoped_status(
    scope_tpa_statuses: list[str],
    aggregate_status: str,
) -> str:
    """Derive the timesheet status from THIS manager's perspective.

    Uses per-project statuses only for their assigned projects. Falls back to
    the aggregate status for client-level outcomes (client_approved / client_rejected)
    which the manager has no influence over.
    """
    # Client decisions are final from everyone's perspective
    if aggregate_status in ("client_approved", "client_rejected"):
        return aggregate_status

    if not scope_tpa_statuses:
        # Manager has no projects in this timesheet — show aggregate as-is
        return aggregate_status

    statuses = set(scope_tpa_statuses)
    # Manager rejected at least one of their projects
    if "l1_rejected" in statuses:
        return "l1_rejected"
    # All of the manager's projects are approved (or beyond)
    if all(s in {"l1_approved", "client_approved", "client_rejected"} for s in statuses):
        return "l1_approved"
    # Employee resubmitted after a rejection
    if "resubmitted" in statuses:
        return "resubmitted"
    return "submitted"


def _compute_aggregate_status(project_statuses: list[str]) -> TimesheetStatusEnum:
    """Derive the overall timesheet status from per-project approval statuses."""
    if not project_statuses:
        return TimesheetStatusEnum.SUBMITTED
    statuses = set(project_statuses)
    # L1 rejection → employee must fix those projects
    if "l1_rejected" in statuses:
        return TimesheetStatusEnum.L1_REJECTED
    # Client rejection → employee must fix those projects
    if "client_rejected" in statuses:
        return TimesheetStatusEnum.CLIENT_REJECTED
    # All client approved → fully done
    if statuses <= {"client_approved"}:
        return TimesheetStatusEnum.CLIENT_APPROVED
    # All L1 approved (some may also be client_approved) → ready for client review
    if statuses <= {"l1_approved", "client_approved"}:
        return TimesheetStatusEnum.L1_APPROVED
    # Some projects resubmitted after a rejection → pending L1 re-review
    if "resubmitted" in statuses:
        return TimesheetStatusEnum.RESUBMITTED
    # Still fresh submission, waiting for L1
    return TimesheetStatusEnum.SUBMITTED


async def approve_timesheet(timesheet_id: str, body: ApprovalAction, user: UserBase, role: str = "manager") -> dict[str, Any]:
    doc = await _load_for_approval(timesheet_id, user.organisation_id)

    now = utcnow()

    if role == "manager":
        await _assert_employee_in_login_scope(user, doc.user_id)
        level = 1
        approver_role = ApproverRoleEnum.MANAGER
        project_level, task_level = await _get_manager_visible_scope(user)
        scope_ids = list(project_level | set(task_level.keys()))
        approvable_statuses = {
            ProjectApprovalStatusEnum.SUBMITTED,
            ProjectApprovalStatusEnum.RESUBMITTED,
        }
    else:
        level = 2
        approver_role = ApproverRoleEnum.CLIENT
        scope_ids = await _get_client_project_ids(user.id, user.organisation_id)
        # Restrict to projects that actually require client approval — the client
        # can view no-client-approval projects but cannot act on them
        scope_ids = await _client_actionable_project_ids(scope_ids)
        approvable_statuses = {ProjectApprovalStatusEnum.L1_APPROVED}

    # Load per-project approval records
    all_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    # tpa_map keyed by str(project_id) so it matches scope_ids (which are str)
    tpa_map = {str(tpa.project_id): tpa for tpa in all_tpa}

    # Find projects in scope that are in an actionable state
    actionable = [
        pid for pid in scope_ids
        if pid in tpa_map and tpa_map[pid].status in approvable_statuses
    ]
    if not actionable:
        raise TimesheetNotApprovable()

    # Update each actionable project approval
    for project_id in actionable:
        tpa = tpa_map[project_id]
        if role == "manager":
            tpa.status = ProjectApprovalStatusEnum.L1_APPROVED
            tpa.l1_approver_id = user.id
            tpa.l1_acted_at = now
            tpa.l1_comments = body.comments
        else:
            tpa.status = ProjectApprovalStatusEnum.CLIENT_APPROVED
            tpa.client_approver_id = user.id
            tpa.client_acted_at = now
            tpa.client_comments = body.comments
        tpa.modified_by = user.id
        tpa.modified_on = now
        await tpa.save()

    # Recompute aggregate timesheet status from all TPA records
    refreshed_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    aggregate_status = _compute_aggregate_status([t.status.value for t in refreshed_tpa])

    # If client approval is not required, skip l1_approved → go straight to client_approved
    if role == "manager" and aggregate_status == TimesheetStatusEnum.L1_APPROVED:
        settings = await TimesheetSettings.find_one({
            "organisation_id": user.organisation_id, "project_id": None,
        })
        if settings and not settings.approval_required:
            aggregate_status = TimesheetStatusEnum.CLIENT_APPROVED

    doc.timesheet_status = aggregate_status
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    # Journey worked-hours metric — emit once the week is fully approved. Keyed
    # per weekly timesheet so the L1 + client approval calls don't double-count.
    if aggregate_status == TimesheetStatusEnum.CLIENT_APPROVED:
        await outbox.publish(
            "timesheet.approved",
            {
                "user_id": str(doc.user_id),
                "organisation_id": str(doc.organisation_id),
                "hours": doc.total_hours,
                "period_end": doc.week_end_date.isoformat() if doc.week_end_date else None,
            },
            idempotency_key=f"timesheet.approved:{doc.id}",
        )

    # Audit record (scope_project_ids are str — model field is list[PydanticObjectId], Pydantic will coerce)
    record = ApprovalRecord(
        organisation_id=user.organisation_id,
        weekly_timesheet_id=doc.id,
        approver_id=user.id,
        approver_role=approver_role,
        approval_level=level,
        action=ApprovalActionEnum.APPROVED,
        comments=body.comments,
        acted_at=now,
        scope_project_ids=actionable,
        created_by=user.id,
        created_on=now,
    )
    await record.insert()

    for pid in actionable:
        await emit_activity(
            action="timesheet.approved",
            resource=f"timesheet:{str(doc.id)}",
            actor_id=str(user.id),
            organisation_id=str(user.organisation_id),
            details={"timesheet_id": str(doc.id), "project_id": str(pid), "user_id": str(doc.user_id), "level": level, "role": role},
        )

    try:
        approver_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.display_name or str(user.id)
        await notify_timesheet_approved(doc, approver_name, level, role)
    except Exception:
        logger.exception("notify_timesheet_approved failed (non-blocking)")

    # After L1 approval, notify client/project-heads to review via magic link
    if role == "manager" and aggregate_status == TimesheetStatusEnum.L1_APPROVED:
        try:
            await notify_l1_approved_to_client(doc, actionable, user.organisation_id)
        except Exception:
            logger.exception("notify_l1_approved_to_client failed (non-blocking)")

    # Budget threshold alert — check the just-approved projects. The function
    # self-filters per project (counts client_approved work, plus l1_approved
    # for no-client-approval projects) and de-dupes via the email idempotency key.
    try:
        await notify_budget_threshold_alert(actionable, user.organisation_id)
    except Exception:
        logger.exception("notify_budget_threshold_alert failed (non-blocking)")

    return _ts_summary(doc)


async def reject_timesheet(timesheet_id: str, body: RejectionAction, user: UserBase, role: str = "manager") -> dict[str, Any]:
    """Reject a timesheet, or withdraw an approval already given.

    A manager may reject a project they have already approved. Mistakes surface after
    sign-off — wrong task, hours on the wrong week — and without this the only remedy
    was to approve something known to be wrong and correct it out of band.

    Withdrawal stops at the client's door: a project the client has already approved
    is not reversible here, because reversing it would contradict a decision taken
    above this level and one the client believes is settled. Those need the client to
    reject, or the month to be handled deliberately.
    """
    doc = await _load_for_approval(timesheet_id, user.organisation_id)

    now = utcnow()

    if role == "manager":
        await _assert_employee_in_login_scope(user, doc.user_id)
        level = 1
        approver_role = ApproverRoleEnum.MANAGER
        project_level, task_level = await _get_manager_visible_scope(user)
        scope_ids = list(project_level | set(task_level.keys()))
        rejectable_statuses = {
            ProjectApprovalStatusEnum.SUBMITTED,
            ProjectApprovalStatusEnum.RESUBMITTED,
            # An approval this manager already gave, withdrawn.
            ProjectApprovalStatusEnum.L1_APPROVED,
        }
    else:
        level = 2
        approver_role = ApproverRoleEnum.CLIENT
        scope_ids = await _get_client_project_ids(user.id, user.organisation_id)
        # Restrict to projects that actually require client approval — the client
        # can view no-client-approval projects but cannot act on them
        scope_ids = await _client_actionable_project_ids(scope_ids)
        rejectable_statuses = {ProjectApprovalStatusEnum.L1_APPROVED}

    # Load per-project approval records
    all_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    tpa_map = {str(tpa.project_id): tpa for tpa in all_tpa}

    # Find projects in scope that can be rejected
    rejectable = [
        pid for pid in scope_ids
        if pid in tpa_map and tpa_map[pid].status in rejectable_statuses
    ]
    if not rejectable:
        raise TimesheetNotApprovable()

    # Projects whose approval is being withdrawn rather than withheld. Recorded
    # separately because an auditor reading the stream needs to tell "reviewed and
    # rejected" from "signed off, then unsigned".
    withdrawn = [
        pid for pid in rejectable
        if tpa_map[pid].status == ProjectApprovalStatusEnum.L1_APPROVED
    ]

    # Update each rejectable project approval
    for project_id in rejectable:
        tpa = tpa_map[project_id]
        if role == "manager":
            tpa.status = ProjectApprovalStatusEnum.L1_REJECTED
            tpa.l1_approver_id = user.id
            tpa.l1_acted_at = now
            tpa.l1_comments = body.comments
        else:
            tpa.status = ProjectApprovalStatusEnum.CLIENT_REJECTED
            tpa.client_approver_id = user.id
            tpa.client_acted_at = now
            tpa.client_comments = body.comments
        tpa.modified_by = user.id
        tpa.modified_on = now
        await tpa.save()

    # Recompute aggregate timesheet status
    refreshed_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "deleted_on": None,
    }).to_list()
    aggregate_status = _compute_aggregate_status([t.status.value for t in refreshed_tpa])
    doc.timesheet_status = aggregate_status
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    # Audit record (scope_project_ids are str — Pydantic coerces to PydanticObjectId)
    record = ApprovalRecord(
        organisation_id=user.organisation_id,
        weekly_timesheet_id=doc.id,
        approver_id=user.id,
        approver_role=approver_role,
        approval_level=level,
        action=ApprovalActionEnum.REJECTED,
        comments=body.comments,
        acted_at=now,
        scope_project_ids=rejectable,
        created_by=user.id,
        created_on=now,
    )
    await record.insert()

    for pid in rejectable:
        await emit_activity(
            action=("timesheet.approval_withdrawn" if pid in withdrawn
                    else "timesheet.rejected"),
            resource=f"timesheet:{str(doc.id)}",
            actor_id=str(user.id),
            organisation_id=str(user.organisation_id),
            details={"timesheet_id": str(doc.id), "project_id": str(pid), "user_id": str(doc.user_id), "level": level, "role": role, "comments": body.comments},
        )

    try:
        approver_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.display_name or str(user.id)
        await notify_timesheet_rejected(doc, approver_name, level, role, body.comments)
    except Exception:
        logger.exception("notify_timesheet_rejected failed (non-blocking)")

    return _ts_summary(doc)


async def bulk_approve(body: BulkApprovalAction, user: UserBase, role: str = "manager") -> list[dict[str, Any]]:
    results = []
    for ts_id in body.timesheet_ids:
        action = ApprovalAction(comments=body.comments)
        result = await approve_timesheet(ts_id, action, user, role)
        results.append(result)
    return results


async def bulk_reject(body: BulkRejectionAction, user: UserBase, role: str = "manager") -> list[dict[str, Any]]:
    results = []
    for ts_id in body.timesheet_ids:
        action = RejectionAction(comments=body.comments)
        result = await reject_timesheet(ts_id, action, user, role)
        results.append(result)
    return results


async def get_timesheet_detail(timesheet_id: str, user: UserBase) -> dict[str, Any]:
    from beanie import PydanticObjectId
    doc = await _load_for_approval(timesheet_id, user.organisation_id)
    await _assert_employee_in_login_scope(user, doc.user_id)

    all_entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("entry_date").to_list()

    # Scope entries to only the projects/tasks this manager is assigned to
    project_level, task_level = await _get_manager_visible_scope(user)

    # Nothing on this timesheet is theirs to approve — they may still be watching it
    # through their reporting line, so fall back to that scope. Tried second, so an
    # approver always gets their approver view: the two can overlap, and the one that
    # carries actions must win.
    #
    # `read_only` means one thing everywhere: this viewer cannot act here. That
    # covers a sheet they only watch and a sheet they have no claim on at all —
    # different reasons, same answer for a caller deciding whether to offer buttons.
    sheet_projects = {str(e.project_id) for e in all_entries}
    read_only = not (sheet_projects & (project_level | set(task_level.keys())))
    if read_only:
        _, reporting_projects = await _reporting_line_scope(user)
        if sheet_projects & reporting_projects:
            project_level, task_level = reporting_projects, {}

    entries = _scope_entries(all_entries, project_level, task_level)

    # str set of every project this manager can see on this timesheet
    scope_project_ids_set = project_level | set(task_level.keys())

    all_approval_records = await ApprovalRecord.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("acted_at").to_list()

    # Only show approval records that touch at least one of the manager's projects,
    # so decisions taken on other managers' projects stay hidden.
    approval_history = [
        ar for ar in all_approval_records
        if not ar.scope_project_ids
        or any(str(pid) in scope_project_ids_set for pid in ar.scope_project_ids)
    ]

    # e.project_id / e.task_id are PydanticObjectId — use directly in _id queries
    project_ids = list({e.project_id for e in entries})
    task_ids = list({e.task_id for e in entries})
    projects = await Project.find({"_id": {"$in": project_ids}}).to_list() if project_ids else []
    tasks = await Task.find({"_id": {"$in": task_ids}}).to_list() if task_ids else []
    proj_map = {str(p.id): p.name for p in projects}
    task_map = {str(t.id): t.name for t in tasks}

    # Per-project approval state — scoped to THIS manager's assigned projects only
    scope_oids = [PydanticObjectId(pid) for pid in scope_project_ids_set if ObjectId.is_valid(pid)]
    all_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "project_id": {"$in": scope_oids},
        "deleted_on": None,
    }).to_list() if scope_oids else []

    day_names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    rows: dict[str, dict[str, Any]] = {}
    for e in entries:
        pid_str = str(e.project_id)
        tid_str = str(e.task_id)
        key = f"{pid_str}|{tid_str}"
        if key not in rows:
            rows[key] = {
                "project_id": pid_str,
                "project_name": proj_map.get(pid_str, pid_str),
                "task_id": tid_str,
                "task_name": task_map.get(tid_str, tid_str),
                "mon": 0, "tue": 0, "wed": 0, "thu": 0, "fri": 0, "sat": 0, "sun": 0,
                "total": 0,
            }
        dow = e.entry_date.weekday()
        if 0 <= dow <= 6:
            rows[key][day_names[dow]] += e.hours
            rows[key]["total"] += e.hours

    # Batch-resolve all user names: employee + approval history actors + TPA approvers
    tpa_actor_ids = [
        uid for tpa in all_tpa
        for uid in [tpa.l1_approver_id, tpa.client_approver_id]
        if uid
    ]
    name_map = await resolve_user_names(
        [doc.user_id] + [ar.approver_id for ar in approval_history] + tpa_actor_ids,
        user.organisation_id,
    )
    emp_code_map = await resolve_emp_codes([doc.user_id], user.organisation_id)

    # Build project_approvals with resolved names
    project_approvals = [
        {
            "project_id": str(tpa.project_id),
            "project_name": proj_map.get(str(tpa.project_id), str(tpa.project_id)),
            "status": tpa.status,
            "submitted_by_id": str(doc.user_id),
            "submitted_by_name": name_map.get(doc.user_id),
            "l1_approver_id": str(tpa.l1_approver_id) if tpa.l1_approver_id else None,
            "l1_approver_name": name_map.get(tpa.l1_approver_id) if tpa.l1_approver_id else None,
            "l1_acted_at": tpa.l1_acted_at,
            "l1_comments": tpa.l1_comments,
            "client_approver_id": str(tpa.client_approver_id) if tpa.client_approver_id else None,
            "client_approver_name": name_map.get(tpa.client_approver_id) if tpa.client_approver_id else None,
            "client_acted_at": tpa.client_acted_at,
            "client_comments": tpa.client_comments,
        }
        for tpa in all_tpa
    ]

    history = []
    if doc.submitted_at:
        history.append({
            "id": "submitted",
            "approver_id": str(doc.user_id),
            "approver_name": name_map.get(doc.user_id),
            "approver_role": "employee",
            "approval_level": 0,
            "action": "submitted",
            "comments": doc.notes or None,
            "acted_at": doc.submitted_at,
            "scope_project_ids": [],
        })
    for ar in approval_history:
        history.append({
            "id": str(ar.id),
            "approver_id": str(ar.approver_id),
            "approver_name": name_map.get(ar.approver_id),
            "approver_role": ar.approver_role,
            "approval_level": ar.approval_level,
            "action": ar.action,
            "comments": ar.comments,
            "acted_at": ar.acted_at,
            "scope_project_ids": [str(pid) for pid in ar.scope_project_ids],
        })

    from ..timesheets.service import _entry_to_out
    scoped_total = sum(e.hours for e in entries)

    # Derive timesheet_status from THIS manager's perspective (all_tpa already scoped)
    scoped_ts_status = _compute_manager_scoped_status(
        [tpa.status.value for tpa in all_tpa],
        doc.timesheet_status.value,
    )

    # Work calendar (weekoffs + raw matrix/config) for the employee's week
    week_from = doc.week_start_date.date().isoformat()
    week_to = doc.week_end_date.date().isoformat()
    cal_by_user = await fetch_work_calendars([str(doc.user_id)], week_from, week_to)
    work_calendar = cal_by_user.get(str(doc.user_id)) or {
        "weekoffs": [], "weekend_matrix": None, "week_config": None,
    }
    # Approved leave and holidays for the same week, so an approver can tell a
    # genuinely empty day from one the employee was not expected to work.
    leaves, holidays = await _fetch_leave_calendar(doc.user_id, week_from, week_to)

    # Reopening is granted per month, and a week belongs to the month it starts in —
    # which is not always the month the caller has selected on the dashboard, for a
    # week that straddles a boundary. `reopen_period` names the month this flag is
    # about, so the two can be seen to differ rather than silently disagreeing.
    reopen_year = doc.week_start_date.year
    reopen_month = doc.week_start_date.month
    from ..past_submissions.service import can_reopen_month
    can_reopen = await can_reopen_month(user, str(doc.user_id), reopen_year, reopen_month)

    return {
        **_ts_summary(doc, name_map, emp_code_map),
        "timesheet_status": scoped_ts_status,
        "total_hours": scoped_total,
        "project_approvals": project_approvals,
        "entries": [_entry_to_out(e) for e in entries],
        "weekly_timeline": list(rows.values()),
        "work_calendar": work_calendar,
        "leaves": leaves,
        "holidays": holidays,
        "approval_history": history,
        # True when this sheet is reachable only through the reporting line. Advisory
        # for the UI; approve/reject enforce it themselves.
        "read_only": read_only,
        "can_reopen": can_reopen,
        "reopen_period": {"year": reopen_year, "month": reopen_month},
    }


async def get_monthly_timesheet_detail(
    target_user_id: str,
    user: UserBase,
    *,
    month: int,
    year: int,
) -> dict[str, Any]:
    """Return an employee's whole month with each week's full (scoped) detail.

    Aggregates the month's scoped hours and a status rollup, and embeds the
    existing per-week detail payload (entries, weekly timeline, project
    approvals, history) for every non-draft weekly timesheet in the month.

    Carries ``can_reopen`` for the requested month. The week payloads carry their
    own, for the month each week starts in — the two differ for a week that straddles
    a month boundary, which is why both name their period.
    """
    from ..past_submissions.service import can_reopen_month

    team_ids = await _get_team_user_ids(user)
    read_only = False
    reporting_projects: set[str] = set()
    if target_user_id not in {str(tid) for tid in team_ids}:
        # Not theirs to approve — allow it read-only if the employee is in their
        # reporting line, so the month view and its exports work from that list too.
        watched, reporting_projects = await _reporting_line_scope(user)
        if target_user_id not in {str(tid) for tid in watched}:
            raise TimesheetNotFound()
        read_only = True

    start, end = _month_range(year, month)
    target_user_oid = ObjectId(target_user_id) if ObjectId.is_valid(target_user_id) else target_user_id
    week_docs = await WeeklyTimesheet.find({
        "organisation_id": user.organisation_id,
        "user_id": target_user_oid,
        "deleted_on": None,
        "timesheet_status": {"$ne": TimesheetStatusEnum.DRAFT},
        "week_start_date": {"$gte": start, "$lte": end},
    }).sort("week_start_date").to_list()

    # Keep only weeks that touch one of this manager's projects (same scoping as
    # the monthly list), so the month detail never includes non-actionable weeks.
    # A reporting-line viewer scopes by the watched projects instead.
    if read_only:
        project_level, task_level = reporting_projects, {}
    else:
        project_level, task_level = await _get_manager_visible_scope(user)
    scope_project_ids = list(project_level | set(task_level.keys()))
    tpa_by_ts = await _scoped_tpa_statuses_by_week([w.id for w in week_docs], scope_project_ids)
    relevant_weeks = [w for w in week_docs if str(w.id) in tpa_by_ts]

    # Reuse the per-week detail builder so each week's shape matches GET /{id}.
    week_details = [await get_timesheet_detail(str(w.id), user) for w in relevant_weeks]

    name_map = await resolve_user_names([target_user_id], user.organisation_id)
    emp_code_map = await resolve_emp_codes([target_user_id], user.organisation_id)

    week_statuses = [wd.get("timesheet_status") for wd in week_details if wd.get("timesheet_status")]
    status_counts: dict[str, int] = {}
    for s in week_statuses:
        status_counts[s] = status_counts.get(s, 0) + 1
    total_hours = sum(wd.get("total_hours", 0) or 0 for wd in week_details)

    return {
        "user_id": target_user_id,
        "user_name": name_map.get(target_user_oid),
        "emp_code": emp_code_map.get(target_user_oid),
        "year": year,
        "month": month,
        "month_label": f"{year:04d}-{month:02d}",
        "period_start": start,
        "period_end": end,
        "total_hours": total_hours,
        "week_count": len(week_details),
        "timesheet_status": _rollup_month_status(week_statuses),
        "status_counts": status_counts,
        "weeks": week_details,
        "read_only": read_only,
        # The month is explicit here, so this is the flag to drive the month sheet's
        # reopen button from — no inference from whichever week happens to be open.
        "can_reopen": await can_reopen_month(user, target_user_id, year, month),
        "reopen_period": {"year": year, "month": month},
    }


async def get_employee_detail(
    target_user_id: str,
    user: UserBase,
) -> dict[str, Any]:
    team_ids = await _get_team_user_ids(user)
    if target_user_id not in {str(tid) for tid in team_ids}:
        raise TimesheetNotFound()

    target_user_oid = ObjectId(target_user_id) if ObjectId.is_valid(target_user_id) else target_user_id
    all_ts = await WeeklyTimesheet.find({
        "organisation_id": user.organisation_id,
        "user_id": target_user_oid,
        "deleted_on": None,
    }).to_list()

    counts: dict[str, int] = {}
    for ts in all_ts:
        key = ts.timesheet_status.value
        counts[key] = counts.get(key, 0) + 1

    name_map = await resolve_user_names([target_user_id], user.organisation_id)

    return {
        "user_id": target_user_id,
        "user_name": name_map.get(target_user_oid),
        "total_submitted": counts.get("submitted", 0) + counts.get("resubmitted", 0),
        "approved": counts.get("l1_approved", 0),
        "rejected": counts.get("l1_rejected", 0),
        "client_approved": counts.get("client_approved", 0),
        "pending_manager": counts.get("submitted", 0) + counts.get("resubmitted", 0),
        "pending_client": counts.get("l1_approved", 0),
        "client_rejected": counts.get("client_rejected", 0),
    }


async def list_employee_timesheets(
    target_user_id: str,
    user: UserBase,
    p: PageParams,
) -> dict[str, Any]:
    """One employee's weeks, each flagged with whether this viewer can act on it.

    ``read_only`` is per week, not per employee, because it cannot be anything else:
    this endpoint returns every non-draft week the employee filed, and consecutive
    weeks routinely touch different projects. A viewer who approves one project and
    merely watches another has weeks of both kinds in the same tab strip.

    A week is actionable only when it touches a project in the viewer's own approver
    scope. Weeks reachable through the reporting line, and weeks touching neither,
    are both read-only — from the caller's point of view they are the same answer:
    do not offer approve or reject here.
    """
    team_ids = await _get_team_user_ids(user)
    if target_user_id not in {str(tid) for tid in team_ids}:
        # Not theirs to approve — allow it read-only if the employee is in their
        # reporting line, so the tab strip works from that list too.
        watched, _ = await _reporting_line_scope(user)
        if target_user_id not in {str(tid) for tid in watched}:
            raise TimesheetNotFound()

    target_user_oid = ObjectId(target_user_id) if ObjectId.is_valid(target_user_id) else target_user_id
    filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "user_id": target_user_oid,
        "deleted_on": None,
        "timesheet_status": {"$ne": TimesheetStatusEnum.DRAFT},
    }

    name_map = await resolve_user_names([target_user_id], user.organisation_id)

    skip = compute_skip(p)
    total = await WeeklyTimesheet.find(filt).count()
    items = await WeeklyTimesheet.find(filt).sort("-week_start_date").skip(skip).limit(p.page_size).to_list()

    # Compute scoped total_hours per timesheet
    project_level, task_level = await _get_manager_visible_scope(user)
    approver_projects = project_level | set(task_level.keys())
    ts_oids = [ts.id for ts in items]
    ts_ids = [str(ts.id) for ts in items]
    scoped_hours: dict[str, float] = {ts_id: 0.0 for ts_id in ts_ids}
    projects_by_ts: dict[str, set[str]] = {ts_id: set() for ts_id in ts_ids}
    if ts_oids:
        page_entries = await TimesheetEntry.find({
            "weekly_timesheet_id": {"$in": ts_oids},
            "deleted_on": None,
        }).to_list()
        for e in page_entries:
            projects_by_ts.setdefault(str(e.weekly_timesheet_id), set()).add(str(e.project_id))
        for e in _scope_entries(page_entries, project_level, task_level):
            scoped_hours[str(e.weekly_timesheet_id)] = scoped_hours.get(str(e.weekly_timesheet_id), 0.0) + e.hours

    result_items = []
    for ts in items:
        ts_id = str(ts.id)
        summary = _ts_summary(ts, name_map)
        summary["total_hours"] = scoped_hours.get(ts_id, 0.0)
        # Actionable only where the week touches something this viewer approves.
        summary["read_only"] = not (projects_by_ts.get(ts_id, set()) & approver_projects)
        result_items.append(summary)

    return {
        "items": result_items,
        "total": total,
        "page": p.page,
        "page_size": p.page_size,
    }


# ──────────────────────────────────────────────────────────────
# Client (L2) portal functions
# ──────────────────────────────────────────────────────────────

async def _get_client_project_ids(user_id: str, organisation_id: str) -> list[str]:
    project_ids: set[str] = set()

    # Client contact user → all projects under that client
    client_doc = await Client.find_one({
        "contact_user_id": user_id,
        "organisation_id": organisation_id,
        "deleted_on": None,
    })
    if client_doc:
        projects = await Project.find({
            "client_id": client_doc.id,
            "organisation_id": organisation_id,
            "deleted_on": None,
        }).to_list()
        project_ids.update(str(p.id) for p in projects)

    # Project head → all projects under every client they head. The same person can
    # head several clients (one ClientProjectHead row per client), so union them all.
    ph_docs = await ClientProjectHead.find({
        "iam_user_id": user_id,
        "organisation_id": organisation_id,
        "deleted_on": None,
    }).to_list()
    ph_client_ids = [ph.client_id for ph in ph_docs]
    if ph_client_ids:
        ph_projects = await Project.find({
            "client_id": {"$in": ph_client_ids},
            "organisation_id": organisation_id,
            "deleted_on": None,
        }).to_list()
        project_ids.update(str(p.id) for p in ph_projects)

    # Internal project head (employee) → the internal projects they head.
    # For internal projects there is no external client; the project head acts
    # as the client-side (L2) approver.
    internal_projects = await Project.find({
        "project_head_ids": user_id,
        "is_internal": True,
        "organisation_id": organisation_id,
        "deleted_on": None,
    }).to_list()
    project_ids.update(str(p.id) for p in internal_projects)

    return list(project_ids)


async def _client_actionable_project_ids(project_ids: list[str]) -> list[str]:
    """From the given project ids, return only those that REQUIRE client approval.

    Projects with client_approval_required=False are visible to the client
    (they appear in the portal/detail) but cannot be approved/rejected by them.
    """
    if not project_ids:
        return []
    oids = [ObjectId(p) for p in project_ids if ObjectId.is_valid(p)]
    projs = await Project.find({
        "_id": {"$in": oids},
        "client_approval_required": {"$ne": False},
    }).to_list()
    return [str(p.id) for p in projs]


def _compute_client_scoped_status(tpa_statuses: list[str]) -> str:
    """Derive the status of a timesheet from the client's perspective.

    Only considers the TPA records for the client's own projects.
    """
    if not tpa_statuses:
        return ProjectApprovalStatusEnum.L1_APPROVED.value
    statuses = set(tpa_statuses)
    if "client_rejected" in statuses:
        return ProjectApprovalStatusEnum.CLIENT_REJECTED.value
    if statuses <= {"client_approved"}:
        return ProjectApprovalStatusEnum.CLIENT_APPROVED.value
    return ProjectApprovalStatusEnum.L1_APPROVED.value


# Statuses a client can see (their projects have reached L1 approval or beyond)
_CLIENT_VISIBLE_TPA_STATUSES = [
    ProjectApprovalStatusEnum.L1_APPROVED.value,
    ProjectApprovalStatusEnum.CLIENT_APPROVED.value,
    ProjectApprovalStatusEnum.CLIENT_REJECTED.value,
]


# Priority for rolling a month's per-week client statuses into one headline:
# work awaiting the client's decision (l1_approved) surfaces first.
_CLIENT_MONTH_STATUS_PRIORITY = [
    ProjectApprovalStatusEnum.L1_APPROVED.value,
    ProjectApprovalStatusEnum.CLIENT_REJECTED.value,
    ProjectApprovalStatusEnum.CLIENT_APPROVED.value,
]


async def _assert_user_in_client_scope(
    target_user_id: str, user: UserBase, project_ids: list[str],
) -> None:
    """Raise TimesheetNotFound unless ``target_user_id`` has at least one
    client-visible timesheet on one of the caller's own projects.

    Guards the ``user_id`` query param on the client-portal endpoints: without it
    any employee id (including one from another tenant) resolves to a name and
    emp code. Fails closed — no projects, an unparsable id or no matching
    approval record all deny.
    """
    from beanie import PydanticObjectId
    if not project_ids or not ObjectId.is_valid(target_user_id):
        raise TimesheetNotFound()

    target_weeks = await WeeklyTimesheet.find({
        "organisation_id": user.organisation_id,
        "user_id": ObjectId(target_user_id),
        "deleted_on": None,
    }).to_list()
    if not target_weeks:
        raise TimesheetNotFound()

    proj_oids = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    visible = await TimesheetProjectApproval.find_one({
        "weekly_timesheet_id": {"$in": [w.id for w in target_weeks]},
        "project_id": {"$in": proj_oids},
        "status": {"$in": _CLIENT_VISIBLE_TPA_STATUSES},
        "deleted_on": None,
    })
    if not visible:
        raise TimesheetNotFound()


def _rollup_client_month_status(week_statuses: list[str]) -> str:
    """Collapse a month's per-week client statuses into a single headline status."""
    present = set(week_statuses)
    for status in _CLIENT_MONTH_STATUS_PRIORITY:
        if status in present:
            return status
    return ProjectApprovalStatusEnum.L1_APPROVED.value


async def list_client_timesheets(
    user: UserBase,
    p: PageParams,
    *,
    timesheet_status: str | None = None,
    project_id: str | None = None,
    search: str | None = None,
    week_start: str | None = None,
    week_end: str | None = None,
) -> dict[str, Any]:
    project_ids = await _get_client_project_ids(user.id, user.organisation_id)
    if project_id:
        project_ids = [pid for pid in project_ids if pid == project_id]

    if not project_ids:
        return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}

    # Drive from TPA records — the global timesheet_status is irrelevant here
    # because partial approvals mean only the client's projects need to be L1-approved
    from beanie import PydanticObjectId
    proj_oids_for_tpa = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    tpa_filt: dict[str, Any] = {
        "project_id": {"$in": proj_oids_for_tpa},
        "status": {"$in": _CLIENT_VISIBLE_TPA_STATUSES},
        "deleted_on": None,
    }
    all_tpa = await TimesheetProjectApproval.find(tpa_filt).to_list()
    if not all_tpa:
        return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}

    # Group TPA records by timesheet for scoped-status computation (use str keys)
    tpa_by_ts: dict[str, list[str]] = {}
    for tpa in all_tpa:
        tpa_by_ts.setdefault(str(tpa.weekly_timesheet_id), []).append(tpa.status.value)

    ts_ids = list(tpa_by_ts.keys())

    ts_filt: dict[str, Any] = {
        "_id": {"$in": [ObjectId(tid) for tid in ts_ids if ObjectId.is_valid(tid)]},
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }
    if week_start:
        ts_filt.setdefault("week_start_date", {})["$gte"] = datetime.fromisoformat(week_start)
    if week_end:
        ts_filt.setdefault("week_start_date", {})["$lte"] = datetime.fromisoformat(week_end)

    all_ts = await WeeklyTimesheet.find(ts_filt).sort("-week_start_date").to_list()

    # Filter by client-scoped status if requested
    if timesheet_status:
        all_ts = [
            ts for ts in all_ts
            if _compute_client_scoped_status(tpa_by_ts.get(str(ts.id), [])) == timesheet_status
        ]

    user_ids = list({ts.user_id for ts in all_ts})
    name_map = await resolve_user_names(user_ids, user.organisation_id)
    emp_code_map = await resolve_emp_codes(user_ids, user.organisation_id)

    if search:
        q = search.lower()
        all_ts = [
            ts for ts in all_ts
            if q in str(ts.user_id).lower() or q in (name_map.get(ts.user_id, "")).lower()
        ]

    # Bucket the client-visible weeks by employee-month (same shape as the
    # manager /approvals/timesheets list).
    buckets: dict[tuple, dict[str, Any]] = {}
    for ts in all_ts:
        key = (str(ts.user_id), ts.week_start_date.year, ts.week_start_date.month)
        bucket = buckets.setdefault(
            key,
            {"user_id": ts.user_id, "year": key[1], "month": key[2], "weeks": []},
        )
        bucket["weeks"].append(ts)

    ordered = sorted(
        buckets.values(),
        key=lambda b: (name_map.get(b["user_id"], "") or str(b["user_id"])),
    )
    ordered.sort(key=lambda b: (b["year"], b["month"]), reverse=True)

    total = len(ordered)
    skip = compute_skip(p)
    page_buckets = ordered[skip : skip + p.page_size]

    # Fetch entries for the weeks on this page to build scoped hours + project name.
    page_ts_oids = [ts.id for b in page_buckets for ts in b["weeks"]]
    page_entries = await TimesheetEntry.find({
        "weekly_timesheet_id": {"$in": page_ts_oids},
        "project_id": {"$in": proj_oids_for_tpa},
        "deleted_on": None,
    }).to_list() if page_ts_oids else []

    projects = await Project.find({"_id": {"$in": proj_oids_for_tpa}}).to_list()
    proj_map = {str(pr.id): pr.name for pr in projects}
    proj_car_map = {str(pr.id): pr.client_approval_required for pr in projects}

    entries_by_ts: dict[str, list] = {}
    for e in page_entries:
        entries_by_ts.setdefault(str(e.weekly_timesheet_id), []).append(e)

    result_items = []
    for b in page_buckets:
        uid = b["user_id"]
        week_rows = []
        week_statuses: list[str] = []
        month_total = 0.0
        month_requires = False
        for ts in sorted(b["weeks"], key=lambda x: x.week_start_date, reverse=True):
            ts_id = str(ts.id)
            ts_entries = entries_by_ts.get(ts_id, [])
            ts_project_ids = list({str(e.project_id) for e in ts_entries})
            scoped_status = _compute_client_scoped_status(tpa_by_ts.get(ts_id, []))
            w_hours = sum(e.hours for e in ts_entries)
            requires = any(proj_car_map.get(pid, True) for pid in ts_project_ids) if ts_project_ids else True
            month_total += w_hours
            month_requires = month_requires or requires
            week_statuses.append(scoped_status)
            week_rows.append({
                "id": ts_id,
                "week_start_date": ts.week_start_date,
                "week_end_date": ts.week_end_date,
                "total_hours": w_hours,
                "submitted_at": ts.submitted_at,
                "timesheet_status": scoped_status,
                "project_name": proj_map.get(ts_project_ids[0], "") if ts_project_ids else "",
                # drives whether approve/reject buttons show for the week
                "client_approval_required": requires,
            })

        status_counts: dict[str, int] = {}
        for s in week_statuses:
            status_counts[s] = status_counts.get(s, 0) + 1

        period_start, period_end = _month_range(b["year"], b["month"])
        result_items.append({
            "user_id": str(uid),
            "user_name": name_map.get(uid),
            "emp_code": emp_code_map.get(uid),
            "year": b["year"],
            "month": b["month"],
            "month_label": f"{b['year']:04d}-{b['month']:02d}",
            "period_start": period_start,
            "period_end": period_end,
            "total_hours": month_total,
            "week_count": len(week_rows),
            "timesheet_status": _rollup_client_month_status(week_statuses),
            "status_counts": status_counts,
            "client_approval_required": month_requires,
            "weeks": week_rows,
        })

    return {"items": result_items, "total": total, "page": p.page, "page_size": p.page_size}


async def export_client_timesheets(
    user: UserBase,
    *,
    timesheet_status: str | None = None,
    search: str | None = None,
    week_start: str | None = None,
    week_end: str | None = None,
) -> list[dict[str, Any]]:
    project_ids = await _get_client_project_ids(user.id, user.organisation_id)
    if not project_ids:
        return []

    from beanie import PydanticObjectId
    proj_oids_export = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    all_tpa = await TimesheetProjectApproval.find({
        "project_id": {"$in": proj_oids_export},
        "status": {"$in": _CLIENT_VISIBLE_TPA_STATUSES},
        "deleted_on": None,
    }).to_list()
    if not all_tpa:
        return []

    tpa_by_ts: dict[str, list[str]] = {}
    for tpa in all_tpa:
        tpa_by_ts.setdefault(str(tpa.weekly_timesheet_id), []).append(tpa.status.value)

    ts_filt: dict[str, Any] = {
        "_id": {"$in": [ObjectId(tid) for tid in tpa_by_ts if ObjectId.is_valid(tid)]},
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }
    if week_start:
        ts_filt.setdefault("week_start_date", {})["$gte"] = datetime.fromisoformat(week_start)
    if week_end:
        ts_filt.setdefault("week_start_date", {})["$lte"] = datetime.fromisoformat(week_end)

    all_ts = await WeeklyTimesheet.find(ts_filt).sort("-week_start_date").to_list()

    if timesheet_status:
        all_ts = [
            ts for ts in all_ts
            if _compute_client_scoped_status(tpa_by_ts.get(str(ts.id), [])) == timesheet_status
        ]

    user_ids = list({ts.user_id for ts in all_ts})
    name_map = await resolve_user_names(user_ids, user.organisation_id)
    emp_code_map = await resolve_emp_codes(user_ids, user.organisation_id)

    if search:
        q = search.lower()
        all_ts = [
            ts for ts in all_ts
            if q in str(ts.user_id).lower() or q in (name_map.get(ts.user_id, "")).lower()
        ]

    all_ts_oids = [ts.id for ts in all_ts]
    entries = await TimesheetEntry.find({
        "weekly_timesheet_id": {"$in": all_ts_oids},
        "project_id": {"$in": proj_oids_export},
        "deleted_on": None,
    }).to_list()

    projects = await Project.find({"_id": {"$in": proj_oids_export}}).to_list()
    proj_map = {str(pr.id): pr.name for pr in projects}

    items = []
    for ts in all_ts:
        ts_entries = [e for e in entries if str(e.weekly_timesheet_id) == str(ts.id)]
        ts_project_ids = list({str(e.project_id) for e in ts_entries})
        scoped_status = _compute_client_scoped_status(tpa_by_ts.get(str(ts.id), []))
        summary = _ts_summary(ts, name_map, emp_code_map)
        summary["timesheet_status"] = scoped_status
        summary["total_hours"] = sum(e.hours for e in ts_entries)
        summary["project_name"] = proj_map.get(ts_project_ids[0], "") if ts_project_ids else ""
        items.append(summary)

    return items


async def get_client_dashboard(user: UserBase) -> dict[str, Any]:
    project_ids = await _get_client_project_ids(user.id, user.organisation_id)
    if not project_ids:
        return {"total": 0, "pending": 0, "approved": 0, "rejected": 0}

    from beanie import PydanticObjectId
    proj_oids_dash = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    all_tpa = await TimesheetProjectApproval.find({
        "project_id": {"$in": proj_oids_dash},
        "status": {"$in": _CLIENT_VISIBLE_TPA_STATUSES},
        "deleted_on": None,
    }).to_list()
    if not all_tpa:
        return {"total": 0, "pending": 0, "approved": 0, "rejected": 0}

    tpa_by_ts: dict[str, list[str]] = {}
    for tpa in all_tpa:
        tpa_by_ts.setdefault(str(tpa.weekly_timesheet_id), []).append(tpa.status.value)

    # Verify the underlying timesheets still exist and belong to this org
    ts_oids = [ObjectId(tid) for tid in tpa_by_ts if ObjectId.is_valid(tid)]
    existing_ts = await WeeklyTimesheet.find({
        "_id": {"$in": ts_oids},
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }).to_list()
    existing_ts_ids = {str(ts.id) for ts in existing_ts}

    counts: dict[str, int] = {"l1_approved": 0, "client_approved": 0, "client_rejected": 0}
    for ts_id, statuses in tpa_by_ts.items():
        if ts_id not in existing_ts_ids:
            continue
        key = _compute_client_scoped_status(statuses)
        counts[key] = counts.get(key, 0) + 1

    total = sum(counts.values())
    return {
        "total": total,
        "pending": counts.get("l1_approved", 0),
        "approved": counts.get("client_approved", 0),
        "rejected": counts.get("client_rejected", 0),
    }


async def get_client_timesheet_detail(timesheet_id: str, user: UserBase) -> dict[str, Any]:
    from beanie import PydanticObjectId
    doc = await _load_for_approval(timesheet_id, user.organisation_id)

    all_entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("entry_date").to_list()

    # Scope entries to only the projects this client/project head owns
    # client_project_ids is a set of str; e.project_id is PydanticObjectId
    client_project_ids_str = set(await _get_client_project_ids(user.id, user.organisation_id))
    entries = [e for e in all_entries if str(e.project_id) in client_project_ids_str]

    # Being in the same organisation is not enough: a timesheet with no work on
    # one of this client's own projects does not exist as far as they are
    # concerned — otherwise the summary below would leak the employee's name and
    # emp code for an unrelated timesheet.
    if not entries:
        raise TimesheetNotFound()

    all_approval_records = await ApprovalRecord.find(
        {"weekly_timesheet_id": doc.id, "deleted_on": None}
    ).sort("acted_at").to_list()

    # Only show approval records that touch at least one of this client's projects
    approval_history = [
        ar for ar in all_approval_records
        if not ar.scope_project_ids
        or any(str(pid) in client_project_ids_str for pid in ar.scope_project_ids)
    ]

    # e.project_id / e.task_id are PydanticObjectId — use directly in _id queries
    project_ids_oids = list({e.project_id for e in entries})
    task_ids_oids = list({e.task_id for e in entries})
    projects = await Project.find({"_id": {"$in": project_ids_oids}}).to_list() if project_ids_oids else []
    tasks = await Task.find({"_id": {"$in": task_ids_oids}}).to_list() if task_ids_oids else []
    proj_map = {str(p.id): p for p in projects}
    task_map = {str(t.id): t.name for t in tasks}

    # Per-project approval state — fetched here so IDs are available for name batching
    client_proj_oids = [PydanticObjectId(pid) for pid in client_project_ids_str if ObjectId.is_valid(pid)]
    all_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": doc.id,
        "project_id": {"$in": client_proj_oids},
        "deleted_on": None,
    }).to_list() if client_proj_oids else []

    tpa_actor_ids = [
        uid for tpa in all_tpa
        for uid in [tpa.l1_approver_id, tpa.client_approver_id]
        if uid
    ]
    name_map = await resolve_user_names(
        [doc.user_id] + [ar.approver_id for ar in approval_history] + tpa_actor_ids,
        user.organisation_id,
    )
    emp_code_map = await resolve_emp_codes([doc.user_id], user.organisation_id)

    daily_breakdown: list[dict[str, Any]] = []
    entries_by_date: dict[str, list] = {}
    for e in entries:
        date_key = e.entry_date.strftime("%Y-%m-%d")
        entries_by_date.setdefault(date_key, []).append(e)

    for date_key in sorted(entries_by_date.keys()):
        day_entries = entries_by_date[date_key]
        total_hours = sum(e.hours for e in day_entries)
        comments = "; ".join(e.notes for e in day_entries if e.notes)
        tasks_list = []
        for e in day_entries:
            p_name = proj_map.get(str(e.project_id), None)
            tasks_list.append({
                "project_name": p_name.name if p_name else str(e.project_id),
                "task_name": task_map.get(str(e.task_id), str(e.task_id)),
                "hours": e.hours,
                "notes": e.notes,
                "is_billable": e.is_billable,
            })

        dt = datetime.fromisoformat(date_key)
        day_label = dt.strftime("%A")
        daily_breakdown.append({
            "date": date_key,
            "day": day_label,
            "hours": total_hours,
            "comments": comments,
            "tasks": tasks_list,
        })

    project_context = None
    if projects:
        p = projects[0]
        # p.client_id is already PydanticObjectId — use it directly
        client_doc = await Client.find_one({"_id": p.client_id})
        project_context = {
            "project_name": p.name,
            "client_name": client_doc.name if client_doc else "",
            "project_code": p.code,
            "project_type": p.project_type,
            "billing_status": "BILLABLE" if p.project_type != "non_billable" else "NON-BILLABLE",
        }

    # Build project_approvals with resolved names (all_tpa and name_map already computed above)
    proj_name_map = {str(p.id): p.name for p in projects}
    proj_car_map = {str(p.id): p.client_approval_required for p in projects}
    project_approvals = [
        {
            "project_id": str(tpa.project_id),
            "project_name": proj_name_map.get(str(tpa.project_id), str(tpa.project_id)),
            "client_approval_required": proj_car_map.get(str(tpa.project_id), True),
            "status": tpa.status,
            "submitted_by_id": str(doc.user_id),
            "submitted_by_name": name_map.get(doc.user_id),
            "l1_approver_id": str(tpa.l1_approver_id) if tpa.l1_approver_id else None,
            "l1_approver_name": name_map.get(tpa.l1_approver_id) if tpa.l1_approver_id else None,
            "l1_acted_at": tpa.l1_acted_at,
            "l1_comments": tpa.l1_comments,
            "client_approver_id": str(tpa.client_approver_id) if tpa.client_approver_id else None,
            "client_approver_name": name_map.get(tpa.client_approver_id) if tpa.client_approver_id else None,
            "client_acted_at": tpa.client_acted_at,
            "client_comments": tpa.client_comments,
        }
        for tpa in all_tpa
    ]

    history = []
    if doc.submitted_at:
        history.append({
            "id": "submitted",
            "approver_id": str(doc.user_id),
            "approver_name": name_map.get(doc.user_id),
            "approver_role": "employee",
            "approval_level": 0,
            "action": "submitted",
            "comments": doc.notes or None,
            "acted_at": doc.submitted_at,
        })
    for ar in approval_history:
        history.append({
            "id": str(ar.id),
            "approver_id": str(ar.approver_id),
            "approver_name": name_map.get(ar.approver_id),
            "approver_role": ar.approver_role,
            "approval_level": ar.approval_level,
            "action": ar.action,
            "comments": ar.comments,
            "acted_at": ar.acted_at,
        })

    from ..timesheets.service import _entry_to_out
    scoped_total = sum(e.hours for e in entries)
    scoped_ts_status = _compute_client_scoped_status([tpa.status.value for tpa in all_tpa])

    # Build weekly timeline grid (used by Excel/PDF export)
    day_names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    rows: dict[str, dict[str, Any]] = {}
    for e in entries:
        pid_str = str(e.project_id)
        tid_str = str(e.task_id)
        key = f"{pid_str}|{tid_str}"
        if key not in rows:
            rows[key] = {
                "project_id": pid_str,
                "project_name": proj_name_map.get(pid_str, pid_str),
                "task_id": tid_str,
                "task_name": task_map.get(tid_str, tid_str),
                **{d: 0 for d in day_names},
                "total": 0,
            }
        dow = e.entry_date.weekday()
        if 0 <= dow <= 6:
            rows[key][day_names[dow]] += e.hours
            rows[key]["total"] += e.hours

    return {
        **_ts_summary(doc, name_map, emp_code_map),
        "timesheet_status": scoped_ts_status,
        "total_hours": scoped_total,
        # True if any project on this timesheet requires client approval
        # (frontend hides approve/reject when False)
        "client_approval_required": any(
            pa["client_approval_required"] for pa in project_approvals
        ) if project_approvals else True,
        "project_approvals": project_approvals,
        "entries": [_entry_to_out(e) for e in entries],
        "weekly_timeline": list(rows.values()),
        "daily_breakdown": daily_breakdown,
        "project_context": project_context,
        "total_weekly_hours": scoped_total,
        "approval_history": history,
    }


async def get_client_monthly_timesheet_detail(
    target_user_id: str,
    user: UserBase,
    *,
    month: int,
    year: int,
) -> dict[str, Any]:
    """Client-portal month view: month summary + each week's full client detail.

    Mirrors the manager monthly endpoint, but scoped to the client's projects —
    only weeks whose client projects have reached L1 approval (or beyond) appear,
    and each week reuses the per-week client detail shape (GET /{id}).
    """
    from beanie import PydanticObjectId

    # Authorise the caller-supplied user_id BEFORE any IAM lookup, so an employee
    # outside this client's projects (or outside the organisation) never has their
    # name / emp code resolved.
    project_ids = await _get_client_project_ids(user.id, user.organisation_id)
    await _assert_user_in_client_scope(target_user_id, user, project_ids)

    name_map = await resolve_user_names([target_user_id], user.organisation_id)
    emp_code_map = await resolve_emp_codes([target_user_id], user.organisation_id)
    target_user_oid = ObjectId(target_user_id) if ObjectId.is_valid(target_user_id) else target_user_id
    start, end = _month_range(year, month)

    def _empty() -> dict[str, Any]:
        return {
            "user_id": target_user_id,
            "user_name": name_map.get(target_user_oid),
            "emp_code": emp_code_map.get(target_user_oid),
            "year": year,
            "month": month,
            "month_label": f"{year:04d}-{month:02d}",
            "period_start": start,
            "period_end": end,
            "total_hours": 0,
            "week_count": 0,
            "timesheet_status": ProjectApprovalStatusEnum.L1_APPROVED.value,
            "status_counts": {},
            "client_approval_required": True,
            "weeks": [],
        }

    proj_oids = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    week_docs = await WeeklyTimesheet.find({
        "organisation_id": user.organisation_id,
        "user_id": target_user_oid,
        "deleted_on": None,
        "week_start_date": {"$gte": start, "$lte": end},
    }).sort("week_start_date").to_list()
    if not week_docs:
        return _empty()

    # Keep only weeks the client can see (their projects reached L1 approval+).
    visible_tpa = await TimesheetProjectApproval.find({
        "weekly_timesheet_id": {"$in": [w.id for w in week_docs]},
        "project_id": {"$in": proj_oids},
        "status": {"$in": _CLIENT_VISIBLE_TPA_STATUSES},
        "deleted_on": None,
    }).to_list()
    visible_week_ids = {str(t.weekly_timesheet_id) for t in visible_tpa}
    relevant_weeks = [w for w in week_docs if str(w.id) in visible_week_ids]
    if not relevant_weeks:
        return _empty()

    # Reuse the per-week client detail builder so each week matches GET /{id}.
    # A week whose client-project entries have since gone is skipped rather than
    # failing the whole month (the per-week builder 404s on those).
    week_details: list[dict[str, Any]] = []
    for w in relevant_weeks:
        try:
            week_details.append(await get_client_timesheet_detail(str(w.id), user))
        except TimesheetNotFound:
            continue
    if not week_details:
        return _empty()

    week_statuses = [wd.get("timesheet_status") for wd in week_details if wd.get("timesheet_status")]
    status_counts: dict[str, int] = {}
    for s in week_statuses:
        status_counts[s] = status_counts.get(s, 0) + 1
    total_hours = sum(wd.get("total_hours", 0) or 0 for wd in week_details)

    return {
        "user_id": target_user_id,
        "user_name": name_map.get(target_user_oid),
        "emp_code": emp_code_map.get(target_user_oid),
        "year": year,
        "month": month,
        "month_label": f"{year:04d}-{month:02d}",
        "period_start": start,
        "period_end": end,
        "total_hours": total_hours,
        "week_count": len(week_details),
        "timesheet_status": _rollup_client_month_status(week_statuses),
        "status_counts": status_counts,
        "client_approval_required": any(
            wd.get("client_approval_required") for wd in week_details
        ) if week_details else True,
        "weeks": week_details,
    }


async def get_client_activity_history(
    user: UserBase,
    p: PageParams,
    *,
    search: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    actor: str | None = None,
) -> dict[str, Any]:
    project_ids = await _get_client_project_ids(user.id, user.organisation_id)
    if not project_ids:
        return {
            "items": [], "total": 0, "page": p.page, "page_size": p.page_size,
            "summary": {"total_reviews": 0, "approved_mtd": 0, "rejected_mtd": 0, "avg_decision_time_hours": 0},
        }

    from beanie import PydanticObjectId
    proj_oids_act = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    entries = await TimesheetEntry.find({
        "project_id": {"$in": proj_oids_act},
        "deleted_on": None,
    }).to_list()
    # e.weekly_timesheet_id is PydanticObjectId — collect as PydanticObjectId set
    ts_oid_set = {e.weekly_timesheet_id for e in entries}

    if not ts_oid_set:
        return {
            "items": [], "total": 0, "page": p.page, "page_size": p.page_size,
            "summary": {"total_reviews": 0, "approved_mtd": 0, "rejected_mtd": 0, "avg_decision_time_hours": 0},
        }

    ts_oid_list = list(ts_oid_set)
    ar_filt: dict[str, Any] = {
        "weekly_timesheet_id": {"$in": ts_oid_list},
        "deleted_on": None,
    }
    if start_date:
        ar_filt.setdefault("acted_at", {})["$gte"] = datetime.fromisoformat(start_date)
    if end_date:
        ar_filt.setdefault("acted_at", {})["$lte"] = datetime.fromisoformat(end_date + "T23:59:59")
    if actor:
        ar_filt["approver_id"] = ObjectId(actor) if ObjectId.is_valid(actor) else actor

    all_records = await ApprovalRecord.find(ar_filt).sort("-acted_at").to_list()

    ts_map: dict[str, WeeklyTimesheet] = {}
    ts_docs = await WeeklyTimesheet.find({"_id": {"$in": ts_oid_list}}).to_list()
    for doc in ts_docs:
        ts_map[str(doc.id)] = doc

    all_user_ids = list({ar.approver_id for ar in all_records} | {ts.user_id for ts in ts_docs})
    name_map = await resolve_user_names(all_user_ids, user.organisation_id)

    proj_docs = await Project.find({"_id": {"$in": proj_oids_act}}).to_list()
    proj_name_map = {str(p.id): p.name for p in proj_docs}

    if search:
        q = search.lower()
        filtered = []
        for ar in all_records:
            ts_doc = ts_map.get(str(ar.weekly_timesheet_id))
            emp_name = name_map.get(ts_doc.user_id, "") if ts_doc else ""
            approver_name = name_map.get(ar.approver_id, "")
            if q in emp_name.lower() or q in approver_name.lower() or q in str(ar.approver_id).lower():
                filtered.append(ar)
        all_records = filtered

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    month_start = datetime(now.year, now.month, 1)
    approved_mtd = sum(1 for ar in all_records if ar.action == ApprovalActionEnum.APPROVED and ar.acted_at and ar.acted_at >= month_start)
    rejected_mtd = sum(1 for ar in all_records if ar.action == ApprovalActionEnum.REJECTED and ar.acted_at and ar.acted_at >= month_start)

    decision_times = []
    for ar in all_records:
        ts_doc = ts_map.get(str(ar.weekly_timesheet_id))
        if ts_doc and ts_doc.submitted_at and ar.acted_at:
            delta = (ar.acted_at - ts_doc.submitted_at).total_seconds() / 3600
            if delta > 0:
                decision_times.append(delta)
    avg_decision = round(sum(decision_times) / len(decision_times), 1) if decision_times else 0

    total = len(all_records)
    skip = compute_skip(p)
    page_records = all_records[skip : skip + p.page_size]

    items = []
    for ar in page_records:
        ts_doc = ts_map.get(str(ar.weekly_timesheet_id))
        emp_entries = [e for e in entries if e.weekly_timesheet_id == ar.weekly_timesheet_id]
        project_names = list({proj_name_map.get(str(e.project_id), "") for e in emp_entries})

        items.append({
            "id": str(ar.id),
            "acted_at": ar.acted_at,
            "approver_id": str(ar.approver_id),
            "approver_name": name_map.get(ar.approver_id),
            "approver_role": ar.approver_role,
            "employee_id": str(ts_doc.user_id) if ts_doc else "",
            "employee_name": name_map.get(ts_doc.user_id, "") if ts_doc else "",
            "project_names": project_names,
            "hours": ts_doc.total_hours if ts_doc else 0,
            "action": ar.action,
            "comments": ar.comments,
        })

    return {
        "items": items,
        "total": total,
        "page": p.page,
        "page_size": p.page_size,
        "summary": {
            "total_reviews": total,
            "approved_mtd": approved_mtd,
            "rejected_mtd": rejected_mtd,
            "avg_decision_time_hours": avg_decision,
        },
    }


async def export_activity_history(
    user: UserBase,
    *,
    search: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    actor: str | None = None,
) -> list[dict[str, Any]]:
    project_ids = await _get_client_project_ids(user.id, user.organisation_id)
    if not project_ids:
        return []

    from beanie import PydanticObjectId
    proj_oids_ea = [PydanticObjectId(pid) for pid in project_ids if ObjectId.is_valid(pid)]
    entries = await TimesheetEntry.find({
        "project_id": {"$in": proj_oids_ea},
        "deleted_on": None,
    }).to_list()
    ts_oid_set_ea = {e.weekly_timesheet_id for e in entries}
    if not ts_oid_set_ea:
        return []

    ts_oid_list_ea = list(ts_oid_set_ea)
    ar_filt: dict[str, Any] = {
        "weekly_timesheet_id": {"$in": ts_oid_list_ea},
        "deleted_on": None,
    }
    if start_date:
        ar_filt.setdefault("acted_at", {})["$gte"] = datetime.fromisoformat(start_date)
    if end_date:
        ar_filt.setdefault("acted_at", {})["$lte"] = datetime.fromisoformat(end_date + "T23:59:59")
    if actor:
        ar_filt["approver_id"] = ObjectId(actor) if ObjectId.is_valid(actor) else actor

    all_records = await ApprovalRecord.find(ar_filt).sort("-acted_at").to_list()

    ts_docs = await WeeklyTimesheet.find({"_id": {"$in": ts_oid_list_ea}}).to_list()
    ts_map = {str(doc.id): doc for doc in ts_docs}

    all_user_ids = list({ar.approver_id for ar in all_records} | {ts.user_id for ts in ts_docs})
    name_map = await resolve_user_names(all_user_ids, user.organisation_id)

    proj_docs = await Project.find({"_id": {"$in": proj_oids_ea}}).to_list()
    proj_name_map = {str(p.id): p.name for p in proj_docs}

    if search:
        q = search.lower()
        all_records = [
            ar for ar in all_records
            if q in name_map.get((ts_map.get(str(ar.weekly_timesheet_id)) or type("", (), {"user_id": ""})).user_id, "").lower()
            or q in name_map.get(ar.approver_id, "").lower()
            or q in str(ar.approver_id).lower()
        ]

    items = []
    for ar in all_records:
        ts_doc = ts_map.get(str(ar.weekly_timesheet_id))
        emp_entries = [e for e in entries if e.weekly_timesheet_id == ar.weekly_timesheet_id]
        project_names = list({proj_name_map.get(str(e.project_id), "") for e in emp_entries})
        items.append({
            "acted_at": ar.acted_at,
            "approver_name": name_map.get(ar.approver_id) or str(ar.approver_id),
            "approver_role": ar.approver_role,
            "employee_name": name_map.get(ts_doc.user_id, "") if ts_doc else "",
            "project_names": ", ".join(project_names),
            "hours": ts_doc.total_hours if ts_doc else 0,
            "action": ar.action,
            "comments": ar.comments or "",
        })

    return items
