"""Unit tests for the Loss-of-Pay weekend rule.

Rule: weekends are charged toward the leave duration only when the leave is
explicitly unpaid — an unpaid leave type, or a request flagged loss_of_pay.
A paid balance-deducting type is NEVER auto-converted to LOP just because its
balance is exhausted (product decision: no auto-LOP — an over-spend is blocked
with INSUFFICIENT_BALANCE instead of silently charging weekends). Public
holidays are never charged.
"""

from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.leave_requests.validation import (
    _count_working_days,
    compute_duration_for_mode,
    should_count_weekends_for_lop,
)

USER_ID = "507f1f77bcf86cd799439012"
TYPE_ID = "507f1f77bcf86cd799439014"


def _day(reason):
    """Build an is_working_day() result for a given reason."""
    return {
        "is_working_day": reason is None,
        "reason": reason,
        "is_weekend": reason == "WEEKEND",
        "is_holiday": reason == "HOLIDAY",
    }


def _calendar_week(reasons):
    """Return an is_working_day side-effect that yields one reason per day."""
    it = iter(reasons)

    async def _side_effect(db, user_id, current, *a, **k):
        return _day(next(it))

    return _side_effect


# Mon 2026-06-01 .. Sun 2026-06-07: Mon-Fri working, Sat/Sun weekend.
WEEK_MON_SUN = [None, None, None, None, None, "WEEKEND", "WEEKEND"]


class TestShouldCountWeekendsForLop:
    @pytest.mark.asyncio
    async def test_explicit_loss_of_pay_flag(self):
        db = MagicMock()
        assert await should_count_weekends_for_lop(
            db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": True},
            loss_of_pay=True,
        ) is True

    @pytest.mark.asyncio
    async def test_unpaid_leave_type(self):
        db = MagicMock()
        assert await should_count_weekends_for_lop(
            db, USER_ID, TYPE_ID, {"is_paid": False, "deduct_from_balance": False},
        ) is True

    @pytest.mark.asyncio
    async def test_paid_non_deducting_type_is_not_lop(self):
        # WFH / bereavement / maternity: paid, no balance — not LOP.
        db = MagicMock()
        assert await should_count_weekends_for_lop(
            db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": False},
        ) is False

    @pytest.mark.asyncio
    async def test_paid_deducting_with_balance_is_not_lop(self):
        db = MagicMock()
        with patch(
            "src.balance_tracker.get_balance_from_tracker",
            new=AsyncMock(return_value=40.0),
        ):
            assert await should_count_weekends_for_lop(
                db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": True},
            ) is False

    @pytest.mark.asyncio
    async def test_paid_deducting_with_zero_balance_is_not_auto_lop(self):
        # Product decision: NO auto-LOP. A paid balance-deducting type with an
        # exhausted balance is NOT silently treated as LOP — the over-spend is
        # rejected elsewhere (INSUFFICIENT_BALANCE) rather than charging weekends.
        # The tracker is never consulted for this decision anymore.
        db = MagicMock()
        assert await should_count_weekends_for_lop(
            db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": True},
        ) is False

    @pytest.mark.asyncio
    async def test_projected_balance_override_avoids_lop(self):
        # Current balance is 0, but the caller passes a projected-by-leave-date
        # balance (accruals before the leave) > 0 — so it is NOT LOP, and the
        # tracker is never read.
        db = MagicMock()
        tracker = AsyncMock(return_value=0.0)
        with patch("src.balance_tracker.get_balance_from_tracker", new=tracker):
            result = await should_count_weekends_for_lop(
                db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": True},
                balance_hours=16.0,
            )
        assert result is False
        tracker.assert_not_called()

    @pytest.mark.asyncio
    async def test_projected_balance_override_zero_is_not_auto_lop(self):
        # Even with a zero projected balance, a paid deducting type is not
        # auto-LOP (no auto-LOP product decision).
        db = MagicMock()
        result = await should_count_weekends_for_lop(
            db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": True},
            balance_hours=0.0,
        )
        assert result is False

    @pytest.mark.asyncio
    async def test_allow_negative_balance_stays_paid(self):
        db = MagicMock()
        # allow_negative short-circuits before the balance is even read.
        assert await should_count_weekends_for_lop(
            db, USER_ID, TYPE_ID, {"is_paid": True, "deduct_from_balance": True},
            allow_negative_balance=True,
        ) is False


class TestCountWorkingDays:
    @pytest.mark.asyncio
    async def test_excludes_weekends_by_default(self):
        db = MagicMock()
        with patch(
            "src.work_calendar.resolver.is_working_day",
            new=AsyncMock(side_effect=_calendar_week(WEEK_MON_SUN)),
        ):
            days = await _count_working_days(
                db, date(2026, 6, 1), date(2026, 6, 7), USER_ID,
            )
        assert days == 5

    @pytest.mark.asyncio
    async def test_includes_weekends_when_lop(self):
        db = MagicMock()
        with patch(
            "src.work_calendar.resolver.is_working_day",
            new=AsyncMock(side_effect=_calendar_week(WEEK_MON_SUN)),
        ):
            days = await _count_working_days(
                db, date(2026, 6, 1), date(2026, 6, 7), USER_ID,
                include_weekends=True,
            )
        assert days == 7

    @pytest.mark.asyncio
    async def test_holiday_never_counted_even_under_lop(self):
        db = MagicMock()
        # Mon working, Tue holiday, Wed-Fri working, Sat/Sun weekend.
        week = [None, "HOLIDAY", None, None, None, "WEEKEND", "WEEKEND"]
        with patch(
            "src.work_calendar.resolver.is_working_day",
            new=AsyncMock(side_effect=_calendar_week(week)),
        ):
            days = await _count_working_days(
                db, date(2026, 6, 1), date(2026, 6, 7), USER_ID,
                include_weekends=True,
            )
        # 4 working + 2 weekend, holiday excluded.
        assert days == 6


class TestComputeDurationForMode:
    @pytest.mark.asyncio
    async def test_full_days_lop_includes_weekends(self):
        db = MagicMock()
        with patch(
            "src.work_calendar.resolver.is_working_day",
            new=AsyncMock(side_effect=_calendar_week(WEEK_MON_SUN)),
        ):
            hours = await compute_duration_for_mode(
                db, date(2026, 6, 1), date(2026, 6, 7), USER_ID,
                "FULL_DAYS", include_weekends=True,
            )
        assert hours == 7 * 8.0
