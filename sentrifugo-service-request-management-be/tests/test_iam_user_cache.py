"""`get_user` must not cache a miss.

The cache read is `if cached: return json.loads(cached)`. `json.dumps(None)` is
the string `"null"` — truthy on read, `None` after decoding — so writing a miss
pins that user as non-existent for the whole TTL and every later `get_user`
returns None without asking IAM again.

Downstream that reads as "user is not eligible": `assign_executor`,
`reassign_executor` and `escalate` all reject a target whose `get_user` comes
back empty, and approval-submit cannot resolve approvers. One transient miss is
enough — the 401 path in `get_user` returns None on a live HTTP response rather
than raising `IAMError`, so it never reaches the replica fallback — and the
damage outlives the outage that caused it.

Found when a passing test started failing only when run alongside its
neighbours: an earlier miss had poisoned the shared Valkey entry for a user the
later test needed.
"""
from __future__ import annotations

import json

import pytest_asyncio

from src.integrations import iam_client as iam_module
from src.integrations.iam_client import STUB_USER_EMPLOYEE_ID, get_iam_client
from src.valkey import get_valkey, user_cache_key

ABSENT_USER_ID = "5f00000000000000000000ff"  # not in the stub tables


@pytest_asyncio.fixture(autouse=True)
async def _clean_cache():
    """Leave the shared Valkey exactly as found — this database is shared."""
    cache = get_valkey()
    keys = [user_cache_key(ABSENT_USER_ID), user_cache_key(STUB_USER_EMPLOYEE_ID)]
    for k in keys:
        await cache.delete(k)
    yield
    for k in keys:
        await cache.delete(k)


class TestGetUserCaching:
    async def test_a_miss_is_not_cached(self):
        iam_module._instance = None
        iam = get_iam_client()
        assert await iam.get_user(ABSENT_USER_ID) is None

        cached = await get_valkey().get(user_cache_key(ABSENT_USER_ID))
        assert cached is None, (
            f"cached a miss as {cached!r} — this pins the user as non-existent "
            "for the whole TTL"
        )

    async def test_a_miss_does_not_stick(self):
        """The consequence, stated directly: a second call must still resolve
        the user if IAM knows about them."""
        iam_module._instance = None
        iam = get_iam_client()
        await iam.get_user(ABSENT_USER_ID)
        # Now ask for a user who DOES exist, having just taken the miss path.
        found = await iam.get_user(STUB_USER_EMPLOYEE_ID)
        assert found is not None
        assert found["email"] == "employee@demo.local"

    async def test_a_hit_is_still_cached(self):
        """The fix must not turn the cache off."""
        iam_module._instance = None
        iam = get_iam_client()
        assert await iam.get_user(STUB_USER_EMPLOYEE_ID) is not None

        cached = await get_valkey().get(user_cache_key(STUB_USER_EMPLOYEE_ID))
        assert cached is not None
        assert json.loads(cached)["email"] == "employee@demo.local"
