"""Idempotent graph upserts driven by domain-event payloads.

Each function takes the event ``payload`` dict (the exact shape emitted by the
services' ``outbox.publish`` calls) and MERGEs the corresponding nodes/edges.

Invariants:
  * Every write is a MERGE, so ``*.created`` and ``*.updated`` are the same
    operation and re-delivery is a no-op (the projection is idempotent).
  * Edges are created only when their FK is present in the payload, so a
    partially-set-up org (head not yet assigned, BU not yet picked) projects
    cleanly and fills in as later events arrive.
  * Editable relationships (HEADED_BY, IN_BUSINESS_UNIT, IN_BAND, HAS_PAY_GRADE,
    HOLDS, WORKS_IN, IN_DEPARTMENT, HAS_DESIGNATION, REPORTS_TO) are rebuilt —
    the stale edges are deleted first — so re-assignment re-points cleanly.

The graph produced:
    (BusinessUnit)-[:BELONGS_TO]->(Organisation)
    (Department)-[:BELONGS_TO]->(Organisation)
    (Department)-[:IN_BUSINESS_UNIT {primary}]->(BusinessUnit)
    (Band)-[:BELONGS_TO]->(Organisation)
    (PayGrade)-[:BELONGS_TO]->(Organisation)
    (PayGrade)-[:IN_BAND]->(Band)
    (Designation)-[:BELONGS_TO]->(Organisation)
    (Designation)-[:IN_DEPARTMENT]->(Department)
    (Designation)-[:HAS_PAY_GRADE]->(PayGrade)
    (Policy)-[:BELONGS_TO]->(Organisation)
    (DocumentFolder)-[:BELONGS_TO]->(Organisation)
    (OrgDocument)-[:BELONGS_TO]->(Organisation)
    (OrgDocument)-[:IN_FOLDER]->(DocumentFolder)
    (Organisation|BusinessUnit|Department)-[:HEADED_BY]->(User)
    (User)-[:HOLDS]->(Policy)
    (Employee)-[:IS]->(User)                       # the User node carries the name
    (Employee)-[:WORKS_IN]->(BusinessUnit)
    (Employee)-[:IN_DEPARTMENT]->(Department)
    (Employee)-[:HAS_DESIGNATION]->(Designation)
    (Employee)-[:REPORTS_TO {level:1|2}]->(Employee)
"""
from __future__ import annotations

from src.graph.connection import run_write


# ─── Organisation ───────────────────────────────────────────────────────────────

async def upsert_organisation(p: dict) -> None:
    await run_write(
        """
        MERGE (o:Organisation {id:$id})
          SET o.name=$name, o.is_active=$active, o.financial_year=$fy,
              o.currency=$currency, o.timezone=$tz, o.setup_status=$setup
        """,
        {"id": p.get("organisation_id"), "name": p.get("legal_name"),
         "active": p.get("is_active", True), "fy": p.get("financial_year"),
         "currency": p.get("currency"), "tz": p.get("timezone"),
         "setup": p.get("setup_status")},
    )
    # organisation.* must include head_user_id for this edge to form (see emits).
    if "head_user_id" in p:
        await set_head("Organisation", p.get("organisation_id"), p.get("head_user_id"))


# ─── Business Unit ────────────────────────────────────────────────────────────────

async def upsert_business_unit(p: dict) -> None:
    await run_write(
        """
        MERGE (b:BusinessUnit {id:$id})
          SET b.name=$name, b.is_active=$active, b.currency=$currency,
              b.time_zone=$tz, b.is_subsidiary=$is_sub
        WITH b
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (b)-[:BELONGS_TO]->(o))
        """,
        {"id": p.get("business_unit_id"), "name": p.get("name"),
         "active": p.get("is_active", True), "org_id": p.get("organisation_id"),
         "currency": p.get("currency"), "tz": p.get("time_zone"),
         "is_sub": p.get("is_subsidiary", False)},
    )
    await set_head("BusinessUnit", p.get("business_unit_id"), p.get("head_user_id"))


# ─── Department ─────────────────────────────────────────────────────────────────

async def upsert_department(p: dict) -> None:
    dept_id = p.get("department_id")
    # Department reaches Org two ways: a direct BELONGS_TO (authoritative) and
    # transitively via its business units (Department→BU→Organisation).
    await run_write(
        """
        MERGE (d:Department {id:$id})
          SET d.name=$name, d.is_active=$active, d.code=$code
        WITH d
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (d)-[:BELONGS_TO]->(o))
        WITH d
        OPTIONAL MATCH (d)-[old:IN_BUSINESS_UNIT]->() DELETE old
        WITH d
        UNWIND $bu_ids AS bu_id
        MERGE (b:BusinessUnit {id:bu_id})
        MERGE (d)-[r:IN_BUSINESS_UNIT]->(b) SET r.primary = (bu_id = $primary)
        """,
        {"id": dept_id, "name": p.get("name"), "active": p.get("is_active", True),
         "code": p.get("department_code"),
         "org_id": p.get("organisation_id"), "primary": p.get("business_unit_id"),
         "bu_ids": p.get("business_unit_ids") or []},
    )
    await set_head("Department", dept_id, p.get("department_head"))


# ─── Band ────────────────────────────────────────────────────────────────────────

async def upsert_band(p: dict) -> None:
    if not (bid := p.get("band_id")):
        return
    await run_write(
        """
        MERGE (bn:Band {id:$id})
          SET bn.name=$name, bn.is_active=$active, bn.currency=$currency
        WITH bn
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (bn)-[:BELONGS_TO]->(o))
        """,
        {"id": bid, "name": p.get("name"), "active": p.get("is_active", True),
         "org_id": p.get("organisation_id"), "currency": p.get("currency")},
    )


# ─── Pay Grade ───────────────────────────────────────────────────────────────────

async def upsert_paygrade(p: dict) -> None:
    if not (pid := p.get("pay_grade_id")):
        return
    await run_write(
        """
        MERGE (pg:PayGrade {id:$id}) SET pg.name=$name, pg.is_active=$active
        WITH pg
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (pg)-[:BELONGS_TO]->(o))
        WITH pg
        OPTIONAL MATCH (pg)-[old:IN_BAND]->() DELETE old
        WITH pg
        UNWIND $band_ids AS band_id
        MERGE (bn:Band {id:band_id}) MERGE (pg)-[:IN_BAND]->(bn)
        """,
        {"id": pid, "name": p.get("name"), "active": p.get("is_active", True),
         "org_id": p.get("organisation_id"), "band_ids": p.get("band_ids") or []},
    )


# ─── Designation ─────────────────────────────────────────────────────────────────

async def upsert_designation(p: dict) -> None:
    if not (did := p.get("designation_id")):
        return
    await run_write(
        """
        MERGE (dg:Designation {id:$id}) SET dg.name=$name, dg.is_active=$active
        WITH dg
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (dg)-[:BELONGS_TO]->(o))
        WITH dg
        OPTIONAL MATCH (dg)-[oldd:IN_DEPARTMENT]->() DELETE oldd
        WITH dg
        FOREACH (_ IN CASE WHEN $dept_id IS NULL THEN [] ELSE [1] END |
          MERGE (d:Department {id:$dept_id}) MERGE (dg)-[:IN_DEPARTMENT]->(d))
        WITH dg
        OPTIONAL MATCH (dg)-[oldp:HAS_PAY_GRADE]->() DELETE oldp
        WITH dg
        UNWIND $pay_grade_ids AS pg_id
        MERGE (pg:PayGrade {id:pg_id}) MERGE (dg)-[:HAS_PAY_GRADE]->(pg)
        """,
        {"id": did, "name": p.get("name"), "active": p.get("is_active", True),
         "org_id": p.get("organisation_id"), "dept_id": p.get("department_id"),
         "pay_grade_ids": p.get("pay_grade_ids") or []},
    )


# ─── Policy ──────────────────────────────────────────────────────────────────────

async def upsert_policy(p: dict) -> None:
    if not (pid := p.get("policy_id")):
        return
    # organisation_id may be null (global / super-admin policy) — then no edge.
    await run_write(
        """
        MERGE (pl:Policy {id:$id})
          SET pl.name=$name, pl.is_role=$is_role, pl.is_active=coalesce($is_active, pl.is_active)
        WITH pl
        OPTIONAL MATCH (pl)-[old:BELONGS_TO]->() DELETE old
        WITH pl
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (pl)-[:BELONGS_TO]->(o))
        """,
        {"id": pid, "name": p.get("name"), "is_role": p.get("is_role", False),
         "is_active": p.get("is_active"), "org_id": p.get("organisation_id")},
    )


# ─── Document folder / org document ──────────────────────────────────────────────

async def upsert_document_folder(p: dict) -> None:
    if not (fid := p.get("folder_id")):
        return
    # Sub-folders hang off their main folder via SUB_FOLDER_OF. The old edge is
    # dropped first so a folder never ends up with two parents; a null
    # parent_id therefore correctly leaves a top-level folder with none.
    await run_write(
        """
        MERGE (f:DocumentFolder {id:$id}) SET f.name=$name
        WITH f
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (f)-[:BELONGS_TO]->(o))
        WITH f
        OPTIONAL MATCH (f)-[old:SUB_FOLDER_OF]->() DELETE old
        WITH f
        FOREACH (_ IN CASE WHEN $parent_id IS NULL THEN [] ELSE [1] END |
          MERGE (pf:DocumentFolder {id:$parent_id}) MERGE (f)-[:SUB_FOLDER_OF]->(pf))
        """,
        {
            "id": fid,
            "name": p.get("name"),
            "org_id": p.get("organisation_id"),
            "parent_id": p.get("parent_id"),
        },
    )


async def upsert_org_document(p: dict) -> None:
    if not (docid := p.get("document_id")):
        return
    await run_write(
        """
        MERGE (doc:OrgDocument {id:$id})
          SET doc.title=$title, doc.asset_id=$asset_id, doc.is_active=$active
        WITH doc
        FOREACH (_ IN CASE WHEN $org_id IS NULL THEN [] ELSE [1] END |
          MERGE (o:Organisation {id:$org_id}) MERGE (doc)-[:BELONGS_TO]->(o))
        WITH doc
        OPTIONAL MATCH (doc)-[old:IN_FOLDER]->() DELETE old
        WITH doc
        FOREACH (_ IN CASE WHEN $folder_id IS NULL THEN [] ELSE [1] END |
          MERGE (f:DocumentFolder {id:$folder_id}) MERGE (doc)-[:IN_FOLDER]->(f))
        """,
        {"id": docid, "title": p.get("title"), "asset_id": p.get("asset_id"),
         "active": p.get("is_active", True), "org_id": p.get("organisation_id"),
         "folder_id": p.get("folder_id")},
    )


# ─── User (name + policy holdings) ───────────────────────────────────────────────

async def upsert_user(p: dict) -> None:
    uid = p.get("user_id") or p.get("id")
    if not uid:
        return
    name = p.get("name") or " ".join(
        x for x in (p.get("first_name"), p.get("last_name")) if x
    ) or None
    await run_write(
        """
        MERGE (u:User {id:$id})
          SET u.name=coalesce($name, u.name),
              u.email=coalesce($email, u.email),
              u.status=coalesce($status, u.status)
        """,
        {"id": uid, "name": name, "email": p.get("email"), "status": p.get("status")},
    )
    # HOLDS rebuilt only when the payload carries policy_ids (see emits). An
    # empty list clears holdings; absence leaves them untouched.
    if "policy_ids" in p:
        await run_write(
            """
            MATCH (u:User {id:$id})
            OPTIONAL MATCH (u)-[old:HOLDS]->() DELETE old
            WITH u
            UNWIND $pids AS pid
            MERGE (pl:Policy {id:pid}) MERGE (u)-[:HOLDS]->(pl)
            """,
            {"id": uid, "pids": p.get("policy_ids") or []},
        )


# ─── Employee ───────────────────────────────────────────────────────────────────

async def upsert_employee(p: dict) -> None:
    name = p.get("name") or " ".join(
        x for x in (p.get("first_name"), p.get("last_name")) if x
    ) or None
    await run_write(
        """
        MERGE (e:Employee {id:$id})
          SET e.user_id=$user_id, e.emp_code=$emp_code, e.organisation_id=$org_id,
              e.name=$name, e.work_email=$work_email, e.date_of_joining=$doj,
              e.employment_status=$emp_status, e.project_status=$proj_status,
              e.l1_mgr_user=$l1, e.l2_mgr_user=$l2
        WITH e
        FOREACH (_ IN CASE WHEN $user_id IS NULL THEN [] ELSE [1] END |
          MERGE (u:User {id:$user_id})
            SET u.name=coalesce($name, u.name), u.email=coalesce($work_email, u.email)
          MERGE (e)-[:IS]->(u))
        WITH e
        OPTIONAL MATCH (e)-[w:WORKS_IN]->()        DELETE w
        WITH e
        OPTIONAL MATCH (e)-[d:IN_DEPARTMENT]->()   DELETE d
        WITH e
        OPTIONAL MATCH (e)-[g:HAS_DESIGNATION]->() DELETE g
        WITH e
        FOREACH (_ IN CASE WHEN $bu_id IS NULL THEN [] ELSE [1] END |
          MERGE (b:BusinessUnit {id:$bu_id}) MERGE (e)-[:WORKS_IN]->(b))
        FOREACH (_ IN CASE WHEN $dept_id IS NULL THEN [] ELSE [1] END |
          MERGE (dp:Department {id:$dept_id}) MERGE (e)-[:IN_DEPARTMENT]->(dp))
        FOREACH (_ IN CASE WHEN $desg_id IS NULL THEN [] ELSE [1] END |
          MERGE (dg:Designation {id:$desg_id}) MERGE (e)-[:HAS_DESIGNATION]->(dg))
        """,
        {"id": p.get("employee_id"), "user_id": p.get("user_id"),
         "emp_code": p.get("emp_code"), "org_id": p.get("organisation_id"),
         "name": name, "work_email": p.get("work_email"),
         "doj": p.get("date_of_joining"), "emp_status": p.get("employment_status"),
         "proj_status": p.get("project_status"),
         "bu_id": p.get("business_unit_id"),
         "dept_id": p.get("department_id"), "desg_id": p.get("designation_id"),
         "l1": p.get("l1_manager_id"), "l2": p.get("l2_manager_id")},
    )
    await _rebuild_reporting(p.get("employee_id"))


async def _rebuild_reporting(emp_id) -> None:
    """(Re)build REPORTS_TO edges in both directions, resolving managers (stored
    as user ids) to their Employee node via Employee.user_id. Running both
    directions on every upsert makes the projection order-independent: a manager
    created after their report still gets wired up when the report is (re)seen,
    and vice-versa."""
    if not emp_id:
        return
    # Upward: this employee → its L1/L2 managers.
    await run_write(
        """
        MATCH (e:Employee {id:$id})
        OPTIONAL MATCH (e)-[old:REPORTS_TO]->() DELETE old
        WITH e
        UNWIND [{lvl:1, u:e.l1_mgr_user}, {lvl:2, u:e.l2_mgr_user}] AS m
        WITH e, m WHERE m.u IS NOT NULL
        MATCH (mgr:Employee {user_id:m.u})
        MERGE (e)-[:REPORTS_TO {level:m.lvl}]->(mgr)
        """,
        {"id": emp_id},
    )
    # Downward: anyone whose stored manager user-id is this employee's user.
    await run_write(
        """
        MATCH (mgr:Employee {id:$id}) WHERE mgr.user_id IS NOT NULL
        MATCH (sub:Employee)
        WHERE sub.l1_mgr_user = mgr.user_id OR sub.l2_mgr_user = mgr.user_id
        WITH mgr, sub,
             CASE WHEN sub.l1_mgr_user = mgr.user_id THEN 1 ELSE 2 END AS lvl
        MERGE (sub)-[:REPORTS_TO {level:lvl}]->(mgr)
        """,
        {"id": emp_id},
    )


# ─── Heads & deletes ──────────────────────────────────────────────────────────────

async def set_head(label: str, entity_id, head_user_id) -> None:
    """Set/replace the :HEADED_BY edge. ``label`` is a fixed internal value
    (Organisation/BusinessUnit/Department), never user input."""
    if not entity_id:
        return
    await run_write(
        f"""
        MATCH (n:{label} {{id:$id}})
        OPTIONAL MATCH (n)-[old:HEADED_BY]->() DELETE old
        WITH n
        FOREACH (_ IN CASE WHEN $uid IS NULL THEN [] ELSE [1] END |
          MERGE (u:User {{id:$uid}}) MERGE (n)-[:HEADED_BY]->(u))
        """,
        {"id": entity_id, "uid": head_user_id},
    )


async def delete_node(label: str, entity_id) -> None:
    """Detach-delete a node on a ``*.deleted`` event. ``label`` is internal."""
    if not entity_id:
        return
    await run_write(f"MATCH (n:{label} {{id:$id}}) DETACH DELETE n", {"id": entity_id})
