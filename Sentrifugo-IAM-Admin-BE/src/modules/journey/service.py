"""Journey read service — serves timelines + metrics from IAM's own collections
(no fan-out to other services at read time)."""
from typing import Optional

from beanie import PydanticObjectId
from pydantic import BaseModel, Field

from src.auth.models import UserDocument
from src.modules.journey.models import JourneyMetricsDocument, JourneyTimelineDocument
from src.modules.organisation.models import EmployeeDocument


class _EmployeeGraphProjection(BaseModel):
    """Minimal projection for reporting-graph traversal — reads only the two
    fields it needs, skipping encrypted/heavy fields like ``ctc``."""

    user_id: Optional[PydanticObjectId] = None
    l1_manager_id: Optional[PydanticObjectId] = Field(default=None)
    employment_status: Optional[PydanticObjectId] = None


async def _active_employment_status_ids() -> list[PydanticObjectId]:
    """Ids of EMPLOYMENT_STATUSES master-data rows flagged active — the same
    'active employee' definition the directory and graph endpoints use."""
    from src.master_data.models import MasterDataDocument
    docs = await MasterDataDocument.find(
        {"category": "EMPLOYMENT_STATUSES", "is_active": True}
    ).to_list()
    return [d.id for d in docs]


class _EmployeeCodeProjection(BaseModel):
    """Minimal projection for user-detail enrichment — only the fields read back,
    skipping encrypted columns that fail full-document validation."""

    user_id: Optional[PydanticObjectId] = None
    emp_code: Optional[str] = None


# Timeline event types that must NOT surface in any journey API (leave allocation
# and service-request events are excluded from the read path — covers existing and
# future rows regardless of what the consumer stored).
_EXCLUDED_TIMELINE_EVENTS = ["leave_allocated", "service_request_raised", "notice_period_adjusted"]


def _to_oid(val) -> Optional[PydanticObjectId]:
    try:
        return PydanticObjectId(val) if val else None
    except Exception:
        return None


def _ser_event(t: JourneyTimelineDocument) -> dict:
    return {
        "id": str(t.id),
        "event_type": t.event_type,
        "title": t.title,
        "description": t.description,
        "occurred_at": t.occurred_at.isoformat() if t.occurred_at else None,
        "source_service": t.source_service,
        "metadata": t.metadata or {},
    }


def _ser_metric(m: JourneyMetricsDocument) -> dict:
    return {
        "period": m.period,
        "worked_hours": m.worked_hours,
        "service_requests_count": m.service_requests_count,
    }


async def get_team_user_ids(
    manager_user_id: str,
    org_id: Optional[str] = None,
    *,
    include_self: bool = False,
    active_only: bool = False,
    max_levels: int = 10,
) -> list[str]:
    """Every employee in the caller's reporting sub-tree (direct + indirect
    reports), walking the ``l1_manager_id`` graph. A team lead gets their few
    reports; higher management gets their whole branch.

    With ``active_only`` the returned set is limited to employees on an active
    employment status — but the traversal still descends THROUGH an inactive
    manager, so reports beneath someone who has exited are not lost."""
    from src.modules.organisation.models import EmployeeDocument

    mgr_oid = _to_oid(manager_user_id)
    if not mgr_oid:
        return []
    org_oid = _to_oid(org_id)
    active_ids = set(await _active_employment_status_ids()) if active_only else set()

    collected: set[str] = set()
    visited: set[str] = {manager_user_id}
    frontier: list = [mgr_oid]
    for _ in range(max_levels):
        if not frontier:
            break
        query: dict = {"l1_manager_id": {"$in": frontier}, "deleted_on": None}
        if org_oid:
            query["organisation_id"] = org_oid
        reports = await EmployeeDocument.find(query).project(
            _EmployeeGraphProjection
        ).to_list()
        next_frontier = []
        for r in reports:
            if not r.user_id:
                continue
            uid = str(r.user_id)
            if uid in visited:
                continue
            visited.add(uid)
            # Traverse through everyone (so an inactive manager's reports are still
            # reached); only the collected result set honours active_only.
            next_frontier.append(r.user_id)
            if active_only and r.employment_status not in active_ids:
                continue
            collected.add(uid)
        frontier = next_frontier

    if include_self:
        collected.add(manager_user_id)
    return list(collected)


async def get_journeys(user_ids: list[str], org_id: Optional[str] = None) -> dict:
    """Return ``{user_id: {timeline: [...desc], metrics: [...]}}`` for the given
    users, scoped to ``org_id`` when provided."""
    oids = [oid for oid in (_to_oid(u) for u in user_ids) if oid is not None]
    result: dict[str, dict] = {
        str(oid): {"timeline": [], "metrics": []} for oid in oids
    }
    if not oids:
        return result

    query: dict = {"user_id": {"$in": oids}}
    org_oid = _to_oid(org_id)
    if org_oid:
        query["organisation_id"] = org_oid

    timeline_query = {**query, "event_type": {"$nin": _EXCLUDED_TIMELINE_EVENTS}}
    timeline = (
        await JourneyTimelineDocument.find(timeline_query).sort("-occurred_at").to_list()
    )
    metrics = await JourneyMetricsDocument.find(query).to_list()

    for t in timeline:
        result.setdefault(str(t.user_id), {"timeline": [], "metrics": []})
        result[str(t.user_id)]["timeline"].append(_ser_event(t))
    for m in metrics:
        result.setdefault(str(m.user_id), {"timeline": [], "metrics": []})
        result[str(m.user_id)]["metrics"].append(_ser_metric(m))

    # Metrics read better most-recent-period first.
    for entry in result.values():
        entry["metrics"].sort(key=lambda x: x["period"], reverse=True)

    return result


async def enrich_with_user_details(result: dict) -> dict:
    """Add name and emp_code to each entry in a get_journeys result dict."""
    oids = [_to_oid(uid) for uid in result if _to_oid(uid)]
    if not oids:
        return result

    users = await UserDocument.find({"_id": {"$in": oids}}).to_list()
    employees = await EmployeeDocument.find(
        {"user_id": {"$in": oids}, "deleted_on": None}
    ).project(_EmployeeCodeProjection).to_list()

    user_map = {str(u.id): u for u in users}
    emp_map = {str(e.user_id): e for e in employees}

    for uid, entry in result.items():
        user = user_map.get(uid)
        emp = emp_map.get(uid)
        entry["name"] = f"{(user.first_name or '').strip()} {(user.last_name or '').strip()}".strip() if user else None
        entry["emp_code"] = emp.emp_code if emp else None

    return result
