from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.exit_management import service
from src.modules.exit_management.schema import (
    ExitInterviewCreate,
    ExitInterviewResponse,
    ExitRequestApproval,
    ExitRequestCreate,
    ExitRequestResponse,
    ExitRequestStatus,
    ExitRequestUpdate,
    HRExitRequestResponse,
    HRExitSummaryResponse,
    ManagerApproveRequest,
    ManagerRejectRequest,
    TeamExitRequestResponse,
    TeamExitSummaryResponse,
    ITAssetReturnResponse,
    ITAssetSummaryResponse,
    ITAssetVerifyRequest,
    AdminTaskResponse,
    AdminTaskSummaryResponse,
    AdminTaskCompleteRequest,
    FinanceClearanceResponse,
    FinanceClearanceSummaryResponse,
    FinanceClearanceStatusRequest,
    DepartmentChecklistResponse,
    DepartmentChecklistCreate,
    HRChecklistSubmit,
)

router = APIRouter(prefix="/exit-management", tags=["exit-management"])

@router.post("/requests", response_model=ExitRequestResponse, status_code=status.HTTP_201_CREATED)
async def create_exit_request(
    data: ExitRequestCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.create_exit_request(data, caller=current_user)


@router.get("/requests", response_model=list[ExitRequestResponse])
async def list_exit_requests(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    status_filter: ExitRequestStatus | None = Query(default=None, alias="status"),
):
    return await service.list_exit_requests(
        caller=current_user, skip=skip, limit=limit, search=search, status_filter=status_filter,
    )


@router.get("/requests/{request_id}", response_model=ExitRequestResponse)
async def get_exit_request(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.get_exit_request(request_id, caller=current_user)


@router.put("/requests/{request_id}", response_model=ExitRequestResponse)
async def update_exit_request(
    request_id: PydanticObjectId,
    data: ExitRequestUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.update_exit_request(request_id, data, caller=current_user)


@router.put("/requests/{request_id}/withdraw", response_model=ExitRequestResponse)
async def withdraw_exit_request(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.withdraw_exit_request(request_id, caller=current_user)


@router.put("/requests/{request_id}/revoke", response_model=ExitRequestResponse)
async def revoke_exit_request(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.revoke_exit_request(request_id, caller=current_user)


@router.post("/requests/{request_id}/approve", response_model=ExitRequestResponse)
async def approve_exit_request(
    request_id: PydanticObjectId,
    data: ExitRequestApproval,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.approve_exit_request(request_id, data, caller=current_user)


@router.post("/requests/{request_id}/reapply", response_model=ExitRequestResponse, status_code=status.HTTP_201_CREATED)
async def reapply_exit_request(
    request_id: PydanticObjectId,
    data: ExitRequestCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.reapply_exit_request(request_id, data, caller=current_user)

@router.post("/requests/{request_id}/interview", response_model=ExitInterviewResponse, status_code=status.HTTP_201_CREATED)
async def submit_exit_interview(
    request_id: PydanticObjectId,
    data: ExitInterviewCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    return await service.submit_exit_interview(request_id, data, caller=current_user)


@router.get("/requests/{request_id}/interview", response_model=ExitInterviewResponse)
async def get_exit_interview(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    result = await service.get_exit_interview(request_id, caller=current_user)
    if not result:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Exit interview not found")
    return result


# ── Manager Flow Endpoints ──────────────────────────────────────────────

@router.get("/team-requests", response_model=list[TeamExitRequestResponse])
async def list_team_exit_requests(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    status_filter: str | None = Query(default=None, alias="status"),
    department: str | None = Query(default=None),
    from_date: str | None = Query(default=None, alias="fromDate"),
    to_date: str | None = Query(default=None, alias="toDate"),
):
    return await service.list_team_exit_requests(
        caller=current_user, skip=skip, limit=limit, search=search,
        status_filter=status_filter, department=department,
        from_date=from_date, to_date=to_date,
    )


@router.get("/team-requests/summary", response_model=TeamExitSummaryResponse)
async def get_team_exit_summary(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.get_team_exit_summary(caller=current_user)


@router.post("/requests/{request_id}/manager-approve", response_model=TeamExitRequestResponse)
async def manager_approve_request(
    request_id: PydanticObjectId,
    data: ManagerApproveRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.manager_approve_request(request_id, data, caller=current_user)


@router.post("/requests/{request_id}/manager-reject", response_model=TeamExitRequestResponse)
async def manager_reject_request(
    request_id: PydanticObjectId,
    data: ManagerRejectRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.manager_reject_request(request_id, data, caller=current_user)

# ── HR Flow Endpoints ──────────────────────────────────────────────

@router.post("/requests/{request_id}/initiate-clearances")
async def initiate_clearances(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    data: HRChecklistSubmit | None = None,
):
    return await service.initiate_clearances(request_id, caller=current_user, hr_checklist=data)


@router.post("/requests/{request_id}/deactivate")
async def deactivate_employee(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    data: HRChecklistSubmit | None = None,
):
    return await service.deactivate_employee(request_id, caller=current_user, hr_checklist=data)


@router.post("/requests/{request_id}/remind")
async def send_clearance_reminder(
    request_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.send_clearance_reminder(request_id, caller=current_user)


@router.get("/hr-requests", response_model=list[HRExitRequestResponse])
async def list_hr_exit_requests(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    status_filter: str | None = Query(default=None, alias="status"),
    department: str | None = Query(default=None),
    from_date: str | None = Query(default=None, alias="fromDate"),
    to_date: str | None = Query(default=None, alias="toDate"),
):
    return await service.list_hr_exit_requests(
        caller=current_user, skip=skip, limit=limit, search=search,
        status_filter=status_filter, department=department,
        from_date=from_date, to_date=to_date,
    )


@router.get("/hr-requests/summary", response_model=HRExitSummaryResponse)
async def get_hr_exit_summary(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.get_hr_exit_summary(caller=current_user)


# --- IT Admin Flow ---

@router.get("/it/assets", response_model=list[ITAssetReturnResponse])
async def list_it_assets(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(""),
    status: str | None = Query(default=None),
    asset_type: str | None = Query(default=None, alias="assetType"),
):
    return await service.list_it_assets(
        caller=current_user, skip=skip, limit=limit, search=search,
        status_filter=status, asset_type=asset_type
    )

@router.get("/it/assets/summary", response_model=ITAssetSummaryResponse)
async def get_it_assets_summary(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.get_it_assets_summary(caller=current_user)

@router.post("/it/assets/{asset_id}/verify", status_code=status.HTTP_200_OK)
async def verify_it_asset(
    asset_id: PydanticObjectId,
    payload: ITAssetVerifyRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.verify_it_asset(asset_id=asset_id, payload=payload, caller=current_user)


# --- Admin Flow ---

@router.get("/admin/tasks", response_model=list[AdminTaskResponse])
async def list_admin_tasks(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(""),
    status: str | None = Query(default=None),
    task_type: str | None = Query(default=None, alias="taskType"),
):
    return await service.list_admin_tasks(
        caller=current_user, skip=skip, limit=limit, search=search,
        status_filter=status, task_type=task_type
    )

@router.get("/admin/tasks/summary", response_model=AdminTaskSummaryResponse)
async def get_admin_tasks_summary(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.get_admin_tasks_summary(caller=current_user)

@router.post("/admin/tasks/{task_id}/complete", status_code=status.HTTP_200_OK)
async def complete_admin_task(
    task_id: PydanticObjectId,
    payload: AdminTaskCompleteRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.complete_admin_task(task_id=task_id, payload=payload, caller=current_user)


# --- Finance Flow ---

@router.get("/finance/requests", response_model=list[FinanceClearanceResponse])
async def list_finance_requests(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(""),
    status: str | None = Query(default=None),
    department: str | None = Query(default=None),
    from_date: str | None = Query(default=None, alias="fromDate"),
    to_date: str | None = Query(default=None, alias="toDate"),
):
    return await service.list_finance_requests(
        caller=current_user, skip=skip, limit=limit, search=search,
        status_filter=status, department=department, from_date=from_date, to_date=to_date
    )

@router.get("/finance/requests/summary", response_model=FinanceClearanceSummaryResponse)
async def get_finance_summary(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.get_finance_summary(caller=current_user)

@router.post("/finance/requests/{request_id}/status", status_code=status.HTTP_200_OK)
async def update_finance_status(
    request_id: PydanticObjectId,
    payload: FinanceClearanceStatusRequest,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
):
    return await service.update_finance_status(request_id=request_id, payload=payload, caller=current_user)


# --- Checklist Endpoints ---

@router.get("/checklists", response_model=list[DepartmentChecklistResponse])
async def get_checklists(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))],
    dept_id: str | None = Query(default=None, alias="deptId")
):
    return await service.get_checklists(caller=current_user, dept_id=dept_id)

@router.put("/checklists", response_model=DepartmentChecklistResponse)
async def update_checklist(
    payload: DepartmentChecklistCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "approve_exit_request"))]
):
    return await service.create_or_update_checklist(payload=payload, caller=current_user)
