from typing import List, Optional, Tuple

from src.year_end_processing.rounding_service import round_value
from src.year_end_processing.schemas import (
    CalculationMode,
    PayoutCarryConfig,
    ProcessingType,
    SlabRule,
)


def _match_slab(balance: float, slabs: List[SlabRule]) -> Optional[SlabRule]:
    eligible = [s for s in slabs if balance >= s.min_balance]
    return max(eligible, key=lambda s: s.min_balance) if eligible else None


def calculate(
    processing_type: ProcessingType,
    balance: float,
    config: Optional[PayoutCarryConfig],
) -> Tuple[float, float, float, List[str]]:
    """Returns (payout, carry_forward, expired, logs)."""
    logs: List[str] = []

    if processing_type == ProcessingType.EXPIRE_RESET:
        logs.append(f"EXPIRE_RESET: full balance {balance} expired")
        return 0.0, 0.0, balance, logs

    if processing_type == ProcessingType.PAYOUT_ALL:
        logs.append(f"PAYOUT_ALL: full balance {balance} paid out")
        return balance, 0.0, 0.0, logs

    if processing_type == ProcessingType.CARRY_FORWARD_ALL:
        logs.append(f"CARRY_FORWARD_ALL: full balance {balance} carried forward")
        return 0.0, balance, 0.0, logs

    if processing_type == ProcessingType.CARRY_FORWARD_EXPIRE:
        limit = (
            config.max_carry_limit
            if config and config.max_carry_limit is not None
            else 0.0
        )
        carry = min(balance, limit)
        expired = max(0.0, balance - carry)
        logs.append(
            f"CARRY_FORWARD_EXPIRE: max_carry_limit={limit}, carry_forward={carry}, expired={expired}"
        )
        return 0.0, carry, expired, logs

    if not config:
        return 0.0, 0.0, 0.0, logs

    if config.calculation_mode == CalculationMode.PERCENTAGE:
        min_eligible = config.minimum_eligible_balance or 0
        if balance < min_eligible:
            logs.append(
                f"Balance {balance} is below minimum_eligible_balance {min_eligible}; skipping settlement"
            )
            return 0.0, 0.0, balance, logs
        payout, carry = _by_percentage(balance, config, logs)
    else:
        payout, carry = _by_fixed(processing_type, balance, config, logs)

    # PAYOUT_THEN_CARRY: payout is calculated first, carry absorbs the remainder
    if processing_type == ProcessingType.PAYOUT_THEN_CARRY:
        payout = min(payout, balance)
        carry = min(carry, balance - payout)
    # CARRY_THEN_PAYOUT: carry is calculated first, payout absorbs the remainder
    elif processing_type == ProcessingType.CARRY_THEN_PAYOUT:
        carry = min(carry, balance)
        payout = min(payout, balance - carry)
    else:
        payout = min(payout, balance)
        carry = min(carry, balance - payout)

    if config.calculation_mode == CalculationMode.PERCENTAGE:
        payout = round_value(payout, config.rounding)
        carry = round_value(carry, config.rounding)

        if config.max_payout_limit is not None:
            payout = min(payout, config.max_payout_limit)
            logs.append(f"max_payout_limit applied: payout capped at {payout}")

        if config.max_carry_limit is not None:
            carry = min(carry, config.max_carry_limit)
            logs.append(f"max_carry_limit applied: carry capped at {carry}")

    expired = max(0.0, balance - payout - carry)
    logs.append(f"Result: payout={payout}, carry_forward={carry}, expired={expired}")
    return payout, carry, expired, logs


def _by_percentage(
    balance: float, config: PayoutCarryConfig, logs: List[str]
) -> Tuple[float, float]:
    if not config.percentage_config:
        return 0.0, 0.0
    pct = config.percentage_config
    payout = balance * (pct.payout_percentage / 100.0)
    carry = balance * (pct.carry_percentage / 100.0)
    logs.append(
        f"PERCENTAGE: {pct.payout_percentage}% payout={payout}, {pct.carry_percentage}% carry={carry}"
    )
    return payout, carry


def _by_fixed(
    processing_type: ProcessingType,
    balance: float,
    config: PayoutCarryConfig,
    logs: List[str],
) -> Tuple[float, float]:
    if config.slab_rules:
        slab = _match_slab(balance, config.slab_rules)
        if not slab:
            logs.append(f"FIXED_DAYS slab: no slab matched for balance={balance}")
            return 0.0, 0.0
        logs.append(f"FIXED_DAYS slab matched (min_balance={slab.min_balance})")
        if processing_type == ProcessingType.CARRY_THEN_PAYOUT:
            carry = min(slab.carry_forward_value, balance)
            payout = min(slab.payout_value, balance - carry)
        else:
            payout = min(slab.payout_value, balance)
            carry = min(slab.carry_forward_value, balance - payout)
        return payout, carry

    # No slabs — process entire balance per processing type
    if processing_type in (ProcessingType.PAYOUT_ALL, ProcessingType.PAYOUT_THEN_CARRY):
        return balance, 0.0
    return 0.0, balance
