"""Remove orphaned structure nodes from the Neo4j graph projection.

The graph is a derived read model kept in sync by the projector consuming
*.deleted events. Data removed OUTSIDE that path (e.g. a seed drop-and-reinsert
with fresh ids) leaves orphan nodes that never get a delete event — they then
show up in /graph/org-structure etc. This reconciles each structure label against
Mongo and DETACH DELETEs any graph node whose Mongo doc is missing or soft-deleted.

    python -m scripts.reconcile_graph_orphans --dry-run
    python -m scripts.reconcile_graph_orphans
"""
from __future__ import annotations
import argparse
import asyncio
from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient
from src.config import settings
from src.graph import connection, run_read, run_write

# graph label -> mongo collection
LABELS = {
    "BusinessUnit": "business_units",
    "Department": "departments",
    "Designation": "designations",
    "Band": "bands",
    "PayGrade": "paygrades",
    "Policy": "policies",
    "Employee": "employees",
    "OrgDocument": "org_documents",
}


def _live(doc) -> bool:
    return bool(doc) and doc.get("deleted_on") is None


async def main(dry_run: bool) -> None:
    db = AsyncIOMotorClient(settings.MONGODB_URL).get_default_database()
    await connection.init_graph()
    grand_total = 0
    for label, coll in LABELS.items():
        ids = [r["id"] for r in await run_read(f"MATCH (n:{label}) RETURN n.id AS id", {}) if r.get("id")]
        orphans = []
        for nid in ids:
            try:
                oid = ObjectId(str(nid))
            except Exception:
                orphans.append(nid)          # unparseable id → definitely orphan
                continue
            if not _live(await db[coll].find_one({"_id": oid})):
                orphans.append(nid)
        grand_total += len(orphans)
        print(f"{label:14s} graph={len(ids):5d}  orphans={len(orphans)}")
        if orphans and not dry_run:
            await run_write(
                f"UNWIND $ids AS id MATCH (n:{label} {{id:id}}) DETACH DELETE n",
                {"ids": orphans},
            )
    verb = "would delete" if dry_run else "deleted"
    print(f"\nTOTAL orphan nodes {verb}: {grand_total}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    asyncio.run(main(ap.parse_args().dry_run))
