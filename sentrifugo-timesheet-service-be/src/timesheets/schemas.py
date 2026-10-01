from __future__ import annotations

from datetime import datetime
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..config import settings
from ..models import TimesheetAttachment, TimesheetStatusEnum

# Default ports that carry no meaning in a host comparison.
_DEFAULT_PORTS = {80, 443}


def _host_key(url: str) -> str | None:
    """Normalise a URL to ``host[:port]`` for allowlist comparison.

    Returns ``None`` for anything that has no host or smuggles credentials
    (``https://evil.com@trusted.host/``), so such URLs can never match.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    if parsed.username or parsed.password:
        return None
    host = (parsed.hostname or "").lower()
    if not host:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    if port and port not in _DEFAULT_PORTS:
        return f"{host}:{port}"
    return host


def _attachment_host_allowlist() -> set[str]:
    """Hosts an attachment URL may point at, derived from the configured CORS
    origins so there is no second list to keep in sync.

    ``*`` is never treated as a matching host — a wildcard cannot widen this
    allowlist. A config of only ``*`` therefore yields an empty set, in which
    case the https-scheme check below is the sole restriction.
    """
    hosts: set[str] = set()
    for origin in settings.CORS_ORIGINS or []:
        candidate = (origin or "").strip()
        if not candidate or candidate == "*":
            continue
        key = _host_key(candidate if "//" in candidate else f"https://{candidate}")
        if key:
            hosts.add(key)
    return hosts


class TimesheetCreate(BaseModel):
    week_start_date: str = Field(description="ISO date string, must be a Monday")
    notes: str | None = None


class TimesheetEntryCreate(BaseModel):
    project_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)
    entry_date: str = Field(description="ISO date string")
    hours: float = Field(ge=0, le=24)
    notes: str | None = None


class TimesheetEntryBulkSave(BaseModel):
    entries: list[TimesheetEntryCreate]


class TimesheetEntryOut(BaseModel):
    id: str
    weekly_timesheet_id: str
    project_id: str
    task_id: str
    entry_date: datetime
    hours: float
    notes: str | None = None
    is_billable: bool
    created_on: datetime | None = None
    modified_on: datetime | None = None


class AttachmentAdd(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    url: str = Field(min_length=1, max_length=2048)

    @field_validator("url")
    @classmethod
    def _https_on_allowed_host(cls, v: str) -> str:
        """Attachment URLs are rendered to approvers, so only https links to a
        configured origin are accepted — ``javascript:`` / ``data:`` payloads and
        arbitrary hosts are rejected outright."""
        url = v.strip()
        if urlparse(url).scheme.lower() != "https":
            raise ValueError("Attachment URL must use https")
        host = _host_key(url)
        if not host:
            raise ValueError("Attachment URL must include a valid host")
        allowed = _attachment_host_allowlist()
        if allowed and host not in allowed:
            raise ValueError("Attachment URL host is not allowed")
        return url


class WorkCalendarOut(BaseModel):
    weekoffs: list[str] = Field(default_factory=list)   # full-day off dates (code 0)
    weekend_matrix: dict | None = None                  # raw LMS matrix passthrough
    week_config: dict | None = None                     # raw LMS week_config passthrough


class WeeklyTimesheetOut(BaseModel):
    id: str
    organisation_id: str
    user_id: str
    week_start_date: datetime
    week_end_date: datetime
    total_hours: float
    billable_hours: float
    non_billable_hours: float
    shortage_hours: float = 0
    penalty_hours: float = 0
    timesheet_status: TimesheetStatusEnum
    submitted_at: datetime | None = None
    notes: str | None = None
    entries: list[TimesheetEntryOut] = Field(default_factory=list)
    attachments: list[TimesheetAttachment] = Field(default_factory=list)
    work_calendar: WorkCalendarOut | None = None
    created_by: str | None = None
    created_on: datetime | None = None
    modified_on: datetime | None = None


class WeeklyTimesheetListItem(BaseModel):
    id: str
    user_id: str
    week_start_date: datetime
    week_end_date: datetime
    total_hours: float
    billable_hours: float
    non_billable_hours: float
    timesheet_status: TimesheetStatusEnum
    submitted_at: datetime | None = None
    created_on: datetime | None = None
