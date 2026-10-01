"""Notification orchestration — resolves recipients and publishes email events.

Each public function is called from the timesheet/approval service layer
after a workflow action completes. Failures are logged but never raised
so email delivery issues cannot block the primary workflow.
"""

from __future__ import annotations

import logging
from hashlib import sha256
from typing import Any

from src.config import settings
from src.common.user_resolver import resolve_emp_codes, resolve_employment_type_ids, resolve_user_emails, resolve_user_names
from src.models import ApprovalActionEnum, ApprovalRecord, BillableRateTypeEnum, Client, ClientApprovalToken, ClientProjectHead, Project, ProjectApprovalStatusEnum, ResourceAssignment, Task, TimesheetEntry, TimesheetProjectApproval, WeeklyTimesheet
from src.notifications.email_events import (
    publish_budget_threshold_email,
    publish_client_review_request_email,
    publish_employee_timesheet_reminder_email,
    publish_timesheet_approved_email,
    publish_timesheet_rejected_email,
    publish_timesheet_resubmitted_email,
    publish_timesheet_submitted_email,
    publish_timesheet_updated_email,
)

from src.settings.service import get_effective_settings

logger = logging.getLogger(__name__)

MANAGER_ROLES = {"manager", "lead", "project_manager", "team_lead"}


def _mask_email(email: str | None) -> str:
    """Return a non-identifying stand-in for an email address.

    These logs are shipped to central logging, so recipient addresses (PII) must
    never appear in them. Keeps only the domain plus a short digest of the local
    part, which is enough to correlate a delivery problem without exposing who
    the recipient is. Prefer logging the user id where one is available.
    """
    value = (email or "").strip().lower()
    if not value:
        return "<none>"
    digest = sha256(value.encode("utf-8")).hexdigest()[:8]
    domain = value.rsplit("@", 1)[1] if "@" in value else "invalid"
    return f"<{digest}@{domain}>"


async def _notifiable(user_ids: list, organisation_id) -> list:
    """Drop recipients whose employment type is excluded from timesheet emails.

    Contractors and interns typically fill timesheets but are not on the mailing
    list; which types those are is configuration, not a hard-coded rule. The setting
    holds master-data ids, which is exactly what an employee record carries, so the
    check is one read of the employee document.

    Anyone without an employee record — an external project head, say — is never
    excluded, so this can only ever narrow the list for people it positively
    identifies as an excluded type.
    """
    if not user_ids:
        return []
    try:
        settings_doc = await get_effective_settings(organisation_id)
        # Compared as strings: the setting holds ids the frontend read from master
        # data, recipients arrive as ObjectId or PydanticObjectId, and IAM stores
        # either. Normalising both sides is what keeps the match reliable.
        excluded = {
            str(t) for t in
            (getattr(settings_doc, "notification_excluded_employment_types", None) or [])
        }
        if not excluded:
            return list(user_ids)

        types = await resolve_employment_type_ids([str(u) for u in user_ids], organisation_id)
    except Exception:
        # Never let this filter be the reason a notification goes missing: if the
        # settings or IAM lookup fails, fall back to notifying everyone.
        logger.exception("employment-type filter failed — notifying all recipients")
        return list(user_ids)

    keep = [uid for uid in user_ids if types.get(str(uid)) not in excluded]
    dropped = len(user_ids) - len(keep)
    if dropped:
        logger.info("notification recipients skipped by employment type: %d", dropped)
    return keep


async def _get_project_manager_ids(
    project_ids: list[str], organisation_id: str, exclude_user_id: str,
) -> list[str]:
    """Find managers assigned to the given projects."""
    from beanie import PydanticObjectId
    from bson import ObjectId as OId
    proj_oids = [PydanticObjectId(pid) for pid in project_ids if OId.is_valid(pid)]
    assignments = await ResourceAssignment.find({
        "project_id": {"$in": proj_oids},
        "organisation_id": organisation_id,
        "role": {"$in": list(MANAGER_ROLES)},
        "task_id": None,
        "deleted_on": None,
        "status": "active",
    }).to_list()
    return list({a.user_id for a in assignments if a.user_id != exclude_user_id})


async def _get_timesheet_project_ids(timesheet_id: str) -> list[str]:
    from beanie import PydanticObjectId
    from bson import ObjectId as OId
    ts_oid = PydanticObjectId(timesheet_id) if OId.is_valid(timesheet_id) else timesheet_id
    entries = await TimesheetEntry.find(
        {"weekly_timesheet_id": ts_oid, "deleted_on": None},
    ).to_list()
    return list({str(e.project_id) for e in entries})


async def _get_project_names_str(project_ids: list[str]) -> str:
    from bson import ObjectId as OId
    from src.models import Project

    if not project_ids:
        return ""
    oids = [OId(pid) for pid in project_ids if OId.is_valid(pid)]
    projects = await Project.find({"_id": {"$in": oids}, "deleted_on": None}).to_list()
    return ", ".join(sorted(p.name for p in projects))


async def notify_timesheet_submitted(
    doc: WeeklyTimesheet,
    actor_name: str,
) -> None:
    try:
        ts_id = str(doc.id)
        project_ids = await _get_timesheet_project_ids(ts_id)
        if not project_ids:
            return

        manager_ids = await _get_project_manager_ids(
            project_ids, doc.organisation_id, doc.user_id,
        )
        if not manager_ids:
            return

        manager_ids = await _notifiable(manager_ids, doc.organisation_id)
        email_map = await resolve_user_emails(manager_ids, doc.organisation_id)
        if not email_map:
            return

        project_names = await _get_project_names_str(project_ids)
        week_start = str(doc.week_start_date.date())
        week_end = str(doc.week_end_date.date())

        for mgr_id, email in email_map.items():
            await publish_timesheet_submitted_email(
                to=email,
                employee_name=actor_name,
                week_start=week_start,
                week_end=week_end,
                total_hours=doc.total_hours,
                project_names=project_names,
                timesheet_id=ts_id,
                tenant_id=str(doc.organisation_id),
            )
    except Exception:
        logger.exception("notify_timesheet_submitted failed timesheet_id=%s", doc.id)


async def notify_timesheet_resubmitted(
    doc: WeeklyTimesheet,
    actor_name: str,
) -> None:
    try:
        ts_id = str(doc.id)
        project_ids = await _get_timesheet_project_ids(ts_id)
        if not project_ids:
            return

        manager_ids = await _get_project_manager_ids(
            project_ids, doc.organisation_id, doc.user_id,
        )
        if not manager_ids:
            return

        manager_ids = await _notifiable(manager_ids, doc.organisation_id)
        email_map = await resolve_user_emails(manager_ids, doc.organisation_id)
        if not email_map:
            return

        project_names = await _get_project_names_str(project_ids)
        week_start = str(doc.week_start_date.date())
        week_end = str(doc.week_end_date.date())

        for mgr_id, email in email_map.items():
            await publish_timesheet_resubmitted_email(
                to=email,
                employee_name=actor_name,
                week_start=week_start,
                week_end=week_end,
                total_hours=doc.total_hours,
                project_names=project_names,
                timesheet_id=ts_id,
                tenant_id=str(doc.organisation_id),
            )
    except Exception:
        logger.exception("notify_timesheet_resubmitted failed timesheet_id=%s", doc.id)


async def _managers_by_project(
    project_ids: list[str], organisation_id: str, exclude_user_id: str,
) -> dict[str, set[str]]:
    """Map manager user id → the ids of *their* projects among ``project_ids``."""
    from beanie import PydanticObjectId
    from bson import ObjectId as OId

    proj_oids = [PydanticObjectId(pid) for pid in project_ids if OId.is_valid(pid)]
    assignments = await ResourceAssignment.find({
        "project_id": {"$in": proj_oids},
        "organisation_id": organisation_id,
        "role": {"$in": list(MANAGER_ROLES)},
        "task_id": None,
        "deleted_on": None,
        "status": "active",
    }).to_list()

    by_manager: dict[str, set[str]] = {}
    for assignment in assignments:
        if assignment.user_id == exclude_user_id:
            continue
        by_manager.setdefault(assignment.user_id, set()).add(str(assignment.project_id))
    return by_manager


async def notify_timesheet_updated(
    doc: WeeklyTimesheet,
    actor_name: str,
) -> None:
    """Tell each pending approver that a submitted week changed.

    Carries the week's current totals, and each manager is told only about the
    projects they actually manage rather than every project on the timesheet. Uses
    its own event type and template so the mail cannot be mistaken for a fresh
    submission, and keys on the modification time so each edit sends once.
    """
    try:
        ts_id = str(doc.id)
        project_ids = await _get_timesheet_project_ids(ts_id)
        if not project_ids:
            return

        by_manager = await _managers_by_project(project_ids, doc.organisation_id, doc.user_id)
        if not by_manager:
            return

        recipients = await _notifiable(list(by_manager), doc.organisation_id)
        email_map = await resolve_user_emails(recipients, doc.organisation_id)
        if not email_map:
            return

        week_start = str(doc.week_start_date.date())
        week_end = str(doc.week_end_date.date())

        for mgr_id, email in email_map.items():
            own_projects = sorted(by_manager.get(mgr_id, set()))
            if not own_projects:
                continue
            await publish_timesheet_updated_email(
                to=email,
                employee_name=actor_name,
                week_start=week_start,
                week_end=week_end,
                total_hours=doc.total_hours,
                project_names=await _get_project_names_str(own_projects),
                timesheet_id=ts_id,
                updated_at=(doc.modified_on or doc.submitted_at or "").isoformat()
                if (doc.modified_on or doc.submitted_at) else "",
                tenant_id=str(doc.organisation_id),
            )
    except Exception:
        logger.exception("notify_timesheet_updated failed timesheet_id=%s", doc.id)


async def notify_timesheet_approved(
    doc: WeeklyTimesheet,
    approver_name: str,
    level: int,
    role: str,
) -> None:
    try:
        ts_id = str(doc.id)
        email_map = await resolve_user_emails(
            await _notifiable([doc.user_id], doc.organisation_id), doc.organisation_id)
        employee_email = email_map.get(doc.user_id)
        if not employee_email:
            return

        name_map = await resolve_user_names([doc.user_id], doc.organisation_id)
        employee_name = name_map.get(doc.user_id, str(doc.user_id))
        approval_level = "Manager (L1)" if level == 1 else "Client (L2)"

        week_param = doc.week_start_date.strftime("%Y-%m-%d")
        employee_view_link = f"{settings.FRONTEND_URL}/timesheet/my-timesheet/entry?week={week_param}"

        await publish_timesheet_approved_email(
            to=employee_email,
            employee_name=employee_name,
            approver_name=approver_name,
            approval_level=approval_level,
            week_start=str(doc.week_start_date.date()),
            week_end=str(doc.week_end_date.date()),
            total_hours=doc.total_hours,
            timesheet_id=ts_id,
            view_link=employee_view_link,
            tenant_id=str(doc.organisation_id),
        )
    except Exception:
        logger.exception("notify_timesheet_approved failed timesheet_id=%s", doc.id)


async def notify_timesheet_rejected(
    doc: WeeklyTimesheet,
    approver_name: str,
    level: int,
    role: str,
    comments: str,
) -> None:
    try:
        ts_id = str(doc.id)
        week_start = str(doc.week_start_date.date())
        week_end = str(doc.week_end_date.date())
        rejection_level = "Manager (L1)" if level == 1 else "Client (L2)"

        week_param = doc.week_start_date.strftime("%Y-%m-%d")
        employee_view_link = f"{settings.FRONTEND_URL}/timesheet/my-timesheet/entry?week={week_param}"
        manager_view_link = f"{settings.FRONTEND_URL}/timesheet/employee-timesheets?timesheet={ts_id}"

        email_map = await resolve_user_emails(
            await _notifiable([doc.user_id], doc.organisation_id), doc.organisation_id)
        employee_email = email_map.get(doc.user_id)
        name_map = await resolve_user_names([doc.user_id], doc.organisation_id)
        employee_name = name_map.get(doc.user_id, str(doc.user_id))

        if employee_email:
            await publish_timesheet_rejected_email(
                to=employee_email,
                employee_name=employee_name,
                approver_name=approver_name,
                rejection_level=rejection_level,
                comments=comments,
                week_start=week_start,
                week_end=week_end,
                timesheet_id=ts_id,
                edit_link=employee_view_link,
                button_label="Edit & Resubmit",
                tenant_id=str(doc.organisation_id),
            )

        if role == "client":
            # Find L1 approver from approval records
            l1_records = await ApprovalRecord.find({
                "weekly_timesheet_id": ts_id,
                "approval_level": 1,
                "action": ApprovalActionEnum.APPROVED.value,
            }).to_list()
            l1_approver_ids = list({r.approver_id for r in l1_records})

            # Also include project-level managers from resource assignments
            project_ids = await _get_timesheet_project_ids(ts_id)
            ra_manager_ids = await _get_project_manager_ids(
                project_ids, doc.organisation_id, doc.user_id,
            )

            all_manager_ids = list({*l1_approver_ids, *ra_manager_ids} - {doc.user_id})
            all_manager_ids = await _notifiable(all_manager_ids, doc.organisation_id)
            mgr_email_map = await resolve_user_emails(all_manager_ids, doc.organisation_id)
            for mgr_email in mgr_email_map.values():
                await publish_timesheet_rejected_email(
                    to=mgr_email,
                    employee_name=employee_name,
                    approver_name=approver_name,
                    rejection_level=rejection_level,
                    comments=comments,
                    week_start=week_start,
                    week_end=week_end,
                    timesheet_id=ts_id,
                    edit_link=manager_view_link,
                    button_label="View Timesheet",
                    tenant_id=str(doc.organisation_id),
                )
    except Exception:
        logger.exception("notify_timesheet_rejected failed timesheet_id=%s", doc.id)


async def notify_budget_threshold_alert(
    project_ids: list[str],
    organisation_id: str,
) -> None:
    """Fire a budget-threshold alert email when a project's estimated spend
    meets or exceeds its ``send_alerts`` percentage after client approval.

    Recipients: project heads (IAM users) + client project heads (external).
    Non-blocking — caller must wrap in try/except.
    """
    try:
        from bson import ObjectId as OId

        for project_id in project_ids:
            if not OId.is_valid(project_id):
                continue

            proj = await Project.get(project_id)
            if proj is None or proj.deleted_on is not None:
                continue

            # Must have send_alerts and at least one budget limit set
            if proj.send_alerts is None:
                continue
            has_budget_cost = proj.budget_cost is not None and proj.budget_cost > 0
            has_budget_hours = proj.budget_hours is not None and proj.budget_hours > 0
            if not has_budget_cost and not has_budget_hours:
                continue

            # Compute cumulative spend across only APPROVED work for this project.
            # Budget is "consumed" when a project's timesheet reaches its terminal
            # approval state: client_approved normally, OR l1_approved when the
            # project does not require client approval. Draft/submitted/pending
            # weeks must NOT count.
            from beanie import PydanticObjectId as _NotifOID
            proj_oid = _NotifOID(project_id)
            qualifying_statuses = [ProjectApprovalStatusEnum.CLIENT_APPROVED.value]
            if proj.client_approval_required is False:
                qualifying_statuses.append(ProjectApprovalStatusEnum.L1_APPROVED.value)
            approved_tpa = await TimesheetProjectApproval.find({
                "project_id": proj_oid,
                "status": {"$in": qualifying_statuses},
                "deleted_on": None,
            }).to_list()
            approved_ts_ids = list({tpa.weekly_timesheet_id for tpa in approved_tpa})
            if not approved_ts_ids:
                continue  # nothing approved for this project yet

            entries = await TimesheetEntry.find({
                "project_id": proj_oid,
                "weekly_timesheet_id": {"$in": approved_ts_ids},
                "deleted_on": None,
            }).to_list()

            if has_budget_cost:
                # Needs a billable_rate to convert to currency
                if not proj.billable_rate or proj.billable_rate <= 0:
                    continue

                if proj.billable_rate_type == BillableRateTypeEnum.PER_DAY:
                    # One "day" = unique (timesheet × calendar date) pair with hours > 0
                    total_days = len({
                        (e.weekly_timesheet_id, e.entry_date.date())
                        for e in entries if e.hours > 0
                    })
                    estimated_amount = total_days * proj.billable_rate
                else:
                    # per_hour (or null — treat as per_hour)
                    billable_hours = sum(e.hours for e in entries if e.is_billable)
                    estimated_amount = billable_hours * proj.billable_rate

                budget_percent = (estimated_amount / proj.budget_cost) * 100
                budget_label = f"{proj.currency} {proj.budget_cost:,.2f}"
                used_label = f"{proj.currency} {round(estimated_amount, 2):,.2f}"
            else:
                # budget_hours fallback: total logged hours vs hour budget
                total_hours = sum(e.hours for e in entries)
                budget_percent = (total_hours / proj.budget_hours) * 100  # type: ignore[operator]
                budget_label = f"{proj.budget_hours} hrs"
                used_label = f"{round(total_hours, 2)} hrs"
                estimated_amount = total_hours  # passed to email for display

            if budget_percent < proj.send_alerts:
                continue  # Threshold not yet reached — nothing to do

            # ── Collect recipients ─────────────────────────────────────────
            recipient_emails: set[str] = set()

            # 1. Project heads stored as IAM user IDs on the project
            if proj.project_head_ids:
                ph_email_map = await resolve_user_emails(proj.project_head_ids, proj.organisation_id)
                recipient_emails.update(ph_email_map.values())

            # 2. External client project heads linked to the project's client
            client_phs = await ClientProjectHead.find({
                "client_id": proj.client_id,
                "organisation_id": organisation_id,
                "deleted_on": None,
                "status": "active",
            }).to_list()
            for cph in client_phs:
                if cph.email:
                    recipient_emails.add(cph.email)

            if not recipient_emails:
                continue

            for email in recipient_emails:
                await publish_budget_threshold_email(
                    to=email,
                    project_name=proj.name,
                    budget_label=budget_label,
                    used_label=used_label,
                    budget_percent=round(budget_percent, 1),
                    threshold_percent=proj.send_alerts,
                    currency=proj.currency,
                    project_id=project_id,
                    tenant_id=str(organisation_id),
                )

    except Exception:
        logger.exception("notify_budget_threshold_alert failed project_ids=%s", project_ids)


_F = 'font-family:&quot;Segoe UI&quot;,system-ui,sans-serif;'
_BORDER_THICK = "2px solid #e4e3ed"
_BORDER_THIN = "1px solid #f0eff6"


def _render_employee_table_rows(employees: list[dict]) -> str:
    """Render employee-grouped <tr> rows matching the approval email template.

    Each employee dict: {
        employee_name, emp_code, approve_link, reject_link,
        projects: [{project_name, tasks: [{task_name, hours}], total}]
    }
    """
    rows: list[str] = []
    for emp in employees:
        total_rows = sum(len(p["tasks"]) + 1 for p in emp["projects"])
        first_in_emp = True

        for proj in emp["projects"]:
            tasks = proj["tasks"]

            for task_idx, task in enumerate(tasks):
                row = "<tr>"

                if first_in_emp:
                    row += (
                        f'<td rowspan="{total_rows}" valign="top"'
                        f' style="{_F} padding:14px; border-bottom:{_BORDER_THICK}; border-right:{_BORDER_THIN};">'
                        f'<span style="font-size:14px; font-weight:600; color:#11023b; display:block;">{emp["employee_name"]}</span>'
                        f'<span style="font-size:12px; color:#6b7280; display:block; margin-top:2px;">{emp.get("emp_code") or ""}</span>'
                        f'</td>'
                    )

                if task_idx == 0:
                    row += (
                        f'<td rowspan="{len(tasks)}" valign="top"'
                        f' style="{_F} padding:13px 14px; border-bottom:{_BORDER_THIN}; border-right:{_BORDER_THIN};'
                        f' font-size:13px; color:#374151;">{proj["project_name"]}</td>'
                    )

                row += (
                    f'<td style="{_F} padding:13px 14px; border-bottom:{_BORDER_THIN};'
                    f' font-size:13px; color:#374151;">{task["task_name"]}</td>'
                    f'<td align="center" style="{_F} padding:13px 14px; border-bottom:{_BORDER_THIN};'
                    f' font-size:14px; font-weight:600; color:#11023b; white-space:nowrap;">{task["hours"]}</td>'
                )

                if first_in_emp:
                    row += (
                        f'<td rowspan="{total_rows}" align="center" valign="middle"'
                        f' style="padding:12px 14px; border-bottom:{_BORDER_THICK};">'
                        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">'
                        f'<tr><td style="padding-bottom:7px;">'
                        f'<a href="{emp["approve_link"]}"'
                        f' style="display:inline-block; {_F} font-size:12px; font-weight:600; color:#ffffff;'
                        f' background-color:#16a34a; text-decoration:none; padding:7px 16px;'
                        f' border-radius:50px; min-width:60px; text-align:center;">&#10003;&nbsp;Approve</a>'
                        f'</td></tr>'
                        f'<tr><td>'
                        f'<a href="{emp["reject_link"]}"'
                        f' style="display:inline-block; {_F} font-size:12px; font-weight:600; color:#dc2626;'
                        f' background-color:#ffffff; text-decoration:none; padding:6px 16px;'
                        f' border-radius:50px; min-width:60px; text-align:center; border:1.5px solid #dc2626;">&#10007;&nbsp;Reject</a>'
                        f'</td></tr></table></td>'
                    )
                    first_in_emp = False

                row += "</tr>"
                rows.append(row)

            # Project subtotal row (colspan=2 covers project+task columns; emp+action still spanned)
            rows.append(
                f'<tr>'
                f'<td colspan="2" align="right"'
                f' style="{_F} padding:10px 14px; border-bottom:{_BORDER_THICK}; background-color:#fafafa;'
                f' font-size:11px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#6b7280;">Project Total</td>'
                f'<td align="center"'
                f' style="{_F} padding:10px 14px; border-bottom:{_BORDER_THICK}; background-color:#fafafa;'
                f' font-size:15px; font-weight:700; color:#11023b;">{proj["total"]}</td>'
                f'</tr>'
            )

    return "".join(rows)


def _render_grand_total_row(grand_total: float) -> str:
    return (
        f'<tr>'
        f'<td colspan="3" align="right"'
        f' style="{_F} padding:14px; background-color:#f5f4fb;'
        f' font-size:12px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#11023b;">Grand Total Hours</td>'
        f'<td align="center"'
        f' style="{_F} padding:14px; background-color:#f5f4fb;'
        f' font-size:17px; font-weight:700; color:#11023b; white-space:nowrap;">{grand_total}</td>'
        f'<td style="background-color:#f5f4fb;">&nbsp;</td>'
        f'</tr>'
    )


async def _dispatch_client_review_emails(
    organisation_id: str,
    seed_project_ids: list[str],
    *,
    count_trigger: bool = False,
    pending_threshold: int = 5,
    idempotency_prefix: str = "system",
    restrict_ts_ids: set[str] | None = None,
) -> None:
    """Core logic: find recipients from seed projects, collect ALL their pending
    L1-approved timesheets, generate tokens, and send one consolidated email per recipient.

    Called by both the L1-approval event handler and the scheduled cron.

    ``restrict_ts_ids`` (set of timesheet id strings), when provided, limits the
    included timesheets — used by the schedule cron to send only the timesheets
    whose employees belong to a Business Unit currently at its 18:30 local time.
    """
    from uuid import uuid4
    from datetime import timedelta
    from bson import ObjectId as OId
    from src.common.timestamps import utcnow
    from src.config import settings as cfg

    if not seed_project_ids:
        return

    proj_oids = [OId(pid) for pid in seed_project_ids if OId.is_valid(pid)]
    # Only projects that actually require client approval are eligible for review emails
    seed_projects = await Project.find({
        "_id": {"$in": proj_oids},
        "deleted_on": None,
        "client_approval_required": {"$ne": False},
    }).to_list()
    logger.info("client_review dispatch seed_projects=%d org=%s", len(seed_projects), organisation_id)
    if not seed_projects:
        logger.info("client_review dispatch: no client-approval-required projects in seed, skipping")
        return

    # Build recipient_map: email → {approver_id, email, client_id?}
    recipient_map: dict[str, dict] = {}
    client_cache: dict = {}  # client_id -> Client doc (avoid refetching per project)
    for proj in seed_projects:
        pid_str = str(proj.id)
        if proj.project_head_ids:
            ph_email_map = await resolve_user_emails(proj.project_head_ids, organisation_id)
            if not ph_email_map:
                logger.warning("client_review no emails for iam_heads=%s project_id=%s", proj.project_head_ids, pid_str)
            for uid, em in ph_email_map.items():
                logger.info("client_review iam_head uid=%s project_id=%s", uid, pid_str)
                recipient_map.setdefault(em, {"approver_id": uid, "email": em})
        else:
            logger.info("client_review project_id=%s has no project_head_ids", pid_str)

        # ── The client's own contact (Client.contact_user_id / contact_email) ──
        if proj.client_id not in client_cache:
            client_cache[proj.client_id] = await Client.get(proj.client_id)
        client_doc = client_cache[proj.client_id]
        if client_doc and client_doc.deleted_on is None:
            client_email = client_doc.contact_email
            if client_email and client_doc.contact_user_id:
                logger.info("client_review client_contact user=%s project_id=%s",
                            client_doc.contact_user_id, pid_str)
                recipient_map.setdefault(client_email, {
                    "approver_id": client_doc.contact_user_id,
                    "email": client_email,
                    "client_id": proj.client_id,
                })
            elif client_email and not client_doc.contact_user_id:
                logger.warning("client_review client %s has contact_email but no contact_user_id — can't tokenise", client_doc.id)

        cph_docs = await ClientProjectHead.find({
            "client_id": proj.client_id,
            "organisation_id": organisation_id,
            "deleted_on": None,
            "status": "active",
        }).to_list()
        logger.info("client_review cph_docs=%d client_id=%s project_id=%s", len(cph_docs), proj.client_id, pid_str)
        for cph in cph_docs:
            if not cph.email:
                logger.warning("client_review skipping cph id=%s: no email", cph.id)
                continue
            if not cph.iam_user_id:
                logger.warning("client_review skipping cph id=%s: no iam_user_id", cph.id)
                continue
            logger.info("client_review cph iam_user_id=%s project_id=%s", cph.iam_user_id, pid_str)
            recipient_map.setdefault(cph.email, {"approver_id": cph.iam_user_id, "email": cph.email, "client_id": proj.client_id})

    logger.info("client_review recipients=%d org=%s", len(recipient_map), organisation_id)
    if not recipient_map:
        logger.warning("client_review no recipients found seed_projects=%s", seed_project_ids)
        return

    now = utcnow()
    expires_at = now + timedelta(days=7)

    for recipient in recipient_map.values():
        em = recipient["email"]
        approver_id = recipient["approver_id"]

        # Expand to full project scope for this recipient — only client-approval
        # -required projects (seed_projects is already filtered)
        all_proj_ids: set[str] = {str(p.id) for p in seed_projects}
        ph_projects = await Project.find({
            "project_head_ids": approver_id,
            "organisation_id": organisation_id,
            "deleted_on": None,
            "client_approval_required": {"$ne": False},
        }).to_list()
        all_proj_ids.update(str(p.id) for p in ph_projects)
        if "client_id" in recipient:
            client_projects = await Project.find({
                "client_id": recipient["client_id"],
                "organisation_id": organisation_id,
                "deleted_on": None,
                "client_approval_required": {"$ne": False},
            }).to_list()
            all_proj_ids.update(str(p.id) for p in client_projects)
        logger.info("client_review approver=%s visible_projects=%d", approver_id, len(all_proj_ids))

        # All pending L1-approved TPA records for their projects
        from beanie import PydanticObjectId as _DispOID
        from bson import ObjectId as _DispBson
        pending_proj_oids = [_DispOID(pid) for pid in all_proj_ids if _DispBson.is_valid(pid)]
        pending_tpa = await TimesheetProjectApproval.find({
            "project_id": {"$in": pending_proj_oids},
            "status": ProjectApprovalStatusEnum.L1_APPROVED.value,
            "deleted_on": None,
        }).to_list()
        # Schedule cron: keep only timesheets in the firing timezone group
        if restrict_ts_ids is not None:
            pending_tpa = [t for t in pending_tpa if str(t.weekly_timesheet_id) in restrict_ts_ids]
        logger.info("client_review approver=%s pending_tpa=%d", approver_id, len(pending_tpa))

        if not pending_tpa:
            logger.info("client_review no pending TPA for approver=%s skipping", approver_id)
            continue

        if count_trigger and len(pending_tpa) < pending_threshold:
            logger.info("client_review count_trigger pending=%d < threshold=%d approver=%s skipping",
                        len(pending_tpa), pending_threshold, approver_id)
            continue

        # tpa.weekly_timesheet_id is PydanticObjectId — use directly in _id queries
        tpa_ts_oids = list({tpa.weekly_timesheet_id for tpa in pending_tpa})
        all_ts = await WeeklyTimesheet.find({
            "_id": {"$in": tpa_ts_oids},
            "organisation_id": organisation_id,
            "deleted_on": None,
        }).to_list()
        if not all_ts:
            continue

        all_ts_oids = [ts.id for ts in all_ts]
        all_entries = await TimesheetEntry.find({
            "weekly_timesheet_id": {"$in": all_ts_oids},
            "project_id": {"$in": pending_proj_oids},
            "deleted_on": None,
        }).to_list()

        # e.project_id and e.task_id are PydanticObjectId — use directly
        entry_proj_oids = list({e.project_id for e in all_entries})
        entry_task_oids = list({e.task_id for e in all_entries})
        entry_projs = await Project.find({"_id": {"$in": entry_proj_oids}}).to_list() if entry_proj_oids else []
        entry_tasks = await Task.find({"_id": {"$in": entry_task_oids}}).to_list() if entry_task_oids else []
        proj_name_map = {str(p.id): p.name for p in entry_projs}
        task_name_map = {str(t.id): t.name for t in entry_tasks}

        emp_ids = list({ts.user_id for ts in all_ts})
        emp_name_map = await resolve_user_names(emp_ids, organisation_id)
        emp_code_map = await resolve_emp_codes(emp_ids, organisation_id)
        logger.info("client_review approver=%s employees=%d", approver_id, len(emp_ids))

        employees_data: list[dict] = []
        all_bulk_ts_ids: list[str] = []
        grand_total = 0.0

        for ts in sorted(all_ts, key=lambda x: (x.user_id, str(x.week_start_date))):
            ts_entries = [e for e in all_entries if e.weekly_timesheet_id == ts.id]
            if not ts_entries:
                continue

            proj_groups: dict[str, dict] = {}
            for e in ts_entries:
                pn = proj_name_map.get(str(e.project_id), str(e.project_id))
                tn = task_name_map.get(str(e.task_id), str(e.task_id))
                pg = proj_groups.setdefault(pn, {"project_name": pn, "tasks": {}, "total": 0.0})
                pg["tasks"][tn] = pg["tasks"].get(tn, 0.0) + e.hours
                pg["total"] += e.hours

            grand_total += sum(pg["total"] for pg in proj_groups.values())
            all_bulk_ts_ids.append(str(ts.id))

            ind_token = str(uuid4())
            await ClientApprovalToken(
                organisation_id=organisation_id,
                token=ind_token,
                timesheet_id=ts.id,
                project_ids=list({e.project_id for e in ts_entries}),
                approver_id=approver_id,
                approver_email=em,
                is_bulk=False,
                expires_at=expires_at,
                created_by="system",
                created_on=now,
            ).insert()
            logger.info("client_review ind_token created ts=%s approver=%s", ts.id, approver_id)

            employees_data.append({
                "employee_name": emp_name_map.get(ts.user_id, str(ts.user_id)),
                "emp_code": emp_code_map.get(ts.user_id),
                "approve_link": f"{cfg.FRONTEND_URL}/client-approval?token={ind_token}&timesheet_id={ts.id}&action=approve",
                "reject_link": f"{cfg.FRONTEND_URL}/client-approval?token={ind_token}&timesheet_id={ts.id}&action=reject",
                "projects": [
                    {
                        "project_name": pg["project_name"],
                        "tasks": [{"task_name": tn, "hours": round(h, 2)} for tn, h in pg["tasks"].items()],
                        "total": round(pg["total"], 2),
                    }
                    for pg in proj_groups.values()
                ],
            })

        if not employees_data:
            logger.info("client_review no employee data for approver=%s skipping", approver_id)
            continue

        bulk_token = str(uuid4())
        # timesheet_ids: list of str → Pydantic coerces to PydanticObjectId
        # project_ids: set of str → Pydantic coerces to list[PydanticObjectId]
        await ClientApprovalToken(
            organisation_id=organisation_id,
            token=bulk_token,
            timesheet_ids=all_bulk_ts_ids,
            project_ids=list(all_proj_ids),
            approver_id=approver_id,
            approver_email=em,
            is_bulk=True,
            expires_at=expires_at,
            created_by="system",
            created_on=now,
        ).insert()
        logger.info("client_review bulk_token created timesheets=%d approver=%s", len(all_bulk_ts_ids), approver_id)

        week_labels = sorted({
            f"{str(ts.week_start_date.date())} – {str(ts.week_end_date.date())}"
            for ts in all_ts
        })
        week_range = week_labels[0] if len(week_labels) == 1 else f"{len(week_labels)} pending weeks"

        await publish_client_review_request_email(
            to=em,
            week_range=week_range,
            employee_rows=_render_employee_table_rows(employees_data),
            grand_total_row=_render_grand_total_row(round(grand_total, 2)),
            grand_total_hours=round(grand_total, 2),
            approve_all_link=f"{cfg.FRONTEND_URL}/client-approval?token={bulk_token}&action=approve_all",
            reject_all_link=f"{cfg.FRONTEND_URL}/client-approval?token={bulk_token}&action=reject_all",
            timesheet_count=len(all_bulk_ts_ids),
            idempotency_suffix=f"{idempotency_prefix}:{approver_id}",
            tenant_id=str(organisation_id),
        )
        logger.info("client_review email queued to=%s approver=%s employees=%d timesheets=%d",
                    _mask_email(em), approver_id, len(employees_data), len(all_bulk_ts_ids))


async def notify_l1_approved_to_client(
    doc: WeeklyTimesheet,
    approved_project_ids: list[str],
    organisation_id: str,
) -> None:
    """After L1 approval, send consolidated pending-review email to relevant
    client/project-heads. Respects org notification settings."""
    try:
        from src.settings.service import get_effective_settings

        logger.info("client_review_notify triggered timesheet_id=%s approved_projects=%s", doc.id, approved_project_ids)

        if not approved_project_ids:
            logger.warning("client_review_notify skipped: no approved_project_ids")
            return

        org_settings = await get_effective_settings(organisation_id)
        count_trigger = bool(org_settings and org_settings.client_notify_on_pending_count_enabled)
        pending_threshold = org_settings.client_notify_pending_count if org_settings else 5

        if not count_trigger:
            logger.info("client_review_notify skipped: count trigger not enabled, cron handles schedule timesheet_id=%s", doc.id)
            return

        await _dispatch_client_review_emails(
            organisation_id,
            approved_project_ids,
            count_trigger=count_trigger,
            pending_threshold=pending_threshold,
            idempotency_prefix=str(doc.id),
        )

    except Exception:
        logger.exception("notify_l1_approved_to_client failed timesheet_id=%s", doc.id)


async def notify_client_approval_schedule_reminder(
    organisation_id: str,
    period_key: str = "",
    restrict_ts_ids: set[str] | None = None,
) -> None:
    """Send pending-review emails for L1-approved timesheets in the org.
    Called by the scheduled cron — ignores count thresholds.

    ``restrict_ts_ids`` limits to timesheets whose employees are in a Business
    Unit currently at 18:30 local time (the cron groups by BU timezone).
    ``period_key`` (e.g. "<tz>:YYYY-MM-DD") is woven into the email idempotency
    key so the reminder recurs (one send per recipient per timezone per day).
    """
    try:
        pending_tpa = await TimesheetProjectApproval.find({
            "organisation_id": organisation_id,
            "status": ProjectApprovalStatusEnum.L1_APPROVED.value,
            "deleted_on": None,
        }).to_list()

        if restrict_ts_ids is not None:
            pending_tpa = [t for t in pending_tpa if str(t.weekly_timesheet_id) in restrict_ts_ids]

        if not pending_tpa:
            logger.info("client_approval_schedule org=%s no pending TPA records skipping", organisation_id)
            return

        seed_project_ids = list({str(tpa.project_id) for tpa in pending_tpa})
        logger.info("client_approval_schedule org=%s seed_projects=%d period=%s", organisation_id, len(seed_project_ids), period_key)

        suffix = f"schedule:{organisation_id}:{period_key}" if period_key else f"schedule:{organisation_id}"
        await _dispatch_client_review_emails(
            organisation_id,
            seed_project_ids,
            count_trigger=False,   # schedule trigger always sends regardless of count
            idempotency_prefix=suffix,
            restrict_ts_ids=restrict_ts_ids,
        )
    except Exception:
        logger.exception("notify_client_approval_schedule_reminder failed org=%s", organisation_id)


async def notify_employee_fill_reminder(
    organisation_id: str,
    user_ids: list,
    week_start: str,
    week_end: str,
    period_key: str,
) -> None:
    """Email a set of employees reminding them to fill/submit their timesheet.

    Called by the employee-reminder cron, scoped to a Business-Unit timezone
    group. ``period_key`` (e.g. "<tz>:YYYY-MM-DD") date-stamps the idempotency
    key so reminders recur (one send per employee per period).

    Deliberately not subject to the employment-type exclusion: everyone who fills a
    timesheet needs reminding to fill it, whatever their employment type. The
    exclusion covers the approval traffic — submitted, approved, rejected — not the
    prompt to do the work.
    """
    try:
        from src.config import settings as cfg

        if not user_ids:
            return

        email_map = await resolve_user_emails(user_ids, organisation_id)
        name_map = await resolve_user_names(user_ids, organisation_id)
        if not email_map:
            logger.info("emp_reminder org=%s no emails resolved", organisation_id)
            return

        fill_link = f"{cfg.FRONTEND_URL}/timesheet/my-timesheet"
        logger.info("emp_reminder org=%s recipients=%d period=%s", organisation_id, len(email_map), period_key)

        for uid, email in email_map.items():
            await publish_employee_timesheet_reminder_email(
                to=email,
                employee_name=name_map.get(uid, ""),
                week_start=week_start,
                week_end=week_end,
                fill_link=fill_link,
                idempotency_suffix=period_key,
                tenant_id=str(organisation_id),
            )
    except Exception:
        logger.exception("notify_employee_fill_reminder failed org=%s", organisation_id)
