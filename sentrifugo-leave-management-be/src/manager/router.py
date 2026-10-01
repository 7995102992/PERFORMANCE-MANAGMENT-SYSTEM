from datetime import date
from typing import Annotated, Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user, user_is_hr
from src.leave_requests.schemas import (
    ApprovalActionPayload,
    CancellationActionPayload,
    LeaveRequestDetailResponse,
    LeaveRequestResponse,
    LeaveRequestStatusCounts,
)
from src.manager.schemas import TeamAvailabilityResponse, TeamCalendarResponse, TeamLeaveSummaryResponse
from src.manager.service import (
    approve_managed_leave_request,
    cancel_managed_leave_request,
    get_managed_leave_request,
    get_managed_status_counts,
    get_team_availability,
    get_team_calendar,
    get_team_leave_summary,
    list_managed_leave_requests,
    list_pending_approvals,
    reject_managed_leave_request,
)

router = APIRouter(prefix="/manager", tags=["manager"])


@router.get("/team-leave-summary", response_model=TeamLeaveSummaryResponse)
async def fetch_team_leave_summary(
    status_filter: Optional[str] = Query(default=None, alias="status", description="Filter by status (default: APPROVED)"),
    from_date: Optional[date] = Query(default=None, description="Leave must end on or after this date (YYYY-MM-DD)"),
    to_date: Optional[date] = Query(default=None, description="Leave must start on or before this date (YYYY-MM-DD)"),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> TeamLeaveSummaryResponse:
    result = await get_team_leave_summary(
        db,
        current_user.user_id,
        status_filter=status_filter,
        from_date=from_date.isoformat() if from_date else None,
        to_date=to_date.isoformat() if to_date else None,
        org_id=current_user.org_id,
    )
    return TeamLeaveSummaryResponse(**result)


@router.get("/team-calendar", response_model=TeamCalendarResponse)
async def fetch_team_calendar(
    from_date: date = Query(..., description="Calendar start date, e.g. 2026-06-01"),
    to_date: date = Query(..., description="Calendar end date, e.g. 2026-06-30"),
    statuses: Optional[List[str]] = Query(default=None, alias="status", description="Statuses to include (default: APPROVED, PENDING)"),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> TeamCalendarResponse:
    if to_date < from_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="to_date must be >= from_date")
    if (to_date - from_date).days > 365:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Date range cannot exceed 365 days")
    result = await get_team_calendar(
        db, current_user.user_id, from_date, to_date,
        statuses=statuses, org_id=current_user.org_id,
    )
    return TeamCalendarResponse(**result)


@router.get("/team-availability", response_model=TeamAvailabilityResponse)
async def fetch_team_availability(
    start_date: date = Query(..., description="Range start, e.g. 2026-06-01"),
    end_date: date = Query(..., description="Range end, e.g. 2026-06-30"),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> TeamAvailabilityResponse:
    if end_date < start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_date must be >= start_date")
    if (end_date - start_date).days > 90:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Date range cannot exceed 90 days")
    result = await get_team_availability(
        db, current_user.user_id, start_date, end_date, org_id=current_user.org_id
    )
    return TeamAvailabilityResponse(**result)


@router.get("/leave-requests/pending-approvals", response_model=list[LeaveRequestResponse])
async def fetch_pending_approvals(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> list[LeaveRequestResponse]:
    docs = await list_pending_approvals(
        db,
        current_user.user_id,
        is_hr=user_is_hr(current_user),
        org_id=current_user.org_id,
    )
    return [LeaveRequestResponse(**d) for d in docs]


@router.get("/leave-requests", response_model=list[LeaveRequestResponse])
async def fetch_managed_leave_requests(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    from_date: Optional[date] = Query(default=None, description="Filter: leave must end on or after this date (YYYY-MM-DD)"),
    to_date: Optional[date] = Query(default=None, description="Filter: leave must start on or before this date (YYYY-MM-DD)"),
    skip: int = Query(default=0, ge=0),
    # None (unset) preserves the old unbounded behavior for any other caller;
    # ManagerLeaveManagement always passes a limit and pages via infinite
    # scroll instead of loading everything (some orgs have thousands of rows).
    limit: Optional[int] = Query(default=None, ge=1, le=200),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> list[LeaveRequestResponse]:
    docs = await list_managed_leave_requests(
        db,
        current_user.user_id,
        status_filter,
        from_date=from_date.isoformat() if from_date else None,
        to_date=to_date.isoformat() if to_date else None,
        is_hr=user_is_hr(current_user),
        org_id=current_user.org_id,
        skip=skip,
        limit=limit,
    )
    return [LeaveRequestResponse(**d) for d in docs]


@router.get("/leave-requests/status-counts", response_model=LeaveRequestStatusCounts)
async def fetch_status_counts(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestStatusCounts:
    """Exact per-status totals for the manager's scope — powers the stat cards."""
    counts = await get_managed_status_counts(
        db,
        current_user.user_id,
        is_hr=user_is_hr(current_user),
        org_id=current_user.org_id,
    )
    return LeaveRequestStatusCounts(**counts)


@router.get("/leave-requests/{request_id}", response_model=LeaveRequestDetailResponse)
async def fetch_managed_leave_request(
    request_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestDetailResponse:
    doc = await get_managed_leave_request(
        db, request_id, current_user.user_id, is_hr=user_is_hr(current_user)
    )
    return LeaveRequestDetailResponse(**doc)


@router.post("/leave-requests/{request_id}/approve", response_model=LeaveRequestResponse)
async def approve_request(
    request_id: str,
    payload: ApprovalActionPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestResponse:
    doc = await approve_managed_leave_request(
        db, request_id, current_user.user_id, payload, is_hr=user_is_hr(current_user)
    )
    return LeaveRequestResponse(**doc)


@router.post("/leave-requests/{request_id}/reject", response_model=LeaveRequestResponse)
async def reject_request(
    request_id: str,
    payload: ApprovalActionPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestResponse:
    doc = await reject_managed_leave_request(
        db, request_id, current_user.user_id, payload, is_hr=user_is_hr(current_user)
    )
    return LeaveRequestResponse(**doc)


@router.post("/leave-requests/{request_id}/cancel", response_model=LeaveRequestResponse)
async def cancel_request(
    request_id: str,
    payload: CancellationActionPayload,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestResponse:
    """Cancel an APPROVED leave of a managed employee. Allowed only until the
    24th closing the payroll cycle the leave falls in; reverses the balance
    debit made at approval."""
    doc = await cancel_managed_leave_request(
        db, request_id, current_user.user_id, payload, is_hr=user_is_hr(current_user)
    )
    return LeaveRequestResponse(**doc)
