from datetime import date
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, Query, status

from src.database import get_db_session
from src.dependencies import (
    UserBase,
    get_current_user,
    require_any_permission,
    require_permission,
)
from src.leave_policy.schemas import ApprovalPolicyResponse
from src.leave_requests.schemas import (
    AllLeaveBalancesResponse,
    ApprovalFlowCreate,
    ApprovalFlowResponse,
    ApprovalOverrideCreate,
    BalanceEstimateResponse,
    BalanceProjectionResponse,
    DurationMode,
    LeaveBalanceResponse,
    LeaveEstimateResponse,
    LeaveHistoryResponse,
    LeaveRequestCreate,
    LeaveRequestDetailResponse,
    LeaveRequestResponse,
    LeaveTypeUsage,
    MyLeaveRequestsResponse,
    SessionHalf,
    ToggleConfigResponse,
    ToggleConfigUpsert,
)
from src.exceptions import DomainException
from src.leave_requests.service import (
    cancel_leave_request,
    create_approval_flow,
    create_approval_override,
    create_leave_request,
    estimate_leave_duration,
    get_all_leave_balances,
    get_approval_flow_by_plan,
    get_balance_estimate,
    get_balance_projection,
    get_leave_balance,
    get_leave_history,
    get_toggle_config,
    get_leave_request,
    get_leave_request_detail,
    get_leave_type_usage,
    get_my_approval_chain,
    list_leave_requests,
    list_my_leave_requests,
    upsert_toggle_config,
    update_leave_request,
)

router = APIRouter(tags=["leave-requests"])


def _require_org_id(current_user: UserBase) -> str:
    if not current_user.org_id:
        raise DomainException(
            message="Organisation context is required",
            code="ORG_CONTEXT_MISSING",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return current_user.org_id


# ─── Toggle Config ──────────────────────────────────────────────────────────

@router.get(
    "/leave-plans/{leave_plan_id}/toggle-config",
    response_model=Optional[ToggleConfigResponse],
)
async def get_config(
    leave_plan_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> Optional[ToggleConfigResponse]:
    org_id = _require_org_id(current_user)
    doc = await get_toggle_config(db, leave_plan_id, org_id)
    return ToggleConfigResponse(**doc) if doc else None


@router.put(
    "/leave-plans/{leave_plan_id}/toggle-config",
    response_model=ToggleConfigResponse,
)
async def upsert_config(
    leave_plan_id: str,
    payload: ToggleConfigUpsert,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> ToggleConfigResponse:
    org_id = _require_org_id(current_user)
    doc = await upsert_toggle_config(db, leave_plan_id, payload, current_user.user_id, org_id)
    return ToggleConfigResponse(**doc)


# ─── Approval Flows ──────────────────────────────────────────────────────────

@router.post(
    "/approval-flows",
    response_model=ApprovalFlowResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_approval_flow(
    payload: ApprovalFlowCreate,
    current_user: Annotated[UserBase, Depends(require_permission("leave_configuration"))],
    db: Any = Depends(get_db_session),
) -> ApprovalFlowResponse:
    org_id = _require_org_id(current_user)
    doc = await create_approval_flow(db, payload, created_by=current_user.user_id, org_id=org_id)
    return ApprovalFlowResponse(**doc)


@router.get(
    "/approval-flows",
    response_model=Optional[ApprovalFlowResponse],
)
async def fetch_approval_flow(
    leave_plan_id: str = Query(...),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> Optional[ApprovalFlowResponse]:
    doc = await get_approval_flow_by_plan(db, leave_plan_id)
    return ApprovalFlowResponse(**doc) if doc else None


@router.get(
    "/approval-flows/me",
    response_model=Optional[ApprovalPolicyResponse],
)
async def fetch_my_approval_chain(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> Optional[ApprovalPolicyResponse]:
    doc = await get_my_approval_chain(db, current_user.user_id)
    return ApprovalPolicyResponse(**doc) if doc else None


# ─── Balance & Estimate ──────────────────────────────────────────────────────

@router.get("/leave-requests/balance", response_model=LeaveBalanceResponse)
async def fetch_leave_balance(
    leave_type_id: str = Query(...),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> LeaveBalanceResponse:
    result = await get_leave_balance(db, current_user.user_id, leave_type_id)
    return LeaveBalanceResponse(**result)


@router.get("/leave-requests/balances", response_model=AllLeaveBalancesResponse)
async def fetch_all_leave_balances(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> AllLeaveBalancesResponse:
    result = await get_all_leave_balances(
        db, current_user.user_id, org_id=current_user.org_id
    )
    return AllLeaveBalancesResponse(**result)


@router.get("/leave-requests/usage", response_model=LeaveTypeUsage)
async def fetch_leave_type_usage(
    leave_type_id: str = Query(...),
    user_id: Optional[str] = Query(
        default=None,
        description="Whose usage to read. Approver-facing; defaults to the caller.",
    ),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> LeaveTypeUsage:
    """Days of a leave type used this leave year.

    Feeds the usage warning on unrestricted leave, which has no balance for the
    apply form or the approver to show instead. Callable for any type — the UI
    only asks when the type is configured to warn.
    """
    result = await get_leave_type_usage(
        db, user_id or current_user.user_id, leave_type_id
    )
    return LeaveTypeUsage(**result)


@router.get("/leave-requests/estimate", response_model=LeaveEstimateResponse)
async def fetch_leave_estimate(
    leave_type_id: str = Query(...),
    start_date: str = Query(..., description="ISO date string e.g. 2026-05-17"),
    end_date: str = Query(..., description="ISO date string e.g. 2026-05-20"),
    duration_mode: DurationMode = Query(DurationMode.FULL_DAYS),
    half_day_period: Optional[SessionHalf] = Query(default=None),
    start_session: Optional[SessionHalf] = Query(default=None),
    end_session: Optional[SessionHalf] = Query(default=None),
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> LeaveEstimateResponse:
    result = await estimate_leave_duration(
        db,
        employee_id=current_user.user_id,
        leave_type_id=leave_type_id,
        start_date_str=start_date,
        end_date_str=end_date,
        duration_mode=duration_mode.value,
        half_day_period=half_day_period.value if half_day_period else None,
        start_session=start_session.value if start_session else None,
        end_session=end_session.value if end_session else None,
    )
    return LeaveEstimateResponse(**result)


# ─── Leave Requests ──────────────────────────────────────────────────────────

@router.post(
    "/leave-requests",
    response_model=LeaveRequestResponse,
    status_code=status.HTTP_201_CREATED,
)
async def submit_leave_request(
    payload: LeaveRequestCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestResponse:
    doc = await create_leave_request(db, payload, current_user.user_id)
    return LeaveRequestResponse(**doc)


# @router.get("/leave-requests", response_model=list[LeaveRequestResponse])
# async def fetch_leave_requests(
#     status_filter: Optional[str] = Query(default=None, alias="status"),
#     current_user: UserBase = Depends(get_current_user),
#     db: Any = Depends(get_db_session),
# ) -> list[LeaveRequestResponse]:
#     docs = await list_leave_requests(db, status_filter=status_filter)
#     return [LeaveRequestResponse(**d) for d in docs]


@router.get("/leave-requests/me", response_model=MyLeaveRequestsResponse)
async def fetch_my_leave_requests(
    status_filter: Optional[
        Literal["PENDING", "APPROVED", "REJECTED", "CANCELLED"]
    ] = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    from_date: Optional[date] = Query(
        default=None,
        description="Inclusive, applied to start_date (YYYY-MM-DD)",
    ),
    to_date: Optional[date] = Query(
        default=None,
        description="Inclusive, applied to start_date (YYYY-MM-DD)",
    ),
    search: Optional[str] = Query(
        default=None,
        description="Case-insensitive substring on leave_type_name + reason",
    ),
    sort: Literal[
        "created_on", "-created_on",
        "start_date", "-start_date",
        "status", "-status",
    ] = Query(default="-created_on"),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> MyLeaveRequestsResponse:
    result = await list_my_leave_requests(
        db,
        user_id=current_user.user_id,
        status_filter=status_filter,
        from_date=from_date.isoformat() if from_date else None,
        to_date=to_date.isoformat() if to_date else None,
        search=search,
        page=page,
        page_size=page_size,
        sort=sort,
    )
    result["items"] = [LeaveRequestResponse(**d) for d in result["items"]]
    return MyLeaveRequestsResponse(**result)


@router.get("/leave-requests/balance-projection", response_model=BalanceProjectionResponse)
async def fetch_balance_projection(
    leave_type_id: Optional[str] = Query(default=None),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> BalanceProjectionResponse:
    result = await get_balance_projection(db, current_user.user_id, leave_type_id)
    return BalanceProjectionResponse(**result)


@router.get("/leave-requests/balance-estimate", response_model=BalanceEstimateResponse)
async def fetch_balance_estimate(
    leave_type_id: str = Query(...),
    start_date: date = Query(..., description="Leave start date e.g. 2026-06-01"),
    end_date: date = Query(..., description="Leave end date e.g. 2026-06-03"),
    duration_mode: DurationMode = Query(DurationMode.FULL_DAYS),
    half_day_period: Optional[SessionHalf] = Query(default=None),
    start_session: Optional[SessionHalf] = Query(default=None),
    end_session: Optional[SessionHalf] = Query(default=None),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> BalanceEstimateResponse:
    result = await get_balance_estimate(
        db,
        user_id=current_user.user_id,
        leave_type_id=leave_type_id,
        start_date_str=start_date.isoformat(),
        end_date_str=end_date.isoformat(),
        duration_mode=duration_mode.value,
        half_day_period=half_day_period.value if half_day_period else None,
        start_session=start_session.value if start_session else None,
        end_session=end_session.value if end_session else None,
    )
    return BalanceEstimateResponse(**result)


@router.get("/leave-requests/history", response_model=LeaveHistoryResponse)
async def fetch_leave_history(
    year: Optional[int] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> LeaveHistoryResponse:
    result = await get_leave_history(
        db, current_user.user_id, year=year, status_filter=status_filter,
        limit=limit, offset=offset,
    )
    result["items"] = [LeaveRequestResponse(**d) for d in result["items"]]
    return LeaveHistoryResponse(**result)


@router.get("/leave-requests/{request_id}", response_model=LeaveRequestDetailResponse)
async def fetch_leave_request(
    request_id: str,
    current_user: UserBase = Depends(get_current_user),
    db: Any = Depends(get_db_session),
) -> LeaveRequestDetailResponse:
    doc = await get_leave_request_detail(db, request_id, current_user.user_id)
    return LeaveRequestDetailResponse(**doc)

# NOTE: The unguarded /leave-requests/{id}/approve and /reject endpoints were
# removed. They bypassed manager/level authorization (any authenticated user
# could act on any request). Approvals now go solely through the guarded
# /manager/leave-requests/{id}/approve|reject routes in src/manager/router.py,
# which enforce _assert_manager_access + _assert_level_access.


@router.post("/leave-requests/{request_id}/cancel", response_model=LeaveRequestResponse)
async def cancel_request(
    request_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestResponse:
    doc = await cancel_leave_request(db, request_id, current_user.user_id)
    return LeaveRequestResponse(**doc)


@router.put("/leave-requests/{request_id}", response_model=LeaveRequestResponse)
async def update_request(
    request_id: str,
    payload: LeaveRequestCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveRequestResponse:
    doc = await update_leave_request(db, request_id, payload, current_user.user_id)
    return LeaveRequestResponse(**doc)


# ─── Approval Overrides ──────────────────────────────────────────────────────

@router.post(
    "/approval-overrides",
    status_code=status.HTTP_201_CREATED,
)
async def add_approval_override(
    payload: ApprovalOverrideCreate,
    current_user: Annotated[
        UserBase,
        Depends(require_any_permission("manage_leave_request", "leave_configuration")),
    ],
    db: Any = Depends(get_db_session),
) -> dict:
    doc = await create_approval_override(
        db, payload, created_by=current_user.user_id, org_id=current_user.org_id
    )
    return {"id": doc["_id"], "leave_request_id": doc["leave_request_id"]}
