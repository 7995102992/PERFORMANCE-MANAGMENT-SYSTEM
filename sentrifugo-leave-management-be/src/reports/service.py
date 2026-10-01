import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.exceptions import DomainException
from src.utils import to_oid

EXECUTION_COLLECTION = "leave_year_end_execution"
LEDGER_COLLECTION = "leave_entitlement_ledger"
ASSIGNMENTS_COLLECTION = "leave_plan_assignments"


def _paginate(rows: list, page: int, page_size: int) -> list:
    """Slice a page; page_size <= 0 means "all rows" (used by export so it never
    silently truncates at a fixed cap)."""
    if not page_size or page_size <= 0:
        return rows
    start = (page - 1) * page_size
    return rows[start:start + page_size]


async def _build_employee_filter_for_plan(
    db: AsyncIOMotorDatabase, leave_plan_id: str, plan: dict
) -> Optional[dict]:
    org_id = plan.get("org_id")
    assignments = await db[ASSIGNMENTS_COLLECTION].find(
        {"leave_plan_id": to_oid(leave_plan_id), "is_active": True, "deleted_on": None},
        {"scope_type": 1, "department_id": 1, "business_unit_id": 1},
    ).to_list(length=None)

    if not assignments:
        return None

    if any(a.get("scope_type") == "ORG" for a in assignments):
        return {"organisation_id": to_oid(str(org_id)), "is_deleted": {"$ne": True}}

    # One clause per assignment, OR'd together. A DEPARTMENT scope matches BOTH
    # the department AND the business unit (a department can be shared across BUs,
    # so dept alone would wrongly include another BU's employees — mirrors
    # resolve_employee_plan). A BU scope matches by business_unit_id.
    def _both(v):
        return {"$in": [v, str(v)]}

    clauses: list[dict] = []
    for a in assignments:
        st = a.get("scope_type")
        if st == "DEPARTMENT" and a.get("department_id"):
            clause = {"department_id": _both(a["department_id"])}
            if a.get("business_unit_id"):
                clause["business_unit_id"] = _both(a["business_unit_id"])
            clauses.append(clause)
        elif st == "BU" and a.get("business_unit_id"):
            clauses.append({"business_unit_id": _both(a["business_unit_id"])})

    if not clauses:
        return None

    base: dict = {"is_deleted": {"$ne": True}}
    if len(clauses) == 1:
        base.update(clauses[0])
    else:
        base["$or"] = clauses
    return base


async def _resolve_leave_plan(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: Optional[str] = None
) -> dict:
    plan = await db["leave_plans"].find_one({"_id": to_oid(leave_plan_id), "deleted_on": None})
    if not plan:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    # Tenant isolation: a caller may only pull plans in their own organisation.
    if org_id is not None and str(plan.get("org_id")) != str(org_id):
        raise DomainException(
            message="You do not have permission to access this leave plan",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return plan


async def _get_leave_type_map(db: AsyncIOMotorDatabase, plan: dict) -> dict[str, str]:
    leave_type_ids = list(plan.get("leave_type_ids") or [])
    if not leave_type_ids:
        type_mappings = await db["leave_plan_type_mapping"].find(
            {"leave_plan_id": plan["_id"]}
        ).to_list(length=None)
        leave_type_ids = [m["leave_type_id"] for m in type_mappings]
    if not leave_type_ids:
        return {}
    lt_docs = await db["leave_types"].find(
        {"_id": {"$in": leave_type_ids}, "deleted_on": None}
    ).to_list(length=None)
    return {str(doc["_id"]): doc["name"] for doc in lt_docs}


async def _enrich_employees(
    db: AsyncIOMotorDatabase, employee_ids: list[ObjectId]
) -> dict[str, dict]:
    if not employee_ids:
        return {}
    emp_docs = await db["employees"].find(
        {"_id": {"$in": employee_ids}},
        {
            "_id": 1, "emp_code": 1, "name": 1, "first_name": 1, "last_name": 1,
            "department_id": 1, "business_unit_id": 1,
        },
    ).to_list(length=None)

    dept_ids = list({e["department_id"] for e in emp_docs if e.get("department_id")})
    bu_ids = list({e["business_unit_id"] for e in emp_docs if e.get("business_unit_id")})

    dept_map = {}
    if dept_ids:
        for d in await db["departments"].find({"_id": {"$in": dept_ids}}).to_list(length=None):
            dept_map[str(d["_id"])] = d["name"]

    bu_map = {}
    if bu_ids:
        for b in await db["business_units"].find({"_id": {"$in": bu_ids}}).to_list(length=None):
            bu_map[str(b["_id"])] = b["name"]

    result = {}
    for e in emp_docs:
        eid = str(e["_id"])
        full_name = (
            e.get("name")
            or f"{e.get('first_name', '') or ''} {e.get('last_name', '') or ''}".strip()
            or "—"
        )
        dept_id = str(e["department_id"]) if e.get("department_id") else None
        bu_id = str(e["business_unit_id"]) if e.get("business_unit_id") else None
        result[eid] = {
            "emp_code": e.get("emp_code") or "",
            "name": full_name,
            "department": dept_map.get(dept_id, "—") if dept_id else "—",
            "business_unit": bu_map.get(bu_id, "—") if bu_id else "—",
        }
    return result


async def get_year_end_report(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    year: int,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = 25,
    org_id: Optional[str] = None,
) -> dict:
    plan = await _resolve_leave_plan(db, leave_plan_id, org_id)
    lt_map = await _get_leave_type_map(db, plan)

    match = {
        "leave_plan_id": to_oid(leave_plan_id),
        "year": year,
    }
    exec_docs = await db[EXECUTION_COLLECTION].find(match).to_list(length=None)
    if not exec_docs:
        return {
            "leave_plan_name": plan.get("name", ""),
            "year": year,
            "leave_types": [{"id": k, "name": v} for k, v in lt_map.items()],
            "employees": [],
            "total_count": 0,
        }

    emp_oids = list({doc["employee_id"] for doc in exec_docs if doc.get("employee_id")})
    emp_info = await _enrich_employees(db, emp_oids)

    needs_ledger_fallback = any(not doc.get("leave_type_details") for doc in exec_docs)
    ledger_map: dict[str, dict[str, dict]] = {}
    if needs_ledger_fallback and lt_map:
        pipeline = [
            {
                "$match": {
                    "employee_id": {"$in": emp_oids},
                    "transaction_type": {"$in": [
                        "YEAR_END_PAYOUT", "YEAR_END_EXPIRY", "YEAR_END_NEGATIVE_RECOVERY",
                    ]},
                    "metadata.year": year,
                    "metadata.leave_plan_id": leave_plan_id,
                }
            },
            {
                "$group": {
                    "_id": {"employee_id": "$employee_id", "leave_type_id": "$leave_type_id"},
                    "payout": {"$sum": {"$cond": [{"$eq": ["$transaction_type", "YEAR_END_PAYOUT"]}, "$amount", 0]}},
                    "expired": {"$sum": {"$cond": [{"$eq": ["$transaction_type", "YEAR_END_EXPIRY"]}, "$amount", 0]}},
                }
            },
        ]
        agg = await db[LEDGER_COLLECTION].aggregate(pipeline).to_list(length=None)
        for row in agg:
            eid = str(row["_id"]["employee_id"])
            ltid = str(row["_id"]["leave_type_id"])
            if eid not in ledger_map:
                ledger_map[eid] = {}
            ledger_map[eid][ltid] = {"payout": row["payout"], "expired": row["expired"]}

    rows = []
    for doc in exec_docs:
        emp_id = str(doc["employee_id"])
        info = emp_info.get(emp_id, {})
        if search:
            pattern = re.compile(re.escape(search), re.IGNORECASE)
            if not (
                pattern.search(info.get("name", ""))
                or pattern.search(info.get("emp_code", ""))
                or pattern.search(info.get("department", ""))
            ):
                continue

        leave_type_details = []
        raw_details = doc.get("leave_type_details") or []
        if raw_details:
            for d in raw_details:
                lt_id = str(d.get("leave_type_id", ""))
                leave_type_details.append({
                    "leave_type_id": lt_id,
                    "leave_type_name": lt_map.get(lt_id, lt_id),
                    "opening_balance": d.get("opening_balance", 0),
                    "payout_amount": d.get("payout_amount", 0),
                    "encashed_amount": d.get("encashed_amount", 0),
                    "carry_forward_amount": d.get("carry_forward_amount", 0),
                    "expired_amount": d.get("expired_amount", 0),
                    "closing_balance": d.get("closing_balance", 0),
                })
        else:
            emp_ledger = ledger_map.get(emp_id, {})
            total_opening = doc.get("opening_balance", 0)
            num_types = len(lt_map) or 1
            for lt_id, lt_name in lt_map.items():
                per_type = emp_ledger.get(lt_id, {})
                payout = per_type.get("payout", 0)
                expired = per_type.get("expired", 0)
                opening = (payout + expired) if (payout or expired) else (total_opening / num_types)
                carry = opening - payout - expired
                leave_type_details.append({
                    "leave_type_id": lt_id,
                    "leave_type_name": lt_name,
                    "opening_balance": opening,
                    "payout_amount": payout,
                    "encashed_amount": 0,
                    "carry_forward_amount": max(carry, 0),
                    "expired_amount": expired,
                    "closing_balance": max(carry, 0),
                })

        rows.append({
            "employee_id": emp_id,
            "emp_code": info.get("emp_code", ""),
            "name": info.get("name", "—"),
            "department": info.get("department", "—"),
            "business_unit": info.get("business_unit", "—"),
            "year": doc.get("year"),
            "opening_balance": doc.get("opening_balance", 0),
            "payout_amount": doc.get("payout_amount", 0),
            "encashed_amount": doc.get("encashed_amount", 0),
            "carry_forward_amount": doc.get("carry_forward_amount", 0),
            "expired_amount": doc.get("expired_amount", 0),
            "closing_balance": doc.get("closing_balance", 0),
            "status": doc.get("execution_status", "SUCCESS"),
            "leave_type_details": leave_type_details,
        })

    rows.sort(key=lambda r: (r["business_unit"], r["department"], r["name"]))
    total_count = len(rows)

    return {
        "leave_plan_name": plan.get("name", ""),
        "year": year,
        "leave_types": [{"id": k, "name": v} for k, v in lt_map.items()],
        "employees": _paginate(rows, page, page_size),
        "total_count": total_count,
    }


async def get_year_end_years(
    db: AsyncIOMotorDatabase, leave_plan_id: str, org_id: Optional[str] = None
) -> list[int]:
    # Enforce tenant isolation on the plan before returning its execution years.
    await _resolve_leave_plan(db, leave_plan_id, org_id)
    years = await db[EXECUTION_COLLECTION].distinct(
        "year", {"leave_plan_id": to_oid(leave_plan_id)}
    )
    return sorted(years, reverse=True)


async def get_current_balance_report(
    db: AsyncIOMotorDatabase,
    leave_plan_id: str,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = 25,
    org_id: Optional[str] = None,
) -> dict:
    plan = await _resolve_leave_plan(db, leave_plan_id, org_id)
    lt_map = await _get_leave_type_map(db, plan)
    leave_type_ids = list(lt_map.keys())

    if not leave_type_ids:
        return {
            "leave_plan_name": plan.get("name", ""),
            "leave_types": [],
            "employees": [],
            "total_count": 0,
        }

    emp_filter = await _build_employee_filter_for_plan(db, leave_plan_id, plan)
    if not emp_filter:
        return {
            "leave_plan_name": plan.get("name", ""),
            "leave_types": [{"id": k, "name": v} for k, v in lt_map.items()],
            "employees": [],
            "total_count": 0,
        }

    emp_docs = await db["employees"].find(emp_filter, {"_id": 1, "user_id": 1}).to_list(length=None)
    emp_oids = [e["_id"] for e in emp_docs]

    if not emp_oids:
        return {
            "leave_plan_name": plan.get("name", ""),
            "leave_types": [{"id": k, "name": v} for k, v in lt_map.items()],
            "employees": [],
            "total_count": 0,
        }

    # ── Read the SOURCE OF TRUTH, not the manual-adjustment ledger ─────────────
    # Spendable balance lives in leave_employee_balance_tracker (fed by BOTH accrual
    # and approval). Pending reservations are in leave_balance_holds; taken leave is
    # the sum of APPROVED, balance-deducting requests. The old aggregation read
    # leave_entitlement_ledger and matched employee_id, but accrual credits live in
    # leave_credit_ledger and approval DEBITs are keyed by user_id — so it showed
    # ~0 used and an overstated, reality-disconnected balance. (R1/R2/R4/R5)
    user_oids = [e["user_id"] for e in emp_docs if e.get("user_id")]
    lt_oids = [to_oid(x) for x in leave_type_ids]

    csm = int(plan.get("calendar_start_month") or 1)
    _now = datetime.now(timezone.utc)
    ly_year = _now.year if _now.month >= csm else _now.year - 1
    cycle_start = datetime(ly_year, csm, 1, tzinfo=timezone.utc)

    tracker_rows = await db["leave_employee_balance_tracker"].find(
        {"user_id": {"$in": user_oids}, "leave_type_id": {"$in": lt_oids}}
    ).to_list(length=None)
    bal_by = {(str(r["user_id"]), str(r["leave_type_id"])): float(r.get("balance_hours") or 0.0) for r in tracker_rows}

    held_rows = await db["leave_balance_holds"].aggregate([
        {"$match": {"user_id": {"$in": user_oids}, "leave_type_id": {"$in": lt_oids}, "status": "ACTIVE"}},
        {"$group": {"_id": {"u": "$user_id", "lt": "$leave_type_id"}, "h": {"$sum": "$hours"}}},
    ]).to_list(length=None)
    held_by = {(str(r["_id"]["u"]), str(r["_id"]["lt"])): float(r["h"] or 0.0) for r in held_rows}

    used_rows = await db["leave_requests"].aggregate([
        {"$match": {
            "user_id": {"$in": user_oids}, "leave_type_id": {"$in": lt_oids},
            "status": "APPROVED", "loss_of_pay": {"$ne": True}, "deleted_on": None,
            "start_datetime": {"$gte": cycle_start},
        }},
        {"$group": {"_id": {"u": "$user_id", "lt": "$leave_type_id"}, "h": {"$sum": "$duration_hours"}}},
    ]).to_list(length=None)
    used_by = {(str(r["_id"]["u"]), str(r["_id"]["lt"])): float(r["h"] or 0.0) for r in used_rows}

    # Credited this leave year = accrual (leave_credit_ledger, by employee_id + period_year)
    # plus admin manual credits (leave_entitlement_ledger, by user_id).
    cred_rows = await db["leave_credit_ledger"].aggregate([
        {"$match": {"employee_id": {"$in": emp_oids}, "leave_type_id": {"$in": lt_oids}, "period_year": ly_year}},
        {"$group": {"_id": {"e": "$employee_id", "lt": "$leave_type_id"}, "h": {"$sum": "$amount"}}},
    ]).to_list(length=None)
    cred_by = {(str(r["_id"]["e"]), str(r["_id"]["lt"])): float(r["h"] or 0.0) for r in cred_rows}

    adj_rows = await db[LEDGER_COLLECTION].aggregate([
        {"$match": {
            "user_id": {"$in": user_oids}, "leave_type_id": {"$in": lt_oids},
            "transaction_type": {"$in": ["CREDIT", "ADJUSTMENT"]},
        }},
        {"$group": {"_id": {"u": "$user_id", "lt": "$leave_type_id"}, "h": {"$sum": "$amount"}}},
    ]).to_list(length=None)
    adj_by = {(str(r["_id"]["u"]), str(r["_id"]["lt"])): float(r["h"] or 0.0) for r in adj_rows}

    per_emp_type: dict[str, dict[str, dict]] = defaultdict(dict)
    for e in emp_docs:
        emp_id = str(e["_id"])
        uid = e.get("user_id")
        if not uid:
            continue
        us = str(uid)
        for lt_id in leave_type_ids:
            uk = (us, str(lt_id))
            tracker_bal = bal_by.get(uk, 0.0)
            held = held_by.get(uk, 0.0)
            per_emp_type[emp_id][lt_id] = {
                # available spendable = clamped tracker minus pending holds (matches
                # get_available_balance, the figure the apply-engine enforces).
                "balance": max(tracker_bal, 0.0) - held,
                "used_ytd": used_by.get(uk, 0.0),
                "on_hold": held,
                "opening": cred_by.get((emp_id, str(lt_id)), 0.0) + adj_by.get(uk, 0.0),
            }

    emp_info = await _enrich_employees(db, emp_oids)

    rows = []
    for emp_oid in emp_oids:
        emp_id = str(emp_oid)
        info = emp_info.get(emp_id, {})
        if search:
            pattern = re.compile(re.escape(search), re.IGNORECASE)
            if not (
                pattern.search(info.get("name", ""))
                or pattern.search(info.get("emp_code", ""))
                or pattern.search(info.get("department", ""))
            ):
                continue

        emp_data = per_emp_type.get(emp_id, {})
        total_opening = 0.0
        total_used = 0.0
        total_balance = 0.0
        total_on_hold = 0.0
        leave_type_details = []
        for lt_id, lt_name in lt_map.items():
            d = emp_data.get(lt_id, {"opening": 0, "used_ytd": 0, "balance": 0, "on_hold": 0})
            total_opening += d["opening"]
            total_used += d["used_ytd"]
            total_balance += d["balance"]
            total_on_hold += d.get("on_hold", 0)
            leave_type_details.append({
                "leave_type_id": lt_id,
                "leave_type_name": lt_name,
                "opening": d["opening"],
                "used_ytd": d["used_ytd"],
                "on_hold": d.get("on_hold", 0),
                "balance": d["balance"],
            })

        rows.append({
            "employee_id": emp_id,
            "emp_code": info.get("emp_code", ""),
            "name": info.get("name", "—"),
            "department": info.get("department", "—"),
            "business_unit": info.get("business_unit", "—"),
            "opening": total_opening,
            "used_ytd": total_used,
            "on_hold": total_on_hold,
            "total_balance": total_balance,
            "leave_type_details": leave_type_details,
        })

    rows.sort(key=lambda r: (r["business_unit"], r["department"], r["name"]))
    total_count = len(rows)

    return {
        "leave_plan_name": plan.get("name", ""),
        "leave_types": [{"id": k, "name": v} for k, v in lt_map.items()],
        "employees": _paginate(rows, page, page_size),
        "total_count": total_count,
    }
