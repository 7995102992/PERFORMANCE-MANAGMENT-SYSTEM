"""Analytics orchestration: role dispatch → build tabs → cache → respond.

On-the-fly computation with a short Valkey cache (60s), mirroring the existing
dashboard_summary caching. Cache key is per (org, user, role) so each persona's
view is cached independently.
"""
from __future__ import annotations

import logging

from fastapi import HTTPException

from ..common.timestamps import utcnow
from ..valkey import get_valkey
from .bu import bu_category_ids
from .metrics.descriptive import (
    build_approver_descriptive,
    build_cxo_descriptive,
    build_employee_descriptive,
    build_executor_descriptive,
    build_manager_descriptive,
)
# Prescriptive/Predictive employee tabs are implemented (metrics/prescriptive.py,
# metrics/predictive.py) but DISABLED for now — re-enable by importing them and
# adding to the EMPLOYEE tab list below.
# from .metrics.prescriptive import build_employee_prescriptive
# from .metrics.predictive import build_employee_predictive
from .schemas import AnalyticsRole, DashboardResponse, Tab
from .scoping import ROLE_LABELS

logger = logging.getLogger(__name__)

_CACHE_TTL_SECONDS = 60


def _cache_key(user, role: AnalyticsRole, business_unit_id: str | None = None) -> str:
    return f"srm:analytics:{user.organisation_id}:{user.id}:{role.value}:{business_unit_id or 'all'}"


# Ordered tab builders per role. Descriptive-only for now; the employee
# Prescriptive/Predictive builders are coded but disabled (see import note above)
# — append build_employee_prescriptive, build_employee_predictive to re-enable.
_TAB_BUILDERS = {
    AnalyticsRole.EMPLOYEE: [build_employee_descriptive],
    AnalyticsRole.MANAGER: [build_manager_descriptive],
    AnalyticsRole.EXECUTOR: [build_executor_descriptive],
    AnalyticsRole.APPROVER: [build_approver_descriptive],
    AnalyticsRole.CXO: [build_cxo_descriptive],
}


async def build_dashboard(user, role: AnalyticsRole, business_unit_id: str | None = None) -> DashboardResponse:
    # Business-unit scoping is CXO-only (View-BU mode); ignored for other roles.
    bu = business_unit_id if role == AnalyticsRole.CXO else None
    key = _cache_key(user, role, bu)
    cache = None
    try:
        cache = get_valkey()
        cached = await cache.get(key)
        if cached:
            return DashboardResponse.model_validate_json(cached)
    except Exception:  # noqa: BLE001 — cache is best-effort
        cache = None

    builders = _TAB_BUILDERS.get(role)
    if not builders:
        raise HTTPException(
            status_code=501,
            detail=f"The '{role.value}' dashboard is not implemented yet (coming in a later phase).",
        )

    if bu:
        restrict = await bu_category_ids(user, bu)
        tabs: list[Tab] = [await build_cxo_descriptive(user, restrict_category_ids=restrict)]
    else:
        tabs = [await build(user) for build in builders]
    response = DashboardResponse(
        role=role,
        role_label=ROLE_LABELS[role],
        generated_at=utcnow(),
        tabs=tabs,
    )

    try:
        if cache is not None:
            await cache.setex(key, _CACHE_TTL_SECONDS, response.model_dump_json())
    except Exception:  # noqa: BLE001
        pass
    return response
