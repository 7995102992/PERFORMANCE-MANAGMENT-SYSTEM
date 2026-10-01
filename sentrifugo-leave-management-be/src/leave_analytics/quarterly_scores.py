"""
Quarterly culture score snapshots.

Computes the Leave Culture Score for a given quarter from leave transaction
data and stores it in the `quarterly_scores` collection. The MD dashboard
reads the last 12 snapshots for the 3-year trend chart.

Quarter convention (Indian FY):
  Q1 = Apr–Jun, Q2 = Jul–Sep, Q3 = Oct–Dec, Q4 = Jan–Mar
  FY label = calendar year of April  (e.g. FY25 starts Apr 2025)

Collection schema:
  {
    quarter_label: "Q2 FY25",       # human-readable
    fy_year: 2025,
    quarter: 2,                     # 1–4
    quarter_start: datetime,
    quarter_end: datetime,
    culture_score: 6.5,
    components: {
      org_utilization_pct: 51.0,
      avg_bradford_factor: 12.3,
      compliance_pct: 98.2,
      sick_leave_rate_pct: 5.2,
    },
    total_employees: 272,
    computed_at: datetime,
  }
"""

from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.employment_status import exclude_inactive_filter
from src.leave_analytics.filters import get_analytics_leave_type_ids

QUARTERLY_COL = "quarterly_scores"
REQUESTS_COL = "leave_requests"
BALANCE_COL = "employee_leave_balances"
LEDGER_COL = "leave_credit_ledger"


def _quarter_boundaries(fy_year: int, quarter: int) -> tuple[datetime, datetime]:
    """Return (start, end) datetimes for the given FY quarter."""
    month_map = {1: (4, 6), 2: (7, 9), 3: (10, 12), 4: (1, 3)}
    start_month, end_month = month_map[quarter]

    if quarter <= 3:
        start_year = fy_year
    else:
        start_year = fy_year + 1

    start = datetime(start_year, start_month, 1, tzinfo=timezone.utc)
    if end_month == 12:
        end = datetime(start_year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(start_year, end_month + 1, 1, tzinfo=timezone.utc)

    return start, end


def _quarter_label(fy_year: int, quarter: int) -> str:
    fy_short = str(fy_year % 100).zfill(2)
    return f"Q{quarter} FY{fy_short}"


def _current_quarter(now: datetime) -> tuple[int, int]:
    """Return (fy_year, quarter) for the given datetime."""
    month = now.month
    if month >= 4:
        fy_year = now.year
        if month <= 6:
            return fy_year, 1
        elif month <= 9:
            return fy_year, 2
        else:
            return fy_year, 3
    else:
        fy_year = now.year - 1
        return fy_year, 4


async def compute_quarter_score(
    db: AsyncIOMotorDatabase, fy_year: int, quarter: int,
) -> dict:
    """Compute and store the culture score for a specific quarter."""
    q_start, q_end = _quarter_boundaries(fy_year, quarter)
    label = _quarter_label(fy_year, quarter)
    now = datetime.now(timezone.utc)

    # ── Active employees ─────────────────────────────────────────────────
    all_employees = await db["employees"].find(
        {"is_deleted": {"$ne": True}, **(await exclude_inactive_filter(db))},
        {"_id": 1, "user_id": 1},
    ).to_list(length=None)

    emp_ids = {str(e["_id"]) for e in all_employees if e.get("_id")}
    all_user_oids = [e["user_id"] for e in all_employees if e.get("user_id")]
    total_employees = len(all_user_oids)

    if total_employees == 0:
        score_doc = {
            "quarter_label": label,
            "fy_year": fy_year,
            "quarter": quarter,
            "quarter_start": q_start,
            "quarter_end": q_end,
            "culture_score": 0,
            "components": {
                "org_utilization_pct": 0,
                "avg_bradford_factor": 0,
                "compliance_pct": 100,
                "sick_leave_rate_pct": 0,
            },
            "total_employees": 0,
            "computed_at": now,
        }
        await db[QUARTERLY_COL].replace_one(
            {"fy_year": fy_year, "quarter": quarter},
            score_doc,
            upsert=True,
        )
        return score_doc

    # Only leave types opted in to analytics feed the metrics below.
    analytics_lt_ids = await get_analytics_leave_type_ids(db)

    # ── 1. Org Utilization (from balances — cumulative YTD up to quarter end)
    balance_docs = await db[BALANCE_COL].find(
        {"leave_type_id": {"$in": analytics_lt_ids}}
    ).to_list(length=None)
    total_credited = sum(d.get("total_credited", 0) or 0 for d in balance_docs)
    total_debited = sum(d.get("total_debited", 0) or 0 for d in balance_docs)

    # For historical quarters, approximate by using leave taken in/before this quarter
    if q_end <= now:
        leave_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": analytics_lt_ids},
                "status": "APPROVED",
                "start_datetime": {"$lt": q_end},
                "deleted_on": None,
            }},
            {"$group": {"_id": None, "total": {"$sum": "$duration_days"}}},
        ]
        result = await db[REQUESTS_COL].aggregate(leave_pipeline).to_list(length=None)
        debited_up_to = result[0]["total"] if result else 0
        org_utilization = round((debited_up_to / total_credited) * 100, 1) if total_credited > 0 else 0.0
    else:
        org_utilization = round((total_debited / total_credited) * 100, 1) if total_credited > 0 else 0.0

    # ── 2. Average Bradford Factor (12 months before quarter end)
    bf_start = q_end - timedelta(days=365)
    sick_types = await db["leave_types"].find(
        {"deleted_on": None, "show_in_analytics": True, "is_sick_leave": True}, {"_id": 1},
    ).to_list(length=None)
    sick_type_ids = [d["_id"] for d in sick_types]

    sick_leave_docs = []
    if sick_type_ids:
        sick_leave_docs = await db[REQUESTS_COL].find({
            "leave_type_id": {"$in": sick_type_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": bf_start, "$lt": q_end},
            "deleted_on": None,
        }, {"user_id": 1, "duration_days": 1}).to_list(length=None)

    user_sick: dict[str, list] = {}
    for doc in sick_leave_docs:
        uid = str(doc["user_id"])
        user_sick.setdefault(uid, []).append(doc)

    bradford_scores = []
    emp_by_uid = {str(e["user_id"]): e for e in all_employees if e.get("user_id")}
    for uid in emp_by_uid:
        docs = user_sick.get(uid, [])
        if not docs:
            bradford_scores.append(0)
            continue
        total_days = sum(d.get("duration_days", 0) for d in docs)
        spells = len(docs)
        bradford_scores.append((spells ** 2) * total_days)

    avg_bradford = round(sum(bradford_scores) / len(bradford_scores), 1) if bradford_scores else 0.0

    # ── 3. Compliance (for the FY that this quarter belongs to)
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

    # ── 4. Sick Leave Rate (within this quarter's FY start → quarter end)
    fy_start = datetime(fy_year, 4, 1, tzinfo=timezone.utc)
    total_sick = 0.0
    if sick_type_ids:
        sick_pipeline = [
            {"$match": {
                "leave_type_id": {"$in": sick_type_ids},
                "status": "APPROVED",
                "start_datetime": {"$gte": fy_start, "$lt": q_end},
                "deleted_on": None,
            }},
            {"$group": {"_id": None, "total": {"$sum": "$duration_days"}}},
        ]
        r = await db[REQUESTS_COL].aggregate(sick_pipeline).to_list(length=None)
        total_sick = r[0]["total"] if r else 0

    all_leave_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": fy_start, "$lt": q_end},
            "deleted_on": None,
        }},
        {"$group": {"_id": None, "total": {"$sum": "$duration_days"}}},
    ]
    all_result = await db[REQUESTS_COL].aggregate(all_leave_pipeline).to_list(length=None)
    total_all = all_result[0]["total"] if all_result else 0

    sick_leave_rate = round(total_sick / total_all, 3) if total_all > 0 else 0.0
    sick_leave_rate_pct = round(sick_leave_rate * 100, 1)

    # ── Compute culture score ────────────────────────────────────────────
    culture_score = round(
        (org_utilization / 100) * 3.5
        + (1 - min(avg_bradford / 1000, 1)) * 2.5
        + (compliance_pct / 100) * 2.0
        + (1 - sick_leave_rate) * 2.0,
        1,
    )
    culture_score = max(0, min(10, culture_score))

    score_doc = {
        "quarter_label": label,
        "fy_year": fy_year,
        "quarter": quarter,
        "quarter_start": q_start,
        "quarter_end": q_end,
        "culture_score": culture_score,
        "components": {
            "org_utilization_pct": org_utilization,
            "avg_bradford_factor": avg_bradford,
            "compliance_pct": compliance_pct,
            "sick_leave_rate_pct": sick_leave_rate_pct,
        },
        "total_employees": total_employees,
        "computed_at": now,
    }

    await db[QUARTERLY_COL].replace_one(
        {"fy_year": fy_year, "quarter": quarter},
        score_doc,
        upsert=True,
    )
    return score_doc


async def backfill_quarterly_scores(
    db: AsyncIOMotorDatabase, num_quarters: int = 12,
) -> list[dict]:
    """Compute and store scores for the last N quarters (including current)."""
    now = datetime.now(timezone.utc)
    fy_year, quarter = _current_quarter(now)

    results = []
    for _ in range(num_quarters):
        doc = await compute_quarter_score(db, fy_year, quarter)
        results.append(doc)
        quarter -= 1
        if quarter < 1:
            quarter = 4
            fy_year -= 1

    results.reverse()
    return results


async def get_culture_score_trend(
    db: AsyncIOMotorDatabase, limit: int = 12,
) -> list[dict]:
    """Fetch the last N quarterly scores, sorted oldest → newest."""
    docs = await db[QUARTERLY_COL].find(
        {}, {"_id": 0, "quarter_label": 1, "culture_score": 1, "components": 1},
    ).sort([("fy_year", 1), ("quarter", 1)]).limit(limit).to_list(length=None)
    return docs
