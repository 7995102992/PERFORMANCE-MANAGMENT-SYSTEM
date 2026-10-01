"""Tests for task deletion guards in the tasks service.

A task (or a project-task assignment) must not be removed once employees have
logged time against it, otherwise existing timesheets would reference a task
that no longer exists.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.exceptions import ProjectTaskHasTimesheets, TaskHasTimesheets, TaskNameExists, TaskNotFound

from .conftest import make_entry, make_query_mock, make_user

# A syntactically valid 24-hex ObjectId for is_valid_object_id / PydanticObjectId.
_OID = "507f1f77bcf86cd799439011"


def make_task(**overrides):
    """Return a MagicMock that quacks like Task."""
    defaults = dict(
        id="task1", organisation_id="org1", project_id=None, name="Design", name_lc="design",
        description=None, is_global=False, is_billable=True, is_time_off=False,
        is_frequent=False, estimated_hours=None, billable_rate=None, notes=None,
        deleted_on=None,
    )
    defaults.update(overrides)
    task = MagicMock()
    task.save = AsyncMock()
    for key, value in defaults.items():
        setattr(task, key, value)
    return task


def make_project_task(**overrides):
    """Return a MagicMock that quacks like ProjectTask."""
    defaults = dict(
        id="pt1", organisation_id="org1", project_id="p1", task_id="task1",
        is_active=True, estimated_hours=None, billable_rate=None, notes=None,
        deleted_on=None, created_on=None,
    )
    defaults.update(overrides)
    pt = MagicMock()
    pt.save = AsyncMock()
    for key, value in defaults.items():
        setattr(pt, key, value)
    return pt


def make_project(name="Website Revamp"):
    """Return a MagicMock that quacks like Project."""
    project = MagicMock()
    project.id = "p1"
    project.name = name
    project.deleted_on = None
    project.organisation_id = "org1"
    return project


class TestDeleteTaskTimesheetGuard:
    @pytest.mark.asyncio
    async def test_delete_blocked_when_timesheets_exist(self):
        from src.tasks import service

        user = make_user()
        task = make_task()

        with patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.TimesheetEntry.find", return_value=make_query_mock([make_entry()])), \
             patch("src.tasks.service.Project.get", AsyncMock(return_value=make_project())), \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            with pytest.raises(TaskHasTimesheets) as exc:
                await service.delete_task(_OID, user)

        assert exc.value.code == "TSM-032"
        assert "Design" in exc.value.message
        assert "Website Revamp" in exc.value.message
        task.save.assert_not_awaited()
        aud.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_delete_proceeds_without_timesheets(self):
        from src.models import StatusEnum
        from src.tasks import service

        user = make_user()
        task = make_task()

        with patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.tasks.service.ProjectTask.find", return_value=make_query_mock(count=0)), \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            await service.delete_task(_OID, user)

        assert task.deleted_on is not None
        assert task.status == StatusEnum.INACTIVE
        task.save.assert_awaited_once()
        aud.assert_awaited_once()


class TestRemoveTaskFromProjectTimesheetGuard:
    @pytest.mark.asyncio
    async def test_removal_blocked_when_project_has_timesheets(self):
        from src.tasks import service

        user = make_user()
        pt = MagicMock(id="pt1", deleted_on=None, project_id="p1", task_id="task1")
        pt.save = AsyncMock()

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=make_task())), \
             patch("src.tasks.service.TimesheetEntry.find", return_value=make_query_mock([make_entry()])), \
             patch("src.tasks.service.Project.get", AsyncMock(return_value=make_project())), \
             patch("src.tasks.service.emit_activity", AsyncMock()) as act, \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            with pytest.raises(ProjectTaskHasTimesheets) as exc:
                await service.remove_task_from_project(_OID, _OID, user)

        assert exc.value.code == "TSM-033"
        assert "Design" in exc.value.message
        assert "Website Revamp" in exc.value.message
        pt.save.assert_not_awaited()
        act.assert_not_awaited()
        aud.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_removal_scoped_to_the_requested_project(self):
        """Entries on the same task in a *different* project must not block removal."""
        from src.tasks import service

        user = make_user()
        pt = MagicMock(id="pt1", deleted_on=None, project_id="p1", task_id="task1")
        pt.save = AsyncMock()
        find_mock = MagicMock(return_value=make_query_mock([]))

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=make_task())), \
             patch("src.tasks.service.TimesheetEntry.find", find_mock), \
             patch("src.tasks.service.emit_activity", AsyncMock()), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.remove_task_from_project(_OID, _OID, user)

        assert find_mock.call_args.args[0] == {
            "organisation_id": "org1",
            "task_id": "task1",
            "project_id": "p1",
            "deleted_on": None,
        }
        assert pt.deleted_on is not None
        assert pt.is_active is False
        pt.save.assert_awaited_once()


class TestUpdateProjectTask:
    """The project-task edit carries the full add-task field set: task-level
    attributes edit the shared task, the three rate/hours/notes fields stay
    per-project overrides."""

    @pytest.mark.asyncio
    async def test_edits_task_level_fields_through_the_link(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task()
        body = {"name": "  Design Review  ", "description": "reworked", "is_billable": False,
                "is_frequent": True, "is_global": True, "is_time_off": False}

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.Task.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            out = await service.update_project_task(_OID, _OID, body, make_user())

        assert task.name == "Design Review"  # normalised, not the raw padded string
        assert task.name_lc == "design review"
        assert (task.description, task.is_billable, task.is_frequent, task.is_global) == (
            "reworked", False, True, True,
        )
        task.save.assert_awaited_once()
        pt.save.assert_awaited_once()
        assert out["task_name"] == "Design Review"
        assert out["is_billable"] is False
        assert out["is_frequent"] is True

    @pytest.mark.asyncio
    async def test_duplicate_name_aborts_before_any_write(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task()

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.Task.find",
                   MagicMock(return_value=make_query_mock([MagicMock(id="task2")]))), \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            with pytest.raises(TaskNameExists):
                await service.update_project_task(
                    _OID, _OID, {"name": "Taken", "estimated_hours": 4.0}, make_user(),
                )

        pt.save.assert_not_awaited()
        task.save.assert_not_awaited()
        aud.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rate_fields_stay_per_project_when_task_default_is_set(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task(estimated_hours=8.0, billable_rate=100.0)

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.update_project_task(
                _OID, _OID, {"estimated_hours": 3.0, "billable_rate": 55.0}, make_user(),
            )

        assert (pt.estimated_hours, pt.billable_rate) == (3.0, 55.0)
        assert (task.estimated_hours, task.billable_rate) == (8.0, 100.0)  # untouched
        task.save.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unset_task_default_is_seeded_from_the_link(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task()

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.update_project_task(_OID, _OID, {"billable_rate": 55.0}, make_user())

        assert pt.billable_rate == 55.0
        assert task.billable_rate == 55.0
        task.save.assert_awaited_once()


class TestProjectOwnedTasks:
    """A task added to a project belongs to that project, so two projects can each
    have their own task of the same name. Global / frequent tasks stay shared."""

    @pytest.mark.asyncio
    async def test_inline_create_owns_the_task(self):
        from src.tasks import service
        from src.tasks.schemas import ProjectTaskCreate

        project = MagicMock(deleted_on=None, organisation_id="org1")
        created = make_task(project_id=None)
        created.insert = AsyncMock()
        task_cls = MagicMock(return_value=created, find=MagicMock(return_value=make_query_mock([])))

        with patch("src.tasks.service.Project.get", AsyncMock(return_value=project)), \
             patch("src.tasks.service.Task", task_cls), \
             patch("src.tasks.service._assign_single", AsyncMock(return_value=make_project_task())), \
             patch("src.tasks.service._pt_out", MagicMock(return_value={})), \
             patch("src.tasks.service.emit_activity", AsyncMock()), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.assign_task_to_project(
                _OID, ProjectTaskCreate(name="Design"), make_user(),
            )

        # constructed with this project as owner
        kwargs = task_cls.call_args.kwargs
        assert kwargs["project_id"] is not None
        assert kwargs["name"] == "Design"
        created.insert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_global_task_created_inline_stays_shared(self):
        from src.tasks import service
        from src.tasks.schemas import ProjectTaskCreate

        project = MagicMock(deleted_on=None, organisation_id="org1")
        created = make_task()
        created.insert = AsyncMock()
        task_cls = MagicMock(return_value=created, find=MagicMock(return_value=make_query_mock([])))

        with patch("src.tasks.service.Project.get", AsyncMock(return_value=project)), \
             patch("src.tasks.service.Task", task_cls), \
             patch("src.tasks.service._assign_single", AsyncMock(return_value=make_project_task())), \
             patch("src.tasks.service._pt_out", MagicMock(return_value={})), \
             patch("src.tasks.service.emit_activity", AsyncMock()), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.assign_task_to_project(
                _OID, ProjectTaskCreate(name="Holiday", is_global=True), make_user(),
            )

        assert task_cls.call_args.kwargs["project_id"] is None

    @pytest.mark.asyncio
    async def test_cannot_link_a_task_owned_by_another_project(self):
        from src.tasks import service
        from src.tasks.schemas import ProjectTaskCreate

        project = MagicMock(deleted_on=None, organisation_id="org1")
        foreign = make_task(project_id=PydanticObjectId("507f1f77bcf86cd7994390ff"))

        with patch("src.tasks.service.Project.get", AsyncMock(return_value=project)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=foreign)):
            with pytest.raises(TaskNotFound):
                await service.assign_task_to_project(
                    _OID, ProjectTaskCreate(task_id=_OID), make_user(),
                )


class TestPromoteToShared:
    """Ticking global/frequent on a project-owned task shares it organisation-wide,
    so it shows up in the frequent/global pickers that list shared tasks."""

    @pytest.mark.asyncio
    async def test_marking_frequent_promotes_a_project_task(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task(project_id=PydanticObjectId(_OID))

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.Task.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.update_project_task(_OID, _OID, {"is_frequent": True}, make_user())

        assert task.project_id is None
        assert task.is_frequent is True
        task.save.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_promotion_needs_an_org_wide_free_name(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task(project_id=PydanticObjectId(_OID))

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.Task.find",
                   MagicMock(return_value=make_query_mock([make_task(id="other")]))), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            with pytest.raises(TaskNameExists):
                await service.update_project_task(_OID, _OID, {"is_global": True}, make_user())

        assert task.project_id is not None  # nothing written
        pt.save.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_shared_tasks_are_never_demoted(self):
        from src.tasks import service

        pt = make_project_task()
        task = make_task(project_id=None, is_frequent=True)

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.Task.find", MagicMock(return_value=make_query_mock([]))), \
             patch("src.tasks.service.emit_audit", AsyncMock()):
            await service.update_project_task(_OID, _OID, {"is_frequent": False}, make_user())

        assert task.project_id is None
        assert task.is_frequent is False


class TestTaskNameScope:
    @pytest.mark.asyncio
    async def test_same_name_in_another_project_is_allowed(self):
        from src.tasks import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.tasks.service.Task.find", find):
            await service._assert_task_name_free(
                "design", "org1", project_id=PydanticObjectId(_OID),
            )

        # the scope is "shared tasks, or this project's own" — never another project's
        assert find.call_args.args[0]["$or"] == [
            {"project_id": None}, {"project_id": PydanticObjectId(_OID)},
        ]

    @pytest.mark.asyncio
    async def test_clash_with_a_shared_task_is_rejected(self):
        from src.tasks import service

        with patch("src.tasks.service.Task.find",
                   MagicMock(return_value=make_query_mock([make_task(id="other")]))):
            with pytest.raises(TaskNameExists):
                await service._assert_task_name_free(
                    "design", "org1", project_id=PydanticObjectId(_OID),
                )

    @pytest.mark.asyncio
    async def test_renaming_ignores_the_task_itself(self):
        from src.tasks import service

        task = make_task(id="task1")
        with patch("src.tasks.service.Task.find",
                   MagicMock(return_value=make_query_mock([task]))):
            await service._assert_task_name_free(
                "design", "org1", project_id=None, exclude_id="task1",
            )

    @pytest.mark.asyncio
    async def test_shared_task_creation_stays_org_wide(self):
        from src.tasks import service

        find = MagicMock(return_value=make_query_mock([]))
        with patch("src.tasks.service.Task.find", find):
            await service._assert_task_name_free("design", "org1")

        assert find.call_args.args[0]["$or"] == [
            {"project_id": None}, {"project_id": {"$ne": None}},
        ]


class TestProjectTaskUpdateSchema:
    def test_accepts_the_add_task_field_set(self):
        from src.tasks.schemas import ProjectTaskUpdate, TaskCreate

        editable = set(ProjectTaskUpdate.model_fields)
        assert set(TaskCreate.model_fields) <= editable

    def test_rejects_unknown_fields(self):
        from pydantic import ValidationError

        from src.tasks.schemas import ProjectTaskUpdate

        with pytest.raises(ValidationError):
            ProjectTaskUpdate(task_id="abc")
