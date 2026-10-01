"""Predictive ("what will happen") metrics — Employee dashboard (sr_hld §1.3).

Heuristic estimates computed from live data per the documented formulas; numbers
are forecasts, not guarantees.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from ...common.timestamps import utcnow
from ...models import ApprovalDecision, DecisionEnum, RequestStatusEnum, ServiceRequest
from ..schemas import Card, Section, Tab
from ..scoping import employee_scope
from .descriptive import ACTIVE_STATUSES, RESOLVED_STATUSES, _category_names

ASSIGNABLE = [RequestStatusEnum.ASSIGNED.value, RequestStatusEnum.IN_PROGRESS.value]


async def _avg_subtract_hours(match: dict, end: str, start: str) -> float | None:
    rows = await ServiceRequest.aggregate(
        [{"$match": match}, {"$group": {"_id": None, "avg": {"$avg": {"$subtract": [f"${end}", f"${start}"]}}}}]
    ).to_list()
    if not rows or rows[0].get("avg") is None:
        return None
    return rows[0]["avg"] / 3_600_000


async def _breach_probability(scope: dict, now: datetime) -> Card:
    t = await (
        ServiceRequest.find({**scope, "request_status": {"$in": ACTIVE_STATUSES}, "resolved_at": None,
                             "resolution_due_by": {"$ne": None}}).sort("+resolution_due_by").limit(1).to_list()
    )
    if not t:
        return Card(id="breach_prob", label="Breach Probability", value="—", intent="good",
                    sub_label="No active tickets at risk")
    t = t[0]
    remaining_h = (t.resolution_due_by - now).total_seconds() / 3600
    cat_avg = await _avg_subtract_hours(
        {"category_id": t.category_id, "request_status": {"$in": RESOLVED_STATUSES},
         "resolved_at": {"$ne": None}, "submitted_on": {"$ne": None}}, "resolved_at", "submitted_on"
    ) or max(remaining_h, 1.0)
    base = max(0.0, 1 - remaining_h / max(cat_avg, 0.1))
    qdepth = 0
    if t.executor_user_id:
        qdepth = await ServiceRequest.find(
            {"organisation_id": t.organisation_id, "executor_user_id": t.executor_user_id,
             "request_status": {"$in": ASSIGNABLE}}).count()
    prob = round(min(1.0, base + min(0.2, max(0, qdepth - 5) * 0.04)) * 100)
    intent = "critical" if prob >= 70 else "warning" if prob >= 40 else "good"
    return Card(id="breach_prob", label="Breach Probability", value=f"~{prob}%", intent=intent,
                sub_label=f"{t.ticket_no}: {remaining_h:.1f}h left vs ~{cat_avg:.0f}h category avg · executor queue {qdepth}.")


async def _approval_probability(scope: dict, now: datetime) -> Card:
    t = await (
        ServiceRequest.find({**scope, "request_status": RequestStatusEnum.PENDING_APPROVAL.value,
                             "level_1_approver_user_id": {"$ne": None}}).sort("+approval_triggered_at").limit(1).to_list()
    )
    if not t:
        return Card(id="approval_prob", label="Approval Probability", value="—", intent="neutral",
                    sub_label="No requests awaiting approval")
    t = t[0]
    since = now - timedelta(days=90)
    base = {"approver_user_id": t.level_1_approver_user_id, "decided_at": {"$gte": since}, "deleted_on": None}
    total = await ApprovalDecision.find(base).count()
    approved = await ApprovalDecision.find({**base, "decision": DecisionEnum.APPROVED.value}).count()
    if not total:
        return Card(id="approval_prob", label="Approval Probability", value="—", intent="neutral",
                    sub_label=f"{t.ticket_no}: no approval history for your L1 approver yet.")
    rate = round(approved / total * 100)
    intent = "good" if rate >= 70 else "warning" if rate >= 40 else "critical"
    return Card(id="approval_prob", label="Approval Probability", value=f"{rate}%", intent=intent,
                sub_label=f"{t.ticket_no}: your L1 approver approves {rate}% of requests (90d).")


async def _assignment_eta(scope: dict, now: datetime) -> Card:
    t = await (
        ServiceRequest.find({**scope, "request_status": RequestStatusEnum.PENDING_ASSIGNMENT.value})
        .sort("+submitted_on").limit(1).to_list()
    )
    if not t:
        return Card(id="assign_eta", label="Assignment ETA", value="—", intent="neutral",
                    sub_label="No requests awaiting assignment")
    t = t[0]
    pos = await ServiceRequest.find(
        {"organisation_id": t.organisation_id, "category_id": t.category_id,
         "request_status": RequestStatusEnum.PENDING_ASSIGNMENT.value,
         "submitted_on": {"$lt": t.submitted_on}}).count()
    avg_h = await _avg_subtract_hours(
        {"organisation_id": t.organisation_id, "category_id": t.category_id,
         "assigned_at": {"$ne": None, "$gte": now - timedelta(days=30)}, "submitted_on": {"$ne": None}},
        "assigned_at", "submitted_on") or 8.0
    eta = round((pos + 1) * avg_h)
    return Card(id="assign_eta", label="Assignment ETA", value=f"~{eta}h", intent="neutral",
                sub_label=f"{t.ticket_no}: {pos} ahead in queue · ~{avg_h:.0f}h avg pickup.")


async def _next_quarter_forecast(scope: dict, now: datetime) -> Card:
    rows = await ServiceRequest.aggregate(
        [{"$match": {**scope, "submitted_on": {"$ne": None, "$gte": now - timedelta(days=365)}}},
         {"$group": {"_id": {"$ceil": {"$divide": [{"$month": "$submitted_on"}, 3]}}, "n": {"$sum": 1}}}]
    ).to_list()
    total = sum(r["n"] for r in rows)
    cur_q = (now.month - 1) // 3 + 1
    nxt_q = cur_q % 4 + 1
    if total == 0:
        return Card(id="vol_forecast", label=f"Q{nxt_q} Volume Forecast", value="0–1", intent="neutral",
                    sub_label="Little history to forecast from")
    qn = {int(r["_id"]): r["n"] for r in rows if r["_id"]}
    seasonal = (qn.get(nxt_q, 0) / (total / 4)) or 1
    forecast = (total / 4) * seasonal
    lo, hi = max(0, round(forecast * 0.85)), round(forecast * 1.15) + 1
    return Card(id="vol_forecast", label=f"Q{nxt_q} Volume Forecast", value=f"{lo}–{hi}", intent="neutral",
                sub_label=f"Based on your trailing-12-month pattern ({total} requests).")


async def _sla_hit_rate(scope: dict) -> Card:
    rows = await ServiceRequest.aggregate(
        [{"$match": {**scope, "resolved_at": {"$ne": None}}},
         {"$group": {"_id": None, "n": {"$sum": 1}, "hit": {"$sum": {"$cond": [
             {"$and": [{"$ne": ["$resolution_due_by", None]}, {"$lte": ["$resolved_at", "$resolution_due_by"]}]}, 1, 0]}}}}]
    ).to_list()
    if not rows or not rows[0]["n"]:
        return Card(id="sla_hit", label="My SLA Hit Rate", value="—", intent="neutral",
                    sub_label="No resolved tickets yet")
    n, hit = rows[0]["n"], rows[0]["hit"]
    pct = round(hit / n * 100)
    intent = "good" if pct >= 80 else "warning" if pct >= 60 else "critical"
    return Card(id="sla_hit", label="My SLA Hit Rate", value=f"{pct}%", intent=intent,
                sub_label=f"{hit}/{n} resolved within SLA.")


async def _next_likely_category(scope: dict) -> Card:
    rows = await ServiceRequest.aggregate(
        [{"$match": scope}, {"$group": {"_id": "$category_id", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}, {"$limit": 1}]
    ).to_list()
    if not rows or rows[0]["_id"] is None:
        return Card(id="next_cat", label="Next Likely Request", value="—", intent="neutral", sub_label="No history yet")
    names = await _category_names([rows[0]["_id"]])
    return Card(id="next_cat", label="Next Likely Request", value=names.get(rows[0]["_id"], "Unknown"),
                intent="neutral", sub_label="Your most frequent request category.")


async def build_employee_predictive(user) -> Tab:
    now = utcnow().replace(tzinfo=None)  # match tz-naive Mongo datetimes for Python math
    scope = employee_scope(user)
    cards = [
        await _breach_probability(scope, now),
        await _approval_probability(scope, now),
        await _assignment_eta(scope, now),
        await _next_quarter_forecast(scope, now),
        await _sla_hit_rate(scope),
        await _next_likely_category(scope),
    ]
    return Tab(key="predictive", label="Predictive",
               sections=[Section(id="predictions", title="Predictions for My Requests", cards=cards)])
