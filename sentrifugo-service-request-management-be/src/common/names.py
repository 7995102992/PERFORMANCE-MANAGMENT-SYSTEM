"""Small string helpers."""
from __future__ import annotations

import re


def normalize_name(name: str | None) -> str:
    return (name or "").strip()


def to_name_lc(name: str | None) -> str:
    return normalize_name(name).lower()


# Longest user-supplied search term we feed to Mongo. Nothing in the UI
# searches on more than a phrase, and unbounded input is the ReDoS lever.
SEARCH_TERM_MAX_LEN = 100


def search_regex(q: str | None) -> str | None:
    """Escape a caller-supplied search term for safe use inside a Mongo $regex.

    Metacharacters are escaped so the term matches literally — a raw needle
    both widens the search (``.*``, alternation) and lets a pathological
    pattern such as ``(a+)+$`` pin a core. Length is capped as well.

    Returns ``None`` when there is nothing to search for, so callers can skip
    the clause entirely instead of adding a match-everything regex.
    """
    needle = normalize_name(q)[:SEARCH_TERM_MAX_LEN]
    if not needle:
        return None
    return re.escape(needle)


# Path separators, control characters and header/quoting metacharacters — all
# stripped from client-supplied filenames before they are persisted.
_UNSAFE_FILENAME_CHARS = re.compile(r'[\x00-\x1f\x7f"\'`;:*?<>|]')


def safe_filename(name: str | None, *, fallback: str = "upload") -> str:
    """Normalise a client-supplied filename before it is stored / echoed back.

    Keeps the basename only (so ``../`` or a Windows/UNC prefix can't survive),
    drops control characters and quoting metacharacters, and caps the length.
    Falls back to ``fallback`` when nothing usable is left.
    """
    base = normalize_name(name).replace("\\", "/").rsplit("/", 1)[-1]
    base = _UNSAFE_FILENAME_CHARS.sub("_", base).strip(" .")
    return base[:120].strip(" .") or fallback
