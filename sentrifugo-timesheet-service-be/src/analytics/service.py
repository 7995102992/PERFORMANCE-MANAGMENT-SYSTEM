from __future__ import annotations

import calendar
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId

from ..auth.utils.dependencies import UserBase
from ..common.user_resolver import resolve_emp_codes, resolve_user_names
from ..database import get_client
from ..models import (
    ApprovalRecord,
    Client,
    Project,
    ResourceAssignment,
    TimesheetEntry,
    TimesheetSettings,
    WeeklyTimesheet,
)

logger = logging.getLogger(__name__)

IAM_DB = "sentrifugo_iam"
_MONTH_LABELS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]
_SUBMITTED_STATUSES = {"submitted", "resubmitted", "l1_approved", "client_approved"}


# ─── Shared helpers ──────────────────────────────────────────────────────────

def _fy_range(now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or datetime.now(timezone.utc)
    start_year = now.year if now.month >= 4 else now.year - 1
    return (
        datetime(start_year, 4, 1, tzinfo=timezone.utc),
        datetime(start_year + 1, 3, 31, 23, 59, 59, tzinfo=timezone.utc),
    )


def _working_days(year: int, month: int, up_to_day: int | None = None) -> int:
    _, last = calendar.monthrange(year, month)
    end = min(up_to_day, last) if up_to_day is not None else last
    if end <= 0:
        return 0
    return sum(1 for d in range(1, end + 1) if calendar.weekday(year, month, d) < 5)


def _months_in_range(start: datetime, end: datetime) -> list[tuple[int, int]]:
    result, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        result.append((y, m))
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return result


def _month_label(m: int) -> str:
    return _MONTH_LABELS[m - 1]


def _week_label(s: datetime, e: datetime) -> str:
    if s.month == e.month:
        return f"{s.strftime('%b %d')}–{e.strftime('%d')}"
    return f"{s.strftime('%b %d')}–{e.strftime('%b %d')}"


def _quarter_label(month: int, fy_start_month: int = 4) -> str:
    offset = (month - fy_start_month) % 12
    q = offset // 3 + 1
    return f"Q{q}"


async def _get_org_settings(org_id) -> TimesheetSettings | None:
    return await TimesheetSettings.find_one({
        "organisation_id": org_id, "project_id": None, "deleted_on": None,
    })


def _safe_pct(num: float, den: float) -> float:
    return round(num / den * 100, 1) if den else 0


def _target_hours_ytd(fy_start: datetime, now: datetime, std_hours: float) -> float:
    total = 0.0
    for y, m in _months_in_range(fy_start, now):
        if y == now.year and m == now.month:
            total += _working_days(y, m, now.day) * std_hours
        else:
            total += _working_days(y, m) * std_hours
    return total


# ─── IAM data helpers ────────────────────────────────────────────────────────

async def _load_org_employees(org_id) -> list[dict]:
    client = get_client()
    col = client[IAM_DB]["employees"]
    oid = ObjectId(org_id) if ObjectId.is_valid(str(org_id)) else org_id
    result = []
    async for doc in col.find(
        {"organisation_id": oid, "deleted_on": None},
        {"user_id": 1, "business_unit_id": 1, "department_id": 1, "designation_id": 1},
    ):
        result.append(doc)
    return result


async def _load_bu_names(org_id) -> dict[str, str]:
    client = get_client()
    oid = ObjectId(org_id) if ObjectId.is_valid(str(org_id)) else org_id
    result = {}
    async for doc in client[IAM_DB]["business_units"].find(
        {"organisation_id": oid, "is_active": True},
        {"business_unit_name": 1},
    ):
        result[str(doc["_id"])] = doc.get("business_unit_name", "")
    return result


async def _load_dept_names(org_id) -> dict[str, str]:
    client = get_client()
    oid = ObjectId(org_id) if ObjectId.is_valid(str(org_id)) else org_id
    result = {}
    async for doc in client[IAM_DB]["departments"].find(
        {"organisation_id": oid, "is_active": True},
        {"department_name": 1},
    ):
        result[str(doc["_id"])] = doc.get("department_name", "")
    return result


async def _load_designation_names(org_id) -> dict[str, str]:
    client = get_client()
    oid = ObjectId(org_id) if ObjectId.is_valid(str(org_id)) else org_id
    result = {}
    async for doc in client[IAM_DB]["designations"].find(
        {"organisation_id": oid, "is_active": True},
        {"designation_name": 1},
    ):
        result[str(doc["_id"])] = doc.get("designation_name", "")
    return result


def _user_to_org_unit(employees: list[dict]) -> dict[str, tuple]:
    """Map user_id_str -> (bu_id_str | None, dept_id_str | None)."""
    result = {}
    for e in employees:
        uid = str(e.get("user_id", ""))
        bu = str(e["business_unit_id"]) if e.get("business_unit_id") else None
        dept = str(e["department_id"]) if e.get("department_id") else None
        if uid:
            result[uid] = (bu, dept)
    return result


def _user_to_designation(employees: list[dict]) -> dict[str, str | None]:
    result = {}
    for e in employees:
        uid = str(e.get("user_id", ""))
        if uid:
            result[uid] = str(e["designation_id"]) if e.get("designation_id") else None
    return result


# ─── Timesheet loading helpers ───────────────────────────────────────────────

async def _fy_timesheets(org_id, fy_start, fy_end, user_ids=None) -> list[WeeklyTimesheet]:
    filt: dict[str, Any] = {
        "organisation_id": org_id,
        "deleted_on": None,
        "week_start_date": {"$gte": fy_start, "$lte": fy_end},
    }
    if user_ids is not None:
        filt["user_id"] = {"$in": user_ids}
    return await WeeklyTimesheet.find(filt).sort("-week_start_date").to_list()


async def _entries_for_timesheets(ts_ids: list) -> list[TimesheetEntry]:
    if not ts_ids:
        return []
    return await TimesheetEntry.find({
        "weekly_timesheet_id": {"$in": ts_ids}, "deleted_on": None,
    }).to_list()


async def _build_monthly_project_hours(
    entries: list[TimesheetEntry],
    fy_start: datetime,
    fy_end: datetime,
) -> tuple[list[dict], list[str]]:
    project_ids = list({e.project_id for e in entries})
    projects = await Project.find({"_id": {"$in": project_ids}}).to_list() if project_ids else []
    proj_map = {str(p.id): p.name for p in projects}

    monthly: dict[str, dict[str, float]] = {}
    for e in entries:
        ml = _month_label(e.entry_date.month)
        pn = proj_map.get(str(e.project_id), str(e.project_id))
        monthly.setdefault(ml, defaultdict(float))
        monthly[ml][pn] += e.hours

    all_names = sorted({n for mp in monthly.values() for n in mp})
    rows = []
    for _y, m in _months_in_range(fy_start, fy_end):
        ml = _month_label(m)
        mp = monthly.get(ml, {})
        row: dict[str, Any] = {"month": ml}
        for n in all_names:
            row[n] = round(mp.get(n, 0), 1)
        rows.append(row)
    return rows, all_names


# ─── Rate helpers (CFO/MD) ───────────────────────────────────────────────────

async def _build_rate_lookups(org_id, std_hours: float) -> tuple[dict, dict]:
    assignments = await ResourceAssignment.find({
        "organisation_id": org_id, "deleted_on": None,
    }).to_list()
    ra_rates: dict[tuple[str, str], float] = {}
    for ra in assignments:
        if ra.billable_rate and ra.billable_rate > 0:
            ra_rates[(str(ra.project_id), str(ra.user_id))] = ra.billable_rate

    projects = await Project.find({"organisation_id": org_id, "deleted_on": None}).to_list()
    proj_rates: dict[str, float] = {}
    for p in projects:
        if p.billable_rate and p.billable_rate > 0:
            rate = p.billable_rate
            if p.billable_rate_type and p.billable_rate_type.value == "per_day":
                rate = rate / std_hours if std_hours else rate / 8
            proj_rates[str(p.id)] = rate
    return ra_rates, proj_rates


def _effective_rate(
    project_id: str,
    user_id: str,
    ra_rates: dict,
    proj_rates: dict,
) -> float:
    return ra_rates.get((project_id, user_id), proj_rates.get(project_id, 0))


# ─── Team user IDs (reused from approvals) ──────────────────────────────────

async def _get_team_user_ids(user: UserBase) -> list:
    from ..approvals.service import _get_team_user_ids as _impl
    return await _impl(user)


# ─── 1. Employee Descriptive ────────────────────────────────────────────────

async def get_employee_descriptive(
    user: UserBase,
    cal_year: int | None = None,
    cal_month: int | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    fy_start, fy_end = _fy_range(now)
    org_id = user.organisation_id

    cal_year = cal_year or now.year
    cal_month = cal_month or now.month

    settings = await _get_org_settings(org_id)
    std_hours = settings.standard_hours_per_day if settings else 8.0

    fy_ts = await _fy_timesheets(org_id, fy_start, fy_end, user_ids=[user.id])

    total_hours = sum(t.total_hours for t in fy_ts)
    billable = sum(t.billable_hours for t in fy_ts)
    non_billable = sum(t.non_billable_hours for t in fy_ts)
    shortage = sum(t.shortage_hours for t in fy_ts)
    penalty = sum(t.penalty_hours for t in fy_ts)

    sc: dict[str, int] = defaultdict(int)
    for t in fy_ts:
        sc[t.timesheet_status.value] += 1

    target = _target_hours_ytd(fy_start, now, std_hours)

    # Calendar hours for requested month
    cal_start = datetime(cal_year, cal_month, 1, tzinfo=timezone.utc)
    _, cal_last = calendar.monthrange(cal_year, cal_month)
    cal_end = datetime(cal_year, cal_month, cal_last, 23, 59, 59, tzinfo=timezone.utc)

    cal_ts = await WeeklyTimesheet.find({
        "user_id": user.id, "organisation_id": org_id, "deleted_on": None,
        "week_start_date": {"$lte": cal_end}, "week_end_date": {"$gte": cal_start},
    }).to_list()
    cal_entries = await TimesheetEntry.find({
        "weekly_timesheet_id": {"$in": [t.id for t in cal_ts]},
        "deleted_on": None,
        "entry_date": {"$gte": cal_start, "$lte": cal_end},
    }).to_list() if cal_ts else []

    cal_hours: dict[str, float] = defaultdict(float)
    for e in cal_entries:
        cal_hours[e.entry_date.strftime("%Y-%m-%d")] += e.hours

    # Monthly project hours
    fy_entries = await _entries_for_timesheets([t.id for t in fy_ts])
    monthly_rows, proj_names = await _build_monthly_project_hours(fy_entries, fy_start, fy_end)

    # Recent timesheets with approval turnaround
    recent = fy_ts[:8]
    recent_ids = [t.id for t in recent]
    approvals = await ApprovalRecord.find({
        "weekly_timesheet_id": {"$in": recent_ids}, "deleted_on": None,
    }).to_list() if recent_ids else []
    apr_by_ts: dict[str, list] = defaultdict(list)
    for a in approvals:
        apr_by_ts[str(a.weekly_timesheet_id)].append(a)

    recent_rows = []
    for t in recent:
        turnaround = None
        if t.submitted_at:
            l1 = [a for a in apr_by_ts.get(str(t.id), [])
                  if a.approver_role.value == "manager" and a.action.value == "approved"]
            if l1:
                delta = (max(a.acted_at for a in l1) - t.submitted_at).total_seconds() / 86400
                turnaround = f"{delta:.1f} days"
            elif t.timesheet_status.value in ("submitted", "resubmitted"):
                turnaround = "Pending"
            elif t.timesheet_status.value == "l1_approved":
                turnaround = "Client pending"

        recent_rows.append({
            "week_label": _week_label(t.week_start_date, t.week_end_date),
            "week_start_date": t.week_start_date.strftime("%Y-%m-%d"),
            "total_hours": t.total_hours,
            "billable_hours": t.billable_hours,
            "non_billable_hours": t.non_billable_hours,
            "shortage_hours": t.shortage_hours,
            "status": t.timesheet_status.value,
            "submitted_at": t.submitted_at.strftime("%b %d") if t.submitted_at else None,
            "approval_turnaround": turnaround,
        })

    return {
        "fy_label": f"FY {fy_start.year}–{str(fy_end.year)[2:]}",
        "kpis": {
            "total_hours_ytd": round(total_hours, 1),
            "billable_hours": round(billable, 1),
            "non_billable_hours": round(non_billable, 1),
            "total_requests": len(fy_ts),
            "approved_count": sc.get("l1_approved", 0) + sc.get("client_approved", 0),
            "pending_count": sc.get("submitted", 0) + sc.get("resubmitted", 0),
            "rejected_count": sc.get("l1_rejected", 0) + sc.get("client_rejected", 0),
            "draft_count": sc.get("draft", 0),
            "shortage_hours": round(shortage, 1),
            "penalty_hours": round(penalty, 1),
            "target_hours": round(target, 1),
        },
        "calendar_hours": {k: round(v, 2) for k, v in cal_hours.items()},
        "monthly_project_hours": monthly_rows,
        "project_names": proj_names,
        "recent_timesheets": recent_rows,
    }


# ─── 2. Manager Descriptive ─────────────────────────────────────────────────

async def get_manager_descriptive(user: UserBase) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    fy_start, fy_end = _fy_range(now)
    org_id = user.organisation_id

    team_ids = await _get_team_user_ids(user)
    if not team_ids:
        return {"kpis": {}, "team_members": [], "monthly_project_hours": [], "heatmap": []}

    settings = await _get_org_settings(org_id)
    std_hours = settings.standard_hours_per_day if settings else 8.0

    fy_ts = await _fy_timesheets(org_id, fy_start, fy_end, user_ids=team_ids)

    # KPIs
    total_hours = sum(t.total_hours for t in fy_ts)
    billable = sum(t.billable_hours for t in fy_ts)
    non_billable = total_hours - billable
    shortage = sum(t.shortage_hours for t in fy_ts)
    penalty = sum(t.penalty_hours for t in fy_ts)
    affected = len({str(t.user_id) for t in fy_ts if t.shortage_hours > 0})

    sc: dict[str, int] = defaultdict(int)
    for t in fy_ts:
        sc[t.timesheet_status.value] += 1

    submitted_ts = [t for t in fy_ts if t.timesheet_status.value in _SUBMITTED_STATUSES]
    on_time = sum(1 for t in submitted_ts if t.submitted_at)
    compliance_pct = _safe_pct(on_time, len(submitted_ts)) if submitted_ts else 100

    # Team members — current week
    week_start = now - timedelta(days=now.weekday())
    week_start_dt = datetime(week_start.year, week_start.month, week_start.day, tzinfo=timezone.utc)
    week_ts = [t for t in fy_ts if t.week_start_date == week_start_dt]
    week_by_user: dict[str, WeeklyTimesheet] = {str(t.user_id): t for t in week_ts}

    name_map = await resolve_user_names(team_ids, org_id)
    emp_codes = await resolve_emp_codes(team_ids, org_id)

    iam_employees = await _load_org_employees(org_id)
    desig_ids_map = _user_to_designation(iam_employees)
    desig_names = await _load_designation_names(org_id)

    team_rows = []
    for uid in team_ids:
        uid_str = str(uid)
        wt = week_by_user.get(uid_str)
        bp = _safe_pct(wt.billable_hours, wt.total_hours) if wt and wt.total_hours else 0
        desig_id = desig_ids_map.get(uid_str)
        team_rows.append({
            "user_id": uid_str,
            "name": name_map.get(uid, uid_str),
            "emp_code": emp_codes.get(uid),
            "role": desig_names.get(desig_id, "") if desig_id else "",
            "week_hours": round(wt.total_hours, 1) if wt else 0,
            "billable_pct": bp,
            "status": wt.timesheet_status.value if wt else "no_timesheet",
        })

    # Monthly project hours
    fy_entries = await _entries_for_timesheets([t.id for t in fy_ts])
    monthly_rows, proj_names = await _build_monthly_project_hours(fy_entries, fy_start, fy_end)

    # Heatmap — hours per user per month
    ts_by_user_month: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for t in fy_ts:
        uid_str = str(t.user_id)
        ml = _month_label(t.week_start_date.month)
        ts_by_user_month[uid_str][ml] += t.total_hours

    heatmap = []
    fy_months = [_month_label(m) for _, m in _months_in_range(fy_start, min(now, fy_end))]
    for uid in team_ids:
        uid_str = str(uid)
        months_data = []
        for ml in fy_months:
            hrs = ts_by_user_month[uid_str].get(ml, 0)
            y_idx = _MONTH_LABELS.index(ml)
            m_num = y_idx + 1
            y = fy_start.year if m_num >= 4 else fy_end.year
            monthly_target = _working_days(y, m_num) * std_hours
            months_data.append({
                "month": ml,
                "hours": round(hrs, 1),
                "utilization_pct": round(hrs / monthly_target * 100) if monthly_target else 0,
            })
        desig_id = desig_ids_map.get(uid_str)
        heatmap.append({
            "name": name_map.get(uid, uid_str),
            "role": desig_names.get(desig_id, "") if desig_id else "",
            "months": months_data,
        })

    return {
        "fy_label": f"FY {fy_start.year}–{str(fy_end.year)[2:]}",
        "kpis": {
            "team_hours_ytd": round(total_hours, 1),
            "billable_hours": round(billable, 1),
            "non_billable_hours": round(non_billable, 1),
            "pending_approvals": sc.get("submitted", 0) + sc.get("resubmitted", 0),
            "l1_pending": sc.get("submitted", 0),
            "resubmitted": sc.get("resubmitted", 0),
            "team_compliance_pct": compliance_pct,
            "on_time_count": on_time,
            "total_submissions": len(submitted_ts),
            "team_shortage_hours": round(shortage, 1),
            "affected_employees": affected,
            "penalty_hours": round(penalty, 1),
        },
        "team_members": team_rows,
        "monthly_project_hours": monthly_rows,
        "project_names": proj_names,
        "heatmap": heatmap,
        "heatmap_months": fy_months,
    }


# ─── 3. HR Descriptive ──────────────────────────────────────────────────────

async def get_hr_descriptive(
    user: UserBase,
    bu_filter: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    fy_start, fy_end = _fy_range(now)
    org_id = user.organisation_id

    settings = await _get_org_settings(org_id)
    max_weekly = settings.max_hours_per_week if settings else 45

    iam_emps = await _load_org_employees(org_id)
    user_org = _user_to_org_unit(iam_emps)
    dept_names = await _load_dept_names(org_id)
    bu_names = await _load_bu_names(org_id)

    # Filter employees by BU if requested
    if bu_filter:
        emp_user_ids = [uid for uid, (bu, _) in user_org.items() if bu == bu_filter]
    else:
        emp_user_ids = list(user_org.keys())

    emp_oids = []
    for uid in emp_user_ids:
        try:
            emp_oids.append(ObjectId(uid))
        except Exception:
            pass

    fy_ts = await _fy_timesheets(org_id, fy_start, fy_end, user_ids=emp_oids or None)

    # Filter to selected employees
    emp_set = set(emp_user_ids)
    if bu_filter:
        fy_ts = [t for t in fy_ts if str(t.user_id) in emp_set]

    total_hours = sum(t.total_hours for t in fy_ts)
    billable = sum(t.billable_hours for t in fy_ts)
    non_billable = total_hours - billable
    shortage = sum(t.shortage_hours for t in fy_ts)

    submitted_ts = [t for t in fy_ts if t.timesheet_status.value in _SUBMITTED_STATUSES]
    on_time = len(submitted_ts)
    late = 0
    missing_count = len(emp_user_ids) - len({str(t.user_id) for t in fy_ts})

    overtime_violations = sum(1 for t in fy_ts if t.total_hours > max_weekly)
    shortage_violations = sum(1 for t in fy_ts if t.shortage_hours > 0)

    compliance_pct = _safe_pct(on_time, on_time + late + missing_count) if (on_time + missing_count) else 100
    utilization_pct = _safe_pct(billable, total_hours)

    # Department compliance
    dept_hours: dict[str, dict[str, float]] = defaultdict(lambda: {"total": 0, "billable": 0, "submitted": 0, "count": 0, "shortage": 0, "violations": 0, "headcount": 0})
    for uid in emp_user_ids:
        bu, dept = user_org.get(uid, (None, None))
        if dept:
            dept_hours[dept]["headcount"] += 1

    for t in fy_ts:
        uid_str = str(t.user_id)
        _, dept = user_org.get(uid_str, (None, None))
        if not dept:
            dept = "_unassigned"
        dept_hours[dept]["total"] += t.total_hours
        dept_hours[dept]["billable"] += t.billable_hours
        dept_hours[dept]["shortage"] += t.shortage_hours
        if t.timesheet_status.value in _SUBMITTED_STATUSES:
            dept_hours[dept]["submitted"] += 1
        dept_hours[dept]["count"] += 1
        if t.total_hours > max_weekly:
            dept_hours[dept]["violations"] += 1
        if t.shortage_hours > 0:
            dept_hours[dept]["violations"] += 1

    dept_compliance = []
    for dept_id, data in dept_hours.items():
        if dept_id == "_unassigned":
            continue
        name = dept_names.get(dept_id, dept_id)
        pct = _safe_pct(data["submitted"], data["count"]) if data["count"] else 0
        dept_compliance.append({"dept_name": name, "compliance_pct": pct})
    dept_compliance.sort(key=lambda x: x["compliance_pct"], reverse=True)

    # Monthly org hours
    monthly_hours: dict[str, dict[str, float]] = defaultdict(lambda: {"billable": 0, "non_billable": 0})
    for t in fy_ts:
        ml = _month_label(t.week_start_date.month)
        monthly_hours[ml]["billable"] += t.billable_hours
        monthly_hours[ml]["non_billable"] += t.non_billable_hours

    monthly_org = []
    for _y, m in _months_in_range(fy_start, fy_end):
        ml = _month_label(m)
        d = monthly_hours.get(ml, {"billable": 0, "non_billable": 0})
        monthly_org.append({"month": ml, "billable": round(d["billable"], 1), "non_billable": round(d["non_billable"], 1)})

    # Department summary table
    dept_summary = []
    for dept_id, data in dept_hours.items():
        if dept_id == "_unassigned":
            continue
        name = dept_names.get(dept_id, dept_id)
        hc = data["headcount"]
        th = data["total"]
        bp = _safe_pct(data["billable"], th)
        otp = _safe_pct(data["submitted"], data["count"]) if data["count"] else 0
        avg_short = round(data["shortage"] / data["count"], 1) if data["count"] else 0
        dept_summary.append({
            "dept": name,
            "headcount": hc,
            "total_hours": round(th, 1),
            "billable_pct": bp,
            "on_time_pct": otp,
            "violations": data["violations"],
            "avg_shortage": avg_short,
        })
    dept_summary.sort(key=lambda x: x["dept"])

    # BU comparison data
    bu_data: dict[str, dict[str, float]] = defaultdict(lambda: {
        "headcount": 0, "total": 0, "billable": 0, "submitted": 0, "count": 0,
        "violations": 0, "shortage": 0, "on_time": 0,
    })
    for uid in emp_user_ids:
        bu, _ = user_org.get(uid, (None, None))
        if bu:
            bu_data[bu]["headcount"] += 1
    for t in fy_ts:
        uid_str = str(t.user_id)
        bu, _ = user_org.get(uid_str, (None, None))
        if not bu:
            continue
        bu_data[bu]["total"] += t.total_hours
        bu_data[bu]["billable"] += t.billable_hours
        bu_data[bu]["count"] += 1
        bu_data[bu]["shortage"] += t.shortage_hours
        if t.timesheet_status.value in _SUBMITTED_STATUSES:
            bu_data[bu]["submitted"] += 1
            bu_data[bu]["on_time"] += 1
        if t.total_hours > max_weekly:
            bu_data[bu]["violations"] += 1

    bu_comparison = []
    for bu_id, d in bu_data.items():
        name = bu_names.get(bu_id, bu_id)
        bu_comparison.append({
            "bu_name": name,
            "bu_id": bu_id,
            "headcount": d["headcount"],
            "total_hours": round(d["total"], 1),
            "billable_pct": _safe_pct(d["billable"], d["total"]),
            "compliance_pct": _safe_pct(d["submitted"], d["count"]) if d["count"] else 0,
            "utilization_pct": _safe_pct(d["billable"], d["total"]),
            "on_time_pct": _safe_pct(d["on_time"], d["count"]) if d["count"] else 0,
            "violations": d["violations"],
            "avg_shortage": round(d["shortage"] / d["count"], 1) if d["count"] else 0,
        })

    # Monthly compliance trend per BU (for the line chart)
    bu_monthly: dict[str, dict[str, dict[str, int]]] = defaultdict(lambda: defaultdict(lambda: {"submitted": 0, "count": 0}))
    for t in fy_ts:
        uid_str = str(t.user_id)
        bu, _ = user_org.get(uid_str, (None, None))
        if not bu:
            continue
        ml = _month_label(t.week_start_date.month)
        bu_monthly[bu][ml]["count"] += 1
        if t.timesheet_status.value in _SUBMITTED_STATUSES:
            bu_monthly[bu][ml]["submitted"] += 1

    fy_month_labels = [_month_label(m) for _, m in _months_in_range(fy_start, min(now, fy_end))]
    bu_monthly_trend = []
    for ml in fy_month_labels:
        row: dict[str, Any] = {"month": ml}
        for bu_id in bu_data:
            name = bu_names.get(bu_id, bu_id)
            d = bu_monthly[bu_id].get(ml, {"submitted": 0, "count": 0})
            row[name] = _safe_pct(d["submitted"], d["count"]) if d["count"] else 0
        bu_monthly_trend.append(row)

    return {
        "fy_label": f"FY {fy_start.year}–{str(fy_end.year)[2:]}",
        "kpis": {
            "org_total_hours_ytd": round(total_hours, 1),
            "billable_hours": round(billable, 1),
            "non_billable_hours": round(non_billable, 1),
            "submission_compliance_pct": compliance_pct,
            "on_time": on_time,
            "late": late,
            "missing": missing_count,
            "total_submissions": on_time + late,
            "policy_violations": overtime_violations + shortage_violations,
            "overtime_violations": overtime_violations,
            "shortage_violations": shortage_violations,
            "total_shortage_hours": round(shortage, 1),
            "avg_utilization_pct": utilization_pct,
        },
        "department_compliance": dept_compliance,
        "monthly_org_hours": monthly_org,
        "department_summary": dept_summary,
        "bu_comparison": bu_comparison,
        "bu_monthly_trend": bu_monthly_trend,
        "bu_names": [bu_names.get(bu_id, bu_id) for bu_id in bu_data],
        "business_units": [{"id": k, "name": v} for k, v in bu_names.items()],
    }


# ─── 4. CFO Descriptive ─────────────────────────────────────────────────────

async def get_cfo_descriptive(
    user: UserBase,
    bu_filter: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    fy_start, fy_end = _fy_range(now)
    org_id = user.organisation_id

    settings = await _get_org_settings(org_id)
    std_hours = settings.standard_hours_per_day if settings else 8.0

    iam_emps = await _load_org_employees(org_id)
    user_org = _user_to_org_unit(iam_emps)
    bu_names = await _load_bu_names(org_id)

    fy_ts = await _fy_timesheets(org_id, fy_start, fy_end)

    if bu_filter:
        emp_in_bu = {uid for uid, (bu, _) in user_org.items() if bu == bu_filter}
        fy_ts = [t for t in fy_ts if str(t.user_id) in emp_in_bu]

    ts_ids = [t.id for t in fy_ts]
    entries = await _entries_for_timesheets(ts_ids)

    ts_user_map = {str(t.id): str(t.user_id) for t in fy_ts}

    ra_rates, proj_rates = await _build_rate_lookups(org_id, std_hours)

    # Load project and client data
    all_projects = await Project.find({"organisation_id": org_id, "deleted_on": None}).to_list()
    proj_map = {str(p.id): p for p in all_projects}
    client_ids = list({p.client_id for p in all_projects})
    clients = await Client.find({"_id": {"$in": client_ids}}).to_list() if client_ids else []
    client_map = {str(c.id): c.name for c in clients}
    proj_client_map = {str(p.id): client_map.get(str(p.client_id), "Unknown") for p in all_projects}

    # Compute revenue per entry
    total_revenue = 0.0
    total_non_billable_cost = 0.0
    total_billable_hours = 0.0
    total_non_billable_hours = 0.0

    revenue_by_client: dict[str, float] = defaultdict(float)
    monthly_rev_cost: dict[str, dict[str, float]] = defaultdict(lambda: {"revenue": 0, "cost": 0})
    project_financials: dict[str, dict[str, float]] = defaultdict(lambda: {
        "billable_hours": 0, "non_billable_hours": 0, "revenue": 0, "cost": 0,
    })

    for e in entries:
        pid_str = str(e.project_id)
        uid_str = ts_user_map.get(str(e.weekly_timesheet_id), "")
        rate = _effective_rate(pid_str, uid_str, ra_rates, proj_rates)
        ml = _month_label(e.entry_date.month)
        client_name = proj_client_map.get(pid_str, "Unknown")

        if e.is_billable:
            rev = e.hours * rate
            total_revenue += rev
            total_billable_hours += e.hours
            revenue_by_client[client_name] += rev
            monthly_rev_cost[ml]["revenue"] += rev
            project_financials[pid_str]["billable_hours"] += e.hours
            project_financials[pid_str]["revenue"] += rev
        else:
            cost = e.hours * rate
            total_non_billable_cost += cost
            total_non_billable_hours += e.hours
            monthly_rev_cost[ml]["cost"] += cost
            project_financials[pid_str]["non_billable_hours"] += e.hours
            project_financials[pid_str]["cost"] += cost

    avg_rate = round(total_revenue / total_billable_hours, 2) if total_billable_hours else 0

    # Revenue leakage = shortage penalty revenue
    shortage_penalty_rev = sum(t.penalty_hours for t in fy_ts) * avg_rate if avg_rate else 0

    # Revenue by client — percentages
    total_rev_for_pct = sum(revenue_by_client.values()) or 1
    rev_client_rows = sorted(
        [{"name": k, "value": round(v / total_rev_for_pct * 100, 1), "revenue": round(v, 2)}
         for k, v in revenue_by_client.items()],
        key=lambda x: x["value"], reverse=True,
    )

    # Monthly revenue vs cost
    monthly_rev_cost_rows = []
    for _y, m in _months_in_range(fy_start, fy_end):
        ml = _month_label(m)
        d = monthly_rev_cost.get(ml, {"revenue": 0, "cost": 0})
        monthly_rev_cost_rows.append({
            "month": ml,
            "revenue": round(d["revenue"] / 1000, 1),
            "cost": round(d["cost"] / 1000, 1),
        })

    # Project profitability table
    proj_table = []
    for pid, fin in project_financials.items():
        p = proj_map.get(pid)
        if not p:
            continue
        budget = p.budget_cost or 0
        actual = fin["revenue"] + fin["cost"]
        margin = _safe_pct(fin["revenue"] - actual, fin["revenue"]) if fin["revenue"] else 0
        status = "On Track"
        if budget and actual > budget * 0.9:
            status = "At Risk" if actual <= budget else "Over Budget"

        proj_table.append({
            "project": p.name,
            "client": proj_client_map.get(pid, ""),
            "type": p.project_type.value if p.project_type else "",
            "budget": f"${budget:,.0f}" if budget else "—",
            "actual_cost": f"${actual:,.0f}",
            "revenue": f"${fin['revenue']:,.0f}",
            "margin_pct": round(margin, 1),
            "status": status,
        })
    proj_table.sort(key=lambda x: x["project"])

    # BU comparison
    bu_rev: dict[str, dict[str, float]] = defaultdict(lambda: {
        "revenue": 0, "billable_hours": 0, "margin": 0, "cost": 0,
    })
    for e in entries:
        pid_str = str(e.project_id)
        uid_str = ts_user_map.get(str(e.weekly_timesheet_id), "")
        rate = _effective_rate(pid_str, uid_str, ra_rates, proj_rates)
        bu, _ = user_org.get(uid_str, (None, None))
        if not bu:
            continue
        if e.is_billable:
            bu_rev[bu]["revenue"] += e.hours * rate
            bu_rev[bu]["billable_hours"] += e.hours
        else:
            bu_rev[bu]["cost"] += e.hours * rate

    bu_comp = []
    for bu_id, d in bu_rev.items():
        name = bu_names.get(bu_id, bu_id)
        total_bu = d["revenue"] + d["cost"]
        bu_comp.append({
            "bu_name": name,
            "bu_id": bu_id,
            "revenue": round(d["revenue"], 2),
            "billable_hours": round(d["billable_hours"], 1),
            "avg_rate": round(d["revenue"] / d["billable_hours"], 2) if d["billable_hours"] else 0,
            "margin_pct": _safe_pct(d["revenue"] - total_bu, d["revenue"]) if d["revenue"] else 0,
        })

    # Per-BU monthly revenue trend (for compare line chart)
    bu_monthly_rev: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for e in entries:
        if not e.is_billable:
            continue
        pid_str = str(e.project_id)
        uid_str = ts_user_map.get(str(e.weekly_timesheet_id), "")
        rate = _effective_rate(pid_str, uid_str, ra_rates, proj_rates)
        bu, _ = user_org.get(uid_str, (None, None))
        if not bu:
            continue
        ml = _month_label(e.entry_date.month)
        bu_monthly_rev[bu][ml] += e.hours * rate

    fy_month_labels = [_month_label(m) for _, m in _months_in_range(fy_start, min(now, fy_end))]
    bu_revenue_trend = []
    for ml in fy_month_labels:
        row: dict[str, Any] = {"month": ml}
        for bu_id in bu_rev:
            name = bu_names.get(bu_id, bu_id)
            row[name] = round(bu_monthly_rev[bu_id].get(ml, 0) / 1000, 1)
        bu_revenue_trend.append(row)

    return {
        "fy_label": f"FY {fy_start.year}–{str(fy_end.year)[2:]}",
        "kpis": {
            "billable_revenue_ytd": round(total_revenue, 2),
            "non_billable_cost": round(total_non_billable_cost, 2),
            "avg_billable_rate": avg_rate,
            "revenue_leakage": round(shortage_penalty_rev, 2),
            "billable_hours": round(total_billable_hours, 1),
            "non_billable_hours": round(total_non_billable_hours, 1),
        },
        "revenue_by_client": rev_client_rows,
        "monthly_revenue_cost": monthly_rev_cost_rows,
        "project_profitability": proj_table,
        "bu_comparison": bu_comp,
        "bu_revenue_trend": bu_revenue_trend,
        "bu_names": [bu_names.get(bu_id, bu_id) for bu_id in bu_rev],
        "business_units": [{"id": k, "name": v} for k, v in bu_names.items()],
    }


# ─── 5. MD Descriptive ──────────────────────────────────────────────────────

async def get_md_descriptive(user: UserBase) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    fy_start, fy_end = _fy_range(now)
    org_id = user.organisation_id

    settings = await _get_org_settings(org_id)
    std_hours = settings.standard_hours_per_day if settings else 8.0
    max_weekly = settings.max_hours_per_week if settings else 45

    iam_emps = await _load_org_employees(org_id)
    user_org = _user_to_org_unit(iam_emps)
    bu_names = await _load_bu_names(org_id)

    total_headcount = len(iam_emps)

    fy_ts = await _fy_timesheets(org_id, fy_start, fy_end)
    ts_ids = [t.id for t in fy_ts]
    entries = await _entries_for_timesheets(ts_ids)
    ts_user_map = {str(t.id): str(t.user_id) for t in fy_ts}

    ra_rates, proj_rates = await _build_rate_lookups(org_id, std_hours)

    total_hours = sum(t.total_hours for t in fy_ts)
    billable_hours_total = sum(t.billable_hours for t in fy_ts)
    utilization = _safe_pct(billable_hours_total, total_hours)

    submitted_ts = [t for t in fy_ts if t.timesheet_status.value in _SUBMITTED_STATUSES]
    compliance = _safe_pct(len(submitted_ts), len(fy_ts)) if fy_ts else 100

    # Revenue calculation
    total_revenue = 0.0
    total_cost = 0.0
    for e in entries:
        pid_str = str(e.project_id)
        uid_str = ts_user_map.get(str(e.weekly_timesheet_id), "")
        rate = _effective_rate(pid_str, uid_str, ra_rates, proj_rates)
        if e.is_billable:
            total_revenue += e.hours * rate
        else:
            total_cost += e.hours * rate

    # Revenue by BU
    bu_metrics: dict[str, dict[str, float]] = defaultdict(lambda: {
        "revenue": 0, "headcount": 0, "total_hours": 0, "billable_hours": 0,
        "submitted": 0, "count": 0, "violations": 0,
    })
    for uid in user_org:
        bu, _ = user_org[uid]
        if bu:
            bu_metrics[bu]["headcount"] += 1

    for t in fy_ts:
        uid_str = str(t.user_id)
        bu, _ = user_org.get(uid_str, (None, None))
        if not bu:
            continue
        bu_metrics[bu]["total_hours"] += t.total_hours
        bu_metrics[bu]["billable_hours"] += t.billable_hours
        bu_metrics[bu]["count"] += 1
        if t.timesheet_status.value in _SUBMITTED_STATUSES:
            bu_metrics[bu]["submitted"] += 1
        if t.total_hours > max_weekly:
            bu_metrics[bu]["violations"] += 1

    for e in entries:
        pid_str = str(e.project_id)
        uid_str = ts_user_map.get(str(e.weekly_timesheet_id), "")
        bu, _ = user_org.get(uid_str, (None, None))
        if not bu:
            continue
        rate = _effective_rate(pid_str, uid_str, ra_rates, proj_rates)
        if e.is_billable:
            bu_metrics[bu]["revenue"] += e.hours * rate

    total_rev_for_pie = sum(d["revenue"] for d in bu_metrics.values()) or 1
    revenue_by_bu = sorted(
        [{"name": bu_names.get(bu_id, bu_id), "value": round(d["revenue"] / total_rev_for_pie * 100, 1), "revenue": round(d["revenue"], 2)}
         for bu_id, d in bu_metrics.items()],
        key=lambda x: x["value"], reverse=True,
    )

    # Quarterly performance
    quarter_data: dict[str, dict[str, float]] = defaultdict(lambda: {"revenue": 0, "cost": 0})
    for e in entries:
        pid_str = str(e.project_id)
        uid_str = ts_user_map.get(str(e.weekly_timesheet_id), "")
        rate = _effective_rate(pid_str, uid_str, ra_rates, proj_rates)
        ql = _quarter_label(e.entry_date.month)
        if e.is_billable:
            quarter_data[ql]["revenue"] += e.hours * rate
        else:
            quarter_data[ql]["cost"] += e.hours * rate

    quarterly = []
    for q in ["Q1", "Q2", "Q3", "Q4"]:
        d = quarter_data.get(q, {"revenue": 0, "cost": 0})
        rev = d["revenue"]
        cost = d["cost"]
        quarterly.append({
            "quarter": q,
            "revenue": round(rev / 1_000_000, 2),
            "cost": round(cost / 1_000_000, 2),
            "margin": round((rev - cost) / 1_000_000, 2),
        })

    # BU scorecard table
    bu_scorecard = []
    for bu_id, d in bu_metrics.items():
        name = bu_names.get(bu_id, bu_id)
        util = _safe_pct(d["billable_hours"], d["total_hours"])
        br = _safe_pct(d["billable_hours"], d["total_hours"])
        comp = _safe_pct(d["submitted"], d["count"]) if d["count"] else 0

        health = "Excellent" if comp >= 90 and util >= 85 else "Good" if comp >= 80 and util >= 75 else "At Risk" if comp >= 70 else "Critical"
        health_variant = "success" if health == "Excellent" else "info" if health == "Good" else "warning" if health == "At Risk" else "destructive"

        bu_scorecard.append({
            "bu": name,
            "revenue": f"${d['revenue']:,.0f}",
            "headcount": int(d["headcount"]),
            "utilization": util,
            "billable_ratio": br,
            "compliance": comp,
            "health": health,
            "health_variant": health_variant,
        })
    bu_scorecard.sort(key=lambda x: x["bu"])

    return {
        "fy_label": f"FY {fy_start.year}–{str(fy_end.year)[2:]}",
        "kpis": {
            "org_revenue_ytd": round(total_revenue, 2),
            "workforce_utilization": utilization,
            "org_headcount": total_headcount,
            "billable_headcount": len({str(t.user_id) for t in fy_ts if t.billable_hours > 0}),
            "compliance_score": compliance,
        },
        "revenue_by_bu": revenue_by_bu,
        "quarterly_performance": quarterly,
        "bu_scorecard": bu_scorecard,
    }
