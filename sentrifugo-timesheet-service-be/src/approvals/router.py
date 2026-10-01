from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase, get_current_user
from ..common.pagination import PageParams, page_params
from ..exceptions import Forbidden
from ..models import Client, ClientProjectHead, Project
from . import service
from .export import (
    generate_activity_excel,
    generate_excel,
    generate_monthly_excel,
    generate_monthly_pdf,
    generate_pdf,
    generate_review_excel,
)
from .schemas import (
    ApprovalAction,
    BulkApprovalAction,
    BulkRejectionAction,
    ManagerDashboardResponse,
    PastSubmissionCutoffOut,
    RejectionAction,
)

router = APIRouter(tags=["approvals"])

_MOD = "timesheet_management"
_MANAGER = require_permission(_MOD, "manage_timesheet")


async def _client_portal_user(
    user: Annotated[UserBase, Depends(get_current_user)],
) -> UserBase:
    if user.is_super_admin or user.is_org_admin:
        return user
    if user.has_permission(_MOD, "client_timesheet"):
        return user
    client_doc = await Client.find_one({
        "contact_user_id": user.id,
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    })
    if client_doc:
        return user
    ph_doc = await ClientProjectHead.find_one({
        "iam_user_id": user.id,
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    })
    if ph_doc:
        return user
    # Internal project head (employee acting as the client-side approver)
    internal_proj = await Project.find_one({
        "project_head_ids": user.id,
        "is_internal": True,
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    })
    if internal_proj:
        return user
    raise Forbidden("Access denied: not a client user or project head")


# --- Manager (L1) endpoints ---

@router.get("/approvals/dashboard", response_model=ManagerDashboardResponse)
async def get_dashboard(
    user: Annotated[UserBase, Depends(_MANAGER)],
    month: int | None = Query(None, ge=1, le=12),
    year: int | None = Query(None, ge=2020, le=2100),
) -> ManagerDashboardResponse:
    return await service.get_dashboard(user, month=month, year=year)


@router.get("/approvals/past-submission-cutoff", response_model=PastSubmissionCutoffOut)
async def get_past_submission_cutoff(
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> PastSubmissionCutoffOut:
    """The monthly payroll cutoff: `{enabled, cutoff_day}`.

    Lives here rather than under `/settings` on purpose. Team Timesheets renders
    against the cutoff to show which months are closed, so it must be readable with
    the same `manage_timesheet` grant that opens the screen — `manage_settings` would
    403 the very managers who need it. Performing a reopen is a different question
    and keeps its own, stricter gate on the override endpoints.
    """
    return await service.get_past_submission_cutoff(user)


@router.get("/approvals/timesheets")
async def list_team_timesheets(
    user: Annotated[UserBase, Depends(_MANAGER)],
    p: Annotated[PageParams, Depends(page_params)],
    timesheet_status: str | None = Query(None),
    status_filter: str = Query(
        "all", pattern="^(all|pending|approved|rejected|not_submitted)$",
        description="Coarse status filter. pending = submitted/resubmitted, "
                    "approved = l1_approved/client_approved, "
                    "rejected = l1_rejected/client_rejected, "
                    "not_submitted = past weeks with nothing filed. Default all.",
    ),
    scope: str = Query(
        "own", pattern="^(own|reporting)$",
        description="own = timesheets you approve (default). reporting = timesheets "
                    "of employees on projects headed by your L1/L2 reports; "
                    "view-only (see `read_only`) and without not_submitted rows.",
    ),
    user_id: str | None = Query(None),
    month: int | None = Query(None, ge=1, le=12),
    year: int | None = Query(None, ge=2020, le=2100),
    search: str | None = Query(None),
) -> dict:
    """Team timesheets by employee-month.

    Includes `not_submitted` weeks — past weeks an employee filed nothing for. The
    current week and future weeks are never reported that way, since a week still
    being worked has not been missed.

    `scope=reporting` switches to oversight of the reporting line: the projects
    headed by this user's direct L1/L2 reports. Those rows carry `read_only: true`
    and cannot be approved or rejected — the approval endpoints resolve the actor's
    own approver scope and never consult the reporting line — and `not_submitted`
    weeks are left out, since chasing them belongs to the approving manager.
    """
    return await service.list_team_timesheets(
        user, p, timesheet_status=timesheet_status, status_filter=status_filter,
        scope=scope, user_id=user_id, month=month, year=year, search=search,
    )


@router.get("/approvals/timesheets/monthly")
async def get_monthly_timesheet(
    user: Annotated[UserBase, Depends(_MANAGER)],
    user_id: str = Query(..., description="Employee user id"),
    month: int = Query(..., ge=1, le=12),
    year: int = Query(..., ge=2020, le=2100),
) -> dict:
    return await service.get_monthly_timesheet_detail(user_id, user, month=month, year=year)


@router.get("/approvals/timesheets/monthly/export/excel")
async def export_monthly_timesheet_excel(
    user: Annotated[UserBase, Depends(_MANAGER)],
    user_id: str = Query(..., description="Employee user id"),
    month: int = Query(..., ge=1, le=12),
    year: int = Query(..., ge=2020, le=2100),
) -> Response:
    detail = await service.get_monthly_timesheet_detail(user_id, user, month=month, year=year)
    content = generate_monthly_excel(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    period = detail.get("month_label", f"{year:04d}-{month:02d}")
    filename = f"timesheet_{user_name}_{period}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/approvals/timesheets/monthly/export/pdf")
async def export_monthly_timesheet_pdf(
    user: Annotated[UserBase, Depends(_MANAGER)],
    user_id: str = Query(..., description="Employee user id"),
    month: int = Query(..., ge=1, le=12),
    year: int = Query(..., ge=2020, le=2100),
) -> Response:
    detail = await service.get_monthly_timesheet_detail(user_id, user, month=month, year=year)
    content = generate_monthly_pdf(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    period = detail.get("month_label", f"{year:04d}-{month:02d}")
    filename = f"timesheet_{user_name}_{period}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/approvals/team-resources")
async def list_team_resources(
    user: Annotated[UserBase, Depends(_MANAGER)],
    from_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    to_date: str = Query(..., description="End date (YYYY-MM-DD)"),
) -> list:
    return await service.list_team_resources(user, from_date, to_date)


@router.get("/approvals/employees/{user_id}")
async def get_employee_detail(
    user_id: str,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> dict:
    return await service.get_employee_detail(user_id, user)


@router.get("/approvals/employees/{user_id}/timesheets")
async def list_employee_timesheets(
    user_id: str,
    user: Annotated[UserBase, Depends(_MANAGER)],
    p: Annotated[PageParams, Depends(page_params)],
) -> dict:
    return await service.list_employee_timesheets(user_id, user, p)


@router.get("/approvals/timesheets/{id}")
async def get_timesheet_detail(
    id: str,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> dict:
    return await service.get_timesheet_detail(id, user)


@router.get("/approvals/timesheets/{id}/export/excel")
async def export_timesheet_excel(
    id: str,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> Response:
    detail = await service.get_timesheet_detail(id, user)
    content = generate_excel(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    week = str(detail.get("week_start_date", ""))[:10]
    filename = f"timesheet_{user_name}_{week}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/approvals/timesheets/{id}/export/pdf")
async def export_timesheet_pdf(
    id: str,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> Response:
    detail = await service.get_timesheet_detail(id, user)
    content = generate_pdf(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    week = str(detail.get("week_start_date", ""))[:10]
    filename = f"timesheet_{user_name}_{week}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/approvals/timesheets/{id}/approve")
async def approve_timesheet(
    id: str,
    body: ApprovalAction,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> dict:
    return await service.approve_timesheet(id, body, user, role="manager")


@router.post("/approvals/timesheets/{id}/reject")
async def reject_timesheet(
    id: str,
    body: RejectionAction,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> dict:
    return await service.reject_timesheet(id, body, user, role="manager")


@router.post("/approvals/bulk-approve")
async def bulk_approve(
    body: BulkApprovalAction,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> list:
    return await service.bulk_approve(body, user, role="manager")


@router.post("/approvals/bulk-reject")
async def bulk_reject(
    body: BulkRejectionAction,
    user: Annotated[UserBase, Depends(_MANAGER)],
) -> list:
    return await service.bulk_reject(body, user, role="manager")


# --- Client (L2) endpoints ---

@router.get("/client-portal/dashboard")
async def get_client_dashboard(
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> dict:
    return await service.get_client_dashboard(user)


@router.get("/client-portal/timesheets")
async def list_client_timesheets(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    p: Annotated[PageParams, Depends(page_params)],
    timesheet_status: str | None = Query(None),
    project_id: str | None = Query(None),
    search: str | None = Query(None),
    week_start: str | None = Query(None),
    week_end: str | None = Query(None),
) -> dict:
    return await service.list_client_timesheets(
        user, p,
        timesheet_status=timesheet_status,
        project_id=project_id,
        search=search,
        week_start=week_start,
        week_end=week_end,
    )


@router.get("/client-portal/timesheets/monthly")
async def get_client_monthly_timesheet(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    user_id: str = Query(..., description="Employee user id"),
    month: int = Query(..., ge=1, le=12),
    year: int = Query(..., ge=2020, le=2100),
) -> dict:
    return await service.get_client_monthly_timesheet_detail(user_id, user, month=month, year=year)


@router.get("/client-portal/timesheets/monthly/export/excel")
async def export_client_monthly_timesheet_excel(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    user_id: str = Query(..., description="Employee user id"),
    month: int = Query(..., ge=1, le=12),
    year: int = Query(..., ge=2020, le=2100),
) -> Response:
    detail = await service.get_client_monthly_timesheet_detail(user_id, user, month=month, year=year)
    content = generate_monthly_excel(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    period = detail.get("month_label", f"{year:04d}-{month:02d}")
    filename = f"timesheet_{user_name}_{period}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/client-portal/timesheets/monthly/export/pdf")
async def export_client_monthly_timesheet_pdf(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    user_id: str = Query(..., description="Employee user id"),
    month: int = Query(..., ge=1, le=12),
    year: int = Query(..., ge=2020, le=2100),
) -> Response:
    detail = await service.get_client_monthly_timesheet_detail(user_id, user, month=month, year=year)
    content = generate_monthly_pdf(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    period = detail.get("month_label", f"{year:04d}-{month:02d}")
    filename = f"timesheet_{user_name}_{period}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/client-portal/timesheets/export/excel")
async def export_client_review_excel(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    timesheet_status: str | None = Query(None),
    search: str | None = Query(None),
    week_start: str | None = Query(None),
    week_end: str | None = Query(None),
) -> Response:
    items = await service.export_client_timesheets(
        user,
        timesheet_status=timesheet_status,
        search=search,
        week_start=week_start,
        week_end=week_end,
    )
    content = generate_review_excel(items)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="client_review_export.xlsx"'},
    )


@router.get("/client-portal/timesheets/{id}")
async def get_client_timesheet_detail(
    id: str,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> dict:
    return await service.get_client_timesheet_detail(id, user)


@router.get("/client-portal/timesheets/{id}/export/excel")
async def export_client_timesheet_excel(
    id: str,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> Response:
    detail = await service.get_client_timesheet_detail(id, user)
    content = generate_excel(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    week = str(detail.get("week_start_date", ""))[:10]
    filename = f"timesheet_{user_name}_{week}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/client-portal/timesheets/{id}/export/pdf")
async def export_client_timesheet_pdf(
    id: str,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> Response:
    detail = await service.get_client_timesheet_detail(id, user)
    content = generate_pdf(detail)
    user_name = (detail.get("user_name") or detail.get("user_id", "unknown")).replace(" ", "_")
    week = str(detail.get("week_start_date", ""))[:10]
    filename = f"timesheet_{user_name}_{week}.pdf"
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/client-portal/activity-history/export/excel")
async def export_activity_history_excel(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    search: str | None = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    actor: str | None = Query(None),
) -> Response:
    items = await service.export_activity_history(
        user, search=search, start_date=start_date, end_date=end_date, actor=actor,
    )
    content = generate_activity_excel(items, title="Activity History Export")
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="activity_history_export.xlsx"'},
    )


@router.get("/client-portal/activity-history/full-report")
async def export_activity_full_report(
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> Response:
    items = await service.export_activity_history(user)
    content = generate_activity_excel(items, title="Full Activity Report")
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="activity_full_report.xlsx"'},
    )


@router.get("/client-portal/activity-history")
async def get_client_activity_history(
    user: Annotated[UserBase, Depends(_client_portal_user)],
    p: Annotated[PageParams, Depends(page_params)],
    search: str | None = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    actor: str | None = Query(None),
) -> dict:
    return await service.get_client_activity_history(
        user, p, search=search, start_date=start_date, end_date=end_date, actor=actor,
    )


@router.post("/client-portal/timesheets/{id}/approve")
async def client_approve(
    id: str,
    body: ApprovalAction,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> dict:
    return await service.approve_timesheet(id, body, user, role="client")


@router.post("/client-portal/timesheets/{id}/reject")
async def client_reject(
    id: str,
    body: RejectionAction,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> dict:
    return await service.reject_timesheet(id, body, user, role="client")


@router.post("/client-portal/bulk-approve")
async def client_bulk_approve(
    body: BulkApprovalAction,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> list:
    return await service.bulk_approve(body, user, role="client")


@router.post("/client-portal/bulk-reject")
async def client_bulk_reject(
    body: BulkRejectionAction,
    user: Annotated[UserBase, Depends(_client_portal_user)],
) -> list:
    return await service.bulk_reject(body, user, role="client")
