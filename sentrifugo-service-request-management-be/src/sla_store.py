"""SLA deadline store — Mongo-backed replacement for the Valkey ZSET.

Every SLA and workflow timer used to live in one Valkey sorted set,
``srm:sla:deadlines``, scored by epoch seconds. That made deadlines cache: a
Valkey restart or an eviction dropped them with no error and no log, and the
affected tickets simply never breached. The only recovery was someone noticing
and POSTing ``/_internal/jobs/rebuild-sla-cursor`` by hand.

They are persisted rows now. The three functions here map one-to-one onto the
Redis commands they replace, so call sites keep their existing shape:

    ZADD           → enrol(entries)
    ZREM           → drop(*members)
    ZRANGEBYSCORE  → claim_due(now, limit)
    + ZREM

Members keep the ``{service_request_id}:{event_kind}`` format the ZSET used,
so the tick's parsing and every caller's key building are unchanged.

Two behaviours are worth stating because they are load-bearing:

*Enrolling is an upsert.* ZADD moved an existing member's score rather than
adding a duplicate, and the callers rely on it — ``service_assign`` re-seeds
deadlines on every reassign, ``timer_enrolment`` rewrites them whenever a
workflow's escalation config changes. Inserting instead of upserting would
leave two rows for one timer and breach the ticket twice.

*Claiming is atomic.* The old read path did ZRANGEBYSCORE then ZREM as two
separate round trips, so two SRM replicas could pop the same entry and both act
on it — double priority bump, double escalation count. That is why
``sla_scheduler`` warns against running more than one instance. Here each entry
is taken with a single ``find_one_and_update`` that stamps ``claimed_at``, so a
second caller racing for the same row gets nothing.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import uuid4

from pymongo import ReturnDocument

from .common.timestamps import utcnow
from .models import SLADeadline

logger = logging.getLogger(__name__)


def _split_member(member: str) -> tuple[str, str]:
    """``'<ticket_id>:<event_kind>'`` → its parts.

    Mirrors the tick's own parsing: a member with no suffix means resolution.
    """
    parts = member.split(":")
    return parts[0], (parts[1] if len(parts) > 1 else "resolution")


async def enrol(entries: dict[str, float]) -> int:
    """Upsert timers. ``entries`` maps member → deadline as an epoch timestamp.

    Signature mirrors ``ZADD``'s mapping argument so callers that already build
    a ``{member: score}`` dict pass it straight through. Re-enrolling an
    existing member moves its ``due_at`` and clears any stale claim, exactly as
    ZADD overwrote a score.

    Returns the number of entries written. Never raises — enrolment is
    best-effort at every call site (a ticket must still be created even if its
    timer cannot be stored), and the reconciler picks up whatever was missed.
    """
    if not entries:
        return 0

    now = utcnow()
    written = 0
    for member, score in entries.items():
        sr_id, event_kind = _split_member(member)
        due_at = datetime.fromtimestamp(score, tz=timezone.utc)
        try:
            await SLADeadline.get_motor_collection().update_one(
                {"member": member},
                {
                    "$set": {
                        "member": member,
                        "service_request_id": sr_id,
                        "event_kind": event_kind,
                        "due_at": due_at,
                        # A re-enrolled timer is unclaimed by definition: the
                        # deadline moved, so any in-flight claim is stale.
                        "claimed_at": None,
                    },
                    # The upsert goes through the raw driver, which would let
                    # Mongo mint an ObjectId — but the model declares a string
                    # id, so Beanie cannot read such a row back. Supply one.
                    "$setOnInsert": {"_id": str(uuid4()), "created_at": now},
                },
                upsert=True,
            )
            written += 1
        except Exception:  # noqa: BLE001
            logger.warning("sla_store.enrol.failed member=%s", member, exc_info=True)
    return written


async def drop(*members: str) -> int:
    """Delete timers by member. Replaces ``ZREM``.

    Called when a deadline stops being relevant — first response given, ticket
    resolved, ticket closed. Deleting something that was never there is fine
    and is the common case (a ticket resolved before first response has no
    ``first_response`` row left to remove).
    """
    if not members:
        return 0
    try:
        result = await SLADeadline.get_motor_collection().delete_many(
            {"member": {"$in": list(members)}}
        )
        return result.deleted_count
    except Exception:  # noqa: BLE001
        logger.warning("sla_store.drop.failed members=%s", members, exc_info=True)
        return 0


async def claim_due(now: datetime, limit: int) -> list[tuple[str, float]]:
    """Atomically claim up to *limit* timers that are due, and return them.

    Returns ``[(member, due_at_epoch), ...]`` — the same shape
    ``zrangebyscore(..., withscores=True)`` returned, so the tick's loop over
    ``for member, score in entries`` is unchanged.

    Each row is taken with its own ``find_one_and_update`` on
    ``claimed_at: None``, which is what serialises concurrent ticks: whichever
    caller matches the row first wins it, the other moves on. Claimed rows are
    deleted here rather than after processing, matching the ZSET behaviour the
    tick was written against — an entry is consumed exactly once, and a ticket
    whose processing then fails is recovered by ``rebuild_sla_cursor``, not by
    a retry of this batch.
    """
    coll = SLADeadline.get_motor_collection()
    claimed: list[tuple[str, float]] = []

    for _ in range(limit):
        try:
            doc = await coll.find_one_and_update(
                {"due_at": {"$lte": now}, "claimed_at": None},
                {"$set": {"claimed_at": now}},
                sort=[("due_at", 1)],  # oldest deadline first
                return_document=ReturnDocument.AFTER,
            )
        except Exception:  # noqa: BLE001
            logger.warning("sla_store.claim.failed", exc_info=True)
            break
        if doc is None:
            break  # nothing left due

        due_at = doc["due_at"]
        if due_at.tzinfo is None:
            # Mongo hands back naive UTC; the tick compares against an aware
            # `now`, so normalise before returning.
            due_at = due_at.replace(tzinfo=timezone.utc)
        claimed.append((doc["member"], due_at.timestamp()))

    if claimed:
        try:
            await coll.delete_many({"member": {"$in": [m for m, _ in claimed]}})
        except Exception:  # noqa: BLE001
            # The rows stay claimed and will not be picked up again, so this
            # cannot double-fire; it only leaves rubbish behind.
            logger.warning("sla_store.claim.cleanup_failed", exc_info=True)

    return claimed
