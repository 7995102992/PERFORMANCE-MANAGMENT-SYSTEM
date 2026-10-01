import math
from typing import Optional

from src.year_end_processing.schemas import RoundingConfig, RoundingType, RoundingUnit

_UNIT_VALUES = {
    RoundingUnit.HALF_DAY: 0.5,
    RoundingUnit.FULL_DAY: 1.0,
}


def round_value(value: float, config: Optional[RoundingConfig]) -> float:
    if not config or not config.enabled or not config.rounding_type or not config.rounding_unit:
        return value
    unit = _UNIT_VALUES[config.rounding_unit]
    if config.rounding_type == RoundingType.NEAREST:
        return round(value / unit) * unit
    if config.rounding_type == RoundingType.UP:
        return math.ceil(value / unit) * unit
    return math.floor(value / unit) * unit
