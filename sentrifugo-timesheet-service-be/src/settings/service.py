from __future__ import annotations

import logging
from typing import Any

from ..audit import emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.object_id import is_valid_object_id
from ..common.user_resolver import fetch_employment_types
from ..common.timestamps import utcnow
from ..exceptions import ProjectNotFound, SettingsNotFound
from ..models import ApprovalLevelConfig, Project, StatusEnum, TimesheetSettings
from .schemas import ApprovalSettingsUpdate, HourSettingsUpdate, SubmissionSettingsUpdate

logger = logging.getLogger(__name__)


async def _assert_project_in_org(project_id: str, user: UserBase) -> None:
    """Fail closed on the ``project_id`` query param: settings may only ever be
    read or written for a live project of the caller's own organisation."""
    if not is_valid_object_id(project_id):
        raise ProjectNotFound()
    project = await Project.get(project_id)
    if (
        project is None
        or project.deleted_on is not None
        or project.organisation_id != user.organisation_id
    ):
        raise ProjectNotFound()


async def _get_or_create_settings(
    user: UserBase, *, project_id: str | None = None,
) -> TimesheetSettings:
    from beanie import PydanticObjectId
    if project_id:
        await _assert_project_in_org(project_id, user)
    proj_oid = PydanticObjectId(project_id) if project_id else None
    doc = await TimesheetSettings.find_one({
        "organisation_id": user.organisation_id,
        "project_id": proj_oid,
    })
    if not doc:
        now = utcnow()
        doc = TimesheetSettings(
            organisation_id=user.organisation_id,
            project_id=proj_oid,
            created_by=user.id,
            created_on=now,
        )
        await doc.insert()
    return doc


async def get_effective_settings(
    organisation_id: str, project_id: str | None = None,
) -> TimesheetSettings | None:
    from beanie import PydanticObjectId
    if project_id:
        proj_oid = PydanticObjectId(project_id)
        doc = await TimesheetSettings.find_one({
            "organisation_id": organisation_id, "project_id": proj_oid,
        })
        if doc:
            return doc
    return await TimesheetSettings.find_one({
        "organisation_id": organisation_id, "project_id": None,
    })


async def _get_approval_levels(settings_id: str) -> list[dict[str, Any]]:
    from beanie import PydanticObjectId
    levels = await ApprovalLevelConfig.find(
        {"settings_id": PydanticObjectId(settings_id), "deleted_on": None}
    ).sort("level").to_list()
    return [
        {
            "id": str(lv.id),
            "level": lv.level,
            "approver_role": lv.approver_role,
            "approver_id": str(lv.approver_id) if lv.approver_id else None,
        }
        for lv in levels
    ]


def _to_out(doc: TimesheetSettings, levels: list[dict] | None = None) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "project_id": str(doc.project_id) if doc.project_id is not None else None,
        # Hour settings
        "daily_restrictions_enabled": doc.daily_restrictions_enabled,
        "min_hours_per_day": doc.min_hours_per_day,
        "max_hours_per_day": doc.max_hours_per_day,
        "deduct_leave_daily": doc.deduct_leave_daily,
        "weekly_restrictions_enabled": doc.weekly_restrictions_enabled,
        "standard_hours_per_day": doc.standard_hours_per_day,
        "max_hours_per_week": doc.max_hours_per_week,
        "deduct_leave_weekly": doc.deduct_leave_weekly,
        "show_hours_type": doc.show_hours_type,
        "shortage_penalty_enabled": doc.shortage_penalty_enabled,
        "penalty_percentage": doc.penalty_percentage,
        # Submission settings
        "daily_time_entry_enabled": doc.daily_time_entry_enabled,
        "allow_past_due_submission": doc.allow_past_due_submission,
        "restrict_time_off_entries": doc.restrict_time_off_entries,
        "allow_attachment": doc.allow_attachment,
        "submission_compliance_type": doc.submission_compliance_type,
        "submission_deadline_hours": doc.submission_deadline_hours,
        "submission_day": doc.submission_day,
        "submission_time": doc.submission_time,
        "auto_submit_enabled": doc.auto_submit_enabled,
        # Approval settings
        "approval_required": doc.approval_required,
        "allow_future_entries": doc.allow_future_entries,
        "past_submission_cutoff_enabled": doc.past_submission_cutoff_enabled,
        "past_submission_cutoff_day": doc.past_submission_cutoff_day,
        "notification_excluded_employment_types": doc.notification_excluded_employment_types,
        "approval_levels": levels or [],
        # Client approval notification settings
        "client_notify_on_pending_count_enabled": doc.client_notify_on_pending_count_enabled,
        "client_notify_pending_count": doc.client_notify_pending_count,
        "client_notify_on_schedule_enabled": doc.client_notify_on_schedule_enabled,
        "client_notify_schedule": doc.client_notify_schedule,
        "employee_reminder_enabled": doc.employee_reminder_enabled,
        "employee_reminder_time": doc.employee_reminder_time,
        "employee_reminder_days": doc.employee_reminder_days,
        "created_on": doc.created_on,
        "modified_on": doc.modified_on,
    }


async def list_employment_types(user: UserBase) -> list[dict[str, str]]:
    """The organisation's employment types, for the notification-exclusion picker."""
    return await fetch_employment_types(user.organisation_id)


async def get_settings(user: UserBase, *, project_id: str | None = None) -> dict[str, Any]:
    doc = await _get_or_create_settings(user, project_id=project_id)
    levels = await _get_approval_levels(str(doc.id))
    return _to_out(doc, levels)


async def update_hour_settings(
    body: HourSettingsUpdate, user: UserBase, *, project_id: str | None = None,
) -> dict[str, Any]:
    doc = await _get_or_create_settings(user, project_id=project_id)
    doc.daily_restrictions_enabled = body.daily_restrictions_enabled
    doc.min_hours_per_day = body.min_hours_per_day
    doc.max_hours_per_day = body.max_hours_per_day
    doc.deduct_leave_daily = body.deduct_leave_daily
    doc.weekly_restrictions_enabled = body.weekly_restrictions_enabled
    doc.standard_hours_per_day = body.standard_hours_per_day
    doc.max_hours_per_week = body.max_hours_per_week
    doc.deduct_leave_weekly = body.deduct_leave_weekly
    doc.show_hours_type = body.show_hours_type
    doc.shortage_penalty_enabled = body.shortage_penalty_enabled
    doc.penalty_percentage = body.penalty_percentage
    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    await emit_audit(
        action="settings.hours_updated",
        resource=f"settings:{str(user.organisation_id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        changed_fields=list(body.model_dump(exclude_unset=True).keys()),
    )

    levels = await _get_approval_levels(str(doc.id))
    return _to_out(doc, levels)


async def update_submission_settings(
    body: SubmissionSettingsUpdate, user: UserBase, *, project_id: str | None = None,
) -> dict[str, Any]:
    doc = await _get_or_create_settings(user, project_id=project_id)
    doc.daily_time_entry_enabled = body.daily_time_entry_enabled
    doc.allow_past_due_submission = body.allow_past_due_submission
    doc.restrict_time_off_entries = body.restrict_time_off_entries
    doc.allow_attachment = body.allow_attachment
    doc.submission_compliance_type = body.submission_compliance_type
    doc.submission_deadline_hours = body.submission_deadline_hours
    doc.submission_day = body.submission_day
    doc.submission_time = body.submission_time
    doc.auto_submit_enabled = body.auto_submit_enabled
    doc.client_notify_on_pending_count_enabled = body.client_notify_on_pending_count_enabled
    doc.client_notify_pending_count = body.client_notify_pending_count
    doc.client_notify_on_schedule_enabled = body.client_notify_on_schedule_enabled
    doc.client_notify_schedule = body.client_notify_schedule
    doc.notification_excluded_employment_types = body.notification_excluded_employment_types
    doc.employee_reminder_enabled = body.employee_reminder_enabled
    doc.employee_reminder_time = body.employee_reminder_time
    doc.employee_reminder_days = body.employee_reminder_days
    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    await emit_audit(
        action="settings.submission_updated",
        resource=f"settings:{str(user.organisation_id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        changed_fields=list(body.model_dump(exclude_unset=True).keys()),
    )

    levels = await _get_approval_levels(str(doc.id))
    return _to_out(doc, levels)


async def update_approval_settings(
    body: ApprovalSettingsUpdate, user: UserBase, *, project_id: str | None = None,
) -> dict[str, Any]:
    doc = await _get_or_create_settings(user, project_id=project_id)
    doc.approval_required = body.approval_required
    doc.allow_future_entries = body.allow_future_entries
    doc.past_submission_cutoff_enabled = body.past_submission_cutoff_enabled
    doc.past_submission_cutoff_day = body.past_submission_cutoff_day
    doc.notification_excluded_employment_types = body.notification_excluded_employment_types
    doc.client_notify_on_pending_count_enabled = body.client_notify_on_pending_count_enabled
    doc.client_notify_pending_count = body.client_notify_pending_count
    doc.client_notify_on_schedule_enabled = body.client_notify_on_schedule_enabled
    doc.client_notify_schedule = body.client_notify_schedule
    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    settings_id = str(doc.id)
    now = utcnow()
    from beanie import PydanticObjectId
    settings_oid = doc.id  # PydanticObjectId

    existing = await ApprovalLevelConfig.find(
        {"settings_id": settings_oid, "deleted_on": None}
    ).to_list()
    for lv in existing:
        lv.deleted_on = now
        lv.deleted_by = user.id
        await lv.save()

    for lv_data in body.levels:
        lv = ApprovalLevelConfig(
            organisation_id=user.organisation_id,
            settings_id=settings_oid,
            level=lv_data.level,
            approver_role=lv_data.approver_role,
            approver_id=lv_data.approver_id,
            created_by=user.id,
            created_on=now,
        )
        await lv.insert()

    await emit_audit(
        action="settings.approval_updated",
        resource=f"settings:{str(user.organisation_id)}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        changed_fields=list(body.model_dump(exclude_unset=True).keys()),
    )

    levels = await _get_approval_levels(settings_id)
    return _to_out(doc, levels)


