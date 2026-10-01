"""Safe free-text search helpers for Mongo ``$regex`` filters.

User input must never reach ``$regex`` verbatim: regex metacharacters let the
caller change the meaning of the filter, and a nested-quantifier pattern can pin
the server's CPU (ReDoS). Escape the term and cap its length instead — the same
``re.escape`` idiom already used in ``common.user_resolver``.
"""

from __future__ import annotations

import re

# Longest search term we will build a pattern from; anything beyond is truncated.
MAX_SEARCH_LENGTH = 100


def regex_contains(q: str | None, *, case_insensitive: bool = True) -> dict | None:
    """Return a Mongo clause matching ``q`` as a literal substring.

    Returns ``None`` when there is nothing to search for, so callers can skip
    adding the filter entirely.
    """
    term = (q or "").strip()[:MAX_SEARCH_LENGTH]
    if not term:
        return None
    clause: dict = {"$regex": re.escape(term)}
    if case_insensitive:
        clause["$options"] = "i"
    return clause
