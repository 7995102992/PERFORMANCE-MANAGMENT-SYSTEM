"""Department queue scoping — who the Employee Tickets / To Execute queue lists.

The queue used to resolve purely by department: every category staffed by the
caller's department, shown to everyone in it. It is roster-scoped now — where a
category names its primaries and secondaries, they are the audience and the rest
of the department is not.

These tests pin the predicate `_roster_visible_category_ids` builds, because the
predicate *is* the logic: the two `$or` branches are the whole decision. Hermetic
— `Category.find` and the IAM department lookup are both patched out.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.requests.service_list import _roster_visible_category_ids

ORG = PydanticObjectId()
DEPT = PydanticObjectId()
ME = PydanticObjectId()

CAT_A = PydanticObjectId()
CAT_B = PydanticObjectId()


def _user() -> SimpleNamespace:
    return SimpleNamespace(
        id=str(ME),
        oid=ME,
        org_oid=ORG,
        department_id=str(DEPT),
        email="me@example.com",
        access_token="t",
    )


def _patch_find(returns: list | None = None):
    """Patch Category.find, handing back the query it was called with."""
    cursor = MagicMock()
    cursor.to_list = AsyncMock(
        return_value=[SimpleNamespace(id=c) for c in (returns or [])]
    )
    return patch("src.requests.service_list.Category.find", return_value=cursor)


async def _run(user, *, returns=None):
    with _patch_find(returns) as find:
        ids = await _roster_visible_category_ids(user)
    return ids, find.call_args[0][0]


class TestRosterVisibleCategoryIds:
    @pytest.mark.asyncio
    async def test_roster_membership_qualifies_on_its_own(self):
        """Branch 1: I am on the roster — no department test applied.

        This is what lets a roster executor staffed out of *another* department
        see the queue, which the department-only sweep could never do.
        """
        _ids, query = await _run(_user())
        assert {"executors.user_id": ME} in query["$or"]

    @pytest.mark.asyncio
    async def test_rosterless_categories_still_resolve_by_department(self):
        """D4 — a category that named nobody keeps its department as the pool.

        Without this branch every category still running on department
        membership would list its tickets to no one at all.
        """
        _ids, query = await _run(_user())
        legacy = [c for c in query["$or"] if "executors.0" in c]
        assert len(legacy) == 1
        # Absent-or-empty, not `$size: 0` — the field is missing entirely on
        # documents written before the roster existed, which is most of them.
        assert legacy[0]["executors.0"] == {"$exists": False}
        assert legacy[0]["$or"] == [
            {"department_ids": DEPT},
            {"department_id": DEPT},
        ]

    @pytest.mark.asyncio
    async def test_a_rostered_category_is_not_offered_to_the_department(self):
        """The narrowing itself: no branch matches "in my department" alone.

        A category with a roster reaches the caller only through branch 1. If a
        clause ever matches department membership without also requiring an
        empty roster, the queue is department-scoped again.
        """
        _ids, query = await _run(_user())
        for clause in query["$or"]:
            if "department_ids" in repr(clause):
                assert clause.get("executors.0") == {"$exists": False}

    @pytest.mark.asyncio
    async def test_query_is_org_and_soft_delete_scoped(self):
        _ids, query = await _run(_user())
        assert query["organisation_id"] == ORG
        assert query["deleted_on"] is None

    @pytest.mark.asyncio
    async def test_no_department_leaves_only_the_roster_branch(self):
        """A caller IAM has no department for still sees what they are rostered
        on — previously this case returned nothing at all."""
        user = _user()
        user.department_id = None
        with patch(
            "src.requests.service_list._caller_department_id",
            AsyncMock(return_value=""),
        ):
            _ids, query = await _run(user)
        assert query["$or"] == [{"executors.user_id": ME}]

    @pytest.mark.asyncio
    async def test_returns_the_matched_category_ids(self):
        ids, _query = await _run(_user(), returns=[CAT_A, CAT_B])
        assert ids == [CAT_A, CAT_B]

    @pytest.mark.asyncio
    async def test_fails_closed(self):
        """A broken sweep must show nothing, never everything."""
        with patch(
            "src.requests.service_list.Category.find",
            side_effect=RuntimeError("mongo down"),
        ):
            assert await _roster_visible_category_ids(_user()) == []
