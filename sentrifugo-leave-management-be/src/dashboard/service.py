"""Aggregation logic for the employee dashboard (leave-domain widgets).

This module only reads data owned by the leave-management service. Timesheet
and service-request widgets are composed on the client from their own services.
"""

import asyncio
from datetime import date, datetime, timezone
from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.clients.iam_master_data import fetch_employment_statuses
from src.employment_status import deactivated_user_ids, exclude_inactive_filter
from src.leave_requests.service import REQUESTS_COLLECTION, get_all_leave_balances
from src.logger import logger
from src.utils import to_oid, uid_match

LEDGER_COLLECTION = "leave_entitlement_ledger"
HOURS_PER_DAY = 8.0


async def get_employee_dashboard(
    db: AsyncIOMotorDatabase, user_id: str, org_id: str
) -> dict:
    """Fan out the leave-domain dashboard reads concurrently and assemble them."""
    today = date.today().isoformat()

    balances, upcoming, next_holiday, whos_out = await asyncio.gather(
        _leave_balances(db, user_id, org_id),
        _upcoming_leaves(db, user_id, today),
        _next_holiday(db, user_id, org_id, today),
        _whos_out_today(db, user_id, today),
    )

    # The first APPROVED upcoming leave is the headline "next leave".
    next_leave = next((lv for lv in upcoming if lv.get("status") == "APPROVED"), None)

    # Lapsing depends on the resolved balances, so it runs after the gather.
    lapsing = await _lapsing_leaves(db, user_id, balances)

    return {
        "leave_balances": balances,
        "next_leave": next_leave,
        "upcoming_leaves": upcoming,
        "next_holiday": next_holiday,
        "lapsing_leaves": lapsing,
        "whos_out_today": whos_out,
    }


async def get_org_on_leave_today(db: AsyncIOMotorDatabase, org_id: str) -> dict:
    """Org-wide 'who is out today' for the admin dashboard.

    ``leave_requests`` carries no org_id, so we resolve the org's employees from
    the (IAM-synced) ``employees`` collection and match approved leaves for today
    against that set.
    """
    today = date.today().isoformat()
    org_oid = to_oid(org_id)
    org_match = {
        "organisation_id": {"$in": [org_oid, str(org_id)]},
        "is_deleted": {"$ne": True},
    }
    employees = await db["employees"].find(
        org_match, {"user_id": 1, "name": 1, "department_id": 1, "employment_status": 1}
    ).to_list(length=None)

    # Exclude IAM-inactive employees (exited / terminated / absconded / retired)
    # so the "of N" denominator reflects current headcount, like the manager
    # surfaces. If IAM is unreachable the inactive set is empty (no filtering).
    try:
        iam_statuses = await fetch_employment_statuses(organisation_id=org_id)
        inactive_status_ids = {
            sid for sid, info in iam_statuses.items() if info.get("is_active") is False
        }
        if inactive_status_ids:
            employees = [
                e
                for e in employees
                if str(e.get("employment_status") or "") not in inactive_status_ids
            ]
    except Exception as exc:  # pragma: no cover - IAM optional
        logger.warning("Could not resolve employment statuses for org on-leave", error=str(exc))

    total_employees = len(employees)
    emp_by_uid = {e["user_id"]: e for e in employees if e.get("user_id")}
    if not emp_by_uid:
        return {"total_out": 0, "total_employees": total_employees, "items": [], "by_department": []}

    pipeline = [
        {
            "$match": {
                "user_id": {"$in": list(emp_by_uid.keys())},
                "status": "APPROVED",
                "deleted_on": None,
                "start_date": {"$lte": today},
                "end_date": {"$gte": today},
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
        {"$sort": {"end_date": 1}},
    ]
    docs = await db[REQUESTS_COLLECTION].aggregate(pipeline).to_list(length=None)

    # Best-effort department names (collection may be absent in some envs).
    dept_names: dict = {}
    try:
        dept_ids = [e["department_id"] for e in employees if e.get("department_id")]
        if dept_ids:
            dept_docs = await db["departments"].find(
                {"_id": {"$in": dept_ids}}, {"department_name": 1}
            ).to_list(length=None)
            dept_names = {d["_id"]: d.get("department_name") for d in dept_docs}
    except Exception as exc:  # pragma: no cover - departments are optional
        logger.warning("Could not resolve department names", error=str(exc))

    items: list[dict] = []
    seen: set = set()
    for doc in docs:
        uid = doc.get("user_id")
        if uid in seen:
            continue
        seen.add(uid)
        emp = emp_by_uid.get(uid, {})
        dept_id = emp.get("department_id")
        items.append(
            {
                "user_id": str(uid),
                "name": emp.get("name"),
                "department_id": str(dept_id) if dept_id else None,
                "department_name": dept_names.get(dept_id),
                "leave_type_name": doc.get("leave_type_name"),
                "duration_mode": doc.get("duration_mode"),
            }
        )

    by_dept: dict = {}
    for it in items:
        key = it["department_id"] or "—"
        if key not in by_dept:
            by_dept[key] = {
                "department_id": it["department_id"],
                "department_name": it["department_name"],
                "count": 0,
            }
        by_dept[key]["count"] += 1

    return {
        "total_out": len(items),
        "total_employees": total_employees,
        "items": items,
        "by_department": sorted(by_dept.values(), key=lambda d: -d["count"]),
    }


async def _leave_balances(
    db: AsyncIOMotorDatabase, user_id: str, org_id: str | None = None
) -> list[dict]:
    """Current available balance per leave type, scoped to the employee's
    resolved leave plan.

    The entitled denominator is the allocation declared on the leave type
    (accrual.annual_count, or max_statutory_days for statutory types); the sum
    of this year's CREDIT ledger entries remains the fallback for types
    without a declared allocation."""
    raw = await get_all_leave_balances(db, user_id, org_id=org_id)
    balances = raw.get("balances", [])

    plan_type_ids = await _plan_leave_type_ids(db, user_id)
    if plan_type_ids is not None:
        balances = [b for b in balances if b["leave_type_id"] in plan_type_ids]

    entitled_by_type = await _entitled_days_this_year(db, user_id)
    allocated_by_type = await _allocated_days_by_type(
        db, [b["leave_type_id"] for b in balances]
    )

    cards: list[dict] = []
    for b in balances:
        ltid = b["leave_type_id"]
        cards.append(
            {
                "leave_type_id": ltid,
                "leave_type_name": b["leave_type_name"],
                "leave_type_code": b.get("leave_type_code"),
                "unit": b.get("unit", "DAYS"),
                "available_days": round(b.get("available_days", 0.0), 2),
                "available_hours": round(b.get("available_hours", 0.0), 2),
                "entitled_days": allocated_by_type.get(
                    ltid, entitled_by_type.get(ltid)
                ),
            }
        )
    return cards


async def _plan_leave_type_ids(
    db: AsyncIOMotorDatabase, user_id: str
) -> Optional[set[str]]:
    """Leave-type ids of the employee's resolved leave plan (DEPARTMENT > BU >
    ORG, same resolver the charging engine uses). None when no employee doc or
    plan could be resolved — the caller then falls back to all org types."""
    from src.leave_plan_assignments.service import resolve_employee_plan

    emp = await db["employees"].find_one(
        {"user_id": to_oid(user_id)},
        {"organisation_id": 1, "department_id": 1, "business_unit_id": 1},
    )
    if not emp or not emp.get("organisation_id"):
        return None
    try:
        emp_plan = await resolve_employee_plan(
            db,
            user_id,
            str(emp["organisation_id"]),
            str(emp["department_id"]) if emp.get("department_id") else None,
            str(emp["business_unit_id"]) if emp.get("business_unit_id") else None,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Could not resolve employee leave plan", error=str(exc))
        return None
    if not emp_plan:
        return None
    plan = await db["leave_plans"].find_one(
        {"_id": to_oid(emp_plan["leave_plan_id"])}, {"leave_type_ids": 1}
    )
    if not plan or not plan.get("leave_type_ids"):
        return None
    return {str(i) for i in plan["leave_type_ids"]}


async def _allocated_days_by_type(
    db: AsyncIOMotorDatabase, leave_type_ids: list[str]
) -> dict[str, float]:
    """Declared annual allocation per leave type — accrual.annual_count, or
    max_statutory_days for statutory types. Types with no declared allocation
    are simply absent from the result."""
    if not leave_type_ids:
        return {}
    docs = await db["leave_types"].find(
        {"_id": {"$in": [to_oid(i) for i in leave_type_ids]}},
        {"accrual": 1, "is_statutory_leave": 1, "max_statutory_days": 1},
    ).to_list(length=None)
    out: dict[str, float] = {}
    for d in docs:
        acc = d.get("accrual") or {}
        alloc = acc.get("annual_count")
        if alloc is None and d.get("is_statutory_leave"):
            alloc = d.get("max_statutory_days")
        if alloc is not None:
            out[str(d["_id"])] = float(alloc)
    return out


async def _entitled_days_this_year(
    db: AsyncIOMotorDatabase, user_id: str
) -> dict[str, float]:
    """Sum of CREDIT amounts (hours) per leave type for the current year.

    The ledger keys credits under either ``user_id`` or ``employee_id`` and
    ``leave_type_id`` is stored as a string. Returns {leave_type_id: days}.
    """
    year_start = datetime(date.today().year, 1, 1, tzinfo=timezone.utc)
    match: dict[str, Any] = {
        "$or": [{"user_id": uid_match(user_id)}, {"employee_id": uid_match(user_id)}],
        "transaction_type": "CREDIT",
        "created_on": {"$gte": year_start},
    }
    pipeline = [
        {"$match": match},
        {"$group": {"_id": "$leave_type_id", "hours": {"$sum": "$amount"}}},
    ]
    try:
        rows = await db[LEDGER_COLLECTION].aggregate(pipeline).to_list(length=None)
    except Exception as exc:  # pragma: no cover - defensive: ledger may be absent in dev
        logger.warning("Could not compute entitled balances", error=str(exc))
        return {}

    result: dict[str, float] = {}
    for r in rows:
        ltid = r.get("_id")
        if ltid is None:
            continue
        result[str(ltid)] = round((r.get("hours", 0.0) or 0.0) / HOURS_PER_DAY, 2)
    return result


async def _upcoming_leaves(
    db: AsyncIOMotorDatabase, user_id: str, today: str, limit: int = 5
) -> list[dict]:
    """The employee's upcoming leaves (ongoing or future), approved or pending,
    earliest first. The caller treats the first APPROVED entry as the headline
    "next leave"."""
    pipeline = [
        {
            "$match": {
                "user_id": to_oid(user_id),
                "status": {"$in": ["APPROVED", "PENDING"]},
                "deleted_on": None,
                "end_date": {"$gte": today},
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
        {"$sort": {"start_date": 1}},
        {"$limit": limit},
    ]
    docs = await db[REQUESTS_COLLECTION].aggregate(pipeline).to_list(length=limit)
    return [
        {
            "id": str(doc["_id"]),
            "leave_type_name": doc.get("leave_type_name"),
            "start_date": doc.get("start_date"),
            "end_date": doc.get("end_date"),
            "duration_days": round(doc.get("duration_days", 0.0) or 0.0, 2),
            "status": doc.get("status"),
        }
        for doc in docs
    ]


async def _next_holiday(
    db: AsyncIOMotorDatabase, user_id: str, org_id: str, today: str
) -> Optional[dict]:
    """The next public holiday on the employee's assigned holiday plan."""
    user_oid = to_oid(user_id)
    assignment = await db["holiday_plan_employees"].find_one(
        {"user_id": user_oid, "deleted_on": None}
    )
    if not assignment:
        return None

    plan_oid = to_oid(assignment["plan_id"])
    org_oid = to_oid(org_id)

    pipeline = [
        {
            "$match": {
                "plan_id": plan_oid,
                "org_id": {"$in": [org_oid, str(org_id)]},
                "deleted_on": None,
                "date": {"$gte": today},
            }
        },
        {
            "$lookup": {
                "from": "holiday_classifications",
                "localField": "classification_id",
                "foreignField": "_id",
                "as": "_cls",
            }
        },
        {
            "$addFields": {
                "classification_name": {"$arrayElemAt": ["$_cls.name", 0]},
                "classification_color": {"$arrayElemAt": ["$_cls.color", 0]},
            }
        },
        {"$sort": {"date": 1}},
        {"$limit": 1},
    ]
    docs = await db["holidays"].aggregate(pipeline).to_list(length=1)
    if not docs:
        return None
    doc = docs[0]
    holiday_date = doc.get("date")
    days_until = 0
    try:
        days_until = max((date.fromisoformat(holiday_date) - date.today()).days, 0)
    except (TypeError, ValueError):
        days_until = 0
    return {
        "id": str(doc["_id"]),
        "name": doc.get("name"),
        "date": holiday_date,
        "days_until": days_until,
        "classification_name": doc.get("classification_name"),
        "classification_color": doc.get("classification_color"),
    }


async def _whos_out_today(
    db: AsyncIOMotorDatabase, user_id: str, today: str
) -> dict:
    """Teammates (same L1 manager) who are on an approved leave today."""
    empty = {"team_size": 0, "out_count": 0, "items": []}
    user_oid = to_oid(user_id)

    me = await db["employees"].find_one(
        {"user_id": user_oid, "is_deleted": {"$ne": True}},
        {"l1_manager_id": 1},
    )
    if not me or not me.get("l1_manager_id"):
        return empty

    l1 = me["l1_manager_id"]
    # l1_manager_id may be stored as the manager's user_id or employee _id.
    peers_cursor = db["employees"].find(
        {"l1_manager_id": {"$in": [l1, str(l1)]}, "is_deleted": {"$ne": True},
         **(await exclude_inactive_filter(db))},
        {"user_id": 1, "name": 1},
    )
    peers = await peers_cursor.to_list(length=None)

    # Map user_id -> name, excluding the current user.
    peer_map: dict = {}
    for p in peers:
        puid = p.get("user_id")
        if puid is None or puid == user_oid:
            continue
        peer_map[puid] = p.get("name")

    # Drop teammates whose USER account is ended so team_size reflects the
    # current team, mirroring the manager team surfaces.
    if peer_map:
        dead = await deactivated_user_ids(db, list(peer_map.keys()))
        peer_map = {uid: n for uid, n in peer_map.items() if to_oid(uid) not in dead}

    team_size = len(peer_map)
    if team_size == 0:
        return {"team_size": 0, "out_count": 0, "items": []}

    peer_oids = list(peer_map.keys())
    pipeline = [
        {
            "$match": {
                "user_id": {"$in": peer_oids},
                "status": "APPROVED",
                "deleted_on": None,
                "start_date": {"$lte": today},
                "end_date": {"$gte": today},
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
        {"$sort": {"end_date": 1}},
    ]
    docs = await db[REQUESTS_COLLECTION].aggregate(pipeline).to_list(length=None)

    items: list[dict] = []
    seen: set = set()
    for doc in docs:
        uid = doc.get("user_id")
        if uid in seen:
            continue
        seen.add(uid)
        items.append(
            {
                "user_id": str(uid),
                "name": peer_map.get(uid),
                "leave_type_name": doc.get("leave_type_name"),
                "start_date": doc.get("start_date"),
                "end_date": doc.get("end_date"),
                "duration_mode": doc.get("duration_mode"),
                "half_day_period": doc.get("half_day_period"),
            }
        )

    return {"team_size": team_size, "out_count": len(items), "items": items}


async def _lapsing_leaves(
    db: AsyncIOMotorDatabase, user_id: str, balances: list[dict]
) -> list[dict]:
    """Best-effort: balances that expire at the end of the current leave cycle.

    Only populated when the employee's leave plan has an entitlement config with
    ``credit_expiry.expiry_at_cycle_end`` enabled. Returns an empty list when the
    plan/config cannot be confidently resolved, so the UI never shows guessed
    expiry data.
    """
    try:
        # Credits are keyed by the employee _id; resolve it from the user_id (the
        # old code queried the externally-populated employee_leave_plans by user_id
        # treated as employee_id, which was both the wrong key and usually empty).
        emp = await db["employees"].find_one({"user_id": to_oid(user_id)}, {"_id": 1})
        if not emp:
            return []

        now = datetime.now(timezone.utc)
        CREDIT_TYPES = ["GRANT_CREDIT", "ACCRUAL_CREDIT", "ADJUSTMENT"]
        result: list[dict] = []

        for b in balances:
            lt_id = b.get("leave_type_id")
            if not lt_id:
                continue
            lt_oid = to_oid(str(lt_id))

            # Still-alive credits with a real upcoming expiry, soonest first.
            upcoming = await db["leave_credit_ledger"].find(
                {
                    "employee_id": emp["_id"],
                    "leave_type_id": lt_oid,
                    "transaction_type": {"$in": CREDIT_TYPES},
                    "expires_at": {"$type": "date", "$gt": now},
                },
                {"expires_at": 1, "amount": 1},
            ).sort("expires_at", 1).to_list(length=None)
            if not upcoming:
                continue

            # Lapsing amount at the soonest expiry D = balance NOT backed by credits
            # that survive past D (mirrors what the expiry engine will actually lapse).
            soonest = upcoming[0]["expires_at"]
            alive_after = sum(r["amount"] for r in upcoming if r["expires_at"] > soonest)
            never = await db["leave_credit_ledger"].aggregate([
                {"$match": {
                    "employee_id": emp["_id"], "leave_type_id": lt_oid,
                    "transaction_type": {"$in": CREDIT_TYPES},
                    "$or": [{"expires_at": None}, {"expires_at": {"$exists": False}}],
                }},
                {"$group": {"_id": None, "a": {"$sum": "$amount"}}},
            ]).to_list(length=1)
            alive_after += float(never[0]["a"]) if never else 0.0
            admin = await db["leave_entitlement_ledger"].aggregate([
                {"$match": {
                    "user_id": to_oid(user_id), "leave_type_id": lt_oid,
                    "transaction_type": {"$in": ["CREDIT", "ADJUSTMENT"]},
                }},
                {"$group": {"_id": None, "a": {"$sum": "$amount"}}},
            ]).to_list(length=1)
            alive_after += float(admin[0]["a"]) if admin else 0.0

            available_hours = float(b.get("available_days", 0.0) or 0.0) * 8.0
            lapsing_hours = max(0.0, available_hours - alive_after)
            if lapsing_hours > 0.01:
                result.append({
                    "leave_type_id": lt_id,
                    "leave_type_name": b.get("leave_type_name", ""),
                    "unit": b.get("unit", "DAYS"),
                    "units": round(lapsing_hours / 8.0, 2),
                    "expires_on": soonest,
                })
        return result
    except Exception as exc:  # pragma: no cover - lapsing is best-effort
        logger.warning("Could not compute lapsing leaves", error=str(exc))
        return []


async def _current_cycle_end(
    db: AsyncIOMotorDatabase, plan_oid
) -> Optional[str]:
    """Last day of the current leave cycle, derived from the plan's year-end
    ``calendar_start_month`` config. Falls back to 31 Dec of the current year."""
    from datetime import timedelta

    calendar_start_month = 1
    config = await db["leave_plan_year_end_processing"].find_one(
        {"leave_plan_id": plan_oid, "deleted_on": None}
    )
    if config and config.get("calendar_start_month"):
        calendar_start_month = int(config["calendar_start_month"])

    today = date.today()
    # Next occurrence of (calendar_start_month, day 1) strictly after today.
    next_start_year = today.year if today.month < calendar_start_month else today.year + 1
    if calendar_start_month == 1:
        next_start_year = today.year + 1
    next_cycle_start = date(next_start_year, calendar_start_month, 1)
    cycle_end = next_cycle_start - timedelta(days=1)
    return cycle_end.isoformat()


# Local alias to keep type hints readable without importing bson at module top.
ObjectIdLike = Any
