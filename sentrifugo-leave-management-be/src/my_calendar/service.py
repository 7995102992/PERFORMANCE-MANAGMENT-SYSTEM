from datetime import date

import asyncio

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.utils import to_oid


async def get_employee_calendar(
    db: AsyncIOMotorDatabase,
    user_id: str,
    org_id: str,
    from_str: str,
    to_str: str,
) -> dict:
    leaves, holidays = await asyncio.gather(
        _get_leaves(db, user_id, from_str, to_str),
        _get_holidays(db, user_id, org_id, from_str, to_str),
    )
    return {"leaves": leaves, "holidays": holidays}


async def get_my_calendar(
    db: AsyncIOMotorDatabase,
    user_id: str,
    org_id: str,
    from_date: date,
    to_date: date,
) -> dict:
    return await get_employee_calendar(
        db, user_id, org_id, from_date.isoformat(), to_date.isoformat()
    )


async def get_my_holidays(
    db: AsyncIOMotorDatabase,
    user_id: str,
    org_id: str,
    year: int,
) -> dict:
    """The holiday plan this employee is on, plus every holiday it grants them.

    Same scoping as the calendar strip (``_get_holidays``): only the holidays of
    the employee's own plan, filtered to the ones their BU / department is in
    scope for. An employee on no plan gets an empty list rather than an error, so
    the page can render a clean empty state.
    """
    assignment = await db["holiday_plan_employees"].find_one(
        {"user_id": to_oid(user_id), "deleted_on": None}
    )
    if not assignment:
        return {"plan_id": None, "plan_name": None, "year": year, "holidays": []}

    plan = await db["holiday_plans"].find_one(
        {"_id": to_oid(assignment["plan_id"]), "deleted_on": None}
    )
    holidays = await _get_holidays(
        db, user_id, org_id, f"{year}-01-01", f"{year}-12-31"
    )
    return {
        "plan_id": str(plan["_id"]) if plan else None,
        "plan_name": (plan or {}).get("name"),
        "year": year,
        "holidays": holidays,
    }


async def _get_leaves(
    db: AsyncIOMotorDatabase,
    user_id: str,
    from_str: str,
    to_str: str,
) -> list[dict]:
    user_oid = to_oid(user_id)

    pipeline = [
        {
            "$match": {
                "user_id": user_oid,
                "status": {"$in": ["PENDING", "APPROVED"]},
                "deleted_on": None,
                # Overlap: leave starts before range end AND ends after range start
                "start_date": {"$lte": to_str},
                "end_date": {"$gte": from_str},
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
        {
            "$addFields": {
                "leave_type_name": {"$arrayElemAt": ["$_lt.name", 0]},
                # Whether this leave is PAID. Payroll needs it to work out loss of pay:
                # approved casual or sick leave is paid and must not reduce salary, while
                # unpaid leave must. Without the flag the only alternative is guessing from
                # the type's NAME, and a rename would quietly start docking people's pay.
                # Defaults to True — a leave type with the flag unset is treated as paid,
                # so a missing value can never invent a deduction.
                "is_paid_leave": {"$ifNull": [{"$arrayElemAt": ["$_lt.is_paid_leave", 0]}, True]},
            }
        },
        {"$project": {"_lt": 0}},
        {"$sort": {"start_date": 1}},
    ]

    docs = await db["leave_requests"].aggregate(pipeline).to_list(length=None)

    result = []
    for doc in docs:
        result.append({
            "id": str(doc["_id"]),
            "leave_type_id": str(doc.get("leave_type_id", "")),
            "leave_type_name": doc.get("leave_type_name"),
            # Additive: existing consumers (timesheet) ignore both.
            "is_paid_leave": doc.get("is_paid_leave", True),
            # Set on the REQUEST when this particular absence is unpaid — most often
            # because the employee exhausted their balance on an otherwise-paid type. It is
            # independent of `is_paid_leave`: payroll must treat EITHER as loss of pay, or
            # it misses every over-balance absence, which is the common case.
            "loss_of_pay": bool(doc.get("loss_of_pay", False)),
            "start_date": doc.get("start_date"),
            "end_date": doc.get("end_date"),
            "duration_mode": doc.get("duration_mode"),
            "half_day_period": doc.get("half_day_period"),
            "start_session": doc.get("start_session"),
            "end_session": doc.get("end_session"),
            "duration_hours": doc.get("duration_hours", 0),
            "duration_days": doc.get("duration_days", 0),
            "status": doc.get("status"),
            "reason": doc.get("reason"),
        })
    return result


async def _get_holidays(
    db: AsyncIOMotorDatabase,
    user_id: str,
    org_id: str,
    from_str: str,
    to_str: str,
) -> list[dict]:
    user_oid = to_oid(user_id)

    assignment = await db["holiday_plan_employees"].find_one(
        {"user_id": user_oid, "deleted_on": None}
    )
    if not assignment:
        return []

    # The employee's BU / dept decide which of the plan's holidays actually apply to
    # them — a plan can carry holidays scoped to specific BUs/depts, and a holiday
    # the charging engine would NOT block must not be shown here either. Mirror
    # _is_holiday's scoping (resolver.py).
    emp = await db["employees"].find_one(
        {"user_id": user_oid}, {"business_unit_id": 1, "department_id": 1}
    )
    emp_bu = str(emp["business_unit_id"]) if emp and emp.get("business_unit_id") else None
    emp_dept = str(emp["department_id"]) if emp and emp.get("department_id") else None

    plan_oid = to_oid(assignment["plan_id"])
    org_oid = to_oid(org_id)

    pipeline = [
        {
            "$match": {
                "plan_id": plan_oid,
                "org_id": {"$in": [org_oid, str(org_id)]},
                "deleted_on": None,
                "date": {"$gte": from_str, "$lte": to_str},
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
        {"$project": {"_cls": 0}},
        {"$sort": {"date": 1}},
    ]

    docs = await db["holidays"].aggregate(pipeline).to_list(length=None)

    result = []
    for doc in docs:
        # Dept scope: empty list == applies to all depts. BU scope: canonical plural
        # business_unit_ids, legacy singular business_unit_id fallback. Skip a holiday
        # whose scope excludes this employee (matches the charging engine).
        depts = {str(d) for d in (doc.get("applicable_department_ids") or [])}
        if depts and emp_dept and emp_dept not in depts:
            continue
        holiday_bus = doc.get("business_unit_ids")
        if not holiday_bus and doc.get("business_unit_id") is not None:
            holiday_bus = [doc["business_unit_id"]]
        bu_set = {str(b) for b in (holiday_bus or [])}
        if bu_set and emp_bu and emp_bu not in bu_set:
            continue
        result.append({
            "id": str(doc["_id"]),
            "name": doc.get("name"),
            "date": doc.get("date"),
            "description": doc.get("description"),
            "classification_name": doc.get("classification_name"),
            "classification_color": doc.get("classification_color"),
        })
    return result
