from datetime import date
from typing import Optional

from pydantic import BaseModel

# Read-only schemas. Punches are written to MongoDB by the separate collector
# service; the raw-row / ingest models used to live here but moved with the
# write path.


class PunchEntry(BaseModel):
    time: str
    type: str  # "in" or "out"
    terminal_name: Optional[str] = None


class EmployeeDayAttendance(BaseModel):
    employee_user_id: Optional[str] = None
    terminal_user_id: str
    user_name: str
    group_name: Optional[str] = None
    # The HR department, resolved from the employees mirror. Distinct from
    # `group_name`, which is the biometric terminal's group (SFO, SIL, Trainees…)
    # and carries no org-structure meaning. Populated by the team roster; the
    # other endpoints leave it None.
    department_name: Optional[str] = None
    punch_date: date
    first_in: Optional[str] = None
    last_out: Optional[str] = None
    total_hours: Optional[str] = None
    work_hours: Optional[str] = None
    punches: list[PunchEntry] = []
    status: str = "no-time"  # full, late, partial, no-time, weekend, holiday, leave
    # Set when status == "leave": the leave type the day was charged to (e.g.
    # "Earned Leave", "Work From Home"). Lets the calendar label the day with
    # the specific type instead of a generic "Leave".
    leave_type_name: Optional[str] = None


class AttendanceDaySummary(BaseModel):
    date: date
    total_employees: int = 0
    present: int = 0
    absent: int = 0
    late: int = 0
    partial: int = 0
