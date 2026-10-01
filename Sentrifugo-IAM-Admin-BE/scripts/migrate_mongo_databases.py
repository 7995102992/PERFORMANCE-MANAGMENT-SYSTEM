"""
Migrate all Sentrifugo databases from one MongoDB server to another.

Copies every collection (documents + indexes) of each database listed in
DATABASES from SOURCE_URI to TARGET_URI.

Usage:
    pip install pymongo
    python migrate_mongo_databases.py            # migrate
    python migrate_mongo_databases.py --dry-run  # show what would be migrated
"""

import sys
from pymongo import MongoClient
from pymongo.errors import BulkWriteError

# ---------------------------------------------------------------------------
# SETTINGS — edit these two values
# ---------------------------------------------------------------------------
SOURCE_URI = ""
TARGET_URI = ""

DATABASES = [
    "sentrifugo_iam",
    "sentrifugo_lms",
    "sentrifugo_payroll",
    "sentrifugo_srm",
    "sentrifugo_ssm",
    "sentrifugo_tsm",
]

BATCH_SIZE = 1000

# If True, target collections are dropped before copying (clean mirror).
# If False, documents are inserted; duplicates (_id conflicts) are skipped.
DROP_TARGET_COLLECTIONS = True
# ---------------------------------------------------------------------------


def migrate_collection(src_db, tgt_db, coll_name, dry_run=False):
    src_coll = src_db[coll_name]
    tgt_coll = tgt_db[coll_name]
    total = src_coll.estimated_document_count()

    if dry_run:
        print(f"    [dry-run] {coll_name}: {total} docs")
        return total, 0

    if DROP_TARGET_COLLECTIONS:
        tgt_coll.drop()

    copied = 0
    batch = []
    for doc in src_coll.find({}, batch_size=BATCH_SIZE):
        batch.append(doc)
        if len(batch) >= BATCH_SIZE:
            copied += insert_batch(tgt_coll, batch)
            batch = []
            print(f"    {coll_name}: {copied}/{total}", end="\r")
    if batch:
        copied += insert_batch(tgt_coll, batch)

    copy_indexes(src_coll, tgt_coll)
    print(f"    {coll_name}: {copied}/{total} docs copied")
    return total, copied


def insert_batch(tgt_coll, batch):
    try:
        result = tgt_coll.insert_many(batch, ordered=False)
        return len(result.inserted_ids)
    except BulkWriteError as e:
        # duplicate _id errors are skipped, everything else is fatal
        fatal = [err for err in e.details["writeErrors"] if err["code"] != 11000]
        if fatal:
            raise
        return e.details["nInserted"]


def copy_indexes(src_coll, tgt_coll):
    for index in src_coll.list_indexes():
        if index["name"] == "_id_":
            continue
        keys = list(index["key"].items())
        opts = {
            k: v
            for k, v in index.items()
            if k not in ("key", "v", "ns", "background")
        }
        name = opts.pop("name")
        try:
            tgt_coll.create_index(keys, name=name, **opts)
        except Exception as e:
            print(f"    WARNING: could not create index {name}: {e}")


def main():
    dry_run = "--dry-run" in sys.argv

    src_client = MongoClient(SOURCE_URI)
    tgt_client = MongoClient(TARGET_URI)

    # fail fast if either server is unreachable
    src_client.admin.command("ping")
    tgt_client.admin.command("ping")

    grand_total = 0
    for db_name in DATABASES:
        src_db = src_client[db_name]
        tgt_db = tgt_client[db_name]
        coll_names = src_db.list_collection_names()
        print(f"\n=== {db_name} ({len(coll_names)} collections) ===")

        for coll_name in sorted(coll_names):
            if coll_name.startswith("system."):
                continue
            total, copied = migrate_collection(src_db, tgt_db, coll_name, dry_run)
            grand_total += copied if not dry_run else total

    label = "would be migrated" if dry_run else "migrated"
    print(f"\nDone. {grand_total} documents {label}.")

    src_client.close()
    tgt_client.close()


if __name__ == "__main__":
    main()
