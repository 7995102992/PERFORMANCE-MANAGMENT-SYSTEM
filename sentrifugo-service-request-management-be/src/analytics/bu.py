"""Business-unit selection + comparison for the CXO analytics dashboard.

Two capabilities, both CXO-only:
  * **View BU**     — scope the CXO dashboard to one business unit
                      (``bu_category_ids`` feeds ``build_cxo_descriptive``).
  * **Compare BUs** — side-by-side metrics across business units
                      (``build_bu_comparison`` → two charts).

A ticket has no business_unit_id; it reaches a BU through its Category
(``Category.business_unit_id``). So everything here maps category → BU and rolls
SR aggregates up to the BU. BU display names come from IAM (best-effort).
"""
from __future__ import annotations

from typing import Any

from bson import ObjectId

from ..categories.service import _resolve_bu_names
from ..common.timestamps import utcnow
from ..models import Category, RequestStatusEnum, ServiceRequest
from .metrics.descriptive import _HIT_COND, _sla_hit_rate
from .periods import fy_start, last_n_month_keys, months_back_start
from .schemas import Chart, ChartSeries
from .scoping import cxo_scope, org_fy_start_month

_RESOLVED = [RequestStatusEnum.RESOLVED.value, RequestStatusEnum.CLOSED.value]
_MAX_BUS = 8  # cap the comparison so the grouped chart stays readable


def _oid(v: Any) -> Any:
    try:
        return ObjectId(str(v))
    except Exception:  # noqa: BLE001
        return v


async def _bu_map(user) -> tuple[dict[Any, Any], dict[Any, list]]:
    """Returns (category_id → business_unit_id, business_unit_id → [category_id])."""
    cats = await Category.find({"organisation_id": user.org_oid, "deleted_on": None}).to_list()
    cat_bu = {c.id: c.business_unit_id for c in cats}
    bu_cats: dict[Any, list] = {}
    for cid, bu in cat_bu.items():
        if bu is not None:
            bu_cats.setdefault(bu, []).append(cid)
    return cat_bu, bu_cats


async def list_business_units(user) -> list[dict[str, str]]:
    """BUs that have at least one SR category, with IAM-resolved names."""
    _, bu_cats = await _bu_map(user)
    names = await _resolve_bu_names(list(bu_cats.keys()), access_token=getattr(user, "access_token", None))
    return [{"id": str(bu), "name": names.get(bu) or str(bu)} for bu in bu_cats]


async def bu_category_ids(user, business_unit_id: str) -> list[Any]:
    """Category ids belonging to a business unit — the View-BU scope restriction."""
    cats = await Category.find(
        {"organisation_id": user.org_oid, "business_unit_id": _oid(business_unit_id), "deleted_on": None}
    ).to_list()
    return [c.id for c in cats]


async def build_bu_comparison(user) -> list[Chart]:
    """Two comparison charts: key metrics per BU (grouped bar) and SLA-compliance
    trend per BU over the last 6 months (line)."""
    now = utcnow().replace(tzinfo=None)
    fy = fy_start(now, await org_fy_start_month(user))
    base = cxo_scope(user)
    cat_bu, bu_cats = await _bu_map(user)
    bus = list(bu_cats.keys())[:_MAX_BUS]
    names = await _resolve_bu_names(bus, access_token=getattr(user, "access_token", None))

    def label(bu: Any) -> str:
        return names.get(bu) or str(bu)

    # ── Key metrics by BU (FY): SLA compliance %, resolution %, first-response % ──
    labels, sla_data, res_data, fr_data = [], [], [], []
    for bu in bus:
        cids = bu_cats[bu]
        scope = {**base, "category_id": {"$in": cids}, "submitted_on": {"$gte": fy}}
        _, _, sla = await _sla_hit_rate(scope, now)
        total = await ServiceRequest.find(scope).count()
        resolved = await ServiceRequest.find({**scope, "request_status": {"$in": _RESOLVED}}).count()
        fr_rows = await ServiceRequest.aggregate([
            {"$match": {**scope, "first_response_due_by": {"$ne": None}}},
            {"$group": {"_id": None, "considered": {"$sum": 1},
                        "hit": {"$sum": {"$cond": [
                            {"$and": [{"$ne": ["$first_response_at", None]},
                                      {"$lte": ["$first_response_at", "$first_response_due_by"]}]}, 1, 0]}}}},
        ]).to_list()
        fr = round(fr_rows[0]["hit"] / fr_rows[0]["considered"] * 100) if fr_rows and fr_rows[0]["considered"] else 0
        labels.append(label(bu))
        sla_data.append(sla)
        res_data.append(round(resolved / total * 100) if total else 0)
        fr_data.append(fr)
    key_metrics = Chart(
        id="bu_key_metrics", title="Key Metrics by Business Unit", type="bar", labels=labels,
        series=[ChartSeries(name="SLA Compliance %", data=sla_data),
                ChartSeries(name="Resolution %", data=res_data),
                ChartSeries(name="First Response %", data=fr_data)],
    )

    # ── SLA-compliance trend by BU (last 6 months) ──
    keys = last_n_month_keys(now, 6)
    rows = await ServiceRequest.aggregate([
        {"$match": {**base, "submitted_on": {"$gte": months_back_start(now, 6)}}},
        {"$match": {"$or": [{"resolved_at": {"$ne": None}}, {"resolution_due_by": {"$lt": now}}]}},
        {"$group": {"_id": {"c": "$category_id", "y": {"$year": "$submitted_on"}, "m": {"$month": "$submitted_on"}},
                    "considered": {"$sum": 1}, "hit": {"$sum": _HIT_COND}}},
    ]).to_list()
    bu_set = set(bus)
    agg: dict[tuple, dict[str, int]] = {}
    for r in rows:
        bu = cat_bu.get(r["_id"]["c"])
        if bu not in bu_set:
            continue
        d = agg.setdefault((bu, (r["_id"]["y"], r["_id"]["m"])), {"hit": 0, "considered": 0})
        d["hit"] += r["hit"]
        d["considered"] += r["considered"]
    trend = Chart(
        id="bu_compliance_trend", title="BU SLA Compliance Trend", type="line",
        labels=[lbl for (_, _, lbl) in keys],
        series=[ChartSeries(name=label(bu), data=[
            (lambda d: round(d["hit"] / d["considered"] * 100) if d and d["considered"] else 0)(agg.get((bu, (y, m))))
            for (y, m, _) in keys
        ]) for bu in bus],
    )

    return [key_metrics, trend]
