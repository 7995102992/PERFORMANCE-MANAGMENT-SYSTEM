"""Read-only graph query endpoints — org chart & reporting traversals.

These answer the variable-depth / cross-hierarchy questions that are awkward in
Mongo but native to the graph projection (see ``src.graph.writer`` for the node/
edge model). Every query is scoped to the caller's organisation.

The graph is a *derived* read model — Mongo stays the system of record. If Neo4j
is unavailable these endpoints return 503 rather than falling back to Mongo.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.dependencies import get_current_user
from src.graph import run_read

router = APIRouter(prefix="/graph", tags=["graph"])

# Authenticated-only (like the employee directory) — any logged-in user in the
# org may read the organogram; every query is still scoped to their organisation.
_GraphReader = Annotated[UserBase, Depends(get_current_user)]


def _org(caller: UserBase) -> str:
    if not caller.organisation_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No organisation context")
    return str(caller.organisation_id)


async def _active_status_ids() -> list[str]:
    """Ids (as node-stored strings) of EMPLOYMENT_STATUSES flagged active — the same
    'active employee' definition the directory uses. Empty result → no filtering
    (defensive: never hide the whole chart if statuses aren't seeded)."""
    from src.master_data.models import MasterDataDocument
    docs = await MasterDataDocument.find(
        {"category": "EMPLOYMENT_STATUSES", "is_active": True}
    ).to_list()
    return [str(d.id) for d in docs]


async def _read(cypher: str, params: dict) -> list[dict]:
    try:
        return await run_read(cypher, params)
    except Exception as exc:  # noqa: BLE001 — surface graph outages as 503
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, f"Graph store unavailable: {exc}"
        )


@router.get("/reporting-chain/{employee_id}")
async def reporting_chain(employee_id: str, current_user: _GraphReader) -> list[dict]:
    """The employee's L1 management chain upward to the top.

    Returned ordered, ``level`` 0 = the employee themselves, increasing toward
    the top of the chain. The variable-depth traversal (``REPORTS_TO*``) is the
    thing a graph does in one query that Mongo cannot.
    """
    active = await _active_status_ids()
    where = "WHERE n.employment_status IN $active" if active else ""
    return await _read(
        f"""
        MATCH (e:Employee {{id:$id, organisation_id:$org}})
        OPTIONAL MATCH p = (e)-[:REPORTS_TO*1..50 {{level:1}}]->(:Employee)
        WITH e, p ORDER BY length(p) DESC LIMIT 1
        WITH CASE WHEN p IS NULL THEN [e] ELSE nodes(p) END AS chain
        UNWIND range(0, size(chain) - 1) AS i
        WITH chain[i] AS n, i
        {where}
        OPTIONAL MATCH (n)-[:IS]->(u:User)
        RETURN i AS level, n.id AS employee_id, n.emp_code AS emp_code, u.name AS name
        ORDER BY level
        """,
        {"id": employee_id, "org": _org(current_user), "active": active},
    )


@router.get("/direct-reports/{employee_id}")
async def direct_reports(employee_id: str, current_user: _GraphReader) -> list[dict]:
    """Employees who report directly (L1) to this employee (active employees only)."""
    active = await _active_status_ids()
    where = "WHERE sub.employment_status IN $active" if active else ""
    return await _read(
        f"""
        MATCH (e:Employee {{id:$id, organisation_id:$org}})<-[:REPORTS_TO {{level:1}}]-(sub:Employee)
        {where}
        OPTIONAL MATCH (sub)-[:IS]->(u:User)
        RETURN sub.id AS employee_id, sub.emp_code AS emp_code, u.name AS name
        ORDER BY name
        """,
        {"id": employee_id, "org": _org(current_user), "active": active},
    )


@router.get("/all-reports/{employee_id}")
async def all_reports(employee_id: str, current_user: _GraphReader) -> list[dict]:
    """Every employee under this one at any depth along the L1 reporting line
    (active employees only; inactive people are dropped from the list but the
    subtree beneath them is still traversed)."""
    active = await _active_status_ids()
    where = "WHERE sub.employment_status IN $active" if active else ""
    return await _read(
        f"""
        MATCH (e:Employee {{id:$id, organisation_id:$org}})<-[:REPORTS_TO*1..50 {{level:1}}]-(sub:Employee)
        {where}
        OPTIONAL MATCH (sub)-[:IS]->(u:User)
        RETURN DISTINCT sub.id AS employee_id, sub.emp_code AS emp_code, u.name AS name
        ORDER BY name
        """,
        {"id": employee_id, "org": _org(current_user), "active": active},
    )


@router.get("/org-tree")
async def org_tree(current_user: _GraphReader) -> list[dict]:
    """The WHOLE active-employee reporting hierarchy for the caller's org, nested
    (roots → children), in one call — so the organogram doesn't have to expand node
    by node. Each node: employee_id, emp_code, name, designation, manager_id,
    children[]. Active employees only; an active employee whose L1 manager is
    inactive (or absent) surfaces as a root."""
    active = await _active_status_ids()
    where = "WHERE e.employment_status IN $active" if active else ""
    rows = await _read(
        f"""
        MATCH (e:Employee {{organisation_id:$org}})
        {where}
        OPTIONAL MATCH (e)-[:REPORTS_TO {{level:1}}]->(m:Employee)
        OPTIONAL MATCH (e)-[:IS]->(u:User)
        OPTIONAL MATCH (e)-[:HAS_DESIGNATION]->(d:Designation)
        RETURN e.id AS employee_id, e.emp_code AS emp_code, u.name AS name,
               d.name AS designation, m.id AS manager_id
        """,
        {"org": _org(current_user), "active": active},
    )
    nodes = {
        r["employee_id"]: {
            "employee_id": r["employee_id"], "emp_code": r["emp_code"],
            "name": r["name"], "designation": r["designation"],
            "manager_id": r["manager_id"], "children": [],
        }
        for r in rows
    }
    roots: list[dict] = []
    for node in nodes.values():
        mgr = nodes.get(node["manager_id"]) if node["manager_id"] else None
        (mgr["children"] if mgr else roots).append(node)
    # Sort every children list (and the roots) by emp code — one pass over all nodes
    # sorts the whole tree and is cycle-safe (no recursion).
    for node in nodes.values():
        node["children"].sort(key=lambda c: (c["emp_code"] or "").lower())
    roots.sort(key=lambda n: (n["emp_code"] or "").lower())
    return roots


@router.get("/org-structure")
async def org_structure(current_user: _GraphReader) -> list[dict]:
    """The caller org's Business Unit → Department tree, with BU heads."""
    return await _read(
        """
        MATCH (b:BusinessUnit)-[:BELONGS_TO]->(o:Organisation {id:$org})
        OPTIONAL MATCH (d:Department)-[:IN_BUSINESS_UNIT]->(b)
        OPTIONAL MATCH (b)-[:HEADED_BY]->(h:User)
        RETURN b.id AS business_unit_id, b.name AS business_unit, h.name AS head,
               collect(DISTINCT {id: d.id, name: d.name}) AS departments
        ORDER BY business_unit
        """,
        {"org": _org(current_user)},
    )
