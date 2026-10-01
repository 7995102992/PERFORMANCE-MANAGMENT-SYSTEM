import re
from datetime import datetime
from html import escape as _html_escape
from pathlib import Path
from urllib.parse import urlencode

from src.email.config import email_settings

_TEMPLATE_DIR = Path(__file__).parent


def _build_raise_ticket_link() -> str:
    """Deep link to the Raise Ticket sheet, pre-filled with the support
    Category + Subtype. Consumed by the {{raise_ticket_link}} footer in every
    template. `&` is HTML-escaped downstream by render_template, which is the
    correct encoding inside an href attribute."""
    query = urlencode(
        {
            "raise": "1",
            "category": email_settings.SUPPORT_CATEGORY_ID,
            "subtype": email_settings.SUPPORT_SUBTYPE_ID,
        }
    )
    base = email_settings.FRONTEND_BASE_URL.rstrip("/")
    return f"{base}/service-request/my-requests/list?{query}"

_SUBJECT_MAP = {
    "activation_v1": "Activate Your Account & Set Your Password",
    "onboarding_invite_v1": "Complete your onboarding at {{org_name}}",
    "onboarding_approval_ack_v1": "Acknowledgement of your {{stage_label}} for {{candidate_name}}",
    "onboarding_approval_notice_v1": "{{stage_label}} completed for {{candidate_name}}",
    "onboarding_stage_cleared_v1": "Update on your onboarding — {{stage_label}} completed",
    "onboarding_manager_approved_v1": "Candidate approved by manager — {{candidate_name}} ({{onboarding_code}})",
    "onboarding_manager_rejected_v1": "Candidate rejected by manager — {{candidate_name}} ({{onboarding_code}})",
    "onboarding_clearances_complete_v1": "Your onboarding clearances are complete — {{candidate_name}} ({{onboarding_code}})",
    "password_reset_v1": "Reset Your Password",
    "email_change_v1": "Confirm Your New Email",
    "timesheet_submitted_v1": "Timesheet Submitted for Review",
    "timesheet_resubmitted_v1": "Timesheet Resubmitted for Review",
    "timesheet_approved_v1": "Your Timesheet Has Been Approved",
    "timesheet_rejected_v1": "Your Timesheet Has Been Rejected",
    "srm_request_submitted_v1": "Service Request Submitted",
    "srm_approval_pending_v1": "Service Request Awaiting Your Approval",
    "srm_request_approved_v1": "Service Request Approved",
    "srm_request_rejected_v1": "Service Request Rejected",
    "srm_executor_assigned_v1": "Service Request Assigned to You",
    "srm_executor_assigned_requester_v1": "Executor Assigned to Your Request",
    "srm_request_escalated_v1": "Service Request Escalated to You",
    "srm_request_escalated_requester_v1": "Your Service Request Has Been Escalated",
    "srm_request_resolved_v1": "Service Request Resolved",
    "srm_request_closed_v1": "Service Request Closed",
    "srm_comment_added_v1": "New Comment on Service Request",
    "srm_sla_breached_v1": "SLA Breach Alert",
    "srm_department_intimation_v1": "New Service Request in Your Department",
    "exit_request_raised_v1": "Exit Request Raised",
    "exit_manager_approved_v1": "Exit Request Approved",
    "exit_manager_rejected_v1": "Exit Request Rejected",
    "exit_clearances_initiated_v1": "Exit Clearances Initiated",
    "exit_clearances_assigned_v1": "Exit Clearance Tasks Assigned",
    "exit_completed_v1": "Exit Process Completed",
    "leave_request_submitted_v1": "Leave Request Submitted",
    "leave_approval_pending_v1": "Leave Request Awaiting Your Approval",
    "leave_request_approved_v1": "Your Leave Request Has Been Approved",
    "leave_request_rejected_v1": "Your Leave Request Has Been Rejected",
    "leave_request_cancelled_v1": "Leave Request Cancelled",
    "leave_request_escalated_hr_v1": "Action Needed: Leave Request Pending {{days_pending}} Day(s)",
    "employee_timesheet_reminder_v1": "Reminder: fill your timesheet for {{week_start}} – {{week_end}}",
    "payslip_pin_generated_v1": "Your new PIN for viewing payslips",
    "holiday_plan_created_v1": "Holiday Plan Created Successfully",
    "holiday_plan_updated_v1": "Holiday Plan Updated Successfully",
    "holiday_plan_employee_added_v1": "You Have Been Added to a Holiday Plan",
    "holiday_reminder_v1": "Upcoming Holiday Reminder",
    "work_calendar_created_v1": "Work Calendar Created Successfully",
    "work_calendar_updated_v1": "Work Calendar Updated Successfully",
    "work_calendar_employee_added_v1": "You Have Been Added to a Work Calendar",
    "shift_employee_added_v1": "Shift Assigned to You",
    "budget_threshold_alert_v1": "Budget Alert: {{project_name}} has reached {{budget_percent}}% of budget",
    "client_review_request_v1": "Timesheet Approval Required — {{week_range}} ({{timesheet_count}} pending)",
}


_COMMON_DEFAULTS = {
    "company_address": "",
}


def render_template(template_id: str, template_data: dict) -> str:
    path = _TEMPLATE_DIR / f"{template_id}.html"
    if not path.exists():
        raise FileNotFoundError(f"Email template not found: {template_id}")
    html = path.read_text(encoding="utf-8")
    # `raise_ticket_link` is a common default so it lands in every template's
    # footer without each event producer having to pass it. A producer may
    # still override it via template_data.
    merged = {
        **_COMMON_DEFAULTS,
        "raise_ticket_link": _build_raise_ticket_link(),
        "year": str(datetime.now().year),
        **template_data,
    }
    for key, value in merged.items():
        # HTML-escape substituted values to prevent template/HTML injection from
        # upstream event data. (Escaped "&" in URLs is still valid HTML.)
        html = html.replace(f"{{{{{key}}}}}", _html_escape(str(value)))
    return html


def get_subject(template_id: str, template_data: dict | None = None) -> str:
    subject = _SUBJECT_MAP.get(template_id, template_id.replace("_", " ").title())
    if template_data:
        for key, value in template_data.items():
            subject = subject.replace(f"{{{{{key}}}}}", str(value))
    return subject
