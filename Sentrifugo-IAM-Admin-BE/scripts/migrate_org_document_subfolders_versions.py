"""Backfill org-document sub-folders + versioning.

Brings existing data up to the schema introduced alongside sub-folders
(`DocumentFolderDocument.parent_id`) and per-version acknowledgements
(`org_document_versions`, `OrgDocumentDocument.current_version_no`,
`DocumentAcknowledgementDocument.version_no`).

What it does, in order:

1. document_folders  → set `parent_id: null` on every existing folder, so all
   current folders become top-level. Drops the old
   `(name, organisation_id)` unique index; the model's new
   `name_parent_org_unique` index replaces it (created by Beanie on boot).
2. org_documents     → set `current_version_no: 1`.
3. org_document_versions → insert a v1 row per document pointing at its
   current asset, so every document has a complete history from day one.
4. org_document_acknowledgements → set `version_no: 1` on existing acks (they
   were made against what is now v1, so they stay valid) and drop the old
   `(document_id, user_id)` unique index in favour of the version-aware one.

Idempotent — safe to re-run. Run it BEFORE starting the app on the new code,
so Beanie's index creation does not race the index drops.

    python scripts/migrate_org_document_subfolders_versions.py [--dry-run]
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from src.config import settings  # noqa: E402

# Old indexes that the new compound ones supersede. Beanie only creates
# indexes, never removes them, so a stale unique index would keep rejecting
# legitimate writes (e.g. same folder name under two different parents).
STALE_INDEXES = {
    "document_folders": ["name_1_organisation_id_1"],
    "org_document_acknowledgements": ["document_id_1_user_id_1"],
}


async def _drop_stale_indexes(db, dry_run: bool) -> None:
    for coll_name, index_names in STALE_INDEXES.items():
        existing = await db[coll_name].index_information()
        for name in index_names:
            if name not in existing:
                continue
            print(f"  drop index {coll_name}.{name}")
            if not dry_run:
                await db[coll_name].drop_index(name)


async def migrate(dry_run: bool = False) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client.get_default_database()

    print("== 1. document_folders → parent_id: null ==")
    res = await db.document_folders.count_documents({"parent_id": {"$exists": False}})
    print(f"  {res} folder(s) need parent_id")
    if res and not dry_run:
        await db.document_folders.update_many(
            {"parent_id": {"$exists": False}}, {"$set": {"parent_id": None}}
        )

    print("== 2. org_documents → current_version_no: 1 ==")
    res = await db.org_documents.count_documents({"current_version_no": {"$exists": False}})
    print(f"  {res} document(s) need current_version_no")
    if res and not dry_run:
        await db.org_documents.update_many(
            {"current_version_no": {"$exists": False}}, {"$set": {"current_version_no": 1}}
        )

    print("== 3. org_document_versions → backfill v1 rows ==")
    existing_doc_ids = set(await db.org_document_versions.distinct("document_id"))
    cursor = db.org_documents.find({"deleted_on": None}, {"_id": 1, "organisation_id": 1, "asset_id": 1, "created_by": 1, "created_on": 1})
    rows = []
    now = datetime.now(timezone.utc)
    async for doc in cursor:
        if doc["_id"] in existing_doc_ids:
            continue
        rows.append({
            "organisation_id": doc["organisation_id"],
            "document_id": doc["_id"],
            "version_no": 1,
            "asset_id": doc["asset_id"],
            "change_note": "Initial version (backfilled)",
            "uploaded_by": doc.get("created_by"),
            "uploaded_at": doc.get("created_on") or now,
            "created_by": doc.get("created_by"),
            "created_on": doc.get("created_on") or now,
            "deleted_on": None,
        })
    print(f"  {len(rows)} version row(s) to insert")
    if rows and not dry_run:
        await db.org_document_versions.insert_many(rows)

    print("== 4. org_document_acknowledgements → version_no: 1 ==")
    res = await db.org_document_acknowledgements.count_documents({"version_no": {"$exists": False}})
    print(f"  {res} acknowledgement(s) need version_no")
    if res and not dry_run:
        await db.org_document_acknowledgements.update_many(
            {"version_no": {"$exists": False}}, {"$set": {"version_no": 1}}
        )

    print("== 5. drop superseded indexes ==")
    await _drop_stale_indexes(db, dry_run)

    print("\nDone." + (" (dry run — nothing written)" if dry_run else ""))
    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report only, write nothing")
    args = parser.parse_args()
    asyncio.run(migrate(dry_run=args.dry_run))
