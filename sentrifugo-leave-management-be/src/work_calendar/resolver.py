from datetime import date
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.utils import to_oid
from src.work_calendar.service import (
    BU_MAP_COLLECTION,
    CALENDAR_COLLECTION,
    DEPT_MAP_COLLECTION,
    EMP_MAP_COLLECTION,
)


def get_week_of_month(target_date: date) -> int:
    """Return 1..5 for the week of month, Mon-anchored (matches HLD §4 weekend_matrix keys)."""
    first_of_month = target_date.replace(day=1)
    first_offset = first_of_month.weekday()
    adjusted_day = target_date.day + first_offset - 1
    return min(adjusted_day // 7 + 1, 5)


def get_day_of_week_index(target_date: date) -> int:
    """Mon=0 .. Sun=6 — matches the weekend_matrix row layout."""
    return target_date.weekday()


def _parse_iso_date(value) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


async def _fetch_active_calendar(
    db: AsyncIOMotorDatabase, calendar_id: str
) -> Optional[dict]:
    return await db[CALENDAR_COLLECTION].find_one(
        {"_id": to_oid(calendar_id), "is_active": True, "deleted_on": None}
    )


async def _load_employee_context(
    db: AsyncIOMotorDatabase, user_id: str
) -> dict:
    doc = await db["employees"].find_one(
        {"user_id": to_oid(user_id), "is_deleted": {"$ne": True}}
    )
    return doc or {}


async def _resolve_holiday_plan_id(
    db: AsyncIOMotorDatabase, user_id: str
) -> Optional[object]:
    """Return the single holiday plan an employee is assigned to, or ``None``.

    Membership lives in ``holiday_plan_employees`` and is unique per employee (a
    cross-scope rule rejects assigning anyone to a second plan), so a holiday
    plan is the analogue of the one work calendar an employee resolves to.
    Soft-deleted assignments use ``deleted_on`` (there is no ``is_deleted`` flag).
    """
    doc = await db["holiday_plan_employees"].find_one(
        {
            "user_id": {"$in": [to_oid(user_id), str(user_id)]},
            "deleted_on": None,
        },
        {"plan_id": 1},
    )
    return doc.get("plan_id") if doc else None


async def resolve_calendar(
    db: AsyncIOMotorDatabase,
    user_id: str,
    target_date: date,
    department_id: Optional[str] = None,
    business_unit_id: Optional[str] = None,
    org_id: Optional[str] = None,
) -> Optional[dict]:
    """Resolve the active work calendar for an employee on a given date.

    Priority (HLD §6):
        1. Employee override (within effective window)
        2. Department mapping
        3. Business unit mapping
        4. Default calendar (is_default=True)
    """
    iso_date = target_date.isoformat()

    # The employee→calendar assignment lives in work_calendar_employees, keyed by
    # user_id (ObjectId) with NO effective_from/effective_to on the real docs. The
    # old query required effective_from and matched user_id as a raw string, so it
    # NEVER matched a real assignment — every employee silently fell through to the
    # default calendar, even though the FE (get_employee_work_calendar) shows the
    # assigned one. Match user_id in both forms, ignore soft-deleted rows, and honour
    # an effective window ONLY when those fields are present (forward-compat).
    override = await db[EMP_MAP_COLLECTION].find_one(
        {
            "user_id": {"$in": [to_oid(user_id), str(user_id)]},
            "deleted_on": None,
            "$and": [
                {"$or": [
                    {"effective_from": {"$exists": False}},
                    {"effective_from": None},
                    {"effective_from": {"$lte": iso_date}},
                ]},
                {"$or": [
                    {"effective_to": {"$exists": False}},
                    {"effective_to": None},
                    {"effective_to": {"$gte": iso_date}},
                ]},
            ],
        },
        sort=[("effective_from", -1)],
    )
    if override:
        cal = await _fetch_active_calendar(db, override["work_calendar_id"])
        if cal:
            return cal

    if not (department_id and business_unit_id and org_id):
        emp = await _load_employee_context(db, user_id)
        department_id = department_id or emp.get("department_id")
        business_unit_id = business_unit_id or emp.get("business_unit_id")
        # Employees store the org under ``organisation_id`` (``org_id`` is always
        # absent). Reading the wrong field left org_id None, so the default-calendar
        # query below ran UNSCOPED — in a multi-org DB that resolves an arbitrary
        # org's default calendar. Prefer organisation_id, keep org_id as a fallback.
        org_id = org_id or emp.get("organisation_id") or emp.get("org_id")

    if department_id:
        dept_map = await db[DEPT_MAP_COLLECTION].find_one(
            {"department_id": department_id}
        )
        if dept_map:
            cal = await _fetch_active_calendar(db, dept_map["calendar_id"])
            if cal:
                return cal

    if business_unit_id:
        bu_map = await db[BU_MAP_COLLECTION].find_one(
            {"business_unit_id": business_unit_id}
        )
        if bu_map:
            cal = await _fetch_active_calendar(db, bu_map["calendar_id"])
            if cal:
                return cal

    query: dict = {"is_default": True, "is_active": True, "deleted_on": None}
    if org_id:
        query["org_id"] = to_oid(org_id) if isinstance(org_id, str) else org_id
    return await db[CALENDAR_COLLECTION].find_one(query)


async def _is_holiday(
    db: AsyncIOMotorDatabase,
    calendar: dict,
    target_date: date,
    business_unit_id: Optional[str],
    department_id: Optional[str],
    plan_id: Optional[object] = None,
) -> Optional[dict]:
    """The holiday doc that applies to this employee on ``target_date``, else None.

    Returns the document rather than a bool so callers can name the holiday —
    "15 Aug 2026 is a holiday (Independence Day)" is far more useful than
    "…is a holiday". Truthiness is unchanged for boolean callers.
    """
    query: dict = {
        "date": target_date.isoformat(),
        # Holidays are soft-deleted via the ``deleted_on`` audit field — there is
        # no ``is_deleted`` flag — so "live" means ``deleted_on is None``. (The old
        # ``is_deleted: False`` filter matched no real holiday at all, silently
        # disabling holiday handling everywhere.)
        "deleted_on": None,
    }
    if plan_id is not None:
        # An org can run several holiday plans; the employee belongs to exactly
        # ONE. Constrain to that plan so holidays from OTHER plans never count.
        # Match both ObjectId and string forms defensively.
        query["plan_id"] = {"$in": [plan_id, str(plan_id)]}
    else:
        # No explicit plan assignment for this employee. Fall back to an org-wide
        # match (by the resolved calendar's org) so a single-plan org that hasn't
        # populated ``holiday_plan_employees`` still gets its holidays. Match
        # org_id in both ObjectId and string form — a type mismatch must never
        # silently hide every holiday.
        org_id = calendar.get("org_id")
        org_values = [org_id]
        if org_id is not None:
            try:
                org_values = [to_oid(org_id), str(org_id)]
            except Exception:
                org_values = [org_id, str(org_id)]
        query["org_id"] = {"$in": org_values}
    doc = await db["holidays"].find_one(query)
    if not doc:
        return None
    # Dept scope: an empty list means "applies to every department". Stored IDs are
    # ObjectIds while callers pass strings, so compare on the normalized string form.
    applicable_depts = {str(d) for d in (doc.get("applicable_department_ids") or [])}
    if applicable_depts and department_id and str(department_id) not in applicable_depts:
        return None
    # BU scope: the canonical field is the plural ``business_unit_ids`` (list of
    # ObjectIds); fall back to the legacy singular ``business_unit_id``.
    holiday_bus = doc.get("business_unit_ids")
    if not holiday_bus and doc.get("business_unit_id") is not None:
        holiday_bus = [doc["business_unit_id"]]
    holiday_bu_set = {str(b) for b in (holiday_bus or [])}
    if holiday_bu_set and business_unit_id and str(business_unit_id) not in holiday_bu_set:
        return None
    return doc


async def is_working_day(
    db: AsyncIOMotorDatabase,
    user_id: str,
    target_date: date,
    department_id: Optional[str] = None,
    business_unit_id: Optional[str] = None,
    org_id: Optional[str] = None,
) -> dict:
    """Return working-day decision for an employee on a given date (HLD §7)."""
    calendar = await resolve_calendar(
        db,
        user_id=user_id,
        target_date=target_date,
        department_id=department_id,
        business_unit_id=business_unit_id,
        org_id=org_id,
    )

    result = {
        "user_id": user_id,
        "date": target_date,
        "is_working_day": True,
        "is_holiday": False,
        "is_weekend": False,
        # Raw weekend-matrix membership, independent of holiday precedence below.
        # ``is_weekend`` is suppressed when a day is ALSO a holiday (holiday wins for
        # the reason), so consumers that need to know "is this date a weekend slot?"
        # regardless of a coinciding holiday must read this instead.
        "is_weekend_slot": False,
        # Name of the holiday when is_holiday is True, so callers can say which
        # one rather than just "a holiday".
        "holiday_name": None,
        "calendar_id": str(calendar["_id"]) if calendar else None,
        "reason": None,
    }

    if not calendar:
        result.update(is_working_day=False, reason="NO_CALENDAR_RESOLVED")
        return result

    cal_start = _parse_iso_date(calendar.get("start_date"))
    cal_end = _parse_iso_date(calendar.get("end_date"))
    if cal_start and target_date < cal_start:
        result.update(is_working_day=False, reason="DATE_BEFORE_CALENDAR_PERIOD")
        return result
    if cal_end and target_date > cal_end:
        result.update(is_working_day=False, reason="DATE_AFTER_CALENDAR_PERIOD")
        return result

    # Resolve weekend-matrix membership first so we can record it even when a
    # holiday coincides (holiday precedence below would otherwise hide it).
    week_key = str(get_week_of_month(target_date))
    day_idx = get_day_of_week_index(target_date)
    matrix = calendar.get("weekend_matrix") or {}
    row = matrix.get(week_key)
    is_weekend_slot = bool(row and len(row) == 7 and row[day_idx] == 0)
    result["is_weekend_slot"] = is_weekend_slot

    # An employee belongs to exactly ONE holiday plan, and an org can run several
    # plans, so resolve THIS employee's plan and count only its holidays. Holidays
    # within a plan can be further scoped by BU/department; callers (e.g. leave
    # validation) usually pass only ``user_id``, so resolve the employee's BU/dept
    # too — otherwise a BU-scoped holiday would wrongly count for everyone.
    holiday_bu, holiday_dept = business_unit_id, department_id
    if holiday_bu is None or holiday_dept is None:
        emp = await _load_employee_context(db, user_id)
        holiday_bu = holiday_bu or emp.get("business_unit_id")
        holiday_dept = holiday_dept or emp.get("department_id")
    holiday_plan_id = await _resolve_holiday_plan_id(db, user_id)
    holiday_doc = await _is_holiday(
        db, calendar, target_date, holiday_bu, holiday_dept, holiday_plan_id
    )
    if holiday_doc:
        result.update(
            is_working_day=False,
            is_holiday=True,
            holiday_name=holiday_doc.get("name"),
            reason="HOLIDAY",
        )
        return result

    if is_weekend_slot:
        result.update(is_working_day=False, is_weekend=True, reason="WEEKEND")
        return result

    return result
