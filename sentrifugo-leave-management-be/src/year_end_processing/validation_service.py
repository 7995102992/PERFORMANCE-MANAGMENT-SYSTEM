from fastapi import status

from src.exceptions import DomainException
from src.year_end_processing.schemas import (
    CalculationMode,
    PayoutCarryConfig,
    ProcessingType,
    YearEndProcessingCreate,
)

_CONFIG_REQUIRED_TYPES = {
    ProcessingType.PAYOUT_THEN_CARRY,
    ProcessingType.CARRY_THEN_PAYOUT,
    ProcessingType.CARRY_FORWARD_EXPIRE,
}


def _validate_carry_forward_expire_config(config: PayoutCarryConfig) -> None:
    if config.max_carry_limit is None or config.max_carry_limit < 0:
        raise DomainException(
            message="max_carry_limit is required and must be >= 0 for CARRY_FORWARD_EXPIRE",
            code="MISSING_MAX_CARRY_LIMIT",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if config.calculation_mode is not None:
        raise DomainException(
            message="calculation_mode must not be set for CARRY_FORWARD_EXPIRE",
            code="INVALID_FIELD_FOR_TYPE",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if config.slab_rules:
        raise DomainException(
            message="slab_rules must be empty for CARRY_FORWARD_EXPIRE",
            code="INVALID_FIELD_FOR_TYPE",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if config.percentage_config is not None:
        raise DomainException(
            message="percentage_config must not be set for CARRY_FORWARD_EXPIRE",
            code="INVALID_FIELD_FOR_TYPE",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def validate_payout_carry_config(config: PayoutCarryConfig) -> None:
    if config.calculation_mode is None:
        return
    if config.calculation_mode == CalculationMode.FIXED_DAYS:
        if config.percentage_config is not None:
            raise DomainException(
                message="percentage_config must not be set when calculation_mode is FIXED_DAYS",
                code="INVALID_FIELD_FOR_MODE",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if config.slab_rules:
            min_balances = [s.min_balance for s in config.slab_rules]
            if len(min_balances) != len(set(min_balances)):
                raise DomainException(
                    message="Slab rule min_balance values must be unique",
                    code="DUPLICATE_SLAB_MIN_BALANCE",
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )

    elif config.calculation_mode == CalculationMode.PERCENTAGE:
        if config.slab_rules:
            raise DomainException(
                message="slab_rules must be empty when calculation_mode is PERCENTAGE",
                code="INVALID_FIELD_FOR_MODE",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if config.percentage_config is None:
            raise DomainException(
                message="percentage_config is required when calculation_mode is PERCENTAGE",
                code="MISSING_PERCENTAGE_CONFIG",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        total = config.percentage_config.payout_percentage + config.percentage_config.carry_percentage
        if abs(total - 100.0) > 0.001:
            raise DomainException(
                message="payout_percentage + carry_percentage must equal 100",
                code="INVALID_PERCENTAGE_SPLIT",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if config.minimum_eligible_balance is not None and config.minimum_eligible_balance < 0:
            raise DomainException(
                message="minimum_eligible_balance must be >= 0",
                code="INVALID_MIN_ELIGIBLE_BALANCE",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if config.max_payout_limit is not None and config.max_payout_limit < 0:
            raise DomainException(
                message="max_payout_limit must be >= 0",
                code="INVALID_MAX_PAYOUT_LIMIT",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if config.max_carry_limit is not None and config.max_carry_limit < 0:
            raise DomainException(
                message="max_carry_limit must be >= 0",
                code="INVALID_MAX_CARRY_LIMIT",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )


def validate_create_payload(payload: YearEndProcessingCreate) -> None:
    if payload.processing_type in _CONFIG_REQUIRED_TYPES and not payload.payout_carry_config:
        raise DomainException(
            message=f"payout_carry_config is required for processing_type '{payload.processing_type}'",
            code="MISSING_PAYOUT_CARRY_CONFIG",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if payload.processing_type == ProcessingType.CARRY_FORWARD_EXPIRE and payload.payout_carry_config:
        _validate_carry_forward_expire_config(payload.payout_carry_config)
    elif payload.payout_carry_config:
        validate_payout_carry_config(payload.payout_carry_config)
