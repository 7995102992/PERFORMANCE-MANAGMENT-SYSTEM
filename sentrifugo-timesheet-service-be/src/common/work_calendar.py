"""Work-calendar resolution from the LMS shift `weekend_matrix`.

The matrix is keyed by week-of-month ("1".."5"); each value is a 7-element list
indexed Monday(0)..Sunday(6). Per-day codes (LMS authoritative definition):

    0 = full day OFF (weekoff)
    1 = full working day
    2 = half day
    3 = full/half (rotating)

We derive only the unambiguous weekoff dates (code 0) here, and pass the raw
`weekend_matrix` and `week_config` through untouched so the frontend can apply
its own rules for half-day / rotating days.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

_WEEKOFF_CODE = 0


def _empty_calendar() -> dict[str, Any]:
    return {"weekoffs": [], "weekend_matrix": None, "week_config": None}


def compute_weekoff_dates(weekend_matrix: dict | None, from_date: str, to_date: str) -> list[str]:
    """Return ISO dates in [from_date, to_date] marked as a full weekoff (code 0)."""
    if not weekend_matrix:
        return []
    try:
        start = datetime.fromisoformat(from_date).date()
        end = datetime.fromisoformat(to_date).date()
    except (ValueError, TypeError):
        return []

    offs: list[str] = []
    cur = start
    while cur <= end:
        week_of_month = ((cur.day - 1) // 7) + 1
        row = weekend_matrix.get(str(week_of_month))
        weekday = cur.weekday()  # Mon=0 .. Sun=6
        if isinstance(row, list) and 0 <= weekday < len(row) and row[weekday] == _WEEKOFF_CODE:
            offs.append(cur.isoformat())
        cur += timedelta(days=1)
    return offs


async def fetch_work_calendars(
    employee_ids: list[str], from_date: str, to_date: str
) -> dict[str, dict[str, Any]]:
    """Fetch shift details from LMS and build each employee's work calendar for
    [from_date, to_date].

    Returns {user_id_str: {
        "weekoffs": [ISO dates, code 0],
        "weekend_matrix": <raw matrix dict | None>,
        "week_config": <raw week_config dict | None>,
    }}. Degrades to empty calendars if LMS is unavailable.
    """
    from ..rabbitmq.lms_rpc import LMSUnavailable, get_employee_shift_details

    id_strs = [str(e) for e in employee_ids]
    result: dict[str, dict[str, Any]] = {sid: _empty_calendar() for sid in id_strs}
    if not id_strs:
        return result
    try:
        shift_resp = await get_employee_shift_details(id_strs)
    except LMSUnavailable as exc:
        logger.warning("fetch_work_calendars: LMS unavailable (%s) — empty calendars", exc)
        return result  # LMSTimeout subclasses LMSUnavailable — degrade gracefully

    data: dict[str, Any] = shift_resp.get("data", {}) or {}
    for sid in id_strs:
        shift = data.get(sid)  # None when no calendar assigned in LMS
        if not shift:
            continue
        weekend_matrix = shift.get("weekend_matrix")
        result[sid] = {
            "weekoffs": compute_weekoff_dates(weekend_matrix, from_date, to_date),
            "weekend_matrix": weekend_matrix,
            "week_config": shift.get("week_config"),
        }
    return result
