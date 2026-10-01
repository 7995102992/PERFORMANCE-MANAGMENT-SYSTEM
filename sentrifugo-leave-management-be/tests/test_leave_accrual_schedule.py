"""Scheduling rules for the forward-only monthly credit engine.

These cover the pure period-selection helpers — no DB, no mocking — plus the
retro-credit guard on the event-driven plan-entry path.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

import src.leave_balance_processor.processor as processor
from src.leave_balance_processor.cron import _is_credit_day, _month_key
from src.leave_balance_processor.processor import _due_periods


def _keys(run_date, mode, freq, *, csm=1, csd=1, leave_year=None):
    return [
        k for k, _, _ in _due_periods(
            run_date, mode, freq, csm, csd, leave_year or run_date.year
        )
    ]


# ── The incident ─────────────────────────────────────────────────────────────

def test_a_mid_month_run_credits_nothing_from_earlier_months():
    """Regression for 2026-08-08, which posted ANNUAL + H1 + H2 in one run.

    All three anchors (Jan 1, Jan 1, Jul 1) had passed, so catch-up offered them
    all at once. Forward-only must offer none of them.
    """
    august = datetime(2026, 8, 8, tzinfo=timezone.utc).date()
    assert _keys(august, "step_by_step", "half_yearly") == []
    assert _keys(august, "all_at_once", None) == []
    assert _keys(august, "step_by_step", "quarterly") == []


def test_the_run_month_still_credits_its_own_period():
    """Forward-only must not become "credit nothing" — August owes M08."""
    august = datetime(2026, 8, 8, tzinfo=timezone.utc).date()
    assert _keys(august, "step_by_step", "monthly") == ["2026:M08"]


# ── The month window ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("cycle_start_day", [1, 15, 28, 31])
def test_posting_day_does_not_gate_the_month(cycle_start_day):
    """The cron fires on the 1st; a plan posting on the 15th must still credit.

    Matching the posting day exactly would permanently skip every plan whose
    cycle_start_day is not 1 — the reason the rule is a month window.
    """
    first_of_september = datetime(2026, 9, 1, tzinfo=timezone.utc).date()
    assert _keys(
        first_of_september, "step_by_step", "monthly", csd=cycle_start_day
    ) == ["2026:M09"]


def test_a_posting_day_past_the_month_end_is_clamped_not_dropped():
    """cycle_start_day=31 in a 30-day month anchors on the 30th, still in-month."""
    november = datetime(2026, 11, 1, tzinfo=timezone.utc).date()
    assert _keys(november, "step_by_step", "monthly", csd=31) == ["2026:M11"]


@pytest.mark.parametrize(
    "month, freq, expected",
    [
        (1, "half_yearly", ["2026:H1"]),
        (7, "half_yearly", ["2026:H2"]),
        (8, "half_yearly", []),
        (10, "quarterly", ["2026:Q4"]),
        (11, "quarterly", []),
        (1, "yearly", ["2026:Y"]),
        (6, "yearly", []),
    ],
)
def test_each_period_fires_only_in_its_anchor_month(month, freq, expected):
    run_date = datetime(2026, month, 1, tzinfo=timezone.utc).date()
    assert _keys(run_date, "step_by_step", freq) == expected


def test_annual_grant_fires_only_in_the_leave_year_opening_month():
    assert _keys(
        datetime(2026, 1, 1, tzinfo=timezone.utc).date(), "all_at_once", None
    ) == ["2026:ANNUAL"]
    assert _keys(
        datetime(2026, 6, 1, tzinfo=timezone.utc).date(), "all_at_once", None
    ) == []


# ── Non-January leave years ──────────────────────────────────────────────────

def test_fiscal_leave_year_anchors_on_its_own_opening_month():
    """calendar_start_month=4: the annual grant belongs to April, not January."""
    april = datetime(2026, 4, 1, tzinfo=timezone.utc).date()
    august = datetime(2026, 8, 1, tzinfo=timezone.utc).date()
    assert _keys(april, "all_at_once", None, csm=4) == ["2026:ANNUAL"]
    assert _keys(august, "all_at_once", None, csm=4) == []


def test_a_fiscal_leave_year_spans_the_calendar_boundary():
    """Leave year 2026 (Apr start) still owes M01 in January 2027."""
    january = datetime(2027, 1, 1, tzinfo=timezone.utc).date()
    assert _keys(
        january, "step_by_step", "monthly", csm=4, leave_year=2026
    ) == ["2026:M01"]


# ── The cron's day gate ──────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "y, m, d, expected",
    [
        (2026, 12, 1, True),
        (2027, 1, 1, True),
        (2026, 2, 28, False),
        (2026, 12, 31, False),
        (2026, 8, 8, False),
    ],
)
def test_credit_day_is_the_first_of_the_month(y, m, d, expected):
    assert _is_credit_day(datetime(y, m, d, tzinfo=timezone.utc).date()) is expected


def test_month_key_is_stable_across_the_year_boundary():
    assert _month_key(datetime(2026, 12, 31, tzinfo=timezone.utc).date()) == "2026-12"
    assert _month_key(datetime(2027, 1, 1, tzinfo=timezone.utc).date()) == "2027-01"


# ── Retro-credit guard on the plan-entry path ────────────────────────────────

# to_oid is strict, so these must be real 24-char hex ids.
_USER_ID = "6a4f8da627261dbcc33a3ad3"
_EMPLOYEE_ID = "6a4f8da627261dbcc33a3ad4"
_ORG_ID = "6a481cbeefd9f278b3708209"
_DEPT_ID = "6a4f8da527261dbcc33a3ac9"
_BU_ID = "6a4b8aa0efd9f278b370829f"
_PLAN_ID = "6a4e2bca7173c2d8b1230748"


def _db_for_plan_entry():
    """Minimal db double: an employee, and the plan they resolve to."""
    employees = MagicMock()
    employees.find_one = AsyncMock(return_value={
        "_id": _EMPLOYEE_ID,
        "user_id": _USER_ID,
        "organisation_id": _ORG_ID,
        "department_id": _DEPT_ID,
        "business_unit_id": _BU_ID,
    })
    plans = MagicMock()
    plans.find_one = AsyncMock(return_value={
        "_id": _PLAN_ID, "calendar_start_month": 1,
    })
    empty = MagicMock()
    empty.find_one = AsyncMock(return_value=None)

    collections = {processor.EMPLOYEES_COL: employees, processor.PLANS_COL: plans}
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: collections.get(name, empty)
    return db


@pytest.fixture
def plan_entry_env(monkeypatch):
    """Stub out plan resolution and leave-type lookup.

    _get_leave_type_ids doubles as the probe: reaching it means the anchor passed
    the leave-year guard.
    """
    monkeypatch.setattr(
        "src.leave_plan_assignments.service.resolve_employee_plan",
        AsyncMock(return_value={"leave_plan_id": _PLAN_ID}),
    )
    reached = AsyncMock(return_value=[])
    monkeypatch.setattr(processor, "_get_leave_type_ids", reached)
    return reached


async def test_a_historical_joining_date_is_never_credited(plan_entry_env):
    """An IAM backfill re-publishing employee.created must not credit old joiners.

    Someone who joined years ago resolves a historical leave year, finds no ledger
    row for it, and would otherwise be credited in full.
    """
    today = datetime.now(timezone.utc).date()
    long_ago = today.replace(year=today.year - 3)

    written = await processor.credit_employee_on_plan_entry(
        _db_for_plan_entry(), _USER_ID,long_ago
    )

    assert written == 0
    assert plan_entry_env.await_count == 0, "bailed out before resolving leave types"


async def test_a_current_year_joining_date_proceeds(plan_entry_env):
    """The guard must not swallow a genuine new joiner."""
    today = datetime.now(timezone.utc).date()

    await processor.credit_employee_on_plan_entry(
        _db_for_plan_entry(), _USER_ID, today
    )

    assert plan_entry_env.await_count == 1, "guard let the current leave year through"


# ── Operator-selected leave types ────────────────────────────────────────────

def _db_for_plan_processing():
    """A db double that answers every find_one with None and every find with []."""
    collection = MagicMock()
    collection.find_one = AsyncMock(return_value=None)
    cursor = MagicMock()
    cursor.to_list = AsyncMock(return_value=[])
    collection.find = MagicMock(return_value=cursor)
    db = MagicMock()
    db.__getitem__.side_effect = lambda _name: collection
    return db


_JUNE = datetime(2026, 6, 1, tzinfo=timezone.utc).date()
_A_PLAN = {"_id": _PLAN_ID, "org_id": _ORG_ID, "calendar_start_month": 1}

# On the plan; the filter must let these through.
_TYPE_A = "6a4f8f830c7030ffeacfe8fc"
_TYPE_B = "6a4f8f830c7030ffeacfe900"
# Not on the plan; selecting only this must credit nothing.
_TYPE_ELSEWHERE = "6a58c5c8fd90e1e41995ca91"


@pytest.fixture
def two_leave_types(monkeypatch):
    monkeypatch.setattr(
        processor, "_get_leave_type_ids", AsyncMock(return_value=[_TYPE_A, _TYPE_B]),
    )


async def test_deselected_leave_types_stop_the_plan_before_crediting(two_leave_types):
    """run_monthly_credit.py restricts a run to the types the operator picked.

    A plan holding none of them must bail out before resolving employees, not
    quietly credit everything.
    """
    result = await processor.process_leave_plan(
        _db_for_plan_processing(), _A_PLAN, _JUNE,
        only_leave_type_ids={_TYPE_ELSEWHERE},
    )

    assert result["skipped"] is True
    assert result["reason"] == "no_selected_leave_types"


async def test_a_selected_leave_type_gets_past_the_filter(two_leave_types):
    """Selecting a type the plan holds must fall through to the normal decision.

    June anchors nothing for an annual type, so the expected outcome is the
    ordinary "not_a_credit_day" — reaching it proves the filter let the type by.
    """
    result = await processor.process_leave_plan(
        _db_for_plan_processing(), _A_PLAN, _JUNE, only_leave_type_ids={_TYPE_A},
    )

    assert result["reason"] == "not_a_credit_day"


async def test_no_selection_means_every_type(two_leave_types):
    """None is the cron's value and must not behave like an empty selection."""
    result = await processor.process_leave_plan(
        _db_for_plan_processing(), _A_PLAN, _JUNE,
    )

    assert result["reason"] == "not_a_credit_day"
