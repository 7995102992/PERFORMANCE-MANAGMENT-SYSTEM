"""Resolving a user when IAM rejects the call — the replica fallback.

The SLA tick has no user token, so it calls IAM with ``access_token=None``. IAM
has no service principal (``IAM_SERVICE_TOKEN`` authenticates nothing
server-side), so ``/users`` and ``/employees`` 401 on *every* such call — not
only during an outage. The Valkey session lookup then only helps if that user
happens to be logged in at that instant.

``get_user`` already knew how to fall back to the local replica, but only inside
``except IAMError``, which catches transport failures. A 401 is a successful
HTTP response and never reached it, so the tick's breach email was skipped by a
falsy-email guard with no log line. These tests pin the 4xx path to the replica,
and pin that an unresolvable user is at least noisy.
"""
from __future__ import annotations

from itertools import count
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from src.integrations.iam_client import IAMClient, IAMError


pytestmark = pytest.mark.asyncio


# A distinct id per test. `get_user` consults the real Valkey user cache before
# anything else, and it outlives the test — sharing one id lets whatever the
# previous test resolved be served to the next one from cache.
_ids = count(1)


@pytest.fixture
def user_id() -> str:
    return f"6a481bf6efd9f278b370{next(_ids):04d}"


@pytest.fixture(autouse=True)
def no_cache():
    """Take Valkey out of the picture. Patched on `iam_client`, not on
    `src.valkey`: the module does `from ..valkey import get_valkey`, so the name
    it calls is its own and patching the source module misses it entirely."""
    with patch(
        "src.integrations.iam_client.get_valkey", side_effect=RuntimeError("no cache")
    ):
        yield


REPLICA_EMAIL = "exec@example.com"


def _replica_doc(uid: str) -> dict:
    return {"id": uid, "email": REPLICA_EMAIL, "name": "Executor"}


def _client() -> IAMClient:
    """A non-stub client. Stub mode returns canned users and would mask all of
    this — which is exactly why the defect survived the existing tests."""
    c = IAMClient()
    c.base_url = "http://iam.invalid"
    c.stub_mode = False
    c.token = "service-token-that-authenticates-nothing"
    return c


def _resp(status: int) -> httpx.Response:
    return httpx.Response(status, request=httpx.Request("GET", "http://iam.invalid/x"))


class TestFourZeroOneFallsBackToReplica:
    async def test_a_401_from_both_endpoints_resolves_from_the_replica(self, user_id):
        c = _client()
        doc = _replica_doc(user_id)
        with (
            patch.object(c, "_request", new_callable=AsyncMock, return_value=_resp(401)),
            patch.object(c, "_lookup_session", new_callable=AsyncMock, return_value=None),
            patch(
                "src.integrations.employee_replica.get",
                new_callable=AsyncMock,
                return_value=doc,
            ),
        ):
            assert await c.get_user(user_id) == doc

    async def test_a_404_falls_back_too(self, user_id):
        """Not only auth failures — any 4xx should prefer a known address over
        nothing."""
        c = _client()
        doc = _replica_doc(user_id)
        with (
            patch.object(c, "_request", new_callable=AsyncMock, return_value=_resp(404)),
            patch.object(c, "_lookup_session", new_callable=AsyncMock, return_value=None),
            patch(
                "src.integrations.employee_replica.get",
                new_callable=AsyncMock,
                return_value=doc,
            ),
        ):
            assert await c.get_user(user_id) == doc

    async def test_the_session_lookup_still_wins_when_it_hits(self, user_id):
        """Cheaper and fresher than the replica; order must not have flipped."""
        session_doc = {"id": user_id, "email": "from-session@example.com"}
        c = _client()
        replica = AsyncMock(return_value=_replica_doc(user_id))
        with (
            patch.object(c, "_request", new_callable=AsyncMock, return_value=_resp(401)),
            patch.object(
                c, "_lookup_session", new_callable=AsyncMock, return_value=session_doc
            ),
            patch("src.integrations.employee_replica.get", replica),
            patch(
                "src.integrations.employee_replica.upsert_read", new_callable=AsyncMock
            ),
        ):
            got = await c.get_user(user_id)

        assert got["email"] == "from-session@example.com"
        replica.assert_not_awaited()

    async def test_unknown_to_the_replica_still_returns_none(self, user_id):
        """The fallback narrows the gap, it does not close it — a user absent
        from the replica is still unresolvable."""
        c = _client()
        with (
            patch.object(c, "_request", new_callable=AsyncMock, return_value=_resp(401)),
            patch.object(c, "_lookup_session", new_callable=AsyncMock, return_value=None),
            patch(
                "src.integrations.employee_replica.get",
                new_callable=AsyncMock,
                return_value=None,
            ),
        ):
            assert await c.get_user(user_id) is None

    async def test_transport_failure_still_uses_the_replica(self, user_id):
        """The pre-existing IAMError path must survive the change."""
        c = _client()
        doc = _replica_doc(user_id)
        with (
            patch.object(
                c, "_request", new_callable=AsyncMock, side_effect=IAMError("down")
            ),
            patch(
                "src.integrations.employee_replica.get",
                new_callable=AsyncMock,
                return_value=doc,
            ),
        ):
            assert await c.get_user(user_id) == doc


class TestTheTickCanNowResolveAnAssignee:
    async def test_resolve_user_info_returns_an_address_from_the_replica(self, user_id):
        """End of the chain the SLA tick actually calls."""
        from src.common.email_resolver import resolve_user_info

        with patch(
            "src.common.email_resolver.get_iam_client"
        ) as get_client:
            get_client.return_value.get_user = AsyncMock(
                return_value=_replica_doc(user_id)
            )
            info = await resolve_user_info(user_id)

        assert info["email"] == REPLICA_EMAIL

    async def test_an_unresolved_user_is_logged_not_swallowed(self, caplog, user_id):
        """The failure that hid this defect: callers guard on a truthy email and
        skip silently, so 'nobody emailed' and 'nothing happened' looked the
        same in the logs."""
        from src.common.email_resolver import resolve_user_info

        with patch("src.common.email_resolver.get_iam_client") as get_client:
            get_client.return_value.get_user = AsyncMock(return_value=None)
            with caplog.at_level("WARNING"):
                info = await resolve_user_info(user_id)

        assert info == {"email": "", "name": ""}
        assert any("unresolved" in r.message for r in caplog.records)
