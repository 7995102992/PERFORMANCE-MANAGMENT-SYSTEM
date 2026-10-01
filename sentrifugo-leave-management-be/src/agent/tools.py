"""
Tool registry for the leave-management agent.

Each tool below is exposed to the LLM. The LLM can read the docstring + type
signature to decide when to call it. The acting user is NEVER a tool argument
— it's read from RunnableConfig.metadata (populated by the router from the
authenticated session), so the LLM cannot spoof identity.

Add new tools by:
1. Writing an `@tool`-decorated async function.
2. Appending it to TOOLS at the bottom of this file.
"""

import json
from datetime import date as date_type, datetime, time as time_type, timezone
from typing import Literal, Optional

from bson import ObjectId
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, tool
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.balance_tracker import get_balance_from_tracker
from src.database import get_db
from src.exceptions import DomainException
from src.leave_requests import service as leave_service
from src.leave_requests.schemas import ApprovalActionPayload, DurationMode, LeaveRequestCreate, SessionHalf
from src.manager.service import (
    approve_managed_leave_request,
    list_pending_approvals as _manager_list_pending_approvals,
    reject_managed_leave_request,
)
from src.utils import to_oid

_MAX_REASON = 300


# ─── Identity & context helpers ──────────────────────────────────────────────

def _meta(config: RunnableConfig) -> dict:
    return (config or {}).get("metadata") or {}


def _require_user_id(config: RunnableConfig) -> str:
    user_id = _meta(config).get("user_id")
    if not user_id:
        raise RuntimeError("Tool invoked without user_id in RunnableConfig metadata")
    return user_id


async def _employee_for_user(db: AsyncIOMotorDatabase, user_id: str) -> dict:
    """
    Resolve the employee document for the authenticated user.

    `employees.user_id` is the auth/IAM id (what the JWT carries);
    `employees._id` is the employee id used everywhere else in the domain.
    """
    employee = await db["employees"].find_one(
        {"user_id": to_oid(user_id), "is_deleted": {"$eq": False}}
    )
    if not employee: 
        # Some legacy seed data stores user_id directly as the employee _id.
        employee = await db["employees"].find_one(
            {"_id": to_oid(user_id), "is_deleted": {"$eq": False}}
        )
    if not employee:
        raise RuntimeError(f"No employee record found for user {user_id}")
    return employee


# ─── Serialisation helpers ───────────────────────────────────────────────────

def _clean(value):
    """Recursively make a Mongo doc JSON-safe (ObjectId → str, datetime → ISO)."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _as_json(data) -> str:
    return json.dumps(_clean(data), ensure_ascii=False, default=str)


# ─── 1. Leave types ──────────────────────────────────────────────────────────

@tool
async def fetch_leave_types(config: RunnableConfig) -> str:
    """
    List the leave types available to the current user's organisation.

    Returns both org-specific custom types and system-wide types (which have
    no org_id). Useful before submitting a request, or when the user asks
    "what kinds of leave can I take?".
    """
    db = get_db()
    org_id = _meta(config).get("org_id")
    cursor = db["leave_types"].find(
        {
            "$or": [{"org_id": to_oid(org_id)}, {"org_id": None}],
            "deleted_on": None,
        }
    )
    docs = await cursor.to_list(length=None)
    items = [
        {
            "id": str(d["_id"]),
            "name": d.get("name"),
            "code": d.get("code"),
            "unit": d.get("unit", "DAYS"),
            "deduct_from_balance": d.get("deduct_from_balance", True),
            "is_custom": d.get("is_custom", False),
        }
        for d in docs
    ]
    return _as_json({"leave_types": items})


# ─── 2. Leave balance ────────────────────────────────────────────────────────

@tool
async def fetch_leave_balance(
    config: RunnableConfig,
    leave_type_id: Optional[str] = None,
) -> str:
    """
    Return the current user's leave balance.

    - If `leave_type_id` is given, returns the balance for that single type.
    - Otherwise returns balances across every leave type the user is entitled
      to under their assigned leave plan.

    Balance is expressed in the unit defined on the leave type (DAYS or HOURS);
    when reporting to the user, prefer DAYS.
    """
    db = get_db()
    user_id = _require_user_id(config)

    if leave_type_id:
        bal = await leave_service.get_leave_balance(db, user_id, leave_type_id)
        return _as_json(bal)

    result = await leave_service.get_all_leave_balances(
        db, user_id, org_id=_meta(config).get("org_id")
    )
    return _as_json(result)


# ─── 3. Leave plan ───────────────────────────────────────────────────────────

async def _resolve_leave_plan(db: AsyncIOMotorDatabase, employee: dict) -> dict:
    """
    Resolve the leave plan that applies to the employee.

    Priority (high → low):
    1. Direct mapping in `employee_leave_plans` (employee was added separately,
       either via an explicit assignment or via prior auto-resolution).
    2. `leave_plan_assignments` at DEPARTMENT scope matching the employee's
       department_id.
    3. `leave_plan_assignments` at BU scope matching the employee's
       business_unit_id.
    4. `leave_plan_assignments` at ORG scope.
    """
    employee_id = str(employee["_id"])
    dept_id = employee.get("department_id")
    bu_id = employee.get("business_unit_id")

    # 1. Direct employee mapping
    direct = await db["employee_leave_plans"].find_one({"employee_id": employee_id})
    if direct:
        plan = await db["leave_plans"].find_one(
            {"_id": direct["leave_plan_id"], "deleted_on": None}
        )
        if plan:
            return {"source": "EMPLOYEE", "plan": plan, "assignment": None}

    # 2-4. Resolve via assignment scopes
    active = await db["leave_plans"].find(
        {"is_active": True, "deleted_on": None}, {"_id": 1}
    ).to_list(length=None)
    active_ids = [p["_id"] for p in active]
    if not active_ids:
        return {"source": None, "plan": None, "assignment": None}

    scopes = []
    if dept_id:
        # A department can be shared across BUs and every DEPARTMENT assignment is
        # scoped to a specific BU, so match on BOTH (mirrors resolve_employee_plan)
        # — dept alone could resolve to another BU's plan.
        dept_scope = {"scope_type": "DEPARTMENT", "department_id": dept_id}
        if bu_id:
            dept_scope["business_unit_id"] = bu_id
        scopes.append(("DEPARTMENT", dept_scope))
    if bu_id:
        scopes.append(("BU", {"scope_type": "BU", "business_unit_id": bu_id}))
    scopes.append(("ORG", {"scope_type": "ORG"}))

    for source, scope_query in scopes:
        assignment = await db["leave_plan_assignments"].find_one(
            {
                "leave_plan_id": {"$in": active_ids},
                "is_active": True,
                "deleted_on": None,
                **scope_query,
            },
            sort=[("priority", 1)],
        )
        if assignment:
            plan = await db["leave_plans"].find_one(
                {"_id": assignment["leave_plan_id"], "deleted_on": None}
            )
            if plan:
                return {"source": source, "plan": plan, "assignment": assignment}

    return {"source": None, "plan": None, "assignment": None}


@tool
async def fetch_leave_plan(config: RunnableConfig) -> str:
    """
    Return the leave plan that governs the current user's leaves.

    Resolution order: direct employee assignment first, then the assignment
    scoped to the employee's department, then their business unit, then the
    organisation-wide default. The response includes a `source` field telling
    you which scope matched (EMPLOYEE / DEPARTMENT / BU / ORG).
    """
    db = get_db()
    user_id = _require_user_id(config)
    employee = await _employee_for_user(db, user_id)
    result = await _resolve_leave_plan(db, employee)

    if not result["plan"]:
        return _as_json(
            {
                "employee_id": str(employee["_id"]),
                "department_id": employee.get("department_id"),
                "business_unit_id": employee.get("business_unit_id"),
                "source": None,
                "message": "No active leave plan resolves for this employee.",
            }
        )

    plan = result["plan"]
    return _as_json(
        {
            "employee_id": str(employee["_id"]),
            "department_id": employee.get("department_id"),
            "business_unit_id": employee.get("business_unit_id"),
            "source": result["source"],
            "plan": {
                "id": str(plan["_id"]),
                "name": plan.get("name"),
                "description": plan.get("description"),
                "is_active": plan.get("is_active"),
                "org_id": plan.get("org_id"),
            },
            "assignment_id": (
                str(result["assignment"]["_id"]) if result["assignment"] else None
            ),
        }
    )


# ─── 4. Holiday plan ─────────────────────────────────────────────────────────

async def _resolve_holiday_plan(
    db: AsyncIOMotorDatabase, employee: dict, year: Optional[int] = None
) -> dict:
    """
    Resolve the holiday plan that applies to the employee.

    Priority:
    1. Employee added directly via `holiday_plan_employees`.
    2. Plan whose `department_ids` contains the employee's department.
    3. Plan whose `business_unit_ids` contains the employee's BU.
    4. Org-wide plan (no department/BU restriction) — `department_ids` and
       `business_unit_ids` both empty.
    """
    employee_oid = employee["_id"]
    org_id = employee.get("organisation_id")
    dept_id = employee.get("department_id")
    bu_id = employee.get("business_unit_id")

    base_query: dict = {"deleted_on": None, "is_active": True}
    if year is not None:
        base_query["year"] = year
    if org_id:
        base_query["org_id"] = org_id

    # 1. Direct employee assignment
    direct = await db["holiday_plan_employees"].find_one(
        {"employee_id": employee_oid, "deleted_on": None}
    )
    if direct:
        plan = await db["holiday_plans"].find_one({"_id": direct["plan_id"], **base_query})
        if plan:
            return {"source": "EMPLOYEE", "plan": plan}

    # 2. Department scope
    if dept_id:
        plan = await db["holiday_plans"].find_one(
            {**base_query, "department_ids": dept_id}
        )
        if plan:
            return {"source": "DEPARTMENT", "plan": plan}

    # 3. BU scope
    if bu_id:
        plan = await db["holiday_plans"].find_one(
            {**base_query, "business_unit_ids": bu_id}
        )
        if plan:
            return {"source": "BU", "plan": plan}

    # 4. Org-wide (no scope restriction)
    plan = await db["holiday_plans"].find_one(
        {
            **base_query,
            "$or": [
                {"department_ids": {"$in": [None, []]}},
                {"department_ids": {"$exists": False}},
            ],
            "$and": [
                {
                    "$or": [
                        {"business_unit_ids": {"$in": [None, []]}},
                        {"business_unit_ids": {"$exists": False}},
                    ]
                }
            ],
        }
    )
    if plan:
        return {"source": "ORG", "plan": plan}

    return {"source": None, "plan": None}


@tool
async def fetch_holiday_plan(
    config: RunnableConfig,
    year: Optional[int] = None,
) -> str:
    """
    Return the holiday plan that applies to the current user, including its
    list of holidays.

    Resolution order: direct employee assignment, then department, then
    business unit, then organisation-wide. Pass `year` to scope to a specific
    calendar year; defaults to the current year if omitted.
    """
    db = get_db()
    user_id = _require_user_id(config)
    employee = await _employee_for_user(db, user_id)
    year = year or datetime.now(timezone.utc).year
    result = await _resolve_holiday_plan(db, employee, year=year)

    if not result["plan"]:
        return _as_json(
            {
                "employee_id": str(employee["_id"]),
                "year": year,
                "source": None,
                "message": "No active holiday plan resolves for this employee.",
            }
        )

    plan = result["plan"]
    holidays = await db["holidays"].find(
        {"plan_id": plan["_id"], "deleted_on": None}
    ).sort("date", 1).to_list(length=None)

    return _as_json(
        {
            "employee_id": str(employee["_id"]),
            "year": year,
            "source": result["source"],
            "plan": {
                "id": str(plan["_id"]),
                "name": plan.get("name"),
                "year": plan.get("year"),
            },
            "holidays": [
                {
                    "id": str(h["_id"]),
                    "date": h.get("date"),
                    "name": h.get("name"),
                    "type": h.get("type"),
                }
                for h in holidays
            ],
        }
    )


# ─── 5. Current leave status ─────────────────────────────────────────────────

@tool
async def fetch_current_leave_status(config: RunnableConfig) -> str:
    """
    Return the current user's *active* leave situation right now.

    - If a PENDING or APPROVED leave covers today's date, returns that leave.
    - Otherwise returns the next upcoming PENDING/APPROVED leave, if any.
    - Otherwise returns `on_leave: false` and no upcoming leave.

    Use this when the user asks "am I on leave?", "what's my next leave?",
    "do I have any leave coming up?".
    """
    db = get_db()
    user_id = _require_user_id(config)
    employee = await _employee_for_user(db, user_id)
    employee_id = str(employee["_id"])
    now = datetime.now(timezone.utc)

    active = await db["leave_requests"].find_one(
        {
            "employee_id": ObjectId(employee_id),
            "status": {"$in": ["PENDING", "APPROVED"]},
            "start_datetime": {"$lte": now},
            "end_datetime": {"$gte": now},
            "deleted_on": None,
        }
    )

    upcoming = None
    if not active:
        upcoming = await db["leave_requests"].find_one(
            {
                "employee_id": ObjectId(employee_id),
                "status": {"$in": ["PENDING", "APPROVED"]},
                "start_datetime": {"$gt": now},
                "deleted_on": None,
            },
            sort=[("start_datetime", 1)],
        )

    def _shape(req: Optional[dict]) -> Optional[dict]:
        if not req:
            return None
        return {
            "leave_request_id": str(req["_id"]),
            "leave_type_id": req.get("leave_type_id"),
            "start_datetime": req.get("start_datetime"),
            "end_datetime": req.get("end_datetime"),
            "duration_hours": req.get("duration_hours"),
            "status": req.get("status"),
            "note": req.get("note"),
        }

    return _as_json(
        {
            "employee_id": employee_id,
            "on_leave": bool(active),
            "active_leave": _shape(active),
            "next_upcoming_leave": _shape(upcoming),
        }
    )


# ─── 6. List leaves with filters ─────────────────────────────────────────────

@tool
async def fetch_leaves(
    config: RunnableConfig,
    scope: Literal["OWN", "REPORTEES"] = "OWN",
    status: Optional[Literal["PENDING", "APPROVED", "REJECTED", "CANCELLED"]] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    limit: int = 25,
) -> str:
    """
    List leave requests, filtered.

    Parameters:
    - scope: "OWN" returns the current user's own leave requests.
             "REPORTEES" returns leave requests by direct reports (employees
             whose l1_manager_id or l2_manager_id is the current user).
    - status: optional — restrict to a single status. Omit to get all statuses.
    - from_date / to_date: ISO YYYY-MM-DD. Filter by overlap with this range.
    - limit: max number of rows to return (default 25, hard cap 100).

    Use scope="REPORTEES" only when the user is acting in a manager capacity
    (e.g. "show me pending approvals", "what leaves did my team take last month").
    """
    db = get_db()
    user_id = _require_user_id(config)
    employee = await _employee_for_user(db, user_id)
    employee_id = str(employee["_id"])
    employee_oid = employee["_id"]
    limit = max(1, min(limit, 100))

    query: dict = {"deleted_on": None}

    if scope == "OWN":
        query["employee_id"] = ObjectId(employee_id)
    else:  # REPORTEES
        reportees_cursor = db["employees"].find(
            {
                "$or": [
                    {"l1_manager_id": employee_oid},
                    {"l2_manager_id": employee_oid},
                ],
                "is_deleted": {"$ne": True},
            },
            {"_id": 1, "name": 1},
        )
        reportees = await reportees_cursor.to_list(length=None)
        if not reportees:
            return _as_json(
                {"scope": scope, "count": 0, "leaves": [], "note": "No reportees found."}
            )
        reportee_ids = [r["_id"] for r in reportees]
        query["employee_id"] = {"$in": reportee_ids}

    if status:
        query["status"] = status

    if from_date or to_date:
        range_clause: dict = {}
        if from_date:
            range_clause["$gte"] = from_date
        if to_date:
            range_clause["$lte"] = to_date
        # overlap: leave.start <= to AND leave.end >= from
        if from_date:
            query["end_datetime"] = {"$gte": from_date}
        if to_date:
            query["start_datetime"] = {"$lte": to_date}

    docs = await db["leave_requests"].find(query).sort("start_datetime", -1).limit(limit).to_list(length=limit)

    return _as_json(
        {
            "scope": scope,
            "count": len(docs),
            "leaves": [
                {
                    "leave_request_id": str(d["_id"]),
                    "employee_id": str(d.get("employee_id")) if d.get("employee_id") else None,
                    "leave_type_id": d.get("leave_type_id"),
                    "start_datetime": d.get("start_datetime"),
                    "end_datetime": d.get("end_datetime"),
                    "duration_hours": d.get("duration_hours"),
                    "status": d.get("status"),
                    "note": d.get("note"),
                }
                for d in docs
            ],
        }
    )


# ─── 7. Leave eligibility pre-flight ─────────────────────────────────────────

@tool
async def check_leave_eligibility(
    config: RunnableConfig,
    leave_type_id: str,
    start_date: str,
    end_date: str,
    duration_mode: str = "FULL_DAYS",
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
) -> str:
    """Run pre-flight validation for a leave request without submitting it.

    Returns a report covering estimated duration, overlap detection, and
    balance availability. Always call this BEFORE apply_leave.

    Args:
        leave_type_id: The leave type ID (from fetch_leave_types).
        start_date: ISO date string (e.g. 2026-05-01).
        end_date: ISO date string (e.g. 2026-05-03).
        duration_mode: FULL_DAYS (default), HALF_DAY, or CUSTOM.
        half_day_period: FIRST_HALF or SECOND_HALF — required for HALF_DAY mode.
        start_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
        end_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
    """
    db = get_db()
    user_id = _require_user_id(config)

    report: list[str] = []
    issues: list[str] = []
    now_utc = datetime.now(timezone.utc)

    try:
        s_date = date_type.fromisoformat(start_date)
        e_date = date_type.fromisoformat(end_date)
    except ValueError:
        return "Invalid date format — use ISO date (e.g. 2026-05-01)."

    if s_date > e_date:
        return "end_date must be on or after start_date."
    if duration_mode == "HALF_DAY" and s_date != e_date:
        return "HALF_DAY mode requires start_date and end_date to be the same day."

    report.append("✅ Dates: Valid")

    leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
    if not leave_type:
        return "Leave type not found. Call fetch_leave_types for valid IDs."

    unit = leave_type.get("unit", "DAYS")
    report.append(f"ℹ️  Leave type: {leave_type.get('name', 'N/A')} (unit: {unit})")

    # Duration via service (reuses work-calendar resolver)
    duration_days = 0.0
    try:
        estimate = await leave_service.estimate_leave_duration(
            db,
            employee_id=user_id,
            leave_type_id=leave_type_id,
            start_date_str=start_date,
            end_date_str=end_date,
            duration_mode=duration_mode,
            half_day_period=half_day_period,
            start_session=start_session,
            end_session=end_session,
        )
        duration_hours = estimate["estimated_hours"]
        duration_days = estimate["estimated_days"]
        if duration_hours <= 0:
            issues.append("Duration is zero — check your dates or duration mode.")
            report.append("❌ Duration: Zero after computation")
        else:
            report.append(
                f"✅ Duration: {duration_days:.2f} day(s)  /  {duration_hours:.2f} hour(s)"
            )
    except DomainException as exc:
        issues.append(exc.message)
        report.append(f"❌ Duration: {exc.message}")
    except Exception as exc:
        issues.append(f"Duration computation failed: {exc}")
        report.append(f"❌ Duration: Could not compute — {exc}")

    if s_date < now_utc.date():
        issues.append("Start date is in the past — policy may not allow back-dated leave.")
        report.append("⚠️  Start date: In the past")
    else:
        report.append("✅ Date policy: OK")

    # Overlap check
    try:
        start_dt = datetime.combine(s_date, time_type.min).replace(tzinfo=timezone.utc)
        end_dt = datetime.combine(e_date, time_type.max).replace(tzinfo=timezone.utc)
        overlap = await db["leave_requests"].find_one({
            "user_id": to_oid(user_id),
            "status": {"$in": ["PENDING", "APPROVED"]},
            "deleted_on": None,
            "start_datetime": {"$lt": end_dt},
            "end_datetime": {"$gt": start_dt},
        })
        if overlap:
            issues.append("An overlapping PENDING/APPROVED request already exists.")
            report.append(
                f"❌ Overlaps: Conflict found (ID: {overlap['_id']}, Status: {overlap['status']})"
            )
        else:
            report.append("✅ Overlaps: None found")
    except Exception as exc:
        report.append(f"⚠️  Overlaps: Could not check — {exc}")

    # Balance from tracker
    if leave_type.get("deduct_from_balance", True):
        available_hours = await get_balance_from_tracker(db, user_id, leave_type_id) or 0.0
        balance_days = available_hours / 8.0 if unit == "DAYS" else available_hours
        if duration_days > balance_days:
            shortfall = duration_days - balance_days
            issues.append(
                f"Insufficient balance: {balance_days:.2f} available, "
                f"{duration_days:.2f} required (shortfall: {shortfall:.2f})."
            )
            report.append(
                f"⚠️  Balance: INSUFFICIENT\n"
                f"   Available : {balance_days:.2f} day(s)\n"
                f"   Required  : {duration_days:.2f} day(s)\n"
                f"   Shortfall : {shortfall:.2f} day(s)\n"
                f"   → Apply as Loss of Pay (LOP)? Risk level will be HIGH."
            )
        else:
            report.append(
                f"✅ Balance: Sufficient — {balance_days:.2f} day(s) available, "
                f"{duration_days:.2f} requested"
            )
    else:
        report.append("ℹ️  Balance: Not tracked for this leave type")

    if issues:
        bullet_issues = "\n".join(f"  • {i}" for i in issues)
        summary = f"\n⚠️  {len(issues)} issue(s) found:\n{bullet_issues}"
    else:
        summary = "\n✅ All checks passed. You may call apply_leave."

    return "\n".join(report) + summary


# ─── 8. Apply leave ───────────────────────────────────────────────────────────

@tool
async def apply_leave(
    config: RunnableConfig,
    leave_type_id: str,
    start_date: str,
    end_date: str,
    reason: str = "",
    duration_mode: str = "FULL_DAYS",
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
    loss_of_pay: bool = False,
) -> str:
    """Submit a leave request for the current user.

    Call check_leave_eligibility first and only proceed when it passes
    (or the user explicitly agrees to LOP for an insufficient-balance case).

    Args:
        leave_type_id: Leave type ID (from fetch_leave_types).
        start_date: ISO date string (e.g. 2026-05-01).
        end_date: ISO date string (e.g. 2026-05-03).
        reason: Employee's reason for the leave.
        duration_mode: FULL_DAYS (default), HALF_DAY, or CUSTOM.
        half_day_period: FIRST_HALF or SECOND_HALF — required for HALF_DAY mode.
        start_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
        end_session: FIRST_HALF or SECOND_HALF — required for CUSTOM mode.
        loss_of_pay: Set True only when the user explicitly agrees to LOP.
    """
    db = get_db()
    user_id = _require_user_id(config)

    try:
        s_date = date_type.fromisoformat(start_date)
        e_date = date_type.fromisoformat(end_date)
    except ValueError as exc:
        return f"Invalid date format — use ISO date (e.g. 2026-05-01). Detail: {exc}"

    leave_type = await db["leave_types"].find_one({"_id": to_oid(leave_type_id), "deleted_on": None})
    if not leave_type:
        return "Leave type not found. Call fetch_leave_types to get valid IDs."

    unit = leave_type.get("unit", "DAYS")

    # Duration for risk tag
    duration_days = 0.0
    try:
        estimate = await leave_service.estimate_leave_duration(
            db,
            employee_id=user_id,
            leave_type_id=leave_type_id,
            start_date_str=start_date,
            end_date_str=end_date,
            duration_mode=duration_mode,
            half_day_period=half_day_period,
            start_session=start_session,
            end_session=end_session,
        )
        duration_days = estimate["estimated_days"]
    except Exception:
        pass

    # Balance for LOP annotation
    balance_days = 0.0
    if loss_of_pay and leave_type.get("deduct_from_balance", True):
        available_hours = await get_balance_from_tracker(db, user_id, leave_type_id) or 0.0
        balance_days = available_hours / 8.0 if unit == "DAYS" else available_hours

    if loss_of_pay or duration_days > 3:
        risk = "HIGH"
    elif round(duration_days) == 2:
        risk = "MEDIUM"
    else:
        risk = "LOW"

    lop_suffix = (
        f" | LOP — {balance_days:.2f} day(s) available, {duration_days:.2f} requested"
    ) if loss_of_pay else ""
    risk_tag = f"[RISK:{risk}{lop_suffix}]"
    full_note = f"{risk_tag} {reason.strip()}".strip()[:_MAX_REASON]

    try:
        payload = LeaveRequestCreate(
            leave_type_id=leave_type_id,
            start_date=s_date,
            end_date=e_date,
            duration_mode=DurationMode(duration_mode),
            half_day_period=SessionHalf(half_day_period) if half_day_period else None,
            start_session=SessionHalf(start_session) if start_session else None,
            end_session=SessionHalf(end_session) if end_session else None,
            reason=full_note,
        )
        doc = await leave_service.create_leave_request(db, payload, user_id, loss_of_pay=loss_of_pay)
        return (
            f"Leave request submitted.\n"
            f"Request ID : {doc['_id']}\n"
            f"Duration   : {doc['duration_hours']:.2f} hours  ({doc['duration_days']:.2f} day(s))\n"
            f"Status     : {doc['status']}\n"
            f"Risk level : {risk}"
        )
    except DomainException as exc:
        return f"Could not submit leave request: {exc.message}"
    except Exception as exc:
        return f"Unexpected error submitting leave: {exc}"


# ─── 9. List my leave requests ────────────────────────────────────────────────

@tool
async def list_my_leave_requests(
    config: RunnableConfig,
    status: Optional[str] = None,
) -> str:
    """List leave requests submitted by the current user.

    Args:
        status: Optional filter — PENDING, APPROVED, REJECTED, CANCELLED.
                Omit to return all.
    """
    db = get_db()
    user_id = _require_user_id(config)

    try:
        requests = await leave_service.list_my_leave_requests(
            db, user_id=user_id, status_filter=status.upper() if status else None
        )
    except Exception as exc:
        return f"Unexpected error listing leave requests: {exc}"

    if not requests:
        return "No leave requests found."

    lines = []
    for r in requests:
        lines.append(
            f"- ID: {r['_id']}  Status: {r['status']}  "
            f"From: {r.get('start_date')}  To: {r.get('end_date')}  "
            f"Duration: {r.get('duration_hours', '?')}h  "
            f"Type: {r.get('leave_type_id', '?')}"
        )
    return "\n".join(lines)


# ─── 10. Get leave request details ────────────────────────────────────────────

@tool
async def get_leave_request_details(
    config: RunnableConfig,
    request_id: str,
) -> str:
    """Get full details of a specific leave request, including manager info and activity timeline.

    Args:
        request_id: The leave request ID (from list_my_leave_requests).
    """
    db = get_db()
    _require_user_id(config)

    try:
        doc = await leave_service.get_leave_request_detail(db, request_id)
    except DomainException as exc:
        return f"Error: {exc.message}"
    except Exception as exc:
        return f"Unexpected error: {exc}"

    lines = [
        f"Request ID    : {doc['_id']}",
        f"Leave type    : {doc.get('leave_type_id')}",
        f"From          : {doc.get('start_date')}",
        f"To            : {doc.get('end_date')}",
        f"Duration      : {doc.get('duration_hours')} hours ({doc.get('duration_days')} days)",
        f"Mode          : {doc.get('duration_mode', 'FULL_DAYS')}",
        f"Status        : {doc.get('status')}",
        f"Approval level: {doc.get('approval_state', {}).get('current_level', 'N/A')}",
        f"Reason        : {doc.get('reason') or '—'}",
    ]

    l1 = doc.get("l1_manager")
    l2 = doc.get("l2_manager")
    if l1:
        lines.append(f"L1 Manager    : {l1.get('name')} (ID: {l1.get('id')})")
    if l2:
        lines.append(f"L2 Manager    : {l2.get('name')} (ID: {l2.get('id')})")

    timeline = doc.get("approval_timeline") or []
    if timeline:
        lines.append("Timeline:")
        for entry in timeline:
            ts = entry.get("timestamp", "")
            if hasattr(ts, "isoformat"):
                ts = ts.isoformat()
            actor = entry.get("actor_name") or entry.get("actor_id", "?")
            comment = f" — {entry['comment']}" if entry.get("comment") else ""
            level = f" (level {entry['level']})" if entry.get("level") is not None else ""
            lines.append(f"  • {entry['action']}{level} by {actor} at {ts}{comment}")

    return "\n".join(lines)


# ─── 11. Cancel / withdraw a leave request ────────────────────────────────────

@tool
async def cancel_leave(
    config: RunnableConfig,
    request_id: str,
) -> str:
    """Cancel (withdraw) one of the current user's own PENDING leave requests.

    Only PENDING requests can be cancelled. Use list_my_leave_requests to find
    the request ID. To modify dates or leave type, cancel the existing request
    and use apply_leave to submit a corrected one.

    Args:
        request_id: The leave request ID to cancel.
    """
    db = get_db()
    user_id = _require_user_id(config)

    try:
        await leave_service.cancel_leave_request(db, request_id, user_id)
        return f"Leave request {request_id} has been withdrawn successfully."
    except DomainException as exc:
        return f"Could not cancel request: {exc.message}"
    except Exception as exc:
        return f"Unexpected error: {exc}"


# ─── 12. List pending approvals (manager) ────────────────────────────────────

@tool
async def list_pending_approvals(config: RunnableConfig) -> str:
    """List PENDING leave requests from your direct reports that await your approval.

    Use this when acting as a manager: "show me pending approvals",
    "what leaves are waiting for my review?", "which requests need my action?".
    Returns requests from employees whose l1 or l2 manager is the current user.
    """
    db = get_db()
    user_id = _require_user_id(config)

    try:
        docs = await _manager_list_pending_approvals(db, user_id)
    except Exception as exc:
        return f"Unexpected error listing pending approvals: {exc}"

    if not docs:
        return "No leave requests are currently pending your approval."

    lines = []
    for r in docs:
        reason = r.get("reason") or ""
        risk_tag = ""
        if reason.startswith("[RISK:"):
            risk_tag = reason[: reason.index("]") + 1] + "  "
        lines.append(
            f"- ID: {r['_id']}  "
            f"From: {r.get('start_date')}  To: {r.get('end_date')}  "
            f"Duration: {r.get('duration_hours')}h  "
            f"{risk_tag}Status: {r['status']}"
        )
    return "\n".join(lines)


# ─── 13. Approve leave (manager) ─────────────────────────────────────────────

@tool
async def approve_leave(
    config: RunnableConfig,
    request_id: str,
    comment: str = "",
) -> str:
    """Approve a pending leave request from one of your direct reports.

    Only works for employees you directly manage (l1 or l2 manager).
    Call list_pending_approvals first if you don't have the request ID.

    Args:
        request_id: The leave request ID to approve.
        comment: Optional comment to attach to the approval decision.
    """
    db = get_db()
    user_id = _require_user_id(config)

    try:
        payload = ApprovalActionPayload(comment=comment or None)
        doc = await approve_managed_leave_request(db, request_id, user_id, payload)
        return f"Leave request {request_id} approved. Final status: {doc['status']}."
    except DomainException as exc:
        return f"Could not approve: {exc.message}"
    except Exception as exc:
        return f"Unexpected error: {exc}"


# ─── 14. Reject leave (manager) ──────────────────────────────────────────────

@tool
async def reject_leave(
    config: RunnableConfig,
    request_id: str,
    comment: str = "",
) -> str:
    """Reject a pending leave request from one of your direct reports.

    Only works for employees you directly manage (l1 or l2 manager).
    A comment is strongly recommended, especially for LOP or high-risk requests.

    Args:
        request_id: The leave request ID to reject.
        comment: Reason for rejection (recommended).
    """
    db = get_db()
    user_id = _require_user_id(config)

    try:
        payload = ApprovalActionPayload(comment=comment or None)
        doc = await reject_managed_leave_request(db, request_id, user_id, payload)
        return f"Leave request {request_id} rejected. Final status: {doc['status']}."
    except DomainException as exc:
        return f"Could not reject: {exc.message}"
    except Exception as exc:
        return f"Unexpected error: {exc}"


# ─── Registry ────────────────────────────────────────────────────────────────

TOOLS: list[BaseTool] = [
    fetch_leave_types,
    fetch_leave_balance,
    fetch_leave_plan,
    fetch_holiday_plan,
    fetch_current_leave_status,
    fetch_leaves,
    check_leave_eligibility,
    apply_leave,
    list_my_leave_requests,
    get_leave_request_details,
    cancel_leave,
    list_pending_approvals,
    approve_leave,
    reject_leave,
]
