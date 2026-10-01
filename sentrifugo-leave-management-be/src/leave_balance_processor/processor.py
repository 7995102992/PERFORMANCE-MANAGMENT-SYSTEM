"""
Leave balance processor.

For every active leave plan:
  1. Load the grant policy (annual allocation, joining rule).
  2. Load the entitlement configuration (distribution mode, probation, mid-year joining).
  3. Decide whether a credit is due today (period-key logic).
  4. Collect the leave-type IDs assigned to the plan.
  5. Resolve the employee scope from plan assignments (ORG / BU / DEPARTMENT).
  6. Walk covered employees in batches and post credits, honouring:
       - First-month joining restriction  (grant policy)
       - Mid-year joining adjustment      (entitlement config, both ALL_AT_ONCE and STEP_BY_STEP)
       - Probation adjustment             (entitlement config)
       - Idempotency via period_key       (leave_credit_ledger)

Collections written:
  leave_credit_ledger           — append-only audit trail
  employee_leave_balances       — running balance per (employee, plan, leave-type)
  leave_employee_balance_tracker — mirror keyed by user_id (fast balance lookups)
"""

import math
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.balance_tracker import upsert_balance as tracker_upsert_balance
from src.clients.iam_master_data import fetch_employment_statuses, fetch_employment_types
from src.employment_type import ELIGIBLE_EMPLOYMENT_TYPE_KEYS
from src.leave_balance_processor.schemas import CreditTransactionType
from src.leave_entitlements.schemas import probation_leave_type_ids
from src.logger import logger
from src.utils import to_oid

# ── Collection names ──────────────────────────────────────────────────────────

LEDGER_COL = "leave_credit_ledger"
BALANCE_COL = "employee_leave_balances"
PLANS_COL = "leave_plans"
GRANT_POLICY_COL = "leave_grant_policy"
ENTITLEMENT_COL = "leave_entitlement_configurations"
MAPPING_COL = "leave_plan_type_mapping"
ASSIGNMENTS_COL = "leave_plan_assignments"
EMPLOYEES_COL = "employees"

SYSTEM_USER = "system"
BATCH_SIZE = 500
HOURS_PER_DAY = 8.0

# Number of accrual periods per leave year, by frequency. Used to convert an
# annual allocation into a per-period amount (and back).
_FREQ_DIVISORS = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}


# ── Unit / rounding ───────────────────────────────────────────────────────────

def _to_hours(amount: float, unit: str) -> float:
    return amount * HOURS_PER_DAY if str(unit).upper() == "DAYS" else float(amount)


def _round_hours(hours: float, mode: str) -> float:
    if mode == "nearest_half":
        return round(hours * 2) / 2
    if mode == "nearest_one":
        return round(hours)
    if mode == "round_up":
        return math.ceil(hours * 2) / 2
    if mode == "round_down":
        return math.floor(hours * 2) / 2
    return hours  # "exact"


# ── Leave-year helpers ────────────────────────────────────────────────────────

def _leave_year(run_date: date, start_month: int) -> int:
    return run_date.year if run_date.month >= start_month else run_date.year - 1


def _month_in_year(run_date: date, start_month: int) -> int:
    """1-based month index within the leave year (1 = opening month)."""
    return ((run_date.month - start_month) % 12) + 1


def _add_months(d: date, months: int) -> date:
    """Add `months` calendar months to a date, clamping the day to the month end."""
    import calendar as _cal

    total = d.month - 1 + months
    year = d.year + total // 12
    month = total % 12 + 1
    return date(year, month, min(d.day, _cal.monthrange(year, month)[1]))


def _compute_expires_at(
    credit_expiry: Optional[dict], credit_date: date, calendar_start_month: int
) -> Optional[datetime]:
    """When a credit granted on ``credit_date`` should expire. ``None`` = never.

    * expiry disabled / no config        -> None
    * expiry_at_cycle_end = True          -> first day of the NEXT leave cycle
    * rolling (period_value + unit)       -> credit_date + N MONTHS/DAYS
    """
    if not credit_expiry or not credit_expiry.get("expiry_enabled"):
        return None
    if credit_expiry.get("expiry_at_cycle_end"):
        ly = _leave_year(credit_date, calendar_start_month)
        nxt = date(ly + 1, calendar_start_month, 1)
        return datetime(nxt.year, nxt.month, nxt.day, tzinfo=timezone.utc)
    val = credit_expiry.get("expiry_period_value")
    unit = str(credit_expiry.get("expiry_period_unit") or "").upper()
    if val and int(val) > 0:
        if unit in ("MONTHS", "MONTH"):
            e = _add_months(credit_date, int(val))
        elif unit in ("DAYS", "DAY"):
            e = credit_date + timedelta(days=int(val))
        else:
            return None
        return datetime(e.year, e.month, e.day, tzinfo=timezone.utc)
    return None


def _quarter(miy: int) -> int:
    return (miy - 1) // 3 + 1


def _half(miy: int) -> int:
    return 1 if miy <= 6 else 2


# ── Period-key / credit-day logic ─────────────────────────────────────────────

def _due_periods(
    run_date: date,
    distribution_mode: str,
    accrual_frequency: Optional[str],
    calendar_start_month: int,
    cycle_start_day: int,
    leave_year: int,
) -> list[tuple[str, date, int]]:
    """The ``(period_key, posting_date, period_miy)`` entries posting inside
    ``run_date``'s calendar month.

    FORWARD ONLY. A period is offered only while the engine is inside its posting
    month; once that month is over the period is never offered again. A month that
    was missed stays missed — ``scripts/run_monthly_credit.py --date`` is the
    deliberate, operator-driven way to credit it after the fact.

    The window is the MONTH, not the exact posting day. The credit cron fires on
    the 1st, so matching ``cycle_start_day`` exactly would permanently skip every
    plan whose posting day is not the 1st. Within the month repeated runs are
    harmless: ``_already_credited`` and the ``uniq_credit_period`` index make the
    write idempotent.
    """
    import calendar as _cal

    def _posting_date(year: int, month: int) -> date:
        # cycle_start_day clamped to the month length (e.g. day 31 in a 30-day month).
        return date(year, month, min(cycle_start_day, _cal.monthrange(year, month)[1]))

    def _is_due(anchor: date) -> bool:
        return anchor.year == run_date.year and anchor.month == run_date.month

    out: list[tuple[str, date, int]] = []
    if distribution_mode == "all_at_once":
        anchor = _posting_date(leave_year, calendar_start_month)
        if _is_due(anchor):
            out.append((f"{leave_year}:ANNUAL", anchor, 1))
        return out

    for off in range(12):
        miy = off + 1  # month-in-year, 1..12
        month = (calendar_start_month - 1 + off) % 12 + 1
        year = leave_year + (calendar_start_month - 1 + off) // 12
        anchor = _posting_date(year, month)
        if not _is_due(anchor):
            continue
        if accrual_frequency == "monthly":
            out.append((f"{leave_year}:M{month:02d}", anchor, miy))
        elif accrual_frequency == "quarterly" and miy in (1, 4, 7, 10):
            out.append((f"{leave_year}:Q{_quarter(miy)}", anchor, miy))
        elif accrual_frequency == "half_yearly" and miy in (1, 7):
            out.append((f"{leave_year}:H{_half(miy)}", anchor, miy))
        elif accrual_frequency == "yearly" and miy == 1:
            out.append((f"{leave_year}:Y", anchor, miy))
    return out


def _probation_period_key(leave_year: int, run_date: date) -> str:
    """Period key for a tiered-probation band credit.

    Bands post MONTHLY (see _probation_check), on a cadence that is independent of
    any leave type's accrual_frequency. They therefore need their own key: reusing
    the probation leave type's key would collapse twelve monthly bands into one
    credit whenever that type is an annual grant (its key is a single
    ``<year>:ANNUAL`` for the whole leave year).
    """
    return f"{leave_year}:PROB:M{run_date.month:02d}"


# ── Date parsing ──────────────────────────────────────────────────────────────

def _parse_date(raw) -> Optional[date]:
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw[:10])
        except ValueError:
            return None
    return None


# ── First-month joining restriction ──────────────────────────────────────────

def _is_first_month_blocked(
    joining_rule: dict, joining_date: Optional[date], run_date: date
) -> bool:
    """True when a first-month restriction prevents crediting this employee today."""
    if not joining_rule.get("enabled"):
        return False
    restriction = joining_rule.get("first_month_restriction", {})
    if not restriction.get("enabled"):
        return False
    if not joining_date:
        return False
    # Only applies in the employee's very first calendar month
    if run_date.year != joining_date.year or run_date.month != joining_date.month:
        return False
    return joining_date.day > restriction.get("cutoff_day", 23)


# ── Mid-year joining adjustment ───────────────────────────────────────────────

def _periods_remaining_in_year(accrual_frequency: Optional[str], miy: int) -> int:
    """Number of accrual periods still to fire in the leave year (joining month inclusive)."""
    if accrual_frequency == "monthly":
        return max(12 - miy + 1, 1)
    if accrual_frequency == "quarterly":
        return max(4 - _quarter(miy) + 1, 1)
    if accrual_frequency == "half_yearly":
        return max(2 - _half(miy) + 1, 1)
    # "yearly" (and any other single-shot frequency) → one remaining period.
    return 1


def _mid_year_hours(
    base_hours: float,
    distribution_mode: str,
    accrual_frequency: Optional[str],
    joining_date: date,
    leave_year: int,
    calendar_start_month: int,
    mid_year_cfg: dict,
) -> float:
    """
    Mid-year joiner adjustment. Driven entirely by `mode` (and `slab_rules`) —
    `enabled` is intentionally NOT consulted; the field has been deprecated.

    For ALL_AT_ONCE, `base_hours` is the annual amount and the return is the
    adjusted annual amount.
    For STEP_BY_STEP, `base_hours` is the per-period accrual and the return is
    the adjusted per-period amount.

    Behaviour matrix:
      mode == "pro_rate"
        ALL_AT_ONCE   → base * months_remaining / 12
        STEP_BY_STEP  → base unchanged (per-period accrual already only fires
                        from the joining period onwards, which IS the pro-rata)
      mode == "credit_joining_month" + matching slab
        ALL_AT_ONCE   → slab.allocation (one annual lump sum)
        STEP_BY_STEP  → slab.allocation / periods_remaining_in_year
                        (slab is the joiner's total for the year; spread it
                        across the periods that will still fire)
      mode == "credit_joining_month" + no slab match
        ALL_AT_ONCE   → (base / 12) * months_remaining
        STEP_BY_STEP  → base unchanged
    """
    year_start = date(leave_year, calendar_start_month, 1)
    if joining_date <= year_start:
        return base_hours  # joined on or before the leave-year start — full credit

    is_all_at_once = distribution_mode == "all_at_once"
    miy = _month_in_year(joining_date, calendar_start_month)
    months_remaining = 12 - miy + 1

    # Explicit slab rules — UI stores dates as "DD-MM" (day-month).
    for slab in mid_year_cfg.get("slab_rules") or []:
        try:
            from_raw = str(slab["from_date"])
            to_raw = str(slab["to_date"])
            if len(from_raw) == 5:  # "DD-MM" format
                from_d = date(joining_date.year, int(from_raw[3:]), int(from_raw[:2]))
                to_d = date(joining_date.year, int(to_raw[3:]), int(to_raw[:2]))
                # Handle year-crossing slabs (e.g. Nov → Feb)
                if from_d > to_d:
                    matched = joining_date >= from_d or joining_date <= to_d
                else:
                    matched = from_d <= joining_date <= to_d
            else:
                from_d = date.fromisoformat(from_raw[:10])
                to_d = date.fromisoformat(to_raw[:10])
                matched = from_d <= joining_date <= to_d
            if matched:
                slab_total = _to_hours(float(slab["allocation"]), slab.get("unit", "DAYS"))
                if is_all_at_once:
                    return slab_total
                periods_remaining = _periods_remaining_in_year(accrual_frequency, miy)
                return slab_total / periods_remaining
        except (ValueError, KeyError, TypeError):
            continue

    mode = mid_year_cfg.get("mode")

    if mode == "pro_rate":
        if is_all_at_once:
            return base_hours * months_remaining / 12
        return base_hours  # step_by_step is naturally pro-rated

    if mode == "credit_joining_month":
        if is_all_at_once:
            return (base_hours / 12) * months_remaining
        return base_hours

    return base_hours


def _join_period_credit_hours(
    annual_count: float,
    unit: str,
    frequency: str,
    anchor_date: date,
    calendar_start_month: int,
    joining_rule: dict,
) -> float:
    """Pro-rated credit for the CURRENT period when an employee *enters the normal
    plan* on ``anchor_date`` (a direct joining date, or a probation→permanent
    confirmation date).

    Monthly honours the joining rule: when the first-month restriction is enabled,
    it's a cutoff threshold (join on/before cutoff_day → full month, after → 0);
    when disabled it pro-rates by calendar days left in the month. Quarterly /
    half-yearly / yearly always pro-rate by whole months left in their current
    period (matching the existing mid-year all-at-once behaviour).
    """
    base_annual = _to_hours(float(annual_count), unit)
    miy = _month_in_year(anchor_date, calendar_start_month)  # 1..12 within the leave year

    if frequency == "monthly":
        base = base_annual / 12.0
        fmr = (joining_rule or {}).get("first_month_restriction") or {}
        if (joining_rule or {}).get("enabled") and fmr.get("enabled"):
            cutoff = int(fmr.get("cutoff_day", 23))
            return base if anchor_date.day <= cutoff else 0.0
        import calendar as _calendar
        days_in_month = _calendar.monthrange(anchor_date.year, anchor_date.month)[1]
        days_left = days_in_month - anchor_date.day + 1
        return base * days_left / days_in_month

    if frequency == "quarterly":
        base = base_annual / 4.0
        months_left = 3 - ((miy - 1) % 3)
        return base * months_left / 3.0

    if frequency == "half_yearly":
        base = base_annual / 2.0
        months_left = 6 - ((miy - 1) % 6)
        return base * months_left / 6.0

    if frequency == "yearly":
        months_left = 12 - miy + 1
        return base_annual * months_left / 12.0

    return 0.0


# ── Probation adjustment ──────────────────────────────────────────────────────


def _probation_check(
    employee_doc: dict,
    probation_cfg: dict,
    run_date: date,
    calendar_start_month: int,
    cycle_start_day: int,
    is_probation: bool,
) -> tuple[bool, Optional[float]]:
    """
    Single entry point for all probation logic.  Returns:

      (True,  None)   — employee is not in probation, or SAME_FOR_ALL: credit at
                        the normal per-leave-type base rate.
      (True,  hours)  — employee is in a TIERED band: override the probation leave
                        type with this fixed credit.
      (True,  0.0)    — employee is in probation but no band matches: write a zero
                        credit so the period_key is consumed and no double-credit
                        occurs later.

    No path returns ``False`` any more. The first element of the tuple is kept
    because ``_credit_employee`` unpacks it, and because a future gate would land
    here — but the old "not the band's posting day, skip this employee" case is
    gone. Bands now post once per calendar month regardless of the plan's
    ``cycle_start_day``; see the band loop below for why.

    "In probation" is decided by the employee's EMPLOYMENT STATUS (``is_probation``,
    resolved from the master-data status), NOT by a joining-date + duration
    calculation — so it tracks early/late/extended confirmations exactly, and a
    confirmed employee simply stops matching on the next run with no transition
    handling needed here. The joining (or confirmation) date is used only to pick
    WHICH band tier applies via months-in-service.

    ``cycle_start_day`` is retained in the signature for call-site stability; it no
    longer gates anything.
    """
    if not probation_cfg.get("enabled"):
        return True, None

    # Status is the source of truth: only an employee whose employment status is
    # "probation" gets band treatment. Everyone else credits normally.
    if not is_probation:
        return True, None

    if probation_cfg.get("credit_mode") != "tiered_by_duration":
        return True, None  # SAME_FOR_ALL: full credit rate during probation

    # TIERED_BY_DURATION: pick the band by months-in-service. The date only
    # selects the tier; it never decides whether the employee is in probation.
    if probation_cfg.get("credit_start") == "confirmation_date":
        probation_start = _parse_date(employee_doc.get("confirmation_date"))
        if not probation_start:
            # A probationer is by definition NOT yet confirmed, so the confirmation
            # clock hasn't started — anchor at month 0 (the first band) rather than
            # falling through to the full base rate, which would over-credit (P5).
            months_in_service = 0
        else:
            months_in_service = (
                (run_date.year - probation_start.year) * 12
                + run_date.month - probation_start.month
            )
    else:
        probation_start = _parse_date(
            employee_doc.get("date_of_joining") or employee_doc.get("joining_date")
        )
        if not probation_start:
            return True, None  # can't place them in a band — credit normally
        months_in_service = (
            (run_date.year - probation_start.year) * 12
            + run_date.month - probation_start.month
        )

    for band in probation_cfg.get("band_rules") or []:
        # Half-open [from_month, to_month): adjacent bands that share a boundary
        # month (e.g. 0–3 and 3–6) don't both claim it. The engine fires once per
        # integer months_in_service, so 0–3 covers {0,1,2} and 3–6 covers {3,4,5} (P2).
        if band.get("from_month", 0) <= months_in_service < band.get("to_month", 9999):
            # Bands post once per calendar month. There is deliberately no
            # cycle_start_day check: the credit cron fires on the 1st, so gating on
            # the plan's posting day would credit no probationer at all on any plan
            # whose cycle_start_day is not 1. _probation_period_key is keyed by
            # month, so once-per-month still holds.
            return True, _to_hours(float(band.get("credit_amount", 0)), band.get("unit", "DAYS"))

    # In probation but no band covers this service duration → no credit.
    return True, 0.0


# ── Employee scope ────────────────────────────────────────────────────────────

async def _build_employee_filter(
    db: AsyncIOMotorDatabase, plan_id: str, org_id: str
) -> Optional[dict]:
    """
    Build a Mongo filter that matches all employees covered by this plan's
    active assignments.

    Scope resolution (one clause per assignment, OR'd together):
      ORG        → all employees in the organisation
      DEPARTMENT → employees matching BOTH the department AND the business unit
                   (a department can be shared across BUs, so dept alone would
                   wrongly pull in employees of another BU — mirrors
                   resolve_employee_plan's dept+BU scoping)
      BU         → employees whose business_unit_id matches
    """
    assignments = await db[ASSIGNMENTS_COL].find(
        {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None},
        {"scope_type": 1, "department_id": 1, "business_unit_id": 1},
    ).to_list(length=None)

    if not assignments:
        return None

    # ORG scope covers everyone in the organisation
    if any(a.get("scope_type") == "ORG" for a in assignments):
        return {"organisation_id": to_oid(org_id), "is_deleted": {"$ne": True}}

    # employees may store ids as ObjectId (canonical) or str (legacy) — match both
    def _both(v):
        return {"$in": [v, str(v)]}

    clauses: list[dict] = []
    for a in assignments:
        st = a.get("scope_type")
        if st == "DEPARTMENT" and a.get("department_id"):
            clause = {"department_id": _both(a["department_id"])}
            if a.get("business_unit_id"):
                clause["business_unit_id"] = _both(a["business_unit_id"])
            clauses.append(clause)
        elif st == "BU" and a.get("business_unit_id"):
            clauses.append({"business_unit_id": _both(a["business_unit_id"])})

    if not clauses:
        return None

    base: dict = {"is_deleted": {"$ne": True}}
    if len(clauses) == 1:
        base.update(clauses[0])
    else:
        base["$or"] = clauses
    return base


async def build_creditable_employee_filter(
    db: AsyncIOMotorDatabase, plan_id: str, org_id: str
) -> tuple[Optional[dict], set]:
    """The Mongo filter matching every employee this plan will actually credit,
    plus the set of status ids that mean "on probation".

    Plan scope (``_build_employee_filter``) narrowed by the two eligibility rules:

      * employment TYPE must be in ELIGIBLE_EMPLOYMENT_TYPE_KEYS. Null / missing
        counts as eligible so employees who predate IAM's employment_type sync are
        not silently dropped. If the type lookup fails entirely (Valkey + IAM HTTP
        + local Mongo all empty) the rule is skipped — better to over-credit than
        to stop crediting a whole org on an infrastructure blip.
      * employment STATUS must not be an explicitly inactive one (exit /
        terminated / retired / absconded). Unknown or unset statuses stay in.

    Returns ``(None, set())`` when the plan has no active assignments.

    Public because ``scripts/run_monthly_credit.py`` counts affected employees with
    it before asking for confirmation — the count is only meaningful if it is the
    same filter the engine goes on to use.
    """
    emp_filter = await _build_employee_filter(db, plan_id, org_id)
    if emp_filter is None:
        return None, set()

    iam_types = await fetch_employment_types(organisation_id=str(org_id))
    if iam_types:
        eligible_type_oids = [
            to_oid(tid)
            for tid, info in iam_types.items()
            if info.get("key") in ELIGIBLE_EMPLOYMENT_TYPE_KEYS
        ]
        if eligible_type_oids:
            # Combine via $and — _build_employee_filter may return the scope as a
            # top-level "$or" (multi-assignment plans), and a bare emp_filter["$or"]
            # assignment would CLOBBER that scope, crediting every employee org-wide.
            emp_filter.setdefault("$and", []).append({"$or": [
                {"employment_type": {"$in": eligible_type_oids}},
                {"employment_type": None},
                {"employment_type": {"$exists": False}},
            ]})
    else:
        logger.warning(
            "Could not fetch employment_types — skipping type-based eligibility filter",
            plan_id=plan_id,
        )

    iam_statuses = await fetch_employment_statuses(organisation_id=str(org_id))
    inactive_status_oids = [
        to_oid(sid)
        for sid, info in iam_statuses.items()
        if info.get("is_active", True) is False
    ]
    # Status ids that mean "on probation" — drives status-based probation crediting
    # (matched by name so it tracks whatever the org calls it).
    probation_status_oids = {
        to_oid(sid)
        for sid, info in iam_statuses.items()
        if "probation" in (info.get("key") or "").lower()
        or "probation" in (info.get("value") or "").lower()
    }
    if inactive_status_oids:
        emp_filter["employment_status"] = {"$nin": inactive_status_oids}
        logger.info(
            "Excluding inactive-status employees from accrual",
            plan_id=plan_id,
            inactive_status_count=len(inactive_status_oids),
        )

    return emp_filter, probation_status_oids


# ── Leave-type IDs ────────────────────────────────────────────────────────────

async def _get_leave_type_ids(
    db: AsyncIOMotorDatabase, plan_id: str, plan_doc: dict
) -> list[str]:
    """Union of IDs from leave_plan_type_mapping and the plan's embedded list."""
    mapping_docs = await db[MAPPING_COL].find(
        {"leave_plan_id": to_oid(plan_id)}, {"leave_type_id": 1}
    ).to_list(length=None)
    from_mapping = {str(d["leave_type_id"]) for d in mapping_docs}
    embedded = {str(lt) for lt in plan_doc.get("leave_type_ids", [])}
    return list(from_mapping | embedded)


# ── Idempotency ───────────────────────────────────────────────────────────────

async def _already_credited(
    db: AsyncIOMotorDatabase,
    employee_id: str,
    plan_id: str,
    lt_id: str,
    period_key: str,
) -> bool:
    return bool(
        await db[LEDGER_COL].find_one({
            "employee_id": to_oid(employee_id),
            "leave_plan_id": to_oid(plan_id),
            "leave_type_id": to_oid(lt_id),
            "period_key": period_key,
            "transaction_type": {"$in": [
                CreditTransactionType.GRANT_CREDIT.value,
                CreditTransactionType.ACCRUAL_CREDIT.value,
            ]},
        })
    )


# ── Ledger + balance writes ───────────────────────────────────────────────────

async def _write_credit(
    db: AsyncIOMotorDatabase,
    *,
    employee_id: str,
    org_id: str,
    plan_id: str,
    lt_id: str,
    transaction_type: CreditTransactionType,
    amount_hours: float,
    period_key: str,
    run_date: date,
    leave_year: int,
    period_month: Optional[int],
    period_quarter: Optional[int],
    period_half: Optional[int],
    note: str,
    user_id: Optional[str],
    credit_expiry: Optional[dict] = None,
    calendar_start_month: int = 1,
) -> None:
    now = datetime.now(timezone.utc)

    # Stamp when this credit lapses (None = never). The expiry job reads this to
    # remove unused credit once it's past its expiry date.
    expires_at = _compute_expires_at(credit_expiry, run_date, calendar_start_month)

    from pymongo.errors import DuplicateKeyError

    try:
        await db[LEDGER_COL].insert_one({
            "_id": str(uuid.uuid4()),
            "employee_id": to_oid(employee_id),
            "org_id": to_oid(org_id),
            "leave_plan_id": to_oid(plan_id),
            "leave_type_id": to_oid(lt_id),
            "transaction_type": transaction_type.value,
            "amount": amount_hours,
            "effective_date": datetime(run_date.year, run_date.month, run_date.day, tzinfo=timezone.utc),
            "period_year": leave_year,
            "period_month": period_month,
            "period_quarter": period_quarter,
            "period_half": period_half,
            "period_key": period_key,
            "expires_at": expires_at,
            "reference_id": None,
            "note": note,
            "metadata": {"leave_plan_id": plan_id, "leave_year": leave_year},
            "created_on": now,
            "created_by": SYSTEM_USER,
        })
    except DuplicateKeyError:
        # The unique index caught a concurrent cron run already crediting this exact
        # (employee, plan, type, period) — idempotent no-op: do NOT mirror to the
        # tracker/aggregate again, or we'd double-credit. (accrual double-credit race)
        logger.debug(
            "Duplicate accrual credit suppressed",
            employee_id=employee_id, leave_type_id=lt_id, period_key=period_key,
        )
        return

    await db[BALANCE_COL].update_one(
        {
            "employee_id": to_oid(employee_id),
            "leave_plan_id": to_oid(plan_id),
            "leave_type_id": to_oid(lt_id),
        },
        {
            "$inc": {"total_credited": amount_hours, "balance": amount_hours},
            "$set": {
                "org_id": to_oid(org_id),
                "last_credit_period_key": period_key,
                "last_updated_on": now,
            },
            "$setOnInsert": {
                "_id": str(uuid.uuid4()),
                "employee_id": to_oid(employee_id),
                "leave_plan_id": to_oid(plan_id),
                "leave_type_id": to_oid(lt_id),
                "total_debited": 0.0,
            },
        },
        upsert=True,
    )

    if user_id:
        try:
            await tracker_upsert_balance(
                db, user_id, lt_id, plan_id, amount_hours, SYSTEM_USER
            )
        except Exception as exc:
            logger.warning(
                "Failed to mirror credit to balance tracker",
                employee_id=employee_id,
                leave_type_id=lt_id,
                error=str(exc),
            )

    # Journey timeline: one "Leave allocated" milestone per employee / leave-type
    # / leave-year. The stable idempotency key collapses periodic accruals into a
    # single node (IAM consumes this off the shared domain_events bus).
    if user_id and transaction_type in (
        CreditTransactionType.GRANT_CREDIT,
        CreditTransactionType.ACCRUAL_CREDIT,
    ):
        try:
            from src.messaging.constants.exchanges import Exchanges
            from src.messaging.outbox.worker import publish as _journey_publish
            await _journey_publish(
                "leave.allocated",
                {
                    "user_id": user_id,
                    "organisation_id": org_id,
                    "leave_type_id": lt_id,
                    "leave_year": leave_year,
                    "amount_hours": amount_hours,
                    "allocated_on": datetime(
                        run_date.year, run_date.month, run_date.day, tzinfo=timezone.utc
                    ).isoformat(),
                },
                idempotency_key=f"leave.allocated:{user_id}:{lt_id}:{leave_year}",
                exchange=Exchanges.DOMAIN_EVENTS,
            )
        except Exception as exc:
            logger.warning("Failed to emit leave.allocated journey event", error=str(exc))


# ── Per-employee credit ───────────────────────────────────────────────────────

async def _credit_employee(
    db: AsyncIOMotorDatabase,
    *,
    employee_doc: dict,
    org_id: str,
    plan_id: str,
    regular_period_keys: dict[str, str],
    type_freq_map: dict[str, str],
    statutory_lt_ids: list[str],
    statutory_annual_map: dict[str, float],
    posting_cycle_map: dict[str, float],
    annual_hours: float,
    distribution_mode: str,
    accrual_frequency: Optional[str],
    joining_rule: dict,
    mid_year_cfg: dict,
    probation_cfg: dict,
    probation_status_oids: set,
    rounding_mode: str,
    run_date: date,
    leave_year: int,
    calendar_start_month: int,
    cycle_start_day: int,
    miy: int,
    statutory_period_key: Optional[str],
    probation_period_key: Optional[str] = None,
    credit_expiry: Optional[dict] = None,
) -> int:
    """
    Post credits for one employee across all leave types in the plan.

    Each regular leave type accrues on its OWN frequency: `regular_period_keys`
    maps the leave-type IDs that fire today to their period key, and
    `type_freq_map` gives each type's frequency (falling back to the plan-level
    `accrual_frequency` for legacy plans). Statutory leave types are always
    credited as an annual lump sum at the start of the leave year, regardless of
    frequency.

    Returns the number of ledger entries written.
    """
    employee_id = str(employee_doc["_id"])
    user_id_raw = employee_doc.get("user_id")
    user_id = str(user_id_raw) if user_id_raw else None
    joining_date = _parse_date(
        employee_doc.get("date_of_joining") or employee_doc.get("joining_date")
    )

    if _is_first_month_blocked(joining_rule, joining_date, run_date):
        logger.debug(
            "First-month restriction: skipping employee",
            employee_id=employee_id,
            plan_id=plan_id,
        )
        return 0

    # Probation check is employee-level: run once before the leave-type loop.
    # "In probation" is decided by employment STATUS, not dates.
    # should_credit=False  → the employee's band frequency hasn't fired today; skip entirely.
    # amount_override=None → credit at the normal base rate (not in tiered probation).
    # amount_override=X    → tiered-probation band credit (0.0 when no band matches).
    is_probation = employee_doc.get("employment_status") in probation_status_oids
    should_credit, amount_override = _probation_check(
        employee_doc, probation_cfg, run_date, calendar_start_month, cycle_start_day,
        is_probation,
    )
    if not should_credit:
        return 0

    # During tiered probation (amount_override is set), fund ONLY the configured
    # probation leave types — skip every other type. A probationer therefore earns
    # nothing in the other buckets until they're confirmed. If no probation type
    # is configured, fall back to legacy behavior (band applies to all types).
    if amount_override is not None:
        prob_lt_ids = probation_leave_type_ids(probation_cfg)
        if prob_lt_ids and probation_period_key:
            # The band REPLACES the regular grant, and posts on its own monthly key
            # rather than borrowing the leave type's — see _probation_period_key.
            #
            # The band amount is credited to EACH selected type at its full rate,
            # not divided between them: the band is a per-type monthly rate, and
            # selecting a second type does not dilute the first. Each type gets
            # its own _already_credited guard, so a catch-up run that failed
            # part-way resumes cleanly instead of re-crediting the types that
            # already posted.
            written_probation = 0
            for prob_lt_id in prob_lt_ids:
                if await _already_credited(
                    db, employee_id, plan_id, prob_lt_id, probation_period_key
                ):
                    continue
                # A zero band (in probation, but no tier covers this service duration)
                # is still written: that consumes the period key, so a later catch-up
                # run cannot re-credit the month at the full base rate.
                await _write_credit(
                    db,
                    employee_id=employee_id,
                    org_id=org_id,
                    plan_id=plan_id,
                    lt_id=prob_lt_id,
                    transaction_type=CreditTransactionType.ACCRUAL_CREDIT,
                    amount_hours=_round_hours(amount_override, rounding_mode),
                    period_key=probation_period_key,
                    run_date=run_date,
                    leave_year=leave_year,
                    period_month=run_date.month,
                    period_quarter=None,
                    period_half=None,
                    note=f"Probation band credit for leave year {leave_year} – plan {plan_id}",
                    user_id=user_id,
                    credit_expiry=credit_expiry,
                    calendar_start_month=calendar_start_month,
                )
                written_probation += 1
            return written_probation
        if prob_lt_ids:
            # No probation key resolved (tiered probation not configured at plan
            # level) — keep the band from leaking into the other buckets.
            prob_lt_set = set(prob_lt_ids)
            regular_period_keys = {
                lt_id: key for lt_id, key in regular_period_keys.items()
                if str(lt_id) in prob_lt_set
            }
            statutory_lt_ids = [
                lt_id for lt_id in statutory_lt_ids if str(lt_id) in prob_lt_set
            ]

    written = 0

    # ── Regular (non-statutory) leave types ──────────────────────────────────
    # Each type accrues on its own frequency: regular_period_keys holds only the
    # types whose period fires today, mapped to that type's period key.
    if regular_period_keys:
        # Flatten {lt_id: [(key, anchor, miy), ...]} so a type with several caught-up
        # periods credits each one; _already_credited (below) guards against dupes.
        flat_periods = [
            (lt_id, key, anchor, pmiy)
            for lt_id, periods in regular_period_keys.items()
            for (key, anchor, pmiy) in periods
        ]
        for lt_id, lt_period_key, p_anchor, p_miy in flat_periods:
            freq = type_freq_map.get(lt_id) or accrual_frequency
            # The leave type's accrual_frequency drives its own schedule (per-type, not
            # the legacy plan distribution.mode): yearly/none = lump sum, else accrue.
            eff_mode = "all_at_once" if (not freq or freq == "yearly") else "step_by_step"
            transaction_type = (
                CreditTransactionType.GRANT_CREDIT
                if eff_mode == "all_at_once"
                else CreditTransactionType.ACCRUAL_CREDIT
            )
            period_month = p_anchor.month if freq == "monthly" else None
            period_quarter = _quarter(p_miy) if freq == "quarterly" else None
            period_half = _half(p_miy) if freq == "half_yearly" else None

            # Mid-year joiner: skip any period that closed before they joined, at the
            # full per-period slice. Under the forward-only rule _due_periods cannot
            # normally offer a pre-join period, so this is defensive — it still holds
            # the line for an operator backfill via scripts/run_monthly_credit.py
            # --date, which can legitimately run a month the employee predates.
            if (
                joining_date
                and eff_mode != "all_at_once"
                and joining_date > date(leave_year, calendar_start_month, 1)
            ):
                _jmiy = _month_in_year(joining_date, calendar_start_month)
                _is_pre_join = (
                    (freq == "monthly" and p_miy < _jmiy)
                    or (freq == "quarterly" and _quarter(p_miy) < _quarter(_jmiy))
                    or (freq == "half_yearly" and _half(p_miy) < _half(_jmiy))
                )
                if _is_pre_join:
                    continue

            if amount_override is not None:
                base = amount_override
            else:
                # posting_cycle values are already per-period for the type's own
                # frequency. Unlisted types fall back to annual / frequency.
                default_period_hours = annual_hours / _FREQ_DIVISORS.get(freq or "", 1)
                base = posting_cycle_map.get(lt_id, default_period_hours)
                if base <= 0:
                    continue
                if joining_date:
                    base = _mid_year_hours(
                        base,
                        eff_mode,
                        freq,
                        joining_date,
                        leave_year,
                        calendar_start_month,
                        mid_year_cfg,
                    )
                    # STEP_BY_STEP pro_rate leaves the JOINING period at the FULL
                    # per-period slice (_mid_year_hours returns it unchanged). Day-
                    # prorate that first period to match the confirmation path
                    # (_join_period_credit_hours), so a mid-month joiner isn't
                    # over-credited for the part of the period before they joined (D2).
                    # Only the joining period itself is adjusted; later periods keep
                    # the full slice. Slab / credit_joining_month modes have their own
                    # handling and are intentionally left untouched.
                    _myc_mode = mid_year_cfg.get("mode")
                    if (
                        eff_mode != "all_at_once"
                        and not mid_year_cfg.get("slab_rules")
                        and _myc_mode in (None, "", "pro_rate")
                        and joining_date > date(leave_year, calendar_start_month, 1)
                    ):
                        _jmiy = _month_in_year(joining_date, calendar_start_month)
                        _is_join_period = (
                            (freq == "monthly" and p_miy == _jmiy)
                            or (freq == "quarterly" and _quarter(p_miy) == _quarter(_jmiy))
                            or (freq == "half_yearly" and _half(p_miy) == _half(_jmiy))
                            or (freq == "yearly")
                        )
                        if _is_join_period:
                            base = _join_period_credit_hours(
                                base * _FREQ_DIVISORS.get(freq or "", 1),
                                "HOURS",
                                freq or "monthly",
                                joining_date,
                                calendar_start_month,
                                joining_rule,
                            )

            amount = _round_hours(base, rounding_mode)
            if amount <= 0:
                continue

            if await _already_credited(db, employee_id, plan_id, lt_id, lt_period_key):
                continue

            period_label = (
                "Annual grant"
                if eff_mode == "all_at_once"
                else f"{(freq or '').capitalize()} accrual"
            )
            note = f"{period_label} for leave year {leave_year} – plan {plan_id}"

            await _write_credit(
                db,
                employee_id=employee_id,
                org_id=org_id,
                plan_id=plan_id,
                lt_id=lt_id,
                transaction_type=transaction_type,
                amount_hours=amount,
                period_key=lt_period_key,
                run_date=run_date,
                leave_year=leave_year,
                period_month=period_month,
                period_quarter=period_quarter,
                period_half=period_half,
                note=note,
                user_id=user_id,
                credit_expiry=credit_expiry,
                calendar_start_month=calendar_start_month,
            )
            written += 1

    # ── Statutory leave types (always annual, at calendar start month) ────────
    if statutory_period_key and statutory_lt_ids:
        for lt_id in statutory_lt_ids:
            # A probation band overrides a STATUTORY type only when the probation
            # leave type is EXPLICITLY configured (and therefore statutory_lt_ids was
            # already narrowed to it above). In legacy mode (no probation_leave_type_id)
            # the band must NOT replace a legally-mandated statutory entitlement (P3).
            if amount_override is not None and probation_leave_type_ids(probation_cfg):
                base = amount_override
            else:
                base = statutory_annual_map.get(lt_id, annual_hours)
                if base <= 0:
                    continue
                if joining_date:
                    # Statutory credits are always an annual lump sum — treat
                    # them as all_at_once for the mid-year adjustment.
                    base = _mid_year_hours(
                        base,
                        "all_at_once",
                        accrual_frequency,
                        joining_date,
                        leave_year,
                        calendar_start_month,
                        mid_year_cfg,
                    )

            amount = _round_hours(base, rounding_mode)
            if amount <= 0:
                continue

            if await _already_credited(db, employee_id, plan_id, lt_id, statutory_period_key):
                continue

            note = f"Annual grant (statutory) for leave year {leave_year} – plan {plan_id}"

            await _write_credit(
                db,
                employee_id=employee_id,
                org_id=org_id,
                plan_id=plan_id,
                lt_id=lt_id,
                transaction_type=CreditTransactionType.GRANT_CREDIT,
                amount_hours=amount,
                period_key=statutory_period_key,
                run_date=run_date,
                leave_year=leave_year,
                period_month=None,
                period_quarter=None,
                period_half=None,
                note=note,
                user_id=user_id,
                credit_expiry=credit_expiry,
                calendar_start_month=calendar_start_month,
            )
            written += 1

    return written


async def credit_employee_on_plan_entry(
    db: AsyncIOMotorDatabase, user_id: str, anchor_date: date
) -> int:
    """Pro-rate-credit an employee's CURRENT period for every leave type when they
    *enter the normal plan*. Two callers, both event-driven:

      * probation→permanent confirmation, anchored on the confirmation date
      * a new joiner (``employee.created``), anchored on their date_of_joining

    The joining path exists because the accrual cron is forward-only and monthly:
    it credits the periods anchored in its own month, so someone who joins on the
    20th is first seen by the next month's run and their joining-month pro-rata
    would otherwise never be written.

    Regular types are pro-rated by ``_join_period_credit_hours`` (monthly honours
    the joining-rule cutoff; quarterly/half/yearly by months remaining). Statutory
    types get their full annual amount (legal entitlement, not pro-rated). Each
    credit is written with the SAME period key the cron would use, so:
      * a redelivered confirmation event is a no-op (idempotent), and
      * the regular cron never double-credits the same period.
    Returns the number of ledger entries written.
    """
    emp = await db[EMPLOYEES_COL].find_one({"user_id": to_oid(user_id)})
    if not emp:
        return 0
    org_id = str(emp["organisation_id"]) if emp.get("organisation_id") else None
    dept_id = str(emp["department_id"]) if emp.get("department_id") else None
    bu_id = str(emp["business_unit_id"]) if emp.get("business_unit_id") else None
    if not org_id:
        return 0

    from src.leave_plan_assignments.service import resolve_employee_plan

    emp_plan = await resolve_employee_plan(db, str(user_id), org_id, dept_id, bu_id)
    if not emp_plan:
        return 0
    plan_id = str(emp_plan["leave_plan_id"])
    plan = await db[PLANS_COL].find_one({"_id": to_oid(plan_id)})
    if not plan:
        return 0

    calendar_start_month = int(plan.get("calendar_start_month") or 1)
    leave_year = _leave_year(anchor_date, calendar_start_month)
    miy = _month_in_year(anchor_date, calendar_start_month)

    # Retro-credit guard. The joining path anchors on the employee's real
    # date_of_joining, so a re-published employee.created during an IAM backfill
    # would otherwise resolve a historical leave year, find no ledger row for it,
    # and credit an employee who joined years ago. Only ever credit the leave year
    # we are currently living in; anything older is an operator decision, made with
    # scripts/run_monthly_credit.py --date.
    current_leave_year = _leave_year(
        datetime.now(timezone.utc).date(), calendar_start_month
    )
    if leave_year != current_leave_year:
        logger.info(
            "Plan-entry credit skipped: anchor is outside the current leave year",
            user_id=str(user_id), anchor=str(anchor_date),
            anchor_leave_year=leave_year, current_leave_year=current_leave_year,
        )
        return 0

    entitlement_doc = await db[ENTITLEMENT_COL].find_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
    ) or {}
    entitlement = entitlement_doc.get("entitlement", {})
    distribution = entitlement.get("distribution", {})
    # Distribution is per-leave-type now (accrual_frequency on the type) — the
    # plan-level distribution.mode is no longer consulted.
    accrual_frequency = distribution.get("accrual_frequency")
    rounding_mode = entitlement.get("fractional_balance", {}).get("mode", "exact")

    grant_policy = await db[GRANT_POLICY_COL].find_one(
        {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
    ) or {}
    joining_rule = grant_policy.get("joining_rule") or entitlement.get("joining_rule") or {}

    lt_ids = await _get_leave_type_ids(db, plan_id, plan)
    if not lt_ids:
        return 0
    lt_docs = await db["leave_types"].find(
        {"_id": {"$in": [to_oid(lt) for lt in lt_ids]}},
        {"_id": 1, "is_statutory_leave": 1, "unit": 1, "accrual": 1, "max_statutory_days": 1},
    ).to_list(length=None)
    lt_meta = {str(d["_id"]): d for d in lt_docs}

    employee_id = str(emp["_id"])
    written = 0

    for lt_id in lt_ids:
        meta = lt_meta.get(lt_id, {})
        acc = meta.get("accrual") or {}
        unit = meta.get("unit", "DAYS")

        if bool(meta.get("is_statutory_leave")):
            # Statutory leave is a full legal entitlement — credit the whole amount
            # once, not pro-rated, on the same annual key the cron uses.
            cnt = meta.get("max_statutory_days")
            if cnt is None:
                cnt = acc.get("annual_count")
            if not cnt:
                continue
            amount = _round_hours(_to_hours(float(cnt), unit), rounding_mode)
            period_key = f"{leave_year}:ANNUAL"
            period_month = period_quarter = period_half = None
            ttype = CreditTransactionType.GRANT_CREDIT
        else:
            annual_count = acc.get("annual_count")
            if annual_count is None:
                continue
            # Per-type: the leave type's own accrual_frequency drives the schedule
            # (yearly = one annual lump sum). The plan distribution.mode is legacy.
            freq = acc.get("accrual_frequency") or accrual_frequency
            eff_freq = freq or "yearly"
            amount = _round_hours(
                _join_period_credit_hours(
                    float(annual_count), unit, eff_freq, anchor_date,
                    calendar_start_month, joining_rule,
                ),
                rounding_mode,
            )
            if eff_freq == "yearly":
                period_key = f"{leave_year}:ANNUAL"
                period_month = period_quarter = period_half = None
                ttype = CreditTransactionType.GRANT_CREDIT
            elif eff_freq == "monthly":
                period_key = f"{leave_year}:M{anchor_date.month:02d}"
                period_month, period_quarter, period_half = anchor_date.month, None, None
                ttype = CreditTransactionType.ACCRUAL_CREDIT
            elif eff_freq == "quarterly":
                q = _quarter(miy)
                period_key = f"{leave_year}:Q{q}"
                period_month, period_quarter, period_half = None, q, None
                ttype = CreditTransactionType.ACCRUAL_CREDIT
            elif eff_freq == "half_yearly":
                h = _half(miy)
                period_key = f"{leave_year}:H{h}"
                period_month, period_quarter, period_half = None, None, h
                ttype = CreditTransactionType.ACCRUAL_CREDIT
            elif eff_freq == "yearly":
                period_key = f"{leave_year}:Y"
                period_month = period_quarter = period_half = None
                ttype = CreditTransactionType.ACCRUAL_CREDIT
            else:
                continue

        if amount <= 0:
            continue
        if await _already_credited(db, employee_id, plan_id, lt_id, period_key):
            continue

        await _write_credit(
            db,
            employee_id=employee_id,
            org_id=org_id,
            plan_id=plan_id,
            lt_id=lt_id,
            transaction_type=ttype,
            amount_hours=amount,
            period_key=period_key,
            run_date=anchor_date,
            leave_year=leave_year,
            period_month=period_month,
            period_quarter=period_quarter,
            period_half=period_half,
            note=f"Confirmation pro-rata for leave year {leave_year} – plan {plan_id}",
            user_id=str(user_id),
        )
        written += 1

    logger.info(
        "Confirmation pro-rata credited",
        user_id=str(user_id), plan_id=plan_id, entries=written, anchor=str(anchor_date),
    )
    return written


# ── Per-plan processing ───────────────────────────────────────────────────────

async def process_leave_plan(
    db: AsyncIOMotorDatabase,
    plan: dict,
    run_date: date,
    only_leave_type_ids: Optional[set[str]] = None,
) -> dict:
    """
    Process one active leave plan for the month containing run_date.
    Returns a summary dict; sets 'skipped: True' with a reason when no credits are posted.

    ``only_leave_type_ids`` restricts the run to those leave types (ids as strings).
    ``None`` — the cron's value — means every type on the plan.
    """
    plan_id = str(plan["_id"])
    org_id = str(plan.get("org_id", ""))
    calendar_start_month = int(plan.get("calendar_start_month") or 1)

    leave_year = _leave_year(run_date, calendar_start_month)
    miy = _month_in_year(run_date, calendar_start_month)

    # ── Grant policy ──────────────────────────────────────────────────────────
    # The leave type is now the source of accrual config; the grant policy (when
    # present) only supplies joining rules + a legacy allocation fallback. It is
    # therefore optional — new plans created after the wizard slimming may have a
    # grant policy with no allocation, or none at all.
    grant_policy = await db[GRANT_POLICY_COL].find_one(
        {"leave_plan_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
    ) or {}

    # ── Entitlement configuration (legacy / optional) ─────────────────────────
    # Accrual + carry now live on each leave type. The plan entitlement is only a
    # fallback for legacy plans, so a missing entitlement doc is no longer fatal.
    entitlement_doc = await db[ENTITLEMENT_COL].find_one(
        {"leave_plan_id": to_oid(plan_id), "deleted_on": None}
    ) or {}

    entitlement = entitlement_doc.get("entitlement", {})
    distribution = entitlement.get("distribution", {})
    # Default to step_by_step so each leave type's own accrual_frequency drives
    # the period key (a "yearly" type then behaves as a single annual grant).
    distribution_mode: str = distribution.get("mode") or "step_by_step"
    accrual_frequency: Optional[str] = distribution.get("accrual_frequency")
    cycle_start_day: int = int(distribution.get("policy_cycle_start_day") or 1)
    rounding_mode: str = entitlement.get("fractional_balance", {}).get("mode", "exact")
    mid_year_cfg: dict = entitlement.get("mid_year_joining", {})
    probation_cfg: dict = entitlement.get("probation", {})

    # ── Leave types ───────────────────────────────────────────────────────────
    lt_ids = await _get_leave_type_ids(db, plan_id, plan)
    if not lt_ids:
        return {"plan_id": plan_id, "skipped": True, "reason": "no_leave_types"}

    # Operator-selected subset (scripts/run_monthly_credit.py). Applied here, before
    # the statutory/regular split, so every downstream decision — period keys,
    # probation banding, the "nothing due" early exit — sees only the chosen types.
    if only_leave_type_ids is not None:
        lt_ids = [lt for lt in lt_ids if lt in only_leave_type_ids]
        if not lt_ids:
            return {"plan_id": plan_id, "skipped": True, "reason": "no_selected_leave_types"}

    # Split leave types into statutory vs regular.
    # Statutory types are always credited as an annual lump sum at the start of
    # the leave year (calendar_start_month), regardless of the plan's accrual
    # frequency.  Regular types follow the plan's distribution_mode/accrual_frequency.
    lt_docs = await db["leave_types"].find(
        {"_id": {"$in": [to_oid(lt) for lt in lt_ids]}},
        {"_id": 1, "is_statutory_leave": 1, "unit": 1, "accrual": 1, "max_statutory_days": 1},
    ).to_list(length=None)
    lt_meta: dict[str, dict] = {str(d["_id"]): d for d in lt_docs}
    lt_statutory_flag: dict[str, bool] = {
        str(d["_id"]): bool(d.get("is_statutory_leave")) for d in lt_docs
    }
    statutory_lt_ids: list[str] = [lt for lt in lt_ids if lt_statutory_flag.get(lt)]
    regular_lt_ids: list[str] = [lt for lt in lt_ids if not lt_statutory_flag.get(lt)]

    alloc = grant_policy.get("allocation", {})
    annual_hours = _to_hours(float(alloc.get("amount", 0)), alloc.get("unit", "DAYS"))

    # ── Legacy plan-level posting cycles (fallback only) ──────────────────────
    # The leave type now owns its accrual config; these are consulted only when a
    # type has no accrual of its own (older plans).
    posting_cycles = distribution.get("posting_cycles") or []
    plan_pc_value: dict[str, float] = {  # per-period hours
        str(pc["leave_type_id"]): _to_hours(float(pc["value"]), pc.get("unit", "DAYS"))
        for pc in posting_cycles
        if pc.get("leave_type_id")
    }
    plan_pc_freq: dict[str, str] = {}
    for pc in posting_cycles:
        lt = str(pc.get("leave_type_id") or "")
        f = pc.get("accrual_frequency") or accrual_frequency
        if lt and f:
            plan_pc_freq[lt] = f

    def _type_freq(lt_id: str) -> Optional[str]:
        """Accrual frequency: leave type first, then legacy plan, then plan-level."""
        acc = lt_meta.get(lt_id, {}).get("accrual") or {}
        return acc.get("accrual_frequency") or plan_pc_freq.get(lt_id) or accrual_frequency

    def _type_annual_hours(lt_id: str) -> Optional[float]:
        """Annual hours from the leave type's own accrual config, else None."""
        meta = lt_meta.get(lt_id, {})
        acc = meta.get("accrual") or {}
        cnt = acc.get("annual_count")
        if cnt is None:
            return None
        return _to_hours(float(cnt), meta.get("unit", "DAYS"))

    # ── Per-type accrual frequency + per-period hours (leave-type first) ──────
    type_freq_map: dict[str, str] = {}
    posting_cycle_map: dict[str, float] = {}
    for lt_id in regular_lt_ids:
        freq = _type_freq(lt_id)
        if freq:
            type_freq_map[lt_id] = freq
        annual = _type_annual_hours(lt_id)
        if annual is not None:
            posting_cycle_map[lt_id] = annual / _FREQ_DIVISORS.get(freq or "yearly", 1)
        elif lt_id in plan_pc_value:
            posting_cycle_map[lt_id] = plan_pc_value[lt_id]
        # else: _credit_employee falls back to annual_hours / divisor

    # ── Statutory annual amounts (leave-type first) ──────────────────────────
    statutory_annual_map: dict[str, float] = {}
    for lt_id in statutory_lt_ids:
        annual = _type_annual_hours(lt_id)
        if annual is None:
            meta = lt_meta.get(lt_id, {})
            msd = meta.get("max_statutory_days")
            if msd is not None:
                annual = _to_hours(float(msd), meta.get("unit", "DAYS"))
        if annual is None:
            annual = (
                plan_pc_value[lt_id]
                * _FREQ_DIVISORS.get(plan_pc_freq.get(lt_id) or accrual_frequency or "", 1)
                if lt_id in plan_pc_value
                else annual_hours
            )
        statutory_annual_map[lt_id] = annual

    # ── Is a credit due this month? ───────────────────────────────────────────
    # Each regular leave type accrues on its OWN frequency, so resolve a period
    # key per type. Keys are always real calendar periods.
    def _regular_periods(freq: Optional[str]) -> list[tuple[str, date, int]]:
        # The leave TYPE's own accrual_frequency drives the schedule — distribution
        # was moved from the plan onto the leave type. "yearly"/none = one annual
        # lump sum; monthly/quarterly/half_yearly accrue on that cadence. The legacy
        # plan-level distribution.mode must NOT override the per-type frequency.
        eff_mode = "all_at_once" if (not freq or freq == "yearly") else "step_by_step"
        eff_freq = None if eff_mode == "all_at_once" else freq
        # Forward only: just the periods posting inside run_date's month. A month
        # that was never run is not recovered here — see _due_periods.
        return _due_periods(
            run_date, eff_mode, eff_freq,
            calendar_start_month, cycle_start_day, leave_year,
        )

    regular_period_keys: dict[str, list[tuple[str, date, int]]] = {}
    for lt_id in regular_lt_ids:
        periods = _regular_periods(type_freq_map.get(lt_id) or accrual_frequency)
        if periods:
            regular_period_keys[lt_id] = periods

    # Statutory types fire once a year on (calendar_start_month, cycle_start_day).
    #
    # The >= here is DELIBERATELY NOT forward-only, unlike _due_periods above. It is
    # what gives a MID-YEAR JOINER their statutory entitlement: they first appear in
    # the employee scan in, say, month 7, the key is still considered due, and
    # _already_credited is false for them, so they receive {year}:ANNUAL. Narrowing
    # this to the opening month would silently deny statutory leave — a legal
    # entitlement — to everyone who joins after it. Existing employees are protected
    # by _already_credited, so the replay costs nothing while the ledger is intact.
    if statutory_lt_ids:
        import calendar as _cal
        _stat_anchor = date(
            leave_year, calendar_start_month,
            min(cycle_start_day, _cal.monthrange(leave_year, calendar_start_month)[1]),
        )
        statutory_period_key: Optional[str] = (
            f"{leave_year}:ANNUAL" if run_date >= _stat_anchor else None
        )
    else:
        statutory_period_key = None

    # Tiered-probation bands post monthly on a cadence of their own, so they must
    # NOT be gated behind the regular types firing: on a plan whose types are all
    # annual/half-yearly, the checks below would skip every month except the leave
    # year's opening month and probationers would never receive their band.
    # The per-employee posting-day gate still lives in _probation_check.
    probation_tiered = (
        bool(probation_cfg.get("enabled"))
        and probation_cfg.get("credit_mode") == "tiered_by_duration"
        and bool(probation_leave_type_ids(probation_cfg))
    )
    probation_period_key: Optional[str] = None
    if probation_tiered:
        probation_period_key = _probation_period_key(leave_year, run_date)

    # Nothing to do if no regular type fires today, statutory types haven't
    # reached the start of the leave year, and no probation band is in play.
    effective_statutory_lt_ids = statutory_lt_ids if statutory_period_key else []
    if not regular_period_keys and not effective_statutory_lt_ids and not probation_period_key:
        return {"plan_id": plan_id, "skipped": True, "reason": "not_a_credit_day"}

    logger.info(
        "Credit due — processing plan",
        plan_id=plan_id,
        regular_period_keys=regular_period_keys,
        statutory_period_key=statutory_period_key,
        probation_period_key=probation_period_key,
        distribution_mode=distribution_mode,
        accrual_frequency=accrual_frequency,
        statutory_count=len(effective_statutory_lt_ids),
        regular_count=len(regular_period_keys),
        run_date=str(run_date),
    )

    # joining_rule now lives on the entitlement config (merged in from the grant
    # step); fall back to the grant policy for plans saved before the merge.
    joining_rule: dict = entitlement.get("joining_rule") or grant_policy.get("joining_rule", {})

    # ── Employee scope ────────────────────────────────────────────────────────
    emp_filter, probation_status_oids = await build_creditable_employee_filter(
        db, plan_id, org_id
    )
    if emp_filter is None:
        return {"plan_id": plan_id, "skipped": True, "reason": "no_assignments"}

    # ── Batch through employees ───────────────────────────────────────────────
    total_employees = total_written = 0
    skip = 0

    while True:
        batch = await db[EMPLOYEES_COL].find(
            emp_filter,
            {
                "_id": 1,
                "user_id": 1,
                "date_of_joining": 1,
                "joining_date": 1,
                "confirmation_date": 1,
                "employment_status": 1,
            },
        ).skip(skip).limit(BATCH_SIZE).to_list(length=None)

        if not batch:
            break

        for emp in batch:
            total_employees += 1
            try:
                written = await _credit_employee(
                    db,
                    employee_doc=emp,
                    org_id=org_id,
                    plan_id=plan_id,
                    regular_period_keys=regular_period_keys,
                    type_freq_map=type_freq_map,
                    statutory_lt_ids=effective_statutory_lt_ids,
                    statutory_annual_map=statutory_annual_map,
                    posting_cycle_map=posting_cycle_map,
                    annual_hours=annual_hours,
                    distribution_mode=distribution_mode,
                    accrual_frequency=accrual_frequency,
                    joining_rule=joining_rule,
                    mid_year_cfg=mid_year_cfg,
                    probation_cfg=probation_cfg,
                    probation_status_oids=probation_status_oids,
                    rounding_mode=rounding_mode,
                    run_date=run_date,
                    leave_year=leave_year,
                    calendar_start_month=calendar_start_month,
                    cycle_start_day=cycle_start_day,
                    miy=miy,
                    statutory_period_key=statutory_period_key,
                    probation_period_key=probation_period_key,
                    credit_expiry=entitlement.get("credit_expiry"),
                )
                total_written += written
            except Exception as exc:
                logger.error(
                    "Failed to credit employee",
                    employee_id=str(emp.get("_id")),
                    plan_id=plan_id,
                    error=str(exc),
                )

        skip += BATCH_SIZE

    logger.info(
        "Leave plan processed",
        plan_id=plan_id,
        regular_period_keys=regular_period_keys,
        total_employees=total_employees,
        total_written=total_written,
    )
    await emit_audit(
        action="leave_balance.processed",
        resource=f"leave_plan:{plan_id}:{leave_year}",
        actor_id="system",
        organisation_id=str(org_id) if org_id else None,
        details={
            "total_employees": total_employees,
            "total_written": total_written,
        },
    )
    return {
        "plan_id": plan_id,
        "regular_period_keys": regular_period_keys,
        "statutory_period_key": statutory_period_key,
        "total_employees": total_employees,
        "total_written": total_written,
    }


async def _dedup_credit_ledger(db: AsyncIOMotorDatabase) -> int:
    """Remove pre-existing duplicate accrual credits for the same (employee, plan,
    type, period_key) — keeping the earliest — and reverse the over-credit on the
    tracker. Runs once before the unique index can be built. Returns rows removed."""
    credit_types = [
        CreditTransactionType.GRANT_CREDIT.value,
        CreditTransactionType.ACCRUAL_CREDIT.value,
    ]
    groups = await db[LEDGER_COL].aggregate([
        {"$match": {"transaction_type": {"$in": credit_types}, "period_key": {"$type": "string"}}},
        {"$sort": {"created_on": 1}},
        {"$group": {
            "_id": {"e": "$employee_id", "p": "$leave_plan_id", "lt": "$leave_type_id", "k": "$period_key"},
            "ids": {"$push": "$_id"},
            "amounts": {"$push": "$amount"},
            "n": {"$sum": 1},
        }},
        {"$match": {"n": {"$gt": 1}}},
    ]).to_list(length=None)

    removed = 0
    for g in groups:
        extra_ids = g["ids"][1:]            # keep the earliest, drop the rest
        extra_amt = sum(g["amounts"][1:])
        await db[LEDGER_COL].delete_many({"_id": {"$in": extra_ids}})
        if extra_amt:                       # reverse the over-credit on the tracker
            emp = await db["employees"].find_one({"_id": g["_id"]["e"]}, {"user_id": 1})
            uid = emp.get("user_id") if emp else None
            if uid:
                await tracker_upsert_balance(
                    db, str(uid), str(g["_id"]["lt"]), str(g["_id"]["p"]), -extra_amt, SYSTEM_USER
                )
        removed += len(extra_ids)
    if removed:
        logger.warning("Deduped duplicate accrual credits", removed=removed)
    return removed


async def ensure_credit_ledger_indexes(db: AsyncIOMotorDatabase) -> None:
    """Partial-unique index so two concurrent cron runs can never double-credit the
    same (employee, plan, type, period). Idempotent — a no-op when it already
    exists; dedups first if legacy duplicates would block the build."""
    keys = [
        ("employee_id", 1), ("leave_plan_id", 1), ("leave_type_id", 1),
        ("period_key", 1), ("transaction_type", 1),
    ]
    opts = dict(
        unique=True,
        name="uniq_credit_period",
        partialFilterExpression={"period_key": {"$type": "string"}},
    )
    try:
        await db[LEDGER_COL].create_index(keys, **opts)
    except Exception:
        await _dedup_credit_ledger(db)
        try:
            await db[LEDGER_COL].create_index(keys, **opts)
        except Exception as exc:
            logger.warning("Could not create credit-ledger unique index", error=str(exc))


# ── Top-level entry point ─────────────────────────────────────────────────────

async def run_daily_credit_processing(
    db: AsyncIOMotorDatabase,
    run_date: Optional[date] = None,
    only_leave_type_ids: Optional[set[str]] = None,
) -> dict:
    """
    Process all active leave plans for the calendar month containing ``run_date``.

    The name is historical — the engine is forward-only and month-scoped, so what
    posts is "the periods anchored in run_date's month", not "today's credits".
    Running it twice in the same month is a no-op.

    Callers: the monthly credit cron, ``scripts/run_monthly_credit.py``, and
    ``src/holidays/router.py`` (holiday save with reprocess_leaves). The cron's
    once-a-month guard lives in the cron, NOT here, so the other two stay callable
    on any day.

    ``only_leave_type_ids`` restricts every plan to those leave types (ids as
    strings) — the operator-selected subset in run_monthly_credit.py. ``None``, the
    cron's value, means every type.
    """
    run_date = run_date or datetime.now(timezone.utc).date()
    logger.info("Leave balance processing started", run_date=str(run_date))
    # Guard the double-credit race: a unique index makes a concurrent duplicate
    # credit fail (caught idempotently in _write_credit).
    await ensure_credit_ledger_indexes(db)

    plans = await db[PLANS_COL].find(
        {"is_active": True, "deleted_on": None}
    ).to_list(length=None)

    results = []
    for plan in plans:
        try:
            result = await process_leave_plan(db, plan, run_date, only_leave_type_ids)
            results.append(result)
        except Exception as exc:
            plan_id = str(plan.get("_id", ""))
            logger.error("Unhandled error processing plan", plan_id=plan_id, error=str(exc))
            results.append({"plan_id": plan_id, "error": str(exc)})

    total = len(plans)
    skipped = sum(1 for r in results if r.get("skipped"))
    errors = sum(1 for r in results if r.get("error"))
    processed = total - skipped - errors

    logger.info(
        "Leave balance processing complete",
        run_date=str(run_date),
        total=total,
        processed=processed,
        skipped=skipped,
        errors=errors,
    )
    return {
        "run_date": str(run_date),
        "total_plans": total,
        "processed": processed,
        "skipped": skipped,
        "errors": errors,
        "results": results,
    }


async def run_credit_expiry(db: AsyncIOMotorDatabase) -> dict:
    """Lapse unused credit that has passed its expiry date.

    For every plan whose entitlement enables credit_expiry, and every employee +
    leave type on it, enforce one invariant:

        spendable balance  <=  sum of credits that have NOT yet expired

    Any excess balance must have come from now-expired credits, so it is removed
    from the tracker (a single ``EXPIRY_LAPSE`` debit). Properties:

      * Idempotent — a second run finds balance == alive and removes nothing.
      * Never drives the balance negative (``to_expire`` is clamped to >= 0 and the
        alive total is also >= 0).
      * FIFO-correct without per-credit bookkeeping — because used leave naturally
        reduces the balance, only the *unused* portion of expired credits lapses.
      * Safe for legacy data — credits with no ``expires_at`` (granted before expiry
        was configured) count as alive forever, so existing balances are never
        retro-expired. Admin manual credits are likewise treated as never-expiring.
    """
    from src.balance_tracker import get_balance_from_tracker
    from src.leave_holds.service import get_active_hold_hours

    now = datetime.now(timezone.utc)
    total_expired = 0.0
    plans_touched = 0

    ent_docs = await db["leave_entitlement_configurations"].find(
        {"entitlement.credit_expiry.expiry_enabled": True, "deleted_on": None},
        {"leave_plan_id": 1},
    ).to_list(length=None)

    for ent in ent_docs:
        plan_id = str(ent["leave_plan_id"])
        plan = await db[PLANS_COL].find_one(
            {"_id": to_oid(plan_id), "is_active": True, "deleted_on": None}
        )
        if not plan:
            continue
        org_id = str(plan["org_id"]) if plan.get("org_id") else None
        if not org_id:
            continue
        emp_filter = await _build_employee_filter(db, plan_id, org_id)
        if not emp_filter:
            continue
        lt_ids = await _get_leave_type_ids(db, plan_id, plan)
        if not lt_ids:
            continue
        lt_oids = [to_oid(x) for x in lt_ids]
        plans_touched += 1

        skip = 0
        while True:
            emps = await db["employees"].find(
                emp_filter, {"_id": 1, "user_id": 1}
            ).skip(skip).limit(BATCH_SIZE).to_list(length=None)
            if not emps:
                break
            for emp in emps:
                uid = emp.get("user_id")
                if not uid:
                    continue

                # Accrual credits that haven't expired yet (no expires_at = never).
                alive_rows = await db[LEDGER_COL].aggregate([
                    {"$match": {
                        "employee_id": emp["_id"],
                        "leave_type_id": {"$in": lt_oids},
                        "transaction_type": {"$in": [
                            CreditTransactionType.GRANT_CREDIT.value,
                            CreditTransactionType.ACCRUAL_CREDIT.value,
                            CreditTransactionType.ADJUSTMENT.value,
                        ]},
                        "$or": [
                            {"expires_at": None},
                            {"expires_at": {"$exists": False}},
                            {"expires_at": {"$gt": now}},
                        ],
                    }},
                    {"$group": {"_id": "$leave_type_id", "alive": {"$sum": "$amount"}}},
                ]).to_list(length=None)
                alive_by = {str(r["_id"]): float(r["alive"]) for r in alive_rows}

                # Admin manual credits (separate ledger, by user_id) never expire —
                # count them as alive so they're never wrongly lapsed.
                admin_rows = await db["leave_entitlement_ledger"].aggregate([
                    {"$match": {
                        "user_id": uid,
                        "leave_type_id": {"$in": lt_oids},
                        "transaction_type": {"$in": ["CREDIT", "ADJUSTMENT"]},
                    }},
                    {"$group": {"_id": "$leave_type_id", "amt": {"$sum": "$amount"}}},
                ]).to_list(length=None)
                for r in admin_rows:
                    alive_by[str(r["_id"])] = alive_by.get(str(r["_id"]), 0.0) + float(r["amt"])

                # Credits that HAVE expired — this bounds how much may lapse, so a
                # tracker balance with no expired credit behind it is never touched
                # (critical: balances not backed by stamped credits stay intact).
                expired_rows = await db[LEDGER_COL].aggregate([
                    {"$match": {
                        "employee_id": emp["_id"],
                        "leave_type_id": {"$in": lt_oids},
                        "transaction_type": {"$in": [
                            CreditTransactionType.GRANT_CREDIT.value,
                            CreditTransactionType.ACCRUAL_CREDIT.value,
                            CreditTransactionType.ADJUSTMENT.value,
                        ]},
                        "expires_at": {"$type": "date", "$lte": now},
                    }},
                    {"$group": {"_id": "$leave_type_id", "expired": {"$sum": "$amount"}}},
                ]).to_list(length=None)
                expired_by = {str(r["_id"]): float(r["expired"]) for r in expired_rows}

                for lt in lt_ids:
                    expired_total = expired_by.get(str(lt), 0.0)
                    if expired_total <= 0:
                        continue  # nothing has expired for this type — never touch it
                    bal = await get_balance_from_tracker(db, str(uid), str(lt)) or 0.0
                    alive = alive_by.get(str(lt), 0.0)
                    # Credit reserved by a PENDING request (a hold) is committed — a
                    # leave applied before the credit expired keeps it usable, so never
                    # lapse the held portion. Subtract active holds from the base. (D1)
                    held = await get_active_hold_hours(db, str(uid), str(lt))
                    # Lapse the unused, unreserved portion of expired credits, capped at
                    # what actually expired (== balance−alive−held when properly backed).
                    to_expire = round(max(0.0, min(bal - alive - held, expired_total)), 4)
                    if to_expire <= 0:
                        continue
                    await tracker_upsert_balance(
                        db, str(uid), str(lt), plan_id, -to_expire, SYSTEM_USER
                    )
                    await db[LEDGER_COL].insert_one({
                        "_id": str(uuid.uuid4()),
                        "employee_id": emp["_id"],
                        "org_id": to_oid(org_id),
                        "leave_plan_id": to_oid(plan_id),
                        "leave_type_id": to_oid(lt),
                        "transaction_type": CreditTransactionType.EXPIRY_LAPSE.value,
                        "amount": to_expire,
                        "effective_date": now,
                        "period_key": None,
                        "expires_at": None,
                        "note": "Unused credit lapsed at expiry",
                        "created_on": now,
                        "created_by": SYSTEM_USER,
                    })
                    total_expired += to_expire
            skip += BATCH_SIZE

    logger.info("Credit expiry complete", plans=plans_touched, expired_hours=total_expired)
    return {"plans": plans_touched, "expired_hours": total_expired}


async def run_stale_pending_cleanup(db: AsyncIOMotorDatabase, grace_days: int = 30) -> dict:
    """Auto-reject requests left PENDING more than ``grace_days`` past their end date.

    A leave that was applied for but never approved/rejected ties up reserved balance
    (its hold) indefinitely. Approval is the manager/HR's job, but as a safety net we
    close anything still PENDING long after the leave date has passed: mark it REJECTED
    and release the hold so the balance is freed. (Product decision: 30-day grace.)
    """
    from src.leave_holds.service import release_hold

    now = datetime.now(timezone.utc)
    cutoff = (now.date() - timedelta(days=grace_days)).isoformat()  # end_date is an ISO string
    stale = await db["leave_requests"].find(
        {"status": "PENDING", "deleted_on": None, "end_date": {"$lt": cutoff}},
        {"_id": 1},
    ).to_list(length=None)

    rejected = 0
    for r in stale:
        rid = str(r["_id"])
        res = await db["leave_requests"].update_one(
            {"_id": r["_id"], "status": "PENDING"},
            {"$set": {
                "status": "REJECTED",
                "auto_rejected": True,
                "reject_reason": f"Auto-closed: still pending more than {grace_days} days after the leave date",
                "modified_on": now,
                "modified_by": "system",
            }},
        )
        if res.modified_count:
            await release_hold(db, rid, "system")
            rejected += 1

    logger.info("Stale-pending cleanup complete", grace_days=grace_days, rejected=rejected)
    return {"rejected": rejected}
