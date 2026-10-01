import io
from datetime import date
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, status
from fastapi.responses import StreamingResponse

from src.bulk_utils import generate_employee_template_xlsx, parse_employee_rows, validate_bulk_rows
from src.database import get_db_session
from src.dependencies import UserBase, get_current_user
from src.exceptions import DomainException
from src.utils import to_oid
from src.work_calendar.resolver import is_working_day
from src.work_calendar.schemas import (
    CalendarPeriod,
    CalendarWorkWeek,
    EmployeeWorkCalendarResponse,
    WorkCalendarCreate,
    WorkCalendarEmployeeEntry,
    WorkCalendarEmployeeSync,
    WorkCalendarEmployeesByDepartments,
    WorkCalendarListItem,
    WorkCalendarResponse,
    WorkCalendarUpdate,
    WorkingDayResponse,
)
from src.work_calendar.service import (
    _assert_calendar_active,
    _get_calendar_or_raise,
    add_calendar_employees,
    create_calendar,
    cross_calendar_assignments,
    delete_calendar,
    get_calendar,
    get_employee_work_calendar,
    list_calendar_employees,
    list_calendars,
    sync_calendar_employees,
    sync_calendar_employees_by_departments,
    update_calendar,
)
from src.employees.schemas import CrossAssignmentList
from src.work_calendar.shifts_schemas import ShiftCreate, ShiftResponse, ShiftUpdate
from src.work_calendar.shifts_service import (
    SHIFT_COLLECTION,
    create_shift,
    delete_shift,
    get_shift,
    list_shifts_by_calendar,
    update_shift,
)
from src.work_calendar.shift_assignment_schemas import (
    ShiftAssignmentResponse,
    ShiftAssignmentSyncPayload,
    ShiftAssignmentSyncResult,
    ShiftAssignValidateResult,
)
from src.work_calendar.shift_assignment_service import (
    get_shift_assignments,
    sync_shift_assignments,
    bulk_assign_shift_employees,
    generate_shift_assignment_template,
    validate_shift_assignment_bulk,
)


router = APIRouter(tags=["work-calendar"])


def _require_org_id(user: UserBase) -> str:
    if not user.org_id:
        raise DomainException(
            message="Authenticated user is missing an org_id",
            code="MISSING_ORG_CONTEXT",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return user.org_id


@router.get("/work-calendars", response_model=list[WorkCalendarListItem])
async def list_all(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[WorkCalendarListItem]:
    org_id = _require_org_id(current_user)
    docs = await list_calendars(db, org_id)
    result = []
    for doc in docs:
        week_cfg = doc.get("week_config", {})
        result.append(
            WorkCalendarListItem(
                **{
                    "_id": doc["_id"],
                    "name": doc["name"],
                    "period": CalendarPeriod(
                        start=doc["start_date"],
                        end=doc["end_date"],
                    ),
                    "work_week": CalendarWorkWeek(
                        start=week_cfg.get("work_week_start", "MONDAY"),
                        end=week_cfg.get("work_week_end", "FRIDAY"),
                    ),
                    "status": "ACTIVE" if doc.get("is_active") else "INACTIVE",
                    "employee_count": doc.get("employee_count", 0),
                }
            )
        )
    return result


@router.post(
    "/work-calendars",
    response_model=WorkCalendarResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create(
    payload: WorkCalendarCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> WorkCalendarResponse:
    org_id = _require_org_id(current_user)
    doc = await create_calendar(db, payload, org_id, current_user.user_id)
    return WorkCalendarResponse(**doc)


@router.get(
    "/work-calendars/employee/{employee_id}",
    response_model=EmployeeWorkCalendarResponse,
    responses={404: {"description": "No work calendar found for employee"}},
)
async def get_employee_calendar(
    employee_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> EmployeeWorkCalendarResponse:
    org_id = _require_org_id(current_user)
    result = await get_employee_work_calendar(db, employee_id, org_id)
    if not result:
        raise DomainException(
            message="No work calendar found for this employee",
            code="NO_CALENDAR_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return EmployeeWorkCalendarResponse(**result)


@router.get("/work-calendars/{calendar_id}", response_model=WorkCalendarResponse)
async def get_one(
    calendar_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> WorkCalendarResponse:
    doc = await get_calendar(db, calendar_id, expected_org_id=current_user.org_id)
    return WorkCalendarResponse(**doc)


@router.get("/work-calendars/{calendar_id}/dependencies")
async def check_calendar_dependencies(
    calendar_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> dict:
    # Tenant guard: verify calendar belongs to caller's org before counting.
    await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user.org_id)
    cal_oid = to_oid(calendar_id)
    emp_count = await db["work_calendar_employees"].count_documents(
        {"work_calendar_id": cal_oid, "deleted_on": None}
    )
    shift_count = await db[SHIFT_COLLECTION].count_documents(
        {"calendar_id": calendar_id, "deleted_on": None}
    )
    return {"employees": emp_count, "shifts": shift_count}


@router.delete("/work-calendars/{calendar_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete(
    calendar_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> None:
    await delete_calendar(
        db, calendar_id, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.put("/work-calendars/{calendar_id}", response_model=WorkCalendarResponse)
async def update(
    calendar_id: str,
    payload: WorkCalendarUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> WorkCalendarResponse:
    doc = await update_calendar(
        db, calendar_id, payload, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return WorkCalendarResponse(**doc)


@router.get(
    "/work-calendars/{calendar_id}/employees",
    response_model=list[WorkCalendarEmployeeEntry],
)
async def get_calendar_employees(
    calendar_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[WorkCalendarEmployeeEntry]:
    docs = await list_calendar_employees(
        db, calendar_id,
        expected_org_id=current_user.org_id,
    )
    return [WorkCalendarEmployeeEntry(**d) for d in docs]


@router.get(
    "/work-calendars/{calendar_id}/employees/cross-assignments",
    response_model=CrossAssignmentList,
)
async def get_calendar_cross_assignments(
    calendar_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> CrossAssignmentList:
    return CrossAssignmentList(**await cross_calendar_assignments(db, calendar_id))


@router.put("/work-calendars/{calendar_id}/employees")
async def sync_calendar_employees_endpoint(
    calendar_id: str,
    payload: WorkCalendarEmployeeSync,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await sync_calendar_employees(
        db, calendar_id, payload.user_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.get("/work-calendars/{calendar_id}/employees/bulk-template")
async def download_bulk_template(
    calendar_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    content = generate_employee_template_xlsx()
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="employee_template_{calendar_id}.xlsx"'},
    )


@router.post("/work-calendars/{calendar_id}/employees/bulk-validate")
async def validate_bulk_upload(
    calendar_id: str,
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
):
    # Tenant guard: only return the calendar if it belongs to the caller's
    # org. A calendar_id from another tenant yields 404.
    cal_query = {"_id": to_oid(calendar_id), "deleted_on": None}
    if current_user and current_user.org_id:
        cal_query["org_id"] = {"$in": [to_oid(current_user.org_id), str(current_user.org_id)]}
    calendar = await db["work_calendars"].find_one(cal_query)
    if not calendar:
        raise HTTPException(status_code=404, detail="Work calendar not found")

    # Reject bulk-validate against an inactive calendar — the user cannot
    # assign employees to it anyway, so don't waste their time parsing the file.
    _assert_calendar_active(calendar)

    dept_ids = [to_oid(d) for d in (calendar.get("department_ids") or [])]

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
        assigned_collection="work_calendar_employees",
        assigned_id_field="work_calendar_id",
        assigned_id_value=to_oid(calendar_id),
        scope_name_collection="work_calendars",
        scope_label="work calendar",
        # org_id comes from the authenticated session.
        org_id=current_user.org_id if current_user else None,
    )
    result["file_errors"] = []
    return result


@router.post("/work-calendars/{calendar_id}/employees/bulk-assign")
async def bulk_assign_employees(
    calendar_id: str,
    payload: WorkCalendarEmployeeSync,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await add_calendar_employees(
        db, calendar_id, payload.user_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.post("/work-calendars/{calendar_id}/employees/sync-by-departments")
async def sync_calendar_employees_by_departments_endpoint(
    calendar_id: str,
    payload: WorkCalendarEmployeesByDepartments,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> dict:
    return await sync_calendar_employees_by_departments(
        db, calendar_id, payload.department_ids,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.post(
    "/work-calendars/shifts",
    response_model=ShiftResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_calendar_shift(
    payload: ShiftCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ShiftResponse:
    doc = await create_shift(
        db, payload, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return ShiftResponse(**doc)


@router.get(
    "/work-calendars/{calendar_id}/shifts",
    response_model=list[ShiftResponse],
)
async def list_calendar_shifts(
    calendar_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> list[ShiftResponse]:
    docs = await list_shifts_by_calendar(
        db, calendar_id,
        expected_org_id=current_user.org_id,
    )
    return [ShiftResponse(**d) for d in docs]


@router.get("/work-calendars/shifts/{shift_id}", response_model=ShiftResponse)
async def get_calendar_shift(
    shift_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> ShiftResponse:
    doc = await get_shift(
        db, shift_id,
        expected_org_id=current_user.org_id,
    )
    return ShiftResponse(**doc)


@router.put("/work-calendars/shifts/{shift_id}", response_model=ShiftResponse)
async def update_calendar_shift(
    shift_id: str,
    payload: ShiftUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ShiftResponse:
    doc = await update_shift(
        db, shift_id, payload, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return ShiftResponse(**doc)


@router.delete(
    "/work-calendars/shifts/{shift_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_calendar_shift(
    shift_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> None:
    await delete_shift(
        db, shift_id, current_user.user_id,
        current_user_org_id=current_user.org_id,
    )


@router.get(
    "/work-calendars/{calendar_id}/shift-assignments",
    response_model=list[ShiftAssignmentResponse],
)
async def get_calendar_shift_assignments(
    calendar_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> list[ShiftAssignmentResponse]:
    results = await get_shift_assignments(
        db, calendar_id, current_user_org_id=current_user.org_id,
    )
    return [ShiftAssignmentResponse(**r) for r in results]


@router.put(
    "/work-calendars/{calendar_id}/shift-assignments",
    response_model=ShiftAssignmentSyncResult,
)
async def sync_calendar_shift_assignments(
    calendar_id: str,
    payload: ShiftAssignmentSyncPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ShiftAssignmentSyncResult:
    assignments = [a.model_dump() for a in payload.assignments]
    result = await sync_shift_assignments(
        db, calendar_id, assignments,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return ShiftAssignmentSyncResult(**result)


@router.get("/work-calendars/{calendar_id}/shift-assignments/bulk-template")
async def download_shift_assignment_template(
    calendar_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
):
    content = await generate_shift_assignment_template(db, calendar_id)
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="shift_assignment_template_{calendar_id}.xlsx"'},
    )


@router.post(
    "/work-calendars/{calendar_id}/shift-assignments/bulk-validate",
    response_model=ShiftAssignValidateResult,
)
async def validate_shift_assignment_upload(
    calendar_id: str,
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> ShiftAssignValidateResult:
    file_bytes = await file.read()
    result = await validate_shift_assignment_bulk(
        db, calendar_id, file_bytes,
        current_user_org_id=current_user.org_id if current_user else None,
    )
    return ShiftAssignValidateResult(**result)


@router.post(
    "/work-calendars/{calendar_id}/shift-assignments/bulk-assign",
    response_model=ShiftAssignmentSyncResult,
)
async def bulk_assign_shift_assignments(
    calendar_id: str,
    payload: ShiftAssignmentSyncPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ShiftAssignmentSyncResult:
    assignments = [a.model_dump() for a in payload.assignments]
    result = await bulk_assign_shift_employees(
        db, calendar_id, assignments,
        user_id=current_user.user_id,
        current_user_org_id=current_user.org_id,
    )
    return ShiftAssignmentSyncResult(**result)


@router.get("/working-day", response_model=WorkingDayResponse)
async def working_day(
    user_id: str = Query(..., min_length=1),
    target_date: date = Query(..., alias="date"),
    department_id: Optional[str] = Query(None),
    business_unit_id: Optional[str] = Query(None),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> WorkingDayResponse:
    org_id = _require_org_id(current_user)
    result = await is_working_day(
        db,
        user_id=user_id,
        target_date=target_date,
        department_id=department_id,
        business_unit_id=business_unit_id,
        org_id=org_id,
    )
    return WorkingDayResponse(**result)
