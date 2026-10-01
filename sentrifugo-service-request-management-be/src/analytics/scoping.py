"""Role entitlement + per-role query scoping for analytics.

Personas map onto the existing ``service_request`` permission grid (the same
grid used by the authorization gates). A user may hold several personas; the
frontend lets them switch between the dashboards they're entitled to.
"""
from __future__ import annotations

from typing import Any

from ..auth.utils.dependencies import UserBase
from ..models import EmployeeReplica, OrgSrConfig, ServiceRequest
from ..requests.service_list import _managed_category_ids, _roster_visible_category_ids
from .schemas import AnalyticsRole

SR_MODULE = "service_request"

ROLE_LABELS: dict[AnalyticsRole, str] = {
    AnalyticsRole.EMPLOYEE: "Employee",
    AnalyticsRole.EXECUTOR: "Executor",
    AnalyticsRole.MANAGER: "Manager",
    AnalyticsRole.APPROVER: "Approver",
    AnalyticsRole.CXO: "CXO",
}

# Each dashboard is gated by a dedicated IAM permission under the
# service_request module (Option 3). Access = permission; the data scope is
# fixed per role (see *_scope helpers below), so granting one never leaks
# another's data.
ROLE_PERMISSION: dict[AnalyticsRole, str] = {
    AnalyticsRole.EMPLOYEE: "view_my_analytics",
    AnalyticsRole.EXECUTOR: "view_executor_analytics",
    AnalyticsRole.APPROVER: "view_approver_analytics",
    AnalyticsRole.MANAGER: "view_team_analytics",
    AnalyticsRole.CXO: "view_org_analytics",
}

# Most-privileged first — used to pick the default dashboard to open.
_ROLE_PRIORITY: list[AnalyticsRole] = [
    AnalyticsRole.CXO,
    AnalyticsRole.MANAGER,
    AnalyticsRole.APPROVER,
    AnalyticsRole.EXECUTOR,
    AnalyticsRole.EMPLOYEE,
]


def _has_grant(user: UserBase, role: AnalyticsRole) -> bool:
    """Explicit IAM permission grant (Option A)."""
    return user.has_permission(SR_MODULE, ROLE_PERMISSION[role])


async def _derived_entitled(user: UserBase, role: AnalyticsRole) -> bool:
    """Membership-derived entitlement (Option B) from the IAM-synced reporting
    chain / department config — the same source the data scopes already use:

      * Approver → user is the L1/L2 manager of ≥1 employee.
      * Manager  → user owns ≥1 department's categories.
      * Executor → user is assigned ≥1 ticket.
      * Employee → always (everyone owns their own tickets).
      * CXO      → never derived; org-wide access stays an explicit grant.

    Best-effort: any lookup error yields False so entitlement can never break
    dashboard access.
    """
    if role is AnalyticsRole.EMPLOYEE:
        return True
    if role is AnalyticsRole.CXO:
        return False
    try:
        if role is AnalyticsRole.APPROVER:
            doc = await EmployeeReplica.find_one(
                {"is_deleted": False,
                 "$or": [{"l1_manager_id": user.id}, {"l2_manager_id": user.id}]}
            )
            return doc is not None
        if role is AnalyticsRole.MANAGER:
            return bool(await _managed_category_ids(user))
        if role is AnalyticsRole.EXECUTOR:
            doc = await ServiceRequest.find_one(
                {"organisation_id": user.org_oid, "deleted_on": None,
                 "executor_user_id": user.oid}
            )
            return doc is not None
    except Exception:  # noqa: BLE001 — entitlement must never raise
        return False
    return False


async def entitled_roles(user: UserBase) -> list[AnalyticsRole]:
    """Dashboards this user may view — explicit IAM grant (A) OR membership
    derived from the synced reporting chain/department (B). CXO is grant-only.

    Super/org admins see all (mirrors require_permission's bypass). Stable
    order: least → most privileged. The grant check short-circuits the derived
    query, so permissioned users incur no extra lookups.
    """
    order = list(reversed(_ROLE_PRIORITY))
    if user.is_super_admin or user.is_org_admin:
        return order
    out: list[AnalyticsRole] = []
    for role in order:
        if _has_grant(user, role) or await _derived_entitled(user, role):
            out.append(role)
    return out


async def is_entitled(user: UserBase, role: AnalyticsRole) -> bool:
    if user.is_super_admin or user.is_org_admin:
        return True
    return _has_grant(user, role) or await _derived_entitled(user, role)


def default_role_from(entitled: list[AnalyticsRole]) -> AnalyticsRole:
    """Most-privileged entitled dashboard to open by default."""
    have = set(entitled)
    for role in _ROLE_PRIORITY:
        if role in have:
            return role
    return AnalyticsRole.EMPLOYEE


async def org_fy_start_month(user: UserBase) -> int:
    """Fiscal-year start month for the caller's org (defaults to April)."""
    cfg = await OrgSrConfig.find_one({"organisation_id": user.org_oid})
    month = getattr(cfg, "fiscal_year_start_month", None) if cfg else None
    return month if isinstance(month, int) and 1 <= month <= 12 else 4


def _org_base(user: UserBase) -> dict[str, Any]:
    return {"organisation_id": user.org_oid, "deleted_on": None}


def employee_scope(user: UserBase) -> dict[str, Any]:
    """Employee/Requester — the caller's own, non-deleted tickets."""
    return {**_org_base(user), "requester_user_id": user.oid}


def executor_scope(user: UserBase) -> dict[str, Any]:
    """Executor — tickets assigned to the caller."""
    return {**_org_base(user), "executor_user_id": user.oid}


def approver_scope(user: UserBase) -> dict[str, Any]:
    """Approver — tickets where the caller is the L1 or L2 approver.

    Includes the Phase-B escalation override: `apply_escalation` hands the
    current level to a single user via `escalation_override_approver_user_id`
    without touching the level snapshots, so an override approver holds a real
    decision that the two clauses above do not match. The approvals queue
    (requests/service_list.py) matches it; these dashboards read the same
    population and would otherwise report a count the queue contradicts.
    """
    return {
        **_org_base(user),
        "$or": [
            {"level_1_approver_user_id": user.oid},
            {"level_2_approver_user_id": user.oid},
            {"escalation_override_approver_user_id": user.oid},
        ],
    }


def cxo_scope(user: UserBase) -> dict[str, Any]:
    """CXO — org-wide, all tickets."""
    return _org_base(user)


async def manager_team_scope(user: UserBase) -> dict[str, Any]:
    """Manager — tickets in the categories the caller manages. Falls back to the
    caller's own approvals when no managed categories resolve (so it's never an
    empty-looking dashboard for a pure approver-manager)."""
    managed = await _managed_category_ids(user)
    filt = _org_base(user)
    if managed:
        filt["category_id"] = {"$in": managed}
    else:
        # Same override caveat as `approver_scope` — this fallback exists so a
        # pure approver-manager doesn't see an empty dashboard, which is
        # exactly what an override approver would otherwise get.
        filt["$or"] = [
            {"level_1_approver_user_id": user.oid},
            {"escalation_override_approver_user_id": user.oid},
        ]
    return filt


async def department_queue_scope(user: UserBase) -> dict[str, Any] | None:
    """Executor self-assign queue — unassigned tickets the caller could pick up.

    Resolved from the same roster-scoped sweep the To Execute queue uses: the
    categories the caller is rostered on, plus the rosterless ones their
    department staffs. The metric is "available to *me*", so reading it off a
    department-wide sweep counted tickets belonging to rosters the caller is not
    on — and handed back their ids, which open the detail view.

    None when nothing resolves.
    """
    dept_cats = await _roster_visible_category_ids(user)
    if not dept_cats:
        return None
    return {**_org_base(user), "category_id": {"$in": dept_cats}}
