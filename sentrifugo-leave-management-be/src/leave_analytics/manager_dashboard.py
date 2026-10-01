"""
Manager leave analytics dashboard — read-only aggregation endpoint.

Computes team KPIs, pending approvals, team utilization with burnout risk,
and chart data for the manager's Descriptive tab.
"""

from datetime import date, datetime, timedelta, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.employment_status import filter_active_user_ids
from src.leave_analytics.filters import get_analytics_leave_type_ids
from src.manager.service import (
    _filter_to_approval_chain,
    _get_managed_user_ids,
    _managed_levels_map,
    _manager_refs,
    _restrict_roster_to_approval_chain,
)

REQUESTS_COL = "leave_requests"
ACTIVITY_COL = "leave_request_activity"
BALANCE_COL = "employee_leave_balances"


def _fy_start(now: datetime) -> datetime:
    year = now.year if now.month >= 4 else now.year - 1
    return datetime(year, 4, 1, tzinfo=timezone.utc)


def _resolve_window(
    now: datetime, from_date: date | None, to_date: date | None
) -> tuple[datetime, datetime]:
    """Resolve the reporting window, defaulting to the current financial year.

    ``to_date`` is inclusive, so it is widened to the end of that day. Callers
    that pass neither bound keep the pre-existing FY-to-date behaviour. A
    reversed range is swapped rather than rejected — the dashboard is read-only
    and two date pickers make it easy to set them the wrong way round.
    """
    # Swap before widening — swapping afterwards would shift both bounds by the
    # inclusive-day padding and silently return a different window.
    if from_date and to_date and to_date < from_date:
        from_date, to_date = to_date, from_date
    start = (
        datetime(from_date.year, from_date.month, from_date.day, tzinfo=timezone.utc)
        if from_date
        else _fy_start(now)
    )
    end = (
        datetime(to_date.year, to_date.month, to_date.day, tzinfo=timezone.utc)
        + timedelta(days=1)
        if to_date
        else now
    )
    if end < start:
        start, end = end, start
    return start, end


def _window_meta(range_start: datetime, range_end: datetime) -> dict:
    """Echo the resolved window so the UI can label which period it is showing."""
    return {
        "from_date": range_start.strftime("%Y-%m-%d"),
        # range_end is exclusive internally; step back the smallest amount to
        # name the inclusive last day. Subtracting a whole day would report
        # yesterday whenever the end lands exactly on midnight.
        "to_date": (range_end - timedelta(microseconds=1)).strftime("%Y-%m-%d"),
    }


_MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _month_buckets(range_start: datetime, range_end: datetime) -> list[tuple[str, tuple[int, int]]]:
    """One (label, (year, month)) bucket per calendar month in the window.

    Grouping the trend on ``$month`` alone folded every year onto a single
    Jan–Dec axis, so an Apr–Mar financial year plotted its Jan–Mar tail to the
    LEFT of its own April, and a range spanning a year boundary summed two
    different years into one bar. Labels carry the year only when the window
    straddles more than one, to keep the common single-year axis uncluttered.
    """
    last = (range_end - timedelta(microseconds=1)) if range_end > range_start else range_start
    multi_year = range_start.year != last.year
    buckets: list[tuple[str, tuple[int, int]]] = []
    y, m = range_start.year, range_start.month
    while (y, m) <= (last.year, last.month):
        label = f"{_MONTH_NAMES[m]} {str(y)[2:]}" if multi_year else _MONTH_NAMES[m]
        buckets.append((label, (y, m)))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return buckets


async def _get_employee_names(
    db: AsyncIOMotorDatabase, user_ids: list[ObjectId],
) -> dict[str, str]:
    if not user_ids:
        return {}
    emp_docs = await db["employees"].find(
        {"user_id": {"$in": user_ids}, "is_deleted": {"$ne": True}},
        {"user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1, "name": 1,
         "work_email": 1},
    ).to_list(length=None)
    user_docs = await db["users"].find(
        {"_id": {"$in": user_ids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1, "email": 1},
    ).to_list(length=None)
    user_map = {str(u["_id"]): u for u in user_docs}

    def _first_last(doc: dict) -> str:
        first = (doc.get("first_name") or "").strip()
        last = (doc.get("last_name") or "").strip()
        return f"{first} {last}".strip()

    result: dict[str, str] = {}
    for emp in emp_docs:
        uid = str(emp["user_id"])
        user = user_map.get(uid) or {}
        # Resolve from whichever source actually carries the name (employee
        # mirror first, then users). The users replica only stores the account
        # lifecycle fields, so a name-less users doc must not shadow the
        # employee record — that was surfacing raw ObjectIds in the UI.
        result[uid] = (
            _first_last(emp) or _first_last(user)
            or emp.get("name") or emp.get("full_name")
            or user.get("full_name") or user.get("name")
            or emp.get("work_email") or user.get("email")
            or uid
        )

    for oid in user_ids:
        result.setdefault(str(oid), str(oid))
    return result


async def get_manager_dashboard(
    db: AsyncIOMotorDatabase,
    manager_user_id: str,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    org_id: str | None = None,
) -> dict:
    now = datetime.now(timezone.utc)
    # Only the request-derived metrics (used days, trend, type mix) honour this
    # window. Entitled / Balance / Utilization come from the balance tracker,
    # which stores running totals with no per-period breakdown, so they stay
    # lifetime figures — the response labels them as such.
    range_start, range_end = _resolve_window(now, from_date, to_date)

    # The utilization table covers the manager's whole reporting line — exited
    # staff still carry a balance the manager needs to see — but every KPI is
    # scoped to the CURRENT team, so ``managed_ids`` stays active-only.
    # Active/inactive is resolved from the local employment_statuses replica
    # rather than a live IAM call, so the split never silently degrades to
    # "everyone is active" when IAM is unreachable.
    all_managed_ids = await _get_managed_user_ids(db, manager_user_id)
    # Same rule as the manager leave-request surfaces: someone the caller only
    # reaches as L2 counts as team only when their leave plan actually routes to
    # a second approval level.
    levels_by_user = await _managed_levels_map(db, manager_user_id)
    all_managed_ids = await _restrict_roster_to_approval_chain(
        db, all_managed_ids, levels_by_user, org_id
    )
    active_oids = await filter_active_user_ids(db, all_managed_ids)
    active_uids = {str(o) for o in active_oids}
    managed_ids = [uid for uid in all_managed_ids if str(uid) in active_uids]
    headcount = len(managed_ids)

    if not all_managed_ids:
        return {
            "kpis": {
                "headcount": 0, "on_leave_today": 0,
                "pending_count": 0, "oldest_pending_age_hours": None,
                "avg_team_utilization_pct": 0, "avg_approval_time_hours": None,
                "org_avg_approval_time_hours": None,
            },
            "pending_approvals": [],
            "team_utilization": [],
            "monthly_chart": [
                {"month": label, "days": 0}
                for label, _ in _month_buckets(range_start, range_end)
            ],
            "type_distribution": [],
            "window": _window_meta(range_start, range_end),
        }

    emp_names = await _get_employee_names(db, all_managed_ids)

    # Only leave types opted in to analytics feed the utilization / trend metrics.
    analytics_lt_ids = await get_analytics_leave_type_ids(db)

    # ── 1. On Leave Today ─────────────────────────────────────────────────
    on_leave_today = await db[REQUESTS_COL].count_documents({
        "user_id": {"$in": managed_ids},
        "status": "APPROVED",
        "start_datetime": {"$lte": now},
        "end_datetime": {"$gte": now},
        "deleted_on": None,
    })

    # ── 2. Pending Approvals + Oldest ─────────────────────────────────────
    pending_docs = await db[REQUESTS_COL].find({
        "user_id": {"$in": managed_ids},
        "status": "PENDING",
        "deleted_on": None,
    }).sort("created_on", 1).to_list(length=None)
    # The roster is filtered by each employee's CURRENT plan; a historic request
    # may sit under a plan that never routed to L2, so filter per request too.
    pending_docs = await _filter_to_approval_chain(db, pending_docs, levels_by_user, [])

    pending_count = len(pending_docs)
    oldest_pending_age_hours = None
    if pending_docs:
        oldest_created = pending_docs[0].get("created_on")
        if oldest_created:
            if oldest_created.tzinfo is None:
                oldest_created = oldest_created.replace(tzinfo=timezone.utc)
            oldest_pending_age_hours = round((now - oldest_created).total_seconds() / 3600, 1)

    # Build pending approvals list for table
    lt_ids_pending = list({d["leave_type_id"] for d in pending_docs if d.get("leave_type_id")})
    lt_docs = await db["leave_types"].find({"_id": {"$in": lt_ids_pending}}).to_list(length=None)
    lt_name_map = {str(lt["_id"]): lt.get("name", "") for lt in lt_docs}

    pending_approvals = []
    for req in pending_docs:
        uid = str(req["user_id"])
        lt_id = str(req.get("leave_type_id", ""))
        created = req.get("created_on")
        waiting_hours = None
        if created:
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            waiting_hours = round((now - created).total_seconds() / 3600, 1)

        start_date = req.get("start_date")
        end_date = req.get("end_date")

        pending_approvals.append({
            "id": str(req["_id"]),
            "employee_name": emp_names.get(uid, uid),
            "leave_type_name": lt_name_map.get(lt_id, ""),
            "start_date": str(start_date) if start_date else None,
            "end_date": str(end_date) if end_date else None,
            "duration_days": req.get("duration_days", 0),
            "reason": req.get("reason", ""),
            "waiting_hours": waiting_hours,
        })

    # ── 3. Avg Team Utilization ───────────────────────────────────────────
    balance_docs = await db[BALANCE_COL].find({
        "employee_id": {"$in": all_managed_ids},
        "leave_type_id": {"$in": analytics_lt_ids},
    }).to_list(length=None)

    per_user_credited: dict[str, float] = {}
    per_user_debited: dict[str, float] = {}
    for bd in balance_docs:
        uid = str(bd.get("employee_id", ""))
        per_user_credited[uid] = per_user_credited.get(uid, 0) + (bd.get("total_credited", 0) or 0)
        per_user_debited[uid] = per_user_debited.get(uid, 0) + (bd.get("total_debited", 0) or 0)

    # KPI averages describe the current team only — exclude exited reportees.
    total_credited = sum(v for uid, v in per_user_credited.items() if uid in active_uids)
    total_debited = sum(v for uid, v in per_user_debited.items() if uid in active_uids)
    avg_team_utilization = round((total_debited / total_credited) * 100, 1) if total_credited > 0 else 0.0

    # ── 4. My Avg Approval Time (last 90 days) ───────────────────────────
    mgr_refs = await _manager_refs(db, manager_user_id)
    ninety_days_ago = now - timedelta(days=90)

    mgr_activities = await db[ACTIVITY_COL].find({
        "actor_id": {"$in": mgr_refs},
        "action": {"$in": ["APPROVED", "REJECTED"]},
        "timestamp": {"$gte": ninety_days_ago},
    }).to_list(length=None)

    approval_latencies: list[float] = []
    acted_request_ids = {act["leave_request_id"] for act in mgr_activities}

    if acted_request_ids:
        submit_activities = await db[ACTIVITY_COL].find({
            "leave_request_id": {"$in": list(acted_request_ids)},
            "action": "SUBMITTED",
        }).to_list(length=None)
        submit_map: dict[str, datetime] = {}
        for sa in submit_activities:
            rid = str(sa["leave_request_id"])
            ts = sa["timestamp"]
            if rid not in submit_map or ts < submit_map[rid]:
                submit_map[rid] = ts

        for act in mgr_activities:
            rid = str(act["leave_request_id"])
            if rid in submit_map:
                submitted = submit_map[rid]
                acted = act["timestamp"]
                if submitted.tzinfo is None:
                    submitted = submitted.replace(tzinfo=timezone.utc)
                if acted.tzinfo is None:
                    acted = acted.replace(tzinfo=timezone.utc)
                hours = (acted - submitted).total_seconds() / 3600
                if hours >= 0:
                    approval_latencies.append(hours)

    avg_approval_hours = round(sum(approval_latencies) / len(approval_latencies), 1) if approval_latencies else None

    # Org benchmark (all managers, last 90 days)
    all_mgr_activities = await db[ACTIVITY_COL].find({
        "action": {"$in": ["APPROVED", "REJECTED"]},
        "timestamp": {"$gte": ninety_days_ago},
    }).to_list(length=None)

    all_acted_rids = {act["leave_request_id"] for act in all_mgr_activities}
    org_latencies: list[float] = []
    if all_acted_rids:
        all_submit = await db[ACTIVITY_COL].find({
            "leave_request_id": {"$in": list(all_acted_rids)},
            "action": "SUBMITTED",
        }).to_list(length=None)
        all_submit_map: dict[str, datetime] = {}
        for sa in all_submit:
            rid = str(sa["leave_request_id"])
            ts = sa["timestamp"]
            if rid not in all_submit_map or ts < all_submit_map[rid]:
                all_submit_map[rid] = ts

        for act in all_mgr_activities:
            rid = str(act["leave_request_id"])
            if rid in all_submit_map:
                submitted = all_submit_map[rid]
                acted = act["timestamp"]
                if submitted.tzinfo is None:
                    submitted = submitted.replace(tzinfo=timezone.utc)
                if acted.tzinfo is None:
                    acted = acted.replace(tzinfo=timezone.utc)
                hours = (acted - submitted).total_seconds() / 3600
                if hours >= 0:
                    org_latencies.append(hours)

    org_avg_hours = round(sum(org_latencies) / len(org_latencies), 1) if org_latencies else None

    # ── 5. Team Utilization Table + Burnout Risk ──────────────────────────
    used_by_user_pipeline = [
        {"$match": {
            "user_id": {"$in": all_managed_ids},
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": range_start, "$lt": range_end},
            "deleted_on": None,
        }},
        {"$group": {"_id": "$user_id", "used_days": {"$sum": "$duration_days"}}},
    ]
    used_result = await db[REQUESTS_COL].aggregate(used_by_user_pipeline).to_list(length=None)
    used_map = {str(r["_id"]): round(r["used_days"], 2) for r in used_result}

    # Last leave date per employee
    last_leave_pipeline = [
        {"$match": {
            "user_id": {"$in": all_managed_ids},
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "deleted_on": None,
        }},
        {"$group": {"_id": "$user_id", "last_end": {"$max": "$end_datetime"}}},
    ]
    last_leave_result = await db[REQUESTS_COL].aggregate(last_leave_pipeline).to_list(length=None)
    last_leave_map: dict[str, datetime] = {}
    for r in last_leave_result:
        val = r.get("last_end")
        if not val:
            continue
        # end_datetime is normally a datetime, but some legacy documents stored
        # it as an ISO string — coerce so the downstream tz/arithmetic below
        # doesn't fail on a str. Unparseable values are treated as "no last leave".
        if isinstance(val, str):
            try:
                val = datetime.fromisoformat(val)
            except ValueError:
                continue
        last_leave_map[str(r["_id"])] = val

    # Sick leave incidents in last 60 days
    sixty_days_ago = now - timedelta(days=60)
    sick_type_docs = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True, "code": {"$regex": "^S", "$options": "i"}},
        {"_id": 1},
    ).to_list(length=None)
    sick_type_ids = [d["_id"] for d in sick_type_docs]

    sick_counts: dict[str, int] = {}
    if sick_type_ids:
        sick_pipeline = [
            {"$match": {
                "user_id": {"$in": all_managed_ids},
                "leave_type_id": {"$in": sick_type_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": sixty_days_ago},
                "deleted_on": None,
            }},
            {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
        ]
        sick_result = await db[REQUESTS_COL].aggregate(sick_pipeline).to_list(length=None)
        sick_counts = {str(r["_id"]): r["count"] for r in sick_result}

    team_utilization = []
    for uid_oid in all_managed_ids:
        uid = str(uid_oid)
        credited_hours = per_user_credited.get(uid, 0)
        debited_hours = per_user_debited.get(uid, 0)
        entitled_days = round(credited_hours / 8.0, 2) if credited_hours else 0
        used_days = used_map.get(uid, 0)
        # Balance comes from the balance tracker (credited − debited), the same
        # source as Entitled and Utilization — NOT from `entitled − used_days`.
        # Used YTD is summed off approved requests for the financial year, so
        # subtracting it from a lifetime credit figure mixes two independent
        # sources: an employee with an approved day but no credit row yet
        # reported Entitled 0d / Used 1d / Balance −1d, a deficit they never had.
        # A genuine overdraft still shows negative here, because plans that set
        # allow_negative_balance drive the tracker itself negative.
        balance_days = round((credited_hours - debited_hours) / 8.0, 2)
        util_pct = round((debited_hours / credited_hours) * 100, 1) if credited_hours > 0 else 0

        # Burnout risk score
        last_leave_dt = last_leave_map.get(uid)
        days_since_break = 0
        last_leave_str = None
        if last_leave_dt:
            if last_leave_dt.tzinfo is None:
                last_leave_dt = last_leave_dt.replace(tzinfo=timezone.utc)
            days_since_break = (now - last_leave_dt).days
            last_leave_str = last_leave_dt.strftime("%b %d")

        sick_incidents = sick_counts.get(uid, 0)
        util_rate = util_pct / 100.0
        burnout_score = round((1 - util_rate) * 5 + (days_since_break / 90) * 3 + (sick_incidents * 0.5), 1)

        if burnout_score >= 6:
            risk = "High"
        elif burnout_score >= 3:
            risk = "Medium"
        else:
            risk = "Low"

        team_utilization.append({
            "user_id": uid,
            "employee_name": emp_names.get(uid, uid),
            "is_active": uid in active_uids,
            "entitled_days": entitled_days,
            "used_days": used_days,
            "balance_days": balance_days,
            "utilization_pct": util_pct,
            "burnout_risk": risk,
            "burnout_score": burnout_score,
            "last_leave": last_leave_str,
            "days_since_last_leave": days_since_break,
        })

    # Active team first (A–Z), exited reportees grouped at the bottom.
    team_utilization.sort(key=lambda x: (not x["is_active"], x["employee_name"].lower()))

    # ── 6. Monthly Trend Chart ────────────────────────────────────────────
    monthly_pipeline = [
        {"$match": {
            "user_id": {"$in": managed_ids},
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": range_start, "$lt": range_end},
            "deleted_on": None,
        }},
        # Bucket by year AND month. Grouping on $month alone folded every year
        # onto one Jan–Dec axis, so an Apr–Mar financial year plotted its
        # Jan–Mar tail to the LEFT of its own April, and any range spanning a
        # year boundary silently summed two different years into one bar.
        {"$group": {
            "_id": {"y": {"$year": "$start_datetime"}, "m": {"$month": "$start_datetime"}},
            "days": {"$sum": "$duration_days"},
        }},
    ]
    monthly_result = await db[REQUESTS_COL].aggregate(monthly_pipeline).to_list(length=None)
    monthly_map = {(r["_id"]["y"], r["_id"]["m"]): round(r["days"], 2) for r in monthly_result}
    monthly_chart = [
        {"month": label, "days": monthly_map.get(key, 0)}
        for label, key in _month_buckets(range_start, range_end)
    ]

    # ── 7. Leave Type Distribution ────────────────────────────────────────
    type_pipeline = [
        {"$match": {
            "user_id": {"$in": managed_ids},
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": range_start, "$lt": range_end},
            "deleted_on": None,
        }},
        {"$group": {"_id": "$leave_type_id", "days": {"$sum": "$duration_days"}}},
        {"$sort": {"days": -1}},
    ]
    type_result = await db[REQUESTS_COL].aggregate(type_pipeline).to_list(length=None)

    all_lt_ids = [r["_id"] for r in type_result if r.get("_id")]
    all_lt_docs = await db["leave_types"].find({"_id": {"$in": all_lt_ids}}).to_list(length=None)
    all_lt_map = {str(lt["_id"]): lt.get("name", "") for lt in all_lt_docs}

    type_distribution = [
        {"leave_type_id": str(r["_id"]), "name": all_lt_map.get(str(r["_id"]), ""), "days": round(r["days"], 2)}
        for r in type_result if r.get("_id")
    ]

    return {
        "kpis": {
            "headcount": headcount,
            "on_leave_today": on_leave_today,
            "pending_count": pending_count,
            "oldest_pending_age_hours": oldest_pending_age_hours,
            "avg_team_utilization_pct": avg_team_utilization,
            "avg_approval_time_hours": avg_approval_hours,
            "org_avg_approval_time_hours": org_avg_hours,
        },
        "pending_approvals": pending_approvals,
        "team_utilization": team_utilization,
        "monthly_chart": monthly_chart,
        "window": _window_meta(range_start, range_end),
        "type_distribution": type_distribution,
    }
