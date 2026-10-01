"""Focused tests for the expiring / comp-off leave feature.

Covers the two pieces of new logic that carry the feature's rules:
  * LeaveTypeCreate/Update comp-off schema validators (pure)
  * validate_comp_off_worked_days apply-time validator (work calendar mocked)
"""

from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.exceptions import DomainException
from src.leave_types.schemas import LeaveTypeCreate, LeaveTypeUpdate
from src.leave_requests.validation import validate_comp_off_worked_days

TODAY = date(2026, 7, 16)  # a Thursday


# ── Leave-type schema validators ───────────────────────────────────────────

def test_comp_off_type_forces_paid_and_clears_accrual():
    lt = LeaveTypeCreate(
        org_id="507f1f77bcf86cd799439011",
        name="Comp Off",
        code="CO",
        is_comp_off=True,
        expiry_days=60,
        # deliberately contradict the flag — the validator must override:
        deduct_from_balance=True,
        is_statutory_leave=True,
        max_statutory_days=30,
    )
    assert lt.is_comp_off is True
    assert lt.expiry_days == 60
    assert lt.is_paid_leave is True and lt.is_paid is True
    assert lt.deduct_from_balance is False
    assert lt.deduct_from_leave_balance is False
    assert lt.is_statutory_leave is False
    assert lt.max_statutory_days is None
    assert lt.accrual is None


def test_comp_off_type_does_not_require_accrual():
    # A paid non-comp-off type WOULD require accrual; comp-off is exempt.
    lt = LeaveTypeCreate(name="X", code="X", is_comp_off=True, expiry_days=15)
    assert lt.accrual is None  # no accrual_rules_error raised


def test_comp_off_type_requires_positive_expiry():
    with pytest.raises(ValueError):
        LeaveTypeCreate(name="X", code="X", is_comp_off=True, expiry_days=0)
    with pytest.raises(ValueError):
        LeaveTypeCreate(name="X", code="X", is_comp_off=True)  # expiry missing


def test_update_comp_off_clears_and_requires_expiry():
    upd = LeaveTypeUpdate(is_comp_off=True, expiry_days=45)
    assert upd.is_paid_leave is True
    assert upd.deduct_from_balance is False
    assert upd.is_statutory_leave is False
    assert upd.accrual is None
    with pytest.raises(ValueError):
        LeaveTypeUpdate(is_comp_off=True, expiry_days=0)


# ── Apply-time worked-days validator ───────────────────────────────────────

def _calendar(working: dict[date, bool]):
    """AsyncMock is_working_day: True → a working day, False → weekend/holiday."""
    async def _impl(_db, _user, d):
        return {"is_working_day": working.get(d, False),
                "reason": "WORKING" if working.get(d, False) else "WEEKEND"}
    return AsyncMock(side_effect=_impl)


async def _run(worked, leave_days, expiry, calendar):
    with patch("src.work_calendar.resolver.is_working_day", calendar):
        await validate_comp_off_worked_days(
            MagicMock(), "u1", worked, leave_days, expiry, TODAY
        )


@pytest.mark.asyncio
async def test_happy_path_single_day():
    worked = [date(2026, 7, 11)]      # past Saturday (non-working)
    leave = [date(2026, 7, 20)]       # within 60 days, after the worked day
    await _run(worked, leave, 60, _calendar({}))  # no raise == pass


@pytest.mark.asyncio
async def test_empty_worked_dates_rejected():
    with pytest.raises(DomainException) as e:
        await _run([], [date(2026, 7, 20)], 60, _calendar({}))
    assert e.value.code == "COMP_OFF_WORKED_DAYS_REQUIRED"


@pytest.mark.asyncio
async def test_count_must_match_leave_days():
    worked = [date(2026, 7, 11)]
    leave = [date(2026, 7, 20), date(2026, 7, 21)]
    with pytest.raises(DomainException) as e:
        await _run(worked, leave, 60, _calendar({}))
    assert e.value.code == "COMP_OFF_WORKED_DAYS_COUNT_MISMATCH"


@pytest.mark.asyncio
async def test_duplicate_worked_day_rejected():
    d = date(2026, 7, 11)
    with pytest.raises(DomainException) as e:
        await _run([d, d], [date(2026, 7, 20), date(2026, 7, 21)], 60, _calendar({}))
    assert e.value.code == "COMP_OFF_DUPLICATE_WORKED_DAY"


@pytest.mark.asyncio
async def test_future_worked_day_rejected():
    worked = [date(2026, 7, 25)]      # after TODAY
    leave = [date(2026, 7, 30)]
    with pytest.raises(DomainException) as e:
        await _run(worked, leave, 60, _calendar({}))
    assert e.value.code == "COMP_OFF_WORKED_DAY_IN_FUTURE"


@pytest.mark.asyncio
async def test_working_day_cannot_be_compensated():
    worked = [date(2026, 7, 13)]      # past Monday, marked a working day
    leave = [date(2026, 7, 20)]
    cal = _calendar({date(2026, 7, 13): True})
    with pytest.raises(DomainException) as e:
        await _run(worked, leave, 60, cal)
    assert e.value.code == "COMP_OFF_WORKED_DAY_NOT_OFF_DAY"


@pytest.mark.asyncio
async def test_leave_beyond_expiry_rejected():
    worked = [date(2026, 5, 1)]       # non-working, far in the past
    leave = [date(2026, 7, 20)]       # 80 days later, > 30-day expiry
    with pytest.raises(DomainException) as e:
        await _run(worked, leave, 30, _calendar({}))
    assert e.value.code == "COMP_OFF_EXPIRED"


@pytest.mark.asyncio
async def test_leave_before_worked_day_rejected():
    worked = [date(2026, 7, 11)]
    leave = [date(2026, 7, 5)]        # before the worked day
    with pytest.raises(DomainException) as e:
        await _run(worked, leave, 60, _calendar({}))
    assert e.value.code == "COMP_OFF_LEAVE_BEFORE_WORKED_DAY"


@pytest.mark.asyncio
async def test_multi_day_pairing_passes():
    # Two worked days, two leave days, each pair within expiry.
    worked = [date(2026, 7, 4), date(2026, 7, 11)]     # Saturdays
    leave = [date(2026, 7, 20), date(2026, 7, 21)]
    await _run(worked, leave, 60, _calendar({}))       # no raise
