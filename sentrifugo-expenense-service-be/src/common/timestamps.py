"""UTC now — one source of truth."""

from __future__ import annotations

from datetime import UTC, datetime


def utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime.

    Returns:
        The current instant, with ``tzinfo`` set to UTC.
    """
    return datetime.now(UTC)
