from datetime import datetime
from typing import Literal, Optional

from pydantic import Field

from src.models import AuditMixin, CustomModel


class LeaveEntitlementCreate(CustomModel):
    employee_id: str
    leave_type_id: str
    policy_id: str


class LeaveEntitlementResponse(AuditMixin):
    id: str = Field(alias="_id")
    employee_id: str
    leave_type_id: str
    policy_id: str


class LedgerEntryCreate(CustomModel):
    employee_id: str
    leave_type_id: str
    transaction_type: Literal["CREDIT", "DEBIT", "REVERSAL", "ADJUSTMENT"]
    amount: float = Field(gt=0)
    reference_id: Optional[str] = None
    note: Optional[str] = None


class LedgerEntryResponse(CustomModel):
    id: str = Field(alias="_id")
    employee_id: str
    leave_type_id: str
    transaction_type: str
    amount: float
    reference_id: Optional[str] = None
    note: Optional[str] = None
    created_on: datetime
    created_by: str


class LeaveBalanceResponse(CustomModel):
    employee_id: str
    leave_type_id: str
    total_credited: float
    total_debited: float
    balance: float


class LeaveBalanceCreditCreate(CustomModel):
    user_id: str
    leave_type_id: str
    days: float = Field(gt=0, description="Number of days to credit")
    note: Optional[str] = None


class LeaveBalanceCreditResponse(CustomModel):
    id: str = Field(alias="_id")
    user_id: str
    leave_type_id: str
    days_credited: float
    hours_credited: float
    note: Optional[str] = None
    created_on: datetime
    created_by: str
    balance_after: float
