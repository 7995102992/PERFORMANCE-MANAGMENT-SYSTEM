from __future__ import annotations


def normalize_name(name: str | None) -> str:
    return (name or "").strip()


def to_name_lc(name: str | None) -> str:
    return normalize_name(name).lower()
