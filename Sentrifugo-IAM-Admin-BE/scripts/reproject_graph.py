"""Rebuild the Neo4j graph projection from the current Mongo state.

Wipes the graph, then replays every live (non-deleted) Mongo document through the
SAME writer functions the projector runs (src.graph.writer) — so the result is
byte-identical to what the RabbitMQ event stream would produce, minus the drift.
Use after seed drop-and-reinserts / bulk deletes that bypassed *.deleted events.

    python -m scripts.reproject_graph --dry-run   # counts only, no writes
    python -m scripts.reproject_graph             # WIPE + reproject
"""
from __future__ import annotations
import argparse
import asyncio

from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings
from src.graph import connection, run_write
from src.graph import writer

LIVE = {"deleted_on": None}


def _s(v):
    return str(v) if v is not None else None


def _slist(v):
    return [str(x) for x in (v or [])]


def _dstr(v):
    return v.isoformat()[:10] if hasattr(v, "isoformat") else (str(v) if v is not None else None)


async def main(dry_run: bool) -> None:
    db = AsyncIOMotorClient(settings.MONGODB_URL).get_default_database()
    await connection.init_graph()

    async def load(coll):
        return await db[coll].find(LIVE).to_list(length=200000)

    orgs = await load("organisations")
    bus = await load("business_units")
    depts = await load("departments")
    bands = await load("bands")
    pgs = await load("paygrades")
    desgs = await load("designations")
    pols = await load("policies")
    folders = await load("document_folders")
    docs = await load("org_documents")
    users = await load("users")
    emps = await load("employees")

    counts = {
        "organisations": len(orgs), "business_units": len(bus), "departments": len(depts),
        "bands": len(bands), "paygrades": len(pgs), "designations": len(desgs),
        "policies": len(pols), "document_folders": len(folders), "org_documents": len(docs),
        "users": len(users), "employees": len(emps),
    }
    print("live Mongo docs to project:")
    for k, v in counts.items():
        print(f"  {k:16s} {v}")
    if dry_run:
        print("\nDRY RUN — no graph writes. Re-run without --dry-run to WIPE + reproject.")
        return

    # 1) Wipe the whole projection.
    print("\nwiping graph …")
    await run_write("MATCH (n) DETACH DELETE n", {})

    # 2) Reproject in dependency order (writers MERGE stubs, so order only affects
    #    property completeness, not correctness).
    print("projecting organisations …")
    for o in orgs:
        p = {"organisation_id": _s(o["_id"]), "legal_name": o.get("legal_name"),
             "is_active": o.get("is_active", True), "financial_year": o.get("financial_year"),
             "currency": o.get("currency"), "timezone": o.get("timezone"),
             "setup_status": o.get("setup_status")}
        if o.get("head_user_id"):
            p["head_user_id"] = _s(o["head_user_id"])
        await writer.upsert_organisation(p)

    print("projecting business units …")
    for b in bus:
        await writer.upsert_business_unit({
            "business_unit_id": _s(b["_id"]), "name": b.get("business_unit_name"),
            "is_active": b.get("is_active", True), "organisation_id": _s(b.get("organisation_id")),
            "currency": b.get("currency"), "time_zone": b.get("time_zone"),
            "is_subsidiary": b.get("is_subsidiary", False), "head_user_id": _s(b.get("head_user_id")),
        })

    print("projecting departments …")
    for d in depts:
        await writer.upsert_department({
            "department_id": _s(d["_id"]), "name": d.get("department_name"),
            "is_active": d.get("is_active", True), "department_code": d.get("department_code"),
            "organisation_id": _s(d.get("organisation_id")),
            "business_unit_id": _s(d.get("primary_business_unit")),
            "business_unit_ids": _slist(d.get("business_units")),
            "department_head": _s(d.get("department_head")),
        })

    print("projecting bands …")
    for bn in bands:
        await writer.upsert_band({
            "band_id": _s(bn["_id"]), "name": bn.get("name"), "is_active": bn.get("is_active", True),
            "organisation_id": _s(bn.get("organisation_id")), "currency": bn.get("currency"),
        })

    print("projecting pay grades …")
    for pg in pgs:
        await writer.upsert_paygrade({
            "pay_grade_id": _s(pg["_id"]), "name": pg.get("name"), "is_active": pg.get("is_active", True),
            "organisation_id": _s(pg.get("organisation_id")), "band_ids": _slist(pg.get("band_ids")),
        })

    print("projecting designations …")
    for dg in desgs:
        await writer.upsert_designation({
            "designation_id": _s(dg["_id"]), "name": dg.get("designation_name"),
            "is_active": dg.get("is_active", True), "organisation_id": _s(dg.get("organisation_id")),
            "department_id": _s(dg.get("department_id")), "pay_grade_ids": _slist(dg.get("pay_grade_ids")),
        })

    print("projecting policies …")
    for pl in pols:
        await writer.upsert_policy({
            "policy_id": _s(pl["_id"]), "name": pl.get("name"), "is_role": pl.get("is_role", False),
            "is_active": pl.get("is_active", True), "organisation_id": _s(pl.get("organisation_id")),
        })

    print("projecting document folders …")
    for f in folders:
        await writer.upsert_document_folder({
            "folder_id": _s(f["_id"]), "name": f.get("name"),
            "organisation_id": _s(f.get("organisation_id")), "parent_id": _s(f.get("parent_id")),
        })

    print("projecting org documents …")
    for doc in docs:
        await writer.upsert_org_document({
            "document_id": _s(doc["_id"]), "title": doc.get("title"), "asset_id": _s(doc.get("asset_id")),
            "is_active": doc.get("is_active", True), "organisation_id": _s(doc.get("organisation_id")),
            "folder_id": _s(doc.get("folder_id")),
        })

    print("projecting users …")
    for u in users:
        await writer.upsert_user({
            "user_id": _s(u["_id"]), "first_name": u.get("first_name"), "last_name": u.get("last_name"),
            "email": u.get("email"), "status": u.get("status"), "policy_ids": _slist(u.get("policy_ids")),
        })

    print("projecting employees …")
    user_map = {str(u["_id"]): u for u in users}
    for e in emps:
        u = user_map.get(str(e.get("user_id")))
        name = (f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip()
                if u else None) or None
        await writer.upsert_employee({
            "employee_id": _s(e["_id"]), "user_id": _s(e.get("user_id")), "emp_code": e.get("emp_code"),
            "organisation_id": _s(e.get("organisation_id")), "name": name,
            "work_email": (u.get("email") if u else None),
            "date_of_joining": _dstr(e.get("date_of_joining")),
            "employment_status": _s(e.get("employment_status")), "project_status": _s(e.get("project_status")),
            "business_unit_id": _s(e.get("business_unit_id")), "department_id": _s(e.get("department_id")),
            "designation_id": _s(e.get("designation_id")),
            "l1_manager_id": _s(e.get("l1_manager_id")), "l2_manager_id": _s(e.get("l2_manager_id")),
        })

    print("\nreprojection complete.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    asyncio.run(main(ap.parse_args().dry_run))
