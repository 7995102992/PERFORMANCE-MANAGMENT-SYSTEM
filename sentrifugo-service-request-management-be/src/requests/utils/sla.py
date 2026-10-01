"""SLA deadline calculation — Foundation §13.

`compute_deadline(start, minutes, business_hours_only, org_tz, business_hours,
holidays)` returns a UTC datetime representing the deadline.

Non-business-hours SLA → simple wall-clock add.
Business-hours SLA → walk forward skipping outside-hours minutes, weekends,
and holidays. Naive algorithm; see SRM_Implementation_Queries.txt Q-008.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from ...models import BusinessHours


_DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _window_for(bh: BusinessHours, day: date) -> tuple[time, time] | None:
    w = getattr(bh, _DAY_NAMES[day.weekday()], None)
    if not w:
        return None
    return time.fromisoformat(w[0]), time.fromisoformat(w[1])


def compute_deadline(
    start: datetime,
    minutes: int,
    *,
    business_hours_only: bool,
    org_tz: str = "UTC",
    business_hours: BusinessHours | None = None,
    holidays: set[date] | None = None,
) -> datetime:
    if minutes <= 0:
        return start

    if not business_hours_only:
        return start + timedelta(minutes=minutes)

    bh = business_hours or BusinessHours()
    hols = holidays or set()
    tz = ZoneInfo(org_tz) if org_tz else ZoneInfo("UTC")
    cursor = start.astimezone(tz)
    remaining = minutes

    # Walk in 1-minute increments. Inefficient but straightforward; optimise
    # to per-day bucket math if profiling shows it's hot (Q-008).
    while remaining > 0:
        day = cursor.date()
        window = _window_for(bh, day)
        if window is None or day in hols:
            # Jump to start of next day's window search.
            next_day = day + timedelta(days=1)
            cursor = datetime.combine(next_day, time(0, 0), tz)
            continue
        open_t, close_t = window
        day_open = datetime.combine(day, open_t, tz)
        day_close = datetime.combine(day, close_t, tz)

        if cursor < day_open:
            cursor = day_open
            continue
        if cursor >= day_close:
            next_day = day + timedelta(days=1)
            cursor = datetime.combine(next_day, time(0, 0), tz)
            continue

        # Minutes available in today's window.
        available = int((day_close - cursor).total_seconds() // 60)
        if available >= remaining:
            cursor = cursor + timedelta(minutes=remaining)
            remaining = 0
            break
        remaining -= available
        # Jump to next day's window opening.
        next_day = day + timedelta(days=1)
        cursor = datetime.combine(next_day, time(0, 0), tz)

    return cursor.astimezone(timezone.utc)


# ── Is this ticket's SLA still in force? ──────────────────────────────────


async def rule_in_force(sr) -> tuple["SLARule | None", str]:
    """Resolve the SLA rule a ticket was raised under, if it still applies.

    Returns ``(rule, "")`` when the rule is live, or ``(None, reason)`` when it
    is not — the rule deactivated or soft-deleted, its request type deactivated
    or soft-deleted, or the ticket carrying no rule id at all.

    Both the SLA tick and the request-detail page ask this question, and they
    have to get the same answer. The tick discards a deadline whose rule is no
    longer in force — no breach event, no email, no violation actions — while
    the detail page used to compute "breached / 81% of allocated time used"
    straight from the stored deadlines, with no idea the rule behind them had
    been switched off. A ticket then showed a breach badge that nobody was ever
    told about and nobody was being held to.

    ``rule_id_not_found`` deserves its own reason string: until rule ids survive
    a request-type save, the overwhelming cause is that save re-minting them,
    not an admin switching anything off.
    """
    from ...models import RequestType, StatusEnum

    if not sr.sla_rule_id:
        return None, "ticket_has_no_sla_rule_id"

    rt = await RequestType.get(sr.request_type_id)
    if rt is None:
        return None, "request_type_missing"
    if rt.deleted_on is not None:
        return None, "request_type_deleted"
    if rt.status != StatusEnum.ACTIVE:
        return None, "request_type_inactive"

    match = next(
        (r for r in (rt.sla_rules or []) if str(r.id) == str(sr.sla_rule_id)),
        None,
    )
    if match is None:
        return None, "rule_id_not_found"
    if match.deleted_on is not None:
        return None, "rule_deleted"
    if match.status != StatusEnum.ACTIVE:
        return None, "rule_inactive"
    return match, ""
