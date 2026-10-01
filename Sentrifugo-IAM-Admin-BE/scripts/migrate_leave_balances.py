"""Sagarsoft leave-balance migration  (IAM repo -> sentrifugo_lms).

"Balances now, plan later": the OLD system had ONE leave bucket. This script
seeds each ACTIVE employee's CURRENT balance into the balance TRACKER (what the
app reads to show balances), against the org's **"Earned Leave"** type.

  balance (days) = latest year's (emp_leave_limit - used_leaves)   [clamped >= 0]
  balance_hours  = balance_days * 8

Leave types are READ-ONLY here: "Earned Leave" must already exist in the org
(create it in the UI). The script never creates, edits or deletes a leave type —
it aborts if the type is missing. Only ONE collection is written:

  leave_employee_balance_tracker    (1 per active employee, keyed user_id+leave_type_id)

Modes:
    python -m scripts.migrate_leave_balances             # DRY RUN (writes nothing)
    python -m scripts.migrate_leave_balances --commit    # write (idempotent)
    python -m scripts.migrate_leave_balances --repoint --commit
                                                        # move trackers left on an
                                                        # older type onto "Earned Leave"
    python -m scripts.migrate_leave_balances --revert    # delete tagged trackers only

Every written doc carries  import_batch = IMPORT_BATCH  for a clean --revert.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

from bson import ObjectId
from pymongo import MongoClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.config import settings  # noqa: E402
from scripts.datafile import read_rows, find_file  # noqa: E402

# ───────────────────────── config ─────────────────────────
LMS_DB = "sentrifugo_lms"      # EXPLICIT target
IAM_DB = "sentrifugo_iam"
DEFAULT_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "data-dir", "attendance_balancehistory_export.2026-07-31.csv")
IMPORT_BATCH = "import_sagarsoft_leave_balance_2026"
HOURS_PER_DAY = 8.0

ORG_ID = ObjectId("6a481cbeefd9f278b3708209")            # Sagarsoft (India) Limited
MIGRATION_USER = ObjectId("6a481cbeefd9f278b370820a")   # audit actor: that org's admin

# The org's real leave type that holds these balances. Must already exist
# (configured in the UI) — this script only looks it up.
TARGET_TYPE_NAME = "Earned Leave"


# ───────────────────────── helpers ─────────────────────────
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def canon(c: str) -> str:
    c = (c or "").upper().replace(" ", "")
    m = re.match(r"^([A-Z]+)-?((?:C|I)-)?0*(\d+)$", c)
    return f"{m.group(1)}-{(m.group(2) or '')}{int(m.group(3))}" if m else c

# Ex-Sapplica (SIT) / SSI employees were imported into Sagarsoft under the SIL
# prefix (same number), but old exports carry the OLD code. Alias SIT-x/SSI-x ->
# SIL-x, EXCEPT SIT-158/159 — those two were skipped at import because their SIL
# numbers belong to DIFFERENT existing people (SIL-0158 Gopi Mora, SIL-0159
# Vishwanth Gunna); aliasing them would credit the wrong person.
NO_ALIAS = {"SIT-158", "SIT-159"}
def alias(code: str) -> str:
    if code.startswith(("SIT-", "SSI-")) and code not in NO_ALIAS:
        return "SIL-" + code.split("-", 1)[1]
    return code

def fnum(x) -> float:
    try:
        return float(str(x).strip())
    except (ValueError, AttributeError):
        return 0.0


def find_type(lms, name: str):
    """Look up a live leave type of the org by name (case/space-insensitive).
    Read-only: this script never creates or edits a leave type."""
    pattern = f"^\\s*{re.escape(name)}\\s*$"
    return lms["leave_types"].find_one(
        {"org_id": ORG_ID, "name": {"$regex": pattern, "$options": "i"}, "deleted_on": None})


def resolve_target_type(lms) -> dict:
    lt = find_type(lms, TARGET_TYPE_NAME)
    if not lt:
        raise SystemExit(
            f"ERROR: leave type {TARGET_TYPE_NAME!r} does not exist for org {ORG_ID} in "
            f"{LMS_DB}.leave_types.\n"
            f"       Create it in the UI first (active, deducts from balance), then re-run.\n"
            f"       This script never creates or modifies leave types."
        )
    if not lt.get("is_active", True):
        print(f"   WARNING: leave type {lt['name']!r} is INACTIVE — balances will be seeded "
              f"but employees cannot apply against it.")
    if not (lt.get("deduct_from_balance") or lt.get("deduct_from_leave_balance")):
        print(f"   WARNING: leave type {lt['name']!r} does not deduct from balance — seeded "
              f"balances will never be consumed.")
    return lt


def build_resolvers(iam):
    """canon(emp_code) -> {user_id, _id, active}."""
    exit_ids = {d["_id"] for d in iam["master_data"].find({"key": "exit"}, {"_id": 1})}
    emp = {}
    for e in iam["employees"].find(
        {"organisation_id": ORG_ID},
        {"emp_code": 1, "user_id": 1, "employment_status": 1},
    ):
        ec = canon(e.get("emp_code") or "")
        if not ec:
            continue
        emp[ec] = {
            "user_id": e.get("user_id"),
            "emp_id": e.get("_id"),
            "active": e.get("employment_status") not in exit_ids,
        }
        # Legacy exports write contract codes WITHOUT the -C-/-I- marker
        # (sheet says SIL-5036, IAM says SIL-C-5036) — register the plain
        # variant too so those rows resolve (real code wins on any clash).
        plain = re.sub(r"-(?:C|I)-", "-", ec, count=1)
        if plain != ec and plain not in emp:
            emp[plain] = emp[ec]
    return emp


def current_balance_by_emp(rows):
    """EmployeeID(canon) -> (balance_days, latest_year)."""
    by = defaultdict(dict)  # code -> {year: (limit, used)}
    for r in rows:
        code = alias(canon((r.get("EmployeeID") or "").strip()))
        yr = (r.get("alloted_year") or "").strip()
        if not code or not yr.isdigit():
            continue
        by[code][int(yr)] = (fnum(r.get("emp_leave_limit")), fnum(r.get("used_leaves")))
    out = {}
    for code, years in by.items():
        ly = max(years)
        lim, used = years[ly]
        out[code] = (max(lim - used, 0.0), ly)
    return out


# ───────────────────────── modes ─────────────────────────
def revert(lms):
    """Trackers only — leave types are never touched by this script."""
    n = lms["leave_employee_balance_tracker"].delete_many(
        {"import_batch": IMPORT_BATCH}).deleted_count
    print(f"  deleted {n:>5} from leave_employee_balance_tracker")
    print(f"Reverted {n} docs tagged import_batch={IMPORT_BATCH!r}. "
          f"leave_types left untouched.")


def repoint(lms, lt_id, commit_it: bool) -> None:
    """Move trackers THIS migration created (import_batch tagged) that are sitting on
    some other leave_type_id — an earlier target type, or one that has since been
    deleted, leaving them orphaned — onto the resolved target type.

    Scoped to `import_batch` on purpose: balances created by the app on any other
    leave type are never moved, modified or deleted.
    """
    coll = lms["leave_employee_balance_tracker"]
    docs = list(coll.find({"import_batch": IMPORT_BATCH, "leave_type_id": {"$ne": lt_id}},
                          {"user_id": 1, "leave_type_id": 1}))
    if not docs:
        print("  repoint: no tagged trackers sitting on another type.")
        return
    from_ids = {d["leave_type_id"] for d in docs}
    live = {t["_id"]: t.get("name") for t in lms["leave_types"].find(
        {"_id": {"$in": list(from_ids)}}, {"name": 1})}
    for fid in from_ids:
        print(f"  repoint: from {live.get(fid, '(deleted type)')} [{fid}] "
              f"{sum(1 for d in docs if d['leave_type_id'] == fid)} trackers")
    already = {d["user_id"] for d in coll.find(
        {"leave_type_id": lt_id, "user_id": {"$in": [d["user_id"] for d in docs]}}, {"user_id": 1})}
    movable = [d["_id"] for d in docs if d["user_id"] not in already]
    print(f"  repoint: {len(movable)} trackers -> {lt_id}"
          f"{f' ({len(already)} users already have one on the target — left as-is)' if already else ''}")
    if commit_it and movable:
        coll.update_many({"_id": {"$in": movable}},
                         {"$set": {"leave_type_id": lt_id, "updated_on": now_utc(),
                                   "updated_by": MIGRATION_USER}})


def org_user_ids(iam) -> list:
    """Every user of the org — trackers carry user_id, not org_id."""
    ids = {u["_id"] for u in iam["users"].find({"organisation_id": ORG_ID}, {"_id": 1})}
    ids |= {e["user_id"] for e in iam["employees"].find(
        {"organisation_id": ORG_ID, "user_id": {"$ne": None}}, {"user_id": 1})}
    return [i for i in ids if i]


def reset(lms, iam, commit_it: bool) -> None:
    """Zero every balance this org's users hold, on every leave type, and drop
    trackers pointing at a leave type that no longer exists (they render nowhere).

    Scoped by user_id, so no other organisation's balances are touched.
    """
    coll = lms["leave_employee_balance_tracker"]
    uids = org_user_ids(iam)
    live = [d["_id"] for d in lms["leave_types"].find(
        {"org_id": ORG_ID, "deleted_on": None}, {"_id": 1})]

    keep_q = {"user_id": {"$in": uids}, "leave_type_id": {"$in": live}}
    orphan_q = {"user_id": {"$in": uids}, "leave_type_id": {"$nin": live}}
    n_keep = coll.count_documents(keep_q)
    n_nonzero = coll.count_documents({**keep_q, "balance_hours": {"$gt": 0}})
    n_orphan = coll.count_documents(orphan_q)
    days = sum(d.get("balance_hours") or 0 for d in coll.find(
        {"user_id": {"$in": uids}}, {"balance_hours": 1})) / HOURS_PER_DAY

    print(f"  org users: {len(uids)}   live leave types: {len(live)}")
    print(f"  zero out : {n_keep} trackers on live types ({n_nonzero} currently non-zero)")
    print(f"  delete   : {n_orphan} orphan trackers (leave type no longer exists)")
    print(f"  balance currently held by this org: {days:.0f} days -> 0")

    if not commit_it:
        print("  (dry run — no writes)")
        return
    z = coll.update_many(keep_q, {"$set": {"balance_hours": 0.0, "updated_on": now_utc(),
                                           "updated_by": MIGRATION_USER}}).modified_count
    d = coll.delete_many(orphan_q).deleted_count
    print(f"  RESET DONE — zeroed {z}, deleted {d} orphans.")


def commit(lms, lt_id, trackers):
    """Upsert one tracker per employee on the target type: existing rows are SET to
    the sheet value (the reset leaves them at 0), missing rows are inserted."""
    coll = lms["leave_employee_balance_tracker"]
    ins = upd = 0
    for t in trackers:
        t["leave_type_id"] = lt_id
        existing = coll.find_one({"user_id": t["user_id"], "leave_type_id": lt_id}, {"_id": 1})
        if existing:
            coll.update_one({"_id": existing["_id"]},
                            {"$set": {"balance_hours": t["balance_hours"],
                                      "updated_on": now_utc(), "updated_by": MIGRATION_USER,
                                      "import_batch": IMPORT_BATCH}})
            upd += 1
        else:
            coll.insert_one(t)
            ins += 1
    print(f"  leave_employee_balance_tracker: inserted={ins} updated={upd}")


# ───────────────────────── outputs (report + clean csv) ─────────────────────────
def write_outputs(scripts_dir, mode, clean_rows, unhandled, st, balances, active_total):
    csv_path = os.path.join(scripts_dir, "sagarsoft_leave_balances_clean.csv")
    skip_path = os.path.join(scripts_dir, "sagarsoft_leave_balances_skipped.csv")
    md_path = os.path.join(scripts_dir, "leave_balance_import_report.md")

    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["emp_code", "user_id", "balance_year", "balance_days", "balance_hours"])
        w.writeheader()
        for r in clean_rows:
            w.writerow(r)
    with open(skip_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["emp_code", "balance_days", "reason"])
        w.writeheader()
        for r in unhandled:
            w.writerow(r)

    tot = sum(balances)
    bs = sorted(balances)
    not_in_org = [u for u in unhandled if "not found" in u["reason"]]
    no_row = [u for u in unhandled if "no balance row" in u["reason"]]

    L = [
        "# Sagarsoft — Leave BALANCE migration report", "",
        f"- Generated: {datetime.now().isoformat(sep=' ', timespec='seconds')}  (mode: **{mode}**)",
        f"- Target DB: `{LMS_DB}`  ·  org_id: `{ORG_ID}`  ·  import_batch: `{IMPORT_BATCH}`",
        "- Source: legacy balance sheet (per-employee, per-year limit & used)", "",
        "## What this does",
        f"Seeds each active employee's CURRENT balance into the balance tracker (what the app reads to",
        f"show balances), against the org's existing **\"{TARGET_TYPE_NAME}\"** type. Leave types are",
        "read-only here — none is created, edited or deleted.", "",
        "## 1. Summary", "",
        "| Item | Count |", "|---|---|",
        f"| Balance-sheet employees | {st['seeded'] + st['matched_inactive'] + st['unmatched']} |",
        f"| **Inserted correctly** (active employees seeded) | **{st['seeded']}** |",
        f"| Leave type used (existing, unmodified) | \"{TARGET_TYPE_NAME}\" |",
        f"| **Could not handle** (kept for review) | **{len(unhandled)}** |",
        f"| Total balance seeded | {tot:.0f} days ({tot*HOURS_PER_DAY:.0f} hours) |", "",
        "## 2. What we added & how we mapped", "",
        f"- **Leave type:** none created — balances attach to the existing **\"{TARGET_TYPE_NAME}\"**.",
        "- **Balance mapping:** for each employee, current balance = **latest year's (limit − used)**, "
        "clamped at ≥ 0, then **× 8 = balance_hours** (the system stores hours).",
        f"- **Intentionally not seeded:** {st['matched_inactive']} inactive (left) employees — they don't need a balance.",
        f"- Of the {st['seeded']} seeded, {st['zero']} have a zero balance (year's limit fully used).", "",
        "## 3. Inserted correctly  ✅", "",
        f"- **{st['seeded']}** active employees seeded (of {active_total} active total).",
    ]
    if balances:
        L.append(f"- Balance days: min **{bs[0]}** · max **{bs[-1]}** · avg **{sum(bs)/len(bs):.1f}**.")
    L += ["- Full per-employee list: `sagarsoft_leave_balances_clean.csv`.", ""]
    L += [
        "## 4. Could NOT handle — kept for review  ⚠️", "",
        "Edge cases we can't safely predict — listed so nothing is silently lost. Full list in "
        "`sagarsoft_leave_balances_skipped.csv`.", "",
        f"**{len(not_in_org)}** balance-sheet employees **not in our org** (left / not migrated):",
        "> " + (", ".join(u["emp_code"] for u in not_in_org) or "none"), "",
        f"**{len(no_row)}** **active** employees with **no balance row** in the sheet "
        "(recent joiners — they get a balance later with the plan/accrual):",
        "> " + (", ".join(u["emp_code"] for u in no_row) or "none"), "",
        "## 5. Reversibility",
        f"`python -m scripts.migrate_leave_balances --revert` — deletes ONLY the balance trackers tagged",
        f"`{IMPORT_BATCH}`. Leave types (and any balance on another type) are never touched.", "",
        "## 6. Output files",
        "- `scripts/sagarsoft_leave_balances_clean.csv` — one row per seeded employee",
        "- `scripts/sagarsoft_leave_balances_skipped.csv` — edge cases we could NOT handle, with the reason",
        "- `scripts/leave_balance_import_report.md` — this report",
    ]
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return csv_path, md_path


# ───────────────────────── main ─────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--data", help="balance export file (.csv or .xlsx); overrides --data-dir")
    ap.add_argument("--data-dir", help="folder holding the balance export (file picked by name)")
    ap.add_argument("--org-id", help="organisation id (default: built-in)")
    ap.add_argument("--reset", action="store_true",
                    help="before seeding, zero EVERY balance held by this org's users (all leave "
                         "types) and delete trackers whose leave type no longer exists")
    ap.add_argument("--repoint", action="store_true",
                    help=f"move trackers tagged by THIS batch that sit on another (or a deleted) "
                         f"leave type onto '{TARGET_TYPE_NAME}' instead of seeding duplicates")
    args = ap.parse_args()
    mode = "COMMIT" if args.commit else "REVERT" if args.revert else "DRY-RUN"

    global ORG_ID
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)

    client = MongoClient(settings.MONGODB_URL, serverSelectionTimeoutMS=8000)
    client.admin.command("ping")
    lms = client[LMS_DB]
    iam = client[IAM_DB]
    print(f"== leave-balance migration ==  mode={mode}  target_db={LMS_DB}  batch={IMPORT_BATCH}\n")

    if args.revert:
        revert(lms)
        client.close()
        return

    if args.data:
        data_path = args.data
    elif args.data_dir:
        data_path = find_file(args.data_dir, ["balance"])
    else:
        data_path = DEFAULT_DATA
    rows = read_rows(data_path)
    print(f"balance rows: {len(rows)}   (source: {data_path})")

    emp = build_resolvers(iam)
    active_total = sum(1 for v in emp.values() if v["active"])
    print(f"IAM employees: {len(emp)}  (active: {active_total})")

    bal = current_balance_by_emp(rows)
    print(f"balance-sheet employees: {len(bal)}")

    leave_type = resolve_target_type(lms)
    lt_id = leave_type["_id"]
    print(f"target leave type: {leave_type['name']!r} (code {leave_type.get('code')}) -> {lt_id}")

    trackers = []
    clean_rows = []
    unhandled = []
    st = {"seeded": 0, "matched_inactive": 0, "unmatched": 0, "zero": 0}
    balances = []
    for code, (days, year) in bal.items():
        e = emp.get(code)
        if not e:
            st["unmatched"] += 1
            unhandled.append({"emp_code": code, "balance_days": days,
                              "reason": "balance-sheet employee not found in our org (left / not migrated)"})
            continue
        if not e["active"]:
            st["matched_inactive"] += 1
            continue
        if days <= 0:
            st["zero"] += 1
        balances.append(days)
        clean_rows.append({"emp_code": code, "user_id": str(e["user_id"]),
                           "balance_year": year, "balance_days": days,
                           "balance_hours": round(days * HOURS_PER_DAY, 2)})
        trackers.append({
            "_id": ObjectId(),
            "user_id": e["user_id"],
            "leave_type_id": lt_id,
            "balance_hours": round(days * HOURS_PER_DAY, 2),
            "created_on": now_utc(), "created_by": MIGRATION_USER,
            "updated_on": None, "updated_by": None,
            "import_batch": IMPORT_BATCH,
        })
        st["seeded"] += 1

    # active employees with NO balance row -> also "could not handle"
    seeded_codes = {code for code in bal if emp.get(code, {}).get("active")}
    active_no_bal = [c for c, v in emp.items() if v["active"] and c not in seeded_codes]
    for c in active_no_bal:
        unhandled.append({"emp_code": c, "balance_days": "",
                          "reason": "active employee has no balance row in the sheet (e.g. recent joiner)"})

    # ---------------- report ----------------
    print(f"\n── LAYER 1: leave type (existing, read-only) ──")
    print(f"   '{leave_type['name']}' (code {leave_type.get('code')}) — not created, not modified")
    print(f"\n── LAYER 2: balances -> leave_employee_balance_tracker ──")
    print(f"   trackers to seed (active + has balance): {st['seeded']}")
    print(f"   matched but INACTIVE (skipped):          {st['matched_inactive']}")
    print(f"   balance-sheet emp not in our org:        {st['unmatched']}")
    print(f"   active employees with NO balance row:    {len(active_no_bal)}")
    print(f"   of seeded, zero-balance:                 {st['zero']}")
    if balances:
        balances.sort()
        print(f"   balance days -> min={balances[0]} max={balances[-1]} "
              f"avg={sum(balances)/len(balances):.1f}  total_days={sum(balances):.0f}")
    print(f"\n── sample trackers (first 5) ──")
    for t in trackers[:5]:
        print(f"   user_id={t['user_id']}  balance_hours={t['balance_hours']} "
              f"(= {t['balance_hours']/HOURS_PER_DAY:g} days)")

    existing_tr = lms["leave_employee_balance_tracker"].count_documents({"import_batch": IMPORT_BATCH})
    on_target = lms["leave_employee_balance_tracker"].count_documents({"leave_type_id": lt_id})
    if existing_tr or on_target:
        print(f"\n   NOTE: trackers already present -> tagged(batch)={existing_tr}, "
              f"on target type={on_target} (commit is idempotent; or --revert first).")

    if args.repoint:
        print(f"\n── repoint: tagged trackers -> '{leave_type['name']}' ──")
        repoint(lms, lt_id, args.commit)

    if args.reset:
        print(f"\n── RESET: zero every balance held by this org's users ──")
        reset(lms, iam, args.commit)

    if args.commit:
        print("\n== COMMIT: writing to sentrifugo_lms ==")
        commit(lms, lt_id, trackers)
        print("Done.")
    else:
        print("\nDRY-RUN — nothing written. Re-run with --commit to write, --revert to undo.")

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path, md_path = write_outputs(scripts_dir, mode, clean_rows, unhandled, st, balances, active_total)
    print(f"\nReport : {md_path}")
    print(f"Clean CSV: {csv_path}  ({len(clean_rows)} rows)")
    client.close()


if __name__ == "__main__":
    main()
