"""Unit tests for the leave-balance-hold feature.

When a balance-deducting, non-LOP leave request is submitted its hours are
reserved (held) in ``leave_balance_holds`` until approval (hold → debit) or
rejection/cancellation (hold released). The balance everyone validates against
is ``available = balance_hours − Σ(ACTIVE holds)``.

These cover the holds repository (src.leave_holds.service) and the
available-balance helper (src.balance_tracker.get_available_balance), which
together carry the core logic. The lifecycle wiring in leave_requests.service
is exercised end-to-end by the integration suite.
"""

from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bson import ObjectId

from src.balance_tracker import get_available_balance
from src.exceptions import DomainException
from src.leave_holds.service import (
    STATUS_ACTIVE,
    STATUS_CONVERTED,
    STATUS_RELEASED,
    convert_hold,
    create_hold,
    get_active_hold_hours,
    get_active_hold_hours_bulk,
    release_hold,
    update_hold_hours,
)
from src.leave_requests.validation import dates_to_datetimes, validate_and_compute

USER_ID = "507f1f77bcf86cd799439012"
TYPE_ID = "507f1f77bcf86cd799439014"
TYPE_ID_2 = "507f1f77bcf86cd799439015"
REQUEST_ID = "507f1f77bcf86cd799439020"


def _db_with_collection(collection):
    """Return a db mock whose [name] indexing yields the given collection mock."""
    db = MagicMock()
    db.__getitem__.return_value = collection
    return db


def _aggregate_cursor(rows):
    cursor = MagicMock()
    cursor.to_list = AsyncMock(return_value=rows)
    return cursor


def _request_doc(hours=24.0):
    return {
        "_id": ObjectId(REQUEST_ID),
        "user_id": ObjectId(USER_ID),
        "leave_type_id": ObjectId(TYPE_ID),
        "leave_plan_id": "plan-1",
        "duration_hours": hours,
    }


class TestCreateHold:
    @pytest.mark.asyncio
    async def test_creates_active_hold_with_request_hours(self):
        coll = MagicMock()
        coll.update_one = AsyncMock()
        db = _db_with_collection(coll)

        await create_hold(db, _request_doc(hours=24.0), actor_id=USER_ID)

        coll.update_one.assert_awaited_once()
        flt, update = coll.update_one.await_args.args[0], coll.update_one.await_args.args[1]
        assert flt == {"request_id": REQUEST_ID}
        assert update["$set"]["status"] == STATUS_ACTIVE
        assert update["$set"]["hours"] == 24.0
        # idempotent upsert keyed by request_id
        assert coll.update_one.await_args.kwargs["upsert"] is True
        assert update["$setOnInsert"]["request_id"] == REQUEST_ID

    @pytest.mark.asyncio
    async def test_half_day_holds_four_hours(self):
        coll = MagicMock()
        coll.update_one = AsyncMock()
        db = _db_with_collection(coll)

        await create_hold(db, _request_doc(hours=4.0), actor_id=USER_ID)

        update = coll.update_one.await_args.args[1]
        assert update["$set"]["hours"] == 4.0


class TestStatusTransitions:
    @pytest.mark.asyncio
    async def test_convert_marks_converted_only_when_active(self):
        coll = MagicMock()
        coll.update_one = AsyncMock()
        db = _db_with_collection(coll)

        await convert_hold(db, REQUEST_ID, actor_id=USER_ID)

        flt, update = coll.update_one.await_args.args
        assert flt == {"request_id": REQUEST_ID, "status": STATUS_ACTIVE}
        assert update["$set"]["status"] == STATUS_CONVERTED

    @pytest.mark.asyncio
    async def test_release_marks_released_only_when_active(self):
        coll = MagicMock()
        coll.update_one = AsyncMock()
        db = _db_with_collection(coll)

        await release_hold(db, REQUEST_ID, actor_id=USER_ID)

        flt, update = coll.update_one.await_args.args
        assert flt == {"request_id": REQUEST_ID, "status": STATUS_ACTIVE}
        assert update["$set"]["status"] == STATUS_RELEASED

    @pytest.mark.asyncio
    async def test_update_hold_hours_sets_new_hours(self):
        coll = MagicMock()
        coll.update_one = AsyncMock()
        db = _db_with_collection(coll)

        await update_hold_hours(db, REQUEST_ID, hours=16.0, actor_id=USER_ID)

        flt, update = coll.update_one.await_args.args
        assert flt == {"request_id": REQUEST_ID, "status": STATUS_ACTIVE}
        assert update["$set"]["hours"] == 16.0


class TestActiveHoldHours:
    @pytest.mark.asyncio
    async def test_sums_active_holds(self):
        coll = MagicMock()
        coll.aggregate = MagicMock(return_value=_aggregate_cursor([{"_id": None, "total": 40.0}]))
        db = _db_with_collection(coll)

        total = await get_active_hold_hours(db, USER_ID, TYPE_ID)
        assert total == 40.0

        pipeline = coll.aggregate.call_args.args[0]
        match = pipeline[0]["$match"]
        assert match["status"] == STATUS_ACTIVE
        assert "request_id" not in match  # no exclusion by default

    @pytest.mark.asyncio
    async def test_no_holds_returns_zero(self):
        coll = MagicMock()
        coll.aggregate = MagicMock(return_value=_aggregate_cursor([]))
        db = _db_with_collection(coll)

        assert await get_active_hold_hours(db, USER_ID, TYPE_ID) == 0.0

    @pytest.mark.asyncio
    async def test_exclude_request_id_filters_own_hold(self):
        coll = MagicMock()
        coll.aggregate = MagicMock(return_value=_aggregate_cursor([{"_id": None, "total": 8.0}]))
        db = _db_with_collection(coll)

        await get_active_hold_hours(db, USER_ID, TYPE_ID, exclude_request_id=REQUEST_ID)

        match = coll.aggregate.call_args.args[0][0]["$match"]
        assert match["request_id"] == {"$ne": REQUEST_ID}


class TestActiveHoldHoursBulk:
    @pytest.mark.asyncio
    async def test_maps_leave_type_to_held_hours(self):
        coll = MagicMock()
        coll.aggregate = MagicMock(return_value=_aggregate_cursor([
            {"_id": ObjectId(TYPE_ID), "total": 24.0},
            {"_id": ObjectId(TYPE_ID_2), "total": 8.0},
        ]))
        db = _db_with_collection(coll)

        result = await get_active_hold_hours_bulk(db, USER_ID)
        assert result == {TYPE_ID: 24.0, TYPE_ID_2: 8.0}


class TestGetAvailableBalance:
    @pytest.mark.asyncio
    async def test_available_is_balance_minus_holds(self):
        db = MagicMock()
        with (
            patch("src.balance_tracker.get_balance_from_tracker", new=AsyncMock(return_value=80.0)),
            patch("src.leave_holds.service.get_active_hold_hours", new=AsyncMock(return_value=24.0)),
        ):
            available = await get_available_balance(db, USER_ID, TYPE_ID)
        assert available == 56.0

    @pytest.mark.asyncio
    async def test_no_tracker_balance_treated_as_zero(self):
        db = MagicMock()
        with (
            patch("src.balance_tracker.get_balance_from_tracker", new=AsyncMock(return_value=None)),
            patch("src.leave_holds.service.get_active_hold_hours", new=AsyncMock(return_value=0.0)),
        ):
            assert await get_available_balance(db, USER_ID, TYPE_ID) == 0.0

    @pytest.mark.asyncio
    async def test_holds_can_drive_available_below_zero(self):
        # Defensive: if holds exceed balance, available goes negative rather than
        # being clamped — the caller's allow_negative_balance gate decides.
        db = MagicMock()
        with (
            patch("src.balance_tracker.get_balance_from_tracker", new=AsyncMock(return_value=8.0)),
            patch("src.leave_holds.service.get_active_hold_hours", new=AsyncMock(return_value=24.0)),
        ):
            assert await get_available_balance(db, USER_ID, TYPE_ID) == -16.0

    @pytest.mark.asyncio
    async def test_exclude_request_id_passed_through(self):
        db = MagicMock()
        held = AsyncMock(return_value=0.0)
        with (
            patch("src.balance_tracker.get_balance_from_tracker", new=AsyncMock(return_value=40.0)),
            patch("src.leave_holds.service.get_active_hold_hours", new=held),
        ):
            await get_available_balance(db, USER_ID, TYPE_ID, exclude_request_id=REQUEST_ID)
        assert held.await_args.args[3] == REQUEST_ID


# A working-day result for every day (weekday is irrelevant — duration just
# counts calendar days in range, isolating the balance-split logic).
_ALL_WORKING = {"is_working_day": True, "reason": "WORKING"}

# Minimal policy: every optional limit (monthly/continuous/clubbing/gap/backdated)
# disabled, so only the duration + balance logic runs.
_POLICY = {
    "entitlement": {
        "negative_balance": {"allow_negative_balance": False},
        # Backdated leave enabled so the fixed past test dates aren't rejected by
        # the backdated-date gate — these tests exercise the LOP/sufficiency split,
        # not the backdated rule.
        "backdated_leave": {"enabled": True, "max_days": 3650},
    },
    "rounding_strategy": "EXACT",
}
_LEAVE_TYPE = {"unit": "DAYS", "is_paid": True, "deduct_from_balance": True, "count_calendar_days": False}


def _no_overlap_db():
    coll = MagicMock()
    coll.find_one = AsyncMock(return_value=None)  # overlap check finds nothing
    return _db_with_collection(coll)


def _full_day_range(num_days):
    # Fixed in-year dates (weekday irrelevant — is_working_day is patched) so the
    # current-year guard always passes regardless of when the test runs.
    year = datetime.now(timezone.utc).year
    sd = date(year, 2, 2)
    ed = sd + timedelta(days=num_days - 1)
    return dates_to_datetimes(sd, ed, "FULL_DAYS")


class TestValidateAndComputeLopSplit:
    """The split: LOP keys off lop_balance_hours (raw); the sufficiency check
    keys off projected_balance_hours (available = raw − holds)."""

    @pytest.mark.asyncio
    async def test_lop_decision_uses_raw_balance(self):
        start, end = _full_day_range(1)
        lop = AsyncMock(return_value=False)
        with (
            patch("src.work_calendar.resolver.is_working_day", new=AsyncMock(return_value=_ALL_WORKING)),
            patch("src.leave_requests.validation.should_count_weekends_for_lop", new=lop),
        ):
            await validate_and_compute(
                _no_overlap_db(), USER_ID, TYPE_ID, start, end, _POLICY, _LEAVE_TYPE,
                projected_balance_hours=8.0,   # available — 1 day
                lop_balance_hours=80.0,        # raw — 10 days
            )
        # LOP must be evaluated against the raw figure, not the available one.
        assert lop.await_args.kwargs["balance_hours"] == 80.0

    @pytest.mark.asyncio
    async def test_sufficiency_uses_available_balance(self):
        start, end = _full_day_range(3)  # request 3 days
        with (
            patch("src.work_calendar.resolver.is_working_day", new=AsyncMock(return_value=_ALL_WORKING)),
            patch("src.leave_requests.validation.should_count_weekends_for_lop",
                  new=AsyncMock(return_value=False)),  # not LOP
        ):
            with pytest.raises(DomainException) as exc:
                await validate_and_compute(
                    _no_overlap_db(), USER_ID, TYPE_ID, start, end, _POLICY, _LEAVE_TYPE,
                    projected_balance_hours=8.0,   # available 1 day < 3 → reject
                    lop_balance_hours=80.0,        # raw 10 days would NOT reject
                )
        assert exc.value.code == "INSUFFICIENT_BALANCE"

    @pytest.mark.asyncio
    async def test_lop_request_skips_sufficiency(self):
        # raw <= 0 → LOP → allowed through unpaid even with zero balance.
        start, end = _full_day_range(3)
        with (
            patch("src.work_calendar.resolver.is_working_day", new=AsyncMock(return_value=_ALL_WORKING)),
            patch("src.leave_requests.validation.should_count_weekends_for_lop",
                  new=AsyncMock(return_value=True)),
        ):
            hours = await validate_and_compute(
                _no_overlap_db(), USER_ID, TYPE_ID, start, end, _POLICY, _LEAVE_TYPE,
                projected_balance_hours=0.0,
                lop_balance_hours=0.0,
            )
        assert hours == 24.0  # 3 days, not rejected

    @pytest.mark.asyncio
    async def test_lop_falls_back_to_available_when_no_raw_supplied(self):
        # Defensive: a caller that doesn't split still gets sensible behaviour —
        # LOP falls back to projected_balance_hours.
        start, end = _full_day_range(1)
        lop = AsyncMock(return_value=False)
        with (
            patch("src.work_calendar.resolver.is_working_day", new=AsyncMock(return_value=_ALL_WORKING)),
            patch("src.leave_requests.validation.should_count_weekends_for_lop", new=lop),
        ):
            await validate_and_compute(
                _no_overlap_db(), USER_ID, TYPE_ID, start, end, _POLICY, _LEAVE_TYPE,
                projected_balance_hours=40.0,   # no lop_balance_hours passed
            )
        assert lop.await_args.kwargs["balance_hours"] == 40.0
