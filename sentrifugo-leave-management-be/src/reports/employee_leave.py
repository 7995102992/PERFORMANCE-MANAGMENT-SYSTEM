"""Employee leave report — the HR-facing "who took what leave, and who approved it"
view over a date range.

Distinct from the other two reports in this package: those are balance snapshots
scoped to ONE leave plan, this one is a request-level extract scoped to the
organisation and sliced by BU / department / employee. Everything here reads
`leave_requests` plus `leave_request_activity` (the approval trail), joined to the
employee mirror for identity and the org hierarchy.

Employees whose employment has since ended are deliberately NOT excluded — their
leave history is part of the period being reported on.
"""

import re
from collections import defaultdict
from datetime import date, datetime, time, timezone
from typing import Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.exceptions import DomainException
from src.utils import to_oid

REQUESTS_COLLECTION = "leave_requests"
ACTIVITY_COLLECTION = "leave_request_activity"
EMPLOYEE_COLLECTION = "employees"

# Terminal approval actions — the ones that close a request.
_DECISION_ACTIONS = ("APPROVED", "REJECTED")

STATUSES = ("PENDING", "APPROVED", "REJECTED", "CANCELLED")

# Guard rail on the export path: an org-wide pull with no filters could otherwise
# stream an unbounded result set into openpyxl.
MAX_EXPORT_ROWS = 20000


def _both(value) -> dict:
    """Match an id stored as either an ObjectId or its string form — the employee
    mirror has been written by several producers over time and carries both."""
    return {"$in": [value, str(value)]}


def _oid_list(values: Optional[list[str]]) -> list[ObjectId]:
    """Parse a list of id strings, dropping anything malformed.

    A caller-supplied list that parses to nothing yields ``[]``, which Mongo
    matches against no documents — the right answer for "filter by these ids"
    when none of them are real ids. Dropping the clause instead would silently
    widen the report to the whole organisation.
    """
    out: list[ObjectId] = []
    for value in values or []:
        if not value:
            continue
        try:
            out.append(ObjectId(str(value)))
        except (InvalidId, TypeError):
            continue
    return out


def _requested(values: Optional[list[str]]) -> bool:
    """True when the caller actually asked for this filter (vs. omitting it)."""
    return any(v for v in (values or []))


def _day_bounds(from_date: date, to_date: date) -> tuple[datetime, datetime]:
    """UTC datetime bounds for an inclusive [from_date, to_date] day range."""
    start = datetime.combine(from_date, time.min, tzinfo=timezone.utc)
    end = datetime.combine(to_date, time.max, tzinfo=timezone.utc)
    return start, end


def _validate_range(from_date: date, to_date: date) -> None:
    if to_date < from_date:
        raise DomainException(
            message="'to_date' must be on or after 'from_date'",
            code="INVALID_DATE_RANGE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )


def _name_of(emp: dict) -> str:
    name = emp.get("name")
    if name:
        return name
    combined = f"{emp.get('first_name') or ''} {emp.get('last_name') or ''}".strip()
    return combined or "—"


def _as_date_str(value) -> Optional[str]:
    """Normalise the several shapes start_date / end_date have been persisted in
    (date-only string, full datetime string, datetime) to 'YYYY-MM-DD'."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value)
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        try:
            return datetime.fromisoformat(text).date().isoformat()
        except ValueError:
            return text


def _iso(value) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


# Master-data mirrors have been written with either `name` or a prefixed
# `<entity>_name` depending on the producer, so read through both.
_NAME_FIELDS = ("name", "business_unit_name", "department_name", "designation_name")


def _display_name(doc: dict) -> str:
    for field in _NAME_FIELDS:
        value = doc.get(field)
        if value:
            return value
    return "—"


async def _name_map(db: AsyncIOMotorDatabase, collection: str, ids: list) -> dict[str, str]:
    ids = [i for i in ids if i is not None]
    if not ids:
        return {}
    docs = await db[collection].find(
        {"_id": {"$in": ids}}, {f: 1 for f in _NAME_FIELDS}
    ).to_list(length=None)
    return {str(d["_id"]): _display_name(d) for d in docs}


async def _resolve_employees(
    db: AsyncIOMotorDatabase,
    org_id: Optional[str],
    business_unit_ids: Optional[list[str]] = None,
    department_ids: Optional[list[str]] = None,
    search: Optional[str] = None,
    employee_ids: Optional[list[str]] = None,
) -> dict[str, dict]:
    """The employee population the report runs over, keyed by user_id (string).

    Org-scoped, narrowed by any combination of BU, department, an explicit
    employee selection, and a name / emp-code / email search. Each value carries
    the display fields every row and every statistic groups by, so callers never
    re-read the employee mirror.
    """
    match: dict = {"is_deleted": {"$ne": True}}
    if org_id:
        match["organisation_id"] = _both(to_oid(org_id))

    if _requested(business_unit_ids):
        oids = _oid_list(business_unit_ids)
        match["business_unit_id"] = {"$in": oids + [str(o) for o in oids]}

    if _requested(department_ids):
        oids = _oid_list(department_ids)
        match["department_id"] = {"$in": oids + [str(o) for o in oids]}

    # The picker hands back user_ids, but a caller holding an employee._id
    # should not have to care — match either, the way the actor lookup does.
    # Both this and `search` need $or, so they compose under $and rather than
    # one silently overwriting the other.
    and_clauses: list[dict] = []

    if _requested(employee_ids):
        oids = _oid_list(employee_ids)
        ids = oids + [str(o) for o in oids]
        and_clauses.append({"$or": [{"_id": {"$in": oids}}, {"user_id": {"$in": ids}}]})

    if search:
        rx = {"$regex": re.escape(search.strip()), "$options": "i"}
        and_clauses.append({"$or": [
            {"name": rx}, {"first_name": rx}, {"last_name": rx},
            {"emp_code": rx}, {"work_email": rx}, {"email": rx},
        ]})

    if and_clauses:
        match["$and"] = and_clauses

    docs = await db[EMPLOYEE_COLLECTION].find(
        match,
        {
            "_id": 1, "user_id": 1, "emp_code": 1, "name": 1, "first_name": 1,
            "last_name": 1, "work_email": 1, "email": 1, "department_id": 1,
            "business_unit_id": 1, "designation_id": 1,
            "l1_manager_id": 1, "l2_manager_id": 1,
        },
    ).to_list(length=None)

    def _collect(field: str) -> list:
        seen: dict[str, object] = {}
        for d in docs:
            v = d.get(field)
            if v is not None:
                seen[str(v)] = v if isinstance(v, ObjectId) else to_oid(v)
        return list(seen.values())

    dept_map = await _name_map(db, "departments", _collect("department_id"))
    bu_map = await _name_map(db, "business_units", _collect("business_unit_id"))
    desg_map = await _name_map(db, "designations", _collect("designation_id"))

    people: dict[str, dict] = {}
    for d in docs:
        uid = d.get("user_id")
        if not uid:
            continue
        people[str(uid)] = {
            "employee_id": str(d["_id"]),
            "user_id": str(uid),
            "emp_code": d.get("emp_code") or "",
            "employee_name": _name_of(d),
            "email": d.get("work_email") or d.get("email") or "",
            "department": dept_map.get(str(d.get("department_id")), "—"),
            "business_unit": bu_map.get(str(d.get("business_unit_id")), "—"),
            "designation": desg_map.get(str(d.get("designation_id")), "—"),
            "l1_manager_id": d.get("l1_manager_id"),
            "l2_manager_id": d.get("l2_manager_id"),
        }
    return people


async def _fetch_requests(
    db: AsyncIOMotorDatabase,
    user_oids: list,
    from_date: date,
    to_date: date,
    leave_type_ids: Optional[list[str]] = None,
    statuses: Optional[list[str]] = None,
) -> list[dict]:
    """Requests OVERLAPPING the window, not merely starting inside it — a leave
    spanning the period boundary is still leave taken in the period."""
    start, end = _day_bounds(from_date, to_date)
    match: dict = {
        "user_id": {"$in": user_oids},
        "deleted_on": None,
        "start_datetime": {"$lte": end},
        "end_datetime": {"$gte": start},
    }
    if _requested(leave_type_ids):
        match["leave_type_id"] = {"$in": _oid_list(leave_type_ids)}
    wanted = [s for s in (statuses or []) if s]
    if wanted:
        match["status"] = {"$in": [s.upper() for s in wanted]}

    return await db[REQUESTS_COLLECTION].find(match).sort(
        "start_datetime", -1
    ).to_list(length=None)


async def _resolve_actor_names(
    db: AsyncIOMotorDatabase, ids: set[str]
) -> dict[str, str]:
    """Names for people referenced by id, keyed under BOTH their employee._id and
    their user_id — callers hold one or the other depending on the source field."""
    if not ids:
        return {}
    oids = [to_oid(i) for i in ids if i]
    names: dict[str, str] = {}
    for e in await db[EMPLOYEE_COLLECTION].find(
        {"$or": [{"user_id": {"$in": oids}}, {"_id": {"$in": oids}}]},
        {"_id": 1, "user_id": 1, "name": 1, "first_name": 1, "last_name": 1},
    ).to_list(length=None):
        resolved = _name_of(e)
        names[str(e["_id"])] = resolved
        if e.get("user_id"):
            names[str(e["user_id"])] = resolved
    return names


async def _approval_trail(
    db: AsyncIOMotorDatabase, request_oids: list, people: dict[str, dict]
) -> dict[str, list[dict]]:
    """Approval activity per request, oldest first, with actor names resolved.

    Actors outside the filtered population (a manager in another BU, HR acting on
    someone's behalf) get a second lookup rather than being dropped — the approver
    column would otherwise be blank exactly where it matters most.
    """
    if not request_oids:
        return {}

    activities = await db[ACTIVITY_COLLECTION].find(
        {"leave_request_id": {"$in": request_oids}}
    ).sort("timestamp", 1).to_list(length=None)
    if not activities:
        return {}

    actor_names: dict[str, str] = {
        uid: info["employee_name"] for uid, info in people.items()
    }
    unknown = {
        str(a["actor_id"]) for a in activities
        if a.get("actor_id") and str(a["actor_id"]) not in actor_names
    }
    actor_names.update(await _resolve_actor_names(db, unknown))

    trail: dict[str, list[dict]] = defaultdict(list)
    for a in activities:
        actor_id = str(a["actor_id"]) if a.get("actor_id") else None
        trail[str(a["leave_request_id"])].append({
            "action": a.get("action"),
            "level": a.get("level"),
            "actor_id": actor_id,
            "actor_name": actor_names.get(actor_id, "—") if actor_id else "—",
            "comment": a.get("comment"),
            "acted_on": _iso(a.get("timestamp")),
        })
    return trail


async def _leave_type_names(db: AsyncIOMotorDatabase, requests: list[dict]) -> dict[str, str]:
    ids = {r["leave_type_id"] for r in requests if r.get("leave_type_id")}
    if not ids:
        return {}
    docs = await db["leave_types"].find(
        {"_id": {"$in": list(ids)}}, {"name": 1}
    ).to_list(length=None)
    return {str(d["_id"]): d.get("name") or "—" for d in docs}


async def _manager_names(db: AsyncIOMotorDatabase, people: dict[str, dict]) -> dict[str, str]:
    ids: set[str] = set()
    for info in people.values():
        for key in ("l1_manager_id", "l2_manager_id"):
            if info.get(key):
                ids.add(str(info[key]))
    return await _resolve_actor_names(db, ids)


def _pending_with(info: dict, level: Optional[int], names: dict[str, str]) -> str:
    """Who a still-pending request is sitting with, read off the employee's own
    chain at the level the approval has reached."""
    manager_id = info.get("l2_manager_id") if (level or 1) >= 2 else info.get("l1_manager_id")
    if not manager_id:
        manager_id = info.get("l1_manager_id")
    return names.get(str(manager_id), "—") if manager_id else "—"


def _build_row(
    req: dict,
    info: dict,
    lt_names: dict[str, str],
    trail: list[dict],
    manager_names: dict[str, str],
) -> dict:
    decisions = [t for t in trail if t["action"] in _DECISION_ACTIONS]
    submitted = next((t for t in trail if t["action"] == "SUBMITTED"), None)
    final = decisions[-1] if decisions else None

    turnaround = None
    if submitted and final and submitted["acted_on"] and final["acted_on"]:
        delta = (
            datetime.fromisoformat(final["acted_on"])
            - datetime.fromisoformat(submitted["acted_on"])
        )
        turnaround = round(delta.total_seconds() / 86400, 2)

    req_status = req.get("status", "")
    current_approver = (
        _pending_with(info, (req.get("approval_state") or {}).get("current_level"), manager_names)
        if req_status == "PENDING" else None
    )

    return {
        "request_id": str(req["_id"]),
        "employee_id": info["employee_id"],
        "user_id": info["user_id"],
        "emp_code": info["emp_code"],
        "employee_name": info["employee_name"],
        "email": info["email"],
        "business_unit": info["business_unit"],
        "department": info["department"],
        "designation": info["designation"],
        "leave_type_id": str(req["leave_type_id"]) if req.get("leave_type_id") else None,
        "leave_type": lt_names.get(str(req.get("leave_type_id")), "—"),
        "from_date": _as_date_str(req.get("start_date")) or _as_date_str(req.get("start_datetime")),
        "to_date": _as_date_str(req.get("end_date")) or _as_date_str(req.get("end_datetime")),
        "days": round(float(req.get("duration_days") or 0.0), 2),
        "hours": round(float(req.get("duration_hours") or 0.0), 2),
        "duration_mode": req.get("duration_mode"),
        "half_day_period": req.get("half_day_period"),
        "status": req_status,
        "loss_of_pay": bool(req.get("loss_of_pay")),
        "reason": req.get("reason") or "",
        "applied_on": _iso(req.get("created_on")) or (submitted or {}).get("acted_on"),
        # Approver details: the full trail for the row drill-down, plus the flat
        # "who closed it / who is it with" fields the table and the sheet show.
        "approval_trail": trail,
        "current_approver": current_approver,
        "l1_manager": manager_names.get(str(info.get("l1_manager_id")), "—") if info.get("l1_manager_id") else "—",
        "l2_manager": manager_names.get(str(info.get("l2_manager_id")), "—") if info.get("l2_manager_id") else "—",
        "action_by": (final or {}).get("actor_name"),
        "action_on": (final or {}).get("acted_on"),
        "action_comment": (final or {}).get("comment"),
        "approval_turnaround_days": turnaround,
    }


async def _collect_rows(
    db: AsyncIOMotorDatabase,
    org_id: Optional[str],
    from_date: date,
    to_date: date,
    business_unit_ids: Optional[list[str]],
    department_ids: Optional[list[str]],
    leave_type_ids: Optional[list[str]],
    statuses: Optional[list[str]],
    search: Optional[str],
    employee_ids: Optional[list[str]] = None,
) -> tuple[list[dict], int]:
    """Every row matching the filters, newest leave first, plus the size of the
    employee population they were drawn from (which the statistics report on)."""
    _validate_range(from_date, to_date)

    people = await _resolve_employees(
        db, org_id, business_unit_ids, department_ids, search, employee_ids
    )
    if not people:
        return [], 0

    user_oids = [to_oid(uid) for uid in people]
    requests = await _fetch_requests(db, user_oids, from_date, to_date, leave_type_ids, statuses)
    if not requests:
        return [], len(people)

    lt_names = await _leave_type_names(db, requests)
    trail = await _approval_trail(db, [r["_id"] for r in requests], people)
    manager_names = await _manager_names(db, people)

    rows = []
    for req in requests:
        info = people.get(str(req["user_id"]))
        if not info:
            continue
        rows.append(_build_row(req, info, lt_names, trail.get(str(req["_id"]), []), manager_names))

    rows.sort(key=lambda r: (r["from_date"] or "", r["employee_name"]), reverse=True)
    return rows, len(people)


async def get_employee_leave_report(
    db: AsyncIOMotorDatabase,
    from_date: date,
    to_date: date,
    org_id: Optional[str] = None,
    business_unit_ids: Optional[list[str]] = None,
    department_ids: Optional[list[str]] = None,
    leave_type_ids: Optional[list[str]] = None,
    statuses: Optional[list[str]] = None,
    search: Optional[str] = None,
    employee_ids: Optional[list[str]] = None,
    page: int = 1,
    page_size: int = 25,
) -> dict:
    """Paged leave-request extract with approver details for the given window."""
    rows, _ = await _collect_rows(
        db, org_id, from_date, to_date,
        business_unit_ids, department_ids, leave_type_ids, statuses, search,
        employee_ids,
    )
    total = len(rows)
    if page_size and page_size > 0:
        start = (page - 1) * page_size
        page_rows = rows[start:start + page_size]
    else:
        page_rows = rows

    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "items": page_rows,
        "total_count": total,
        "page": page,
        "page_size": page_size,
    }


def _summarise(rows: list[dict], key: str) -> list[dict]:
    buckets: dict[str, dict] = defaultdict(lambda: {"requests": 0, "days": 0.0})
    for r in rows:
        bucket = buckets[r.get(key) or "—"]
        bucket["requests"] += 1
        bucket["days"] += r["days"]
    return sorted(
        (
            {"name": name, "requests": v["requests"], "days": round(v["days"], 2)}
            for name, v in buckets.items()
        ),
        key=lambda b: (-b["days"], b["name"]),
    )


def _build_statistics(
    rows: list[dict], population: int, from_date: date, to_date: date
) -> dict:
    by_status = {s: {"requests": 0, "days": 0.0} for s in STATUSES}
    lop_days = 0.0
    turnarounds: list[float] = []
    on_leave: set[str] = set()
    total_days = 0.0

    for r in rows:
        bucket = by_status.setdefault(r["status"], {"requests": 0, "days": 0.0})
        bucket["requests"] += 1
        bucket["days"] += r["days"]
        total_days += r["days"]
        if r["loss_of_pay"]:
            lop_days += r["days"]
        if r["approval_turnaround_days"] is not None:
            turnarounds.append(r["approval_turnaround_days"])
        # "On leave" counts settled absence only — a pending or rejected request
        # is not time the employee actually took off.
        if r["status"] == "APPROVED":
            on_leave.add(r["user_id"])

    total_requests = len(rows)
    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "total_requests": total_requests,
        "total_days": round(total_days, 2),
        "approved_requests": by_status["APPROVED"]["requests"],
        "approved_days": round(by_status["APPROVED"]["days"], 2),
        "pending_requests": by_status["PENDING"]["requests"],
        "pending_days": round(by_status["PENDING"]["days"], 2),
        "rejected_requests": by_status["REJECTED"]["requests"],
        "rejected_days": round(by_status["REJECTED"]["days"], 2),
        "cancelled_requests": by_status["CANCELLED"]["requests"],
        "cancelled_days": round(by_status["CANCELLED"]["days"], 2),
        "loss_of_pay_days": round(lop_days, 2),
        "employees_on_leave": len(on_leave),
        "employees_in_scope": population,
        "avg_days_per_request": round(total_days / total_requests, 2) if total_requests else 0.0,
        "avg_approval_turnaround_days": (
            round(sum(turnarounds) / len(turnarounds), 2) if turnarounds else None
        ),
        "by_status": [
            {"status": s, "requests": v["requests"], "days": round(v["days"], 2)}
            for s, v in by_status.items()
        ],
        "by_leave_type": _summarise(rows, "leave_type"),
        "by_business_unit": _summarise(rows, "business_unit"),
        "by_department": _summarise(rows, "department"),
    }


async def get_employee_leave_statistics(
    db: AsyncIOMotorDatabase,
    from_date: date,
    to_date: date,
    org_id: Optional[str] = None,
    business_unit_ids: Optional[list[str]] = None,
    department_ids: Optional[list[str]] = None,
    leave_type_ids: Optional[list[str]] = None,
    statuses: Optional[list[str]] = None,
    search: Optional[str] = None,
    employee_ids: Optional[list[str]] = None,
) -> dict:
    """Headline numbers and breakdowns for exactly the rows the list would return."""
    rows, population = await _collect_rows(
        db, org_id, from_date, to_date,
        business_unit_ids, department_ids, leave_type_ids, statuses, search,
        employee_ids,
    )
    return _build_statistics(rows, population, from_date, to_date)


async def get_employee_leave_export_data(
    db: AsyncIOMotorDatabase,
    from_date: date,
    to_date: date,
    org_id: Optional[str] = None,
    business_unit_ids: Optional[list[str]] = None,
    department_ids: Optional[list[str]] = None,
    leave_type_ids: Optional[list[str]] = None,
    statuses: Optional[list[str]] = None,
    search: Optional[str] = None,
    employee_ids: Optional[list[str]] = None,
) -> dict:
    """The rows the workbook writes. Shares `_collect_rows` with the on-screen
    list, so the download and the table can never describe different populations.

    No statistics: the workbook is the request-level extract only — the summary
    lives on screen, and these rows are what it is computed from.
    """
    rows, _ = await _collect_rows(
        db, org_id, from_date, to_date,
        business_unit_ids, department_ids, leave_type_ids, statuses, search,
        employee_ids,
    )
    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "rows": rows[:MAX_EXPORT_ROWS],
        "truncated": len(rows) > MAX_EXPORT_ROWS,
        "max_rows": MAX_EXPORT_ROWS,
    }


async def get_leave_report_filters(
    db: AsyncIOMotorDatabase, org_id: Optional[str] = None
) -> dict:
    """Filter options sourced from the SAME database the report reads, so the ids
    the UI sends back always match the ids on the employee records."""
    org_clause: dict = {"is_deleted": {"$ne": True}}
    if org_id:
        org_clause["org_id"] = _both(to_oid(org_id))

    bu_projection = {f: 1 for f in _NAME_FIELDS}
    bus = await db["business_units"].find(org_clause, bu_projection).to_list(length=None)
    depts = await db["departments"].find(
        org_clause, {**bu_projection, "business_unit_ids": 1}
    ).to_list(length=None)

    # System-wide leave types carry org_id=None and belong to every tenant —
    # matching only the caller's org would hide them (mirrors leave_types._org_filter).
    lt_clause: dict = {"deleted_on": None}
    if org_id:
        lt_clause["org_id"] = {"$in": [to_oid(org_id), str(org_id), None]}
    leave_types = await db["leave_types"].find(lt_clause, {"name": 1}).to_list(length=None)

    def _named(docs: list[dict], extra=None) -> list[dict]:
        out = [
            {"id": str(d["_id"]), "name": _display_name(d), **(extra(d) if extra else {})}
            for d in docs
        ]
        return sorted(out, key=lambda o: o["name"].lower())

    return {
        "business_units": _named(bus),
        "departments": _named(
            depts,
            lambda d: {
                "business_unit_ids": [str(b) for b in (d.get("business_unit_ids") or [])]
            },
        ),
        "leave_types": _named(leave_types),
        "statuses": list(STATUSES),
    }
