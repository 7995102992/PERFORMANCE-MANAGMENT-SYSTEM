"""Project responses carry their client and project-head names.

The frontend used to fetch /clients and /client-project-heads purely to turn ids
into labels. The names ride along now, resolved in batch so a page of projects
costs two extra queries rather than two per row.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from .conftest import make_query_mock, make_user

_C1 = PydanticObjectId("507f1f77bcf86cd799439011")
_C2 = PydanticObjectId("507f1f77bcf86cd799439012")
_H1 = PydanticObjectId("507f1f77bcf86cd7994390a1")
_H2 = PydanticObjectId("507f1f77bcf86cd7994390a2")


def make_project(client_id=_C1, heads=(), name="Website Revamp"):
    p = MagicMock()
    p.id = PydanticObjectId("507f1f77bcf86cd799439021")
    p.organisation_id = "org1"
    p.client_id = client_id
    p.name = name
    p.code = "WR"
    p.project_head_ids = list(heads)
    p.start_date = None
    p.end_date = None
    p.created_by = None
    p.modified_by = None
    return p


def _viewer():
    return make_user(is_org_admin=True, is_super_admin=False)


def make_cph(hid, first="Venkat", last="Raman", email="venkat.raman@yopmail.com"):
    """A ClientProjectHead row — the client-side kind of project head."""
    h = MagicMock()
    h.id = hid
    h.first_name = first
    h.last_name = last
    h.email = email
    return h


def make_client(cid, name):
    c = MagicMock()
    c.id = cid
    c.name = name
    return c


class TestWithNames:
    @pytest.mark.asyncio
    async def test_it_fills_client_and_head_names(self):
        from src.projects import service

        with patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([make_client(_C1, "Acme")]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(return_value={_H1: "Gopal Nair", _H2: "Asha Rao"})):
            out = await service._with_names([make_project(heads=[_H1, _H2])], _viewer())

        assert out[0]["client_name"] == "Acme"
        assert out[0]["project_head_names"] == ["Gopal Nair", "Asha Rao"]
        assert out[0]["project_head_ids"] == [str(_H1), str(_H2)]

    @pytest.mark.asyncio
    async def test_head_names_follow_the_id_order(self):
        from src.projects import service

        with patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(return_value={_H1: "Gopal Nair", _H2: "Asha Rao"})):
            out = await service._with_names([make_project(heads=[_H2, _H1])], _viewer())

        assert out[0]["project_head_names"] == ["Asha Rao", "Gopal Nair"]

    @pytest.mark.asyncio
    async def test_an_unresolvable_head_is_skipped_not_crashed(self):
        """A head whose IAM record is gone must not break the whole page."""
        from src.projects import service

        with patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(return_value={_H1: "Gopal Nair"})):
            out = await service._with_names([make_project(heads=[_H1, _H2])], _viewer())

        assert out[0]["project_head_names"] == ["Gopal Nair"]
        assert out[0]["client_name"] is None

    @pytest.mark.asyncio
    async def test_a_page_resolves_in_two_queries(self):
        from src.projects import service

        client_find = MagicMock(return_value=make_query_mock(
            [make_client(_C1, "Acme"), make_client(_C2, "Globex")]))
        resolver = AsyncMock(return_value={_H1: "Gopal Nair"})
        projects = [
            make_project(_C1, [_H1], "One"),
            make_project(_C2, [_H1], "Two"),
            make_project(_C1, [], "Three"),
        ]

        with patch("src.projects.service.Client.find", client_find), \
             patch("src.projects.service.resolve_user_names", resolver):
            out = await service._with_names(projects, _viewer())

        assert client_find.call_count == 1
        assert resolver.await_count == 1
        assert [o["client_name"] for o in out] == ["Acme", "Globex", "Acme"]

    @pytest.mark.asyncio
    async def test_an_iam_outage_still_returns_the_projects(self):
        """Names are a label; losing IAM must not take project reads down with it."""
        from src.projects import service

        with patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([make_client(_C1, "Acme")]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(side_effect=RuntimeError("Mongo client not initialised"))):
            out = await service._with_names([make_project(heads=[_H1])], _viewer())

        assert out[0]["client_name"] == "Acme"
        assert out[0]["project_head_names"] == []
        assert out[0]["project_head_ids"] == [str(_H1)]

    @pytest.mark.asyncio
    async def test_no_projects_makes_no_queries(self):
        from src.projects import service

        client_find = MagicMock()
        with patch("src.projects.service.Client.find", client_find):
            assert await service._with_names([], _viewer()) == []
        client_find.assert_not_called()


class TestClientSideHeads:
    """`project_head_ids` is polymorphic: an internal head is an IAM user id, a
    client-side head is a ClientProjectHead row. Resolving only the first kind left
    client projects with a blank head column and the id still in the payload.
    """

    async def render(self, heads, iam_names, cph_rows):
        from src.projects import service

        with patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(return_value=iam_names)), \
             patch("src.projects.service.ClientProjectHead.find",
                   MagicMock(return_value=make_query_mock(cph_rows))) as cph_find:
            out = await service._with_names([make_project(heads=heads)], _viewer())
        return out[0], cph_find

    @pytest.mark.asyncio
    async def test_a_client_side_head_resolves_to_a_name(self):
        row, _ = await self.render([_H1], {}, [make_cph(_H1, "Venkat", "Raman")])

        assert row["project_head_names"] == ["Venkat Raman"]
        assert row["project_head_ids"] == [str(_H1)]

    @pytest.mark.asyncio
    async def test_an_iam_head_never_reaches_the_second_lookup(self):
        """Everything resolved already — no reason to touch the other collection."""
        row, cph_find = await self.render([_H1], {_H1: "Gopal Nair"}, [])

        assert row["project_head_names"] == ["Gopal Nair"]
        cph_find.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_project_can_mix_both_kinds_in_order(self):
        row, _ = await self.render(
            [_H1, _H2], {_H2: "Gopal Nair"}, [make_cph(_H1, "Venkat", "Raman")],
        )

        assert row["project_head_names"] == ["Venkat Raman", "Gopal Nair"]

    @pytest.mark.asyncio
    async def test_a_nameless_client_head_falls_back_to_its_email(self):
        row, _ = await self.render(
            [_H1], {}, [make_cph(_H1, "", "", email="venkat.raman@yopmail.com")],
        )

        assert row["project_head_names"] == ["venkat.raman@yopmail.com"]

    @pytest.mark.asyncio
    async def test_a_dangling_head_id_is_skipped_not_crashed(self):
        """Live data carries head ids that match neither kind."""
        row, _ = await self.render([_H1], {}, [])

        assert row["project_head_names"] == []
        assert row["project_head_ids"] == [str(_H1)]

    @pytest.mark.asyncio
    async def test_an_iam_outage_still_finds_the_client_side_head(self):
        """The two sources fail independently — one being down must not blank both."""
        from src.projects import service

        with patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(side_effect=RuntimeError("IAM unavailable"))), \
             patch("src.projects.service.ClientProjectHead.find",
                   MagicMock(return_value=make_query_mock([make_cph(_H1, "Venkat", "Raman")]))):
            out = await service._with_names([make_project(heads=[_H1])], _viewer())

        assert out[0]["project_head_names"] == ["Venkat Raman"]


class TestListProjects:
    @pytest.mark.asyncio
    async def test_the_list_carries_the_names(self):
        from src.projects import service

        p = MagicMock(page=1, page_size=20)
        with patch("src.projects.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.projects.service.own_project_ids", AsyncMock(return_value=None)), \
             patch("src.projects.service.Project.find",
                   MagicMock(return_value=make_query_mock([make_project(heads=[_H1])], count=1))), \
             patch("src.projects.service.Client.find",
                   MagicMock(return_value=make_query_mock([make_client(_C1, "Acme")]))), \
             patch("src.projects.service.resolve_user_names",
                   AsyncMock(return_value={_H1: "Gopal Nair"})):
            page = await service.list_projects(make_user(), p)

        assert page["items"][0]["client_name"] == "Acme"
        assert page["items"][0]["project_head_names"] == ["Gopal Nair"]
