"""Audit-logging tests for the timesheet service.

These verify the cross-service audit contract and the stream-choice rule that
makes timesheet consistent with IAM / SRM / schedule:

  * Canonical envelope + payload (emit_activity / emit_audit helpers).
  * Config-entity CRUD  -> emit_audit only.
  * Assignment ops      -> BOTH streams (activity + audit).
  * Lifecycle state-change (submit/resubmit/auto-submit) -> BOTH streams.
  * Entry edits         -> emit_activity.
  * action "<entity>.<verb>" matches resource "<entity>:<id>" (project_task.*).
  * auto_submit_pending also creates per-project approval records.

Emits are asserted by patching emit_activity / emit_audit in each service
module; the rest of the persistence flow is mocked with the conftest factories.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.rabbitmq.constants import DebugLevel

from .conftest import make_entry, make_query_mock, make_settings, make_timesheet, make_user

# A syntactically valid 24-hex ObjectId for is_valid_object_id / PydanticObjectId.
_OID = "507f1f77bcf86cd799439011"


# ---------------------------------------------------------------------------
# audit.py helpers — canonical envelope / payload
# ---------------------------------------------------------------------------

class TestAuditHelpers:
    @pytest.mark.asyncio
    async def test_emit_activity_envelope(self):
        from src import audit
        with patch("src.audit.outbox.publish_audit_log", AsyncMock(return_value="evt")) as pub:
            await audit.emit_activity(
                action="timesheet.submitted",
                resource="timesheet:ts1",
                actor_id="u1",
                organisation_id="org1",
                details={"k": "v"},
                correlation_id="corr1",
            )
        kw = pub.call_args.kwargs
        assert kw["module"] == "timesheet"
        assert kw["actor_id"] == "u1"
        assert kw["action"] == "timesheet.submitted"
        assert kw["resource"] == "timesheet:ts1"
        assert kw["debug_level"] == DebugLevel.EMPLOYEE
        meta = kw["metadata"]
        assert meta["stream"] == "activity"
        assert meta["correlation_id"] == "corr1"
        assert meta["organisation_id"] == "org1"
        assert meta["details"] == {"k": "v"}
        # activity never carries changed_fields
        assert "changed_fields" not in meta

    @pytest.mark.asyncio
    async def test_emit_audit_envelope_and_changed_fields(self):
        from src import audit
        with patch("src.audit.outbox.publish_audit_log", AsyncMock(return_value="evt")) as pub:
            await audit.emit_audit(
                action="client.updated",
                resource="client:c1",
                actor_id="u1",
                organisation_id="org1",
                details={"name": "Acme"},
                changed_fields=["name"],
            )
        kw = pub.call_args.kwargs
        assert kw["module"] == "timesheet"
        assert kw["debug_level"] == DebugLevel.ADMIN
        meta = kw["metadata"]
        assert meta["stream"] == "audit"
        assert meta["organisation_id"] == "org1"
        assert meta["details"] == {"name": "Acme"}
        assert meta["changed_fields"] == ["name"]

    @pytest.mark.asyncio
    async def test_emit_audit_defaults_actor_to_system(self):
        from src import audit
        with patch("src.audit.outbox.publish_audit_log", AsyncMock(return_value="evt")) as pub:
            await audit.emit_audit(
                action="timesheet.auto_submitted",
                resource="timesheet:ts1",
                actor_id=None,
                organisation_id="org1",
            )
        kw = pub.call_args.kwargs
        assert kw["actor_id"] == "system"
        # no changed_fields key when not provided
        assert "changed_fields" not in kw["metadata"]


# ---------------------------------------------------------------------------
# Config-entity CRUD -> emit_audit only
# ---------------------------------------------------------------------------

class TestProjectCreateUsesAudit:
    @pytest.mark.asyncio
    async def test_create_project_emits_audit_not_activity(self):
        from src.projects import service
        from src.projects.schemas import ProjectCreate

        user = make_user()
        body = ProjectCreate(client_id=_OID, name="Proj", code=None, is_internal=False)

        client = MagicMock(deleted_on=None, organisation_id="org1")
        doc = MagicMock(id="proj1")
        doc.insert = AsyncMock()

        MockProject = MagicMock()
        MockProject.find_one = AsyncMock(return_value=None)
        MockProject.return_value = doc

        with patch("src.projects.service.Client.get", AsyncMock(return_value=client)), \
             patch("src.projects.service.can_access_client", AsyncMock(return_value=True)), \
             patch("src.projects.service.Project", MockProject), \
             patch("src.projects.service.Task.find", return_value=make_query_mock([])), \
             patch("src.projects.service._with_names", AsyncMock(return_value=[{}])), \
             patch("src.projects.service.emit_audit", AsyncMock()) as audit_mock:
            await service.create_project(body, user)

        audit_mock.assert_awaited_once()
        kw = audit_mock.call_args.kwargs
        assert kw["action"] == "project.created"
        assert kw["resource"] == "project:proj1"
        assert kw["organisation_id"] == "org1"


# ---------------------------------------------------------------------------
# Assignment ops -> BOTH streams (activity + audit)
# ---------------------------------------------------------------------------

class TestResourceAssignmentDualStream:
    @pytest.mark.asyncio
    async def test_create_resource_dual_stream(self):
        from src.resources import service
        from src.resources.schemas import ResourceAssignmentCreate

        user = make_user()
        body = ResourceAssignmentCreate(user_id=_OID, task_id=None, role="dev")

        project = MagicMock(deleted_on=None, organisation_id="org1")
        doc = MagicMock(id="ra1", task_id=None, user_id=_OID)
        doc.insert = AsyncMock()

        # find() serves both the live-assignment list and the revive probe.
        query = make_query_mock([])
        query.first_or_none = AsyncMock(return_value=None)
        MockRA = MagicMock()
        MockRA.find = MagicMock(return_value=query)
        MockRA.find_one = AsyncMock(return_value=None)  # no released row to reopen
        MockRA.return_value = doc

        with patch("src.resources.service.Project.get", AsyncMock(return_value=project)), \
             patch("src.resources.service.user_belongs_to_organisation", AsyncMock(return_value=True)), \
             patch("src.resources.service.ResourceAssignment", MockRA), \
             patch("src.resources.service.outbox.publish", AsyncMock()), \
             patch("src.resources.service._to_out", MagicMock(return_value={})), \
             patch("src.resources.service.emit_activity", AsyncMock()) as act, \
             patch("src.resources.service.emit_audit", AsyncMock()) as aud:
            await service.create_resource(_OID, body, user)

        act.assert_awaited_once()
        aud.assert_awaited_once()
        for m in (act, aud):
            kw = m.call_args.kwargs
            assert kw["action"] == "resource.assigned"
            assert kw["resource"] == "resource:ra1"

    @pytest.mark.asyncio
    async def test_delete_resource_dual_stream(self):
        from src.resources import service

        user = make_user()
        doc = MagicMock(
            id="ra1", deleted_on=None, released_on=None, project_id=_OID,
            organisation_id="org1", user_id="emp1", task_id=None, removal_history=[],
        )
        doc.save = AsyncMock()

        with patch("src.resources.service.ResourceAssignment.get", AsyncMock(return_value=doc)), \
             patch("src.resources.service._active_assignments", AsyncMock(return_value=[doc])), \
             patch("src.resources.service.emit_activity", AsyncMock()) as act, \
             patch("src.resources.service.emit_audit", AsyncMock()) as aud:
            await service.delete_resource(_OID, "ra1", user, "no longer on project", "2026-09-30")

        act.assert_awaited_once()
        aud.assert_awaited_once()
        for m in (act, aud):
            assert m.call_args.kwargs["action"] == "resource.removed"
            assert m.call_args.kwargs["resource"] == "resource:ra1"


class TestProjectTaskAssignmentDualStream:
    @pytest.mark.asyncio
    async def test_assign_task_to_project_dual_stream_and_resource(self):
        from src.tasks import service
        from src.tasks.schemas import ProjectTaskCreate

        user = make_user()
        project = MagicMock(deleted_on=None, organisation_id="org1")
        task = MagicMock(deleted_on=None, organisation_id="org1", project_id=None,
                         name="T", is_billable=True)
        result = MagicMock(id="pt1")

        with patch("src.tasks.service.Project.get", AsyncMock(return_value=project)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service._assign_single", AsyncMock(return_value=result)), \
             patch("src.tasks.service._pt_out", MagicMock(return_value={})), \
             patch("src.tasks.service.emit_activity", AsyncMock()) as act, \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            await service.assign_task_to_project(_OID, ProjectTaskCreate(task_id=_OID), user)

        act.assert_awaited_once()
        aud.assert_awaited_once()
        for m in (act, aud):
            kw = m.call_args.kwargs
            assert kw["action"] == "project_task.assigned"
            assert kw["resource"] == "project_task:pt1"  # entity matches action

    @pytest.mark.asyncio
    async def test_remove_task_from_project_dual_stream_and_resource(self):
        from src.tasks import service

        user = make_user()
        pt = MagicMock(id="pt1", deleted_on=None)
        pt.save = AsyncMock()
        task = MagicMock(name="T")

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.TimesheetEntry.find", return_value=make_query_mock([])), \
             patch("src.tasks.service.emit_activity", AsyncMock()) as act, \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            await service.remove_task_from_project(_OID, _OID, user)

        act.assert_awaited_once()
        aud.assert_awaited_once()
        for m in (act, aud):
            assert m.call_args.kwargs["action"] == "project_task.removed"
            assert m.call_args.kwargs["resource"] == "project_task:pt1"

    @pytest.mark.asyncio
    async def test_update_project_task_audit_with_changed_fields(self):
        from src.tasks import service

        user = make_user()
        pt = MagicMock(id="pt1", deleted_on=None, task_id="task1")
        pt.save = AsyncMock()
        # task.save is awaited by the sync-back-to-Task path -> must be AsyncMock
        task = MagicMock(
            id="task1", deleted_on=None, organisation_id="org1", name="T",
            estimated_hours=None, billable_rate=None, notes=None,
        )
        task.save = AsyncMock()

        with patch("src.tasks.service.ProjectTask.find_one", AsyncMock(return_value=pt)), \
             patch("src.tasks.service.Task.get", AsyncMock(return_value=task)), \
             patch("src.tasks.service.emit_audit", AsyncMock()) as aud:
            await service.update_project_task(_OID, _OID, {"estimated_hours": 5.0}, user)

        kw = aud.call_args_list[0].kwargs
        assert kw["action"] == "project_task.updated"
        assert kw["resource"] == "project_task:pt1"
        assert kw["changed_fields"] == ["estimated_hours"]
        # The sync of an unset Task default is audited against the task itself.
        kw = aud.call_args_list[1].kwargs
        assert kw["action"] == "task.updated"
        assert kw["resource"] == "task:task1"
        assert kw["changed_fields"] == ["estimated_hours"]


# ---------------------------------------------------------------------------
# Timesheet lifecycle
# ---------------------------------------------------------------------------

class TestEntryUpdateEmitsActivity:
    @pytest.mark.asyncio
    async def test_save_entries_existing_entry_emits_entry_updated(self):
        from src.timesheets import service
        from src.timesheets.schemas import TimesheetEntryBulkSave, TimesheetEntryCreate

        user = make_user()
        ts = make_timesheet()  # DRAFT (editable)
        # Settings tuned so every pre-loop guard is skipped.
        settings = make_settings(
            daily_time_entry_enabled=False,
            allow_future_entries=True,
            allow_past_entries_days=None,
            restrict_time_off_entries=False,
            daily_restrictions_enabled=False,
        )
        body = TimesheetEntryBulkSave(entries=[
            TimesheetEntryCreate(project_id=_OID, task_id=_OID, entry_date="2026-05-04", hours=8.0)
        ])

        existing = make_entry(id="e1")  # find_one returns it -> UPDATE branch
        MockTE = MagicMock()
        MockTE.find = MagicMock(return_value=make_query_mock([]))
        MockTE.find_one = AsyncMock(return_value=existing)

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service.hidden_project_ids", AsyncMock(return_value=[])), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=settings)), \
             patch("src.timesheets.service.Project.find", return_value=make_query_mock([])), \
             patch("src.timesheets.service._validate_entry", AsyncMock(return_value=True)), \
             patch("src.timesheets.service.TimesheetEntry", MockTE), \
             patch("src.timesheets.service._recalculate_hours", AsyncMock(return_value=(8.0, 8.0, 0.0))), \
             patch("src.timesheets.service._ts_to_out", MagicMock(return_value={})), \
             patch("src.timesheets.service.emit_activity", AsyncMock()) as act:
            await service.save_entries("ts1", body, user)

        actions = [c.kwargs["action"] for c in act.await_args_list]
        assert "timesheet.entry_updated" in actions
        # existing entry was updated, not inserted
        existing.save.assert_awaited()


class TestSubmitEmitsAuditRecord:
    @pytest.mark.asyncio
    async def test_submit_timesheet_emits_audit_and_activity(self):
        from src.timesheets import service

        user = make_user()
        ts = make_timesheet()  # DRAFT (submittable)
        entry = make_entry(project_id="p1")

        with patch("src.timesheets.service._load_timesheet", AsyncMock(return_value=ts)), \
             patch("src.timesheets.service._get_settings", AsyncMock(return_value=None)), \
             patch("src.timesheets.service._fill_zero_hour_entries", AsyncMock()), \
             patch("src.timesheets.service.TimesheetEntry.find", return_value=make_query_mock([entry])), \
             patch("src.timesheets.service.ResourceAssignment.find",
                   return_value=make_query_mock([MagicMock(project_id="p1", task_id=None)])), \
             patch("src.timesheets.service._create_project_approvals", AsyncMock()), \
             patch("src.timesheets.service.notify_timesheet_submitted", AsyncMock()), \
             patch("src.timesheets.service._ts_to_out", MagicMock(return_value={})), \
             patch("src.timesheets.service.emit_activity", AsyncMock()) as act, \
             patch("src.timesheets.service.emit_audit", AsyncMock()) as aud:
            await service.submit_timesheet("ts1", user)

        # one compliance audit record for the state change
        aud.assert_awaited_once()
        assert aud.call_args.kwargs["action"] == "timesheet.submitted"
        assert aud.call_args.kwargs["resource"] == "timesheet:ts1"
        # plus the per-project activity event
        assert any(c.kwargs["action"] == "timesheet.submitted" for c in act.await_args_list)


class TestAutoSubmitCoverage:
    @pytest.mark.asyncio
    async def test_auto_submit_dual_stream_and_creates_approvals(self):
        from src.timesheets import service

        ts_settings = make_settings(
            auto_submit_enabled=True,
            weekly_restrictions_enabled=False,
            submission_day="monday",
            submission_time="00:00",
            submission_deadline_hours=0,
            organisation_id="org1",
        )
        draft = make_timesheet(total_hours=8.0)  # DRAFT (editable)
        entry = make_entry(project_id="p1")

        with patch("src.models.TimesheetSettings.find", MagicMock(return_value=make_query_mock([ts_settings]))), \
             patch("src.timesheets.service.WeeklyTimesheet.find", MagicMock(return_value=make_query_mock([draft]))), \
             patch("src.timesheets.service.TimesheetEntry.find", MagicMock(return_value=make_query_mock([entry]))), \
             patch("src.timesheets.service._compute_shortage_and_penalty", MagicMock(return_value=(0.0, 0.0))), \
             patch("src.timesheets.service._create_project_approvals", AsyncMock()) as approvals, \
             patch("src.timesheets.service.emit_activity", AsyncMock()) as act, \
             patch("src.timesheets.service.emit_audit", AsyncMock()) as aud:
            result = await service.auto_submit_pending()

        # the silent gap is closed: approvals created + both streams emitted
        approvals.assert_awaited_once()
        assert act.call_args.kwargs["action"] == "timesheet.auto_submitted"
        assert aud.call_args.kwargs["action"] == "timesheet.auto_submitted"
        assert result["submitted"] == 1
