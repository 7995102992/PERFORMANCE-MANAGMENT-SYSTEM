"""
Runtime validation engine for leave requests.
Checks: policy rules, balance, overlaps, holiday exclusion, rounding.
"""

import math
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from bson import ObjectId
from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.exceptions import DomainException

# A zero-duration span is explained by walking it day by day; cap the walk so a
# mistyped multi-year range can't fan out into thousands of calendar lookups.
_ZERO_DURATION_SCAN_LIMIT = 62


def _format_day(value: date) -> str:
    return value.strftime("%d %b %Y")


async def _explain_zero_duration(
    db: AsyncIOMotorDatabase,
    user_id: str,
    start_date: date,
    end_date: date,
    raw_hours: float,
    rounding: str,
    leave_type: dict,
) -> str:
    """Say that the request is BLOCKED and why, instead of describing the maths.

    "Leave duration must be greater than zero after rounding" is accurate and
    useless: the overwhelmingly common cause is that every selected day is a
    weekend or a holiday on the employee's own work calendar, which the sentence
    never mentions — and rounding usually had nothing to do with it.

    Every branch leads with "<Type> cannot be applied …" so the employee knows
    the request is refused, not merely that it would deduct nothing, and closes
    with what to do instead.
    """
    from src.work_calendar.resolver import is_working_day

    type_name = leave_type.get("name") or "This leave type"

    # raw_hours > 0 means the span DID contain working time and rounding is
    # genuinely the culprit — the only case the original wording described.
    if raw_hours > 0:
        return (
            f"{type_name} cannot be applied for these dates — they come to "
            f"{raw_hours / 8.0:.2f} day(s), which the plan's '{rounding}' rounding "
            "reduces to zero. Select a longer period."
        )

    # raw_hours == 0: every day in the span was skipped. Walk it and report why.
    holidays: list[str] = []
    weekend_count = 0
    scanned = 0
    day = start_date
    while day <= end_date and scanned < _ZERO_DURATION_SCAN_LIMIT:
        info = await is_working_day(db, user_id, day)
        reason = info.get("reason")
        if reason == "NO_CALENDAR_RESOLVED":
            return (
                f"{type_name} cannot be applied — no work calendar is assigned to you, "
                "so working days cannot be determined. Ask HR to assign you to a work "
                "calendar."
            )
        if reason in ("DATE_BEFORE_CALENDAR_PERIOD", "DATE_AFTER_CALENDAR_PERIOD"):
            return (
                f"{type_name} cannot be applied on {_format_day(day)} — it falls outside "
                "the period covered by your work calendar. Pick a date inside it, or ask "
                "HR to publish the calendar for that year."
            )
        if info.get("is_holiday"):
            holidays.append(info.get("holiday_name") or _format_day(day))
        elif info.get("is_weekend") or info.get("is_weekend_slot"):
            weekend_count += 1
        day += timedelta(days=1)
        scanned += 1

    # Statutory types charge every calendar day, so they never reach this branch —
    # "only counts working days" is the distinction that explains why this one did.
    single_day = start_date == end_date
    lead = f"{type_name} cannot be applied"
    single_tail = (
        f" {type_name} only counts working days, so pick a working day."
    )
    range_tail = (
        f" {type_name} only counts working days, so pick a range that includes at "
        "least one working day."
    )

    if single_day:
        when = _format_day(start_date)
        if holidays:
            return (
                f"{lead} on {when} — it is a holiday ({holidays[0]}) on your work "
                f"calendar.{single_tail}"
            )
        if weekend_count:
            return (
                f"{lead} on {when} — it is a non-working day on your work "
                f"calendar.{single_tail}"
            )
        return (
            f"{lead} on {when} — it is not a working day on your work "
            f"calendar.{single_tail}"
        )

    span = f"{_format_day(start_date)} – {_format_day(end_date)}"
    if holidays and weekend_count:
        return (
            f"{lead} for {span} — every day in that range is a weekend or a holiday "
            f"on your work calendar.{range_tail}"
        )
    if holidays:
        return (
            f"{lead} for {span} — every day in that range is a holiday on your work "
            f"calendar ({', '.join(dict.fromkeys(holidays))}).{range_tail}"
        )
    return (
        f"{lead} for {span} — every day in that range is a non-working day on your "
        f"work calendar.{range_tail}"
    )


def _apply_rounding(hours: float, mode: str, unit: str) -> float:
    """Round a leave request's charged hours per the fractional_balance ``mode``.

    Rounding is applied at DAY granularity (the unit employees see): half-day modes
    snap to 0.5-day boundaries, ``nearest_one`` to whole days. ``mode`` uses the
    FractionRoundingMode vocabulary (exact / nearest_half / nearest_one / round_up /
    round_down). Only meaningful for DAYS-unit leave; hourly leave is returned as-is.

    (The accrual side — processor._round_hours — rounds on the hours value at 0.5h
    granularity; requests round at day granularity because that's the unit the
    duration and the cap are expressed in. Both read the same fractional_balance.mode.)
    """
    if unit != "DAYS":
        return hours
    days = hours / 8.0
    if mode == "nearest_half":
        days = round(days * 2) / 2
    elif mode == "nearest_one":
        days = round(days)
    elif mode == "round_up":
        days = math.ceil(days * 2) / 2
    elif mode == "round_down":
        days = math.floor(days * 2) / 2
    # "exact" (and anything unrecognised) → no rounding.
    return days * 8.0


async def _count_working_days(
    db: AsyncIOMotorDatabase,
    start_date: date,
    end_date: date,
    user_id: str,
    include_weekends: bool = False,
) -> int:
    """Count chargeable days between two dates (inclusive).

    Normally only working days are counted (weekends and holidays are skipped).
    When ``include_weekends`` is True (Loss of Pay — see ``should_count_weekends_for_lop``)
    weekend days are also counted, but public holidays are still skipped.
    """
    from src.work_calendar.resolver import is_working_day as _is_working_day

    working_days = 0
    current = start_date
    while current <= end_date:
        result = await _is_working_day(db, user_id, current)
        reason = result.get("reason")
        # When no calendar is configured, fall back to counting the day as working
        if result["is_working_day"] or reason == "NO_CALENDAR_RESOLVED":
            working_days += 1
        elif include_weekends and reason == "WEEKEND":
            working_days += 1
        current += timedelta(days=1)
    return working_days


async def _working_day_list(
    db: AsyncIOMotorDatabase,
    start_date: date,
    end_date: date,
    user_id: str,
) -> list[date]:
    """The chargeable (working) days in [start_date, end_date] inclusive.

    Mirrors ``_count_working_days`` but returns the actual dates — used by the
    comp-off validator to pair each leave day with a worked day. Days with no
    calendar configured fall back to "counts as working", consistent with how
    the charge is computed.
    """
    from src.work_calendar.resolver import is_working_day as _is_working_day

    days: list[date] = []
    current = start_date
    while current <= end_date:
        result = await _is_working_day(db, user_id, current)
        if result["is_working_day"] or result.get("reason") == "NO_CALENDAR_RESOLVED":
            days.append(current)
        current += timedelta(days=1)
    return days


async def validate_comp_off_worked_days(
    db: AsyncIOMotorDatabase,
    user_id: str,
    worked_dates: list[date],
    leave_days: list[date],
    expiry_days: Optional[int],
    today: date,
) -> None:
    """Validate the worked (compensated) days for an expiring / comp-off leave.

    An expiring leave carries no balance: each requested leave day must point to
    one non-working day the employee actually worked, and be taken within the
    type's expiry window of that worked day. Rules:

      * one worked day per chargeable leave day (1:1), no duplicates
      * each worked day is in the past and is a genuine non-working day
        (weekend/holiday) — verified against the work calendar when one exists
      * pairing earliest worked day with earliest leave day, each leave day
        falls AFTER its worked day and within ``expiry_days`` of it
    """
    from src.work_calendar.resolver import is_working_day as _is_working_day

    if not worked_dates:
        raise DomainException(
            message="Select the day(s) you worked that this leave compensates",
            code="COMP_OFF_WORKED_DAYS_REQUIRED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if len(set(worked_dates)) != len(worked_dates):
        raise DomainException(
            message="The same worked day cannot be selected more than once",
            code="COMP_OFF_DUPLICATE_WORKED_DAY",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if len(worked_dates) != len(leave_days):
        raise DomainException(
            message=(
                f"Point to exactly {len(leave_days)} worked day(s) — one for each "
                f"leave day requested"
            ),
            code="COMP_OFF_WORKED_DAYS_COUNT_MISMATCH",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if expiry_days is None or expiry_days <= 0:
        raise DomainException(
            message="This leave type is misconfigured: its expiry window is not set",
            code="COMP_OFF_EXPIRY_NOT_CONFIGURED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    for wd in worked_dates:
        if wd > today:
            raise DomainException(
                message=f"Worked day {wd.isoformat()} cannot be in the future",
                code="COMP_OFF_WORKED_DAY_IN_FUTURE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        res = await _is_working_day(db, user_id, wd)
        # Only enforce the non-working requirement when a calendar actually
        # resolved the day; with no calendar we can't tell, so we don't block.
        if res.get("reason") != "NO_CALENDAR_RESOLVED" and res.get("is_working_day"):
            raise DomainException(
                message=(
                    f"{wd.isoformat()} is a working day — this leave can only "
                    f"compensate a weekend/holiday you actually worked"
                ),
                code="COMP_OFF_WORKED_DAY_NOT_OFF_DAY",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    for wd, ld in zip(sorted(worked_dates), sorted(leave_days)):
        if ld <= wd:
            raise DomainException(
                message="A comp-off leave day must fall after the day you worked",
                code="COMP_OFF_LEAVE_BEFORE_WORKED_DAY",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if (ld - wd).days > expiry_days:
            raise DomainException(
                message=(
                    f"Comp-off must be taken within {expiry_days} day(s) of the "
                    f"worked day — {ld.isoformat()} is past the expiry of "
                    f"{wd.isoformat()}"
                ),
                code="COMP_OFF_EXPIRED",
                status_code=status.HTTP_400_BAD_REQUEST,
            )


async def _count_consecutive_days(
    db: AsyncIOMotorDatabase,
    start_date: date,
    end_date: date,
    user_id: str,
    include_weekends: bool,
    include_holidays: bool,
) -> float:
    """Length of the leave span for the continuous-leave-limit check.

    Working days (and days with no calendar) always count. Weekends count only
    when ``include_weekends`` is set; holidays only when ``include_holidays`` is
    set — so the configured flags decide whether the gap days inside a long leave
    extend the "consecutive days" total.
    """
    from src.work_calendar.resolver import is_working_day as _is_working_day

    # Only days with NO calendar configured fall back to "counts as a span day" —
    # matching how the charge (_count_working_days) treats them, so the consecutive
    # span can never exceed the chargeable span. Dates OUTSIDE the calendar's
    # effective period are not charged, so they don't extend the span either.
    count = 0
    current = start_date
    while current <= end_date:
        res = await _is_working_day(db, user_id, current)
        reason = res.get("reason")
        # A weekend day that ALSO happens to be a holiday is reported is_weekend=False
        # (holiday precedence), so read the raw weekend-slot membership instead — else
        # such a day is silently dropped from the span when weekends should count.
        is_weekend = bool(res.get("is_weekend") or res.get("is_weekend_slot"))
        if res.get("is_working_day") or reason == "NO_CALENDAR_RESOLVED":
            count += 1
        elif include_weekends and is_weekend:
            count += 1
        elif include_holidays and res.get("is_holiday"):
            count += 1
        current += timedelta(days=1)
    return count


async def _portion_in_month(
    db: AsyncIOMotorDatabase,
    user_id: str,
    span_start: date,
    span_end: date,
    total_days: float,
    include_weekends: bool,
    month_first: date,
    month_last: date,
) -> float:
    """How many of ``total_days`` fall inside [month_first, month_last].

    A leave can straddle month boundaries; the monthly-limit check must charge each
    month only the portion that actually lands in it. We split ``total_days`` (the
    stored/charged duration, which already reflects any sandwich/rounding) by the
    share of *working* days inside the month — the same working-day primitive the
    charge itself is built on — so the parts sum back to the whole.
    """
    overlap_start = max(span_start, month_first)
    overlap_end = min(span_end, month_last)
    if overlap_start > overlap_end:
        return 0.0
    total_wd = await _count_working_days(db, span_start, span_end, user_id, include_weekends)
    if total_wd <= 0:
        # Whole span is non-working (degenerate); attribute the full charge to the
        # month containing the start so it isn't silently dropped.
        return total_days if month_first <= span_start <= month_last else 0.0
    in_wd = await _count_working_days(db, overlap_start, overlap_end, user_id, include_weekends)
    return total_days * (in_wd / total_wd)


def _month_windows(span_start: date, span_end: date):
    """Yield (first_of_month_date, last_of_month_date) for every calendar month the
    span [span_start, span_end] touches."""
    windows = []
    m = span_start.replace(day=1)
    while m <= span_end:
        if m.month == 12:
            nxt = m.replace(year=m.year + 1, month=1)
        else:
            nxt = m.replace(month=m.month + 1)
        windows.append((m, nxt - timedelta(days=1)))
        m = nxt
    return windows


async def should_count_weekends_for_lop(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: str,
    leave_type: Optional[dict],
    *,
    loss_of_pay: bool = False,
    allow_negative_balance: bool = False,
    balance_hours: Optional[float] = None,
) -> bool:
    """Decide whether the leave is unpaid Loss of Pay (weekends are charged for LOP).

    A leave is LOP only when it is *explicitly* unpaid:
      * the request is explicitly flagged loss_of_pay, or
      * the leave type itself is unpaid (``is_paid`` False — the dedicated LOP /
        Unpaid Leave type).

    PRODUCT DECISION (confirmed): a paid, balance-deducting type is NEVER silently
    auto-converted to unpaid LOP when its balance is exhausted. Instead the request
    is blocked with INSUFFICIENT_BALANCE, and the employee must explicitly apply
    under the dedicated unpaid (is_paid=False) leave type to take Loss of Pay. So an
    exhausted paid balance returns False here, which lets the balance-sufficiency
    check run and reject the request.

    ``allow_negative_balance`` / ``balance_hours`` are retained for the callers'
    signature but no longer drive an auto-LOP decision (extra-leave handles the
    paid-buffer case separately, in the balance-sufficiency check).
    """
    if loss_of_pay:
        return True
    # A leave type is unpaid (→ weekends charged as LOP) when EITHER paid flag is
    # off. `is_paid` and `is_paid_leave` are redundant duplicates that the form/
    # schema keep in sync, but different code historically read different ones —
    # checking both here is divergence-proof: an unpaid type is never missed no
    # matter which flag an import/migration happened to set.
    if leave_type is not None and (
        not leave_type.get("is_paid", True)
        or not leave_type.get("is_paid_leave", True)
    ):
        return True
    return False


async def _compute_duration_hours(
    db: AsyncIOMotorDatabase,
    start: datetime,
    end: datetime,
    employee_id: str,
    org_id: Optional[str],
    leave_type_unit: str,
) -> float:
    if start >= end:
        raise DomainException(
            message="end_datetime must be after start_datetime",
            code="INVALID_LEAVE_DATES",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if leave_type_unit == "HOURS":
        delta = end - start
        return delta.total_seconds() / 3600.0

    working_days = await _count_working_days(db, start.date(), end.date(), employee_id)
    return working_days * 8.0


async def compute_duration_for_mode(
    db: AsyncIOMotorDatabase,
    start_date: date,
    end_date: date,
    user_id: str,
    duration_mode: str,
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
    count_calendar_days: bool = False,
    include_weekends: bool = False,
) -> float:
    """Return duration in hours based on the chosen duration mode.

    When ``count_calendar_days`` is True (e.g. Maternity / Paternity leave), the
    day count includes weekends and holidays — every calendar day from start to
    end inclusive — instead of only working days resolved from the work calendar.

    When ``include_weekends`` is True (Loss of Pay), weekends are added to the
    working-day count but public holidays are still excluded.
    """
    async def _is_working(d: date) -> bool:
        if count_calendar_days:
            return True
        return bool(await _count_working_days(db, d, d, user_id, include_weekends=include_weekends))

    if duration_mode == "HALF_DAY":
        # A half-day must land on a GENUINE working day (unless the type counts
        # calendar days). On a weekend/holiday there's nothing to charge — return 0
        # so the caller raises ZERO_DURATION, consistent with FULL_DAYS. (Audit B)
        # Use include_weekends=False here regardless of LOP: a half-day on a weekend
        # must be blocked even for unpaid/LOP leave (the LOP weekend extension only
        # governs FULL_DAYS charging, not whether a partial day is valid).
        if count_calendar_days:
            return 4.0
        genuinely_working = bool(
            await _count_working_days(db, start_date, start_date, user_id, include_weekends=False)
        )
        return 4.0 if genuinely_working else 0.0

    async def _day_count(s: date, e: date) -> int:
        if count_calendar_days:
            return (e - s).days + 1
        return await _count_working_days(db, s, e, user_id, include_weekends=include_weekends)

    if duration_mode == "CUSTOM":
        days = await _day_count(start_date, end_date)
        total_hours = days * 8.0
        # Trim the untaken portion of the start/end days — but only when that day is
        # actually a counted working day, otherwise we'd subtract against a different
        # day's hours. (A partial leave whose only day is non-working → 0 → ZERO_DURATION.)
        if start_session == "SECOND_HALF" and await _is_working(start_date):
            total_hours -= 4.0  # start from afternoon, morning not counted
        if end_session == "FIRST_HALF" and await _is_working(end_date):
            total_hours -= 4.0  # end at noon, afternoon not counted
        return max(total_hours, 0.0)

    # FULL_DAYS
    days = await _day_count(start_date, end_date)
    return days * 8.0


def dates_to_datetimes(
    start_date: date,
    end_date: date,
    duration_mode: str,
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
) -> tuple[datetime, datetime]:
    """
    Convert date + mode to concrete UTC datetimes used for overlap detection and storage.
    Uses midnight boundaries: FIRST_HALF = 00:00-12:00 UTC, SECOND_HALF = 12:00-00:00 UTC.
    """
    tz = timezone.utc

    if duration_mode == "HALF_DAY":
        d = datetime(start_date.year, start_date.month, start_date.day, tzinfo=tz)
        if half_day_period == "FIRST_HALF":
            return d, d.replace(hour=12)
        else:  # SECOND_HALF
            return d.replace(hour=12), d + timedelta(days=1)

    if duration_mode == "CUSTOM":
        start_hour = 0 if start_session == "FIRST_HALF" else 12
        if end_session == "FIRST_HALF":
            end_dt = datetime(end_date.year, end_date.month, end_date.day, 12, tzinfo=tz)
        else:
            end_dt = datetime(end_date.year, end_date.month, end_date.day, tzinfo=tz) + timedelta(days=1)
        start_dt = datetime(start_date.year, start_date.month, start_date.day, start_hour, tzinfo=tz)
        return start_dt, end_dt

    # FULL_DAYS
    start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=tz)
    end_dt = datetime(end_date.year, end_date.month, end_date.day, tzinfo=tz) + timedelta(days=1)
    return start_dt, end_dt


def _get_period_bounds(now: datetime, period: str) -> tuple[datetime, datetime]:
    """Return (period_start, period_end) for the current period containing `now`."""
    if period == "monthly":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if now.month == 12:
            end = start.replace(year=now.year + 1, month=1)
        else:
            end = start.replace(month=now.month + 1)
        return start, end
    elif period == "quarterly":
        quarter = (now.month - 1) // 3
        start_month = quarter * 3 + 1
        start = now.replace(month=start_month, day=1, hour=0, minute=0, second=0, microsecond=0)
        end_month = start_month + 3
        if end_month > 12:
            end = start.replace(year=now.year + 1, month=end_month - 12)
        else:
            end = start.replace(month=end_month)
        return start, end
    else:  # yearly or default
        start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        end = start.replace(year=now.year + 1)
        return start, end


async def _compute_sandwich_extra_hours(
    db: AsyncIOMotorDatabase,
    user_id: str,
    start_date: date,
    end_date: date,
    sandwich_cfg: dict,
    duration_mode: str,
    duration_days: float,
    exclude_request_id: Optional[str] = None,
) -> float:
    """Extra hours to charge for non-working days "sandwiched" by leave days.

    When the sandwich policy is enabled, weekends/holidays bracketed by leave
    days are charged as leave too, per ``apply_rule_when``:
      * between_two_leave_days / between_two_holidays — leave on BOTH sides
      * before_a_leave_day  — a leave day immediately AFTER the gap
      * after_a_leave_day   — a leave day immediately BEFORE the gap
      * before_or_after_leave_day — either side

    Considers this request's own span AND the employee's other PENDING/APPROVED
    leave days (any type), so a Fri-request + Mon-request still sandwiches the
    weekend. Only gaps that touch THIS request are charged (so it doesn't bill a
    run sitting entirely between two unrelated requests). ``minimum_consecutive_value``
    gates on the bridged block length; ``ignore_half_day_leaves`` skips half days.
    """
    if not sandwich_cfg or not sandwich_cfg.get("enabled"):
        return 0.0
    ignore_half = sandwich_cfg.get("ignore_half_day_leaves", True)
    if ignore_half and (duration_mode == "HALF_DAY" or duration_days < 1):
        return 0.0

    rule = sandwich_cfg.get("apply_rule_when")
    min_value = sandwich_cfg.get("minimum_consecutive_value") or 0
    min_unit = sandwich_cfg.get("minimum_consecutive_unit") or "days"
    min_days = min_value if min_unit == "days" else (min_value / 8.0)

    from src.work_calendar.resolver import is_working_day as _is_working_day

    _cache: dict[date, bool] = {}

    async def _working(d: date) -> bool:
        if d not in _cache:
            res = await _is_working_day(db, user_id, d)
            _cache[d] = bool(res["is_working_day"]) or res.get("reason") == "NO_CALENDAR_RESOLVED"
        return _cache[d]

    window = timedelta(days=5)
    win_start = start_date - window
    win_end = end_date + window

    # This request's own leave days (working days within its span).
    own_days: set[date] = set()
    d = start_date
    while d <= end_date:
        if await _working(d):
            own_days.add(d)
        d += timedelta(days=1)
    if not own_days:
        return 0.0

    # Other PENDING/APPROVED leave days in the window (any leave type).
    win_start_dt = datetime(win_start.year, win_start.month, win_start.day, tzinfo=timezone.utc)
    win_end_dt = datetime(win_end.year, win_end.month, win_end.day, tzinfo=timezone.utc) + timedelta(days=1)
    other_query: dict = {
        "user_id": ObjectId(user_id),
        "status": {"$in": ["PENDING", "APPROVED"]},
        "deleted_on": None,
        "start_datetime": {"$lt": win_end_dt},
        "end_datetime": {"$gt": win_start_dt},
    }
    if exclude_request_id:
        other_query["_id"] = {"$ne": ObjectId(exclude_request_id)}
    others = await db["leave_requests"].find(other_query).to_list(length=None)

    leave_days: set[date] = set(own_days)
    for o in others:
        o_days_val = o.get("duration_days") or (o.get("duration_hours", 0) / 8.0)
        if ignore_half and o_days_val < 1:
            continue
        try:
            o_start = date.fromisoformat(o["start_date"])
            o_end = date.fromisoformat(o["end_date"])
        except Exception:
            continue
        dd = max(o_start, win_start)
        o_end_clamped = min(o_end, win_end)
        while dd <= o_end_clamped:
            if await _working(dd):
                leave_days.add(dd)
            dd += timedelta(days=1)

    def _is_leave(d: date) -> bool:
        return d in leave_days

    # Scan maximal runs of non-working, non-leave days and charge the qualifying ones.
    charged = 0
    d = win_start
    while d <= win_end:
        if await _working(d) or _is_leave(d):
            d += timedelta(days=1)
            continue
        run_start = d
        run_len = 0
        while d <= win_end and not (await _working(d)) and not _is_leave(d):
            run_len += 1
            d += timedelta(days=1)
        run_end = run_start + timedelta(days=run_len - 1)
        left = run_start - timedelta(days=1)
        right = run_end + timedelta(days=1)
        has_left = _is_leave(left)
        has_right = _is_leave(right)

        # Only charge gaps that touch THIS request.
        if left not in own_days and right not in own_days:
            continue

        if rule in ("between_two_leave_days", "between_two_holidays"):
            qualifies = has_left and has_right
        elif rule == "before_a_leave_day":
            qualifies = has_right
        elif rule == "after_a_leave_day":
            qualifies = has_left
        elif rule == "before_or_after_leave_day":
            qualifies = has_left or has_right
        else:
            qualifies = has_left and has_right
        if not qualifies:
            continue

        # Minimum bridged-block length (leave days on both flanks + the gap).
        block = run_len
        ld = left
        while _is_leave(ld):
            block += 1
            ld -= timedelta(days=1)
        rd = right
        while _is_leave(rd):
            block += 1
            rd += timedelta(days=1)
        if block < min_days:
            continue

        charged += run_len

    return charged * 8.0


async def validate_and_compute(
    db: AsyncIOMotorDatabase,
    user_id: str,
    leave_type_id: str,
    start: datetime,
    end: datetime,
    policy: dict,
    leave_type: dict,
    *,
    loss_of_pay: bool = False,
    duration_mode: str = "FULL_DAYS",
    half_day_period: Optional[str] = None,
    start_session: Optional[str] = None,
    end_session: Optional[str] = None,
    exclude_request_id: Optional[str] = None,
    projected_balance_hours: Optional[float] = None,
    lop_balance_hours: Optional[float] = None,
) -> float:
    """
    Run all policy validations and return the final duration in hours.
    Raises DomainException on any violation.
    """
    # Extract nested entitlement config sections from the policy document.
    # The leave type now owns its policy ("the leave type IS the policy"), so
    # overlay any per-type sections on top of the plan entitlement: a section
    # the type defines governs that type, the plan stays the fallback for
    # sections (and legacy types) that don't.
    entitlement = dict(policy.get("entitlement") or {})
    lt_policies = (leave_type or {}).get("policies") or {}
    for section, value in lt_policies.items():
        if value is not None:
            entitlement[section] = value

    # Negative balance (the complex auto/approval feature) is disabled product-wide.
    # "Extra leave" is the lightweight replacement: when ALLOWED, an employee may
    # apply up to max_days BEYOND their balance (a simple capped buffer).
    continuous_cfg = entitlement.get("continuous_limit") or {}
    monthly_cfg = entitlement.get("monthly_limit") or {}
    req_limits_cfg = entitlement.get("request_limits") or {}
    clubbing_cfg = entitlement.get("clubbing") or {}
    backdated_cfg = entitlement.get("backdated_leave") or {}
    future_cfg = entitlement.get("future_request") or {}
    extra_cfg = entitlement.get("extra_leave") or {}
    extra_days = (extra_cfg.get("max_days") or 0) if extra_cfg.get("status") == "ALLOWED" else 0

    if start >= end:
        raise DomainException(
            message="end_datetime must be after start_datetime",
            code="INVALID_LEAVE_DATES",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    now_utc = datetime.now(timezone.utc)
    today = now_utc.date()

    # --- Current-year restriction ---
    # Reject BOTH future and prior years: balance/accruals are leave-year scoped, so
    # a prior-year leave would debit the wrong year's balance. (Audit B — previously
    # only future years were blocked, so prior-year leave slipped through.)
    if start.date().year != today.year:
        raise DomainException(
            message="Leave requests can only be submitted for the current year",
            code="LEAVE_YEAR_OUT_OF_RANGE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # --- Days-only: hourly leave is not supported product-wide ---
    if str(leave_type.get("unit", "DAYS")).upper() == "HOURS":
        raise DomainException(
            message="Hourly leave is not supported; configure this leave type in days",
            code="HOURS_UNIT_NOT_SUPPORTED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # --- Future-dated request gate ---
    # When the policy explicitly disallows future requests, reject any leave that
    # starts after today. Left untouched (allowed) when the config is absent.
    if future_cfg.get("allow_future_requests") is False and start.date() > today:
        raise DomainException(
            message="Future-dated leave requests are not allowed under this policy",
            code="FUTURE_REQUEST_NOT_ALLOWED",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    # --- Backdated (past-dated) leave gate ---
    # When backdated leave is DISABLED, past-dated requests are rejected outright
    # (the toggle being off means "no backdating allowed"). When ENABLED, past dates
    # are permitted but must be submitted within max_days of the absence date when a
    # deadline is configured (no deadline = any past date allowed).
    if start.date() < today:
        if not backdated_cfg.get("enabled"):
            raise DomainException(
                message="Backdated (past-dated) leave requests are not allowed under this policy",
                code="BACKDATED_LEAVE_NOT_ALLOWED",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        # Statutory leave is EXEMPT from the submission deadline. Maternity is
        # routinely filed after the birth, and paternity after the fact — a 7-day
        # window would make both unusable for their actual purpose. The `enabled`
        # toggle above is still honoured: an admin who switches backdating off
        # blocks every type, statutory included.
        max_deadline = backdated_cfg.get("max_days")
        if max_deadline is not None and not leave_type.get("is_statutory_leave"):
            days_since_absence = (today - start.date()).days
            if days_since_absence > max_deadline:
                raise DomainException(
                    message=(
                        f"Backdated leave deadline exceeded — requests must be submitted "
                        f"within {max_deadline} day(s) of the absence date"
                    ),
                    code="BACKDATED_LEAVE_DEADLINE_EXCEEDED",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )

    # --- Duration calculation ---
    unit = leave_type.get("unit", "DAYS")
    # dates_to_datetimes sets end to midnight of (end_date + 1) for FULL_DAYS and
    # CUSTOM/SECOND_HALF; subtract one day back so duration counts only up to the real end_date.
    if duration_mode == "HALF_DAY":
        # A half-day leave is always a single calendar day. (SECOND_HALF sets end to
        # midnight of start+1, so without this the span counters would count 2 days.)
        duration_end_date = start.date()
    elif duration_mode == "FULL_DAYS" or (duration_mode == "CUSTOM" and end_session != "FIRST_HALF"):
        duration_end_date = end.date() - timedelta(days=1)
    else:
        duration_end_date = end.date()

    # Loss of Pay rule: when the leave is effectively unpaid (exhausted balance
    # or an unpaid leave type) weekends are charged too; with balance remaining
    # only working days count.
    # LOP is decided on the RAW projected balance (lop_balance_hours) — pending
    # holds must not flip a new request to unpaid. Sufficiency (below) still uses
    # the available (hold-netted) projected_balance_hours. Falls back to the
    # available figure only when the caller didn't supply a separate raw value.
    include_weekends = await should_count_weekends_for_lop(
        db,
        user_id,
        leave_type_id,
        leave_type,
        loss_of_pay=loss_of_pay,
        # When "extra leave" is allowed the employee may go negative (paid) up to
        # max_days, so it isn't LOP within that buffer. With no extra buffer an
        # exhausted balance still converts to unpaid LOP below.
        allow_negative_balance=(extra_days > 0),
        balance_hours=(lop_balance_hours if lop_balance_hours is not None else projected_balance_hours),
    )

    # Statutory leave runs as one continuous block: every calendar day in the
    # span is charged (weekends + holidays), regardless of the stored flag — so
    # a statutory type created without count_calendar_days still counts weekends.
    count_calendar_days = bool(
        leave_type.get("count_calendar_days", False)
        or leave_type.get("is_statutory_leave", False)
    )

    # --- Unpaid leave must overlap a working day ---
    # Loss of Pay charges every day in the span, weekends included, so a span made
    # up only of weekends passes the zero-duration check below with a non-zero
    # duration — Sunday alone billed a full day. But LOP is a deduction from pay
    # for a day the employee was rostered and absent; a day nobody was scheduled
    # to work has no pay to dock. Weekends are charged when they sit INSIDE an
    # absence (Fri–Sun = 3), never as the whole of it.
    # Statutory types are exempt: they legitimately run as a continuous calendar
    # block that can start or end on a weekend.
    if include_weekends and not count_calendar_days:
        working_days = await _count_working_days(
            db, start.date(), duration_end_date, user_id, include_weekends=False
        )
        if working_days == 0:
            type_name = leave_type.get("name") or "Unpaid leave"
            single_day = start.date() == duration_end_date
            when = (
                f"on {_format_day(start.date())}"
                if single_day
                else f"for {_format_day(start.date())} – {_format_day(duration_end_date)}"
            )
            subject = "it is" if single_day else "every day in that range is"
            raise DomainException(
                message=(
                    f"{type_name} cannot be applied {when} — {subject} a non-working day "
                    f"on your work calendar. {type_name} is a deduction from pay, so the "
                    "request must cover at least one working day."
                ),
                code="LOP_WITHOUT_WORKING_DAY",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    raw_hours = await compute_duration_for_mode(
        db,
        start.date(),
        duration_end_date,
        user_id,
        duration_mode,
        half_day_period,
        start_session,
        end_session,
        count_calendar_days=count_calendar_days,
        include_weekends=include_weekends,
    )

    # Fractional rounding mode lives at entitlement.fractional_balance.mode (read
    # from the merged `entitlement`, so a per-leave-type override is honoured).
    frac_cfg = entitlement.get("fractional_balance") or {}
    rounding = frac_cfg.get("mode") or "exact"
    # Don't apply rounding to partial-day modes — they have fixed durations
    if duration_mode == "FULL_DAYS":
        duration_hours = _apply_rounding(raw_hours, rounding, unit)
    else:
        duration_hours = raw_hours

    if duration_hours <= 0:
        raise DomainException(
            message=await _explain_zero_duration(
                db,
                user_id,
                start.date(),
                duration_end_date,
                raw_hours,
                rounding,
                leave_type,
            ),
            code="ZERO_DURATION",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    duration_days = duration_hours / 8.0

    # --- Sandwich leave: charge non-working days bracketed by leave days ---
    # Skip when weekends are already being counted (LOP) or the type counts
    # calendar days (Maternity / Paternity / statutory), to avoid double-charging.
    if not include_weekends and not count_calendar_days:
        plan_oid = policy.get("leave_plan_id")
        sandwich_cfg = None
        if plan_oid is not None:
            from src.utils import to_oid as _to_oid

            sandwich_cfg = await db["leave_sandwich_policies"].find_one(
                {"leave_plan_id": _to_oid(str(plan_oid))}
            )
        sandwich_extra = await _compute_sandwich_extra_hours(
            db,
            user_id,
            start.date(),
            duration_end_date,
            sandwich_cfg or {},
            duration_mode,
            duration_days,
            exclude_request_id,
        )
        if sandwich_extra:
            duration_hours += sandwich_extra
            duration_days = duration_hours / 8.0

    # --- Continuous leave limit (from continuous_limit config) ---
    # Statutory leave is EXEMPT. Its length is fixed by law and carried on the
    # leave type as max_statutory_days (182 days for maternity, 15 for
    # paternity), and it must run as one continuous block. A plan-level
    # consecutive-day cap cannot override that — with the cap at 15 days, no
    # maternity leave could be applied for at all, making the type unusable.
    #
    # This does NOT make statutory leave unbounded: the accrual engine credits
    # exactly max_statutory_days as the balance for these types, so the ceiling
    # is enforced by the balance-sufficiency check (a 31-day paternity request
    # against a 15-day entitlement fails with INSUFFICIENT_BALANCE).
    if continuous_cfg.get("enabled") and not leave_type.get("is_statutory_leave"):
        max_consecutive = continuous_cfg.get("max_consecutive_days")
        if max_consecutive is not None:
            # Count the leave SPAN (working days, plus weekends/holidays only when
            # the flags say so). This is independent of the charged duration, so a
            # sandwich-charged weekend doesn't silently inflate the consecutive
            # count — the include_weekends/include_holidays flags alone decide.
            #
            # INTENTIONAL (product decision, confirmed): continuous_limit and the
            # sandwich charge are SEPARATE knobs. A Fri-Mon leave can be CHARGED 4
            # days (sandwich) while counting as a 2-day span here when
            # include_weekends is off. To make the span match the sandwich charge,
            # the admin ticks include_weekends on the continuous config. Do NOT wire
            # the span to the sandwich policy automatically.
            consecutive_days = await _count_consecutive_days(
                db, start.date(), duration_end_date, user_id,
                bool(continuous_cfg.get("include_weekends")),
                bool(continuous_cfg.get("include_holidays")),
            )
            if consecutive_days > max_consecutive:
                raise DomainException(
                    message=f"Maximum consecutive leave days allowed is {max_consecutive}",
                    code="EXCEEDS_MAX_CONSECUTIVE",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )

    # --- Monthly leave limit (enforced PER calendar month the leave touches) ---
    # A request can span several months. Check EACH month it touches against that
    # month's cap, charging each month only the portion of this request — and of
    # every existing request — that actually falls in that month (not the whole
    # span). This stops the end-month's cap from being silently bypassed and stops
    # cross-month neighbours from being over-counted.
    if monthly_cfg.get("enabled"):
        max_per_month = monthly_cfg.get("max_days_per_month")
        if max_per_month is not None:
            req_start_date = start.date()
            req_end_date = duration_end_date
            for month_first, month_last in _month_windows(req_start_date, req_end_date):
                this_portion = await _portion_in_month(
                    db, user_id, req_start_date, req_end_date, duration_days,
                    include_weekends, month_first, month_last,
                )
                if this_portion <= 0:
                    continue

                month_start = datetime(
                    month_first.year, month_first.month, 1, tzinfo=timezone.utc
                )
                month_end = datetime(
                    month_last.year, month_last.month, month_last.day,
                    tzinfo=timezone.utc,
                ) + timedelta(days=1)

                monthly_query: dict = {
                    "user_id": ObjectId(user_id),
                    "leave_type_id": ObjectId(leave_type_id),
                    "status": {"$in": ["PENDING", "APPROVED"]},
                    "deleted_on": None,
                    "start_datetime": {"$lt": month_end},
                    "end_datetime": {"$gt": month_start},
                }
                if exclude_request_id:
                    monthly_query["_id"] = {"$ne": ObjectId(exclude_request_id)}
                existing_docs = await db["leave_requests"].find(monthly_query).to_list(length=None)

                existing_days = 0.0
                for d in existing_docs:
                    d_total = d.get("duration_days") or (d.get("duration_hours", 0) / 8.0)
                    d_start = d["start_datetime"].date()
                    # Stored end_datetime is the exclusive upper bound (midnight after
                    # the last leave day); step back an instant for the inclusive date.
                    d_end = (d["end_datetime"] - timedelta(seconds=1)).date()
                    # Count weekends in the per-month portion ONLY for existing LOP
                    # leaves (they charged weekend days), matching how each was
                    # actually deducted — a hardcoded False under-counted weekend-
                    # spanning LOP leaves and let the monthly cap be exceeded.
                    existing_days += await _portion_in_month(
                        db, user_id, d_start, d_end, d_total,
                        bool(d.get("loss_of_pay")), month_first, month_last,
                    )

                if existing_days + this_portion > max_per_month:
                    raise DomainException(
                        message=(
                            f"Monthly leave limit of {max_per_month} day(s) would be exceeded "
                            f"for {month_first.strftime('%B %Y')}. "
                            f"Already used: {existing_days:.2f} day(s) that month"
                        ),
                        code="EXCEEDS_MONTHLY_LIMIT",
                        status_code=status.HTTP_400_BAD_REQUEST,
                    )

    # --- Max requests per period ---
    # This is a SUBMISSION-rate throttle: it counts how many requests were FILED
    # (created_on) in the current period, matching the UI label "Max Requests
    # Allowed Per Period". It is deliberately distinct from monthly_limit, which
    # caps leave DAYS by the leave's own date — do not "align" the two.
    max_requests = req_limits_cfg.get("max_requests_allowed")
    period = req_limits_cfg.get("period")
    if max_requests is not None and period:
        period_start, period_end = _get_period_bounds(now_utc, period)
        req_count_query: dict = {
            "user_id": ObjectId(user_id),
            "leave_type_id": ObjectId(leave_type_id),
            "status": {"$in": ["PENDING", "APPROVED"]},
            "deleted_on": None,
            "created_on": {"$gte": period_start, "$lt": period_end},
        }
        # On an edit, don't count the request against itself.
        if exclude_request_id:
            req_count_query["_id"] = {"$ne": ObjectId(exclude_request_id)}
        count = await db["leave_requests"].count_documents(req_count_query)
        if count >= max_requests:
            raise DomainException(
                message=f"Maximum {max_requests} leave request(s) allowed per {period}. Limit reached.",
                code="EXCEEDS_MAX_REQUESTS",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    # --- Minimum gap between requests ---
    if req_limits_cfg.get("enforce_gap"):
        gap_days = req_limits_cfg.get("gap_days")
        if gap_days:
            gap_before = start - timedelta(days=gap_days)
            gap_after = end + timedelta(days=gap_days)
            gap_query: dict = {
                "user_id": ObjectId(user_id),
                "leave_type_id": ObjectId(leave_type_id),
                "status": {"$in": ["PENDING", "APPROVED"]},
                "deleted_on": None,
                "$or": [
                    {"end_datetime": {"$gt": gap_before, "$lte": start}},
                    {"start_datetime": {"$gte": end, "$lt": gap_after}},
                ],
            }
            if exclude_request_id:
                gap_query["_id"] = {"$ne": ObjectId(exclude_request_id)}
            nearby = await db["leave_requests"].find_one(gap_query)
            if nearby:
                raise DomainException(
                    message=f"A minimum gap of {gap_days} day(s) is required between leave requests",
                    code="INSUFFICIENT_GAP_BETWEEN_REQUESTS",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )

    # --- Overlap detection ---
    overlap_query: dict = {
        "user_id": ObjectId(user_id),
        "leave_type_id": ObjectId(leave_type_id),
        "status": {"$in": ["PENDING", "APPROVED"]},
        "deleted_on": None,
        "start_datetime": {"$lt": end},
        "end_datetime": {"$gt": start},
    }
    if exclude_request_id:
        overlap_query["_id"] = {"$ne": ObjectId(exclude_request_id)}
    overlap = await db["leave_requests"].find_one(overlap_query)
    if overlap:
        raise DomainException(
            message="An overlapping leave request already exists",
            code="OVERLAPPING_LEAVE",
            status_code=status.HTTP_409_CONFLICT,
        )

    # --- Clubbing restriction ---
    if clubbing_cfg.get("enabled"):
        restricted_ids = clubbing_cfg.get("restricted_leave_type_ids") or []
        for restricted_id in restricted_ids:
            try:
                r_oid = ObjectId(str(restricted_id))
            except Exception:
                continue
            clubbing_query: dict = {
                "user_id": ObjectId(user_id),
                "leave_type_id": r_oid,
                "status": {"$in": ["PENDING", "APPROVED"]},
                "deleted_on": None,
                "start_datetime": {"$lt": end},
                "end_datetime": {"$gt": start},
            }
            if exclude_request_id:
                clubbing_query["_id"] = {"$ne": ObjectId(exclude_request_id)}
            clubbing_overlap = await db["leave_requests"].find_one(clubbing_query)
            if clubbing_overlap:
                raise DomainException(
                    message="Leave cannot be combined with another leave type during the same period",
                    code="CLUBBING_NOT_ALLOWED",
                    status_code=status.HTTP_409_CONFLICT,
                )

    # --- Balance validation ---
    # An unrestricted type has no balance to check. The schema already forces
    # deduct_from_balance off for it, so this is belt-and-braces for a document
    # written outside the API — but it states the rule where it is enforced.
    if (
        not loss_of_pay
        and leave_type.get("deduct_from_balance", True)
        and not leave_type.get("is_unrestricted")
    ):
        # Use the projected-by-leave-date balance when supplied, matching the
        # LOP decision above; otherwise fall back to the current balance.
        #
        # When the policy disallows requesting against a projected balance
        # (allow_based_on_projected_balance == False), ignore the projected
        # figure and check strictly against TODAY's available balance — so a
        # future accrual the employee hasn't earned yet can't fund the request.
        allow_projected = future_cfg.get("allow_based_on_projected_balance", True)
        if extra_days > 0:
            # The extra-leave buffer must be measured against the TRUE (unclamped)
            # balance, so prior negative usage counts — otherwise the tracker's
            # clamp-to-zero would let the buffer be reused indefinitely.
            #
            # INTENTIONAL (product decision, confirmed): the buffer sits on top of
            # TODAY's balance, NOT the projected-by-leave-date figure — extra leave
            # is an emergency buffer against what you have now, not borrowing against
            # future accruals. And once balance + extra_days is exhausted the request
            # is hard-rejected (no unpaid-LOP fallback). Do not "fix" either back.
            from src.balance_tracker import get_raw_balance_unclamped
            from src.leave_holds.service import get_active_hold_hours

            raw = await get_raw_balance_unclamped(db, user_id, leave_type_id)
            held = await get_active_hold_hours(db, user_id, leave_type_id, exclude_request_id)
            balance_hours = raw - held
        elif projected_balance_hours is not None and allow_projected:
            balance_hours = projected_balance_hours
        else:
            from src.balance_tracker import get_available_balance

            balance_hours = await get_available_balance(
                db, user_id, leave_type_id, exclude_request_id
            )
        balance_days = (balance_hours or 0.0) / 8.0

        # When the balance is fully exhausted the request is auto-converted to
        # Loss of Pay (``include_weekends`` is already True here) and allowed
        # through unpaid. A partial-but-insufficient balance still errors —
        # UNLESS "extra leave" is allowed, which lets the request exceed the
        # current balance by up to ``extra_days`` (a paid, capped negative buffer).
        if not include_weekends and duration_days > balance_days + extra_days:
            raise DomainException(
                message=(
                    f"Insufficient leave balance. Available: {balance_days:.2f}"
                    + (f" (+{extra_days} extra)" if extra_days else "")
                    + f", Requested: {duration_days:.2f}"
                ),
                code="INSUFFICIENT_BALANCE",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    return duration_hours
