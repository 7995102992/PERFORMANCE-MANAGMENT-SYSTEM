"""Mirror whole databases from one MongoDB server to another  (DESTRUCTIVE).

Makes the TARGET an exact copy of the SOURCE: every collection is emptied on the
target and re-filled with the source documents **verbatim, `_id` included**, so
every cross-database reference (user_id, leave_type_id, ...) keeps working.

Protected: `sentrifugo_lms.attendance_punches` on the target is never read,
never emptied and never written — it is left exactly as it is. Add more with
--skip db.collection.

Collections that exist only on the TARGET are emptied too (the target must not
keep rows the source doesn't have), except protected ones.

Source and target are hardcoded below (SOURCE_URI / TARGET_URI) — set TARGET_URI
before the first run. --source / --target still override them ad hoc.

Modes:
    python -m scripts.mirror_db                  # DRY RUN — what would be deleted/copied
    python -m scripts.mirror_db --commit         # wipe + copy for real
    python -m scripts.mirror_db --db sentrifugo_lms --commit      # one database only

--db defaults to sentrifugo_iam and sentrifugo_lms. Indexes are NOT copied (the
app rebuilds them at startup); pass --with-indexes to recreate them too.
"""
from __future__ import annotations

import argparse
import os
import sys

from pymongo import MongoClient
from pymongo.errors import BulkWriteError

# ───────────────────────── endpoints ─────────────────────────
# Server URIs, no database in the path — the databases come from --db / DEFAULT_DBS.
# Both can be overridden per run with --source / --target.
#
# NOTE: these carry credentials. Prefer setting MIRROR_SOURCE_URI / MIRROR_TARGET_URI
# in the environment (they win over the literals below) and keep real passwords out
# of the repo — this file is committed.
SOURCE_URI = os.getenv(
    "MIRROR_SOURCE_URI",
    "",
)
TARGET_URI = os.getenv(
    "MIRROR_TARGET_URI",
    "",  # <-- SET ME: mongodb://user:pass@host:27017/?authSource=admin
)

DEFAULT_DBS = [
"sentrifugo_iam",
"sentrifugo_lms",
"sentrifugo_payroll",
"sentrifugo_srm",
"sentrifugo_tsm"
]
# Never touched on the TARGET — not emptied, not written.
PROTECTED = {"sentrifugo_lms.attendance_punches"}
BATCH = 1000


def host_of(uri: str) -> str:
    """Host:port for display — credentials stripped."""
    tail = uri.split("://", 1)[-1]
    return tail.split("@")[-1].split("/")[0]


def collections_of(db) -> list[str]:
    return sorted(c["name"] for c in db.list_collections(filter={"type": "collection"})
                  if not c["name"].startswith("system."))


def copy_collection(src, tgt, name: str, commit: bool) -> tuple[int, int, int]:
    """-> (source docs, target docs deleted, docs inserted)."""
    n_src = src[name].estimated_document_count()
    n_tgt = tgt[name].estimated_document_count()
    if not commit:
        return n_src, n_tgt, 0

    tgt[name].delete_many({})
    inserted, buf = 0, []
    for doc in src[name].find({}, batch_size=BATCH):
        buf.append(doc)
        if len(buf) >= BATCH:
            inserted += _flush(tgt[name], buf)
            buf = []
    if buf:
        inserted += _flush(tgt[name], buf)
    return n_src, n_tgt, inserted


def _flush(coll, docs) -> int:
    try:
        return len(coll.insert_many(docs, ordered=False).inserted_ids)
    except BulkWriteError as exc:
        wrote = exc.details.get("nInserted", 0)
        print(f"      ! {len(exc.details.get('writeErrors', []))} write errors "
              f"(first: {exc.details['writeErrors'][0]['errmsg'][:120]})")
        return wrote


def copy_indexes(src, tgt, name: str, commit: bool) -> int:
    specs = [ix for ix in src[name].list_indexes() if ix["name"] != "_id_"]
    if not commit:
        return len(specs)
    made = 0
    for ix in specs:
        keys = list(ix["key"].items())
        opts = {k: v for k, v in ix.items()
                if k not in ("key", "v", "ns", "background", "textIndexVersion")}
        opts.pop("name", None)
        try:
            tgt[name].create_index(keys, name=ix["name"], **opts)
            made += 1
        except Exception as exc:  # noqa: BLE001 — an index clash must not abort the mirror
            print(f"      ! index {ix['name']}: {exc}")
    return made


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", default=SOURCE_URI,
                   help="override the hardcoded SOURCE_URI")
    p.add_argument("--target", default=TARGET_URI,
                   help="override the hardcoded TARGET_URI — WILL BE OVERWRITTEN")
    p.add_argument("--db", action="append", metavar="NAME",
                   help=f"database to mirror, repeatable (default: {' '.join(DEFAULT_DBS)})")
    p.add_argument("--skip", action="append", default=[], metavar="DB.COLL",
                   help="extra collection to leave untouched on the target (repeatable)")
    p.add_argument("--with-indexes", action="store_true",
                   help="also recreate the source's indexes on the target")
    p.add_argument("--commit", action="store_true", help="do it (default is a dry run)")
    args = p.parse_args()

    if not args.source:
        raise SystemExit("ERROR: SOURCE_URI is empty — set it at the top of this script "
                         "(or pass --source / MIRROR_SOURCE_URI).")
    if not args.target:
        raise SystemExit("ERROR: TARGET_URI is empty — set it at the top of this script "
                         "(or pass --target / MIRROR_TARGET_URI).")
    protected = PROTECTED | {s.strip() for s in args.skip}
    dbs = args.db or DEFAULT_DBS

    src_cli = MongoClient(args.source, serverSelectionTimeoutMS=8000)
    tgt_cli = MongoClient(args.target, serverSelectionTimeoutMS=8000)
    for label, cli, uri in (("source", src_cli, args.source), ("target", tgt_cli, args.target)):
        try:
            cli.admin.command("ping")
        except Exception as exc:  # noqa: BLE001 — a clean message beats a driver traceback
            raise SystemExit(f"ERROR: cannot reach {label} {host_of(uri)} — {type(exc).__name__}: "
                             f"{str(exc)[:160]}")

    src_host, tgt_host = host_of(args.source), host_of(args.target)
    if src_host == tgt_host:
        raise SystemExit(f"ERROR: source and target are the same server ({src_host}). Refusing.")

    print(f"== mirror ==  {'COMMIT' if args.commit else 'DRY-RUN'}")
    print(f"   source : {src_host}")
    print(f"   target : {tgt_host}   <-- everything here is replaced")
    print(f"   dbs    : {', '.join(dbs)}")
    print(f"   protected on target: {', '.join(sorted(protected))}\n")

    grand = {"src": 0, "del": 0, "ins": 0, "idx": 0}
    for dbname in dbs:
        src, tgt = src_cli[dbname], tgt_cli[dbname]
        src_colls = collections_of(src)
        tgt_colls = collections_of(tgt)
        extra = [c for c in tgt_colls if c not in src_colls]
        print(f"── {dbname} ──  source collections: {len(src_colls)}")

        for name in src_colls:
            key = f"{dbname}.{name}"
            if key in protected:
                print(f"   {name:38} PROTECTED — untouched "
                      f"(target holds {tgt[name].estimated_document_count()} docs)")
                continue
            n_src, n_tgt, ins = copy_collection(src, tgt, name, args.commit)
            idx = copy_indexes(src, tgt, name, args.commit) if args.with_indexes else 0
            grand["src"] += n_src; grand["del"] += n_tgt; grand["ins"] += ins; grand["idx"] += idx
            verb = f"deleted {n_tgt:>7} -> inserted {ins:>7}" if args.commit \
                else f"would delete {n_tgt:>7} -> copy {n_src:>7}"
            flag = ""
            if args.commit and ins != n_src:
                flag = f"   !! MISMATCH source={n_src}"
            print(f"   {name:38} {verb}{flag}")

        for name in extra:
            key = f"{dbname}.{name}"
            if key in protected:
                print(f"   {name:38} PROTECTED (target-only) — untouched")
                continue
            n = tgt[name].estimated_document_count()
            if not n:
                continue
            grand["del"] += n
            if args.commit:
                tgt[name].delete_many({})
                print(f"   {name:38} target-only — emptied {n} docs")
            else:
                print(f"   {name:38} target-only — would empty {n} docs")
        print()

    src_cli.close()
    tgt_cli.close()
    if args.commit:
        print(f"DONE — inserted {grand['ins']} docs (source had {grand['src']}), "
              f"deleted {grand['del']} on the target"
              + (f", {grand['idx']} indexes created" if args.with_indexes else ""))
    else:
        print(f"DRY-RUN — would delete {grand['del']} docs on {tgt_host} and copy "
              f"{grand['src']} from {src_host}. Re-run with --commit.")


if __name__ == "__main__":
    main()
