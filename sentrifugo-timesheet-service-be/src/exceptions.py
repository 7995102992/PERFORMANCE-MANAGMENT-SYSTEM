from __future__ import annotations

import logging

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

logger = logging.getLogger(__name__)


class DomainException(Exception):
    def __init__(self, message: str, code: str = "INTERNAL_ERROR", status_code: int = status.HTTP_400_BAD_REQUEST):
        self.message = message
        self.code = code
        self.status_code = status_code


class Unauthorized(DomainException):
    def __init__(self, message: str = "Not authenticated"):
        super().__init__(message, "UNAUTHENTICATED", status.HTTP_401_UNAUTHORIZED)


class Forbidden(DomainException):
    def __init__(self, message: str = "Forbidden"):
        super().__init__(message, "FORBIDDEN", status.HTTP_403_FORBIDDEN)


class NotFound(DomainException):
    def __init__(self, message: str = "Not found"):
        super().__init__(message, "NOT_FOUND", status.HTTP_404_NOT_FOUND)


class Conflict(DomainException):
    def __init__(self, message: str = "Conflict"):
        super().__init__(message, "CONFLICT", status.HTTP_409_CONFLICT)


# Domain-specific exceptions
class ClientNotFound(NotFound):
    def __init__(self): super().__init__("Client not found")

class ClientNameExists(Conflict):
    def __init__(self): super().__init__("Client with this name already exists")

class ProjectNotFound(NotFound):
    def __init__(self): super().__init__("Project not found")

class ProjectNameExists(Conflict):
    def __init__(self): super().__init__("Project with this name already exists")

class ProjectCodeExists(Conflict):
    def __init__(self): super().__init__("Project with this code already exists")

class TaskNotFound(NotFound):
    def __init__(self): super().__init__("Task not found")

class TaskNameExists(Conflict):
    def __init__(self): super().__init__("Task with this name already exists")

class ResourceAssignmentNotFound(NotFound):
    def __init__(self): super().__init__("Resource assignment not found")

class ResourceAlreadyAssigned(Conflict):
    def __init__(self): super().__init__("Employee is already assigned")

class EmployeeNotInOrganisation(NotFound):
    def __init__(self): super().__init__("Employee not found in this organisation")

class TimesheetNotFound(NotFound):
    def __init__(self): super().__init__("Timesheet not found")

class TimesheetAlreadyExists(Conflict):
    def __init__(self): super().__init__("Timesheet already exists for this week")

class TimesheetNotEditable(DomainException):
    def __init__(self): super().__init__("Timesheet is not in an editable status", "TSM-004")

class TimesheetNotSubmittable(DomainException):
    def __init__(self): super().__init__("Timesheet is not in a submittable status", "TSM-004")

class TimesheetNotApprovable(DomainException):
    def __init__(self): super().__init__("Timesheet is not in a status that can be approved", "TSM-010")

class DailyHoursExceeded(DomainException):
    def __init__(self, max_hours: float):
        super().__init__(f"Daily hours exceed maximum of {max_hours}", "TSM-002")

class WeeklyHoursExceeded(DomainException):
    def __init__(self, max_hours: float):
        super().__init__(f"Weekly hours exceed maximum of {max_hours}", "TSM-003")

class EmployeeNotAssignedToProject(DomainException):
    def __init__(self): super().__init__("Employee is not assigned to this project", "TSM-005")

class TaskNotAvailableForProject(DomainException):
    def __init__(self): super().__init__("Task is not available for this project", "TSM-006")

class RejectionRequiresComment(DomainException):
    def __init__(self): super().__init__("Rejection requires a comment", "TSM-009")

class SettingsNotFound(NotFound):
    def __init__(self): super().__init__("Timesheet settings not found")

class ProjectTaskNotFound(NotFound):
    def __init__(self): super().__init__("Project task mapping not found")

class ProjectHasResources(DomainException):
    def __init__(self): super().__init__("Project has active resource assignments", "TSM-012")

class ProjectHasPendingTimesheets(DomainException):
    def __init__(self):
        super().__init__(
            "This project has timesheets pending approval. Approve or reject them before deleting the project.",
            "TSM-030",
        )

class InvalidInternalProjectHead(DomainException):
    def __init__(self):
        super().__init__(
            "Internal project heads must be employees within the client's business unit / department.",
            "TSM-031",
        )

class ClientHasProjects(DomainException):
    def __init__(self): super().__init__("Client has active projects", "TSM-013")

class ClientProjectHeadNotFound(NotFound):
    def __init__(self): super().__init__("Client project head not found")

class ClientProjectHeadEmailExists(Conflict):
    def __init__(self): super().__init__("A project head with this email already exists")

class TaskInUse(DomainException):
    def __init__(self): super().__init__("Task is in use by projects", "TSM-014")

class TaskHasTimesheets(DomainException):
    """Raised when a task cannot be deleted because timesheet entries reference it."""

    def __init__(self, task_name: str | None = None, project_names: list[str] | None = None):
        task_label = f"'{task_name}'" if task_name else "this task"
        scope = f" in project(s): {', '.join(project_names)}" if project_names else ""
        super().__init__(
            f"Timesheets already exist with task {task_label}{scope}. The task cannot be deleted.",
            "TSM-032",
        )

class ResourceReleased(DomainException):
    """Raised when a released allocation is edited — a release is final."""

    def __init__(self, end_date: str | None = None):
        effective = f" effective {end_date}" if end_date else ""
        super().__init__(
            f"This resource has been removed from the project{effective} and can no longer "
            "be updated. Assign them again to reopen the allocation.",
            "TSM-037",
        )


class OnlyZeroHourDaysEditable(DomainException):
    """Raised when a submitted timesheet's already-logged days are being changed."""

    def __init__(self, dates: list[str]):
        shown = dates[:5]
        more = len(dates) - len(shown)
        listed = ", ".join(shown) + (f" and {more} more" if more > 0 else "")
        super().__init__(
            f"This timesheet has been submitted — only days with no hours logged can still "
            f"be filled in. Leave {listed} as submitted, or ask your manager to reject the week.",
            "TSM-036",
        )


class PastSubmissionLocked(DomainException):
    """Raised when a week has passed the monthly payroll cutoff and is frozen."""

    def __init__(self, cutoff_date: str, project_names: list[str] | None = None):
        scope = f" for {', '.join(project_names)}" if project_names else ""
        super().__init__(
            f"This week closed at the {cutoff_date} cutoff and can no longer be edited or "
            f"submitted{scope}. Ask the project manager to reopen the month.",
            "TSM-035",
        )


class EntriesNoLongerAssigned(DomainException):
    """Raised when a timesheet still holds time for a task the employee lost access to."""

    def __init__(self, entries: list[str]):
        shown = entries[:5]
        more = len(entries) - len(shown)
        listed = "; ".join(shown) + (f"; and {more} more" if more > 0 else "")
        super().__init__(
            f"Your assignment changed — you are no longer assigned to {listed}. "
            "Remove or re-enter that time before submitting.",
            "TSM-034",
        )


class ProjectTaskHasTimesheets(DomainException):
    """Raised when a task cannot be unassigned because the project has timesheet entries for it."""

    def __init__(self, task_name: str | None = None, project_name: str | None = None):
        task_label = f"'{task_name}'" if task_name else "this task"
        project_label = f"'{project_name}'" if project_name else "this project"
        super().__init__(
            f"Timesheets already exist with task {task_label} in project {project_label}. "
            "The task cannot be removed from this project.",
            "TSM-033",
        )

class PastDueTimesheetsBlocked(DomainException):
    def __init__(self): super().__init__("Cannot submit: you have unsubmitted past timesheets", "TSM-015")

class SubmissionDeadlinePassed(DomainException):
    def __init__(self): super().__init__("Cannot submit: submission deadline has passed", "TSM-018")

class DailyComplianceMissing(DomainException):
    def __init__(self, missing_dates: list[str]):
        super().__init__(f"Cannot submit: missing time entries for {', '.join(missing_dates)}", "TSM-019")

class DailyDeadlineMissed(DomainException):
    def __init__(self, missed_dates: list[str]):
        super().__init__(f"Cannot submit: daily submission deadline missed for {', '.join(missed_dates)}", "TSM-020")

class MinDailyHoursNotMet(DomainException):
    def __init__(self, min_hours: float, dates: list[str]):
        super().__init__(f"Minimum daily hours ({min_hours}) not met for: {', '.join(dates)}", "TSM-021")

class FutureDateEntryNotAllowed(DomainException):
    """Raised when hours are logged against a date later than today.

    Two separate settings cap entries at today — daily entry mode and the
    allow-future-entries switch — so the caller supplies the reason that applies
    rather than the message naming one of them unconditionally.
    """

    def __init__(self, reason: str | None = None):
        super().__init__(
            reason or "Time cannot be logged for future dates.",
            "TSM-022",
        )

class TimeOffEntriesRestricted(DomainException):
    def __init__(self): super().__init__("Time-off task entries are restricted by your organisation settings", "TSM-023")

class AttachmentsNotAllowed(DomainException):
    def __init__(self): super().__init__("Attachments are not enabled for this organisation", "TSM-024")

class AttachmentNotFound(NotFound):
    def __init__(self): super().__init__("Attachment not found")

class PastEntryTooOld(DomainException):
    def __init__(self, days: int): super().__init__(f"Entry date exceeds the allowed past limit of {days} days", "TSM-025")

class ProjectNotStarted(DomainException):
    def __init__(self, project_name: str, start_date: str):
        super().__init__(
            f"Project '{project_name}' has not started yet. It starts on {start_date}.",
            "TSM-026",
        )

class ProjectAlreadyEnded(DomainException):
    def __init__(self, project_name: str, end_date: str):
        super().__init__(
            f"Project '{project_name}' has already ended on {end_date}.",
            "TSM-027",
        )

class AssignmentNotStarted(DomainException):
    def __init__(self, project_name: str, start_date: str):
        super().__init__(
            f"Your assignment to '{project_name}' has not started yet. It starts on {start_date}.",
            "TSM-028",
        )

class AssignmentEnded(DomainException):
    def __init__(self, project_name: str, end_date: str):
        super().__init__(
            f"Your assignment to '{project_name}' ended on {end_date}.",
            "TSM-029",
        )


def _public_error(error: dict) -> dict:
    """Strip a pydantic error down to what is safe to hand back.

    ``loc``, ``msg`` and ``type`` are the caller's own request described back to
    them. ``input`` and ``ctx`` are dropped because they echo the submitted value
    into the response body, and ``url`` because it points at pydantic's docs.
    """
    return {key: error[key] for key in ("type", "loc", "msg") if key in error}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainException)
    async def domain_handler(request: Request, exc: DomainException):
        logger.warning("domain_error path=%s code=%s msg=%s", request.url.path, exc.code, exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.message, "code": exc.code},
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request: Request, exc: RequestValidationError):
        """The caller sent something we cannot accept — a genuine 422.

        Bound to ``RequestValidationError`` rather than to pydantic's
        ``ValidationError``, which it does not inherit from. The broader binding
        also caught every *model* validation failure, including a document that
        would not load out of Mongo, and answered it with a 422 naming the
        offending field — indistinguishable from a rejected request, with no
        traceback and nothing in the log but the status line. See the handler
        below for where those go now.
        """
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"detail": [_public_error(error) for error in exc.errors()], "code": "VALIDATION_ERROR"},
        )

    @app.exception_handler(ValidationError)
    async def model_validation_handler(request: Request, exc: ValidationError):
        """Our own data would not validate — a server fault, reported as one.

        Reached when a stored document no longer satisfies the model that reads
        it: a field added since it was written, or a value outside an enum that
        has moved on. That is not the caller's doing and there is nothing they
        can change about their request, so it is a 500 rather than a 422.

        The offending model and field are logged because the response cannot
        carry them — the errors name our schema, not their input.
        """
        logger.error(
            "model_validation_error path=%s model=%s fields=%s",
            request.url.path,
            exc.title,
            [".".join(str(part) for part in error["loc"]) for error in exc.errors()],
            exc_info=True,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "An unexpected error occurred.", "code": "INTERNAL_SERVER_ERROR"},
        )

    @app.exception_handler(Exception)
    async def global_handler(request: Request, exc: Exception):
        logger.error("unhandled_error path=%s err=%s", request.url.path, str(exc), exc_info=True)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "An unexpected error occurred.", "code": "INTERNAL_SERVER_ERROR"},
        )
