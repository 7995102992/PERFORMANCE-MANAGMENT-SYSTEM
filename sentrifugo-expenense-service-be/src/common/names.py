"""Small string helpers."""

from __future__ import annotations


def normalize_name(name: str | None) -> str:
    """Trim surrounding whitespace, treating ``None`` as an empty string.

    Args:
        name: Raw name value.

    Returns:
        The trimmed name, or ``""`` when ``name`` is ``None``.
    """
    return (name or "").strip()


def to_name_lc(name: str | None) -> str:
    """Return the normalized name lowercased, for case-insensitive lookups.

    Args:
        name: Raw name value.

    Returns:
        The trimmed, lowercased name.
    """
    return normalize_name(name).lower()
