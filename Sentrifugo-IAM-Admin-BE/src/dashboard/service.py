from datetime import date, datetime, timezone

from beanie import PydanticObjectId

from src.auth.models import UserDocument
from src.dashboard.schemas import (
    BirthdaysResponse,
    DashboardStats,
    HeadcountSnapshot,
    OrgDashboardStats,
)
from src.master_data.models import MasterDataDocument
from src.modules.exit_management.models import ExitRequestDocument
from src.modules.organisation.models import (
    BusinessUnitDocument,
    DepartmentDocument,
    EmployeeDocument,
    OrganisationDocument,
)

NOT_DELETED = {"deleted_on": None}

_IN_PROGRESS_EXIT_STATUSES = [
    "pending_approval",
    "under_review",
    "awaiting_clearances",
    "awaiting_exit_interview",
]


async def get_dashboard_stats() -> DashboardStats:
    total_orgs = await OrganisationDocument.find(NOT_DELETED).count()
    active_orgs = await OrganisationDocument.find({"is_active": True, **NOT_DELETED}).count()
    inactive_orgs = total_orgs - active_orgs
    pending_setup = await OrganisationDocument.find({"setup_status": {"$ne": "active"}, **NOT_DELETED}).count()
    total_users = await UserDocument.find({"is_super_admin": {"$ne": True}, **NOT_DELETED}).count()

    return DashboardStats(
        total_organisations=total_orgs,
        active_organisations=active_orgs,
        inactive_organisations=inactive_orgs,
        pending_setup=pending_setup,
        total_users=total_users,
    )


async def _count_active_employees(org_id: PydanticObjectId, now: datetime) -> int:
    # EmployeeDocument has no `is_active` flag. "Active" needs BOTH signals to agree —
    # an employee may be marked left by an inactive employment status WITHOUT a
    # leaving date (the source often lacks one), or vice versa. So: not soft-deleted,
    # not exited by date (no exit date / future), AND not in an inactive employment
    # status (e.g. "Exit", whose master-data is_active is False).
    inactive_status_ids = [
        d.id
        for d in await MasterDataDocument.find(
            {"category": "EMPLOYMENT_STATUSES", "is_active": False}
        ).to_list()
    ]
    return await EmployeeDocument.find(
        {
            "organisation_id": org_id,
            **NOT_DELETED,
            "$or": [{"date_of_exit": None}, {"date_of_exit": {"$gt": now}}],
            "employment_status": {"$nin": inactive_status_ids},
        }
    ).count()


async def get_org_dashboard_stats(org_id: PydanticObjectId) -> OrgDashboardStats:
    active_filter = {"organisation_id": org_id, "is_active": True, **NOT_DELETED}

    total_employees = await EmployeeDocument.find(
        {"organisation_id": org_id, **NOT_DELETED}
    ).count()
    active_employees = await _count_active_employees(org_id, datetime.now(timezone.utc))
    total_bus = await BusinessUnitDocument.find(active_filter).count()
    total_depts = await DepartmentDocument.find(active_filter).count()

    org = await OrganisationDocument.find_one(
        OrganisationDocument.id == org_id, NOT_DELETED
    )
    enabled_modules = [m.code.value for m in (org.enabled_modules or [])] if org else []

    return OrgDashboardStats(
        total_employees=total_employees,
        active_employees=active_employees,
        total_business_units=total_bus,
        total_departments=total_depts,
        enabled_modules=enabled_modules,
    )


async def get_headcount_snapshot(org_id: PydanticObjectId) -> HeadcountSnapshot:
    now = datetime.now(timezone.utc)
    month_start = datetime(now.year, now.month, 1)

    active_employees = await _count_active_employees(org_id, now)
    new_joiners = await EmployeeDocument.find(
        {"organisation_id": org_id, "date_of_joining": {"$gte": month_start}, **NOT_DELETED}
    ).count()
    in_progress_exits = await ExitRequestDocument.find(
        {
            "organisation_id": org_id,
            "status": {"$in": _IN_PROGRESS_EXIT_STATUSES},
            **NOT_DELETED,
        }
    ).count()

    return HeadcountSnapshot(
        active_employees=active_employees,
        new_joiners_this_month=new_joiners,
        in_progress_exits=in_progress_exits,
    )


def _next_occurrence(d: date, ref_year: int) -> date:
    """The date's month/day in ``ref_year`` (Feb 29 → Feb 28 on non-leap years)."""
    try:
        return d.replace(year=ref_year)
    except ValueError:
        return d.replace(year=ref_year, month=2, day=28)


def _upcoming_of(d: date, today: date) -> date:
    nxt = _next_occurrence(d, today.year)
    if nxt < today:
        nxt = _next_occurrence(d, today.year + 1)
    return nxt


async def get_org_birthdays(
    org_id: PydanticObjectId, limit: int = 7
) -> BirthdaysResponse:
    """Active org members' birthdays and work anniversaries — today's, plus the
    next ``limit`` upcoming across both event types."""
    now = datetime.now(timezone.utc)
    today = now.date()

    users = await UserDocument.find(
        {
            "organisation_id": org_id,
            "deleted_on": None,
            "status": "active",
        }
    ).to_list()
    user_name = {
        u.id: f"{u.first_name or ''} {u.last_name or ''}".strip() or u.email
        for u in users
    }

    today_list: list[dict] = []
    upcoming: list[dict] = []

    def add(item: dict) -> None:
        (today_list if item["days_until"] == 0 else upcoming).append(item)

    # Birthdays — dob lives on the user
    for u in users:
        if not u.dob:
            continue
        bday = _upcoming_of(u.dob.date(), today)
        add({
            "user_id": str(u.id),
            "name": user_name[u.id],
            "date": bday.isoformat(),
            "days_until": (bday - today).days,
            "type": "birthday",
        })

    # Work anniversaries — joining date lives on the employee; only completed
    # years count (a joiner within the last year has no anniversary yet), and
    # exited employees are skipped (mirrors the headcount exit filter).
    employees = await EmployeeDocument.find(
        {
            "organisation_id": org_id,
            **NOT_DELETED,
            "user_id": {"$in": list(user_name.keys())},
            "date_of_joining": {"$ne": None},
            "$or": [{"date_of_exit": None}, {"date_of_exit": {"$gt": now}}],
        }
    ).to_list()
    for e in employees:
        doj = e.date_of_joining
        anniv = _upcoming_of(doj, today)
        years = anniv.year - doj.year
        if years < 1:
            continue
        add({
            "user_id": str(e.user_id),
            "name": user_name[e.user_id],
            "date": anniv.isoformat(),
            "days_until": (anniv - today).days,
            "type": "anniversary",
            "years": years,
        })

    # The next ``limit`` soonest events, however far out they are.
    upcoming.sort(key=lambda x: x["days_until"])
    return BirthdaysResponse(today=today_list, upcoming=upcoming[:limit])
