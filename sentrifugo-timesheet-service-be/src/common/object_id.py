from __future__ import annotations

from bson import ObjectId


def is_valid_object_id(value: str) -> bool:
    """Return True if value is a valid 24-hex MongoDB ObjectId string."""
    return ObjectId.is_valid(value)
