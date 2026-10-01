from datetime import datetime
from enum import Enum
from typing import List, Optional

from bson import ObjectId
from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


class ProcessingType(str, Enum):
    EXPIRE_RESET = "EXPIRE_RESET"
    PAYOUT_ALL = "PAYOUT_ALL"
    CARRY_FORWARD_ALL = "CARRY_FORWARD_ALL"
    PAYOUT_THEN_CARRY = "PAYOUT_THEN_CARRY"
    CARRY_THEN_PAYOUT = "CARRY_THEN_PAYOUT"
    CARRY_FORWARD_EXPIRE = "CARRY_FORWARD_EXPIRE"


class CalculationMode(str, Enum):
    FIXED_DAYS = "FIXED_DAYS"
    PERCENTAGE = "PERCENTAGE"


class NegativeBalanceRule(str, Enum):
    DEDUCT_FROM_PAYROLL = "DEDUCT_FROM_PAYROLL"
    RESET_TO_ZERO = "RESET_TO_ZERO"
    CARRY_FORWARD_DEFICIT = "CARRY_FORWARD_DEFICIT"


class RoundingType(str, Enum):
    NEAREST = "NEAREST"
    UP = "UP"
    DOWN = "DOWN"


class RoundingUnit(str, Enum):
    HALF_DAY = "HALF_DAY"
    FULL_DAY = "FULL_DAY"


class ExecutionStatus(str, Enum):
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"


class SlabRule(CustomModel):
    min_balance: float
    payout_value: float
    carry_forward_value: float


class PercentageConfig(CustomModel):
    payout_percentage: float
    carry_percentage: float


class RoundingConfig(CustomModel):
    enabled: bool = False
    rounding_type: Optional[RoundingType] = None
    rounding_unit: Optional[RoundingUnit] = None


class PayoutCarryConfig(CustomModel):
    calculation_mode: Optional[CalculationMode] = None
    minimum_eligible_balance: Optional[float] = 0
    slab_rules: List[SlabRule] = []
    percentage_config: Optional[PercentageConfig] = None
    max_payout_limit: Optional[float] = None
    max_carry_limit: Optional[float] = None
    rounding: Optional[RoundingConfig] = None


# --- Request schemas ---

class YearEndProcessingCreate(CustomModel):
    processing_type: ProcessingType
    payout_carry_config: Optional[PayoutCarryConfig] = None
    negative_balance_rule: NegativeBalanceRule = NegativeBalanceRule.RESET_TO_ZERO


class YearEndProcessingUpdate(CustomModel):
    processing_type: Optional[ProcessingType] = None
    payout_carry_config: Optional[PayoutCarryConfig] = None
    negative_balance_rule: Optional[NegativeBalanceRule] = None


class ExecuteYearEndRequest(CustomModel):
    year: int
    dry_run: bool = False


class PreviewYearEndRequest(CustomModel):
    employee_id: Optional[str] = None
    mock_balance: float


# --- Response schemas ---

class YearEndProcessingResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    processing_type: ProcessingType
    payout_carry_config: Optional[PayoutCarryConfig] = None
    negative_balance_rule: NegativeBalanceRule

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "leave_plan_id"):
            v = data.get(field)
            if v is not None and isinstance(v, ObjectId):
                data[field] = str(v)
        return data


class LeaveTypeYearEndDetail(CustomModel):
    """Per-leave-type year-end breakdown. Mirrors carry-forward/expire so the
    UI can list, per leave type, how much was paid out, encashed, carried
    forward, or expired. ``encashed_amount`` defaults to 0 for records written
    before the encashment split."""
    leave_type_id: str
    opening_balance: float
    payout_amount: float
    encashed_amount: float = 0.0
    carry_forward_amount: float
    expired_amount: float
    closing_balance: float


class PreviewResult(CustomModel):
    opening_balance: float
    payout_amount: float
    carry_forward_amount: float
    expired_amount: float
    negative_recovered_amount: float
    closing_balance: float
    logs: List[str]


class YearEndExecutionResponse(AuditMixin):
    id: str = Field(alias="_id")
    leave_plan_id: str
    year: int
    employee_id: str
    opening_balance: float
    payout_amount: float
    encashed_amount: float = 0.0
    carry_forward_amount: float
    expired_amount: float
    negative_recovered_amount: float
    closing_balance: float
    leave_type_details: List[LeaveTypeYearEndDetail] = Field(default_factory=list)
    execution_status: ExecutionStatus
    execution_logs: List[str]
    processed_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "leave_plan_id", "employee_id"):
            v = data.get(field)
            if v is not None and isinstance(v, ObjectId):
                data[field] = str(v)
        return data


class ExecuteYearEndResponse(CustomModel):
    total_processed: int
    total_success: int
    total_failed: int
    dry_run: bool
    year: int
