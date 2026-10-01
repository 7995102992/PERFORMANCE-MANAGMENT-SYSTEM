from typing import Optional

from pydantic import Field

from src.models import CustomModel


class LeaveBalanceCard(CustomModel):
    """A single leave-type balance row for the dashboard balance widget."""

    leave_type_id: str
    leave_type_name: str
    leave_type_code: Optional[str] = None
    unit: str = "DAYS"
    available_days: float = 0.0
    available_hours: float = 0.0
    # Best-effort denominator (sum of credits this cycle). May be None when the
    # ledger has no credit history for the employee — the UI then shows the
    # available figure without a progress ratio.
    entitled_days: Optional[float] = None


class NextLeaveCard(CustomModel):
    id: str
    leave_type_name: Optional[str] = None
    start_date: str
    end_date: str
    duration_days: float = 0.0
    status: str


class NextHolidayCard(CustomModel):
    id: str
    name: Optional[str] = None
    date: str
    days_until: int = 0
    classification_name: Optional[str] = None
    classification_color: Optional[str] = None


class LapsingLeaveCard(CustomModel):
    leave_type_id: str
    leave_type_name: str
    unit: str = "DAYS"
    units: float = 0.0
    expires_on: str


class TeammateOut(CustomModel):
    user_id: str
    name: Optional[str] = None
    leave_type_name: Optional[str] = None
    start_date: str
    end_date: str
    duration_mode: Optional[str] = None
    half_day_period: Optional[str] = None


class WhosOutToday(CustomModel):
    team_size: int = 0
    out_count: int = 0
    items: list[TeammateOut] = Field(default_factory=list)


class OrgOnLeaveItem(CustomModel):
    user_id: str
    name: Optional[str] = None
    department_id: Optional[str] = None
    department_name: Optional[str] = None
    leave_type_name: Optional[str] = None
    duration_mode: Optional[str] = None


class OrgOnLeaveByDept(CustomModel):
    department_id: Optional[str] = None
    department_name: Optional[str] = None
    count: int = 0


class OrgOnLeaveResponse(CustomModel):
    """Org-wide 'who is out today' for the admin dashboard."""

    total_out: int = 0
    total_employees: int = 0
    items: list[OrgOnLeaveItem] = Field(default_factory=list)
    by_department: list[OrgOnLeaveByDept] = Field(default_factory=list)


class EmployeeDashboardResponse(CustomModel):
    """Aggregated leave-domain data for the employee dashboard.

    Cross-service widgets (timesheet, service requests) are composed on the
    client from their own services — this payload only carries data owned by
    the leave-management service.
    """

    leave_balances: list[LeaveBalanceCard] = Field(default_factory=list)
    next_leave: Optional[NextLeaveCard] = None
    upcoming_leaves: list[NextLeaveCard] = Field(default_factory=list)
    next_holiday: Optional[NextHolidayCard] = None
    lapsing_leaves: list[LapsingLeaveCard] = Field(default_factory=list)
    whos_out_today: WhosOutToday = Field(default_factory=WhosOutToday)
