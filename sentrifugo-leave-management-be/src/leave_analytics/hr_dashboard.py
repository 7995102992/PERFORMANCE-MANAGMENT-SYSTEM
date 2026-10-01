"""
HR leave analytics dashboard — org-wide read-only aggregation.

Computes org utilization, burnout counts, statutory compliance,
department heatmap, Bradford Factor, and manager leaderboard.
"""

from datetime import datetime, timedelta, timezone

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.employment_status import exclude_inactive_filter
from src.leave_analytics.filters import get_analytics_leave_type_ids
from src.utils import to_oid

REQUESTS_COL = "leave_requests"
ACTIVITY_COL = "leave_request_activity"
BALANCE_COL = "employee_leave_balances"
LEDGER_COL = "leave_credit_ledger"
TRACKER_COL = "leave_employee_balance_tracker"


def _fy_start(now: datetime) -> datetime:
    year = now.year if now.month >= 4 else now.year - 1
    return datetime(year, 4, 1, tzinfo=timezone.utc)


def _fy_year(now: datetime) -> int:
    return now.year if now.month >= 4 else now.year - 1


def _first_last(doc: dict) -> str:
    first = (doc.get("first_name") or "").strip()
    last = (doc.get("last_name") or "").strip()
    return f"{first} {last}".strip()


async def get_hr_dashboard(db: AsyncIOMotorDatabase, organisation_id: str | None = None) -> dict:
    now = datetime.now(timezone.utc)
    fy_start = _fy_start(now)
    fy_year = _fy_year(now)

    # ── All active employees ──────────────────────────────────────────────
    _org_filter = {"organisation_id": to_oid(organisation_id)} if organisation_id else {}
    all_employees = await db["employees"].find(
        {"is_deleted": {"$ne": True}, **_org_filter, **(await exclude_inactive_filter(db))},
        {"_id": 1, "user_id": 1, "department_id": 1, "l1_manager_id": 1, "l2_manager_id": 1,
         "first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
    ).to_list(length=None)

    emp_by_uid: dict[str, dict] = {}
    for emp in all_employees:
        if emp.get("user_id"):
            emp_by_uid[str(emp["user_id"])] = emp

    all_user_oids = [emp["user_id"] for emp in all_employees if emp.get("user_id")]
    total_employees = len(all_user_oids)

    if total_employees == 0:
        return _empty_response()

    # Fetch user names for fallback
    user_docs = await db["users"].find(
        {"_id": {"$in": all_user_oids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
    ).to_list(length=None)
    user_name_map = {str(u["_id"]): u for u in user_docs}

    def _emp_name(uid: str) -> str:
        # Employee mirror first — the users replica carries only account
        # lifecycle fields, so a name-less users doc must not shadow it.
        emp = emp_by_uid.get(uid, {})
        user = user_name_map.get(uid, {})
        return (
            _first_last(emp) or _first_last(user)
            or emp.get("full_name") or emp.get("name")
            or user.get("full_name") or user.get("name")
            or uid
        )

    # Department names
    dept_ids = list({emp["department_id"] for emp in all_employees if emp.get("department_id")})
    dept_docs = await db["departments"].find({"_id": {"$in": dept_ids}}).to_list(length=None)
    dept_name_map = {str(d["_id"]): d.get("name", str(d["_id"])) for d in dept_docs}

    def _emp_dept(uid: str) -> str | None:
        emp = emp_by_uid.get(uid, {})
        did = emp.get("department_id")
        return str(did) if did else None

    # Only leave types opted in to analytics feed the metrics below.
    analytics_lt_ids = await get_analytics_leave_type_ids(db, organisation_id)

    # ── 1. Org Utilization ────────────────────────────────────────────────
    balance_docs = await db[BALANCE_COL].find(
        {"leave_type_id": {"$in": analytics_lt_ids}}
    ).to_list(length=None)

    total_credited = sum(d.get("total_credited", 0) or 0 for d in balance_docs)
    total_debited = sum(d.get("total_debited", 0) or 0 for d in balance_docs)
    org_utilization = round((total_debited / total_credited) * 100, 1) if total_credited > 0 else 0.0

    # Per-user credited/debited for burnout + dept calculations
    per_user_credited: dict[str, float] = {}
    per_user_debited: dict[str, float] = {}
    for bd in balance_docs:
        uid = str(bd.get("employee_id", ""))
        per_user_credited[uid] = per_user_credited.get(uid, 0) + (bd.get("total_credited", 0) or 0)
        per_user_debited[uid] = per_user_debited.get(uid, 0) + (bd.get("total_debited", 0) or 0)

    # ── 2. Burnout Risk (org-wide) ────────────────────────────────────────
    # Last leave date per employee
    last_leave_pipeline = [
        {"$match": {
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
        # it as an ISO string — coerce so the tz/arithmetic below doesn't fail on
        # a str. Unparseable values are treated as "no last leave".
        if isinstance(val, str):
            try:
                val = datetime.fromisoformat(val)
            except ValueError:
                continue
        last_leave_map[str(r["_id"])] = val

    # Sick leave incidents (last 60 days)
    sixty_days_ago = now - timedelta(days=60)
    sick_types = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True, "is_sick_leave": True}, {"_id": 1},
    ).to_list(length=None)
    sick_type_ids = [d["_id"] for d in sick_types]

    sick_counts: dict[str, int] = {}
    if sick_type_ids:
        sick_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": sick_type_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": sixty_days_ago},
                "deleted_on": None,
            }},
            {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
        ]
        sick_result = await db[REQUESTS_COL].aggregate(sick_pipeline).to_list(length=None)
        sick_counts = {str(r["_id"]): r["count"] for r in sick_result}

    high_burnout_count = 0
    per_user_burnout: dict[str, float] = {}
    for uid in emp_by_uid:
        credited = per_user_credited.get(uid, 0)
        debited = per_user_debited.get(uid, 0)
        util_rate = (debited / credited) if credited > 0 else 0

        last_dt = last_leave_map.get(uid)
        days_since = 0
        if last_dt:
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            days_since = (now - last_dt).days

        sick_inc = sick_counts.get(uid, 0)
        score = round((1 - util_rate) * 5 + (days_since / 90) * 3 + (sick_inc * 0.5), 1)
        per_user_burnout[uid] = score
        if score >= 6.0:
            high_burnout_count += 1

    # ── 3. Statutory Compliance ───────────────────────────────────────────
    statutory_types = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True, "is_statutory_leave": True}, {"_id": 1},
    ).to_list(length=None)
    statutory_type_ids = [d["_id"] for d in statutory_types]

    compliant_count = total_employees
    non_compliant_count = 0

    if statutory_type_ids:
        # Find employees who have at least one GRANT_CREDIT for each statutory type this FY
        ledger_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": statutory_type_ids},
                "transaction_type": {"$in": ["GRANT_CREDIT", "ACCRUAL_CREDIT"]},
                "metadata.leave_year": fy_year,
            }},
            {"$group": {"_id": "$employee_id"}},
        ]
        credited_employees = await db[LEDGER_COL].aggregate(ledger_pipeline).to_list(length=None)
        credited_set = {str(r["_id"]) for r in credited_employees}

        non_compliant_count = 0
        for uid_oid in all_user_oids:
            emp_doc = emp_by_uid.get(str(uid_oid), {})
            emp_id = emp_doc.get("_id")
            if emp_id and str(emp_id) not in credited_set:
                non_compliant_count += 1

        compliant_count = total_employees - non_compliant_count

    compliance_pct = round((compliant_count / total_employees) * 100, 1) if total_employees > 0 else 100.0

    # ── 4. Avg Approval Latency (org-wide, last 90 days) ─────────────────
    ninety_days_ago = now - timedelta(days=90)

    all_actions = await db[ACTIVITY_COL].find({
        "action": {"$in": ["APPROVED", "REJECTED"]},
        "timestamp": {"$gte": ninety_days_ago},
    }).to_list(length=None)

    acted_rids = {act["leave_request_id"] for act in all_actions}
    org_latencies: list[float] = []

    if acted_rids:
        submit_acts = await db[ACTIVITY_COL].find({
            "leave_request_id": {"$in": list(acted_rids)},
            "action": "SUBMITTED",
        }).to_list(length=None)
        submit_map: dict[str, datetime] = {}
        for sa in submit_acts:
            rid = str(sa["leave_request_id"])
            ts = sa["timestamp"]
            if rid not in submit_map or ts < submit_map[rid]:
                submit_map[rid] = ts

        for act in all_actions:
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
                    org_latencies.append(hours)

    avg_approval_latency = round(sum(org_latencies) / len(org_latencies), 1) if org_latencies else None

    # ── 5. Department Health Heatmap (merged by name to handle duplicate dept records)
    dept_name_users: dict[str, list[str]] = {}
    for uid, emp in emp_by_uid.items():
        did = _emp_dept(uid)
        if did:
            dname = dept_name_map.get(did, did)
            dept_name_users.setdefault(dname, []).append(uid)

    dept_heatmap = []
    for dname, uids in dept_name_users.items():
        d_credited = sum(per_user_credited.get(u, 0) for u in uids)
        d_debited = sum(per_user_debited.get(u, 0) for u in uids)
        util_pct = round((d_debited / d_credited) * 100, 1) if d_credited > 0 else 0

        dept_heatmap.append({
            "department_id": dname,
            "department_name": dname,
            "employee_count": len(uids),
            "utilization_pct": util_pct,
        })

    dept_heatmap.sort(key=lambda x: x["department_name"])

    # ── 6. Bradford Factor Distribution ───────────────────────────────────
    one_year_ago = now - timedelta(days=365)
    sick_leave_docs = []
    if sick_type_ids:
        sick_leave_docs = await db[REQUESTS_COL].find({
            "leave_type_id": {"$in": sick_type_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": one_year_ago},
            "deleted_on": None,
        }, {"user_id": 1, "duration_days": 1, "start_date": 1, "end_date": 1}).to_list(length=None)

    # Group by user, count spells (each continuous block = 1 spell) + total days
    user_sick: dict[str, list[dict]] = {}
    for doc in sick_leave_docs:
        uid = str(doc["user_id"])
        user_sick.setdefault(uid, []).append(doc)

    bradford_bands = {"normal": 0, "monitor": 0, "review": 0, "critical": 0}
    for uid, docs in user_sick.items():
        total_days = sum(d.get("duration_days", 0) for d in docs)
        spells = len(docs)  # each separate request = 1 spell
        bf = (spells ** 2) * total_days
        if bf > 500:
            bradford_bands["critical"] += 1
        elif bf > 200:
            bradford_bands["review"] += 1
        elif bf > 50:
            bradford_bands["monitor"] += 1
        else:
            bradford_bands["normal"] += 1

    # Add employees with no sick leave as normal
    bradford_bands["normal"] += (total_employees - len(user_sick))

    # ── 7. Manager Approval Leaderboard ───────────────────────────────────
    # Find all managers (anyone who is an l1_manager_id for at least one employee)
    manager_ids_raw: set[str] = set()
    manager_team_count: dict[str, int] = {}
    for emp in all_employees:
        mgr = emp.get("l1_manager_id")
        if mgr:
            mgr_str = str(mgr)
            manager_ids_raw.add(mgr_str)
            manager_team_count[mgr_str] = manager_team_count.get(mgr_str, 0) + 1

    # Get manager names (they could be stored as employee _id or user_id)
    mgr_oids = [to_oid(m) for m in manager_ids_raw if m]
    mgr_emp_docs = await db["employees"].find(
        {"$or": [{"_id": {"$in": mgr_oids}}, {"user_id": {"$in": mgr_oids}}],
         "is_deleted": {"$ne": True}},
        {"_id": 1, "user_id": 1, "first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
    ).to_list(length=None)

    mgr_name_map: dict[str, str] = {}
    mgr_user_map: dict[str, str] = {}  # manager ref -> user_id for activity lookup
    for me in mgr_emp_docs:
        eid = str(me["_id"])
        uid = str(me.get("user_id", ""))
        user = user_name_map.get(uid, {})
        name = (
            _first_last(me) or _first_last(user)
            or me.get("full_name") or me.get("name")
            or user.get("full_name") or user.get("name")
            or uid
        )
        mgr_name_map[eid] = name
        if uid:
            mgr_name_map[uid] = name
            mgr_user_map[eid] = uid
            mgr_user_map[uid] = uid

    # Per-manager approval stats from activity collection
    per_mgr_approved: dict[str, int] = {}
    per_mgr_rejected: dict[str, int] = {}
    per_mgr_latencies: dict[str, list[float]] = {}

    submit_map_all: dict[str, datetime] = {}
    if acted_rids:
        for sa in submit_acts:
            rid = str(sa["leave_request_id"])
            ts = sa["timestamp"]
            if rid not in submit_map_all or ts < submit_map_all[rid]:
                submit_map_all[rid] = ts

    for act in all_actions:
        actor = str(act["actor_id"])
        rid = str(act["leave_request_id"])
        action = act["action"]

        if action == "APPROVED":
            per_mgr_approved[actor] = per_mgr_approved.get(actor, 0) + 1
        elif action == "REJECTED":
            per_mgr_rejected[actor] = per_mgr_rejected.get(actor, 0) + 1

        if rid in submit_map_all:
            submitted = submit_map_all[rid]
            acted_at = act["timestamp"]
            if submitted.tzinfo is None:
                submitted = submitted.replace(tzinfo=timezone.utc)
            if acted_at.tzinfo is None:
                acted_at = acted_at.replace(tzinfo=timezone.utc)
            hours = (acted_at - submitted).total_seconds() / 3600
            if hours >= 0:
                per_mgr_latencies.setdefault(actor, []).append(hours)

    # Overdue count per manager (pending > 48h where they are L1)
    pending_docs = await db[REQUESTS_COL].find({
        "status": "PENDING", "deleted_on": None,
    }).to_list(length=None)

    per_mgr_overdue: dict[str, int] = {}
    for req in pending_docs:
        created = req.get("created_on")
        if not created:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if (now - created).total_seconds() < 48 * 3600:
            continue
        uid = str(req["user_id"])
        emp = emp_by_uid.get(uid, {})
        mgr = emp.get("l1_manager_id")
        if mgr:
            mgr_str = str(mgr)
            per_mgr_overdue[mgr_str] = per_mgr_overdue.get(mgr_str, 0) + 1

    manager_leaderboard = []
    for mgr_ref in manager_ids_raw:
        # Resolve the user_id for activity lookup
        actor_id = mgr_user_map.get(mgr_ref, mgr_ref)

        approved = per_mgr_approved.get(actor_id, 0) + per_mgr_approved.get(mgr_ref, 0)
        rejected = per_mgr_rejected.get(actor_id, 0) + per_mgr_rejected.get(mgr_ref, 0)
        total_actions = approved + rejected
        rejection_rate = round((rejected / total_actions) * 100, 1) if total_actions > 0 else 0

        latencies = per_mgr_latencies.get(actor_id, []) or per_mgr_latencies.get(mgr_ref, [])
        avg_latency = round(sum(latencies) / len(latencies), 1) if latencies else None

        overdue = per_mgr_overdue.get(mgr_ref, 0)
        team_size = manager_team_count.get(mgr_ref, 0)

        if team_size == 0:
            continue

        # Performance band
        if avg_latency is not None and avg_latency <= 12 and rejection_rate <= 15 and overdue <= 1:
            perf = "Top Tier"
        elif avg_latency is not None and avg_latency <= 24 and rejection_rate <= 20 and overdue <= 3:
            perf = "Good"
        elif (avg_latency is not None and avg_latency > 24) or rejection_rate > 25 or overdue > 4:
            perf = "Action Needed"
        else:
            perf = "Review"

        manager_leaderboard.append({
            "manager_name": mgr_name_map.get(mgr_ref, mgr_ref),
            "team_size": team_size,
            "avg_latency_hours": avg_latency,
            "rejection_rate_pct": rejection_rate,
            "overdue_count": overdue,
            "performance": perf,
        })

    manager_leaderboard.sort(key=lambda x: x["avg_latency_hours"] or 999)

    # ── 8. Dept utilization bar chart data ────────────────────────────────
    dept_utilization_chart = [
        {"name": d["department_name"], "pct": d["utilization_pct"]}
        for d in dept_heatmap
    ]

    return {
        "kpis": {
            "total_employees": total_employees,
            "org_utilization_pct": org_utilization,
            "high_burnout_count": high_burnout_count,
            "compliance_pct": compliance_pct,
            "non_compliant_count": non_compliant_count,
            "avg_approval_latency_hours": avg_approval_latency,
        },
        "dept_heatmap": dept_heatmap,
        "dept_utilization_chart": dept_utilization_chart,
        "bradford_factor": {
            "normal": bradford_bands["normal"],
            "monitor": bradford_bands["monitor"],
            "review": bradford_bands["review"],
            "critical": bradford_bands["critical"],
        },
        "manager_leaderboard": manager_leaderboard,
    }


def _empty_response() -> dict:
    return {
        "kpis": {
            "total_employees": 0,
            "org_utilization_pct": 0,
            "high_burnout_count": 0,
            "compliance_pct": 100,
            "non_compliant_count": 0,
            "avg_approval_latency_hours": None,
        },
        "dept_heatmap": [],
        "dept_utilization_chart": [],
        "bradford_factor": {"normal": 0, "monitor": 0, "review": 0, "critical": 0},
        "manager_leaderboard": [],
    }
