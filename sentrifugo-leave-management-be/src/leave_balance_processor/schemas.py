from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import Field

from src.models import CustomModel


class CreditTransactionType(str, Enum):
    GRANT_CREDIT = "GRANT_CREDIT"     # Full-year allocation credited all at once
    ACCRUAL_CREDIT = "ACCRUAL_CREDIT" # Periodic accrual (monthly / quarterly / half-yearly)
    ADJUSTMENT = "ADJUSTMENT"         # Manual correction
    DEBIT = "DEBIT"                   # Leave taken
    REVERSAL = "REVERSAL"             # Reversal of a prior debit
    EXPIRY_LAPSE = "EXPIRY_LAPSE"     # Unused credit lapsed at its expiry


class LeaveCreditLedgerEntry(CustomModel):
    """Immutable audit row written for every credit event."""
    id: str = Field(alias="_id")
    employee_id: str
    org_id: str
    leave_plan_id: str
    leave_type_id: str
    transaction_type: CreditTransactionType
    amount: float
    effective_date: datetime
    period_year: int
    period_month: Optional[int] = None
    period_quarter: Optional[int] = None
    period_half: Optional[int] = None
    # Composite idempotency key — e.g. "2025:ANNUAL", "2025:M04", "2025:Q2", "2025:H1"
    period_key: str
    reference_id: Optional[str] = None
    note: str
    metadata: dict = Field(default_factory=dict)
    created_on: datetime
    created_by: str


class EmployeeLeaveBalance(CustomModel):
    """Running balance snapshot per (employee × leave-plan × leave-type)."""
    id: str = Field(alias="_id")
    employee_id: str
    org_id: str
    leave_plan_id: str
    leave_type_id: str
    total_credited: float = 0.0
    total_debited: float = 0.0
    balance: float = 0.0
    last_credit_period_key: Optional[str] = None
    last_updated_on: datetime
