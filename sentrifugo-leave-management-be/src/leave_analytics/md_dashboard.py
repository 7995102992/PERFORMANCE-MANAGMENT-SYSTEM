"""
MD / CEO leave analytics dashboard — executive strategic view.

Computes the Leave Culture Score, Burnout Risk Index, Compliance Score,
BU-level health, org KPIs, and chart data for the MD's Descriptive tab.
Reuses raw data patterns from hr_dashboard but aggregates at the BU level
and produces executive-grade composite scores.
"""

from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.employment_status import exclude_inactive_filter
from src.leave_analytics.filters import get_analytics_leave_type_ids
from src.utils import to_oid
from src.leave_analytics.quarterly_scores import get_culture_score_trend

REQUESTS_COL = "leave_requests"
ACTIVITY_COL = "leave_request_activity"
BALANCE_COL = "employee_leave_balances"
LEDGER_COL = "leave_credit_ledger"


def _fy_start(now: datetime) -> datetime:
    year = now.year if now.month >= 4 else now.year - 1
    return datetime(year, 4, 1, tzinfo=timezone.utc)


def _fy_year(now: datetime) -> int:
    return now.year if now.month >= 4 else now.year - 1


async def get_md_dashboard(db: AsyncIOMotorDatabase, organisation_id: str | None = None) -> dict:
    now = datetime.now(timezone.utc)
    fy_start = _fy_start(now)
    fy_year = _fy_year(now)

    # ── All active employees with BU + department ────────────────────────
    _org_filter = {"organisation_id": to_oid(organisation_id)} if organisation_id else {}
    all_employees = await db["employees"].find(
        {"is_deleted": {"$ne": True}, **_org_filter, **(await exclude_inactive_filter(db))},
        {"_id": 1, "user_id": 1, "department_id": 1, "business_unit_id": 1,
         "l1_manager_id": 1},
    ).to_list(length=None)

    emp_by_uid: dict[str, dict] = {}
    for emp in all_employees:
        if emp.get("user_id"):
            emp_by_uid[str(emp["user_id"])] = emp

    all_user_oids = [emp["user_id"] for emp in all_employees if emp.get("user_id")]
    total_employees = len(all_user_oids)

    if total_employees == 0:
        return _empty_response()

    # ── BU names ─────────────────────────────────────────────────────────
    bu_ids = list({emp["business_unit_id"] for emp in all_employees if emp.get("business_unit_id")})
    bu_docs = await db["business_units"].find(
        {"_id": {"$in": bu_ids}},
        {"_id": 1, "business_unit_name": 1, "name": 1},
    ).to_list(length=None)
    bu_name_map = {
        str(d["_id"]): d.get("business_unit_name") or d.get("name") or str(d["_id"])
        for d in bu_docs
    }

    def _emp_bu(uid: str) -> str | None:
        emp = emp_by_uid.get(uid, {})
        bid = emp.get("business_unit_id")
        return str(bid) if bid else None

    # Only leave types opted in to analytics feed the metrics below.
    analytics_lt_ids = await get_analytics_leave_type_ids(db, organisation_id)

    # ── 1. Org Utilization ───────────────────────────────────────────────
    balance_docs = await db[BALANCE_COL].find(
        {"leave_type_id": {"$in": analytics_lt_ids}}
    ).to_list(length=None)

    total_credited = sum(d.get("total_credited", 0) or 0 for d in balance_docs)
    total_debited = sum(d.get("total_debited", 0) or 0 for d in balance_docs)
    org_utilization = round((total_debited / total_credited) * 100, 1) if total_credited > 0 else 0.0

    per_user_credited: dict[str, float] = {}
    per_user_debited: dict[str, float] = {}
    for bd in balance_docs:
        uid = str(bd.get("employee_id", ""))
        per_user_credited[uid] = per_user_credited.get(uid, 0) + (bd.get("total_credited", 0) or 0)
        per_user_debited[uid] = per_user_debited.get(uid, 0) + (bd.get("total_debited", 0) or 0)

    # ── 2. Sick leave data ───────────────────────────────────────────────
    sick_types = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True, "is_sick_leave": True}, {"_id": 1},
    ).to_list(length=None)
    sick_type_ids = [d["_id"] for d in sick_types]

    # Total sick days YTD
    total_sick_days = 0.0
    if sick_type_ids:
        sick_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": sick_type_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": fy_start},
                "deleted_on": None,
            }},
            {"$group": {"_id": None, "total": {"$sum": "$duration_days"}}},
        ]
        sick_result = await db[REQUESTS_COL].aggregate(sick_pipeline).to_list(length=None)
        if sick_result:
            total_sick_days = sick_result[0].get("total", 0)

    # Total all leave days YTD
    all_leave_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": fy_start},
            "deleted_on": None,
        }},
        {"$group": {"_id": None, "total": {"$sum": "$duration_days"}}},
    ]
    all_leave_result = await db[REQUESTS_COL].aggregate(all_leave_pipeline).to_list(length=None)
    total_all_leave_days = all_leave_result[0].get("total", 0) if all_leave_result else 0

    sick_leave_rate = round(total_sick_days / total_all_leave_days, 3) if total_all_leave_days > 0 else 0.0

    # Sick leave rate per month (for MoM growth + chart)
    sick_monthly: dict[str, float] = {}
    all_monthly: dict[str, float] = {}

    if sick_type_ids:
        sick_month_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": sick_type_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": fy_start},
                "deleted_on": None,
            }},
            {"$group": {
                "_id": {"$dateToString": {"format": "%Y-%m", "date": "$start_datetime"}},
                "days": {"$sum": "$duration_days"},
            }},
        ]
        for r in await db[REQUESTS_COL].aggregate(sick_month_pipeline).to_list(length=None):
            sick_monthly[r["_id"]] = r["days"]

    all_month_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": fy_start},
            "deleted_on": None,
        }},
        {"$group": {
            "_id": {"$dateToString": {"format": "%Y-%m", "date": "$start_datetime"}},
            "days": {"$sum": "$duration_days"},
        }},
    ]
    for r in await db[REQUESTS_COL].aggregate(all_month_pipeline).to_list(length=None):
        all_monthly[r["_id"]] = r["days"]

    # Build monthly sick rate chart data
    sorted_months = sorted(set(list(sick_monthly.keys()) + list(all_monthly.keys())))
    sick_rate_chart = []
    prev_rate = None
    sick_rate_mom_growth = 0.0
    for m in sorted_months:
        s = sick_monthly.get(m, 0)
        a = all_monthly.get(m, 0)
        rate = round((s / a) * 100, 1) if a > 0 else 0.0
        label = datetime.strptime(m, "%Y-%m").strftime("%b")
        sick_rate_chart.append({"month": label, "rate": rate})
        if prev_rate is not None and prev_rate > 0:
            sick_rate_mom_growth = round((rate - prev_rate) / prev_rate, 3)
        prev_rate = rate

    # ── 3. Bradford Factor (org-wide average) ────────────────────────────
    one_year_ago = now - timedelta(days=365)
    sick_leave_docs = []
    if sick_type_ids:
        sick_leave_docs = await db[REQUESTS_COL].find({
            "leave_type_id": {"$in": sick_type_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": one_year_ago},
            "deleted_on": None,
        }, {"user_id": 1, "duration_days": 1}).to_list(length=None)

    user_sick: dict[str, list[dict]] = {}
    for doc in sick_leave_docs:
        uid = str(doc["user_id"])
        user_sick.setdefault(uid, []).append(doc)

    bradford_scores: list[float] = []
    bradford_bands = {"normal": 0, "monitor": 0, "review": 0, "critical": 0}
    for uid in emp_by_uid:
        docs = user_sick.get(uid, [])
        if not docs:
            bradford_scores.append(0)
            bradford_bands["normal"] += 1
            continue
        total_days = sum(d.get("duration_days", 0) for d in docs)
        spells = len(docs)
        bf = (spells ** 2) * total_days
        bradford_scores.append(bf)
        if bf > 500:
            bradford_bands["critical"] += 1
        elif bf > 200:
            bradford_bands["review"] += 1
        elif bf > 50:
            bradford_bands["monitor"] += 1
        else:
            bradford_bands["normal"] += 1

    avg_bradford = round(sum(bradford_scores) / len(bradford_scores), 1) if bradford_scores else 0.0

    # ── 4. Burnout Risk (org-wide) ───────────────────────────────────────
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

    sixty_days_ago = now - timedelta(days=60)
    sick_counts: dict[str, int] = {}
    if sick_type_ids:
        sick_inc_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": sick_type_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": sixty_days_ago},
                "deleted_on": None,
            }},
            {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
        ]
        sick_inc_result = await db[REQUESTS_COL].aggregate(sick_inc_pipeline).to_list(length=None)
        sick_counts = {str(r["_id"]): r["count"] for r in sick_inc_result}

    high_bri_count = 0
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
            high_bri_count += 1

    high_bri_pct = round((high_bri_count / total_employees) * 100, 1) if total_employees > 0 else 0.0

    # Org Burnout Risk Index
    org_bri = round(
        high_bri_pct / 100 * 5
        + (1 - org_utilization / 100) * 3
        + max(min(sick_rate_mom_growth, 1), -1) * 2,
        1,
    )
    org_bri = max(0, min(10, org_bri))

    # ── 5. Statutory Compliance ──────────────────────────────────────────
    statutory_types = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True, "is_statutory_leave": True}, {"_id": 1},
    ).to_list(length=None)
    statutory_type_ids = [d["_id"] for d in statutory_types]

    compliant_count = total_employees
    non_compliant_count = 0

    if statutory_type_ids:
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

        for uid_oid in all_user_oids:
            emp_doc = emp_by_uid.get(str(uid_oid), {})
            emp_id = emp_doc.get("_id")
            if emp_id and str(emp_id) not in credited_set:
                non_compliant_count += 1

        compliant_count = total_employees - non_compliant_count

    compliance_pct = round((compliant_count / total_employees) * 100, 1) if total_employees > 0 else 100.0

    # ── 6. Leave Culture Score ───────────────────────────────────────────
    culture_score = round(
        (org_utilization / 100) * 3.5
        + (1 - min(avg_bradford / 1000, 1)) * 2.5
        + (compliance_pct / 100) * 2.0
        + (1 - sick_leave_rate) * 2.0,
        1,
    )
    culture_score = max(0, min(10, culture_score))

    # ── 7. Approval SLA (org-wide) ───────────────────────────────────────
    ninety_days_ago = now - timedelta(days=90)
    all_actions = await db[ACTIVITY_COL].find({
        "action": {"$in": ["APPROVED", "REJECTED"]},
        "timestamp": {"$gte": ninety_days_ago},
    }).to_list(length=None)

    acted_rids = {act["leave_request_id"] for act in all_actions}
    sla_met_count = 0
    sla_total = 0

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

        approval_latency_buckets = {"lt12": 0, "lt24": 0, "lt48": 0, "gt48": 0}
        for act in all_actions:
            rid = str(act["leave_request_id"])
            if rid in submit_map:
                submitted = submit_map[rid]
                acted_at = act["timestamp"]
                if submitted.tzinfo is None:
                    submitted = submitted.replace(tzinfo=timezone.utc)
                if acted_at.tzinfo is None:
                    acted_at = acted_at.replace(tzinfo=timezone.utc)
                hours = (acted_at - submitted).total_seconds() / 3600
                if hours >= 0:
                    sla_total += 1
                    if hours <= 48:
                        sla_met_count += 1
                    if hours < 12:
                        approval_latency_buckets["lt12"] += 1
                    elif hours < 24:
                        approval_latency_buckets["lt24"] += 1
                    elif hours <= 48:
                        approval_latency_buckets["lt48"] += 1
                    else:
                        approval_latency_buckets["gt48"] += 1
    else:
        approval_latency_buckets = {"lt12": 0, "lt24": 0, "lt48": 0, "gt48": 0}

    approval_sla_pct = round((sla_met_count / sla_total) * 100, 1) if sla_total > 0 else 100.0

    # ── 8. Flight risk (pre-exit pattern detection) ──────────────────────
    flight_risk_count = 0
    for uid in emp_by_uid:
        bri = per_user_burnout.get(uid, 0)
        credited = per_user_credited.get(uid, 0)
        debited = per_user_debited.get(uid, 0)
        util = (debited / credited) if credited > 0 else 0
        sick = sick_counts.get(uid, 0)
        if bri >= 6 and util < 0.3 and sick >= 2:
            flight_risk_count += 1

    # ── 9. BU-level health (merged by name to handle duplicate BU records)
    bu_name_users: dict[str, list[str]] = {}
    for uid in emp_by_uid:
        bid = _emp_bu(uid)
        if bid:
            bname = bu_name_map.get(bid, bid)
            bu_name_users.setdefault(bname, []).append(uid)

    bu_health = []
    for bname, uids in bu_name_users.items():
        b_credited = sum(per_user_credited.get(u, 0) for u in uids)
        b_debited = sum(per_user_debited.get(u, 0) for u in uids)
        util_pct = round((b_debited / b_credited) * 100, 1) if b_credited > 0 else 0.0
        high_risk = sum(1 for u in uids if per_user_burnout.get(u, 0) >= 6.0)

        if util_pct >= 60:
            detail = "Healthy"
        elif util_pct >= 40:
            detail = "Monitor"
        else:
            detail = "Critical"

        if high_risk > 0:
            detail += f" · {high_risk} high burnout"

        bu_health.append({
            "bu_id": bname,
            "bu_name": bname,
            "employee_count": len(uids),
            "utilization_pct": util_pct,
            "detail": detail,
        })

    bu_health.sort(key=lambda x: x["bu_name"])

    # ── 10. BU utilization chart data ────────────────────────────────────
    bu_utilization_chart = [
        {"name": b["bu_name"], "pct": b["utilization_pct"]}
        for b in bu_health
    ]

    # ── 11. Culture score trend (line chart) ────────────────────────────
    # Monthly leave consumption for the trend chart
    monthly_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": fy_start},
            "deleted_on": None,
        }},
        {"$group": {
            "_id": {"$dateToString": {"format": "%Y-%m", "date": "$start_datetime"}},
            "days": {"$sum": "$duration_days"},
        }},
        {"$sort": {"_id": 1}},
    ]
    monthly_result = await db[REQUESTS_COL].aggregate(monthly_pipeline).to_list(length=None)
    monthly_chart = []
    for r in monthly_result:
        label = datetime.strptime(r["_id"], "%Y-%m").strftime("%b")
        monthly_chart.append({"month": label, "days": round(r["days"], 1)})

    # ── 12. Approval latency distribution (pie chart) ────────────────────
    approval_dist = [
        {"name": "<12h (Top Tier)", "value": approval_latency_buckets["lt12"]},
        {"name": "12–24h (Good)", "value": approval_latency_buckets["lt24"]},
        {"name": "24–48h (Acceptable)", "value": approval_latency_buckets["lt48"]},
        {"name": ">48h (SLA Breach)", "value": approval_latency_buckets["gt48"]},
    ]

    # ── 13. Culture score quarterly trend ────────────────────────────────
    culture_trend = await get_culture_score_trend(db)

    return {
        "kpis": {
            "total_employees": total_employees,
            "org_utilization_pct": org_utilization,
            "culture_score": culture_score,
            "org_bri": org_bri,
            "high_bri_count": high_bri_count,
            "high_bri_pct": high_bri_pct,
            "compliance_pct": compliance_pct,
            "non_compliant_count": non_compliant_count,
            "approval_sla_pct": approval_sla_pct,
            "sick_leave_rate_pct": round(sick_leave_rate * 100, 1),
            "avg_bradford_factor": avg_bradford,
            "flight_risk_count": flight_risk_count,
        },
        "bu_health": bu_health,
        "bu_utilization_chart": bu_utilization_chart,
        "sick_rate_chart": sick_rate_chart,
        "approval_dist": approval_dist,
        "monthly_chart": monthly_chart,
        "culture_trend": culture_trend,
    }


def _empty_response() -> dict:
    return {
        "kpis": {
            "total_employees": 0,
            "org_utilization_pct": 0,
            "culture_score": 0,
            "org_bri": 0,
            "high_bri_count": 0,
            "high_bri_pct": 0,
            "compliance_pct": 100,
            "non_compliant_count": 0,
            "approval_sla_pct": 100,
            "sick_leave_rate_pct": 0,
            "avg_bradford_factor": 0,
            "flight_risk_count": 0,
        },
        "bu_health": [],
        "bu_utilization_chart": [],
        "sick_rate_chart": [],
        "approval_dist": [],
        "monthly_chart": [],
        "culture_trend": [],
    }
