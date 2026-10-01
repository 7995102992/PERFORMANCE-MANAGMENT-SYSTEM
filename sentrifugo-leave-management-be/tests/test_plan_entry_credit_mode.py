"""What each leave type is credited when an employee enters the normal plan.

Both callers of ``credit_employee_on_plan_entry`` — a probation → permanent
confirmation and a new joiner — go through the same rule, keyed on
encashability (``_entry_credit_mode``):

    statutory              full annual entitlement
    paid + encashable      pro-rated (earned leave converts to money)
    paid, not encashable   the current period's whole credit
    unpaid                 nothing

The scenario throughout: confirmed on 1 August, plan year starting in January.
"""

from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

import src.leave_balance_processor.processor as processor
from src.leave_balance_processor.processor import _entry_credit_mode

# to_oid is strict, so these must be real 24-char hex ids.
_USER_ID = "6a4f8da627261dbcc33a3ad3"
_EMPLOYEE_ID = "6a4f8da627261dbcc33a3ad4"
_ORG_ID = "6a481cbeefd9f278b3708209"
_DEPT_ID = "6a4f8da527261dbcc33a3ac9"
_BU_ID = "6a4b8aa0efd9f278b370829f"
_PLAN_ID = "6a4e2bca7173c2d8b1230748"

HOURS_PER_DAY = 8.0

# The real plan's types, trimmed to the fields the engine reads.
EARNED = {                       # 12 d/yr, half-yearly, encashable  -> pro-rate
    "_id": "6a4f8f830c7030ffeacfe8fc", "unit": "DAYS", "is_paid_leave": True,
    "is_statutory_leave": False,
    "accrual": {"annual_count": 12.0, "accrual_frequency": "half_yearly",
                "encashable": True, "encash_percentage": 100.0},
}
WELLNESS = {                     # 8 d/yr, half-yearly, not encashable -> full
    "_id": "6a58c5c8fd90e1e41995ca91", "unit": "DAYS", "is_paid_leave": True,
    "is_statutory_leave": False,
    "accrual": {"annual_count": 8.0, "accrual_frequency": "half_yearly",
                "encashable": False},
}
PATERNITY = {                    # 5 statutory days -> full annual
    "_id": "6a4f8f830c7030ffeacfe901", "unit": "DAYS", "is_paid_leave": True,
    "is_statutory_leave": True, "max_statutory_days": 5,
    "accrual": {"annual_count": 5.0, "accrual_frequency": "yearly",
                "encashable": False},
}
GARDEN = {                       # 60 d/yr but UNPAID -> nothing
    "_id": "6a4f8f830c7030ffeacfe902", "unit": "DAYS", "is_paid_leave": False,
    "is_statutory_leave": False,
    "accrual": {"annual_count": 60.0, "accrual_frequency": "yearly",
                "encashable": False},
}


def _august() -> date:
    """1 August of the leave year we are currently in — the plan-entry path
    refuses any anchor outside it, so the year cannot be hard-coded."""
    return date(datetime.now(timezone.utc).year, 8, 1)


def _db(types: list[dict]):
    employees = MagicMock()
    employees.find_one = AsyncMock(return_value={
        "_id": _EMPLOYEE_ID, "user_id": _USER_ID, "organisation_id": _ORG_ID,
        "department_id": _DEPT_ID, "business_unit_id": _BU_ID,
    })
    plans = MagicMock()
    plans.find_one = AsyncMock(return_value={"_id": _PLAN_ID, "calendar_start_month": 1})

    leave_types = MagicMock()
    cursor = MagicMock()
    cursor.to_list = AsyncMock(return_value=types)
    leave_types.find = MagicMock(return_value=cursor)

    empty = MagicMock()
    empty.find_one = AsyncMock(return_value=None)

    collections = {
        processor.EMPLOYEES_COL: employees,
        processor.PLANS_COL: plans,
        "leave_types": leave_types,
    }
    db = MagicMock()
    db.__getitem__.side_effect = lambda name: collections.get(name, empty)
    return db


@pytest.fixture
def credits(monkeypatch):
    """Capture what would be written; let every supplied type through."""
    monkeypatch.setattr(
        "src.leave_plan_assignments.service.resolve_employee_plan",
        AsyncMock(return_value={"leave_plan_id": _PLAN_ID}),
    )
    monkeypatch.setattr(processor, "_already_credited", AsyncMock(return_value=False))

    written: list[dict] = []

    async def _capture(db, **kwargs):
        written.append(kwargs)

    monkeypatch.setattr(processor, "_write_credit", _capture)
    return written


async def _enter_plan(credits, monkeypatch, types: list[dict]) -> dict:
    """Run the plan-entry credit for `types`; return {lt_id: amount_hours}."""
    monkeypatch.setattr(
        processor, "_get_leave_type_ids",
        AsyncMock(return_value=[t["_id"] for t in types]),
    )
    await processor.credit_employee_on_plan_entry(_db(types), _USER_ID, _august())
    return {w["lt_id"]: w["amount_hours"] for w in credits}


# ── The rule, on its own ─────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "leave_type, expected",
    [(EARNED, "prorate"), (WELLNESS, "full"), (PATERNITY, "full"), (GARDEN, None)],
    ids=["earned=encashable", "wellness=not encashable", "statutory", "unpaid"],
)
def test_encashability_decides_the_mode(leave_type, expected):
    assert _entry_credit_mode(leave_type) == expected


def test_statutory_is_full_even_when_marked_encashable():
    """A legal entitlement is never reduced, whatever the accrual config says."""
    encashable_statutory = {**PATERNITY, "accrual": {**PATERNITY["accrual"],
                                                     "encashable": True}}
    assert _entry_credit_mode(encashable_statutory) == "full"


# ── The rule, through the credit path ────────────────────────────────────────

async def test_earned_leave_is_prorated(credits, monkeypatch):
    """Half-yearly, 12 d/yr = 6 d per half. August is month 2 of H2, so 5 of the
    6 months remain: 6 * 5/6 = 5 days."""
    amounts = await _enter_plan(credits, monkeypatch, [EARNED])

    assert amounts[EARNED["_id"]] == pytest.approx(5.0 * HOURS_PER_DAY)


async def test_wellness_gets_the_whole_period(credits, monkeypatch):
    """Half-yearly, 8 d/yr = 4 d per half — credited whole, not 4 * 5/6."""
    amounts = await _enter_plan(credits, monkeypatch, [WELLNESS])

    assert amounts[WELLNESS["_id"]] == pytest.approx(4.0 * HOURS_PER_DAY)


async def test_statutory_gets_the_whole_year(credits, monkeypatch):
    amounts = await _enter_plan(credits, monkeypatch, [PATERNITY])

    assert amounts[PATERNITY["_id"]] == pytest.approx(5.0 * HOURS_PER_DAY)


async def test_unpaid_leave_is_not_credited(credits, monkeypatch):
    """Garden Leave declares 60 days a year but is unpaid — entering the plan
    must not hand anyone 60 days of it."""
    amounts = await _enter_plan(credits, monkeypatch, [GARDEN])

    assert amounts == {}


async def test_the_four_types_together(credits, monkeypatch):
    """The real shape of a confirmation: all four in one pass, each on its own
    rule."""
    amounts = await _enter_plan(
        credits, monkeypatch, [EARNED, WELLNESS, PATERNITY, GARDEN]
    )

    assert amounts == pytest.approx({
        EARNED["_id"]: 5.0 * HOURS_PER_DAY,
        WELLNESS["_id"]: 4.0 * HOURS_PER_DAY,
        PATERNITY["_id"]: 5.0 * HOURS_PER_DAY,
    })


# ── Why "full" is the period, not the year ───────────────────────────────────

async def test_a_full_credit_cannot_outrun_the_annual_entitlement(
    credits, monkeypatch
):
    """Regression guard on _full_period_credit_hours.

    The credit posts on the CURRENT period's key. Granting a full year on
    {year}:H1 would leave {year}:H2 open for the cron to credit again — 12 days
    on an 8-day type. The period's share is what keeps the year's total right.
    """
    monkeypatch.setattr(
        processor, "_get_leave_type_ids",
        AsyncMock(return_value=[WELLNESS["_id"]]),
    )
    february = date(datetime.now(timezone.utc).year, 2, 1)
    await processor.credit_employee_on_plan_entry(
        _db([WELLNESS]), _USER_ID, february
    )

    row = credits[0]
    annual_hours = WELLNESS["accrual"]["annual_count"] * HOURS_PER_DAY
    assert row["period_key"].endswith(":H1")
    assert row["amount_hours"] == pytest.approx(annual_hours / 2)
    assert row["amount_hours"] + annual_hours / 2 == pytest.approx(annual_hours), (
        "H1 credit plus the cron's later H2 credit must equal the year"
    )
