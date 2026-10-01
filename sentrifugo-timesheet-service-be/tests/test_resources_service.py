"""Tests for multi-task resource assignment.

A resource is assigned either to specific tasks or to the project as a whole,
never both. The API takes a list of tasks; storage stays one ResourceAssignment
row per task, so everything downstream (entry validation, manager scope) keeps
working off `task_id is None`.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import ResourceAlreadyAssigned, TaskNotAvailableForProject
from src.resources.schemas import ResourceAssignmentCreate, ResourceAssignmentUpdate

from .conftest import make_query_mock, make_user

_PROJECT = "507f1f77bcf86cd799439011"
_EMPLOYEE = "507f1f77bcf86cd799439012"
_T1 = "507f1f77bcf86cd7994390a1"
_T2 = "507f1f77bcf86cd7994390a2"
_T3 = "507f1f77bcf86cd7994390a3"


def make_ra(task_id=None, **overrides):
    """Return a MagicMock that quacks like a live ResourceAssignment."""
    defaults = dict(
        id=f"ra-{task_id or 'project'}",
        organisation_id="org1",
        project_id=PydanticObjectId(_PROJECT),
        task_id=PydanticObjectId(task_id) if isinstance(task_id, str) else task_id,
        user_id=PydanticObjectId(_EMPLOYEE),
        role="dev",
        allocation_percentage=100,
        billable_rate=None,
        is_billable=True,
        start_date=None,
        end_date=None,
        deleted_on=None,
        released_on=None,
        removal_comment=None,
        removal_history=[],
    )
    defaults.update(overrides)
    ra = MagicMock()
    ra.save = AsyncMock()
    ra.insert = AsyncMock()
    for key, value in defaults.items():
        setattr(ra, key, value)
    return ra


def make_ra_class(active=None, prior=None):
    """Stand-in for the ResourceAssignment document class.

    `find` serves both lookups the service makes — the live-assignment list
    (`to_list`) and the revive-a-removed-row probe (`first_or_none`) — and calling
    the class builds a fresh doc so each task gets its own row.
    """
    cls = MagicMock()

    def _find(_filt, *_a, **_k):
        q = make_query_mock(list(active or []))
        q.first_or_none = AsyncMock(return_value=prior)
        return q

    cls.find = MagicMock(side_effect=_find)
    cls.find_one = AsyncMock(return_value=None)
    cls.side_effect = lambda **kw: make_ra(**{**kw, "id": f"new-{kw.get('task_id')}"})
    return cls


def patched(ra_class, *, task_available=True, addressed=None):
    """Common patch set for the resources service."""
    if addressed is not None:
        ra_class.get = AsyncMock(return_value=addressed)
    return [
        patch("src.resources.service.Project.get", AsyncMock(return_value=MagicMock(
            deleted_on=None, organisation_id="org1", name="Website Revamp"))),
        patch("src.resources.service.user_belongs_to_organisation", AsyncMock(return_value=True)),
        patch("src.resources.service.ProjectTask.find_one",
              AsyncMock(return_value=MagicMock() if task_available else None)),
        patch("src.resources.service.ResourceAssignment", ra_class),
        patch("src.resources.service.outbox.publish", AsyncMock()),
        patch("src.resources.service.emit_activity", AsyncMock()),
        patch("src.resources.service.emit_audit", AsyncMock()),
    ]


class _Patches:
    def __init__(self, patches):
        self._patches = patches

    def __enter__(self):
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()
        return False


class TestCreateResourceMultiTask:
    @pytest.mark.asyncio
    async def test_one_row_per_selected_task(self):
        from src.resources import service

        ra_class = make_ra_class()
        body = ResourceAssignmentCreate(user_id=_EMPLOYEE, task_ids=[_T1, _T2], role="dev")

        with _Patches(patched(ra_class)):
            out = await service.create_resource(_PROJECT, body, make_user())

        assert len(out) == 2
        assert {row["task_id"] for row in out} == {_T1, _T2}
        assert {row["user_id"] for row in out} == {_EMPLOYEE}

    @pytest.mark.asyncio
    async def test_singular_task_id_still_accepted(self):
        from src.resources import service

        ra_class = make_ra_class()
        body = ResourceAssignmentCreate(user_id=_EMPLOYEE, task_id=_T1)

        with _Patches(patched(ra_class)):
            out = await service.create_resource(_PROJECT, body, make_user())

        assert [row["task_id"] for row in out] == [_T1]

    @pytest.mark.asyncio
    async def test_empty_selection_is_a_project_level_assignment(self):
        from src.resources import service

        ra_class = make_ra_class()
        body = ResourceAssignmentCreate(user_id=_EMPLOYEE, task_ids=[])

        with _Patches(patched(ra_class)):
            out = await service.create_resource(_PROJECT, body, make_user())

        assert [row["task_id"] for row in out] == [None]

    @pytest.mark.asyncio
    async def test_task_selection_supersedes_a_project_level_row(self):
        from src.resources import service

        project_level = make_ra(task_id=None)
        ra_class = make_ra_class(active=[project_level])
        body = ResourceAssignmentCreate(user_id=_EMPLOYEE, task_ids=[_T1])

        with _Patches(patched(ra_class)):
            out = await service.create_resource(_PROJECT, body, make_user())

        assert project_level.deleted_on is not None
        assert project_level.removal_comment is None  # edit-driven, no removal note
        project_level.save.assert_awaited_once()
        assert [row["task_id"] for row in out] == [_T1]

    @pytest.mark.asyncio
    async def test_already_assigned_task_is_rejected(self):
        from src.resources import service

        ra_class = make_ra_class(active=[make_ra(task_id=_T1)])
        body = ResourceAssignmentCreate(user_id=_EMPLOYEE, task_ids=[_T1, _T2])

        with _Patches(patched(ra_class)):
            with pytest.raises(ResourceAlreadyAssigned):
                await service.create_resource(_PROJECT, body, make_user())

    @pytest.mark.asyncio
    async def test_task_outside_the_project_is_rejected(self):
        from src.resources import service

        ra_class = make_ra_class()
        body = ResourceAssignmentCreate(user_id=_EMPLOYEE, task_ids=[_T1])

        with _Patches(patched(ra_class, task_available=False)):
            with pytest.raises(TaskNotAvailableForProject):
                await service.create_resource(_PROJECT, body, make_user())


class TestUpdateResourceTaskSet:
    @pytest.mark.asyncio
    async def test_selection_replaces_the_task_set(self):
        from src.resources import service

        keep, drop = make_ra(task_id=_T1), make_ra(task_id=_T2)
        ra_class = make_ra_class(active=[keep, drop])
        body = ResourceAssignmentUpdate(task_ids=[_T1, _T3])

        with _Patches(patched(ra_class, addressed=keep)):
            out = await service.update_resource(_PROJECT, "ra1", body, make_user())

        assert drop.deleted_on is not None      # deselected -> removed
        assert drop.removal_comment is None     # silently, no removal note
        assert keep.deleted_on is None          # still selected -> untouched
        assert {row["task_id"] for row in out} == {_T1, _T3}

    @pytest.mark.asyncio
    async def test_empty_selection_converts_to_project_level(self):
        from src.resources import service

        task_row = make_ra(task_id=_T1)
        ra_class = make_ra_class(active=[task_row])
        body = ResourceAssignmentUpdate(task_ids=[])

        with _Patches(patched(ra_class, addressed=task_row)):
            out = await service.update_resource(_PROJECT, "ra1", body, make_user())

        assert task_row.deleted_on is not None
        assert [row["task_id"] for row in out] == [None]

    @pytest.mark.asyncio
    async def test_field_edit_without_task_keys_leaves_the_set_alone(self):
        from src.resources import service

        row_a, row_b = make_ra(task_id=_T1), make_ra(task_id=_T2)
        ra_class = make_ra_class(active=[row_a, row_b])
        body = ResourceAssignmentUpdate(role="manager", allocation_percentage=50)

        with _Patches(patched(ra_class, addressed=row_a)):
            out = await service.update_resource(_PROJECT, "ra1", body, make_user())

        assert (row_a.deleted_on, row_b.deleted_on) == (None, None)
        # The edit applies to the employee's whole assignment on the project.
        assert row_a.role == row_b.role == "manager"
        assert row_a.allocation_percentage == row_b.allocation_percentage == 50
        assert len(out) == 2

    @pytest.mark.asyncio
    async def test_new_rows_inherit_the_edited_fields(self):
        from src.resources import service

        existing = make_ra(task_id=_T1)
        ra_class = make_ra_class(active=[existing])
        body = ResourceAssignmentUpdate(task_ids=[_T1, _T2], role="lead")

        with _Patches(patched(ra_class, addressed=existing)):
            out = await service.update_resource(_PROJECT, "ra1", body, make_user())

        assert {row["task_id"] for row in out} == {_T1, _T2}
        assert all(row["role"] == "lead" for row in out)
