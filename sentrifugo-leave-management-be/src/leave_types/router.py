from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user, require_permission
from src.exceptions import DomainException
from src.leave_types.schemas import (
    LeaveTypeCreate,
    LeaveTypeResponse,
    LeaveTypeUpdate,
    LeaveTypeUsageResponse,
)
from src.leave_types.service import (
    create_leave_type,
    delete_leave_type,
    get_employee_for_eligibility,
    get_leave_type,
    get_leave_type_usage,
    list_leave_types,
    update_leave_type,
)

router = APIRouter(tags=["leave-types"])


@router.post("/leave-types", response_model=LeaveTypeResponse, status_code=status.HTTP_201_CREATED)
async def add_leave_type(
    payload: LeaveTypeCreate,
    current_user: Annotated[UserBase, Depends(require_permission("leave_types"))],
    db: Any = Depends(get_db_session),
) -> LeaveTypeResponse:
    # Derive the org from the session, never from the body. A payload naming a
    # different org is rejected rather than silently honoured.
    caller_org = current_user.org_id
    if not caller_org:
        raise DomainException(
            message="Organisation context is required",
            code="ORG_CONTEXT_MISSING",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if payload.org_id is not None and str(payload.org_id) != str(caller_org):
        raise DomainException(
            message="You cannot create leave types in another organisation",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    doc = await create_leave_type(
        db, payload, created_by=current_user.user_id, org_id=caller_org
    )
    return LeaveTypeResponse(**doc)


@router.get("/leave-types", response_model=list[LeaveTypeResponse])
async def fetch_leave_types(
    org_id: Optional[str] = Query(default=None, description="Ignored unless it matches your organisation"),
    eligible_only: bool = Query(
        default=False,
        description=(
            "Drop the leave types the CALLER is restricted out of by gender / "
            "marital status. For employee-facing pickers; the admin listing "
            "leaves it off so every type stays visible."
        ),
    ),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> list[LeaveTypeResponse]:
    # Derive the org from the session, never from the client. A query param that
    # names a different org is rejected rather than silently honoured.
    caller_org = current_user.org_id
    if not caller_org:
        raise DomainException(
            message="Organisation context is required",
            code="ORG_CONTEXT_MISSING",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if org_id is not None and str(org_id) != str(caller_org):
        raise DomainException(
            message="You cannot access another organisation's leave types",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    employee = (
        await get_employee_for_eligibility(db, current_user.user_id)
        if eligible_only
        else None
    )
    docs = await list_leave_types(db, caller_org, eligible_for=employee)
    return [LeaveTypeResponse(**d) for d in docs]


@router.get("/leave-types/{leave_type_id}", response_model=LeaveTypeResponse)
async def fetch_leave_type(
    leave_type_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> LeaveTypeResponse:
    doc = await get_leave_type(db, leave_type_id, org_id=current_user.org_id)
    return LeaveTypeResponse(**doc)


@router.put("/leave-types/{leave_type_id}", response_model=LeaveTypeResponse)
async def modify_leave_type(
    leave_type_id: str,
    payload: LeaveTypeUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("leave_types"))] = None,
    db: Any = Depends(get_db_session),
) -> LeaveTypeResponse:
    doc = await update_leave_type(db, leave_type_id, payload, updated_by=current_user.user_id, org_id=current_user.org_id)
    return LeaveTypeResponse(**doc)


@router.get("/leave-types/{leave_type_id}/usage", response_model=LeaveTypeUsageResponse)
async def fetch_leave_type_usage(
    leave_type_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> LeaveTypeUsageResponse:
    """Pre-delete check: which leave plans use this type, and can it be deleted?

    The UI calls this before showing the delete action so it can either disable
    it (``can_delete=false`` — an active plan uses the type) or raise a
    confirmation dialog with ``message`` (``requires_confirmation=true``).
    """
    usage = await get_leave_type_usage(db, leave_type_id, org_id=current_user.org_id)
    return LeaveTypeUsageResponse(**usage)


@router.delete("/leave-types/{leave_type_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_leave_type(
    leave_type_id: str,
    current_user: Annotated[UserBase, Depends(require_permission("leave_types"))],
    confirm: bool = Query(
        default=False,
        description="Acknowledges that the type is assigned to one or more inactive leave plans and will be removed from them",
    ),
    db: Any = Depends(get_db_session),
) -> None:
    # The same rules the /usage endpoint reports are re-enforced here, so a
    # client that skips the pre-check still cannot delete a type an active plan
    # depends on, nor delete an assigned one without an explicit confirmation.
    await delete_leave_type(
        db, leave_type_id, deleted_by=current_user.user_id, org_id=current_user.org_id,
        confirm=confirm,
    )
