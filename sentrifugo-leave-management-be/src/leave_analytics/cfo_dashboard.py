"""
CFO leave analytics dashboard — financial view.

Computes leave liability metrics (days and ₹), accrual vs consumption,
expiry projections, LOP deductions, liability by plan, and
year-end processing history. Rupee values are derived from each
employee's latest CTC (encrypted in the employees collection).
"""

from datetime import datetime, timezone
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.crypto import decrypt_amount
from src.employment_status import exclude_inactive_filter
from src.leave_analytics.filters import get_analytics_leave_type_ids
from src.utils import to_oid

REQUESTS_COL = "leave_requests"
BALANCE_COL = "employee_leave_balances"
LEDGER_COL = "leave_credit_ledger"
EXECUTION_COL = "leave_year_end_execution"


def _extract_latest_ctc(ctc_field) -> Optional[float]:
    """Get the latest decrypted CTC from the dict format, legacy string, or None."""
    if ctc_field is None:
        return None
    if isinstance(ctc_field, dict) and ctc_field:
        latest_key = max(ctc_field.keys(), key=lambda k: int(k))
        record = ctc_field[latest_key]
        encrypted = record.get("value") if isinstance(record, dict) else None
        return decrypt_amount(encrypted)
    if isinstance(ctc_field, str):
        return decrypt_amount(ctc_field)
    if isinstance(ctc_field, (int, float)):
        return float(ctc_field)
    return None


def _fy_start(now: datetime) -> datetime:
    year = now.year if now.month >= 4 else now.year - 1
    return datetime(year, 4, 1, tzinfo=timezone.utc)


def _fy_year(now: datetime) -> int:
    return now.year if now.month >= 4 else now.year - 1


async def get_cfo_dashboard(db: AsyncIOMotorDatabase, organisation_id: str | None = None) -> dict:
    now = datetime.now(timezone.utc)
    fy_start = _fy_start(now)
    fy_year = _fy_year(now)

    # ── Active employees ─────────────────────────────────────────────────
    _org_filter = {"organisation_id": to_oid(organisation_id)} if organisation_id else {}
    all_employees = await db["employees"].find(
        {"is_deleted": {"$ne": True}, **_org_filter, **(await exclude_inactive_filter(db))},
        {"_id": 1, "user_id": 1, "department_id": 1, "business_unit_id": 1,
         "first_name": 1, "last_name": 1, "full_name": 1, "name": 1,
         "ctc": 1, "employment_type": 1},
    ).to_list(length=None)

    emp_by_uid: dict[str, dict] = {}
    emp_by_eid: dict[str, dict] = {}
    eid_to_uid: dict[str, str] = {}
    for emp in all_employees:
        if emp.get("user_id"):
            emp_by_uid[str(emp["user_id"])] = emp
        eid = str(emp["_id"])
        emp_by_eid[eid] = emp
        if emp.get("user_id"):
            eid_to_uid[eid] = str(emp["user_id"])

    total_employees = len(emp_by_uid)
    if total_employees == 0:
        return _empty_response()

    # ── Department names ─────────────────────────────────────────────────
    dept_ids = list({e["department_id"] for e in all_employees if e.get("department_id")})
    dept_docs = await db["departments"].find({"_id": {"$in": dept_ids}}).to_list(length=None)
    dept_name_map = {str(d["_id"]): d.get("name", str(d["_id"])) for d in dept_docs}

    # ── User names ───────────────────────────────────────────────────────
    all_user_oids = [e["user_id"] for e in all_employees if e.get("user_id")]
    user_docs = await db["users"].find(
        {"_id": {"$in": all_user_oids}},
        {"first_name": 1, "last_name": 1, "full_name": 1, "name": 1},
    ).to_list(length=None)
    user_name_map = {str(u["_id"]): u for u in user_docs}

    def _resolve_uid(key: str) -> str:
        """Resolve an employee_id or user_id to user_id for name lookup."""
        return eid_to_uid.get(key, key)

    def _first_last(doc: dict) -> str:
        first = (doc.get("first_name") or "").strip()
        last = (doc.get("last_name") or "").strip()
        return f"{first} {last}".strip()

    def _emp_name(key: str) -> str:
        uid = _resolve_uid(key)
        # Employee mirror first — the users replica carries only account
        # lifecycle fields, so a name-less users doc must not shadow it.
        emp = emp_by_uid.get(uid) or emp_by_eid.get(key, {})
        user = user_name_map.get(uid, {})
        return (
            _first_last(emp) or _first_last(user)
            or emp.get("full_name") or emp.get("name")
            or user.get("full_name") or user.get("name")
            or key
        )

    def _emp_dept_name(key: str) -> str:
        uid = _resolve_uid(key)
        emp = emp_by_uid.get(uid) or emp_by_eid.get(key, {})
        did = emp.get("department_id")
        return dept_name_map.get(str(did), "—") if did else "—"

    # ── CTC → daily rate per employee ────────────────────────────────────
    # Employment type key determines divisor: contract → 365, else → 260
    emp_type_ids = list({e["employment_type"] for e in all_employees if e.get("employment_type")})
    emp_type_docs = await db["master_data"].find(
        {"_id": {"$in": emp_type_ids}}, {"_id": 1, "key": 1},
    ).to_list(length=None)
    emp_type_key_map = {str(d["_id"]): d.get("key", "") for d in emp_type_docs}

    daily_rate_map: dict[str, float] = {}
    for emp in all_employees:
        uid = str(emp.get("user_id", ""))
        if not uid:
            continue
        annual_ctc = _extract_latest_ctc(emp.get("ctc"))
        if annual_ctc is None or annual_ctc <= 0:
            continue
        et_id = str(emp.get("employment_type", ""))
        et_key = emp_type_key_map.get(et_id, "")
        divisor = 365 if et_key in ("contract", "internship") else 260
        daily_rate_map[uid] = annual_ctc / divisor

    # Only leave types opted in to analytics feed the financial metrics below.
    analytics_lt_ids = await get_analytics_leave_type_ids(db, organisation_id)

    # ── 1. Balances ──────────────────────────────────────────────────────
    balance_docs = await db[BALANCE_COL].find(
        {"leave_type_id": {"$in": analytics_lt_ids}}
    ).to_list(length=None)

    total_credited = 0.0
    total_debited = 0.0
    per_user_balance: dict[str, float] = {}
    per_plan_balance: dict[str, float] = {}

    for bd in balance_docs:
        uid = str(bd.get("employee_id", ""))
        credited = bd.get("total_credited", 0) or 0
        debited = bd.get("total_debited", 0) or 0
        bal = credited - debited
        total_credited += credited
        total_debited += debited
        per_user_balance[uid] = per_user_balance.get(uid, 0) + bal

        plan_id = str(bd.get("leave_plan_id", "unknown"))
        per_plan_balance[plan_id] = per_plan_balance.get(plan_id, 0) + bal

    total_balance_days = round(total_credited - total_debited, 1)

    # Total Leave Liability (₹)
    total_liability_amount = 0.0
    for uid, bal_days in per_user_balance.items():
        rate = daily_rate_map.get(uid)
        if rate and bal_days > 0:
            total_liability_amount += bal_days * rate
    total_liability_amount = round(total_liability_amount, 2)

    # ── 2. YTD Accrued (from ledger) ─────────────────────────────────────
    accrual_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "transaction_type": {"$in": ["GRANT_CREDIT", "ACCRUAL_CREDIT"]},
            "metadata.leave_year": fy_year,
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]
    accrual_result = await db[LEDGER_COL].aggregate(accrual_pipeline).to_list(length=None)
    ytd_accrued = round(accrual_result[0]["total"], 1) if accrual_result else 0.0

    # ── 3. YTD Consumed ──────────────────────────────────────────────────
    ytd_consumed = round(total_debited, 1)

    # ── 4. LOP deductions (YTD) ──────────────────────────────────────────
    lop_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "loss_of_pay": True,
            "status": "APPROVED",
            "start_datetime": {"$gte": fy_start},
            "deleted_on": None,
        }},
        {"$group": {
            "_id": "$employee_id",
            "total_days": {"$sum": "$duration_days"},
            "count": {"$sum": 1},
        }},
    ]
    lop_results = await db[REQUESTS_COL].aggregate(lop_pipeline).to_list(length=None)
    lop_days = 0.0
    lop_count = 0
    lop_amount = 0.0
    for r in lop_results:
        d = r.get("total_days", 0) or 0
        lop_days += d
        lop_count += r.get("count", 0) or 0
        uid = str(r["_id"]) if r.get("_id") else ""
        rate = daily_rate_map.get(uid)
        if rate:
            lop_amount += d * rate
    lop_days = round(lop_days, 1)
    lop_amount = round(lop_amount, 2)

    # ── 5. Expiring at year-end ──────────────────────────────────────────
    # Get year-end processing configs with carry limits
    ye_configs = await db["year_end_processing"].find(
        {"deleted_on": None},
    ).to_list(length=None)

    plan_carry_limits: dict[str, float] = {}
    plan_processing_types: dict[str, str] = {}
    for cfg in ye_configs:
        pid = str(cfg.get("leave_plan_id", ""))
        ptype = cfg.get("processing_type", "")
        plan_processing_types[pid] = ptype
        pcc = cfg.get("payout_carry_config") or {}
        limit = pcc.get("max_carry_limit")
        if limit is not None:
            plan_carry_limits[pid] = limit

    expiring_days = 0.0
    for bd in balance_docs:
        plan_id = str(bd.get("leave_plan_id", ""))
        ptype = plan_processing_types.get(plan_id, "")
        if ptype not in ("CARRY_FORWARD_EXPIRE", "PAYOUT_THEN_CARRY", "CARRY_THEN_PAYOUT"):
            continue
        limit = plan_carry_limits.get(plan_id)
        if limit is None:
            continue
        bal = (bd.get("total_credited", 0) or 0) - (bd.get("total_debited", 0) or 0)
        above = max(0, bal - limit)
        expiring_days += above

    expiring_days = round(expiring_days, 1)

    # Projected Year-End Payout (₹)
    projected_payout_amount = 0.0
    for bd in balance_docs:
        plan_id = str(bd.get("leave_plan_id", ""))
        ptype = plan_processing_types.get(plan_id, "")
        if ptype not in ("PAYOUT_ALL", "PAYOUT_THEN_CARRY", "CARRY_THEN_PAYOUT"):
            continue
        limit = plan_carry_limits.get(plan_id)
        bal = (bd.get("total_credited", 0) or 0) - (bd.get("total_debited", 0) or 0)
        if ptype == "PAYOUT_ALL":
            payout_days = max(0, bal)
        else:
            payout_days = max(0, bal - (limit or 0)) if limit is not None else 0
        uid = str(bd.get("employee_id", ""))
        rate = daily_rate_map.get(uid)
        if rate and payout_days > 0:
            projected_payout_amount += payout_days * rate
    projected_payout_amount = round(projected_payout_amount, 2)

    # ── 6. Accrual vs Consumption monthly chart ──────────────────────────
    accrual_monthly_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "transaction_type": {"$in": ["GRANT_CREDIT", "ACCRUAL_CREDIT"]},
            "metadata.leave_year": fy_year,
        }},
        {"$group": {
            "_id": "$period_month",
            "days": {"$sum": "$amount"},
        }},
    ]
    accrual_monthly = await db[LEDGER_COL].aggregate(accrual_monthly_pipeline).to_list(length=None)
    accrual_by_month: dict[int, float] = {r["_id"]: round(r["days"], 1) for r in accrual_monthly if r["_id"]}

    consumption_monthly_pipeline = [
        {"$match": {
            "leave_type_id": {"$in": analytics_lt_ids},
            "status": "APPROVED",
            "start_datetime": {"$gte": fy_start},
            "deleted_on": None,
        }},
        {"$group": {
            "_id": {"$month": "$start_datetime"},
            "days": {"$sum": "$duration_days"},
        }},
    ]
    consumption_monthly = await db[REQUESTS_COL].aggregate(consumption_monthly_pipeline).to_list(length=None)
    consumption_by_month: dict[int, float] = {r["_id"]: round(r["days"], 1) for r in consumption_monthly}

    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    # FY months: Apr(4) → Mar(3)
    fy_months = list(range(4, 13)) + list(range(1, 4))
    current_month = now.month
    accrual_chart = []
    for m in fy_months:
        if m > current_month and (m >= 4 or current_month >= 4):
            break
        if m < 4 and current_month < 4 and m > current_month:
            break
        accrual_chart.append({
            "month": month_names[m - 1],
            "accrued": accrual_by_month.get(m, 0),
            "consumed": consumption_by_month.get(m, 0),
        })

    # ── 7. Liability by leave plan (pie chart) ───────────────────────────
    plan_ids = list(per_plan_balance.keys())
    plan_oids = [to_oid(p) for p in plan_ids if p != "unknown"]
    plan_docs = await db["leave_plans"].find(
        {"_id": {"$in": plan_oids}},
        {"_id": 1, "name": 1},
    ).to_list(length=None)
    plan_name_map = {str(d["_id"]): d.get("name", str(d["_id"])) for d in plan_docs}

    # Merge by plan name to handle duplicates
    plan_name_balance: dict[str, float] = {}
    for pid, bal in per_plan_balance.items():
        pname = plan_name_map.get(pid, pid)
        plan_name_balance[pname] = plan_name_balance.get(pname, 0) + bal

    liability_by_plan = [
        {"name": name, "value": round(bal, 1)}
        for name, bal in sorted(plan_name_balance.items(), key=lambda x: -x[1])
        if bal > 0
    ]

    # ── 8. Top liability employees ───────────────────────────────────────
    top_employees = sorted(per_user_balance.items(), key=lambda x: -x[1])[:10]

    # Compute per-user above-carry-limit
    per_user_above: dict[str, float] = {}
    for bd in balance_docs:
        uid = str(bd.get("employee_id", ""))
        plan_id = str(bd.get("leave_plan_id", ""))
        limit = plan_carry_limits.get(plan_id)
        if limit is None:
            continue
        bal = (bd.get("total_credited", 0) or 0) - (bd.get("total_debited", 0) or 0)
        above = max(0, bal - limit)
        per_user_above[uid] = per_user_above.get(uid, 0) + above

    top_liability = []
    for uid, bal in top_employees:
        above = round(per_user_above.get(uid, 0), 1)
        rate = daily_rate_map.get(uid)
        liability = round(bal * rate, 2) if rate else None
        risk = "High" if above > 15 else "Medium" if above > 5 else "Low"
        top_liability.append({
            "employee_name": _emp_name(uid),
            "department": _emp_dept_name(uid),
            "balance_days": round(bal, 1),
            "daily_rate": round(rate, 2) if rate else None,
            "liability_amount": liability,
            "above_carry_limit": above,
            "risk": risk,
        })

    # ── 9. Year-end processing history ───────────────────────────────────
    # Aggregate last year's execution by plan
    last_fy = fy_year - 1
    ye_pipeline = [
        {"$match": {"year": last_fy}},
        {"$group": {
            "_id": "$leave_plan_id",
            "employees": {"$sum": 1},
            "opening_balance": {"$sum": "$opening_balance"},
            "payout_amount": {"$sum": "$payout_amount"},
            "carry_forward_amount": {"$sum": "$carry_forward_amount"},
            "expired_amount": {"$sum": "$expired_amount"},
        }},
    ]
    ye_result = await db[EXECUTION_COL].aggregate(ye_pipeline).to_list(length=None)

    ye_plan_ids = [r["_id"] for r in ye_result if r.get("_id")]
    ye_plan_docs = await db["leave_plans"].find(
        {"_id": {"$in": ye_plan_ids}}, {"_id": 1, "name": 1},
    ).to_list(length=None)
    ye_plan_names = {str(d["_id"]): d.get("name", "—") for d in ye_plan_docs}

    year_end_history = []
    for r in ye_result:
        pid = str(r["_id"]) if r.get("_id") else "unknown"
        year_end_history.append({
            "plan_name": ye_plan_names.get(pid, pid),
            "employees": r["employees"],
            "opening_balance": round(r["opening_balance"], 1),
            "payout_amount": round(r["payout_amount"], 1),
            "carry_forward_amount": round(r["carry_forward_amount"], 1),
            "expired_amount": round(r["expired_amount"], 1),
        })

    year_end_history.sort(key=lambda x: -x["opening_balance"])

    return {
        "kpis": {
            "total_employees": total_employees,
            "total_balance_days": total_balance_days,
            "total_liability_amount": total_liability_amount,
            "ytd_accrued_days": ytd_accrued,
            "ytd_consumed_days": ytd_consumed,
            "utilization_pct": round((total_debited / total_credited) * 100, 1) if total_credited > 0 else 0,
            "expiring_days": expiring_days,
            "projected_payout_amount": projected_payout_amount,
            "lop_days": lop_days,
            "lop_count": lop_count,
            "lop_amount": lop_amount,
        },
        "accrual_chart": accrual_chart,
        "liability_by_plan": liability_by_plan,
        "year_end_history": year_end_history,
        "top_liability": top_liability,
    }


def _empty_response() -> dict:
    return {
        "kpis": {
            "total_employees": 0,
            "total_balance_days": 0,
            "total_liability_amount": 0,
            "ytd_accrued_days": 0,
            "ytd_consumed_days": 0,
            "utilization_pct": 0,
            "expiring_days": 0,
            "projected_payout_amount": 0,
            "lop_days": 0,
            "lop_count": 0,
            "lop_amount": 0,
        },
        "accrual_chart": [],
        "liability_by_plan": [],
        "year_end_history": [],
        "top_liability": [],
    }
