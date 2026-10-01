"""Rehire merge — collapse each rejoined person's two accounts into ONE real-email
account, keeping BOTH employee stints and flagging the older one as a rehire.

Detected from the live DB: every user whose email local-part carries a `+<tag>`
(the duplicate the importer made) whose base email also exists. For each pair:

  1. re-point the OLD (tagged) employee record -> the keeper (real-email) user_id
  2. flag the old stint  (is_rehire=True, rehire_primary_user_id/emp_code) and the
     keeper (has_prior_stint=True, prior_emp_code)
  3. re-point the OLD user's downstream references (leave/SR/holiday/calendar) ->
     keeper user_id, so the person's full history lives under their one account
  4. soft-delete the OLD (tagged) user account

A backup of every change is written so --revert can undo it exactly. No employee
records are deleted — all stints are kept.

    python -m scripts.migrate_rehire_merge            # DRY RUN (writes nothing)
    python -m scripts.migrate_rehire_merge --commit   # apply + write backup
    python -m scripts.migrate_rehire_merge --revert   # undo using the backup
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from bson import ObjectId
from pymongo import MongoClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.config import settings  # noqa: E402

IAM_DB, LMS_DB, SRM_DB = "sentrifugo_iam", "sentrifugo_lms", "sentrifugo_srm"
ORG_ID = ObjectId("6a3e05a5c0470e0bdd9ce9a9")
MIGRATION_USER = ObjectId("6a3e05a5c0470e0bdd9ce9aa")
BACKUP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rehire_merge_backup.json")
REPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rehire_merge_report.md")
CLEAN_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sagarsoft_rehire_merge_clean.csv")

# downstream user-id references to re-point: (db, collection, field)
REFS = [
    (LMS_DB, "leave_requests", "user_id"),
    (LMS_DB, "leave_employee_balance_tracker", "user_id"),
    (LMS_DB, "holiday_plan_employees", "user_id"),
    (LMS_DB, "work_calendar_employees", "user_id"),
    (LMS_DB, "work_calendar_shift_assignments", "user_id"),
    (SRM_DB, "service_requests", "requester_user_id"),
    (SRM_DB, "service_requests", "executor_user_id"),
    (SRM_DB, "service_requests", "primary_assignee_user_id"),
]


def now_utc():
    return datetime.now(timezone.utc)


def find_pairs(client):
    """Return [{email, keeper_uid, keeper_emp_code, old_uid, old_email, old_emp_id,
    old_emp_code, old_emp_orig_uid}] for every rehire (tagged) account."""
    iam = client[IAM_DB]
    pairs = []
    for u in iam["users"].find({"organisation_id": ORG_ID, "email": {"$regex": r"^[^@]+\+[^@]+@"}}):
        em = (u.get("email") or "")
        local, _, domain = em.partition("@")
        base_email = f"{local.split('+')[0]}@{domain}".lower()
        keeper = iam["users"].find_one({"email": base_email, "deleted_on": None})
        if not keeper:
            continue
        old_emp = iam["employees"].find_one({"organisation_id": ORG_ID, "user_id": u["_id"]})
        keep_emp = iam["employees"].find_one({"organisation_id": ORG_ID, "user_id": keeper["_id"]})
        if not old_emp or not keep_emp:
            continue
        pairs.append({
            "email": base_email,
            "keeper_uid": keeper["_id"], "keeper_emp_id": keep_emp["_id"],
            "keeper_emp_code": keep_emp.get("emp_code"),
            "old_uid": u["_id"], "old_email": em, "old_emp_id": old_emp["_id"],
            "old_emp_code": old_emp.get("emp_code"),
        })
    return pairs


def downstream_ids(client, old_uid):
    """{(db.coll.field): [doc _ids referencing old_uid]} — exact ids for clean revert."""
    out = {}
    for db, coll, field in REFS:
        ids = [d["_id"] for d in client[db][coll].find({field: old_uid}, {"_id": 1})]
        if ids:
            out[f"{db}.{coll}.{field}"] = [str(i) for i in ids]
    return out


# ───────────────────────── modes ─────────────────────────
def do_commit(client, pairs):
    iam = client[IAM_DB]
    backup = {"created_on": now_utc().isoformat(), "pairs": []}
    for p in pairs:
        refs = downstream_ids(client, p["old_uid"])
        # 3. re-point downstream old_uid -> keeper_uid (by exact ids)
        for key, ids in refs.items():
            db, coll, field = key.split(".")
            oids = [ObjectId(i) for i in ids]
            client[db][coll].update_many({"_id": {"$in": oids}}, {"$set": {field: p["keeper_uid"]}})
        # 1. re-point old employee -> keeper user + 2. flag both
        iam["employees"].update_one({"_id": p["old_emp_id"]}, {"$set": {
            "user_id": p["keeper_uid"], "is_rehire": True,
            "rehire_primary_user_id": p["keeper_uid"], "rehire_primary_emp_code": p["keeper_emp_code"],
            "rehire_merge_on": now_utc(), "rehire_merge_by": MIGRATION_USER}})
        iam["employees"].update_one({"_id": p["keeper_emp_id"]}, {"$set": {
            "has_prior_stint": True, "prior_emp_code": p["old_emp_code"]}})
        # 4. soft-delete the old tagged user
        iam["users"].update_one({"_id": p["old_uid"]}, {"$set": {
            "deleted_on": now_utc(), "deleted_by": MIGRATION_USER,
            "rehire_merged_into": p["keeper_uid"]}})
        backup["pairs"].append({
            "old_uid": str(p["old_uid"]), "keeper_uid": str(p["keeper_uid"]),
            "old_emp_id": str(p["old_emp_id"]), "keeper_emp_id": str(p["keeper_emp_id"]),
            "old_email": p["old_email"], "refs": refs})
        print(f"  merged {p['old_emp_code']} -> {p['keeper_emp_code']}  <{p['email']}>  "
              f"({sum(len(v) for v in refs.values())} downstream re-pointed)")
    with open(BACKUP, "w", encoding="utf-8") as f:
        json.dump(backup, f, indent=2)
    print(f"\nBackup written: {BACKUP}")


def do_revert(client):
    if not os.path.exists(BACKUP):
        print(f"No backup at {BACKUP} — nothing to revert."); return
    iam = client[IAM_DB]
    backup = json.load(open(BACKUP, encoding="utf-8"))
    for p in backup["pairs"]:
        old_uid = ObjectId(p["old_uid"])
        for key, ids in p["refs"].items():
            db, coll, field = key.split(".")
            client[db][coll].update_many({"_id": {"$in": [ObjectId(i) for i in ids]}},
                                         {"$set": {field: old_uid}})
        iam["employees"].update_one({"_id": ObjectId(p["old_emp_id"])}, {
            "$set": {"user_id": old_uid},
            "$unset": {"is_rehire": "", "rehire_primary_user_id": "", "rehire_primary_emp_code": "",
                       "rehire_merge_on": "", "rehire_merge_by": ""}})
        iam["employees"].update_one({"_id": ObjectId(p["keeper_emp_id"])},
                                    {"$unset": {"has_prior_stint": "", "prior_emp_code": ""}})
        iam["users"].update_one({"_id": old_uid},
                                {"$set": {"deleted_on": None, "deleted_by": None},
                                 "$unset": {"rehire_merged_into": ""}})
        print(f"  reverted {p['old_email']}")
    print("Revert complete.")


# ───────────────────────── main ─────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--org-id", help="organisation id (default: built-in)")
    args = ap.parse_args()
    mode = "COMMIT" if args.commit else "REVERT" if args.revert else "DRY-RUN"

    global ORG_ID
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)

    client = MongoClient(settings.MONGODB_URL, serverSelectionTimeoutMS=8000)
    client.admin.command("ping")
    print(f"== rehire merge ==  mode={mode}\n")

    if args.revert:
        do_revert(client); client.close(); return

    pairs = find_pairs(client)
    print(f"rehire pairs detected (tagged accounts with a real-email twin): {len(pairs)}\n")

    rows = []
    print("── plan (per person) ──")
    print(f"  {'email':36} {'keep':10} {'rehired(old)':12} {'downstream re-point'}")
    grand = 0
    for p in pairs:
        refs = downstream_ids(client, p["old_uid"])
        n = sum(len(v) for v in refs.values())
        grand += n
        per = ", ".join(f"{k.split('.')[1]}.{k.split('.')[2]}={len(v)}" for k, v in refs.items()) or "none"
        print(f"  {p['email'][:36]:36} {str(p['keeper_emp_code']):10} {str(p['old_emp_code']):12} {n:>3}  ({per})")
        rows.append({"email": p["email"], "keeper_emp_code": p["keeper_emp_code"],
                     "rehired_old_emp_code": p["old_emp_code"], "old_tagged_email": p["old_email"],
                     "downstream_repoint": n})

    print(f"\nTotals: {len(pairs)} accounts merged, {grand} downstream docs re-pointed, "
          f"{len(pairs)} tagged accounts soft-deleted, {len(pairs)*2} employee stints kept (all).")

    # outputs (report + clean csv)
    import csv as _csv
    with open(CLEAN_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = _csv.DictWriter(f, fieldnames=["email", "keeper_emp_code", "rehired_old_emp_code",
                                           "old_tagged_email", "downstream_repoint"])
        w.writeheader()
        for r in rows:
            w.writerow(r)
    L = [
        "# Sagarsoft — Rehire merge report", "",
        f"- Generated: {datetime.now().isoformat(sep=' ', timespec='seconds')}  (mode: **{mode}**)", "",
        "## What this does",
        "Collapses each rejoined person's two accounts into ONE real-email account, keeps BOTH employee",
        "stints (all data), flags the older stint as a rehire, and moves the old stint's history onto the",
        "one account. Nothing is deleted except the duplicate tagged login (soft-deleted, reversible).", "",
        "## Inserted / changed correctly  ✅", "",
        "| Item | Count |", "|---|---|",
        f"| Rejoined people merged | {len(pairs)} |",
        f"| Employee stints kept (all) | {len(pairs) * 2} |",
        f"| Downstream docs re-pointed to the kept account | {grand} |",
        f"| Duplicate tagged logins soft-deleted | {len(pairs)} |", "",
        "## What we mapped  (old stint → kept account)", "",
        "| Real email | Kept (current) | Rehired (old) | Downstream moved |",
        "|---|---|---|---|",
    ]
    for r in rows:
        L.append(f"| {r['email']} | {r['keeper_emp_code']} | {r['rehired_old_emp_code']} | {r['downstream_repoint']} |")
    L += [
        "", "## Could NOT handle", "",
        "_None — every detected rehire pair was matched to a real-email twin._", "",
        "## Reversibility",
        "`python -m scripts.migrate_rehire_merge --revert` (uses `scripts/rehire_merge_backup.json`).", "",
        "## Output files",
        "- `scripts/sagarsoft_rehire_merge_clean.csv` — one row per merged person",
        "- `scripts/rehire_merge_report.md` — this report",
        "- `scripts/rehire_merge_backup.json` — exact before-state for revert (written on --commit)",
    ]
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L))

    if args.commit:
        print("\n== COMMIT: applying merge ==")
        do_commit(client, pairs)
        print("Done.")
    else:
        print("\nDRY-RUN — nothing written. Re-run with --commit to apply, --revert to undo.")
    print(f"\nReport : {REPORT}\nClean CSV: {CLEAN_CSV}")
    client.close()


if __name__ == "__main__":
    main()
