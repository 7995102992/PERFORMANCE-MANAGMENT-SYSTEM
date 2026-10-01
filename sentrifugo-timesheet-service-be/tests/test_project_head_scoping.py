"""Project heads inherit their client's visibility.

They hang off a client, so a non-admin permission holder sees only the heads of
the clients behind their own projects — the same rule /clients applies. Admins are
unrestricted apart from the existing department scope.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import ClientNotFound, ClientProjectHeadNotFound

from .conftest import make_query_mock, make_user

_C_MINE = PydanticObjectId("507f1f77bcf86cd799439011")
_C_OTHER = PydanticObjectId("507f1f77bcf86cd799439012")
_C_HIDDEN = PydanticObjectId("507f1f77bcf86cd799439013")


def make_member(**overrides):
    overrides.setdefault("is_org_admin", False)
    overrides.setdefault("is_super_admin", False)
    return make_user(**overrides)


def make_page_params():
    p = MagicMock()
    p.page = 1
    p.page_size = 20
    return p


def make_head(client_id=_C_MINE):
    head = MagicMock()
    head.id = "ph1"
    head.organisation_id = "org1"
    head.client_id = client_id
    head.deleted_on = None
    return head


class TestListProjectHeads:
    @pytest.mark.asyncio
    async def test_restricted_to_the_users_own_clients(self):
        from src.client_project_heads import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.client_project_heads.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value={_C_MINE})), \
             patch("src.client_project_heads.service.ClientProjectHead.find", find):
            await service.list_project_heads(make_member(), make_page_params())

        assert find.call_args.args[0]["client_id"] == {"$in": [_C_MINE]}

    @pytest.mark.asyncio
    async def test_department_scope_still_applies(self):
        from src.client_project_heads import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.client_project_heads.service.hidden_client_ids",
                   AsyncMock(return_value=[_C_HIDDEN])), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value=None)), \
             patch("src.client_project_heads.service.ClientProjectHead.find", find):
            await service.list_project_heads(make_user(), make_page_params())

        assert find.call_args.args[0]["client_id"] == {"$nin": [_C_HIDDEN]}

    @pytest.mark.asyncio
    async def test_admin_sees_everything(self):
        from src.client_project_heads import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.client_project_heads.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value=None)), \
             patch("src.client_project_heads.service.ClientProjectHead.find", find):
            await service.list_project_heads(make_user(), make_page_params())

        assert "client_id" not in find.call_args.args[0]

    @pytest.mark.asyncio
    async def test_out_of_scope_client_filter_returns_empty(self):
        """Asking for another client's heads by id must not leak them."""
        from src.client_project_heads import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.client_project_heads.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value={_C_MINE})), \
             patch("src.client_project_heads.service.ClientProjectHead.find", find):
            page = await service.list_project_heads(
                make_member(), make_page_params(), client_id=str(_C_OTHER),
            )

        assert page == {"items": [], "total": 0, "page": 1, "page_size": 20}
        find.assert_not_called()


class TestSingleHeadAccess:
    @pytest.mark.asyncio
    async def test_head_of_another_client_is_hidden(self):
        from src.client_project_heads import service

        with patch("src.client_project_heads.service.ClientProjectHead.get",
                   AsyncMock(return_value=make_head(_C_OTHER))), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value={_C_MINE})):
            with pytest.raises(ClientProjectHeadNotFound):
                await service.get_project_head("ph1", make_member())

    @pytest.mark.asyncio
    async def test_head_of_an_own_client_is_reachable(self):
        from src.client_project_heads import service

        with patch("src.client_project_heads.service.ClientProjectHead.get",
                   AsyncMock(return_value=make_head(_C_MINE))), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value={_C_MINE})), \
             patch("src.client_project_heads.service._to_out", MagicMock(return_value={"id": "ph1"})):
            assert await service.get_project_head("ph1", make_member()) == {"id": "ph1"}


class TestCreateUnderClient:
    @pytest.mark.asyncio
    async def test_cannot_add_a_head_to_an_unreachable_client(self):
        from src.client_project_heads import service

        client = MagicMock(id=_C_OTHER, deleted_on=None, organisation_id="org1")
        with patch("src.client_project_heads.service.Client.get", AsyncMock(return_value=client)), \
             patch("src.client_project_heads.service.can_access_client", AsyncMock(return_value=True)), \
             patch("src.client_project_heads.service.own_client_ids", AsyncMock(return_value={_C_MINE})):
            with pytest.raises(ClientNotFound):
                await service._load_client(str(_C_OTHER), make_member())
