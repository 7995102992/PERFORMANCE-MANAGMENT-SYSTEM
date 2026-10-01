"""Searching the project-head picker.

The picker can only offer what this endpoint returns, so the search has to run
here — filtering in the client can only ever narrow rows that were already sent.
Both groups are matched on the fields the picker labels rows with, and `total`
counts the matched set so an empty result reads as "no matches".
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from .conftest import make_query_mock, make_user

_CLIENT = PydanticObjectId("507f1f77bcf86cd799439011")
_OTHER = PydanticObjectId("507f1f77bcf86cd799439012")


def make_head(email, first="Venkat", last="Raman", client_id=_OTHER):
    h = MagicMock()
    h.id = PydanticObjectId("507f1f77bcf86cd7994390a1")
    h.client_id = client_id
    h.first_name = first
    h.last_name = last
    h.email = email
    h.phone = None
    h.iam_user_id = None
    return h


def make_emp(email, first="Asha", last="Rao", emp_code="EMP001"):
    return {
        "user_id": "u9",
        "emp_code": emp_code,
        "first_name": first,
        "last_name": last,
        "email": email,
        "business_unit_id": None,
        "department_id": None,
        "business_unit_name": None,
        "department_name": None,
    }


async def available(heads, employees, *, q=None, client_id=str(_CLIENT)):
    from src.client_project_heads import service

    client_doc = MagicMock()
    client_doc.business_unit_ids = []
    client_doc.department_ids = []

    with patch("src.client_project_heads.service.ClientProjectHead.find",
               MagicMock(return_value=make_query_mock(heads))), \
         patch("src.client_project_heads.service.Client.find",
               MagicMock(return_value=make_query_mock([]))), \
         patch("src.client_project_heads.service._client_scope_filter",
               AsyncMock(return_value=None)), \
         patch("src.client_project_heads.service._load_client",
               AsyncMock(return_value=client_doc)), \
         patch("src.client_project_heads.service.fetch_employees_in_scope",
               AsyncMock(return_value=employees)):
        return await service.list_available_project_heads(
            make_user(), client_id=client_id, q=q,
        )


class TestSearch:
    @pytest.mark.asyncio
    async def test_no_term_returns_both_groups_whole(self):
        out = await available(
            [make_head("venkat@x.com")], [make_emp("asha@x.com")],
        )

        assert len(out["external_heads"]) == 1
        assert len(out["employees"]) == 1
        assert out["total"] == 2

    @pytest.mark.asyncio
    async def test_a_blank_term_is_treated_as_absent(self):
        out = await available([make_head("venkat@x.com")], [make_emp("asha@x.com")], q="   ")

        assert out["total"] == 2

    @pytest.mark.asyncio
    async def test_it_matches_across_both_groups_at_once(self):
        """One term, both lists — the picker shows them together."""
        out = await available(
            [make_head("raman@x.com", "Venkat", "Raman"),
             make_head("gopal@x.com", "Gopal", "Nair")],
            [make_emp("asha@x.com", "Asha", "Rao"),
             make_emp("ravi@x.com", "Ravi", "Raman")],
            q="raman",
        )

        assert [p["email"] for p in out["external_heads"]] == ["raman@x.com"]
        assert [e["email"] for e in out["employees"]] == ["ravi@x.com"]
        assert out["total"] == 2

    @pytest.mark.asyncio
    async def test_it_matches_first_name_last_name_and_email(self):
        heads = [make_head("venkat.raman@yopmail.com", "Venkat", "Raman")]
        for term in ("venkat", "raman", "yopmail"):
            out = await available(heads, [], q=term)
            assert len(out["external_heads"]) == 1, term

    @pytest.mark.asyncio
    async def test_an_employee_matches_on_emp_code(self):
        """The picker labels employees with the code, so it must be searchable."""
        out = await available([], [make_emp("asha@x.com", emp_code="SAG1234")], q="sag12")

        assert len(out["employees"]) == 1

    @pytest.mark.asyncio
    async def test_it_matches_the_full_name_across_the_gap(self):
        """"venkat r" matches neither part alone."""
        out = await available([make_head("v@x.com", "Venkat", "Raman")], [], q="venkat r")

        assert len(out["external_heads"]) == 1

    @pytest.mark.asyncio
    async def test_matching_is_case_insensitive(self):
        out = await available([make_head("v@x.com", "Venkat", "Raman")], [], q="VENKAT")

        assert len(out["external_heads"]) == 1

    @pytest.mark.asyncio
    async def test_no_matches_returns_empty_groups_and_zero_total(self):
        """Distinguishable from a capped response — there is no cap."""
        out = await available(
            [make_head("venkat@x.com")], [make_emp("asha@x.com")], q="zzzznope",
        )

        assert out["employees"] == []
        assert out["external_heads"] == []
        assert out["total"] == 0

    @pytest.mark.asyncio
    async def test_a_regex_metacharacter_is_matched_literally(self):
        """The term is a substring, never a pattern."""
        out = await available([make_head("a.b@x.com", "Ann", "Bee")], [], q=".*")

        assert out["external_heads"] == []


class TestSearchDoesNotWeakenExclusion:
    @pytest.mark.asyncio
    async def test_someone_already_heading_the_client_stays_excluded(self):
        """The filter runs after exclusion, so a non-matching name cannot smuggle an
        existing head back into the picker."""
        out = await available(
            [make_head("venkat@x.com", "Venkat", "Raman", client_id=_CLIENT)],
            [make_emp("venkat@x.com", "Venkat", "Raman")],
            q="venkat",
        )

        assert out["external_heads"] == []
        assert out["employees"] == []
        assert out["total"] == 0

    @pytest.mark.asyncio
    async def test_an_employee_who_is_already_an_external_head_is_offered_once(self):
        out = await available(
            [make_head("venkat@x.com", "Venkat", "Raman")],
            [make_emp("venkat@x.com", "Venkat", "Raman")],
            q="venkat",
        )

        assert len(out["external_heads"]) == 1
        assert out["employees"] == []
