"""Monthly payroll cutoff for timesheet submission.

Organisations close their timesheet period on a fixed day of the month (the 25th,
say). Once that day arrives, every week that has already *ended* is frozen — it has
gone to payroll — while the week straddling the cutoff stays open, because part of
it is work done after the cutoff that belongs to the next cycle.

The boundary rolls: on 26 Aug with a cutoff of 25 the boundary is 25 Aug; on 3 Aug
it is still 25 Jul. A week is locked when it ended strictly before the boundary.

Cutoff days beyond the length of a month clamp to that month's last day, so 31 means
"the last day" in February as well as in January.
"""

from __future__ import annotations

import calendar
from datetime import date

__all__ = ["clamp_cutoff_day", "current_cutoff_boundary", "is_day_locked", "is_period_locked"]


def clamp_cutoff_day(year: int, month: int, cutoff_day: int) -> int:
    """The cutoff day as it falls in a given month, clamped to that month's length."""
    return min(max(cutoff_day, 1), calendar.monthrange(year, month)[1])


def current_cutoff_boundary(today: date, cutoff_day: int) -> date:
    """The most recent cutoff date on or before ``today``.

    Args:
        today: The date the rule is being evaluated on.
        cutoff_day: Configured day of the month, 1-31.

    Returns:
        This month's cutoff once it has arrived, otherwise last month's.
    """
    this_month = clamp_cutoff_day(today.year, today.month, cutoff_day)
    if today.day >= this_month:
        return date(today.year, today.month, this_month)

    year, month = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return date(year, month, clamp_cutoff_day(year, month, cutoff_day))


def is_day_locked(entry_date: date, today: date, cutoff_day: int) -> bool:
    """Whether a single day sits inside a closed payroll period.

    The cutoff day itself is closed: on the 25th, the 25th and everything before it
    are settled and only the 26th onward may still be filled. Locking is per day
    rather than per week because the boundary usually falls mid-week — the days
    either side of it belong to different payroll periods, so a week that straddles
    it is partly closed and partly open.
    """
    return entry_date <= current_cutoff_boundary(today, cutoff_day)


def is_period_locked(week_end: date, today: date, cutoff_day: int) -> bool:
    """Whether an entire week sits inside a closed payroll period.

    True only when the week's last day is closed, so no day of it can still be
    filled. Used for submission, which pushes a whole week at once; per-day writes
    use ``is_day_locked``.
    """
    return is_day_locked(week_end, today, cutoff_day)
