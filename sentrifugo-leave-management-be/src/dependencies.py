import json
from typing import Annotated, Optional

from fastapi import Depends, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from src.config import settings
from src.exceptions import DomainException
from src.logger import logger
from src.models import CustomModel
from src.redis import get_redis


security = HTTPBearer()


class LeaveManagementActions(CustomModel):
    leave_plan: bool = False
    leave_request: bool = False
    holiday_plan: bool = False
    work_calendar: bool = False
    manage_leave_request: bool = False
    leave_configuration: bool = False
    leave_types: bool = False
    # Dedicated HR capability: marks the holder as an HR approver for leave.
    # Whether HR can actually act on / view a given request is further gated by
    # the plan's allow_hr_to_act / allow_hr_to_view toggles. Defaults False, so
    # enforcement is inert until IAM grants this permission.
    approve_as_hr: bool = False
    # The HR employee-leave report (/reports/employee-leave*): who took what leave
    # over a date range, the approval that closed each request, and the Excel
    # download. IAM grants it under leave_management (Leave & Attendance), NOT
    # reports_and_analytics — and it has to be declared HERE regardless, because
    # has_permission resolves an action by looking the field up on this model.
    # An undeclared code reads as False for everyone, so the grant looks correct
    # in the session payload while every request still 403s.
    view_employee_reports: bool = False
    # Attendance view capabilities. IAM grants these under the leave_management
    # module (see IAM ModuleEnum.LEAVE_MANAGEMENT), so they mirror here rather
    # than under attendance_management. manager_attendance gates the team /
    # reporting attendance surface; the others gate the My / HR surfaces.
    my_attendance: bool = False
    manager_attendance: bool = False
    hr_attendance: bool = False


class ReportsAndAnalyticsActions(CustomModel):
    """Reporting & analytics capabilities.

    IAM grants these under the `reports_and_analytics` module, not under
    `leave_management`, so they are read from their own slice of the session's
    permission grid. All default False.
    """

    reports: bool = False
    employee_leave_analytics: bool = False
    manager_leave_analytics: bool = False
    hr_leave_analytics: bool = False
    md_leave_analytics: bool = False
    cfo_leave_analytics: bool = False
    employee_timesheet_analytics: bool = False
    manager_timesheet_analytics: bool = False
    hr_timesheet_analytics: bool = False
    md_timesheet_analytics: bool = False
    cfo_timesheet_analytics: bool = False
    employee_exit_analytics: bool = False
    manager_exit_analytics: bool = False
    hr_exit_analytics: bool = False
    md_exit_analytics: bool = False
    cfo_exit_analytics: bool = False
    workforce_analytics: bool = False


class ModuleActions(CustomModel):
    read: bool = False
    delete: bool = False
    export: bool = False
    update: bool = False
    create: bool = False


class ModulePermission(CustomModel):
    acl: Optional[str] = None
    actions: ModuleActions = ModuleActions()


class LeaveModulePermission(CustomModel):
    acl: Optional[str] = None
    actions: LeaveManagementActions = LeaveManagementActions()


class ReportsAndAnalyticsModulePermission(CustomModel):
    acl: Optional[str] = None
    actions: ReportsAndAnalyticsActions = ReportsAndAnalyticsActions()


class UserPermissions(CustomModel):
    core_hr: Optional[ModulePermission] = None
    attendance_management: Optional[ModulePermission] = None
    leave_management: Optional[LeaveModulePermission] = None
    reports_and_analytics: Optional[ReportsAndAnalyticsModulePermission] = None
    payroll: Optional[ModulePermission] = None
    performance_management: Optional[ModulePermission] = None
    recruitment: Optional[ModulePermission] = None
    training_and_development: Optional[ModulePermission] = None
    expense_management: Optional[ModulePermission] = None
    asset_management: Optional[ModulePermission] = None


# Actions IAM grants under the `reports_and_analytics` module rather than
# `leave_management`; every other action resolves against leave_management.
REPORTS_AND_ANALYTICS_ACTIONS = frozenset(ReportsAndAnalyticsActions.model_fields)


class UserBase(CustomModel):
    user_id: str
    email: Optional[str] = None
    full_name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    org_id: Optional[str] = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    auth_method: Optional[str] = None
    permissions: Optional[UserPermissions] = None

    def has_permission(self, action: str) -> bool:
        """True when the caller may perform `action`.

        Reporting / analytics actions are granted by IAM under the
        `reports_and_analytics` module; everything else under
        `leave_management`. Org / super admins receive a fully-populated
        permission grid upstream and always pass, matching the existing
        is_org_admin checks."""
        if self.is_super_admin or self.is_org_admin:
            return True
        if not self.permissions:
            return False
        if action in REPORTS_AND_ANALYTICS_ACTIONS:
            module = self.permissions.reports_and_analytics
        else:
            module = self.permissions.leave_management
        if not module:
            return False
        return bool(getattr(module.actions, action, False))


def user_is_hr(user: UserBase) -> bool:
    """True when the user holds the dedicated HR leave permission.

    Org / super admins receive a fully-populated permission grid upstream, so
    this returns True for them too without any special-casing.
    """
    lm = user.permissions.leave_management if user.permissions else None
    return bool(lm and lm.actions.approve_as_hr)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
) -> UserBase:
    """
    Validate the access token by looking it up in Redis.
    Expects a Redis key like `session:<token>` containing JSON user data.
    """
    token = credentials.credentials
    redis = await get_redis()

    credentials_exception = DomainException(
        message="Could not validate credentials",
        code="UNAUTHENTICATED",
        status_code=status.HTTP_401_UNAUTHORIZED,
    )

    try:
        user_data = await redis.get(f"session:{token}")
    except Exception as e:
        logger.error("Redis lookup failed during auth", error=str(e))
        raise credentials_exception

    if not user_data:
        raise credentials_exception

    try:
        user_dict = json.loads(user_data)
        return UserBase(**user_dict)
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("Invalid session data in Redis", error=str(e))
        raise credentials_exception


def require_permission(action: str):
    """FastAPI dependency factory that enforces a single permission.

    The action is resolved against whichever module IAM grants it under — see
    `UserBase.has_permission`. Returns a dependency raising 403 unless the
    caller holds `action`
    (org / super admins bypass, consistent with the existing is_org_admin
    checks). The resolved user is returned, so routes can also declare it as a
    parameter when they need `current_user` for org-scoping.
    """

    async def _require(
        current_user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if not current_user.has_permission(action):
            raise DomainException(
                message="You do not have permission to perform this action",
                code="FORBIDDEN",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        return current_user

    return _require


def require_any_permission(*actions: str):
    """Like `require_permission`, but passes when the caller holds ANY of the
    listed permissions (org / super admins bypass)."""

    async def _require(
        current_user: Annotated[UserBase, Depends(get_current_user)],
    ) -> UserBase:
        if not any(current_user.has_permission(a) for a in actions):
            raise DomainException(
                message="You do not have permission to perform this action",
                code="FORBIDDEN",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        return current_user

    return _require


async def require_development_env() -> None:
    """Dependency that disables the route outside the development environment.

    Fails closed: only an explicit ENVIRONMENT of "development" enables the
    route. Anything else — including an unset ENVIRONMENT, which defaults to
    production — makes the endpoint behave as though it does not exist (404),
    so it neither runs nor advertises itself.
    """
    if settings.ENVIRONMENT.strip().lower() != "development":
        raise DomainException(
            message="Not Found",
            code="NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
