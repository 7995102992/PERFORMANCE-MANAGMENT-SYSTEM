from datetime import date
from typing import Optional

from pydantic import Field

from src.models import CustomModel


class LeaveOnDay(CustomModel):
    user_id: str
    employee_name: str
    leave_type_name: str
    request_id: str
    duration_mode: str
    status: str


class DailyAvailability(CustomModel):
    date: date
    available_count: int
    on_leave_count: int
    on_leave: list[LeaveOnDay]


class TeamMemberLeave(CustomModel):
    request_id: str
    leave_type_id: str
    leave_type_name: str
    start_date: str
    end_date: str
    duration_mode: str
    duration_days: float
    status: str


class TeamMemberAvailability(CustomModel):
    user_id: str
    name: str
    leaves_in_range: list[TeamMemberLeave] = Field(default_factory=list)


class TeamAvailabilityResponse(CustomModel):
    start_date: date
    end_date: date
    total_team_size: int
    daily_availability: list[DailyAvailability]
    team_members: list[TeamMemberAvailability]


class CalendarLeaveEvent(CustomModel):
    request_id: str
    leave_type_id: str
    leave_type_name: str
    start_date: str
    end_date: str
    duration_days: float
    duration_mode: str
    half_day_period: Optional[str] = None
    start_session: Optional[str] = None
    end_session: Optional[str] = None
    status: str
    reason: Optional[str] = None


class CalendarTeamMember(CustomModel):
    user_id: str
    employee_name: str
    events: list[CalendarLeaveEvent] = Field(default_factory=list)


class CalendarHoliday(CustomModel):
    name: str
    date: str
    # Classification name (e.g. "National Holiday") and its swatch, resolved from
    # the holiday's classification_id.
    type: str
    color: str = ""


class TeamCalendarResponse(CustomModel):
    from_date: date
    to_date: date
    team_members: list[CalendarTeamMember]
    holidays: list[CalendarHoliday]


class LeaveTypeSummary(CustomModel):
    leave_type_id: str
    leave_type_name: str
    total_requests: int
    total_hours: float
    total_days: float
    # Distinct employees who took this leave type — the FE's "N emp" figure
    # and the numerator of its share-of-team bar.
    employee_count: int = 0


class EmployeeLeaveSummary(CustomModel):
    user_id: str
    employee_name: str
    total_requests: int
    total_hours: float
    total_days: float
    by_type: list[LeaveTypeSummary]


class TeamLeaveSummaryResponse(CustomModel):
    total_employees: int
    employees_with_leaves: int
    summary_by_type: list[LeaveTypeSummary]
    by_employee: list[EmployeeLeaveSummary]
