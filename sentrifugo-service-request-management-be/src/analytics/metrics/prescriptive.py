"""Prescriptive ("what to do") metrics — Employee dashboard (sr_hld §1.2)."""
from __future__ import annotations

from datetime import datetime, timedelta

from ...common.timestamps import utcnow
from ...models import RequestStatusEnum, ServiceRequest
from ..schemas import Alert, Chart, ChartSeries, Section, Tab
from ..scoping import employee_scope
from .descriptive import ACTIVE_STATUSES, RESOLVED_STATUSES, _category_names


async def _weekday_tip(scope: dict, now: datetime) -> Alert | None:
    """SLA breach rate by weekday-of-submission; nudge if Friday >> Monday."""
    rows = await ServiceRequest.aggregate(
        [
            {"$match": {**scope, "submitted_on": {"$ne": None}, "request_status": {"$in": RESOLVED_STATUSES}}},
            {"$project": {
                "dow": {"$dayOfWeek": "$submitted_on"},  # 1=Sun … 6=Fri 7=Sat
                "breached": {"$cond": [{"$and": [
                    {"$ne": ["$resolution_due_by", None]}, {"$ne": ["$resolved_at", None]},
                    {"$gt": ["$resolved_at", "$resolution_due_by"]}]}, 1, 0]},
            }},
            {"$group": {"_id": "$dow", "n": {"$sum": 1}, "b": {"$sum": "$breached"}}},
        ]
    ).to_list()
    rate = {r["_id"]: (r["b"] / r["n"] if r["n"] else 0) for r in rows}
    mon, fri = rate.get(2), rate.get(6)
    if mon is not None and fri is not None and fri > 0 and fri > max(mon, 0.0001) * 1.5:
        return Alert(id="submit-early", severity="info", title="Submit requests earlier in the week",
                     message=f"Your Friday submissions miss SLA {fri*100:.0f}% of the time vs {mon*100:.0f}% on Mondays — raise non-urgent requests early in the week.")
    return None


async def _resolution_vs_target(scope: dict) -> Chart | None:
    rows = await ServiceRequest.aggregate(
        [
            {"$match": {**scope, "request_status": {"$in": RESOLVED_STATUSES},
                        "resolved_at": {"$ne": None}, "submitted_on": {"$ne": None}}},
            {"$group": {"_id": "$category_id",
                        "actual_ms": {"$avg": {"$subtract": ["$resolved_at", "$submitted_on"]}},
                        "target_ms": {"$avg": {"$cond": [{"$ne": ["$resolution_due_by", None]},
                                                          {"$subtract": ["$resolution_due_by", "$submitted_on"]}, None]}}}},
            {"$sort": {"actual_ms": -1}}, {"$limit": 8},
        ]
    ).to_list()
    if not rows:
        return None
    names = await _category_names([r["_id"] for r in rows])
    return Chart(
        id="resolution_vs_target", title="My Resolution Time by Category (hrs)", type="bar",
        labels=[names.get(r["_id"], "Unknown") for r in rows],
        series=[
            ChartSeries(name="Avg Resolution", data=[round((r.get("actual_ms") or 0) / 3_600_000, 1) for r in rows]),
            ChartSeries(name="SLA Target", data=[round((r.get("target_ms") or 0) / 3_600_000, 1) for r in rows]),
        ],
    )


async def build_employee_prescriptive(user) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    scope = employee_scope(user)
    alerts: list[Alert] = []

    # SLA breach imminent — active tickets within 2h of resolution deadline.
    at_risk = await (
        ServiceRequest.find({**scope, "request_status": {"$in": ACTIVE_STATUSES}, "resolved_at": None,
                             "resolution_due_by": {"$ne": None, "$gte": now, "$lt": now + timedelta(hours=2)}})
        .sort("+resolution_due_by").limit(3).to_list()
    )
    cat = await _category_names(list({t.category_id for t in at_risk}))
    for t in at_risk:
        hrs = (t.resolution_due_by - now).total_seconds() / 3600
        msg = f"{cat.get(t.category_id, '—')} · ~{hrs:.1f}h to resolution SLA."
        if hrs < 1:
            msg += " Auto-escalation imminent — contact the executor now."
        alerts.append(Alert(id=f"breach:{t.ticket_no}", severity="warning",
                            title=f"{t.ticket_no} — SLA Breach Imminent", message=msg))

    # Withdraw stale pending-approval requests (>18h waiting).
    stale = await (
        ServiceRequest.find({**scope, "request_status": RequestStatusEnum.PENDING_APPROVAL.value,
                             "approval_triggered_at": {"$ne": None, "$lt": now - timedelta(hours=18)}})
        .limit(3).to_list()
    )
    for t in stale:
        alerts.append(Alert(id=f"withdraw:{t.ticket_no}", severity="success",
                            title=f"Withdraw {t.ticket_no} if no longer needed",
                            message="Pending approval for over 18h. If it's no longer urgent, withdraw before it enters In Progress."))

    # Add-description tip — active tickets with no description.
    thin = await (
        ServiceRequest.find({**scope, "request_status": {"$in": ACTIVE_STATUSES},
                             "$or": [{"description": None}, {"description": ""}]}).limit(5).to_list()
    )
    if thin:
        alerts.append(Alert(id="add-desc", severity="info", title="Add detail to speed up resolution",
                            message=f"Requests with detailed descriptions resolve faster. Add context to: {', '.join(t.ticket_no for t in thin)}."))

    tip = await _weekday_tip(scope, now)
    if tip:
        alerts.append(tip)

    if not alerts:
        alerts.append(Alert(id="all-clear", severity="success", title="No actions needed",
                            message="None of your tickets need attention right now."))

    chart = await _resolution_vs_target(scope)
    sections = [Section(id="alerts", title="Actions & Recommendations", alerts=alerts)]
    if chart:
        sections.append(Section(id="presc-charts", title="Service Performance", charts=[chart]))
    return Tab(key="prescriptive", label="Prescriptive", sections=sections)
