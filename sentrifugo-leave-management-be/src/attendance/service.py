"""Attendance business logic — query and summarize.

Punches arrive from the biometric database via ``src.attendance.sync``; nothing
here writes them.
"""

from datetime import date, datetime, timedelta

from bson import ObjectId
from fastapi import status

from src.database import get_db
from src.dependencies import UserBase, user_is_hr
from src.employment_status import deactivated_user_ids, exclude_inactive_filter
from src.exceptions import DomainException
from src.logger import logger
from src.utils import to_oid
from src.attendance.schemas import EmployeeDayAttendance, PunchEntry

PUNCHES_COLLECTION = "attendance_punches"
INGEST_STATE_COLLECTION = "attendance_ingest_state"


async def authorize_employee_attendance_view(
    current_user: UserBase, terminal_user_id: str
) -> None:
    """Guard the per-employee attendance surfaces.

    Allowed when the caller is HR (org-scoped), the terminal belongs to the
    caller themselves, or the target employee is in the caller's reporting line
    (L1/L2 manager). Raises 403 otherwise.
    """
    # HR (or org / super admin) may view any employee in their org.
    if user_is_hr(current_user):
        return

    db = get_db()
    org_id = ObjectId(current_user.org_id) if current_user.org_id else None

    # Resolve the employee behind this biometric terminal id via a punch in the
    # caller's organisation (punches carry the employee's user_id).
    punch = await db[PUNCHES_COLLECTION].find_one(
        {"organisation_id": org_id, "terminal_user_id": terminal_user_id},
        {"employee_user_id": 1},
    )
    target_user_id = punch.get("employee_user_id") if punch else None

    # Self.
    if target_user_id is not None and str(target_user_id) == str(current_user.user_id):
        return

    # Reporting line: caller is the L1/L2 manager of the target employee.
    if target_user_id is not None:
        caller_oid = to_oid(current_user.user_id)
        refs = [caller_oid]
        caller_emp = await db["employees"].find_one(
            {"user_id": caller_oid, "is_deleted": {"$ne": True}}, {"_id": 1}
        )
        if caller_emp and caller_emp["_id"] != caller_oid:
            refs.append(caller_emp["_id"])
        managed = await db["employees"].find_one(
            {
                "user_id": to_oid(target_user_id),
                "$or": [{"l1_manager_id": {"$in": refs}}, {"l2_manager_id": {"$in": refs}}],
                "is_deleted": {"$ne": True},
            }
        )
        if managed:
            return

    raise DomainException(
        message="You do not have permission to view this employee's attendance",
        code="FORBIDDEN",
        status_code=status.HTTP_403_FORBIDDEN,
    )


async def _manager_refs(manager_user_id: str) -> list:
    """ObjectIds that could identify this manager in the employees collection.

    ``l1_manager_id`` may store either the manager's ``user_id`` ObjectId or
    their employee document ``_id``; return both so a reportee match works
    regardless of which was written. Mirrors the same resolution used by
    ``authorize_employee_attendance_view`` and the manager module.
    """
    db = get_db()
    mgr_oid = to_oid(manager_user_id)
    refs = [mgr_oid]
    emp = await db["employees"].find_one(
        {"user_id": mgr_oid, "is_deleted": {"$ne": True}}, {"_id": 1}
    )
    if emp and emp["_id"] != mgr_oid:
        refs.append(emp["_id"])
    return refs


async def _get_l1_reportee_ids(manager_user_id: str) -> list:
    """user_id ObjectIds of the manager's ACTIVE L1 (direct) reports.

    L1 only — the team-attendance roster shows direct reports, matching the
    "current user is the employee's L1" rule. "Active" mirrors the leave team
    views: soft-deleted employee records and those whose employment_status is
    flagged inactive (exit / terminated / retired / absconded) are excluded, as
    are employees whose USER account has been ended. So an exited reportee drops
    off the roster instead of showing as a permanent Absent.
    """
    db = get_db()
    refs = await _manager_refs(manager_user_id)
    query = {
        "l1_manager_id": {"$in": refs},
        "is_deleted": {"$ne": True},
        **await exclude_inactive_filter(db),
    }
    docs = await db["employees"].find(query, {"user_id": 1}).to_list(length=None)
    user_ids = [doc["user_id"] for doc in docs if doc.get("user_id")]
    # The user account has its own lifecycle — drop ids whose user is ended even
    # if the employee record still looks active.
    dead = await deactivated_user_ids(db, user_ids)
    return [u for u in user_ids if to_oid(u) not in dead]


async def _approved_leave_on_day(
    reportee_ids: list, punch_date: date
) -> dict[str, str | None]:
    """Map reportee user_id (str) -> leave type name for approved leave that
    covers ``punch_date``.

    One query across the whole team (unlike ``_get_approved_leave_days``, which
    is per-employee). Leave requests store user_id as an ObjectId and
    start/end as ISO "YYYY-MM-DD" strings, so the day-cover match is a string
    range test.
    """
    if not reportee_ids:
        return {}
    db = get_db()
    day_str = punch_date.isoformat()
    pipeline = [
        {
            "$match": {
                "user_id": {"$in": reportee_ids},
                "status": "APPROVED",
                "deleted_on": None,
                "start_date": {"$lte": day_str},
                "end_date": {"$gte": day_str},
            }
        },
        {
            "$lookup": {
                "from": "leave_types",
                "localField": "leave_type_id",
                "foreignField": "_id",
                "as": "_lt",
            }
        },
        {"$addFields": {"leave_type_name": {"$arrayElemAt": ["$_lt.name", 0]}}},
        {"$project": {"user_id": 1, "leave_type_name": 1}},
    ]
    docs = await db["leave_requests"].aggregate(pipeline).to_list(length=None)
    leave_map: dict[str, str | None] = {}
    for doc in docs:
        # First writer wins if two leaves overlap the same day.
        leave_map.setdefault(str(doc["user_id"]), doc.get("leave_type_name"))
    return leave_map


async def _reportee_name_map(reportee_ids: list) -> dict[str, str]:
    """Map reportee user_id (str) -> display name, resolved from the employees
    mirror with a users-collection fallback, then work_email, then the raw id —
    so a row never renders a placeholder. Mirrors the manager module."""
    if not reportee_ids:
        return {}
    db = get_db()
    employees = await db["employees"].find(
        {"user_id": {"$in": reportee_ids}, "is_deleted": {"$ne": True}},
        {"user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "work_email": 1},
    ).to_list(length=None)
    user_oids = [e["user_id"] for e in employees if e.get("user_id")]
    users = await db["users"].find(
        {"_id": {"$in": user_oids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1},
    ).to_list(length=None)
    user_map = {str(u["_id"]): u for u in users}

    def _first_last(doc: dict) -> str:
        first = (doc.get("first_name") or "").strip()
        last = (doc.get("last_name") or "").strip()
        return f"{first} {last}".strip()

    name_map: dict[str, str] = {}
    for emp in employees:
        uid = str(emp["user_id"])
        user = user_map.get(uid) or {}
        # Prefer first + last, resolved from whichever source actually has them
        # (employee mirror first, then users). A name-less users doc must not
        # shadow real employee names — that was surfacing the work_email instead.
        name_map[uid] = (
            _first_last(emp) or _first_last(user)
            or emp.get("name") or emp.get("full_name")
            or user.get("full_name") or user.get("name")
            or emp.get("work_email") or user.get("email")
            or uid
        )
    for oid in reportee_ids:
        name_map.setdefault(str(oid), str(oid))
    return name_map


async def _reportee_department_map(reportee_ids: list) -> dict[str, str]:
    """Map reportee user_id (str) -> HR department name, via the employees
    mirror's ``department_id`` and the departments collection.

    Resolved here rather than in the FE: listing employees from IAM needs the
    `core_hr:create_resource` permission, which a manager does not hold, so that
    lookup returned 403 and the column rendered blank for every row.
    """
    if not reportee_ids:
        return {}
    db = get_db()
    employees = await db["employees"].find(
        {"user_id": {"$in": reportee_ids}, "is_deleted": {"$ne": True}},
        {"user_id": 1, "department_id": 1},
    ).to_list(length=None)

    dept_ids = [e["department_id"] for e in employees if e.get("department_id")]
    if not dept_ids:
        return {}

    # Departments are optional in some envs — a missing collection must not take
    # the whole roster down, it just leaves the column empty.
    try:
        # The departments collection stores the label as `name`. Some older
        # call sites project `department_name`, which does not exist on the
        # document and silently resolves to None — read both, `name` first.
        dept_docs = await db["departments"].find(
            {"_id": {"$in": dept_ids}}, {"name": 1, "department_name": 1},
        ).to_list(length=None)
    except Exception as exc:  # pragma: no cover - departments are optional
        logger.warning("Could not resolve department names", error=str(exc))
        return {}

    dept_names = {
        d["_id"]: (d.get("name") or d.get("department_name")) for d in dept_docs
    }
    return {
        str(e["user_id"]): dept_names[e["department_id"]]
        for e in employees
        if e.get("department_id") and dept_names.get(e["department_id"])
    }


async def get_team_day(
    organisation_id: str,
    manager_user_id: str,
    punch_date: date,
) -> list[EmployeeDayAttendance]:
    """Daily attendance roster for the caller's direct (L1) reports.

    Roster-first: every reportee gets a row, then the day's punches are
    left-joined. A reportee with no punch reads ``no-time`` (Absent) unless an
    approved leave covers the day, in which case it reads ``leave`` with the
    specific type. Scoped to the manager's reportees server-side — the caller
    only ever sees their own team.
    """
    db = get_db()
    org_id = ObjectId(organisation_id) if organisation_id else None

    reportee_ids = await _get_l1_reportee_ids(manager_user_id)
    if not reportee_ids:
        return []

    name_map = await _reportee_name_map(reportee_ids)
    dept_map = await _reportee_department_map(reportee_ids)
    leave_map = await _approved_leave_on_day(reportee_ids, punch_date)

    # Punches store employee_user_id as a string (see get_my_day); match both
    # str and ObjectId forms defensively so a differently-typed row still joins.
    id_variants = [str(u) for u in reportee_ids] + list(reportee_ids)
    punch_dt = datetime.combine(punch_date, datetime.min.time())
    punches = await db[PUNCHES_COLLECTION].find(
        {
            "organisation_id": org_id,
            "employee_user_id": {"$in": id_variants},
            "punch_date": punch_dt,
        },
    ).sort("event_time", 1).to_list(length=None)

    grouped: dict[str, list[dict]] = {}
    for p in punches:
        grouped.setdefault(str(p.get("employee_user_id")), []).append(p)

    # A reportee with no punch on this day still needs a terminal_user_id so the
    # FE can drill into their month (that endpoint keys on the biometric id).
    # Backfill it from each such reportee's most recent punch on any date.
    missing = [oid for oid in reportee_ids if str(oid) not in grouped]
    terminal_map: dict[str, str] = {}
    if missing:
        missing_variants = [str(u) for u in missing] + list(missing)
        recent = await db[PUNCHES_COLLECTION].aggregate([
            {"$match": {"organisation_id": org_id, "employee_user_id": {"$in": missing_variants}}},
            {"$sort": {"punch_date": -1}},
            {"$group": {"_id": "$employee_user_id", "terminal_user_id": {"$first": "$terminal_user_id"}}},
        ]).to_list(length=None)
        terminal_map = {str(r["_id"]): r.get("terminal_user_id") or "" for r in recent}

    results: list[EmployeeDayAttendance] = []
    for oid in reportee_ids:
        uid = str(oid)
        day_punches = grouped.get(uid)
        if day_punches:
            summary = _compute_day_record(day_punches)
            results.append(EmployeeDayAttendance(
                employee_user_id=uid,
                terminal_user_id=day_punches[0].get("terminal_user_id", ""),
                user_name=name_map.get(uid) or day_punches[0].get("user_name") or uid,
                group_name=day_punches[0].get("group_name"),
                department_name=dept_map.get(uid),
                punch_date=punch_date,
                first_in=summary["first_in"],
                last_out=summary["last_out"],
                total_hours=summary["total_hours"],
                work_hours=summary["work_hours"],
                punches=_punches_to_entries(day_punches),
                status=summary["status"],
            ))
        elif uid in leave_map:
            results.append(_leave_day_record(
                punch_date=punch_date,
                leave_type_name=leave_map[uid],
                terminal_user_id=terminal_map.get(uid, ""),
                user_name=name_map.get(uid, uid),
                group_name=None,
                employee_user_id=uid,
                department_name=dept_map.get(uid),
            ))
        else:
            # No punch and no leave — Absent.
            results.append(EmployeeDayAttendance(
                employee_user_id=uid,
                terminal_user_id=terminal_map.get(uid, ""),
                user_name=name_map.get(uid, uid),
                department_name=dept_map.get(uid),
                punch_date=punch_date,
                status="no-time",
            ))

    results.sort(key=lambda r: r.user_name.lower())
    return results


async def _get_approved_leave_days(
    employee_user_id: str,
    start: datetime,
    end: datetime,
) -> dict[date, str | None]:
    """Approved-leave dates for one employee within [start, end).

    Returns date -> leave type name. Leave requests store start/end as ISO
    "YYYY-MM-DD" strings, so the overlap match and expansion both work on
    strings. Only APPROVED leaves count — a pending request is not yet a
    confirmed leave, so it must not override the day's real state.
    """
    if not employee_user_id:
        return {}
    db = get_db()
    from_str = start.date().isoformat()
    # `end` is exclusive (first of next month); the last covered day is end-1.
    last_day = (end - timedelta(days=1)).date()
    to_str = last_day.isoformat()

    pipeline = [
        {
            "$match": {
                "user_id": to_oid(employee_user_id),
                "status": "APPROVED",
                "deleted_on": None,
                "start_date": {"$lte": to_str},
                "end_date": {"$gte": from_str},
            }
        },
        {
            "$lookup": {
                "from": "leave_types",
                "localField": "leave_type_id",
                "foreignField": "_id",
                "as": "_lt",
            }
        },
        {"$addFields": {"leave_type_name": {"$arrayElemAt": ["$_lt.name", 0]}}},
        {"$project": {"start_date": 1, "end_date": 1, "leave_type_name": 1}},
    ]

    docs = await db["leave_requests"].aggregate(pipeline).to_list(length=None)

    leave_days: dict[date, str | None] = {}
    for doc in docs:
        try:
            leave_start = date.fromisoformat(doc["start_date"][:10])
            leave_end = date.fromisoformat(doc["end_date"][:10])
        except (KeyError, ValueError, TypeError):
            continue
        # Clamp to the requested window so a leave spanning month boundaries
        # only contributes its in-window days.
        cursor = max(leave_start, start.date())
        stop = min(leave_end, last_day)
        while cursor <= stop:
            # First writer wins if two leaves overlap a day — unlikely, but keeps
            # the label stable.
            leave_days.setdefault(cursor, doc.get("leave_type_name"))
            cursor += timedelta(days=1)
    return leave_days


def _leave_day_record(
    punch_date: date,
    leave_type_name: str | None,
    terminal_user_id: str,
    user_name: str,
    group_name: str | None,
    employee_user_id: str | None,
    department_name: str | None = None,
) -> EmployeeDayAttendance:
    return EmployeeDayAttendance(
        employee_user_id=employee_user_id,
        terminal_user_id=terminal_user_id,
        user_name=user_name,
        group_name=group_name,
        department_name=department_name,
        punch_date=punch_date,
        punches=[],
        status="leave",
        leave_type_name=leave_type_name,
    )


def _format_duration(minutes: int) -> str:
    h, m = divmod(abs(minutes), 60)
    return f"{h}:{m:02d}"


def _dedupe_punches(punches: list[dict]) -> list[dict]:
    """Collapse repeat swipes of the same type in the same minute, sorted by time.

    A terminal double-read logs one physical punch twice (10:47 "in" recorded
    twice). The copy has no partner, so the day is flagged as an odd punch and
    the pairing walk throws away a real interval. Seconds are ignored: the
    duplicate rarely lands on the exact same second, and both the timeline and
    the summary render punches to the minute anyway. Only same-type repeats
    collapse — an "in" and an "out" in the same minute are a real (if very
    short) trip and both survive.
    """
    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for p in sorted(punches, key=lambda x: x["event_time"]):
        key = (p["punch_type"], p["event_time"].strftime("%Y-%m-%d %H:%M"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def _compute_day_record(punches: list[dict]) -> dict:
    """Given all punches for one employee on one day, compute summary."""
    if not punches:
        return {"first_in": None, "last_out": None, "total_hours": None, "work_hours": None, "status": "no-time"}

    sorted_punches = _dedupe_punches(punches)
    in_punches = [p for p in sorted_punches if p["punch_type"] == "in"]
    out_punches = [p for p in sorted_punches if p["punch_type"] == "out"]

    first_in = in_punches[0]["event_time"] if in_punches else None
    last_out = out_punches[-1]["event_time"] if out_punches else None

    total_minutes = 0
    work_minutes = 0

    if first_in and last_out and last_out > first_in:
        total_minutes = int((last_out - first_in).total_seconds() / 60)

    # Pair punches by walking the day in chronological order — the same rule the
    # punch-timeline UI uses to lay out its rows, so the totals always agree with
    # what the employee sees. Zipping the in/out lists by index instead shifts
    # every pair below a missing punch: each later "in" gets matched to a far
    # later "out", the intervals overlap, and work time balloons past the
    # first-in/last-out span (one real day reported 13:11 worked inside 8:24).
    open_in = None
    for p in sorted_punches:
        if p["punch_type"] == "in":
            # A fresh "in" supersedes one that is still open — that unclosed
            # "in" is the missing "out" the timeline flags, and since we cannot
            # know when they left it contributes no work time.
            open_in = p["event_time"]
        elif open_in is not None:
            if p["event_time"] > open_in:
                work_minutes += int((p["event_time"] - open_in).total_seconds() / 60)
            open_in = None

    status = "no-time"
    if work_minutes >= 480:
        status = "full"
    elif work_minutes >= 360:
        if first_in and first_in.hour >= 10:
            status = "late"
        else:
            status = "partial"
    elif work_minutes > 0:
        status = "partial"

    return {
        "first_in": first_in.strftime("%H:%M") if first_in else None,
        "last_out": last_out.strftime("%H:%M") if last_out else None,
        "total_hours": _format_duration(total_minutes) if total_minutes else None,
        "work_hours": _format_duration(work_minutes) if work_minutes else None,
        "status": status,
    }


def _punches_to_entries(punches: list[dict]) -> list[PunchEntry]:
    return [
        PunchEntry(
            time=p["event_time"].strftime("%H:%M"),
            type=p["punch_type"],
            terminal_name=p.get("terminal_name"),
        )
        for p in _dedupe_punches(punches)
    ]


async def get_employee_day(
    organisation_id: str,
    terminal_user_id: str,
    punch_date: date,
) -> EmployeeDayAttendance:
    """Get attendance for a single employee on a given date."""
    db = get_db()
    org_id = ObjectId(organisation_id)
    punch_dt = datetime.combine(punch_date, datetime.min.time())

    punches = await db[PUNCHES_COLLECTION].find(
        {"organisation_id": org_id, "terminal_user_id": terminal_user_id, "punch_date": punch_dt},
    ).sort("event_time", 1).to_list(length=None)

    if not punches:
        return EmployeeDayAttendance(
            terminal_user_id=terminal_user_id,
            user_name="",
            punch_date=punch_date,
        )

    summary = _compute_day_record(punches)
    return EmployeeDayAttendance(
        employee_user_id=punches[0].get("employee_user_id"),
        terminal_user_id=terminal_user_id,
        user_name=punches[0]["user_name"],
        group_name=punches[0].get("group_name"),
        punch_date=punch_date,
        first_in=summary["first_in"],
        last_out=summary["last_out"],
        total_hours=summary["total_hours"],
        work_hours=summary["work_hours"],
        punches=_punches_to_entries(punches),
        status=summary["status"],
    )


async def get_all_employees_day(
    organisation_id: str,
    punch_date: date,
) -> list[EmployeeDayAttendance]:
    """Get attendance for all employees on a given date."""
    db = get_db()
    org_id = ObjectId(organisation_id)
    punch_dt = datetime.combine(punch_date, datetime.min.time())

    punches = await db[PUNCHES_COLLECTION].find(
        {"organisation_id": org_id, "punch_date": punch_dt},
    ).sort("event_time", 1).to_list(length=None)

    grouped: dict[str, list[dict]] = {}
    for p in punches:
        grouped.setdefault(p["terminal_user_id"], []).append(p)

    results = []
    for user_id, user_punches in grouped.items():
        summary = _compute_day_record(user_punches)
        results.append(EmployeeDayAttendance(
            employee_user_id=user_punches[0].get("employee_user_id"),
            terminal_user_id=user_id,
            user_name=user_punches[0]["user_name"],
            group_name=user_punches[0].get("group_name"),
            punch_date=punch_date,
            first_in=summary["first_in"],
            last_out=summary["last_out"],
            total_hours=summary["total_hours"],
            work_hours=summary["work_hours"],
            punches=_punches_to_entries(user_punches),
            status=summary["status"],
        ))

    return results


async def get_employee_month(
    organisation_id: str,
    terminal_user_id: str,
    year: int,
    month: int,
) -> list[EmployeeDayAttendance]:
    """Get attendance for one employee for an entire month."""
    db = get_db()
    org_id = ObjectId(organisation_id)
    start = datetime.combine(date(year, month, 1), datetime.min.time())
    if month == 12:
        end = datetime.combine(date(year + 1, 1, 1), datetime.min.time())
    else:
        end = datetime.combine(date(year, month + 1, 1), datetime.min.time())

    punches = await db[PUNCHES_COLLECTION].find(
        {
            "organisation_id": org_id,
            "terminal_user_id": terminal_user_id,
            "punch_date": {"$gte": start, "$lt": end},
        },
    ).sort("event_time", 1).to_list(length=None)

    grouped: dict[date, list[dict]] = {}
    for p in punches:
        d = p["punch_date"].date() if isinstance(p["punch_date"], datetime) else p["punch_date"]
        grouped.setdefault(d, []).append(p)

    results = []
    for d, day_punches in sorted(grouped.items()):
        summary = _compute_day_record(day_punches)
        results.append(EmployeeDayAttendance(
            employee_user_id=day_punches[0].get("employee_user_id"),
            terminal_user_id=terminal_user_id,
            user_name=day_punches[0]["user_name"],
            group_name=day_punches[0].get("group_name"),
            punch_date=d,
            first_in=summary["first_in"],
            last_out=summary["last_out"],
            total_hours=summary["total_hours"],
            work_hours=summary["work_hours"],
            punches=_punches_to_entries(day_punches),
            status=summary["status"],
        ))

    # Overlay approved leaves onto no-punch days. Leaves are keyed by the
    # employee's user_id, which we read from any punch this month; if the
    # employee has no punches at all we can't resolve it, so leave is skipped.
    employee_user_id = punches[0].get("employee_user_id") if punches else None
    if employee_user_id:
        leave_days = await _get_approved_leave_days(str(employee_user_id), start, end)
        ident = punches[0]
        for d, leave_type_name in leave_days.items():
            if d in grouped:
                continue
            results.append(_leave_day_record(
                punch_date=d,
                leave_type_name=leave_type_name,
                terminal_user_id=terminal_user_id,
                user_name=ident["user_name"],
                group_name=ident.get("group_name"),
                employee_user_id=str(employee_user_id),
            ))
        results.sort(key=lambda r: r.punch_date)

    return results


async def get_my_day(
    organisation_id: str,
    employee_user_id: str,
    punch_date: date,
) -> EmployeeDayAttendance:
    """Get attendance for the logged-in user by employee_user_id."""
    db = get_db()
    org_id = ObjectId(organisation_id)
    punch_dt = datetime.combine(punch_date, datetime.min.time())

    punches = await db[PUNCHES_COLLECTION].find(
        {"organisation_id": org_id, "employee_user_id": employee_user_id, "punch_date": punch_dt},
    ).sort("event_time", 1).to_list(length=None)

    if not punches:
        return EmployeeDayAttendance(
            terminal_user_id="",
            user_name="",
            punch_date=punch_date,
        )

    summary = _compute_day_record(punches)
    return EmployeeDayAttendance(
        employee_user_id=employee_user_id,
        terminal_user_id=punches[0]["terminal_user_id"],
        user_name=punches[0]["user_name"],
        group_name=punches[0].get("group_name"),
        punch_date=punch_date,
        first_in=summary["first_in"],
        last_out=summary["last_out"],
        total_hours=summary["total_hours"],
        work_hours=summary["work_hours"],
        punches=_punches_to_entries(punches),
        status=summary["status"],
    )


async def get_my_month(
    organisation_id: str,
    employee_user_id: str,
    year: int,
    month: int,
) -> list[EmployeeDayAttendance]:
    """Get attendance for the logged-in user for an entire month by employee_user_id."""
    db = get_db()
    org_id = ObjectId(organisation_id)
    start = datetime.combine(date(year, month, 1), datetime.min.time())
    if month == 12:
        end = datetime.combine(date(year + 1, 1, 1), datetime.min.time())
    else:
        end = datetime.combine(date(year, month + 1, 1), datetime.min.time())

    punches = await db[PUNCHES_COLLECTION].find(
        {
            "organisation_id": org_id,
            "employee_user_id": employee_user_id,
            "punch_date": {"$gte": start, "$lt": end},
        },
    ).sort("event_time", 1).to_list(length=None)

    grouped: dict[date, list[dict]] = {}
    for p in punches:
        d = p["punch_date"].date() if isinstance(p["punch_date"], datetime) else p["punch_date"]
        grouped.setdefault(d, []).append(p)

    results = []
    for d, day_punches in sorted(grouped.items()):
        summary = _compute_day_record(day_punches)
        results.append(EmployeeDayAttendance(
            employee_user_id=employee_user_id,
            terminal_user_id=day_punches[0]["terminal_user_id"],
            user_name=day_punches[0]["user_name"],
            group_name=day_punches[0].get("group_name"),
            punch_date=d,
            first_in=summary["first_in"],
            last_out=summary["last_out"],
            total_hours=summary["total_hours"],
            work_hours=summary["work_hours"],
            punches=_punches_to_entries(day_punches),
            status=summary["status"],
        ))

    # Overlay approved leaves onto days with no punch, so the calendar reads
    # "Leave" (with the specific type) instead of inferring "Absent". A day that
    # has punches keeps its punch-derived state (e.g. a half-day leave worked).
    leave_days = await _get_approved_leave_days(employee_user_id, start, end)
    ident = punches[0] if punches else {}
    for d, leave_type_name in leave_days.items():
        if d in grouped:
            continue
        results.append(_leave_day_record(
            punch_date=d,
            leave_type_name=leave_type_name,
            terminal_user_id=ident.get("terminal_user_id", ""),
            user_name=ident.get("user_name", ""),
            group_name=ident.get("group_name"),
            employee_user_id=employee_user_id,
        ))

    results.sort(key=lambda r: r.punch_date)
    return results


async def ensure_indexes():
    """Create MongoDB indexes for attendance collections."""
    db = get_db()
    await db[PUNCHES_COLLECTION].create_index(
        [("organisation_id", 1), ("terminal_user_id", 1), ("punch_date", 1)],
    )
    await db[PUNCHES_COLLECTION].create_index(
        [("organisation_id", 1), ("punch_date", 1)],
    )
    await db[PUNCHES_COLLECTION].create_index(
        [("organisation_id", 1), ("employee_user_id", 1), ("punch_date", 1)],
    )
    # Ingest upserts on this key, so a retried or overlapping batch updates
    # rows in place instead of duplicating somebody's day.
    await db[PUNCHES_COLLECTION].create_index(
        "source_row_key",
        unique=True,
        partialFilterExpression={"source_row_key": {"$exists": True, "$type": "string"}},
    )
    await db[INGEST_STATE_COLLECTION].create_index(
        [("organisation_id", 1), ("source_table", 1)],
        unique=True,
    )
    logger.info("Attendance indexes ensured")
