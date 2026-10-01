"""Time-window helpers for analytics (fiscal year, trailing months)."""
from __future__ import annotations

from datetime import datetime, timezone

# Fiscal-year start month. India FY = Apr–Mar, so April (4) by default.
# TODO: source this from org config (OrgSrConfig) once a fiscal-year setting
# exists; kept a constant for now so descriptive metrics are deterministic.
FISCAL_YEAR_START_MONTH = 4


def fy_start(now: datetime, start_month: int = FISCAL_YEAR_START_MONTH) -> datetime:
    """First instant of the fiscal year containing ``now`` (UTC)."""
    year = now.year if now.month >= start_month else now.year - 1
    return datetime(year, start_month, 1, tzinfo=timezone.utc)


def months_back_start(now: datetime, months: int) -> datetime:
    """First day of the month ``months-1`` before the current month (UTC).

    e.g. with months=6 in June → first day of January (a 6-month window).
    """
    total = (now.year * 12 + (now.month - 1)) - (months - 1)
    y, m = divmod(total, 12)
    return datetime(y, m + 1, 1, tzinfo=timezone.utc)


def last_n_month_keys(now: datetime, months: int) -> list[tuple[int, int, str]]:
    """Ordered (year, month, label) tuples for the trailing ``months`` months,
    oldest first — used to render a fixed x-axis with zero-filled gaps."""
    out: list[tuple[int, int, str]] = []
    total = now.year * 12 + (now.month - 1)
    for i in range(months - 1, -1, -1):
        y, m = divmod(total - i, 12)
        out.append((y, m + 1, datetime(y, m + 1, 1).strftime("%b %Y")))
    return out
