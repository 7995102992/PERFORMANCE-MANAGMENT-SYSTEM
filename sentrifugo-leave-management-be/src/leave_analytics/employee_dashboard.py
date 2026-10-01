"""
Employee leave analytics dashboard — read-only aggregation endpoint.

Computes all KPIs, chart data, balance bars, and recent requests for the
Descriptive tab of the employee's leave analytics page in a single round-trip.
"""

from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.leave_analytics.filters import get_analytics_leave_type_ids
from src.utils import to_oid

# ── Collection names ──────────────────────────────────────────────────────────

REQUESTS_COL = "leave_requests"
ACTIVITY_COL = "leave_request_activity"
TRACKER_COL = "leave_employee_balance_tracker"
BALANCE_COL = "employee_leave_balances"
ASSIGNMENTS_COL = "leave_plan_assignments"
YEAR_END_COL = "year_end_processing"


def _fy_start(now: datetime) -> datetime:
    """Return the start of the current financial year (Apr 1)."""
    year = now.year if now.month >= 4 else now.year - 1
    return datetime(year, 4, 1, tzinfo=timezone.utc)


async def _get_user_plan_id(db: AsyncIOMotorDatabase, user_id: str) -> Optional[str]:
    """Find the employee's active leave plan via assignments."""
    doc = await db[ASSIGNMENTS_COL].find_one(
        {"employee_id": to_oid(user_id), "deleted_on": None},
        {"leave_plan_id": 1},
    )
    if not doc:
        doc = await db[ASSIGNMENTS_COL].find_one(
            {"employee_id": {"$in": [to_oid(user_id), user_id]}, "deleted_on": None},
            {"leave_plan_id": 1},
        )
    return str(doc["leave_plan_id"]) if doc else None


async def _get_carry_limit(db: AsyncIOMotorDatabase, plan_id: str) -> Optional[float]:
    """Fetch max_carry_limit from the year-end processing config for a plan."""
    doc = await db[YEAR_END_COL].find_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None},
    )
    if not doc:
        return None
    config = doc.get("payout_carry_config") or {}
    return config.get("max_carry_limit")


async def get_employee_dashboard(db: AsyncIOMotorDatabase, user_id: str) -> dict:
    now = datetime.now(timezone.utc)
    fy_start = _fy_start(now)
    user_oid = to_oid(user_id)

    # Only leave types opted in to analytics are counted anywhere below.
    analytics_lt_ids = await get_analytics_leave_type_ids(db)

    # ── 1. Total Balance (analytics leave types) ──────────────────────────
    tracker_docs = await db[TRACKER_COL].find(
        {"user_id": user_oid, "leave_type_id": {"$in": analytics_lt_ids}}
    ).to_list(length=None)

    total_balance_hours = sum(
        max(d.get("balance_hours", 0.0), 0.0) for d in tracker_docs
    )
    total_balance_days = round(total_balance_hours / 8.0, 2)

    tracker_by_lt = {
        str(d["leave_type_id"]): max(d.get("balance_hours", 0.0), 0.0)
        for d in tracker_docs
        if d.get("leave_type_id")
    }

    # ── 2. Days Used YTD (approved requests in current FY) ────────────────
    used_pipeline = [
        {
            "$match": {
                "user_id": user_oid,
                "leave_type_id": {"$in": analytics_lt_ids},
                "status": "APPROVED",
                "start_date": {"$gte": fy_start.strftime("%Y-%m-%d")},
                "deleted_on": None,
            }
        },
        {
            "$group": {
                "_id": None,
                "total_days": {"$sum": "$duration_days"},
                "total_hours": {"$sum": "$duration_hours"},
            }
        },
    ]
    used_result = await db[REQUESTS_COL].aggregate(used_pipeline).to_list(length=1)
    days_used_ytd = round(used_result[0]["total_days"], 2) if used_result else 0.0

    # ── 2b. Also try with datetime start_date field ───────────────────────
    if days_used_ytd == 0:
        used_pipeline_dt = [
            {
                "$match": {
                    "user_id": user_oid,
                    "leave_type_id": {"$in": analytics_lt_ids},
                    "status": "APPROVED",
                    "start_datetime": {"$gte": fy_start},
                    "deleted_on": None,
                }
            },
            {
                "$group": {
                    "_id": None,
                    "total_days": {"$sum": "$duration_days"},
                    "total_hours": {"$sum": "$duration_hours"},
                }
            },
        ]
        used_result_dt = await db[REQUESTS_COL].aggregate(used_pipeline_dt).to_list(length=1)
        if used_result_dt:
            days_used_ytd = round(used_result_dt[0]["total_days"], 2)

    # ── 3. Total entitled days (from employee_leave_balances) ─────────────
    balance_docs = await db[BALANCE_COL].find(
        {"employee_id": user_oid, "leave_type_id": {"$in": analytics_lt_ids}}
    ).to_list(length=None)

    total_entitled_hours = sum(d.get("total_credited", 0.0) for d in balance_docs)
    total_entitled_days = round(total_entitled_hours / 8.0, 2) if total_entitled_hours else 0.0

    utilization_pct = (
        round((days_used_ytd / total_entitled_days) * 100, 1)
        if total_entitled_days > 0
        else 0.0
    )

    # ── 4. Pending requests ───────────────────────────────────────────────
    pending_pipeline = [
        {
            "$match": {
                "user_id": user_oid,
                "status": "PENDING",
                "deleted_on": None,
            }
        },
        {
            "$group": {
                "_id": None,
                "count": {"$sum": 1},
                "total_days": {"$sum": "$duration_days"},
            }
        },
    ]
    pending_result = await db[REQUESTS_COL].aggregate(pending_pipeline).to_list(length=1)
    pending_count = pending_result[0]["count"] if pending_result else 0
    pending_days = round(pending_result[0]["total_days"], 2) if pending_result else 0.0

    # ── 5. Days expiring (balance − carry limit) ──────────────────────────
    plan_id = await _get_user_plan_id(db, user_id)
    carry_limit: Optional[float] = None
    days_expiring = 0.0

    if plan_id:
        carry_limit = await _get_carry_limit(db, plan_id)
        if carry_limit is not None:
            days_expiring = round(max(0, total_balance_days - carry_limit), 2)

    # ── 6. Balance bars (per leave type) ──────────────────────────────────
    leave_types = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True}
    ).to_list(length=None)
    lt_map = {str(lt["_id"]): lt for lt in leave_types}

    entitled_by_lt: dict[str, float] = {}
    for bd in balance_docs:
        lt_id = str(bd.get("leave_type_id", ""))
        entitled_by_lt[lt_id] = bd.get("total_credited", 0.0) / 8.0

    used_by_type_pipeline = [
        {
            "$match": {
                "user_id": user_oid,
                "leave_type_id": {"$in": analytics_lt_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": fy_start},
                "deleted_on": None,
            }
        },
        {
            "$group": {
                "_id": "$leave_type_id",
                "used_days": {"$sum": "$duration_days"},
            }
        },
    ]
    used_by_type_result = await db[REQUESTS_COL].aggregate(used_by_type_pipeline).to_list(length=None)
    used_by_lt = {str(r["_id"]): round(r["used_days"], 2) for r in used_by_type_result}

    balance_bars = []
    for lt_id, lt_doc in lt_map.items():
        entitled = round(entitled_by_lt.get(lt_id, 0.0), 2)
        used = used_by_lt.get(lt_id, 0.0)
        current_hours = tracker_by_lt.get(lt_id, 0.0)
        current_days = round(current_hours / 8.0, 2)

        if entitled == 0 and used == 0 and current_days == 0:
            continue

        pct = round((used / entitled) * 100, 1) if entitled > 0 else 0.0
        balance_bars.append({
            "leave_type_id": lt_id,
            "leave_type_name": lt_doc.get("name", ""),
            "leave_type_code": lt_doc.get("code", ""),
            "entitled_days": entitled,
            "used_days": used,
            "available_days": current_days,
            "usage_pct": pct,
        })

    balance_bars.sort(key=lambda b: b["leave_type_name"])

    # ── 7. Monthly consumption chart (grouped by month) ───────────────────
    monthly_pipeline = [
        {
            "$match": {
                "user_id": user_oid,
                "leave_type_id": {"$in": analytics_lt_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": fy_start},
                "deleted_on": None,
            }
        },
        {
            "$group": {
                "_id": {"$month": "$start_datetime"},
                "days": {"$sum": "$duration_days"},
            }
        },
        {"$sort": {"_id": 1}},
    ]
    monthly_result = await db[REQUESTS_COL].aggregate(monthly_pipeline).to_list(length=None)

    month_names = [
        "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    monthly_chart = []
    for m in range(1, 13):
        days = 0.0
        for r in monthly_result:
            if r["_id"] == m:
                days = round(r["days"], 2)
                break
        monthly_chart.append({"month": month_names[m], "days": days})

    # ── 8. Leave type distribution (doughnut chart) ───────────────────────
    type_distribution = []
    for lt_id, used in used_by_lt.items():
        if used > 0 and lt_id in lt_map:
            type_distribution.append({
                "leave_type_id": lt_id,
                "name": lt_map[lt_id].get("name", ""),
                "days": used,
            })
    type_distribution.sort(key=lambda x: x["days"], reverse=True)

    # ── 9. Recent leave requests (last 10) ────────────────────────────────
    recent_docs = await db[REQUESTS_COL].find(
        {"user_id": user_oid, "leave_type_id": {"$in": analytics_lt_ids}, "deleted_on": None}
    ).sort("created_on", -1).limit(10).to_list(length=None)

    recent_requests = []
    for req in recent_docs:
        req_id = req["_id"]
        lt_id = str(req.get("leave_type_id", ""))
        lt_name = lt_map.get(lt_id, {}).get("name", "")

        approval_latency = None
        if req.get("status") == "APPROVED":
            activities = await db[ACTIVITY_COL].find(
                {"leave_request_id": req_id}
            ).sort("timestamp", 1).to_list(length=None)

            submitted_at = None
            approved_at = None
            for act in activities:
                if act["action"] == "SUBMITTED" and submitted_at is None:
                    submitted_at = act["timestamp"]
                if act["action"] == "APPROVED" and approved_at is None:
                    approved_at = act["timestamp"]

            if submitted_at and approved_at:
                delta = approved_at - submitted_at
                total_hours = delta.total_seconds() / 3600
                approval_latency = round(total_hours, 1)

        start_date = req.get("start_date")
        end_date = req.get("end_date")
        if isinstance(start_date, datetime):
            start_date = start_date.strftime("%Y-%m-%d")
        if isinstance(end_date, datetime):
            end_date = end_date.strftime("%Y-%m-%d")

        recent_requests.append({
            "id": str(req_id),
            "leave_type_name": lt_name,
            "start_date": str(start_date) if start_date else None,
            "end_date": str(end_date) if end_date else None,
            "duration_days": req.get("duration_days", 0),
            "status": req.get("status", ""),
            "approval_latency_hours": approval_latency,
        })

    # ── Assemble response ─────────────────────────────────────────────────
    return {
        "kpis": {
            "total_balance_days": total_balance_days,
            "days_used_ytd": days_used_ytd,
            "total_entitled_days": total_entitled_days,
            "utilization_pct": utilization_pct,
            "pending_count": pending_count,
            "pending_days": pending_days,
            "days_expiring": days_expiring,
            "carry_forward_limit": carry_limit,
        },
        "balance_bars": balance_bars,
        "monthly_chart": monthly_chart,
        "type_distribution": type_distribution,
        "recent_requests": recent_requests,
    }
