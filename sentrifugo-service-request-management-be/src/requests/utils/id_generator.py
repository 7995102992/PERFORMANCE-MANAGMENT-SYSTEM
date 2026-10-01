"""Ticket number generator — Foundation §12.

Format: `SR-<YYYY>-<6-digit-seq>`, sequence per organisation per year,
atomic via Mongo `findOneAndUpdate`.

Counter doc `_id` = `"{organisation_id}:sr:{year}"`.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ...database import get_db


async def next_ticket_number(organisation_id: str, *, now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    year = moment.year
    counter_id = f"{organisation_id}:sr:{year}"
    result = await get_db()["counters"].find_one_and_update(
        {"_id": counter_id},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=True,  # pymongo ReturnDocument.AFTER
    )
    # motor returns the doc after the update — value is the new sequence.
    seq = int(result["value"])
    return f"SR-{year}-{seq:06d}"
