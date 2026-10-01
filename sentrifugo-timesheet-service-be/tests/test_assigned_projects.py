"""Tests for GET /my-timesheets/assigned-projects task exposure.

The endpoint deliberately lists projects the employee was ever assigned to
(including inactive ones), but the *tasks* it offers must come from live
assignments only — otherwise a removed project-level row keeps exposing every
task in the project, and the entry validator then rejects what the picker offered.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from beanie import PydanticObjectId

from src.models import StatusEnum

from .conftest import make_query_mock, make_user

_PROJECT = "507f1f77bcf86cd799439011"
_T1 = "507f1f77bcf86cd7994390a1"
_T2 = "507f1f77bcf86cd7994390a2"
_T3 = "507f1f77bcf86cd7994390a3"


def make_assignment(task_id=None, *, removed=False, status=StatusEnum.ACTIVE, end_date=None):
    ra = MagicMock()
    ra.project_id = PydanticObjectId(_PROJECT)
    ra.task_id = PydanticObjectId(task_id) if task_id else None
    ra.deleted_on = datetime(2026, 8, 1, tzinfo=timezone.utc) if removed else None
    ra.status = status
    ra.end_date = end_date  # open-ended unless a release has been scheduled
    return ra


def make_project_doc():
    p = MagicMock()
    p.id = PydanticObjectId(_PROJECT)
    p.name = "Website Revamp"
    p.code = "WR"
    p.project_status = "active"
    p.status = StatusEnum.ACTIVE
    return p


def make_pt(task_id):
    pt = MagicMock()
    pt.task_id = PydanticObjectId(task_id)
    return pt


def run_with(assignments, project_task_rows):
    """Patch the service's collaborators and return the endpoint's result."""
    from src.timesheets import service

    def project_task_find(filt):
        rows = project_task_rows
        if "task_id" in filt:  # task-level lookup narrows to the assigned ids
            allowed = set(filt["task_id"]["$in"])
            rows = [pt for pt in rows if pt.task_id in allowed]
        return make_query_mock(rows)

    tasks = [MagicMock(id=PydanticObjectId(t), name=f"Task {t[-1]}", is_frequent=False)
             for t in (_T1, _T2, _T3)]

    return service, patch.multiple(
        "src.timesheets.service",
        ResourceAssignment=MagicMock(find=MagicMock(return_value=make_query_mock(assignments))),
        Project=MagicMock(find=MagicMock(return_value=make_query_mock([make_project_doc()]))),
        ProjectTask=MagicMock(find=MagicMock(side_effect=project_task_find)),
        Task=MagicMock(find=MagicMock(return_value=make_query_mock(tasks))),
        hidden_project_ids=AsyncMock(return_value=[]),
    )


class TestAssignedProjectsTaskExposure:
    @pytest.mark.asyncio
    async def test_project_level_assignment_exposes_every_task(self):
        service, patches = run_with(
            [make_assignment(None)],
            [make_pt(_T1), make_pt(_T2), make_pt(_T3)],
        )
        with patches:
            out = await service.get_assigned_projects(make_user())

        assert {t["task_id"] for t in out[0]["tasks"]} == {_T1, _T2, _T3}

    @pytest.mark.asyncio
    async def test_removed_project_level_row_no_longer_exposes_every_task(self):
        """Switching null -> specific tasks soft-removes the project-level row."""
        service, patches = run_with(
            [make_assignment(None, removed=True), make_assignment(_T1)],
            [make_pt(_T1), make_pt(_T2), make_pt(_T3)],
        )
        with patches:
            out = await service.get_assigned_projects(make_user())

        assert [t["task_id"] for t in out[0]["tasks"]] == [_T1]

    @pytest.mark.asyncio
    async def test_deactivated_project_level_row_is_ignored_too(self):
        service, patches = run_with(
            [make_assignment(None, status=StatusEnum.INACTIVE), make_assignment(_T2)],
            [make_pt(_T1), make_pt(_T2), make_pt(_T3)],
        )
        with patches:
            out = await service.get_assigned_projects(make_user())

        assert [t["task_id"] for t in out[0]["tasks"]] == [_T2]

    @pytest.mark.asyncio
    async def test_project_still_listed_with_no_tasks_when_fully_removed(self):
        service, patches = run_with(
            [make_assignment(_T1, removed=True)],
            [make_pt(_T1), make_pt(_T2), make_pt(_T3)],
        )
        with patches:
            out = await service.get_assigned_projects(make_user())

        assert out[0]["name"] == "Website Revamp"
        assert out[0]["tasks"] == []
