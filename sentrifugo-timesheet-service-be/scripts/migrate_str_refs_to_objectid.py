"""One-time migration: convert cross-collection reference fields that were
historically stored as BSON strings into BSON ObjectId, so they match the
updated Beanie models (which now type these fields as PydanticObjectId).

Run ONCE after deploying the model/query changes:

    python -m scripts.migrate_str_refs_to_objectid              # dry run (default)
    python -m scripts.migrate_str_refs_to_objectid --apply      # actually write

Safe to re-run: only documents whose target field is currently a string get
touched; fields already stored as ObjectId are skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient

from src.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrate_refs")

# Fields present on every MetadataMixin collection (IAM user references).
_META_SCALARS = ["created_by", "modified_by", "deleted_by"]

# collection_name -> {"scalar": [fields], "array": [fields]}
# scalar fields hold a single id; array fields hold a list of ids.
# Includes BOTH cross-collection refs (project_id, etc.) AND IAM refs
# (organisation_id, user_id, approver_id, created_by, ...).
COLLECTION_FIELDS: dict[str, dict[str, list[str]]] = {
    "clients": {
        "scalar": ["organisation_id", "contact_user_id", *_META_SCALARS],
        "array": [],
    },
    "projects": {
        "scalar": ["organisation_id", "client_id", *_META_SCALARS],
        "array": ["project_head_ids"],
    },
    "tasks": {
        "scalar": ["organisation_id", *_META_SCALARS],
        "array": [],
    },
    "project_tasks": {
        "scalar": ["organisation_id", "project_id", "task_id", *_META_SCALARS],
        "array": [],
    },
    "resource_assignments": {
        "scalar": ["organisation_id", "project_id", "task_id", "user_id", *_META_SCALARS],
        "array": [],
    },
    "weekly_timesheets": {
        "scalar": ["organisation_id", "user_id", *_META_SCALARS],
        "array": [],
    },
    "timesheet_entries": {
        "scalar": ["organisation_id", "weekly_timesheet_id", "project_id", "task_id", *_META_SCALARS],
        "array": [],
    },
    "approval_records": {
        "scalar": ["organisation_id", "weekly_timesheet_id", "approver_id", *_META_SCALARS],
        "array": ["scope_project_ids"],
    },
    "timesheet_project_approvals": {
        "scalar": ["organisation_id", "weekly_timesheet_id", "project_id",
                   "l1_approver_id", "client_approver_id", *_META_SCALARS],
        "array": [],
    },
    "timesheet_settings": {
        "scalar": ["organisation_id", "project_id", *_META_SCALARS],
        "array": [],
    },
    "approval_level_configs": {
        "scalar": ["organisation_id", "settings_id", "approver_id", *_META_SCALARS],
        "array": [],
    },
    "client_project_heads": {
        "scalar": ["organisation_id", "client_id", "iam_user_id", *_META_SCALARS],
        "array": [],
    },
    # NOTE: client_approval_tokens does NOT inherit MetadataMixin (no created_by, etc.)
    "client_approval_tokens": {
        "scalar": ["organisation_id", "timesheet_id", "approver_id"],
        "array": ["timesheet_ids", "project_ids"],
    },
}


def _to_oid(value):
    """Return ObjectId if value is a string that's a valid ObjectId, else None (skip)."""
    if isinstance(value, str) and ObjectId.is_valid(value):
        return ObjectId(value)
    return None


async def migrate(apply: bool) -> None:
    client = AsyncIOMotorClient(settings.MONGODB_URL, uuidRepresentation="standard")
    db = client[settings.MONGO_DB_NAME]
    logger.info("Connected db=%s apply=%s", settings.MONGO_DB_NAME, apply)

    grand_total = 0
    for coll_name, spec in COLLECTION_FIELDS.items():
        coll = db[coll_name]
        scalar_fields = spec["scalar"]
        array_fields = spec["array"]
        touched = 0

        cursor = coll.find({})
        async for doc in cursor:
            set_ops: dict = {}

            # Scalar fields: string -> ObjectId
            for f in scalar_fields:
                if f in doc:
                    oid = _to_oid(doc[f])
                    if oid is not None:
                        set_ops[f] = oid

            # Array fields: list[str] -> list[ObjectId]
            for f in array_fields:
                val = doc.get(f)
                if isinstance(val, list) and val:
                    converted = []
                    changed = False
                    for item in val:
                        oid = _to_oid(item)
                        if oid is not None:
                            converted.append(oid)
                            changed = True
                        else:
                            converted.append(item)  # already ObjectId or non-id
                    if changed:
                        set_ops[f] = converted

            if set_ops:
                touched += 1
                if apply:
                    await coll.update_one({"_id": doc["_id"]}, {"$set": set_ops})
                else:
                    logger.info("[dry-run] %s/%s would set %s",
                                coll_name, doc["_id"], list(set_ops.keys()))

        logger.info("%s: %d document(s) %s", coll_name, touched,
                    "updated" if apply else "would be updated")
        grand_total += touched

    # Nested: weekly_timesheets.attachments[].uploaded_by (str -> ObjectId)
    wt = db["weekly_timesheets"]
    nested_touched = 0
    async for doc in wt.find({"attachments": {"$exists": True, "$ne": []}}):
        attachments = doc.get("attachments") or []
        changed = False
        for att in attachments:
            oid = _to_oid(att.get("uploaded_by"))
            if oid is not None:
                att["uploaded_by"] = oid
                changed = True
        if changed:
            nested_touched += 1
            if apply:
                await wt.update_one({"_id": doc["_id"]}, {"$set": {"attachments": attachments}})
            else:
                logger.info("[dry-run] weekly_timesheets/%s would convert attachments[].uploaded_by", doc["_id"])
    logger.info("weekly_timesheets.attachments: %d document(s) %s",
                nested_touched, "updated" if apply else "would be updated")
    grand_total += nested_touched

    logger.info("DONE total=%d apply=%s", grand_total, apply)
    if not apply:
        logger.info("Dry run only — re-run with --apply to persist changes.")
    client.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Persist changes (default: dry run)")
    args = parser.parse_args()
    asyncio.run(migrate(args.apply))


if __name__ == "__main__":
    main()
