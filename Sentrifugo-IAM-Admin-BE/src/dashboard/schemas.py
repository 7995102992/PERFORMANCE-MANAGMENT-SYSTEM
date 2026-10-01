from src.models import CustomModel


class DashboardStats(CustomModel):
    total_organisations: int
    active_organisations: int
    inactive_organisations: int
    pending_setup: int
    total_users: int


class OrgDashboardStats(CustomModel):
    total_employees: int
    active_employees: int
    total_business_units: int
    total_departments: int
    enabled_modules: list[str]


class HeadcountSnapshot(CustomModel):
    active_employees: int
    new_joiners_this_month: int
    in_progress_exits: int


class BirthdayItem(CustomModel):
    user_id: str
    name: str
    date: str  # next occurrence, ISO 'YYYY-MM-DD'
    days_until: int
    type: str = "birthday"  # "birthday" | "anniversary"
    years: int | None = None  # anniversary only: years being completed


class BirthdaysResponse(CustomModel):
    today: list[BirthdayItem]
    upcoming: list[BirthdayItem]
