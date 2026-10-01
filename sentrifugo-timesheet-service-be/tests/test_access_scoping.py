"""Tests for ownership scoping on the /projects and /clients routes.

Holding manage_projects / manage_clients lets a non-admin into the module, but not
into the whole organisation: they see only the projects they are attached to
(project head, creator, or an active manager-role resource assignment) and the
clients behind those projects. Admins stay unrestricted.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.common.access import MANAGER_ROLES
from src.exceptions import ClientNotFound, ProjectNotFound

from .conftest import make_query_mock, make_user

# A syntactically valid 24-hex ObjectId for is_valid_object_id / PydanticObjectId.
_OID = "507f1f77bcf86cd799439011"


def make_member(**overrides):
    """A non-admin user (make_user alone yields truthy admin flags on the mock)."""
    overrides.setdefault("is_org_admin", False)
    overrides.setdefault("is_super_admin", False)
    return make_user(**overrides)


def make_page_params():
    p = MagicMock()
    p.page = 1
    p.page_size = 20
    return p


class TestOwnProjectIds:
    @pytest.mark.asyncio
    async def test_admins_are_unrestricted(self):
        from src.common import access

        for flag in ("is_org_admin", "is_super_admin"):
            user = make_member(**{flag: True})
            assert await access.own_project_ids(user) is None
            assert await access.own_client_ids(user) is None

    @pytest.mark.asyncio
    async def test_union_of_head_creator_and_manager_assignment(self):
        from src.common import access

        user = make_member()
        head_project = MagicMock(id="p1", client_id="c1")
        created_project = MagicMock(id="p2", client_id="c2")
        assigned_project = MagicMock(id="p3", client_id="c3")
        project_filters: list[dict] = []

        def project_find(filt):
            project_filters.append(filt)
            if "_id" in filt:  # second query resolves the assignment-only projects
                return make_query_mock([assigned_project])
            return make_query_mock([head_project, created_project])

        assignment_find = MagicMock(return_value=make_query_mock([MagicMock(project_id="p3")]))

        with patch("src.common.access.Project.find", project_find), \
             patch("src.common.access.ResourceAssignment.find", assignment_find):
            ids = await access.own_project_ids(user)

        assert ids == {"p1", "p2", "p3"}
        assert project_filters[0]["$or"] == [{"project_head_ids": "u1"}, {"created_by": "u1"}]

    @pytest.mark.asyncio
    async def test_non_manager_assignments_do_not_grant_access(self):
        from src.common import access

        user = make_member()
        assignment_find = MagicMock(return_value=make_query_mock([]))

        with patch("src.common.access.Project.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.common.access.ResourceAssignment.find", assignment_find):
            ids = await access.own_project_ids(user)

        assert ids == set()
        # A plain member assignment is filtered out by the query itself.
        filt = assignment_find.call_args.args[0]
        assert filt["role"] == {"$in": sorted(MANAGER_ROLES)}
        assert filt["status"] == "active"
        assert filt["user_id"] == "u1"


class TestOwnClientIds:
    @pytest.mark.asyncio
    async def test_clients_of_own_projects_plus_own_creations(self):
        from src.common import access

        user = make_member()
        own_project = MagicMock(id="p1", client_id="c1")

        with patch("src.common.access.Project.find", MagicMock(return_value=make_query_mock([own_project]))), \
             patch("src.common.access.ResourceAssignment.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.common.access.Client.find", MagicMock(return_value=make_query_mock([MagicMock(id="c9")]))):
            ids = await access.own_client_ids(user)

        assert ids == {"c1", "c9"}


class TestProjectsServiceScoping:
    @pytest.mark.asyncio
    async def test_list_projects_returns_empty_when_user_owns_none(self):
        from src.projects import service

        find_mock = MagicMock(return_value=make_query_mock([]))
        with patch("src.projects.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.projects.service.own_project_ids", AsyncMock(return_value=set())), \
             patch("src.projects.service.Project.find", find_mock):
            page = await service.list_projects(make_member(), make_page_params())

        assert page == {"items": [], "total": 0, "page": 1, "page_size": 20}
        find_mock.assert_not_called()  # short-circuits instead of querying

    @pytest.mark.asyncio
    async def test_list_projects_filters_to_owned_ids(self):
        from src.projects import service

        find_mock = MagicMock(return_value=make_query_mock([]))
        with patch("src.projects.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.projects.service.own_project_ids", AsyncMock(return_value={"p1"})), \
             patch("src.projects.service.Project.find", find_mock):
            await service.list_projects(make_member(), make_page_params())

        assert find_mock.call_args.args[0]["_id"] == {"$in": ["p1"]}

    @pytest.mark.asyncio
    async def test_get_project_hidden_when_not_owned(self):
        from src.projects import service

        doc = MagicMock(id="p9", deleted_on=None, organisation_id="org1", client_id="c1")
        with patch("src.projects.service.Project.get", AsyncMock(return_value=doc)), \
             patch("src.projects.service.is_scope_exempt", MagicMock(return_value=True)), \
             patch("src.projects.service.own_project_ids", AsyncMock(return_value={"p1"})):
            with pytest.raises(ProjectNotFound):
                await service.get_project(_OID, make_member())

    @pytest.mark.asyncio
    async def test_get_project_allowed_when_owned(self):
        from src.projects import service

        doc = MagicMock(id="p1", deleted_on=None, organisation_id="org1", client_id="c1")
        with patch("src.projects.service.Project.get", AsyncMock(return_value=doc)), \
             patch("src.projects.service.is_scope_exempt", MagicMock(return_value=True)), \
             patch("src.projects.service.own_project_ids", AsyncMock(return_value={"p1"})), \
             patch("src.projects.service._with_names", AsyncMock(return_value=[{"id": "p1"}])):
            assert await service.get_project(_OID, make_member()) == {"id": "p1"}


class TestClientsServiceScoping:
    @pytest.mark.asyncio
    async def test_list_clients_returns_empty_when_user_owns_none(self):
        from src.clients import service

        find_mock = MagicMock(return_value=make_query_mock([]))
        with patch("src.clients.service.hidden_client_ids", AsyncMock(return_value=[])), \
             patch("src.clients.service.own_client_ids", AsyncMock(return_value=set())), \
             patch("src.clients.service.Client.find", find_mock):
            page = await service.list_clients(make_member(), make_page_params())

        assert page == {"items": [], "total": 0, "page": 1, "page_size": 20}
        find_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_list_clients_keeps_department_and_ownership_filters(self):
        from src.clients import service

        find_mock = MagicMock(return_value=make_query_mock([]))
        with patch("src.clients.service.hidden_client_ids", AsyncMock(return_value=["c8"])), \
             patch("src.clients.service.own_client_ids", AsyncMock(return_value={"c1"})), \
             patch("src.clients.service.Client.find", find_mock):
            await service.list_clients(make_member(), make_page_params())

        assert find_mock.call_args.args[0]["_id"] == {"$nin": ["c8"], "$in": ["c1"]}

    @pytest.mark.asyncio
    async def test_get_client_hidden_when_not_owned(self):
        from src.clients import service

        doc = MagicMock(id="c9", deleted_on=None, organisation_id="org1")
        with patch("src.clients.service.Client.get", AsyncMock(return_value=doc)), \
             patch("src.clients.service.can_access_client", AsyncMock(return_value=True)), \
             patch("src.clients.service.own_client_ids", AsyncMock(return_value={"c1"})):
            with pytest.raises(ClientNotFound):
                await service.get_client(_OID, make_member())
