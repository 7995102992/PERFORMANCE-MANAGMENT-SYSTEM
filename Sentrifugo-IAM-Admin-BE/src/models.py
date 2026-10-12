"""Shared models: enums, base classes, and Beanie ODM documents."""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal, Optional, Union
from uuid import uuid4

from beanie import Document, PydanticObjectId
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ASCENDING, IndexModel


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class StatusEnum(StrEnum):
    """Account-level login status. Deliberately just two states.

    The employee LIFECYCLE (serving notice, exited, absconded, terminated, ...)
    is not an account concern — it lives on employee.employment_status, which
    points at the EMPLOYMENT_STATUSES master data. Collapsing the account column
    to active/inactive keeps the two from drifting apart:
      * serving notice  -> still working, full access  -> ACTIVE
      * exited          -> cannot log in               -> INACTIVE
    """
    ACTIVE = "active"
    INACTIVE = "inactive"


# Statuses that can authenticate.
ACCESS_STATUSES = (StatusEnum.ACTIVE,)


def is_activation_pending(doc: dict) -> bool:
    """True when a user account has never completed activation.

    Single source of truth for the "pending activation" state, used to decide
    whether the Resend-Activation action applies. A user is pending iff it is
    not deleted, still INACTIVE, and has never been activated (``activated_at``
    is None). A user that was activated and later deactivated has a non-null
    ``activated_at`` and is therefore NOT pending.
    """
    return (
        doc.get("deleted_on") is None
        and doc.get("status") == StatusEnum.INACTIVE
        and doc.get("activated_at") is None
    )


class ModuleEnum(StrEnum):
    """Product modules a policy can grant permissions on."""
    CORE_HR = "core_hr"
    ATTENDANCE_MANAGEMENT = "attendance_management"
    LEAVE_MANAGEMENT = "leave_management"
    PAYROLL = "payroll"
    PERFORMANCE_MANAGEMENT = "performance_management"
    RECRUITMENT = "recruitment"
    TRAINING_AND_DEVELOPMENT = "training_and_development"
    ASSET_MANAGEMENT = "asset_management"
    SERVICE_REQUEST = "service_request"
    TIMESHEET_MANAGEMENT = "timesheet_management"
    EXPENSE_MANAGEMENT = "expense_management"
    REPORTS_AND_ANALYTICS = "reports_and_analytics"


MODULE_LABELS: dict[ModuleEnum, str] = {
    ModuleEnum.CORE_HR: "Core HR",
    ModuleEnum.ATTENDANCE_MANAGEMENT: "Attendance Management",
    ModuleEnum.LEAVE_MANAGEMENT: "Leave & Attendance",
    ModuleEnum.PAYROLL: "Payroll",
    ModuleEnum.PERFORMANCE_MANAGEMENT: "Performance Management",
    ModuleEnum.RECRUITMENT: "Recruitment",
    ModuleEnum.TRAINING_AND_DEVELOPMENT: "Training & Development",
    ModuleEnum.ASSET_MANAGEMENT: "Asset Management",
    ModuleEnum.SERVICE_REQUEST: "Service Request",
    ModuleEnum.TIMESHEET_MANAGEMENT: "Timesheet Management",
    ModuleEnum.EXPENSE_MANAGEMENT: "Expense Management",
    ModuleEnum.REPORTS_AND_ANALYTICS: "Reports & Analytics",
}


# ---------------------------------------------------------------------------
# Lookup enums (paired with seeded Beanie collections below). Codes are
# Python-side constants for type safety; the collections give the frontend
# a CRUD-able catalog with labels/descriptions/flags.
# ---------------------------------------------------------------------------
class AclRoleEnum(StrEnum):
    """Top-level ACL roles carried on module_acl_permissions rows."""
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"


class PermissionCodeEnum(StrEnum):
    """All permission codes enforced by require_permission().

    Codes are scoped to modules via MODULE_PERMISSIONS below: a code only
    grants meaning when paired with a module that lists it. Generic codes
    (create/read/update/delete/export) are reused across modules; feature
    codes (holiday_plan, ...) belong to a single module.
    """
    # Generic CRUD-style — reused across most modules.
    CREATE = "create"
    READ = "read"
    UPDATE = "update"
    DELETE = "delete"
    EXPORT = "export"
    CREATE_RESOURCE = "create_resource"

    # Timesheet Management feature permissions.
    MY_TIMESHEET = "my_timesheet"
    MANAGE_TIMESHEET = "manage_timesheet"
    CLIENT_TIMESHEET = "client_timesheet"
    MANAGE_CLIENTS = "manage_clients"
    MANAGE_PROJECTS = "manage_projects"
    MANAGE_SETTINGS = "manage_settings"
    VIEW_REPORTS = "view_reports"
    # Org-wide read-only oversight: holders see every client, project, task,
    # resource and employee timesheet, bypassing the department scoping and the
    # "only your own projects" rule that constrains manage_projects /
    # manage_clients. Read endpoints only — every write endpoint still enforces
    # its own permission and returns 403. For auditors / finance / delivery leads
    # who need the read half of org-admin oversight without any write.
    VIEW_ALL = "view_all"

    # Core HR feature permissions.
    # Employee records (the HR > Employees screen) and the org graph behind the
    # Organogram. Split out of the blanket CREATE_RESOURCE grant, which still
    # covers the rest of Core HR master data (business units, departments,
    # designations, bands, paygrades, org documents, custom fields). Unlike the
    # other codes here this one is LEVELLED — see require_permission_level:
    # viewer reads, editor writes, admin deletes.
    RESOURCE_MANAGEMENT = "resource_management"
    APPLY_EXIT_REQUEST = "apply_exit_request"
    APPROVE_EXIT_REQUEST = "approve_exit_request"
    MONITOR_EXIT_REQUEST = "monitor_exit_request"
    IT_CLEARANCES = "it_clearances"
    ADMIN_CLEARANCES = "admin_clearances"
    FINAL_SETTLEMENT = "final_settlement"

    # The employee's own payslip — the upload-driven payslip register's only grant.
    MY_PAYROLL = "my_payroll"
    APPLY_ONBOARDING = "apply_onboarding"
    MANAGE_ONBOARDING = "manage_onboarding"
    ONBOARDING_MANAGER_APPROVAL = "onboarding_manager_approval"
    ONBOARDING_IT_CLEARANCE = "onboarding_it_clearance"
    ONBOARDING_ADMIN_CLEARANCE = "onboarding_admin_clearance"
    ONBOARDING_FINANCE_CLEARANCE = "onboarding_finance_clearance"
    # Announcements — manage_ is the admin CRUD/publish surface, view_ is the
    # read-only employee dashboard feed.
    MANAGE_ANNOUNCEMENTS = "manage_announcements"
    VIEW_ANNOUNCEMENTS = "view_announcements"

    # Leave Management feature permissions.
    HOLIDAY_PLAN = "holiday_plan"
    LEAVE_PLAN = "leave_plan"
    WORK_CALENDAR = "work_calendar"
    LEAVE_CONFIGURATION = "leave_configuration"
    LEAVE_TYPES = "leave_types"
    LEAVE_REQUEST = "leave_request"
    MANAGE_LEAVE_REQUEST = "manage_leave_request"
    LEAVE_BALANCE = "leave_balance"
    # Dedicated HR capability. Enforced by the Leave Management service: holders
    # may act on / view leave requests under plans that enable
    # allow_hr_to_act / allow_hr_to_view.
    APPROVE_AS_HR = "approve_as_hr"
    # The HR employee-leave report: who took what leave over a date range, with
    # the approval that closed each request, plus its Excel download. Reads
    # across every employee in the organisation, so it is granted deliberately
    # rather than riding along with the per-plan HR rights above.
    VIEW_EMPLOYEE_REPORTS = "view_employee_reports"

    # Service Request feature permissions.
    RAISE_REQUEST = "raise_request"
    EXECUTE_REQUEST = "execute_request"
    APPROVE_REQUEST = "approve_request"
    MANAGE_REQUEST = "manage_request"
    VIEW_ALL_REQUESTS = "view_all_requests"
    MANAGE_CATALOG = "manage_catalog"
    MANAGE_WORKFLOWS = "manage_workflows"
    # Service Request analytics dashboards — each gates one role dashboard in
    # the SRM service. Role-based (not persona-based) and enforced under the
    # REPORTS_AND_ANALYTICS module: the SRM analytics gate reads
    # has_permission("reports_and_analytics", <code>). See MODULE_PERMISSIONS.
    VIEW_MY_ANALYTICS = "view_my_analytics"
    VIEW_EXECUTOR_ANALYTICS = "view_executor_analytics"
    VIEW_APPROVER_ANALYTICS = "view_approver_analytics"
    VIEW_TEAM_ANALYTICS = "view_team_analytics"
    VIEW_ORG_ANALYTICS = "view_org_analytics"

    # Reports & Analytics feature permissions.
    REPORTS = "reports"
    EMPLOYEE_LEAVE_ANALYTICS = "employee_leave_analytics"
    MANAGER_LEAVE_ANALYTICS = "manager_leave_analytics"
    HR_LEAVE_ANALYTICS = "hr_leave_analytics"
    MD_LEAVE_ANALYTICS = "md_leave_analytics"
    CFO_LEAVE_ANALYTICS = "cfo_leave_analytics"
    EMPLOYEE_TIMESHEET_ANALYTICS = "employee_timesheet_analytics"
    MANAGER_TIMESHEET_ANALYTICS = "manager_timesheet_analytics"
    HR_TIMESHEET_ANALYTICS = "hr_timesheet_analytics"
    MD_TIMESHEET_ANALYTICS = "md_timesheet_analytics"
    CFO_TIMESHEET_ANALYTICS = "cfo_timesheet_analytics"
    EMPLOYEE_EXIT_ANALYTICS = "employee_exit_analytics"
    MANAGER_EXIT_ANALYTICS = "manager_exit_analytics"
    HR_EXIT_ANALYTICS = "hr_exit_analytics"
    MD_EXIT_ANALYTICS = "md_exit_analytics"
    CFO_EXIT_ANALYTICS = "cfo_exit_analytics"
    WORKFORCE_ANALYTICS = "workforce_analytics"

    # Attendance Management feature permissions.
    MY_ATTENDANCE = "my_attendance"
    MANAGER_ATTENDANCE = "manager_attendance"
    HR_ATTENDANCE = "hr_attendance"

    # PMS / Performance Management permissions
    MY_GOALS = "my_goals"
    PROGRESS = "progress"
    SELF_APPRAISAL = "self_appraisal"
    MY_RATING = "my_rating"
    APPRAISAL_HISTORY = "appraisal_history"

    TEAM_GOALS = "team_goals"
    TEAM_PROGRESS = "team_progress"
    MID_YEAR_REVIEW = "mid_year_review"
    TEAM_APPRAISAL = "team_appraisal"

    GOAL_APPROVAL = "goal_approval"
    TARGET_REVISION = "target_revision"
    APPRAISAL_REVIEW = "appraisal_review"

    PMS_CYCLE = "pms_cycle"
    GOAL_TEMPLATE = "goal_template"
    KRA_MASTER = "kra_master"
    KPI_MASTER = "kpi_master"
    COMPETENCY_MASTER = "competency_master"
    RATING_SCALE = "rating_scale"

    CYCLE_CLOSURE = "cycle_closure"
    RATING_NORMALIZATION = "rating_normalization"


_GENERIC_CRUD: set[PermissionCodeEnum] = {
    PermissionCodeEnum.CREATE,
    PermissionCodeEnum.READ,
    PermissionCodeEnum.UPDATE,
    PermissionCodeEnum.DELETE,
    PermissionCodeEnum.EXPORT,
}


MODULE_PERMISSIONS: dict[ModuleEnum, set[PermissionCodeEnum]] = {
    ModuleEnum.CORE_HR: {
        PermissionCodeEnum.CREATE_RESOURCE,
        PermissionCodeEnum.RESOURCE_MANAGEMENT,
        PermissionCodeEnum.APPLY_EXIT_REQUEST,
        PermissionCodeEnum.APPROVE_EXIT_REQUEST,
        PermissionCodeEnum.MONITOR_EXIT_REQUEST,
        PermissionCodeEnum.IT_CLEARANCES,
        PermissionCodeEnum.ADMIN_CLEARANCES,
        PermissionCodeEnum.FINAL_SETTLEMENT,
        PermissionCodeEnum.MY_PAYROLL,
        PermissionCodeEnum.APPLY_ONBOARDING,
        PermissionCodeEnum.MANAGE_ONBOARDING,
        PermissionCodeEnum.ONBOARDING_MANAGER_APPROVAL,
        PermissionCodeEnum.ONBOARDING_IT_CLEARANCE,
        PermissionCodeEnum.ONBOARDING_ADMIN_CLEARANCE,
        PermissionCodeEnum.ONBOARDING_FINANCE_CLEARANCE,
        PermissionCodeEnum.MANAGE_ANNOUNCEMENTS,
        PermissionCodeEnum.VIEW_ANNOUNCEMENTS,
    },
    ModuleEnum.LEAVE_MANAGEMENT: {
        PermissionCodeEnum.HOLIDAY_PLAN,
        PermissionCodeEnum.LEAVE_PLAN,
        PermissionCodeEnum.WORK_CALENDAR,
        PermissionCodeEnum.LEAVE_CONFIGURATION,
        PermissionCodeEnum.LEAVE_TYPES,
        PermissionCodeEnum.LEAVE_REQUEST,
        PermissionCodeEnum.MANAGE_LEAVE_REQUEST,
        PermissionCodeEnum.LEAVE_BALANCE,
        PermissionCodeEnum.APPROVE_AS_HR,
        PermissionCodeEnum.VIEW_EMPLOYEE_REPORTS,
        PermissionCodeEnum.MY_ATTENDANCE,
        PermissionCodeEnum.MANAGER_ATTENDANCE,
        PermissionCodeEnum.HR_ATTENDANCE,
    },
    ModuleEnum.PAYROLL: {
        # The upload-driven payslip register's only grant: reading your own payslip.
        PermissionCodeEnum.MY_PAYROLL,
    },
    # sagarcements - for pms
    ModuleEnum.PERFORMANCE_MANAGEMENT: {
        PermissionCodeEnum.CREATE_RESOURCE,

        PermissionCodeEnum.MY_GOALS,
        PermissionCodeEnum.PROGRESS,
        PermissionCodeEnum.SELF_APPRAISAL,
        PermissionCodeEnum.MY_RATING,
        PermissionCodeEnum.APPRAISAL_HISTORY,

        PermissionCodeEnum.TEAM_GOALS,
        PermissionCodeEnum.TEAM_PROGRESS,
        PermissionCodeEnum.MID_YEAR_REVIEW,
        PermissionCodeEnum.TEAM_APPRAISAL,

        PermissionCodeEnum.GOAL_APPROVAL,
        PermissionCodeEnum.TARGET_REVISION,
        PermissionCodeEnum.APPRAISAL_REVIEW,

        PermissionCodeEnum.PMS_CYCLE,
        PermissionCodeEnum.GOAL_TEMPLATE,
        PermissionCodeEnum.KRA_MASTER,
        PermissionCodeEnum.KPI_MASTER,
        PermissionCodeEnum.COMPETENCY_MASTER,
        PermissionCodeEnum.RATING_SCALE,

        PermissionCodeEnum.CYCLE_CLOSURE,
        PermissionCodeEnum.RATING_NORMALIZATION,
    },




    ModuleEnum.RECRUITMENT: {PermissionCodeEnum.CREATE_RESOURCE},
    ModuleEnum.TRAINING_AND_DEVELOPMENT: {PermissionCodeEnum.CREATE_RESOURCE},
    ModuleEnum.ASSET_MANAGEMENT: {PermissionCodeEnum.CREATE_RESOURCE},
    ModuleEnum.SERVICE_REQUEST: {
        PermissionCodeEnum.RAISE_REQUEST,
        PermissionCodeEnum.EXECUTE_REQUEST,
        PermissionCodeEnum.APPROVE_REQUEST,
        PermissionCodeEnum.MANAGE_REQUEST,
        PermissionCodeEnum.VIEW_ALL_REQUESTS,
        PermissionCodeEnum.MANAGE_CATALOG,
        PermissionCodeEnum.MANAGE_WORKFLOWS,
    },
    ModuleEnum.TIMESHEET_MANAGEMENT: {
        PermissionCodeEnum.MY_TIMESHEET,
        PermissionCodeEnum.MANAGE_TIMESHEET,
        PermissionCodeEnum.CLIENT_TIMESHEET,
        PermissionCodeEnum.MANAGE_CLIENTS,
        PermissionCodeEnum.MANAGE_PROJECTS,
        PermissionCodeEnum.MANAGE_SETTINGS,
        PermissionCodeEnum.VIEW_REPORTS,
        PermissionCodeEnum.VIEW_ALL,
    },
    ModuleEnum.EXPENSE_MANAGEMENT: {PermissionCodeEnum.CREATE_RESOURCE},
    ModuleEnum.REPORTS_AND_ANALYTICS: {
        PermissionCodeEnum.REPORTS,
        # Service Request analytics — role-based dashboards enforced by the SRM
        # service (src/analytics/scoping.py). Kept role-based (my/executor/
        # approver/team/org) rather than the persona set because SR roles are
        # relational: a user is executor/approver/manager per ticket, not by
        # fixed persona.
        PermissionCodeEnum.VIEW_MY_ANALYTICS,
        PermissionCodeEnum.VIEW_EXECUTOR_ANALYTICS,
        PermissionCodeEnum.VIEW_APPROVER_ANALYTICS,
        PermissionCodeEnum.VIEW_TEAM_ANALYTICS,
        PermissionCodeEnum.VIEW_ORG_ANALYTICS,
        PermissionCodeEnum.EMPLOYEE_LEAVE_ANALYTICS,
        PermissionCodeEnum.MANAGER_LEAVE_ANALYTICS,
        PermissionCodeEnum.HR_LEAVE_ANALYTICS,
        PermissionCodeEnum.MD_LEAVE_ANALYTICS,
        PermissionCodeEnum.CFO_LEAVE_ANALYTICS,
        PermissionCodeEnum.EMPLOYEE_TIMESHEET_ANALYTICS,
        PermissionCodeEnum.MANAGER_TIMESHEET_ANALYTICS,
        PermissionCodeEnum.HR_TIMESHEET_ANALYTICS,
        PermissionCodeEnum.MD_TIMESHEET_ANALYTICS,
        PermissionCodeEnum.CFO_TIMESHEET_ANALYTICS,
        PermissionCodeEnum.EMPLOYEE_EXIT_ANALYTICS,
        PermissionCodeEnum.MANAGER_EXIT_ANALYTICS,
        PermissionCodeEnum.HR_EXIT_ANALYTICS,
        PermissionCodeEnum.MD_EXIT_ANALYTICS,
        PermissionCodeEnum.CFO_EXIT_ANALYTICS,
        PermissionCodeEnum.WORKFORCE_ANALYTICS,
    },
}


# Per-(module, code) display labels. Falls back to the code's title-cased
# value when not listed here.
PERMISSION_LABELS: dict[tuple[ModuleEnum, PermissionCodeEnum], str] = {
    (ModuleEnum.CORE_HR, PermissionCodeEnum.CREATE_RESOURCE): "Create Resource",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.RESOURCE_MANAGEMENT): "Resource Management",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.APPLY_EXIT_REQUEST): "Apply Exit Request",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.APPROVE_EXIT_REQUEST): "Approve Exit Request",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.MONITOR_EXIT_REQUEST): "Monitor Exit Request",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.IT_CLEARANCES): "IT Clearances",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.ADMIN_CLEARANCES): "Admin Clearances",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.FINAL_SETTLEMENT): "Final Settlement",
    (ModuleEnum.PAYROLL, PermissionCodeEnum.MY_PAYROLL): "My Payslip",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.MY_PAYROLL): "My Payroll",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.APPLY_ONBOARDING): "Apply Onboarding",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.MANAGE_ONBOARDING): "Manage Onboarding",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.ONBOARDING_MANAGER_APPROVAL): "Onboarding Manager Approval",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.ONBOARDING_IT_CLEARANCE): "Onboarding IT Clearance",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.ONBOARDING_ADMIN_CLEARANCE): "Onboarding Admin Clearance",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.ONBOARDING_FINANCE_CLEARANCE): "Onboarding Finance Clearance",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.MANAGE_ANNOUNCEMENTS): "Manage Announcements",
    (ModuleEnum.CORE_HR, PermissionCodeEnum.VIEW_ANNOUNCEMENTS): "View Announcements",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.MY_TIMESHEET): "My Timesheet",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.MANAGE_TIMESHEET): "Manage Timesheet",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.CLIENT_TIMESHEET): "Client Timesheet",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.MANAGE_CLIENTS): "Manage Clients",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.MANAGE_PROJECTS): "Manage Projects",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.MANAGE_SETTINGS): "Manage Settings",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.VIEW_REPORTS): "View Reports",
    (ModuleEnum.TIMESHEET_MANAGEMENT, PermissionCodeEnum.VIEW_ALL): "View all timesheet data",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.HOLIDAY_PLAN): "Holiday Plan",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.LEAVE_PLAN): "Leave Plan",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.WORK_CALENDAR): "Work Calendar",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.LEAVE_CONFIGURATION): "Leave Configuration",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.LEAVE_TYPES): "Leave Types",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.LEAVE_REQUEST): "Leave Request",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.MANAGE_LEAVE_REQUEST): "Manage Leave Request",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.LEAVE_BALANCE): "Leave Balance",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.APPROVE_AS_HR): "Approve / View as HR",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.VIEW_EMPLOYEE_REPORTS): "View Employee Reports",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.MY_ATTENDANCE): "My Attendance",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.MANAGER_ATTENDANCE): "Manager Attendance",
    (ModuleEnum.LEAVE_MANAGEMENT, PermissionCodeEnum.HR_ATTENDANCE): "HR Attendance",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.RAISE_REQUEST): "Raise Request",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.EXECUTE_REQUEST): "Execute Request",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.APPROVE_REQUEST): "Approve Request",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.MANAGE_REQUEST): "Manage Request",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.VIEW_ALL_REQUESTS): "View All Requests",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.MANAGE_CATALOG): "Manage Catalog",
    (ModuleEnum.SERVICE_REQUEST, PermissionCodeEnum.MANAGE_WORKFLOWS): "Manage Workflows",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.REPORTS): "Reports",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.VIEW_MY_ANALYTICS): "SR — View My Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.VIEW_EXECUTOR_ANALYTICS): "SR — View Executor Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.VIEW_APPROVER_ANALYTICS): "SR — View Approver Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.VIEW_TEAM_ANALYTICS): "SR — View Team Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.VIEW_ORG_ANALYTICS): "SR — View Organisation Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.EMPLOYEE_LEAVE_ANALYTICS): "Employee Leave Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.MANAGER_LEAVE_ANALYTICS): "Manager Leave Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.HR_LEAVE_ANALYTICS): "HR Leave Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.MD_LEAVE_ANALYTICS): "MD Leave Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.CFO_LEAVE_ANALYTICS): "CFO Leave Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.EMPLOYEE_TIMESHEET_ANALYTICS): "Employee Timesheet Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.MANAGER_TIMESHEET_ANALYTICS): "Manager Timesheet Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.HR_TIMESHEET_ANALYTICS): "HR Timesheet Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.MD_TIMESHEET_ANALYTICS): "MD Timesheet Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.CFO_TIMESHEET_ANALYTICS): "CFO Timesheet Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.EMPLOYEE_EXIT_ANALYTICS): "Employee Exit Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.MANAGER_EXIT_ANALYTICS): "Manager Exit Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.HR_EXIT_ANALYTICS): "HR Exit Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.MD_EXIT_ANALYTICS): "MD Exit Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.CFO_EXIT_ANALYTICS): "CFO Exit Analytics",
    (ModuleEnum.REPORTS_AND_ANALYTICS, PermissionCodeEnum.WORKFORCE_ANALYTICS): "Workforce Analytics",
}


_GENERIC_LABELS: dict[PermissionCodeEnum, str] = {
    PermissionCodeEnum.CREATE: "Create",
    PermissionCodeEnum.READ: "Read",
    PermissionCodeEnum.UPDATE: "Update",
    PermissionCodeEnum.DELETE: "Delete",
    PermissionCodeEnum.EXPORT: "Export",
}


#: One sentence per grant, surfaced as a tooltip beside the label in the role
#: permission grid. A label says what a permission is called; these say what it
#: lets somebody do, and — where it matters more — what it does NOT.
PERMISSION_DESCRIPTIONS: dict[tuple[ModuleEnum, PermissionCodeEnum], str] = {}


def permission_label(module: ModuleEnum, code: PermissionCodeEnum) -> str:
    """Return the display label for a (module, code) pair."""
    return (
        PERMISSION_LABELS.get((module, code))
        or _GENERIC_LABELS.get(code)
        or code.value.replace("_", " ").title()
    )


def permission_description(module: ModuleEnum, code: PermissionCodeEnum) -> str | None:
    """Return the tooltip text for a (module, code) pair, or ``None``.

    ``None`` rather than a generated sentence: an invented description reads as
    authoritative and would be wrong, whereas a missing tooltip is simply a
    tooltip nobody wrote yet.
    """
    return PERMISSION_DESCRIPTIONS.get((module, code))


def permission_doc_id(module: ModuleEnum, code: PermissionCodeEnum) -> str:
    """Composite business key used as PermissionDocument.id."""
    return f"{module.value}:{code.value}"


# ---------------------------------------------------------------------------
# Pydantic base models
# ---------------------------------------------------------------------------
class CustomModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
    )


class OrgModule(CustomModel):
    """A module assigned to an organisation with activation status.

    Super admin controls which modules appear in the list.
    Org admin can toggle is_active to enable/disable within that set.
    Core HR is always forced to is_active=True.
    """
    code: ModuleEnum
    is_active: bool = True


class AuditMixin(CustomModel):
    """Audit trail fields applied to any entity.

    Tracks who created/modified/deleted a record and when.
    Supports soft deletion via deleted_by + deleted_on.
    """
    created_by: str | None = None
    created_on: datetime | None = None
    modified_by: str | None = None
    modified_on: datetime | None = None
    deleted_by: str | None = None
    deleted_on: datetime | None = None
    correlation_id: str | None = None


class MetadataMixin(AuditMixin):
    """Audit fields + lifecycle status enum (active/inactive).

    Used by modules where activation state is tracked via an enum.
    New org-setup modules prefer a boolean ``is_active`` and should
    inherit ``AuditMixin`` directly instead.
    """
    status: StatusEnum = StatusEnum.ACTIVE


# ---------------------------------------------------------------------------
# Global Asset document (centralized file storage metadata)
# ---------------------------------------------------------------------------
class AssetDocument(Document, AuditMixin):
    """Stores metadata for every file uploaded to DO Spaces.

    Any module needing a file (org docs, logos, employee photos, etc.)
    stores an ``asset_id`` reference instead of embedding file details.
    """
    file_name: str
    file_size: int          # bytes
    mime_type: str
    storage_key: str        # path in DO Spaces bucket
    file_url: str           # full public CDN URL
    folder: str             # logical group: "org-documents", "org-logos", "employee-photos"
    is_public: bool = True  # public CDN url vs presigned/proxied url at serve time
    # Tenant that owns this asset. Set for uploads made through the authenticated
    # /assets API so reads/deletes can be scoped to the caller's org (H2). Null
    # for legacy/system assets (accessed via their owning module, not directly).
    organisation_id: str | None = None
    is_active: bool = True

    class Settings:
        name = "assets"
        indexes = [
            IndexModel([("folder", ASCENDING)]),
            IndexModel([("storage_key", ASCENDING)], unique=True),
        ]


# ---------------------------------------------------------------------------
# Beanie ODM documents (MongoDB collections)
# ---------------------------------------------------------------------------
class OutboxEventDocument(Document):
    """Transactional outbox: stores events that must be relayed to RabbitMQ.

    Events are written atomically alongside the domain operation.  A background
    relay picks them up and publishes to RabbitMQ, marking them as ``sent``.
    Consumers use ``idempotency_key`` to deduplicate (at-least-once delivery).
    """

    id: str = Field(default_factory=lambda: str(uuid4()))
    correlation_id: str = Field(default="", description="Request correlation ID for tracing")
    idempotency_key: str = Field(
        description="Unique key for consumer-side deduplication"
    )
    exchange: str = "domain_events"
    event_type: str
    payload: dict
    status: Literal["pending", "sent", "failed"] = "pending"
    retries: int = 0
    created_at: datetime
    sent_at: Optional[datetime] = None
    dead_lettered_at: Optional[datetime] = Field(
        default=None,
        description="Set when the event exhausts MAX_RETRIES and is abandoned",
    )

    class Settings:
        name = "outbox_events"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True),
        ]


# ---------------------------------------------------------------------------
# Lookup collections — seeded once via scripts/seed_lookups.py.
#
# Using the business code (e.g. "admin", "core_hr", "create") as the id means
# foreign keys elsewhere are stable, human-readable, and don't require a
# second round-trip to resolve surrogate UUIDs. Renames become migrations;
# that trade-off is fine for a small, stable lookup set.
# ---------------------------------------------------------------------------
class AclDocument(Document):
    """Top-level ACL roles: admin / editor / viewer."""

    id: str  # AclRoleEnum value, used as the FK from module_acl_permissions.acl_id
    role: AclRoleEnum
    label: str
    # Higher rank wins when merging policies that grant the same module via
    # different roles (matches the existing _ROLE_RANK logic in user_session).
    rank: int

    class Settings:
        name = "acl"


class ModuleDocument(Document):
    """Product modules surfaced in the 'Add Organization' picker and in policies.

    Mandatory modules (currently Core HR) cannot be deselected from an
    organisation — enforced in organisations/schemas.py validators.
    """

    id: str  # ModuleEnum value
    code: ModuleEnum
    label: str
    description: str
    mandatory: bool = False

    class Settings:
        name = "modules"
        indexes = [
            IndexModel([("code", ASCENDING)], unique=True),
        ]


class PermissionDocument(Document):
    """Module-scoped permission rows. id is the composite "{module}:{code}".

    The same code (e.g. "create") may appear across multiple modules; each
    pairing is a distinct row so the UI can render module-specific labels
    and so the policy editor can filter the available codes per module.
    """

    id: str  # permission_doc_id(module, code)
    module: ModuleEnum
    code: PermissionCodeEnum
    label: str
    #: Tooltip text for the role permission grid. Optional — a permission
    #: nobody has written one for simply renders without a tooltip, which is
    #: better than a generated sentence that reads as authoritative.
    description: str | None = None

    class Settings:
        name = "permissions"
        indexes = [
            IndexModel([("module", ASCENDING), ("code", ASCENDING)], unique=True),
        ]


# ---------------------------------------------------------------------------
# Policy + junction. The policy itself is slim — just a named container.
# Grants live on ModuleAclPermissionDocument, one row per granted
# (module × acl × permission) combination. Users hold policies via
# UserDocument.policy_ids (list, multiple policies per user).
#
# Presence-based grants: a row existing means the combination IS granted.
# Removing a grant soft-deletes the row (deleted_on set) for audit trails.
# No explicit `granted: bool` flag — keeps the collection small and the
# query shape simple.
# ---------------------------------------------------------------------------
class PolicyDocument(Document, AuditMixin):
    """A named permission set. Grants live on ModuleAclPermissionDocument rows."""

    name: str
    is_role: bool = False
    is_active: bool = True
    organisation_id: Optional[PydanticObjectId] = None
    seed_module_codes: list[str] = Field(default_factory=list)

    class Settings:
        name = "policies"
        indexes = [
            # Name is unique per tenant (nulls allowed for super-admin-owned policies).
            IndexModel(
                [("name", ASCENDING), ("organisation_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("is_active", ASCENDING)]),
        ]


class ModuleAclPermissionDocument(Document, AuditMixin):
    """Junction: one row = (policy grants role-X the action-Y on module-Z).

    FKs use business codes (ModuleEnum / AclRoleEnum / PermissionCodeEnum
    values) since the lookup collections use those as their ids.
    """

    policy_id: PydanticObjectId
    module_id: str
    acl_id: str
    permission_id: str

    class Settings:
        name = "module_acl_permissions"
        indexes = [
            # Primary query shape: "what does this policy grant?"
            IndexModel([("policy_id", ASCENDING)]),
            # Uniqueness: one row per (policy, module, acl, permission) combination,
            # ignoring soft-deleted rows.
            IndexModel(
                [
                    ("policy_id", ASCENDING),
                    ("module_id", ASCENDING),
                    ("acl_id", ASCENDING),
                    ("permission_id", ASCENDING),
                ],
                unique=True,
                partialFilterExpression={"deleted_on": None},
            ),
        ]

# ---------------------------------------------------------------------------
# Master Data embedded models
# ---------------------------------------------------------------------------
class MasterDataCompact(CustomModel):
    id: PydanticObjectId = Field(..., alias="_id")
    category: str
    key: str
    value: str
    is_active: bool = Field(True, alias="isActive")

 