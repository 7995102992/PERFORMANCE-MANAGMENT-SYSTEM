"""Sagarsoft leave-history migration  (IAM repo -> sentrifugo_lms).

Imports the legacy leave/attendance applications into `leave_requests` (for
viewing past leave). Each record is attached to a leave type that ALREADY EXISTS
in the org — configured in the UI. This script is strictly read-only on
`leave_types`: it never creates, edits or deletes one, and --revert leaves them
alone. Legacy names are matched to existing types case-insensitively, with
LEGACY_TYPE_MAP for the ones whose name changed.

A dry run prints every legacy type and the type it resolves to; anything
unresolved is listed as MISSING with its row count, so you know exactly what to
create in the UI. --commit refuses to run while anything is MISSING unless
--skip-unmapped is passed (those rows then go to the skipped CSV).

Records carry leave_plan_id = None (no plan yet; wired later). Balances are
untouched — they are seeded by scripts/migrate_leave_balances.py.

Modes:
    python -m scripts.migrate_leave_history            # DRY RUN (writes nothing)
    python -m scripts.migrate_leave_history --commit   # write (idempotent by src leave no.)
    python -m scripts.migrate_leave_history --revert   # delete tagged leave_requests only

Every written doc carries  import_batch = IMPORT_BATCH  for a clean --revert.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone

from bson import ObjectId
from pymongo import MongoClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.config import settings  # noqa: E402
from scripts.datafile import read_rows, find_file  # noqa: E402

# ───────────────────────── config ─────────────────────────
LMS_DB = "sentrifugo_lms"
IAM_DB = "sentrifugo_iam"
DEFAULT_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "data-dir", "leave_history_export.2026-07-31.csv")
IMPORT_BATCH = "import_sagarsoft_leave_history_2026"
ORG_ID = ObjectId("6a481cbeefd9f278b3708209")          # Sagarsoft (India) Limited
MIGRATION_USER = ObjectId("6a481cbeefd9f278b370820a")  # audit actor: that org's admin
# Legacy export type name (lowercased) -> the leave type NAME configured in the
# org today. Only needed where the name differs; everything else matches on name
# case-insensitively. The balance migration seeds its balances on "Earned Leave",
# so the legacy "Earned Leave" rows land on that very same type.
LEGACY_TYPE_MAP = {
    "leave": "Earned Leave",
    "earned leave": "Earned Leave",
    "wellness leave": "Wellness Leave",
    # No separate type for these in the org — they are all work-from-home variants.
    "remote work": "Work From Home",
    "hybrid work - wfh": "Work From Home",
}

STATUS_MAP = {
    "approved": "APPROVED",
    "cancel": "CANCELLED",
    "cancelled": "CANCELLED",
    "pending for approval": "PENDING",
    "rejected": "REJECTED",
}


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
# Vishwanth Gunna); aliasing them would attribute records to the wrong person.
NO_ALIAS = {"SIT-158", "SIT-159"}
def alias(code: str) -> str:
    if code.startswith(("SIT-", "SSI-")) and code not in NO_ALIAS:
        return "SIL-" + code.split("-", 1)[1]
    return code

def code_of(name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", (name or "").upper()).strip("_")[:40] or "UNKNOWN"

def fix_moji(s):
    s = s or ""
    if any(m in s for m in ("Ã", "â€", "Â", "ï¿½")):
        for enc in ("cp1252", "latin-1"):
            try:
                return s.encode(enc).decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
    return s

def fnum(x) -> float:
    try:
        return float(str(x).strip())
    except (ValueError, AttributeError):
        return 0.0

def parse_dt(v):
    v = (v or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(v, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None

def audit(created_on, created_by):
    return {
        "created_on": created_on or now_utc(), "created_by": created_by,
        "updated_on": None, "updated_by": None,
        "deleted_on": None, "deleted_by": None,
        "correlation_id": str(uuid.uuid4()), "import_batch": IMPORT_BATCH,
    }


def norm_type(s: str) -> str:
    """Fold a leave-type name for matching: case + whitespace insensitive."""
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def resolve_types(lms, legacy_names: list[str]) -> tuple[dict, dict]:
    """legacy name -> existing leave_type _id, plus the ones we could not resolve.

    READ-ONLY: existing types are matched, never created or modified.
    """
    by_name, by_code = {}, {}
    for d in lms["leave_types"].find({"org_id": ORG_ID, "deleted_on": None},
                                     {"name": 1, "code": 1, "is_active": 1}):
        by_name.setdefault(norm_type(d.get("name")), d)
        if d.get("code"):
            by_code.setdefault(d["code"].strip().upper(), d)

    resolved, missing = {}, {}
    for nm in legacy_names:
        target = LEGACY_TYPE_MAP.get(norm_type(nm), nm)
        # Name first, then CODE — types created by an earlier run carry
        # code_of(legacy name), so a type since RENAMED in the UI still matches
        # its legacy name and keeps every record pointing at the same _id.
        hit = (by_name.get(norm_type(target))
               or by_code.get(code_of(target))
               or by_code.get(code_of(nm)))
        if hit:
            resolved[nm] = hit
        else:
            missing[nm] = target
    return resolved, missing


def build_resolvers(iam):
    code_to_uid = {}
    for e in iam["employees"].find({"organisation_id": ORG_ID}, {"emp_code": 1, "user_id": 1}):
        ec = canon(e.get("emp_code") or "")
        if ec and e.get("user_id"):
            code_to_uid[ec] = e["user_id"]
            # Legacy exports write contract codes WITHOUT the -C-/-I- marker
            # (sheet says SIL-5036, IAM says SIL-C-5036) — register the plain
            # variant too so those rows resolve (real code wins on any clash).
            plain = re.sub(r"-(?:C|I)-", "-", ec, count=1)
            if plain != ec:
                code_to_uid.setdefault(plain, e["user_id"])
    return code_to_uid


# ───────────────────────── build ─────────────────────────
def build(rows, lms, iam):
    code_to_uid = build_resolvers(iam)

    # leave types: match every distinct legacy name to a type that already exists
    # in the org. Nothing is created here.
    names = []
    for r in rows:
        nm = (r.get("leavetype_name") or "").strip()
        if nm and nm not in names:
            names.append(nm)
    resolved, missing = resolve_types(lms, names)
    type_id = {nm: d["_id"] for nm, d in resolved.items()}

    # leave requests
    requests = []
    clean_rows = []
    skipped = []
    st = Counter()
    for r in rows:
        emp_id_raw = (r.get("EmployeeID") or "").strip()
        nm = (r.get("leavetype_name") or "").strip()
        uid = code_to_uid.get(alias(canon(emp_id_raw)))
        if not uid:
            st["unresolved_requester"] += 1
            if not emp_id_raw:
                why = "row has NO employee code — nobody to attach the record to"
            elif canon(emp_id_raw) in NO_ALIAS:
                why = ("employee deliberately SKIPPED at import — their SIL number already "
                       "belongs to a different person (SIL-0158 Gopi Mora / SIL-0159 Vishwanth "
                       "Gunna), so importing would credit the wrong account")
            else:
                why = "emp-code not in the employee export — this person was never migrated"
            skipped.append({"src_leave_no": (r.get("LeaveNumber") or "").strip(),
                            "employee_id": emp_id_raw, "leave_type": nm,
                            "from_date": (r.get("from_date") or "").strip(),
                            "reason": why})
            continue
        lt_id = type_id.get(nm)
        if not lt_id:
            st["no_type"] += 1
            skipped.append({"src_leave_no": (r.get("LeaveNumber") or "").strip(),
                            "employee_id": emp_id_raw, "leave_type": nm,
                            "from_date": (r.get("from_date") or "").strip(),
                            "reason": f"leave type {nm!r} is not configured in this org "
                                      f"(target: {missing.get(nm, nm)!r}) — create it in the UI, "
                                      f"or add a LEGACY_TYPE_MAP entry, then re-run"})
            continue
        status = STATUS_MAP.get((r.get("leavestatus") or "").strip().lower(), "APPROVED")
        st[status] += 1
        sd = parse_dt(r.get("from_date")); ed = parse_dt(r.get("to_date"))
        if sd and ed:
            end_dt = ed.replace(hour=23, minute=59, second=59)
            if end_dt < sd:
                end_dt = sd.replace(hour=23, minute=59, second=59)
        else:
            end_dt = sd
        days = fnum(r.get("appliedleavescount"))
        created = parse_dt(r.get("createddate"))
        doc = {
            "_id": ObjectId(),
            "user_id": uid,
            "leave_type_id": lt_id,
            "leave_plan_id": None,
            "loss_of_pay": nm.strip().lower() == "loss of pay",
            # LMS stores start_date/end_date as plain "YYYY-MM-DD" strings (date-only,
            # no time component) — derive from the parsed datetimes rather than passing
            # the raw source string through, which may carry a time part or a non-ISO layout.
            "start_date": sd.date().isoformat() if sd else None,
            "end_date": end_dt.date().isoformat() if end_dt else None,
            "start_datetime": sd,
            "end_datetime": end_dt,
            "duration_mode": "FULL_DAYS",
            "half_day_period": None, "start_session": None, "end_session": None,
            "duration_hours": round(days * 8.0, 2),
            "duration_days": days,
            "status": status,
            "approval_state": {"current_level": 1, "approved_by": []},
            "reason": fix_moji((r.get("Reason") or "").strip()) or None,
            "notify_cc": [], "asset_ids": [],
            "src_leave_no": (r.get("LeaveNumber") or "").strip(),   # idempotency key
            "src_leave_type": nm,
            **audit(created, uid),
        }
        requests.append(doc)
        clean_rows.append({
            "src_leave_no": doc["src_leave_no"],
            "employee_id": (r.get("EmployeeID") or "").strip(),
            "user_id": str(uid),
            "leave_type": nm,
            "status": status,
            "start_date": doc["start_date"] or "",
            "end_date": doc["end_date"] or "",
            "duration_days": doc["duration_days"],
        })
    return resolved, missing, type_id, requests, clean_rows, skipped, st


# ───────────────────────── modes ─────────────────────────
def revert(lms):
    """leave_requests only — leave types are never created or deleted here, so a
    revert can't strip a type the org still uses (or orphan other records)."""
    n = lms["leave_requests"].delete_many({"import_batch": IMPORT_BATCH}).deleted_count
    print(f"  deleted {n:>6} from leave_requests")
    print(f"Reverted {n} docs tagged import_batch={IMPORT_BATCH!r}. leave_types untouched.")


def commit(lms, requests):
    # leave_type_id already points at an existing type (resolve_types) — nothing
    # to create or remap.
    # idempotent by src_leave_no within this batch
    existing = {d["src_leave_no"] for d in lms["leave_requests"].find(
        {"import_batch": IMPORT_BATCH}, {"src_leave_no": 1})}
    todo = [d for d in requests if d["src_leave_no"] not in existing]
    ins = 0
    for i in range(0, len(todo), 2000):
        chunk = todo[i:i + 2000]
        lms["leave_requests"].insert_many(chunk)
        ins += len(chunk)
    print(f"  leave_requests: inserted={ins} skipped(existing)={len(requests) - len(todo)}")


# ───────────────────────── outputs (report + clean csv) ─────────────────────────
def write_outputs(scripts_dir, mode, resolved, missing, requests, clean_rows, skipped, st):
    csv_path = os.path.join(scripts_dir, "sagarsoft_leave_history_clean.csv")
    skip_path = os.path.join(scripts_dir, "sagarsoft_leave_history_skipped.csv")
    md_path = os.path.join(scripts_dir, "leave_history_import_report.md")

    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["src_leave_no", "employee_id", "user_id", "leave_type",
                                          "status", "start_date", "end_date", "duration_days"])
        w.writeheader()
        for r in clean_rows:
            w.writerow(r)
    with open(skip_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["src_leave_no", "employee_id", "leave_type", "from_date", "reason"])
        w.writeheader()
        for r in skipped:
            w.writerow(r)

    type_counts = Counter(d["src_leave_type"] for d in requests)
    status_counts = Counter(d["status"] for d in requests)
    skip_by_emp = Counter(s["employee_id"] for s in skipped)

    L = [
        "# Sagarsoft — Leave HISTORY migration report", "",
        f"- Generated: {datetime.now().isoformat(sep=' ', timespec='seconds')}  (mode: **{mode}**)",
        f"- Target DB: `{LMS_DB}`  ·  org_id: `{ORG_ID}`  ·  import_batch: `{IMPORT_BATCH}`",
        f"- Source: legacy leave-history export", "",
        "## What this does",
        "Imports the legacy leave/attendance applications into `leave_requests` (for viewing). Each record",
        "is attached to a leave type that **already exists** in the org — no leave type is created, edited",
        "or deleted, and `--revert` removes only the imported requests. Records carry `leave_plan_id = null`",
        "(no plan yet) and are written by **direct insert**, so the seeded balances are NOT touched.", "",
        "## 1. Summary", "",
        "| Item | Count |", "|---|---|",
        f"| Source rows | {len(requests) + len(skipped)} |",
        f"| **Imported** (leave_requests) | **{len(requests)}** |",
        f"| **Skipped** (could not handle) | **{len(skipped)}** |",
        f"| Legacy types matched to an existing type | {len(resolved)} |",
        f"| **Legacy types MISSING in the org** | **{len(missing)}** |", "",
        "## 2. Leave-type mapping  (legacy name → existing type)", "",
        "| Legacy type | Existing type used | Code | Active | Records imported |",
        "|---|---|---|---|---|",
    ]
    for nm, d in resolved.items():
        L.append(f"| {nm} | {d.get('name')} | {d.get('code') or ''} | "
                 f"{'yes' if d.get('is_active', True) else 'no'} | {type_counts.get(nm, 0)} |")
    if missing:
        L += [
            "", "### Legacy types NOT configured in this org  ⚠️", "",
            "Create these in the UI (or map them via `LEGACY_TYPE_MAP`) and re-run — their rows are in",
            "the skipped CSV until then.", "",
            "| Legacy type | Looked for | Rows |", "|---|---|---|",
        ]
        skipped_by_type = Counter(s["leave_type"] for s in skipped)
        for nm, target in missing.items():
            L.append(f"| {nm} | {target} | {skipped_by_type.get(nm, 0)} |")
    L += [
        "", "## 3. Status mapping  (legacy → new)", "",
        "Approved → APPROVED · Cancel → CANCELLED · Pending for approval → PENDING · Rejected → REJECTED", "",
        "| New status | Records |", "|---|---|",
    ]
    for s, n in status_counts.most_common():
        L.append(f"| {s} | {n} |")
    L += [
        "", "## 4. Skipped — records we could NOT import, and WHY  ⚠️", "",
        f"**{len(skipped)}** records were not imported. Each code below states the exact reason.",
        "Full per-row list in `sagarsoft_leave_history_skipped.csv`.", "",
    ]
    if skip_by_emp:
        # code -> (count, reason) — the reason is the same for every row of a code
        skip_reason = {s["employee_id"]: s["reason"] for s in skipped}
        L += ["| Emp code | Records | Why not imported |", "|---|---|---|"]
        for code, n in skip_by_emp.most_common():
            L.append(f"| {code or '(blank)'} | {n} | {skip_reason.get(code, '')} |")
    else:
        L.append("_None — every record was handled._")
    L += [
        "", "## 5. Reversibility",
        f"`python -m scripts.migrate_leave_history --revert` — deletes ONLY the `leave_requests` tagged",
        f"`{IMPORT_BATCH}`. Leave types are never created or deleted by this script.", "",
        "## 6. Output files",
        "- `scripts/sagarsoft_leave_history_clean.csv` — one row per imported leave record",
        "- `scripts/sagarsoft_leave_history_skipped.csv` — records we could NOT handle, with the reason",
        "- `scripts/leave_history_import_report.md` — this report",
    ]
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return csv_path, md_path


# ───────────────────────── main ─────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--data", help="leave-history export (.csv/.xlsx); overrides --data-dir")
    ap.add_argument("--data-dir", help="folder holding the leave-history export (file picked by name)")
    ap.add_argument("--org-id", help="organisation id (default: built-in)")
    ap.add_argument("--skip-unmapped", action="store_true",
                    help="commit even though some legacy leave types are not configured in the "
                         "org (their rows go to the skipped CSV instead of being imported)")
    args = ap.parse_args()
    mode = "COMMIT" if args.commit else "REVERT" if args.revert else "DRY-RUN"

    global ORG_ID
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)

    client = MongoClient(settings.MONGODB_URL, serverSelectionTimeoutMS=8000)
    client.admin.command("ping")
    lms = client[LMS_DB]; iam = client[IAM_DB]
    print(f"== leave-history migration ==  mode={mode}  target_db={LMS_DB}  batch={IMPORT_BATCH}\n")

    if args.revert:
        revert(lms)
        client.close()
        return

    if args.data:
        data_path = args.data
    elif args.data_dir:
        data_path = find_file(args.data_dir, ["leave_history"])
    else:
        data_path = DEFAULT_DATA
    rows = read_rows(data_path)
    print(f"history rows: {len(rows)}   (source: {data_path})")

    resolved, missing, type_id, requests, clean_rows, skipped, st = build(rows, lms, iam)

    src_by_type = Counter((r.get("leavetype_name") or "").strip() for r in rows)
    print(f"\n── LAYER 1: leave types (existing only — nothing created) ──")
    for nm, d in resolved.items():
        print(f"   {nm:38} -> '{d.get('name')}' ({d.get('code') or '-'})"
              f"{'' if d.get('is_active', True) else '  [INACTIVE]'}")
    for nm, target in missing.items():
        print(f"   {nm:38} -> MISSING: no type named '{target}' in this org "
              f"({src_by_type.get(nm, 0)} rows)")
    print(f"\n── LAYER 2: leave_requests ──")
    print(f"   built (will write): {len(requests)}")
    print(f"   skipped (requester not in our org): {st['unresolved_requester']}")
    print(f"   status (mapped): " + " · ".join(f"{k} {v}" for k, v in st.most_common() if k in ('APPROVED','CANCELLED','PENDING','REJECTED')))
    print(f"\n── sample requests (first 3) ──")
    for d in requests[:3]:
        print(f"   {d['src_leave_no']:>6} | {d['src_leave_type']:18} | {d['status']:9} | "
              f"{d['start_date']}..{d['end_date']} | {d['duration_days']}d | user={d['user_id']}")

    existing_req = lms["leave_requests"].count_documents({"import_batch": IMPORT_BATCH})
    if existing_req:
        print(f"\n   NOTE: {existing_req} leave_requests already tagged {IMPORT_BATCH!r} (commit is idempotent; or --revert first).")

    if args.commit and missing and not args.skip_unmapped:
        scripts_dir = os.path.dirname(os.path.abspath(__file__))
        write_outputs(scripts_dir, mode, resolved, missing, requests, clean_rows, skipped, st)
        client.close()
        raise SystemExit(
            f"\nABORTED — {len(missing)} legacy leave type(s) are not configured in this org: "
            f"{', '.join(repr(n) for n in missing)}.\n"
            f"       Create them in the UI (or add a LEGACY_TYPE_MAP entry) and re-run, or pass "
            f"--skip-unmapped\n       to import only the mapped rows. Nothing was written.")

    if args.commit:
        print("\n== COMMIT: writing to sentrifugo_lms ==")
        commit(lms, requests)
        print("Done.")
    else:
        print("\nDRY-RUN — nothing written. Re-run with --commit to write, --revert to undo.")

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path, md_path = write_outputs(scripts_dir, mode, resolved, missing, requests, clean_rows, skipped, st)
    print(f"\nReport : {md_path}")
    print(f"Clean CSV: {csv_path}  ({len(clean_rows)} rows)")
    client.close()


if __name__ == "__main__":
    main()
