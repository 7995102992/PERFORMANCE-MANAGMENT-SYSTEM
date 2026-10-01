"""Who counts as an approver.

A resource assignment with no role is someone *working* on the project. It must not
confer sight of colleagues' timesheets. Only a manager-role assignment, or being
named among a project's heads, makes someone an approver for that project.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.approvals.service import MANAGER_ROLES

from .conftest import make_query_mock, make_user

_P1 = PydanticObjectId("507f1f77bcf86cd799439011")
_P2 = PydanticObjectId("507f1f77bcf86cd799439012")


def make_assignment(project_id=_P1, task_id=None, role="manager"):
    ra = MagicMock()
    ra.project_id = project_id
    ra.task_id = task_id
    ra.role = role
    ra.user_id = "u1"
    return ra


def patched(assignments, headed):
    return (
        patch("src.approvals.service.ResourceAssignment.find",
              MagicMock(return_value=make_query_mock(assignments))),
        patch("src.approvals.service.Project.find",
              MagicMock(return_value=make_query_mock([MagicMock(id=p) for p in headed]))),
    )


class TestApproverAssignments:
    @pytest.mark.asyncio
    async def test_only_manager_roles_are_queried(self):
        from src.approvals import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.approvals.service.ResourceAssignment.find", find), \
             patch("src.approvals.service.Project.find",
                   MagicMock(return_value=make_query_mock([]))):
            await service._approver_assignments(make_user())

        filt = find.call_args.args[0]
        assert set(filt["role"]["$in"]) == MANAGER_ROLES
        assert filt["status"] == "active"

    @pytest.mark.asyncio
    async def test_project_heads_qualify_too(self):
        from src.approvals import service

        ra_find, proj_find = patched([], [_P2])
        with ra_find, proj_find:
            assignments, headed = await service._approver_assignments(make_user())

        assert assignments == []
        assert headed == {_P2}


class TestTeamVisibility:
    @pytest.mark.asyncio
    async def test_a_plain_employee_has_no_team(self):
        """The reported bug: an assignment with no role used to fall back to
        treating every assignment as managerial."""
        from src.approvals import service

        ra_find, proj_find = patched([], [])
        with ra_find, proj_find:
            assert await service._get_team_user_ids(make_user()) == []

    @pytest.mark.asyncio
    async def test_a_manager_still_gets_their_team(self):
        from src.approvals import service

        teammate = MagicMock(user_id="u2", project_id=_P1, task_id=None)
        calls = {"n": 0}

        def ra_find(_filt):
            calls["n"] += 1
            # First call resolves the approver's own assignments, later ones the team.
            return make_query_mock([make_assignment()] if calls["n"] == 1 else [teammate])

        with patch("src.approvals.service.ResourceAssignment.find", MagicMock(side_effect=ra_find)), \
             patch("src.approvals.service.Project.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.approvals.service.hidden_project_ids", AsyncMock(return_value=[])), \
             patch("src.approvals.service._filter_users_to_login_scope",
                   AsyncMock(side_effect=lambda _u, ids: ids)):
            team = await service._get_team_user_ids(make_user())

        assert team == ["u2"]


class TestVisibleScope:
    @pytest.mark.asyncio
    async def test_a_plain_employee_sees_no_projects(self):
        from src.approvals import service

        ra_find, proj_find = patched([], [])
        with ra_find, proj_find, \
             patch("src.approvals.service.hidden_project_ids", AsyncMock(return_value=[])):
            project_level, task_level = await service._get_manager_visible_scope(make_user())

        assert project_level == set()
        assert task_level == {}

    @pytest.mark.asyncio
    async def test_a_head_sees_the_whole_project(self):
        from src.approvals import service

        ra_find, proj_find = patched([], [_P2])
        with ra_find, proj_find, \
             patch("src.approvals.service.hidden_project_ids", AsyncMock(return_value=[])):
            project_level, _ = await service._get_manager_visible_scope(make_user())

        assert project_level == {str(_P2)}

    @pytest.mark.asyncio
    async def test_a_task_level_manager_keeps_task_scope(self):
        from src.approvals import service

        task_row = make_assignment(task_id=PydanticObjectId("507f1f77bcf86cd7994390a1"))
        ra_find, proj_find = patched([task_row], [])
        with ra_find, proj_find, \
             patch("src.approvals.service.hidden_project_ids", AsyncMock(return_value=[])):
            project_level, task_level = await service._get_manager_visible_scope(make_user())

        assert project_level == set()
        assert task_level == {str(_P1): {"507f1f77bcf86cd7994390a1"}}
