import io
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from src.bulk_utils import generate_employee_template_xlsx, parse_employee_rows, validate_bulk_rows
from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.holiday_plan_employees.schemas import (
    HolidayPlanEmployeeSync,
    HolidayPlanEmployeeEntry,
    HolidayPlanEmployeesByDepartments,
)
from src.holiday_plan_employees.service import (
    _assert_plan_active,
    add_employees,
    add_employees_by_departments,
    cross_plan_assignments,
    list_employees,
    sync_employees,
    sync_employees_by_departments,
)
from src.employees.schemas import CrossAssignmentList
from src.utils import to_oid

router = APIRouter(tags=["holiday-plan-employees"])


@router.get(
    "/holiday-plans/{plan_id}/employees",
    response_model=list[HolidayPlanEmployeeEntry],
)
async def get_plan_employees(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[HolidayPlanEmployeeEntry]:
    docs = await list_employees(db, plan_id)
    return [HolidayPlanEmployeeEntry(**d) for d in docs]


@router.get(
    "/holiday-plans/{plan_id}/employees/cross-assignments",
    response_model=CrossAssignmentList,
)
async def get_plan_cross_assignments(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> CrossAssignmentList:
    return CrossAssignmentList(**await cross_plan_assignments(db, plan_id))


@router.put("/holiday-plans/{plan_id}/employees")
async def sync_plan_employees(
    plan_id: str,
    payload: HolidayPlanEmployeeSync,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await sync_employees(
        db, plan_id, payload.user_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.get("/holiday-plans/{plan_id}/employees/bulk-template")
async def download_bulk_template(
    plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    content = generate_employee_template_xlsx()
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="employee_template_{plan_id}.xlsx"'},
    )


@router.post("/holiday-plans/{plan_id}/employees/bulk-validate")
async def validate_bulk_upload(
    plan_id: str,
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
):
    # Tenant guard: only return the plan if it belongs to the caller's org.
    # If a user sends a plan_id from a different tenant, this returns 404 —
    # they can never reach into another organisation's data.
    plan_query = {"_id": to_oid(plan_id), "deleted_on": None}
    if current_user and current_user.org_id:
        plan_query["org_id"] = {"$in": [to_oid(current_user.org_id), str(current_user.org_id)]}
    plan = await db["holiday_plans"].find_one(plan_query)
    if not plan:
        raise HTTPException(status_code=404, detail="Holiday plan not found")

    # Reject bulk-validate against an inactive plan — the user cannot assign
    # employees to it anyway, so don't waste their time parsing the file.
    _assert_plan_active(plan)

    dept_ids = [to_oid(d) for d in (plan.get("department_ids") or [])]

    file_bytes = await file.read()
    parsed_rows = parse_employee_rows(file_bytes)

    if not parsed_rows:
        return {
            "total_rows": 0, "valid_count": 0, "error_count": 0, "duplicate_count": 0,
            "rows": [],
            "file_errors": ["No data found. Ensure the file has 'work_email' and/or 'emp_code' column headers."],
        }

    result = await validate_bulk_rows(
        db, parsed_rows,
        eligible_dept_ids=dept_ids,
        assigned_collection="holiday_plan_employees",
        assigned_id_field="plan_id",
        assigned_id_value=to_oid(plan_id),
        scope_name_collection="holiday_plans",
        scope_label="holiday plan",
        # org_id comes from the authenticated session (not from the plan doc),
        # so even if a (now-impossible) cross-tenant request slipped through,
        # cross-scope detection still tenant-scopes correctly.
        org_id=current_user.org_id if current_user else None,
    )
    result["file_errors"] = []
    return result


@router.post("/holiday-plans/{plan_id}/employees/bulk-assign")
async def bulk_assign_employees(
    plan_id: str,
    payload: HolidayPlanEmployeeSync,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await add_employees(
        db, plan_id, payload.user_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.post("/holiday-plans/{plan_id}/employees/sync-by-departments")
async def sync_plan_employees_by_departments(
    plan_id: str,
    payload: HolidayPlanEmployeesByDepartments,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await sync_employees_by_departments(
        db, plan_id, payload.department_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.post("/holiday-plans/{plan_id}/employees/assign-by-departments")
async def assign_plan_employees_by_departments(
    plan_id: str,
    payload: HolidayPlanEmployeesByDepartments,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await add_employees_by_departments(
        db, plan_id, payload.department_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
