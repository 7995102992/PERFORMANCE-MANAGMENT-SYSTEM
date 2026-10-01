from datetime import date
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from src.database import get_db_session
from src.dependencies import UserBase, require_permission
from src.reports.employee_leave import (
    get_employee_leave_export_data,
    get_employee_leave_report,
    get_employee_leave_statistics,
    get_leave_report_filters,
)
from src.reports.export import (
    generate_current_balance_xlsx,
    generate_employee_leave_xlsx,
    generate_year_end_report_xlsx,
)
from src.reports.service import (
    get_current_balance_report,
    get_year_end_report,
    get_year_end_years,
)

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/year-end-processing")
async def year_end_processing_report(
    leave_plan_id: str = Query(...),
    year: int = Query(...),
    search: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    current_user: UserBase = Depends(require_permission("reports")),
    db: Any = Depends(get_db_session),
):
    return await get_year_end_report(db, leave_plan_id, year, search=search, page=page, page_size=page_size, org_id=current_user.org_id)


@router.get("/year-end-processing/export")
async def year_end_processing_export(
    leave_plan_id: str = Query(...),
    year: int = Query(...),
    search: str | None = Query(None),
    current_user: UserBase = Depends(require_permission("reports")),
    db: Any = Depends(get_db_session),
):
    data = await get_year_end_report(db, leave_plan_id, year, search=search, page=1, page_size=10000, org_id=current_user.org_id)
    content = generate_year_end_report_xlsx(data)
    filename = f"Year_End_Report_{year}.xlsx"
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/year-end-processing/years")
async def year_end_years(
    leave_plan_id: str = Query(...),
    current_user: UserBase = Depends(require_permission("reports")),
    db: Any = Depends(get_db_session),
):
    return await get_year_end_years(db, leave_plan_id, org_id=current_user.org_id)


@router.get("/current-leave-balance")
async def current_leave_balance_report(
    leave_plan_id: str = Query(...),
    search: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    current_user: UserBase = Depends(require_permission("reports")),
    db: Any = Depends(get_db_session),
):
    return await get_current_balance_report(db, leave_plan_id, search=search, page=page, page_size=page_size, org_id=current_user.org_id)


@router.get("/current-leave-balance/export")
async def current_leave_balance_export(
    leave_plan_id: str = Query(...),
    search: str | None = Query(None),
    current_user: UserBase = Depends(require_permission("reports")),
    db: Any = Depends(get_db_session),
):
    data = await get_current_balance_report(db, leave_plan_id, search=search, page=1, page_size=10000, org_id=current_user.org_id)
    content = generate_current_balance_xlsx(data)
    filename = f"Current_Leave_Balance.xlsx"
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Employee leave report (HR) ───────────────────────────────────────────────
# Date-range extract of leave requests + their approval trail, sliced by BU /
# department / employee. The list, the statistics and the export take an
# identical filter set so all three always describe the same population.

_MULTI = "Repeat the parameter for multiple values."

EmployeeLeaveFilters = dict


def _leave_filter_params(
    from_date: date = Query(..., description="Start of the reporting window (inclusive)"),
    to_date: date = Query(..., description="End of the reporting window (inclusive)"),
    business_unit_id: Optional[list[str]] = Query(None, description=f"Business unit. {_MULTI}"),
    department_id: Optional[list[str]] = Query(None, description=f"Department. {_MULTI}"),
    leave_type_id: Optional[list[str]] = Query(None, description=f"Leave type. {_MULTI}"),
    status: Optional[list[str]] = Query(None, description=f"Request status. {_MULTI}"),
    employee_id: Optional[list[str]] = Query(
        None,
        description=(
            "Specific employees, by employee id OR user id — whichever the caller "
            f"holds. {_MULTI}"
        ),
    ),
    search: Optional[str] = Query(
        None,
        description=(
            "Free-text employee name / code / email match, applied ON TOP of "
            "`employee_id` when both are given."
        ),
    ),
) -> EmployeeLeaveFilters:
    """The filter set shared by the list, statistics and export endpoints."""
    return {
        "from_date": from_date,
        "to_date": to_date,
        "business_unit_ids": business_unit_id,
        "department_ids": department_id,
        "leave_type_ids": leave_type_id,
        "statuses": status,
        "employee_ids": employee_id,
        "search": search,
    }


@router.get("/employee-leave/filters")
async def employee_leave_filter_options(
    current_user: UserBase = Depends(require_permission("view_employee_reports")),
    db: Any = Depends(get_db_session),
):
    """Business units, departments and leave types available to filter on."""
    return await get_leave_report_filters(db, org_id=current_user.org_id)


@router.get("/employee-leave")
async def employee_leave_report(
    filters: Annotated[EmployeeLeaveFilters, Depends(_leave_filter_params)],
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    current_user: UserBase = Depends(require_permission("view_employee_reports")),
    db: Any = Depends(get_db_session),
):
    return await get_employee_leave_report(
        db, org_id=current_user.org_id, page=page, page_size=page_size, **filters
    )


@router.get("/employee-leave/statistics")
async def employee_leave_statistics(
    filters: Annotated[EmployeeLeaveFilters, Depends(_leave_filter_params)],
    current_user: UserBase = Depends(require_permission("view_employee_reports")),
    db: Any = Depends(get_db_session),
):
    return await get_employee_leave_statistics(db, org_id=current_user.org_id, **filters)


@router.get("/employee-leave/export")
async def employee_leave_export(
    filters: Annotated[EmployeeLeaveFilters, Depends(_leave_filter_params)],
    current_user: UserBase = Depends(require_permission("view_employee_reports")),
    db: Any = Depends(get_db_session),
):
    data = await get_employee_leave_export_data(db, org_id=current_user.org_id, **filters)
    rows = data.get("rows", [])

    # Echoed into the workbook header so a downloaded file states the slice it
    # came from — a sheet with no provenance is unusable a week later. Names are
    # read off the rows that came back rather than re-queried, so a selection
    # with no leave in the window is simply absent instead of misreported.
    def _names(field: str, selected, label: str) -> None:
        if not selected:
            return
        found = sorted({r[field] for r in rows if r.get(field)})
        applied[label] = ", ".join(found) if found else f"{len(selected)} selected"

    applied: dict[str, str] = {}
    _names("employee_name", filters.get("employee_ids"), "Employees")
    _names("business_unit", filters.get("business_unit_ids"), "Business Unit")
    _names("department", filters.get("department_ids"), "Department")
    _names("leave_type", filters.get("leave_type_ids"), "Leave Type")
    if filters.get("statuses"):
        applied["Status"] = ", ".join(filters["statuses"])
    if filters.get("search"):
        applied["Employee search"] = filters["search"]
    data["filters_applied"] = applied

    content = generate_employee_leave_xlsx(data)
    filename = f"Employee_Leave_Report_{data['from_date']}_to_{data['to_date']}.xlsx"
    return StreamingResponse(
        iter([content]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
