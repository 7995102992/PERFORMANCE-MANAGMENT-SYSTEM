from datetime import date, datetime
from typing import Literal, Optional

from pydantic import Field, model_validator

from src.models import AuditMixin, CustomModel


DayName = Literal[
    "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"
]

YearType = Literal["CALENDAR", "FISCAL", "CUSTOM"]
ScopeType = Literal["BU", "DEPARTMENT"]
StatutoryRuleType = Literal["FIXED", "ROTATING"]

VALID_WEEK_KEYS = {"1", "2", "3", "4", "5"}


def _validate_weekend_matrix(matrix: dict[str, list[int]]) -> None:
    """Each row must be 7 ints (Mon..Sun): 0=off, 1=full working day, 2=half day, 3=full/half (allow both).

    0 means OFF, not "full day" — this docstring and the error message below used to
    say the opposite of what the system does. The resolver treats 0 as the weekend
    slot (``work_calendar/resolver.py``), the shift RPC consumer documents 0 as "full
    day off", and the FE ships ``[1,1,1,1,1,0,0]`` as its Mon–Fri default. Anyone
    building a payload from the old wording produced an inverted calendar that
    reported Mon–Fri as weekends.
    """
    for key, row in matrix.items():
        if key not in VALID_WEEK_KEYS:
            raise ValueError(
                f"weekend_matrix keys must be one of {sorted(VALID_WEEK_KEYS)} (week of month), got '{key}'"
            )
        if not isinstance(row, list) or len(row) != 7:
            raise ValueError(f"weekend_matrix['{key}'] must be a list of 7 integers (Mon..Sun)")
        if any(v not in (0, 1, 2, 3) for v in row):
            raise ValueError(f"weekend_matrix['{key}'] entries must be 0 (off), 1 (full working day), 2 (half), or 3 (full/half)")


class WeekConfig(CustomModel):
    week_start_day: DayName = "MONDAY"
    work_week_start: DayName = "MONDAY"
    work_week_end: DayName = "FRIDAY"
    allow_half_day: bool = True


class StatutoryConfig(CustomModel):
    enabled: bool = True
    rule_type: StatutoryRuleType = "FIXED"
    statutory_days: list[DayName] = Field(default_factory=list)


class WorkCalendarBase(CustomModel):
    name: str = Field(min_length=1, max_length=120)
    year_type: YearType = "CUSTOM"
    start_date: date
    end_date: date
    is_active: bool = True
    is_default: bool = False
    business_unit_ids: list[str] = Field(default_factory=list)
    department_ids: list[str] = Field(default_factory=list)
    week_config: WeekConfig = Field(default_factory=WeekConfig)
    weekend_matrix: dict[str, list[int]] = Field(default_factory=dict)
    # Nullable so the FE can explicitly clear the statutory block when the
    # user toggles it off (FE sends ``null``); ``None`` is normalised below.
    statutory_config: Optional[StatutoryConfig] = None


class WorkCalendarCreate(WorkCalendarBase):
    @model_validator(mode="after")
    def _validate(self) -> "WorkCalendarCreate":
        _validate_weekend_matrix(self.weekend_matrix)
        if self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class WorkCalendarUpdate(CustomModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    year_type: Optional[YearType] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    is_active: Optional[bool] = None
    is_default: Optional[bool] = None
    business_unit_ids: Optional[list[str]] = None
    department_ids: Optional[list[str]] = None
    week_config: Optional[WeekConfig] = None
    weekend_matrix: Optional[dict[str, list[int]]] = None
    statutory_config: Optional[StatutoryConfig] = None

    @model_validator(mode="after")
    def _validate(self) -> "WorkCalendarUpdate":
        if self.weekend_matrix is not None:
            _validate_weekend_matrix(self.weekend_matrix)
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class EntityRef(CustomModel):
    id: str
    name: str


class DepartmentRef(CustomModel):
    id: str
    name: str
    # Primary BU the dept rolls up to in the IAM. ``business_unit_ids`` is the
    # full set of BUs the dept is linked to (primary may also appear there).
    # ``business_unit_name`` is the denormalised name of the primary BU so the
    # FE can render the canonical "<Primary BU> - <Dept>" label without a
    # secondary join to ``business_units``.
    # The FE's shared-dept cascade reads ``business_unit_ids`` to decide
    # whether a dept stays selected after a BU is removed from the calendar.
    business_unit_id: Optional[str] = None
    business_unit_name: Optional[str] = None
    business_unit_ids: list[str] = Field(default_factory=list)


class WorkCalendarResponse(WorkCalendarBase, AuditMixin):
    id: str = Field(alias="_id")
    org_id: str
    business_units: list[EntityRef] = Field(default_factory=list)
    departments: list[DepartmentRef] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _normalize_objectids(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "org_id"):
            if data.get(field) is not None and not isinstance(data[field], str):
                data[field] = str(data[field])
        # The response uses the joined ``business_units`` / ``departments``
        # arrays. A raw doc from ``find_one`` could leak the underlying
        # ObjectId lists — coerce them to strings so Pydantic doesn't choke,
        # and pop them so they don't shadow the joined fields below.
        for raw_field in ("business_unit_ids", "department_ids"):
            raw = data.get(raw_field)
            if raw is not None:
                data[raw_field] = [str(v) for v in raw]
        # Same defence on nested dept refs — the aggregation $toString-coerces
        # in the happy path, but a non-aggregation fallback could leak ObjectIds.
        depts = data.get("departments")
        if isinstance(depts, list):
            for ref in depts:
                if not isinstance(ref, dict):
                    continue
                if ref.get("id") is not None and not isinstance(ref["id"], str):
                    ref["id"] = str(ref["id"])
                if ref.get("business_unit_id") is not None and not isinstance(ref["business_unit_id"], str):
                    ref["business_unit_id"] = str(ref["business_unit_id"])
                if ref.get("business_unit_name") is not None and not isinstance(ref["business_unit_name"], str):
                    ref["business_unit_name"] = str(ref["business_unit_name"])
                bu_ids = ref.get("business_unit_ids")
                if isinstance(bu_ids, list):
                    ref["business_unit_ids"] = [str(v) for v in bu_ids]
        return data


class AssignmentScope(CustomModel):
    calendar_id: str = Field(min_length=1)
    scope: ScopeType
    scope_ids: list[str] = Field(min_length=1)


class EmployeeOverridePayload(CustomModel):
    calendar_id: str = Field(min_length=1)
    employee_ids: list[str] = Field(min_length=1)
    effective_from: date
    effective_to: Optional[date] = None

    @model_validator(mode="after")
    def _validate(self) -> "EmployeeOverridePayload":
        if self.effective_to and self.effective_to < self.effective_from:
            raise ValueError("effective_to must be on or after effective_from")
        return self


class AssignmentResponse(CustomModel):
    calendar_id: str
    scope: str
    count: int


class WorkingDayResponse(CustomModel):
    user_id: str
    date: date
    is_working_day: bool
    is_holiday: bool = False
    is_weekend: bool = False
    # Set when is_holiday is True, so the caller can name the day.
    holiday_name: Optional[str] = None
    calendar_id: Optional[str] = None
    reason: Optional[str] = None


class CalendarPeriod(CustomModel):
    start: date
    end: date


class CalendarWorkWeek(CustomModel):
    start: DayName
    end: DayName


class WorkCalendarListItem(CustomModel):
    id: str = Field(alias="_id")
    name: str
    period: CalendarPeriod
    work_week: CalendarWorkWeek
    status: str
    employee_count: int


class WorkCalendarEmployeeSync(CustomModel):
    user_ids: list[str]


class WorkCalendarEmployeesByDepartments(CustomModel):
    department_ids: list[str] = Field(default_factory=list)


class EmployeeWorkCalendarResponse(CustomModel):
    calendar_id: str
    calendar_name: str
    weekend_matrix: dict[str, list[int]] = Field(default_factory=dict)
    week_config: WeekConfig = Field(default_factory=WeekConfig)
    start_date: date
    end_date: date


class WorkCalendarEmployeeEntry(CustomModel):
    id: str = Field(alias="_id")
    work_calendar_id: str
    user_id: str
    created_on: Optional[date] = None
    created_by: Optional[str] = None
    # Enriched from the LMS employee mirror so the FE renders members directly
    # from this response (no IAM employee fetch + client-side join).
    name: Optional[str] = None
    emp_code: Optional[str] = None
    work_email: Optional[str] = None
    department_name: Optional[str] = None
    business_unit_name: Optional[str] = None
    designation_name: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _normalize(cls, data: dict) -> dict:
        if not isinstance(data, dict):
            return data
        for field in ("_id", "work_calendar_id", "user_id", "created_by"):
            if data.get(field) is not None:
                data[field] = str(data[field])
        if isinstance(data.get("created_on"), datetime):
            data["created_on"] = data["created_on"].date()
        return data
