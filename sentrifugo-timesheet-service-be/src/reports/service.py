from __future__ import annotations

import logging
from typing import Any

from ..auth.utils.dependencies import UserBase
from ..common.user_resolver import resolve_user_names
from ..models import Project, ResourceAssignment, TimesheetEntry, WeeklyTimesheet

logger = logging.getLogger(__name__)


async def get_project_summary(
    user: UserBase,
    *,
    client_id: str | None = None,
) -> list[dict[str, Any]]:
    project_filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }
    if client_id:
        from beanie import PydanticObjectId
        project_filt["client_id"] = PydanticObjectId(client_id)

    projects = await Project.find(project_filt).to_list()

    results = []
    for proj in projects:
        pid_oid = proj.id  # PydanticObjectId
        pid = str(proj.id)
        entries = await TimesheetEntry.find(
            {"project_id": pid_oid, "deleted_on": None}
        ).to_list()

        total = sum(e.hours for e in entries)
        billable = sum(e.hours for e in entries if e.is_billable)

        # Count distinct (resource × date) pairs where hours were logged
        total_days = len({
            (e.weekly_timesheet_id, e.entry_date.date())
            for e in entries if e.hours > 0
        })

        resource_count = await ResourceAssignment.find(
            {"project_id": pid_oid, "deleted_on": None, "status": "active"}
        ).count()

        results.append({
            "project_id": pid,
            "project_name": proj.name,
            "total_hours": total,
            "total_days": total_days,
            "billable_hours": billable,
            "non_billable_hours": total - billable,
            "resource_count": resource_count,
        })

    return results


async def get_employee_summary(
    user: UserBase,
    *,
    project_id: str | None = None,
) -> list[dict[str, Any]]:
    ts_filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "deleted_on": None,
    }
    timesheets = await WeeklyTimesheet.find(ts_filt).to_list()

    employee_map: dict[str, dict[str, Any]] = {}
    for ts in timesheets:
        eid = ts.user_id
        if eid not in employee_map:
            employee_map[eid] = {
                "user_id": eid,
                "total_hours": 0,
                "billable_hours": 0,
                "non_billable_hours": 0,
                "submitted_count": 0,
                "approved_count": 0,
            }
        emp = employee_map[eid]
        emp["total_hours"] += ts.total_hours
        emp["billable_hours"] += ts.billable_hours
        emp["non_billable_hours"] += ts.non_billable_hours
        if ts.timesheet_status.value in ("submitted", "resubmitted", "l1_approved", "client_approved"):
            emp["submitted_count"] += 1
        if ts.timesheet_status.value in ("l1_approved", "client_approved"):
            emp["approved_count"] += 1

    name_map = await resolve_user_names(list(employee_map.keys()), user.organisation_id)
    for emp in employee_map.values():
        emp["user_name"] = name_map.get(emp["user_id"], "")
        emp["user_id"] = str(emp["user_id"])

    return list(employee_map.values())
