from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query, status

from src.database import get_db_session
from src.dependencies import UserBase, get_current_user, require_development_env
from src.entitlements.schemas import (
    LeaveBalanceCreditCreate,
    LeaveBalanceCreditResponse,
    LeaveBalanceResponse,
    LeaveEntitlementResponse,
    LedgerEntryResponse,
)
from src.entitlements.service import (
    compute_balance,
    credit_leave_balance,
    get_entitlements_for_employee,
    get_ledger_entries,
)

router = APIRouter(tags=["entitlements"])


@router.get("/entitlements", response_model=list[LeaveEntitlementResponse])
async def fetch_entitlements(
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> list[LeaveEntitlementResponse]:
    docs = await get_entitlements_for_employee(db, current_user.user_id)
    return [LeaveEntitlementResponse(**d) for d in docs]


@router.get("/entitlements/ledger", response_model=list[LedgerEntryResponse])
async def fetch_ledger(
    leave_type_id: Optional[str] = Query(default=None),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> list[LedgerEntryResponse]:
    docs = await get_ledger_entries(db, current_user.user_id, leave_type_id)
    return [LedgerEntryResponse(**d) for d in docs]


@router.post(
    "/leave-balance/credit",
    response_model=LeaveBalanceCreditResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_development_env)],
)
async def credit_balance(
    payload: LeaveBalanceCreditCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
    db: Any = Depends(get_db_session),
) -> LeaveBalanceCreditResponse:
    doc = await credit_leave_balance(
        db, payload, actor_id=current_user.user_id, actor_org_id=current_user.org_id
    )
    return LeaveBalanceCreditResponse(**doc)


@router.get("/entitlements/balance", response_model=LeaveBalanceResponse)
async def fetch_balance(
    leave_type_id: str = Query(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
    db: Any = Depends(get_db_session),
) -> LeaveBalanceResponse:
    result = await compute_balance(db, current_user.user_id, leave_type_id)
    return LeaveBalanceResponse(**result)
