"""Descriptive ("what happened") metrics — Phase 1, all five role dashboards.

On-the-fly MongoDB aggregation over ServiceRequest / ApprovalDecision, scoped
per role. The service layer caches each role's response briefly (Valkey, 60s).

Simplifications noted for the review:
  * Executor capacity uses a constant default (no per-org capacity config yet).
  * CXO "Top Executors" / "Department Health" rows are keyed by id; resolving
    user/department display names needs IAM/replica lookups — deferred.
  * Cross-collection averages (approval latency) use a bounded Python join.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ...common.timestamps import utcnow
from ...models import (
    ApprovalDecision,
    Category,
    Comment,
    DecisionEnum,
    DepartmentReplica,
    EmployeeReplica,
    HandoffEvent,
    HandoffKindEnum,
    PriorityEnum,
    RequestStatusEnum,
    ServiceRequest,
)
from ..periods import fy_start, last_n_month_keys, months_back_start
from ..schemas import Card, Chart, ChartSeries, Section, Table, Tab
from ..scoping import (
    approver_scope,
    cxo_scope,
    department_queue_scope,
    employee_scope,
    executor_scope,
    manager_team_scope,
    org_fy_start_month,
)

# Active = open / in-flight (non-terminal, not yet resolved/closed).
ACTIVE_STATUSES: list[str] = [
    RequestStatusEnum.SUBMITTED.value,
    RequestStatusEnum.PENDING_APPROVAL.value,
    RequestStatusEnum.PENDING_ASSIGNMENT.value,
    RequestStatusEnum.ASSIGNED.value,
    RequestStatusEnum.IN_PROGRESS.value,
]
RESOLVED_STATUSES: list[str] = [
    RequestStatusEnum.RESOLVED.value,
    RequestStatusEnum.CLOSED.value,
]
DEFAULT_EXECUTOR_CAPACITY = 10  # tickets; no per-org config field yet
# External ITSM benchmarks (HLD §5.1 defaults). No config field yet — surfaced
# as context on the CXO Avg Resolution card; make org-configurable later.
INDUSTRY_P50_HOURS = 18
INDUSTRY_P25_HOURS = 12

# Escalation root-cause classification (CXO). HandoffEvent.reason is free text, so
# we keyword-match into buckets. (A dedicated activity/event taxonomy would let us
# classify precisely; this is the best signal available today.)
_ESC_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("SLA Auto-Escalation", ("sla", "auto", "breach")),
    ("Executor Overload", ("overload", "capacity", "workload")),
    ("Approval Delay", ("approval", "approver", "l1", "l2")),
    ("Unassigned", ("unassigned", "no executor", "pending_assignment")),
]


def _classify_escalations(events: list[HandoffEvent]) -> dict[str, int]:
    counts = {label: 0 for label, _ in _ESC_RULES}
    counts["Other / Manual"] = 0
    for e in events:
        reason = (e.reason or "").lower()
        for label, kws in _ESC_RULES:
            if any(k in reason for k in kws):
                counts[label] += 1
                break
        else:
            counts["Other / Manual"] += 1
    nonzero = {k: v for k, v in counts.items() if v}
    return nonzero or {"No escalations": 0}


# ───────────────────────── shared helpers ─────────────────────────

def _today_start(now: datetime) -> datetime:
    return datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)


async def _count(filt: dict[str, Any]) -> int:
    return await ServiceRequest.find(filt).count()


def _approver_or(user, level_field: str) -> list[dict[str, Any]]:
    """"Is the caller the approver of this level?" — snapshot OR override.

    Phase-B escalation (requests/utils/escalation.py) hands the current level to
    one user via `escalation_override_approver_user_id` and leaves the level
    snapshots and `current_level_index` untouched, so matching only
    `level_N_approver_user_id` misses a decision the caller genuinely holds and
    can act on. The approvals queue matches it (requests/service_list.py); these
    tiles read the same population, and a KPI that says 0 while the queue shows
    a ticket is worse than either alone.

    Callers pin `current_level_index` themselves, which is what keeps the
    override attributed to the level it actually applies to.
    """
    return [
        {level_field: user.oid},
        {"escalation_override_approver_user_id": user.oid},
    ]


def _sla_indicator(due: datetime | None, now: datetime) -> dict[str, str]:
    if not due:
        return {"label": "—", "intent": "neutral"}
    hours = (due - now).total_seconds() / 3600
    if hours < 0:
        return {"label": "Breached", "intent": "critical"}
    if hours < 2:
        return {"label": f"⚠ {int(hours)}h left", "intent": "critical"}
    if hours < 12:
        return {"label": f"~{int(hours)}h left", "intent": "warning"}
    days = int(hours // 24)
    return {"label": f"{days}d left" if days >= 1 else f"{int(hours)}h left", "intent": "good"}


async def _category_names(ids: list[Any]) -> dict[Any, str]:
    ids = [i for i in ids if i is not None]
    if not ids:
        return {}
    cats = await Category.find({"_id": {"$in": ids}}).to_list()
    return {c.id: c.name for c in cats}


# Hit when resolved on/before the resolution deadline; considered = resolved OR
# already overdue. Uses $match stages so it works with scopes containing $or.
_HIT_COND = {
    "$cond": [
        {
            "$and": [
                {"$ne": ["$resolved_at", None]},
                {"$ne": ["$resolution_due_by", None]},
                {"$lte": ["$resolved_at", "$resolution_due_by"]},
            ]
        },
        1,
        0,
    ]
}


async def _sla_hit_rate(base: dict[str, Any], now: datetime) -> tuple[int, int, int]:
    rows = await ServiceRequest.aggregate(
        [
            {"$match": base},
            {"$match": {"$or": [{"resolved_at": {"$ne": None}}, {"resolution_due_by": {"$lt": now}}]}},
            {"$group": {"_id": None, "considered": {"$sum": 1}, "hit": {"$sum": _HIT_COND}}},
        ]
    ).to_list()
    if not rows:
        return 0, 0, 0
    hit, considered = rows[0]["hit"], rows[0]["considered"]
    return hit, considered, (round(hit / considered * 100) if considered else 0)


# Resolution-speed clock start. Per HLD Appendix B, the SLA clock resets on
# reassignment, so resolution-duration metrics must measure from reassigned_at
# when present (else submitted_on) — not always submitted_on, which would
# over-count time the *current* executor never owned.
_RES_START: dict[str, Any] = {"$ifNull": ["$reassigned_at", "$submitted_on"]}


def _res_start(t: ServiceRequest) -> datetime | None:
    """Python-side equivalent of `_RES_START` for per-document math."""
    return t.reassigned_at or t.submitted_on


async def _avg_resolution_hours(base: dict[str, Any], since: datetime | None) -> float | None:
    """Mean resolution time (hours), measured from the reassignment-aware clock."""
    end_match: dict[str, Any] = {"$ne": None}
    if since is not None:
        end_match["$gte"] = since
    rows = await ServiceRequest.aggregate(
        [
            {"$match": base},
            {"$match": {"resolved_at": end_match}},
            {"$group": {"_id": None, "avg_ms": {"$avg": {"$subtract": ["$resolved_at", _RES_START]}}}},
        ]
    ).to_list()
    if not rows or rows[0].get("avg_ms") is None:
        return None
    return round(rows[0]["avg_ms"] / 3_600_000, 1)


async def _avg_decision_latency(decision_filter: dict[str, Any], since: datetime) -> float | None:
    """Mean approval-decision latency (hours) = decided_at − parent SR's
    approval_triggered_at, over decisions matching `decision_filter` since
    `since`. Bounded Python join (mirrors the approver builder). Pass an empty
    `decision_filter` for the org-wide benchmark."""
    decisions = await ApprovalDecision.find(
        {**decision_filter, "decided_at": {"$gte": since}, "deleted_on": None}
    ).limit(2000).to_list()
    sr_ids = list({d.service_request_id for d in decisions})
    trig: dict[Any, Any] = {}
    if sr_ids:
        srs = await ServiceRequest.find({"_id": {"$in": sr_ids}}).to_list()
        trig = {s.id: s.approval_triggered_at for s in srs}
    lat = [(d.decided_at - trig[d.service_request_id]).total_seconds() / 3600
           for d in decisions if d.decided_at and trig.get(d.service_request_id)]
    return round(sum(lat) / len(lat), 1) if lat else None


def _hours_ago(label_h: float | None) -> str:
    return f"{label_h}h" if label_h is not None else "—"


async def _employee_names(ids: list[Any]) -> dict[str, str]:
    """Resolve user_ids → display names via the local EmployeeReplica (collection
    'employees'); ids stored as hex strings. Missing names fall back to the id."""
    keys = {str(i) for i in ids if i is not None}
    if not keys:
        return {}
    rows = await EmployeeReplica.find({"_id": {"$in": list(keys)}}).to_list()
    return {r.id: (r.name or r.id) for r in rows}


async def _department_names(ids: list[Any]) -> dict[str, str]:
    """Resolve department_ids → names via the local DepartmentReplica."""
    keys = {str(i) for i in ids if i is not None}
    if not keys:
        return {}
    rows = await DepartmentReplica.find({"_id": {"$in": list(keys)}}).to_list()
    return {r.id: (r.name or r.id) for r in rows}


# ───────────────────────── EMPLOYEE ─────────────────────────

async def _employee_timeline(user, now: datetime, limit: int = 10) -> Table:
    """Recent activity derived from the caller's tickets — lifecycle timestamps
    + comments merged and sorted (no dedicated activity-event collection)."""
    mine = await ServiceRequest.find(employee_scope(user)).sort("-submitted_on").limit(40).to_list()
    by_id = {t.id: t for t in mine}
    lifecycle = [
        ("submitted_on", "Submitted"),
        ("assigned_at", "Assigned"),
        ("first_response_at", "First response"),
        ("approval_triggered_at", "Sent for approval"),
        ("escalated_at", "Escalated"),
        ("resolved_at", "Resolved"),
        ("closed_at", "Closed"),
    ]
    events: list[tuple[datetime, str, str, str]] = []
    for t in mine:
        for field, label in lifecycle:
            ts = getattr(t, field, None)
            if ts:
                events.append((ts, t.ticket_no, label, ""))
    if by_id:
        comments = (
            await Comment.find({"service_request_id": {"$in": list(by_id.keys())}, "deleted_on": None})
            .sort("-created_on")
            .limit(limit)
            .to_list()
        )
        for c in comments:
            tk = by_id.get(c.service_request_id)
            if c.created_on:
                events.append((c.created_on, tk.ticket_no if tk else "—", "Comment", (c.body or "")[:80]))
    events.sort(key=lambda e: e[0], reverse=True)
    rows = [
        {"when": ts.isoformat(), "ticket_no": tn, "event": ev, "detail": d}
        for (ts, tn, ev, d) in events[:limit]
    ]
    return Table(
        id="my_timeline",
        title="Recent Activity",
        columns=[
            {"key": "when", "label": "When", "type": "date"},
            {"key": "ticket_no", "label": "Ticket", "type": "text"},
            {"key": "event", "label": "Event", "type": "text"},
            {"key": "detail", "label": "Detail", "type": "text"},
        ],
        rows=rows,
    )


async def build_employee_descriptive(user) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    scope = employee_scope(user)
    fy = fy_start(now, await org_fy_start_month(user))

    total_raised = await _count({**scope, "submitted_on": {"$gte": fy}})
    resolved = await _count({**scope, "submitted_on": {"$gte": fy}, "request_status": {"$in": RESOLVED_STATUSES}})
    resolution_rate = round(resolved / total_raised * 100) if total_raised else 0
    in_progress = await _count({**scope, "request_status": {"$in": ACTIVE_STATUSES}})
    sla_risk = await _count(
        {**scope, "request_status": {"$in": ACTIVE_STATUSES}, "resolved_at": None,
         "resolution_due_by": {"$gte": now, "$lt": now + timedelta(hours=4)}}
    )
    sla_breached = await _count(
        {**scope, "submitted_on": {"$gte": fy}, "$or": [
            {"first_response_at": None, "first_response_due_by": {"$ne": None, "$lt": now}},
            {"resolved_at": None, "resolution_due_by": {"$ne": None, "$lt": now}},
        ]}
    )
    avg_res = await _avg_resolution_hours(scope, None)
    hit_rows = await ServiceRequest.aggregate([
        {"$match": {**scope, "resolved_at": {"$ne": None}}},
        {"$group": {"_id": None, "n": {"$sum": 1}, "hit": {"$sum": _HIT_COND}}},
    ]).to_list()
    sla_pct = round(hit_rows[0]["hit"] / hit_rows[0]["n"] * 100) if hit_rows and hit_rows[0]["n"] else None
    kpis = Section(id="kpis", title="Overview", cards=[
        Card(id="total_raised", label="Total Raised (FY)", value=total_raised),
        Card(id="resolved", label="Resolved", value=resolved, sub_label=f"{resolution_rate}% resolution rate",
             intent="good" if resolution_rate >= 70 else "neutral", filter={"status_group": "resolved"}),
        Card(id="in_progress", label="In Progress", value=in_progress,
             sub_label=(f"{sla_risk} within 4h SLA" if sla_risk else None),
             intent="warning" if sla_risk else "neutral", filter={"status_group": "open"}),
        Card(id="sla_breached", label="SLA Breached", value=sla_breached,
             intent="critical" if sla_breached else "good", filter={"status_group": "sla_breached"}),
        Card(id="avg_resolution", label="Avg Resolution Time",
             value=(f"{avg_res}h" if avg_res is not None else "—")),
        Card(id="my_sla_hit", label="My SLA Hit Rate",
             value=(f"{sla_pct}%" if sla_pct is not None else "—"),
             intent=(("good" if sla_pct >= 80 else "warning" if sla_pct >= 60 else "critical") if sla_pct is not None else "neutral")),
    ])

    cat_rows = await ServiceRequest.aggregate([
        {"$match": {**scope, "submitted_on": {"$gte": fy}}},
        {"$group": {"_id": "$category_id", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]).to_list()
    cat_names = await _category_names([r["_id"] for r in cat_rows])
    category_chart = Chart(id="requests_by_category", title="Requests by Category", type="doughnut",
                           labels=[cat_names.get(r["_id"], "Unknown") for r in cat_rows],
                           series=[ChartSeries(name="Requests", data=[r["count"] for r in cat_rows])])

    mon_rows = await ServiceRequest.aggregate([
        {"$match": {**scope, "submitted_on": {"$gte": months_back_start(now, 6)}}},
        {"$group": {"_id": {"y": {"$year": "$submitted_on"}, "m": {"$month": "$submitted_on"}}, "count": {"$sum": 1}}},
    ]).to_list()
    counts = {(r["_id"]["y"], r["_id"]["m"]): r["count"] for r in mon_rows}
    keys = last_n_month_keys(now, 6)
    volume_chart = Chart(id="monthly_volume", title="Monthly Request Volume", type="bar",
                         labels=[lbl for (_, _, lbl) in keys],
                         series=[ChartSeries(name="Requests", data=[counts.get((y, m), 0) for (y, m, _) in keys])])
    charts = Section(id="breakdown", title="Breakdown", charts=[category_chart, volume_chart])

    PRI_ORDER = ["low", "medium", "high", "urgent"]
    status_rows = await ServiceRequest.aggregate([
        {"$match": {**scope, "submitted_on": {"$gte": fy}}},
        {"$group": {"_id": "$request_status", "count": {"$sum": 1}}}, {"$sort": {"count": -1}},
    ]).to_list()
    status_chart = Chart(id="requests_by_status", title="Requests by Status", type="doughnut",
                         labels=[str(r["_id"]).replace("_", " ").title() for r in status_rows],
                         series=[ChartSeries(name="Requests", data=[r["count"] for r in status_rows])])
    pri_rows = await ServiceRequest.aggregate([
        {"$match": {**scope, "submitted_on": {"$gte": fy}}},
        {"$group": {"_id": "$priority", "count": {"$sum": 1}}},
    ]).to_list()
    pmap = {r["_id"]: r["count"] for r in pri_rows}
    priority_chart = Chart(id="requests_by_priority", title="Requests by Priority", type="bar",
                           labels=[p.title() for p in PRI_ORDER],
                           series=[ChartSeries(name="Requests", data=[pmap.get(p, 0) for p in PRI_ORDER])])
    charts2 = Section(id="breakdown2", title="Breakdown", charts=[status_chart, priority_chart])

    active = await ServiceRequest.find({**scope, "request_status": {"$in": ACTIVE_STATUSES}}).sort("+resolution_due_by").limit(25).to_list()
    acat_names = await _category_names(list({t.category_id for t in active}))
    active_rows = []
    for t in active:
        ind = _sla_indicator(t.resolution_due_by, now)
        active_rows.append({"ticket_no": t.ticket_no, "category": acat_names.get(t.category_id, "—"),
                            "priority": t.priority.value, "status": t.request_status.value,
                            "sla": ind["label"], "sla_intent": ind["intent"]})
    active_table = Table(id="my_active_tickets", title="My Active Tickets", columns=[
        {"key": "ticket_no", "label": "Ticket", "type": "text"},
        {"key": "category", "label": "Category", "type": "text"},
        {"key": "priority", "label": "Priority", "type": "text"},
        {"key": "status", "label": "Status", "type": "text"},
        {"key": "sla", "label": "SLA", "type": "badge"},
    ], rows=active_rows)
    timeline = await _employee_timeline(user, now)

    recent = await ServiceRequest.find(
        {**scope, "request_status": {"$in": RESOLVED_STATUSES}, "resolved_at": {"$ne": None}}
    ).sort("-resolved_at").limit(10).to_list()
    rcat = await _category_names(list({t.category_id for t in recent}))
    recent_rows = []
    for t in recent:
        start = _res_start(t)
        hrs = (t.resolved_at - start).total_seconds() / 3600 if (t.resolved_at and start) else None
        res_label = "—" if hrs is None else (f"{hrs / 24:.1f}d" if hrs >= 24 else f"{hrs:.0f}h")
        met = t.resolution_due_by is not None and t.resolved_at <= t.resolution_due_by
        recent_rows.append({"ticket_no": t.ticket_no, "category": rcat.get(t.category_id, "—"),
                            "resolution_time": res_label, "sla": "Met" if met else "Missed",
                            "sla_intent": "good" if met else "critical"})
    recently_resolved = Table(id="recently_resolved", title="Recently Resolved", columns=[
        {"key": "ticket_no", "label": "Ticket", "type": "text"},
        {"key": "category", "label": "Category", "type": "text"},
        {"key": "resolution_time", "label": "Resolution Time", "type": "text"},
        {"key": "sla", "label": "SLA", "type": "badge"},
    ], rows=recent_rows)

    tickets = Section(id="tickets", title="My Tickets", tables=[active_table, timeline, recently_resolved])

    return Tab(key="descriptive", label="Descriptive", sections=[kpis, charts, charts2, tickets])


# ───────────────────────── MANAGER ─────────────────────────

async def build_manager_descriptive(user) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    fy = fy_start(now, await org_fy_start_month(user))
    team = await manager_team_scope(user)

    ninety = now - timedelta(days=90)
    team_requests = await _count({**team, "submitted_on": {"$gte": fy}})
    escalated = await _count({**team, "is_escalated": True, "submitted_on": {"$gte": fy}})
    _, _, team_sla = await _sla_hit_rate(team, now)
    _, _, org_sla = await _sla_hit_rate(cxo_scope(user), now)

    pend_rows = await ServiceRequest.aggregate([
        {"$match": {"organisation_id": user.org_oid, "deleted_on": None,
                    "$or": _approver_or(user, "level_1_approver_user_id"),
                    "request_status": RequestStatusEnum.PENDING_APPROVAL.value, "current_level_index": 1}},
        {"$group": {"_id": None, "n": {"$sum": 1}, "oldest": {"$min": "$approval_triggered_at"}}},
    ]).to_list()
    pending_n = pend_rows[0]["n"] if pend_rows else 0
    oldest = pend_rows[0]["oldest"] if pend_rows else None
    oldest_wait = f"{int((now - oldest).total_seconds() // 3600)}h oldest" if oldest else None

    kpis = Section(id="kpis", title="Overview", cards=[
        Card(id="team_requests", label="Team Requests (FY)", value=team_requests),
        Card(id="pending_approvals", label="My Pending Approvals", value=pending_n, sub_label=oldest_wait,
             intent="warning" if pending_n else "neutral"),
        Card(id="team_sla", label="Team SLA Hit Rate", value=f"{team_sla}%", sub_label=f"Org avg: {org_sla}%",
             intent="good" if team_sla >= 80 else ("warning" if team_sla >= 60 else "critical")),
        Card(id="escalated", label="Escalated Tickets", value=escalated,
             intent="critical" if escalated else "good"),
    ])

    status_rows = await ServiceRequest.aggregate([
        {"$match": team}, {"$group": {"_id": "$request_status", "count": {"$sum": 1}}}, {"$sort": {"count": -1}},
    ]).to_list()
    status_chart = Chart(id="team_by_status", title="Team Requests by Status", type="doughnut",
                         labels=[str(r["_id"]) for r in status_rows],
                         series=[ChartSeries(name="Tickets", data=[r["count"] for r in status_rows])])

    cat_rows = await ServiceRequest.aggregate([
        {"$match": {**team, "$or": [{"resolved_at": {"$ne": None}}, {"resolution_due_by": {"$lt": now}}]}},
        {"$group": {"_id": "$category_id", "considered": {"$sum": 1}, "hit": {"$sum": _HIT_COND}}},
        {"$sort": {"considered": -1}}, {"$limit": 10},
    ]).to_list()
    cat_names = await _category_names([r["_id"] for r in cat_rows])
    cat_sla_chart = Chart(id="team_sla_by_category", title="Team SLA Performance by Category", type="bar",
                          labels=[cat_names.get(r["_id"], "Unknown") for r in cat_rows],
                          series=[ChartSeries(name="SLA %", data=[round(r["hit"] / r["considered"] * 100) if r["considered"] else 0 for r in cat_rows])])

    # My approval turnaround vs. the org benchmark (last 90d).
    my_turn = await _avg_decision_latency({"approver_user_id": user.oid}, ninety)
    org_turn = await _avg_decision_latency({}, ninety)
    turnaround_chart = Chart(id="my_approval_turnaround", title="My Approval Turnaround (avg hours)", type="bar",
                             labels=["Me", "Org Avg"],
                             series=[ChartSeries(name="Avg Hours", data=[my_turn or 0, org_turn or 0])])
    charts = Section(id="breakdown", title="Breakdown", charts=[status_chart, cat_sla_chart, turnaround_chart])

    pending = await ServiceRequest.find(
        {"organisation_id": user.org_oid, "deleted_on": None,
         "$or": _approver_or(user, "level_1_approver_user_id"),
         "request_status": RequestStatusEnum.PENDING_APPROVAL.value}
    ).sort("+approval_triggered_at").limit(25).to_list()
    pcat_names = await _category_names(list({t.category_id for t in pending}))
    preq_names = await _employee_names([t.requester_user_id for t in pending])
    prows = []
    for t in pending:
        wait_h = int((now - t.approval_triggered_at).total_seconds() // 3600) if t.approval_triggered_at else None
        intent = "neutral" if wait_h is None else ("critical" if wait_h > 24 else "warning" if wait_h >= 12 else "good")
        prows.append({"ticket_no": t.ticket_no, "requester": preq_names.get(str(t.requester_user_id), "—"),
                      "category": pcat_names.get(t.category_id, "—"),
                      "priority": t.priority.value, "waiting": f"{wait_h}h" if wait_h is not None else "—",
                      "waiting_intent": intent})
    queue = Table(id="pending_queue", title="Pending Approvals Queue", columns=[
        {"key": "ticket_no", "label": "Ticket", "type": "text"},
        {"key": "requester", "label": "Requester", "type": "text"},
        {"key": "category", "label": "Category", "type": "text"},
        {"key": "priority", "label": "Priority", "type": "text"},
        {"key": "waiting", "label": "Waiting", "type": "badge"},
    ], rows=prows)

    return Tab(key="descriptive", label="Descriptive", sections=[kpis, charts, Section(id="queue", title="Approvals", tables=[queue])])


# ───────────────────────── EXECUTOR ─────────────────────────

async def build_executor_descriptive(user) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    scope = executor_scope(user)
    today = _today_start(now)
    thirty_ago = now - timedelta(days=30)

    active = await _count({**scope, "request_status": {"$in": [RequestStatusEnum.ASSIGNED.value, RequestStatusEnum.IN_PROGRESS.value]}})
    resolved_today = await _count({**scope, "request_status": {"$in": RESOLVED_STATUSES}, "resolved_at": {"$gte": today}})
    breach_risk = await _count({**scope, "resolved_at": None,
                                "request_status": {"$in": ACTIVE_STATUSES},
                                "resolution_due_by": {"$gte": now, "$lt": now + timedelta(hours=4)}})
    _, _, my_sla = await _sla_hit_rate({**scope, "resolved_at": {"$gte": thirty_ago}}, now)

    kpis = Section(id="kpis", title="Overview", cards=[
        Card(id="active", label="Active Tickets", value=active, sub_label=f"Capacity {DEFAULT_EXECUTOR_CAPACITY}",
             intent="warning" if active >= DEFAULT_EXECUTOR_CAPACITY else "neutral"),
        Card(id="resolved_today", label="Resolved Today", value=resolved_today, intent="good" if resolved_today else "neutral"),
        Card(id="breach_risk", label="SLA Breach Risk", value=breach_risk, intent="critical" if breach_risk else "good"),
        Card(id="my_sla", label="My SLA Hit Rate (30d)", value=f"{my_sla}%",
             intent="good" if my_sla >= 80 else ("warning" if my_sla >= 60 else "critical")),
    ])

    # Capacity meter (as a bar of percentages).
    urgent = await _count({**scope, "request_status": {"$in": [RequestStatusEnum.ASSIGNED.value, RequestStatusEnum.IN_PROGRESS.value]}, "priority": PriorityEnum.URGENT.value})
    cap_pct = round(active / DEFAULT_EXECUTOR_CAPACITY * 100) if DEFAULT_EXECUTOR_CAPACITY else 0
    urgent_pct = round(urgent / active * 100) if active else 0
    risk_pct = round(breach_risk / active * 100) if active else 0
    capacity_chart = Chart(id="capacity", title="My Current Capacity", type="bar",
                           labels=["Active", "Urgent", "Near SLA"],
                           series=[ChartSeries(name="%", data=[cap_pct, urgent_pct, risk_pct])])

    # Resolution-time distribution (resolved last 30d).
    dist_rows = await ServiceRequest.aggregate([
        {"$match": {**scope, "resolved_at": {"$gte": thirty_ago, "$ne": None}, "submitted_on": {"$ne": None}}},
        {"$project": {"h": {"$divide": [{"$subtract": ["$resolved_at", _RES_START]}, 3_600_000]}}},
        {"$bucket": {"groupBy": "$h", "boundaries": [0, 4, 12, 24, 1_000_000], "default": "other",
                     "output": {"count": {"$sum": 1}}}},
    ]).to_list()
    bucket_labels = {0: "<4h", 4: "4–12h", 12: "12–24h", 24: ">24h"}
    dist_map = {r["_id"]: r["count"] for r in dist_rows}
    dist_chart = Chart(id="resolution_distribution", title="Resolution Time Distribution", type="doughnut",
                       labels=list(bucket_labels.values()),
                       series=[ChartSeries(name="Tickets", data=[dist_map.get(b, 0) for b in bucket_labels])])
    charts = Section(id="breakdown", title="Breakdown", charts=[capacity_chart, dist_chart])

    active_list = await ServiceRequest.find({**scope, "request_status": {"$in": ACTIVE_STATUSES}}).sort("+resolution_due_by").limit(25).to_list()
    acat = await _category_names(list({t.category_id for t in active_list}))
    arows = []
    for t in active_list:
        ind = _sla_indicator(t.resolution_due_by, now)
        arows.append({"ticket_no": t.ticket_no, "category": acat.get(t.category_id, "—"),
                      "priority": t.priority.value, "status": t.request_status.value,
                      "sla": ind["label"], "sla_intent": ind["intent"]})
    active_table = Table(id="my_active_sla", title="My Active Tickets — SLA Status", columns=[
        {"key": "ticket_no", "label": "Ticket", "type": "text"},
        {"key": "category", "label": "Category", "type": "text"},
        {"key": "priority", "label": "Priority", "type": "text"},
        {"key": "status", "label": "Status", "type": "text"},
        {"key": "sla", "label": "SLA", "type": "badge"},
    ], rows=arows)
    tables = [active_table]

    dq = await department_queue_scope(user)
    if dq is not None:
        queue = await ServiceRequest.find(
            {**dq, "request_status": RequestStatusEnum.PENDING_ASSIGNMENT.value, "requester_user_id": {"$ne": user.oid}}
        ).sort("+submitted_on").limit(25).to_list()
        qcat = await _category_names(list({t.category_id for t in queue}))
        qrows = [{"ticket_no": t.ticket_no, "category": qcat.get(t.category_id, "—"),
                  "priority": t.priority.value, "submitted_on": t.submitted_on.isoformat() if t.submitted_on else "—"} for t in queue]
        tables.append(Table(id="dept_queue", title="Department Queue — Available to Self-Assign", columns=[
            {"key": "ticket_no", "label": "Ticket", "type": "text"},
            {"key": "category", "label": "Category", "type": "text"},
            {"key": "priority", "label": "Priority", "type": "text"},
            {"key": "submitted_on", "label": "Submitted", "type": "date"},
        ], rows=qrows))

    return Tab(key="descriptive", label="Descriptive", sections=[kpis, charts, Section(id="work", title="My Work", tables=tables)])


# ───────────────────────── APPROVER ─────────────────────────

async def _approval_counts(user, decision: str, since: datetime) -> int:
    return await ApprovalDecision.find(
        {"approver_user_id": user.oid, "decision": decision, "decided_at": {"$gte": since}, "deleted_on": None}
    ).count()


async def build_approver_descriptive(user) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    fy = fy_start(now, await org_fy_start_month(user))
    ninety_ago = now - timedelta(days=90)
    org = user.org_oid

    l1_pending = await _count({"organisation_id": org, "deleted_on": None,
                               "$or": _approver_or(user, "level_1_approver_user_id"),
                               "current_level_index": 1, "request_status": RequestStatusEnum.PENDING_APPROVAL.value})
    l2_pending = await _count({"organisation_id": org, "deleted_on": None,
                               "$or": _approver_or(user, "level_2_approver_user_id"),
                               "current_level_index": 2, "request_status": RequestStatusEnum.PENDING_APPROVAL.value})
    approved = await _approval_counts(user, DecisionEnum.APPROVED.value, fy)
    rejected = await _approval_counts(user, DecisionEnum.REJECTED.value, fy)
    decided_total = approved + rejected
    approval_rate = round(approved / decided_total * 100) if decided_total else 0
    rejection_rate = round(rejected / decided_total * 100) if decided_total else 0

    # Avg decision time + per-priority turnaround (bounded Python join:
    # decision.decided_at − SR.approval_triggered_at, grouped by SR.priority).
    decisions = await ApprovalDecision.find(
        {"approver_user_id": user.oid, "decided_at": {"$gte": ninety_ago}, "deleted_on": None}
    ).limit(1000).to_list()
    sr_ids = list({d.service_request_id for d in decisions})
    sr_map: dict[Any, ServiceRequest] = {}
    if sr_ids:
        srs = await ServiceRequest.find({"_id": {"$in": sr_ids}}).to_list()
        sr_map = {s.id: s for s in srs}
    lat: list[float] = []
    pri_lat: dict[str, list[float]] = {}
    for d in decisions:
        sr = sr_map.get(d.service_request_id)
        if not (d.decided_at and sr and sr.approval_triggered_at):
            continue
        hrs = (d.decided_at - sr.approval_triggered_at).total_seconds() / 3600
        lat.append(hrs)
        pri_lat.setdefault(sr.priority.value, []).append(hrs)
    avg_decision_h = round(sum(lat) / len(lat), 1) if lat else None
    org_decision_h = await _avg_decision_latency({}, ninety_ago)  # org-wide benchmark

    kpis = Section(id="kpis", title="Overview", cards=[
        Card(id="pending", label="Pending My Decision", value=l1_pending + l2_pending,
             sub_label=f"{l1_pending} L1 · {l2_pending} L2", intent="warning" if (l1_pending + l2_pending) else "neutral"),
        Card(id="approved", label="Approved (FY)", value=approved, sub_label=f"{approval_rate}% approval rate", intent="good"),
        Card(id="rejected", label="Rejected (FY)", value=rejected, sub_label=f"{rejection_rate}% rejection rate",
             intent="warning" if rejection_rate > 15 else "neutral"),
        Card(id="avg_decision", label="Avg Decision Time", value=_hours_ago(avg_decision_h),
             sub_label=f"Org benchmark: {_hours_ago(org_decision_h)}"),
    ])

    decision_chart = Chart(id="decision_distribution", title="Decision Distribution", type="doughnut",
                           labels=["Approved", "Rejected"], series=[ChartSeries(name="Decisions", data=[approved, rejected])])

    vol_rows = await ApprovalDecision.aggregate([
        {"$match": {"approver_user_id": user.oid, "decided_at": {"$gte": months_back_start(now, 6)}, "deleted_on": None}},
        {"$group": {"_id": {"y": {"$year": "$decided_at"}, "m": {"$month": "$decided_at"}, "d": "$decision"}, "count": {"$sum": 1}}},
    ]).to_list()
    appr_map = {(r["_id"]["y"], r["_id"]["m"]): r["count"] for r in vol_rows if r["_id"]["d"] == DecisionEnum.APPROVED.value}
    rej_map = {(r["_id"]["y"], r["_id"]["m"]): r["count"] for r in vol_rows if r["_id"]["d"] == DecisionEnum.REJECTED.value}
    keys = last_n_month_keys(now, 6)
    volume_chart = Chart(id="monthly_approvals", title="Monthly Approval Volume", type="bar", stacked=True,
                         labels=[lbl for (_, _, lbl) in keys],
                         series=[ChartSeries(name="Approved", data=[appr_map.get((y, m), 0) for (y, m, _) in keys]),
                                 ChartSeries(name="Rejected", data=[rej_map.get((y, m), 0) for (y, m, _) in keys])])

    pri_order = [p.value for p in PriorityEnum]
    turnaround_pri = Chart(id="turnaround_by_priority", title="Approval Turnaround by Priority (avg hours)", type="bar",
                           labels=[p.title() for p in pri_order],
                           series=[ChartSeries(name="Avg Hours",
                                               data=[round(sum(pri_lat[p]) / len(pri_lat[p]), 1) if pri_lat.get(p) else 0
                                                     for p in pri_order])])
    charts = Section(id="breakdown", title="Breakdown", charts=[decision_chart, volume_chart, turnaround_pri])

    pending = await ServiceRequest.find(approver_scope(user) | {"request_status": RequestStatusEnum.PENDING_APPROVAL.value}).sort("+approval_triggered_at").limit(25).to_list()
    pcat = await _category_names(list({t.category_id for t in pending}))
    prows = []
    for t in pending:
        wait_h = int((now - t.approval_triggered_at).total_seconds() // 3600) if t.approval_triggered_at else None
        level = "L2" if t.current_level_index == 2 else "L1"
        prows.append({"ticket_no": t.ticket_no, "category": pcat.get(t.category_id, "—"),
                      "level": level, "priority": t.priority.value,
                      "waiting": f"{wait_h}h" if wait_h is not None else "—"})
    queue = Table(id="pending_decisions", title="Pending Decisions Queue", columns=[
        {"key": "ticket_no", "label": "Ticket", "type": "text"},
        {"key": "category", "label": "Category", "type": "text"},
        {"key": "level", "label": "Level", "type": "badge"},
        {"key": "priority", "label": "Priority", "type": "text"},
        {"key": "waiting", "label": "Waiting", "type": "text"},
    ], rows=prows)

    return Tab(key="descriptive", label="Descriptive", sections=[kpis, charts, Section(id="queue", title="Decisions", tables=[queue])])


# ───────────────────────── CXO ─────────────────────────

async def build_cxo_descriptive(user, restrict_category_ids: list | None = None) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    fy = fy_start(now, await org_fy_start_month(user))
    ninety_ago = now - timedelta(days=90)
    # View-BU mode narrows the org-wide scope to one business unit's categories.
    base = cxo_scope(user)
    if restrict_category_ids is not None:
        base = {**base, "category_id": {"$in": restrict_category_ids}}

    # Category → department map (+ names): reused by the breach-breakdown KPI,
    # the dept-health table, and name resolution.
    cats = await Category.find({"organisation_id": user.org_oid, "deleted_on": None}).to_list()
    # One department per category: a ticket is one row in the dept-health table,
    # so a multi-department category is counted under its primary department —
    # department_ids[0] (D10). Splitting the count across departments would make
    # the column totals exceed the ticket count.
    from ...categories.service import category_department_ids

    cat_dept = {
        c.id: (category_department_ids(c) or [None])[0] for c in cats
    }
    dept_names = await _department_names([d for d in cat_dept.values() if d is not None])

    _, _, sla_compliance = await _sla_hit_rate({**base, "submitted_on": {"$gte": fy}}, now)
    # QoQ trajectory: trailing-90d window vs. the prior 90d window.
    _, _, cur_q = await _sla_hit_rate({**base, "submitted_on": {"$gte": ninety_ago}}, now)
    _, _, prev_q = await _sla_hit_rate(
        {**base, "submitted_on": {"$gte": now - timedelta(days=180), "$lt": ninety_ago}}, now)
    qoq = cur_q - prev_q

    avg_resolution = await _avg_resolution_hours(base, ninety_ago)
    avg_latency = await _avg_decision_latency({"organisation_id": user.org_oid}, ninety_ago)

    breach_filter = {**base, "resolved_at": None, "request_status": {"$in": ACTIVE_STATUSES},
                     "resolution_due_by": {"$lt": now}}
    active_breaches = await _count(breach_filter)
    br_rows = await ServiceRequest.aggregate([
        {"$match": breach_filter},
        {"$group": {"_id": "$category_id", "n": {"$sum": 1}}},
    ]).to_list()
    br_by_dept: dict[Any, int] = {}
    for r in br_rows:
        dep = cat_dept.get(r["_id"])
        if dep is not None:
            br_by_dept[dep] = br_by_dept.get(dep, 0) + r["n"]
    breach_break = " · ".join(
        f"{n} {dept_names.get(str(dep), str(dep))}"
        for dep, n in sorted(br_by_dept.items(), key=lambda kv: kv[1], reverse=True)[:3]
    ) or None

    total_fy = await _count({**base, "submitted_on": {"$gte": fy}})
    prev_fy_start = fy.replace(year=fy.year - 1)
    total_prev_fy = await _count({**base, "submitted_on": {"$gte": prev_fy_start, "$lt": fy}})
    yoy = round((total_fy / total_prev_fy - 1) * 100) if total_prev_fy else None

    escalated_fy = await _count({**base, "is_escalated": True, "submitted_on": {"$gte": fy}})
    esc_rate = round(escalated_fy / total_fy * 100) if total_fy else 0

    kpis = Section(id="kpis", title="Executive Scorecard", cards=[
        Card(id="sla_compliance", label="SLA Compliance Rate", value=f"{sla_compliance}%",
             sub_label=f"Target 85% · QoQ {'+' if qoq >= 0 else ''}{qoq}pp",
             intent="good" if sla_compliance >= 85 else ("warning" if sla_compliance >= 70 else "critical")),
        Card(id="avg_resolution", label="Avg Resolution Time", value=_hours_ago(avg_resolution),
             sub_label=f"Industry P50 {INDUSTRY_P50_HOURS}h · P25 {INDUSTRY_P25_HOURS}h"),
        Card(id="active_breaches", label="Active SLA Breaches", value=active_breaches, sub_label=breach_break,
             intent="critical" if active_breaches else "good"),
        Card(id="total_fy", label="Total Tickets (FY)", value=total_fy,
             sub_label=(f"{'+' if yoy >= 0 else ''}{yoy}% vs last FY" if yoy is not None else None)),
        Card(id="avg_approval_latency", label="Avg Approval Latency", value=_hours_ago(avg_latency),
             sub_label="Target 8h"),
        Card(id="escalated", label="Escalated (FY)", value=escalated_fy, sub_label=f"{esc_rate}% escalation rate"),
    ])

    # Volume by category.
    cat_rows = await ServiceRequest.aggregate([
        {"$match": {**base, "submitted_on": {"$gte": fy}}},
        {"$group": {"_id": "$category_id", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}, {"$limit": 10},
    ]).to_list()
    cat_names = await _category_names([r["_id"] for r in cat_rows])
    vol_by_cat = Chart(id="volume_by_category", title="Request Volume by Category", type="bar",
                       labels=[cat_names.get(r["_id"], "Unknown") for r in cat_rows],
                       series=[ChartSeries(name="Requests", data=[r["count"] for r in cat_rows])])

    # SLA by priority.
    pri_labels, pri_data = [], []
    for pri in PriorityEnum:
        _, _, pct = await _sla_hit_rate({**base, "priority": pri.value, "submitted_on": {"$gte": fy}}, now)
        pri_labels.append(pri.value.title())
        pri_data.append(pct)
    sla_by_pri = Chart(id="sla_by_priority", title="Org-Wide SLA Performance by Priority", type="bar",
                       labels=pri_labels, series=[ChartSeries(name="SLA %", data=pri_data)])

    # Escalation root-cause analysis (org, FY) — classify HandoffEvent escalations.
    esc_events = await HandoffEvent.find(
        {"organisation_id": user.org_oid, "kind": HandoffKindEnum.ESCALATION.value, "happened_at": {"$gte": fy}}
    ).limit(5000).to_list()
    cause_counts = _classify_escalations(esc_events)
    esc_root = Chart(id="escalation_root_cause", title="Escalation Root Cause Analysis", type="bar",
                     labels=list(cause_counts.keys()),
                     series=[ChartSeries(name="Escalations", data=list(cause_counts.values()))])
    charts = Section(id="breakdown", title="Breakdown", charts=[vol_by_cat, sla_by_pri, esc_root])

    # Top executors (last 90d) — names resolved via EmployeeReplica.
    exec_rows = await ServiceRequest.aggregate([
        {"$match": {**base, "executor_user_id": {"$ne": None}, "resolved_at": {"$gte": ninety_ago}}},
        {"$group": {"_id": "$executor_user_id", "resolved": {"$sum": 1}, "hit": {"$sum": _HIT_COND}}},
        {"$sort": {"resolved": -1}}, {"$limit": 10},
    ]).to_list()
    exec_names = await _employee_names([r["_id"] for r in exec_rows])
    exec_table = Table(id="top_executors", title="Top Executors (90d)", columns=[
        {"key": "executor", "label": "Executor", "type": "text"},
        {"key": "resolved", "label": "Resolved", "type": "number"},
        {"key": "sla", "label": "SLA %", "type": "number"},
    ], rows=[{"executor": exec_names.get(str(r["_id"]), str(r["_id"])), "resolved": r["resolved"],
              "sla": round(r["hit"] / r["resolved"] * 100) if r["resolved"] else 0} for r in exec_rows])

    # Department health: per-category hit/considered rolled up to department
    # (cat_dept / dept_names computed once at the top of this builder).
    dept_rows = await ServiceRequest.aggregate([
        {"$match": {**base, "$or": [{"resolved_at": {"$ne": None}}, {"resolution_due_by": {"$lt": now}}]}},
        {"$group": {"_id": "$category_id", "considered": {"$sum": 1}, "hit": {"$sum": _HIT_COND}}},
    ]).to_list()
    dept_agg: dict[Any, dict[str, int]] = {}
    for r in dept_rows:
        dep = cat_dept.get(r["_id"])
        if dep is None:
            continue
        d = dept_agg.setdefault(dep, {"hit": 0, "considered": 0})
        d["hit"] += r["hit"]
        d["considered"] += r["considered"]
    dept_health_rows = []
    for dep, v in sorted(dept_agg.items(), key=lambda kv: kv[1]["considered"], reverse=True):
        pct = round(v["hit"] / v["considered"] * 100) if v["considered"] else 0
        status, intent = ("Healthy", "good") if pct >= 85 else (("Monitor", "warning") if pct >= 70 else ("Critical", "critical"))
        dept_health_rows.append({"department": dept_names.get(str(dep), str(dep)), "sla": pct,
                                 "status": status, "status_intent": intent})
    dept_table = Table(id="department_health", title="Department SRM Health", columns=[
        {"key": "department", "label": "Department", "type": "text"},
        {"key": "sla", "label": "SLA %", "type": "number"},
        {"key": "status", "label": "Status", "type": "badge"},
    ], rows=dept_health_rows)

    return Tab(key="descriptive", label="Descriptive",
               sections=[kpis, charts, Section(id="tables", title="Performance", tables=[exec_table, dept_table])])
