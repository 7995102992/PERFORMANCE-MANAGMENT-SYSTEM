from typing import Optional

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_activity, emit_audit
from src.exceptions import DomainException
from src.leave_plan_assignments.schemas import LeavePlanAssignmentCreate
from src.logger import logger
from src.models import audit_fields_create
from src.utils import to_oid

ASSIGNMENTS_COLLECTION = "leave_plan_assignments"
EMPLOYEE_PLAN_COLLECTION = "employee_leave_plans"


async def _get_leave_plan(db: AsyncIOMotorDatabase, plan_id: str) -> dict:
    doc = await db["leave_plans"].find_one({"_id": to_oid(plan_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Leave plan not found",
            code="LEAVE_PLAN_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def create_assignment(
    db: AsyncIOMotorDatabase, payload: LeavePlanAssignmentCreate, created_by: str
) -> list[dict]:
    plan = await _get_leave_plan(db, payload.leave_plan_id)
    org_id = plan.get("org_id")

    if payload.scope_type in ("BU", "DEPARTMENT") and not payload.business_unit_id:
        raise DomainException(
            message="business_unit_id is required for BU and DEPARTMENT scope",
            code="MISSING_BUSINESS_UNIT",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if payload.business_unit_id:
        bu_exists = await db["business_units"].find_one(
            {"_id": to_oid(payload.business_unit_id), "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
        )
        if not bu_exists:
            # The scoped lookup failed (wrong org / deleted / missing). Resolve
            # the name loosely so the user sees it instead of a raw ObjectId.
            bu_doc = await db["business_units"].find_one(
                {"_id": to_oid(payload.business_unit_id)}, {"name": 1}
            )
            bu_name = (bu_doc or {}).get("name")
            logger.warning(
                "Business unit not found for assignment",
                business_unit_id=payload.business_unit_id,
                plan_id=payload.leave_plan_id,
            )
            raise DomainException(
                message=(
                    f"Business unit '{bu_name}' not found"
                    if bu_name
                    else "Selected business unit not found"
                ),
                code="INVALID_BUSINESS_UNIT",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    department_ids = list(payload.department_ids or [])

    if payload.apply_to_whole_bu and payload.business_unit_id:
        bu_oid = to_oid(payload.business_unit_id)
        all_depts = await db["departments"].find(
            {
                "$or": [
                    {"business_unit_id": bu_oid},
                    {"business_unit_ids": bu_oid},
                ],
                "is_deleted": {"$ne": True},
            },
            {"_id": 1},
        ).to_list(length=None)
        department_ids = [str(d["_id"]) for d in all_depts]

        if not department_ids:
            raise DomainException(
                message="No departments found for this business unit",
                code="NO_DEPARTMENTS_FOUND",
                status_code=status.HTTP_404_NOT_FOUND,
            )

    if department_ids:
        if not payload.apply_to_whole_bu:
            for dept_id in department_ids:
                dept_exists = await db["departments"].find_one(
                    {"_id": to_oid(dept_id), "org_id": to_oid(org_id), "is_deleted": {"$ne": True}}
                )
                if not dept_exists:
                    dept_doc = await db["departments"].find_one(
                        {"_id": to_oid(dept_id)}, {"name": 1}
                    )
                    dept_name = (dept_doc or {}).get("name")
                    logger.warning(
                        "Department not found for assignment",
                        department_id=dept_id,
                        plan_id=payload.leave_plan_id,
                    )
                    raise DomainException(
                        message=(
                            f"Department '{dept_name}' not found"
                            if dept_name
                            else "Selected department not found"
                        ),
                        code="INVALID_DEPARTMENT",
                        status_code=status.HTTP_400_BAD_REQUEST,
                    )

        # Reject only if a department is already assigned to a different ACTIVE plan.
        # Assignments under pending/inactive plans do not block new assignments.
        active_plan_ids = [
            p["_id"]
            for p in await db["leave_plans"].find(
                {
                    "is_active": True,
                    "deleted_on": None,
                    "_id": {"$ne": to_oid(payload.leave_plan_id)},
                },
                {"_id": 1},
            ).to_list(length=None)
        ]

        conflicting = []
        if active_plan_ids:
            for dept_id in department_ids:
                cross_plan = await db[ASSIGNMENTS_COLLECTION].find_one(
                    {
                        "scope_type": "DEPARTMENT",
                        "business_unit_id": to_oid(payload.business_unit_id),
                        "department_id": to_oid(dept_id),
                        "leave_plan_id": {"$in": active_plan_ids},
                        "deleted_on": None,
                    }
                )
                if cross_plan:
                    conflicting.append(dept_id)

        if conflicting:
            dept_docs = await db["departments"].find(
                {"_id": {"$in": [to_oid(d) for d in conflicting]}}, {"name": 1}
            ).to_list(length=None)
            names = [d.get("name") or str(d["_id"]) for d in dept_docs] or conflicting
            raise DomainException(
                message=(
                    f"The following department(s) are already assigned to an active leave plan "
                    f"and cannot be reassigned: {', '.join(names)}"
                ),
                code="DEPARTMENT_ALREADY_ASSIGNED",
                status_code=status.HTTP_409_CONFLICT,
            )

        created_docs = []
        for dept_id in department_ids:
            existing = await db[ASSIGNMENTS_COLLECTION].find_one(
                {
                    "leave_plan_id": to_oid(payload.leave_plan_id),
                    "scope_type": "DEPARTMENT",
                    "business_unit_id": to_oid(payload.business_unit_id),
                    "department_id": to_oid(dept_id),
                    "deleted_on": None,
                }
            )
            if existing:
                continue

            doc = {
                "leave_plan_id": to_oid(payload.leave_plan_id),
                "scope_type": "DEPARTMENT",
                "business_unit_id": to_oid(payload.business_unit_id),
                "department_id": to_oid(dept_id),
                "priority": payload.priority,
                "is_active": True,
                **audit_fields_create(created_by),
            }
            result = await db[ASSIGNMENTS_COLLECTION].insert_one(doc)
            doc["_id"] = result.inserted_id
            logger.info(
                "Leave plan assignment created",
                assignment_id=doc["_id"],
                scope_type="DEPARTMENT",
                plan_id=payload.leave_plan_id,
                department_id=dept_id,
            )
            created_docs.append(doc)

        if not created_docs:
            raise DomainException(
                message="All selected departments already have an assignment for this plan",
                code="DUPLICATE_ASSIGNMENT",
                status_code=status.HTTP_409_CONFLICT,
            )

        audit_kwargs = dict(
            action="leave_plan_assignment.assigned",
            resource=f"leave_plan:{payload.leave_plan_id}",
            actor_id=created_by,
            organisation_id=str(org_id) if org_id else None,
            details={
                "scope_type": "DEPARTMENT",
                "count": len(created_docs),
                "assignment_ids": [str(d["_id"]) for d in created_docs],
                "department_ids": [str(d["department_id"]) for d in created_docs],
            },
        )
        await emit_activity(**audit_kwargs)
        await emit_audit(**audit_kwargs)
        return created_docs

    # BU-level or ORG-level assignment
    query: dict = {
        "leave_plan_id": to_oid(payload.leave_plan_id),
        "scope_type": payload.scope_type,
        "deleted_on": None,
    }
    if payload.business_unit_id:
        query["business_unit_id"] = to_oid(payload.business_unit_id)

    existing = await db[ASSIGNMENTS_COLLECTION].find_one(query)
    if existing:
        raise DomainException(
            message="An assignment already exists for this scope and plan",
            code="DUPLICATE_ASSIGNMENT",
            status_code=status.HTTP_409_CONFLICT,
        )

    doc = {
        "leave_plan_id": to_oid(payload.leave_plan_id),
        "scope_type": payload.scope_type,
        "priority": payload.priority,
        "is_active": True,
        **audit_fields_create(created_by),
    }
    if payload.business_unit_id:
        doc["business_unit_id"] = to_oid(payload.business_unit_id)

    result = await db[ASSIGNMENTS_COLLECTION].insert_one(doc)
    doc["_id"] = result.inserted_id
    logger.info(
        "Leave plan assignment created",
        assignment_id=doc["_id"],
        scope_type=payload.scope_type,
        plan_id=payload.leave_plan_id,
    )
    audit_kwargs = dict(
        action="leave_plan_assignment.assigned",
        resource=f"leave_plan_assignment:{doc['_id']}",
        actor_id=created_by,
        organisation_id=str(org_id) if org_id else None,
        details={
            "scope_type": payload.scope_type,
            "leave_plan_id": str(payload.leave_plan_id),
        },
    )
    await emit_activity(**audit_kwargs)
    await emit_audit(**audit_kwargs)
    return [doc]


async def list_assignments(db: AsyncIOMotorDatabase, plan_id: str) -> list[dict]:
    await _get_leave_plan(db, plan_id)
    cursor = db[ASSIGNMENTS_COLLECTION].find(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
    ).sort("priority", 1)
    return await cursor.to_list(length=None)


async def resolve_employee_plan(
    db: AsyncIOMotorDatabase,
    user_id: str,
    org_id: str,
    department_id: Optional[str] = None,
    business_unit_id: Optional[str] = None,
) -> dict | None:
    """
    Resolve the leave plan for an employee by checking assignments for their
    department, then business unit, then org. Priority: DEPARTMENT > BU > ORG.
    Only considers assignments linked to active plans belonging to the org.

    The first id arg is the user_id (employees are keyed by user_id; every caller
    passes a user_id). Resolution is by org/dept/BU scope, with the employee's own
    dept/BU looked up when the caller does not supply them.
    """
    active_plans = await db["leave_plans"].find(
        {"org_id": to_oid(org_id), "is_active": True, "deleted_on": None}, {"_id": 1}
    ).to_list(length=None)
    if not active_plans:
        return None

    active_plan_ids = [p["_id"] for p in active_plans]

    # Fall back to the employee's own department / BU when the caller omitted
    # them. In-process callers all load the employee first and pass them in, but
    # the HTTP endpoint forwards its (usually absent) query params straight
    # through — and the FE only sends user_id + org_id. Without this, the only
    # scope tried is ORG, so an org whose assignments are all DEPARTMENT-scoped
    # resolved to nothing and every employee was told "no leave plan is assigned
    # to you yet" even though submitting a request worked fine.
    if department_id is None or business_unit_id is None:
        uid = to_oid(user_id)
        emp = await db["employees"].find_one(
            {"user_id": {"$in": [uid, str(uid)]}},
            {"department_id": 1, "business_unit_id": 1},
        )
        if emp:
            if department_id is None and emp.get("department_id"):
                department_id = str(emp["department_id"])
            if business_unit_id is None and emp.get("business_unit_id"):
                business_unit_id = str(emp["business_unit_id"])

    scopes_to_try = []
    if department_id:
        dept_scope = {"scope_type": "DEPARTMENT", "department_id": to_oid(department_id)}
        # Match the BU too. A department can be shared across BUs, and every
        # DEPARTMENT assignment is scoped to a specific BU. Without this, an
        # employee in (BU-B, shared dept) would wrongly resolve to a plan
        # assigned to (BU-A, same dept). Mirrors the BU+dept scoping used by the
        # work calendar / holiday plan employee resolution.
        if business_unit_id:
            dept_scope["business_unit_id"] = to_oid(business_unit_id)
        scopes_to_try.append(dept_scope)
    if business_unit_id:
        scopes_to_try.append({"scope_type": "BU", "business_unit_id": to_oid(business_unit_id)})
    scopes_to_try.append({"scope_type": "ORG"})

    for scope_query in scopes_to_try:
        assignment = await db[ASSIGNMENTS_COLLECTION].find_one(
            {
                "leave_plan_id": {"$in": active_plan_ids},
                "is_active": True,
                "deleted_on": None,
                **scope_query,
            },
            sort=[("priority", 1)],
        )
        if assignment:
            logger.info(
                "Employee leave plan resolved",
                user_id=user_id,
                assignment_id=assignment["_id"],
                scope_type=assignment["scope_type"],
            )
            return {"leave_plan_id": assignment["leave_plan_id"], "assignment_id": assignment["_id"]}
    return None
