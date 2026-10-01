"""SLA deadline store — the two properties that used to be Valkey's job.

The ZSET gave these for free and losing either one is silent in production, so
they are worth pinning down:

  * enrolling an existing member *moves* its deadline (ZADD semantics). Insert
    instead of upsert and one timer becomes two rows, firing the same breach
    twice — double priority bump, double escalation count.
  * a due entry is claimed exactly once, even under concurrency. The old
    ZRANGEBYSCORE-then-ZREM was two round trips and could hand the same entry
    to two replicas.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta, timezone

import pytest

from src.common.timestamps import utcnow
from src.models import SLADeadline
from src.sla_store import claim_due, drop, enrol


pytestmark = pytest.mark.asyncio


def _epoch(dt):
    """Mongo hands datetimes back naive; ``.timestamp()`` would then read them
    as local time. ``claim_due`` normalises this itself — tests reading the
    document directly have to do the same."""
    return (dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt).timestamp()


class TestEnrol:
    async def test_enrols_and_splits_the_member(self):
        due = utcnow() + timedelta(minutes=30)
        await enrol({"ticket-1:first_response": due.timestamp()})

        doc = await SLADeadline.find_one({"member": "ticket-1:first_response"})
        assert doc is not None
        assert doc.service_request_id == "ticket-1"
        assert doc.event_kind == "first_response"
        assert doc.claimed_at is None

    async def test_member_without_suffix_defaults_to_resolution(self):
        await enrol({"ticket-2": utcnow().timestamp()})
        doc = await SLADeadline.find_one({"member": "ticket-2"})
        assert doc.event_kind == "resolution"

    async def test_re_enrolling_moves_the_deadline_and_does_not_duplicate(self):
        """The ZADD property. This is the double-fire guard."""
        first = utcnow() + timedelta(minutes=10)
        second = utcnow() + timedelta(minutes=90)

        await enrol({"ticket-3:resolution": first.timestamp()})
        await enrol({"ticket-3:resolution": second.timestamp()})

        docs = await SLADeadline.find({"member": "ticket-3:resolution"}).to_list()
        assert len(docs) == 1, "re-enrolment must upsert, not insert"
        assert _epoch(docs[0].due_at) == pytest.approx(second.timestamp(), abs=1)

    async def test_re_enrolling_clears_a_stale_claim(self):
        past = utcnow() - timedelta(minutes=5)
        await enrol({"ticket-4:resolution": past.timestamp()})
        await SLADeadline.get_motor_collection().update_one(
            {"member": "ticket-4:resolution"}, {"$set": {"claimed_at": utcnow()}}
        )

        await enrol({"ticket-4:resolution": (utcnow() + timedelta(hours=1)).timestamp()})

        doc = await SLADeadline.find_one({"member": "ticket-4:resolution"})
        assert doc.claimed_at is None

    async def test_empty_mapping_is_a_no_op(self):
        assert await enrol({}) == 0


class TestDrop:
    async def test_removes_named_members_only(self):
        now_ts = utcnow().timestamp()
        await enrol(
            {
                "ticket-5:first_response": now_ts,
                "ticket-5:resolution": now_ts,
                "ticket-6:resolution": now_ts,
            }
        )

        removed = await drop("ticket-5:first_response", "ticket-5:resolution")

        assert removed == 2
        remaining = await SLADeadline.find({}).to_list()
        assert [d.member for d in remaining] == ["ticket-6:resolution"]

    async def test_dropping_absent_members_is_harmless(self):
        """The common case — a ticket resolved before first response."""
        assert await drop("nope:first_response") == 0

    async def test_no_members_is_a_no_op(self):
        assert await drop() == 0


class TestClaimDue:
    async def test_returns_only_entries_that_are_due(self):
        now = utcnow()
        await enrol(
            {
                "past:resolution": (now - timedelta(minutes=1)).timestamp(),
                "future:resolution": (now + timedelta(hours=2)).timestamp(),
            }
        )

        claimed = await claim_due(now, 500)

        assert [m for m, _ in claimed] == ["past:resolution"]
        # The future entry stays put for a later tick.
        assert await SLADeadline.find_one({"member": "future:resolution"}) is not None

    async def test_returns_member_and_epoch_score_like_zrangebyscore(self):
        due = utcnow() - timedelta(seconds=30)
        await enrol({"ticket-7:auto_escalate": due.timestamp()})

        claimed = await claim_due(utcnow(), 500)

        assert len(claimed) == 1
        member, score = claimed[0]
        assert member == "ticket-7:auto_escalate"
        assert score == pytest.approx(due.timestamp(), abs=1)

    async def test_claimed_entries_are_consumed(self):
        past = utcnow() - timedelta(minutes=1)
        await enrol({"ticket-8:resolution": past.timestamp()})

        assert len(await claim_due(utcnow(), 500)) == 1
        assert await claim_due(utcnow(), 500) == []

    async def test_respects_the_limit(self):
        past = utcnow() - timedelta(minutes=1)
        await enrol({f"t{i}:resolution": past.timestamp() for i in range(5)})

        assert len(await claim_due(utcnow(), 2)) == 2
        assert len(await claim_due(utcnow(), 500)) == 3

    async def test_claims_oldest_deadline_first(self):
        now = utcnow()
        await enrol(
            {
                "later:resolution": (now - timedelta(minutes=1)).timestamp(),
                "earlier:resolution": (now - timedelta(minutes=30)).timestamp(),
            }
        )

        claimed = await claim_due(now, 500)

        assert [m for m, _ in claimed] == ["earlier:resolution", "later:resolution"]

    async def test_concurrent_ticks_never_claim_the_same_entry(self):
        """The atomicity property the ZSET never actually had."""
        past = utcnow() - timedelta(minutes=1)
        await enrol({f"race{i}:resolution": past.timestamp() for i in range(20)})

        now = utcnow()
        batches = await asyncio.gather(
            claim_due(now, 500), claim_due(now, 500), claim_due(now, 500)
        )

        claimed = [m for batch in batches for m, _ in batch]
        assert len(claimed) == 20, "every entry claimed exactly once"
        assert len(set(claimed)) == 20, "no entry claimed twice"

    async def test_nothing_due_returns_empty(self):
        await enrol({"future:resolution": (utcnow() + timedelta(days=1)).timestamp()})
        assert await claim_due(utcnow(), 500) == []
