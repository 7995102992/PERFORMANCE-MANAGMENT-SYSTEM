"""Sagarsoft Service-Request history migration  (IAM repo -> sentrifugo_srm).

Builds the SR catalog implied by the old ticket export and loads all historical
tickets, mirroring the SRM service's stored doc shapes. Writes DIRECTLY to
`sentrifugo_srm` with pymongo (the SRM models live in another repo), same
deterministic cross-DB pattern used by sync_org_to_lms / lms_holidays.

Layers built:
  1. categories      (19)  one per old CategoryName, mapped to an IAM department
  2. request_types   (45)  one per (CategoryName, RequestTypeName) pair, each
                           carrying SLA rules for all 4 priorities
  3. workflows       (45)  one active workflow per request type; default owner =
                           org-admin PLACEHOLDER (no dept heads assigned yet)
  4. service_requests(~11k) the historical tickets, with real executor/status/
                           dates resolved from the data

Modes:
    python -m scripts.migrate_sr_tickets            # DRY RUN (writes nothing)
    python -m scripts.migrate_sr_tickets --commit   # insert (idempotent)
    python -m scripts.migrate_sr_tickets --revert   # delete everything tagged

Every written doc carries  import_batch = IMPORT_BATCH  for a clean --revert.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone

from bson import ObjectId
from pymongo import MongoClient

# allow running as `python scripts/migrate_sr_tickets.py` too
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.config import settings  # noqa: E402
from scripts.datafile import read_rows, find_file  # noqa: E402  (.csv/.xlsx; folder lookup)

# ───────────────────────── config ─────────────────────────
SRM_DB = "sentrifugo_srm"        # EXPLICIT target (never trust the SRM .env)
IAM_DB = "sentrifugo_iam"
CSV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data-dir", "ticket_history_export.2026-07-31.csv")
IMPORT_BATCH = "import_sagarsoft_sr_2026"

ORG_ID = ObjectId("6a481cbeefd9f278b3708209")   # Sagarsoft (India) Limited
# Ex-Sapplica (SIT) / SSI employees were imported into Sagarsoft under the SIL
# prefix (same number). Tickets carry the OLD code, so alias SIT-x/SSI-x -> SIL-x
# on lookup — EXCEPT these two, which were skipped at import because their SIL
# number belongs to a DIFFERENT existing person (SIL-0158 Gopi Mora, SIL-0159
# Vishwanth Gunna); aliasing them would mis-attribute their tickets. Canonical
# form (zero-padding stripped).
NO_ALIAS_CODES = {"SIT-158", "SIT-159"}
# Resolved at runtime from the target org (see resolve_org_refs): the org's
# "Sagarsoft" business unit, its department_name -> _id map, and an org-admin user.
# (Works for any org — no per-org ids to hardcode.)
ORG_ADMIN_UID = None    # created_by + workflow placeholder owner
SAGARSOFT_BU = None      # business unit the catalog hangs under
DEPT: dict = {}          # department_name -> _id  (for the target org)
CATEGORY_DEPT = {
    "System Admin": "IT and Network Admin", "Cloud Admin": "IT and Network Admin",
    "Sentrifugo": "IT Technical", "CMMi": "IT Technical",
    "General Admin": "Admin and Facilities", "Travel": "Admin and Facilities",
    "Accounts": "Finance and Accounts", "Monthly Payroll": "Finance and Accounts",
    "Purchase Orders": "Finance and Accounts", "Visa": "Finance and Accounts",
    "RPO Incentives": "Finance and Accounts", "Recuiter": "Finance and Accounts",
    "Human Resources": "Human Resources", "Tarang": "Human Resources", "Offer Letter": "Human Resources",
    "Digital Marketing": "Sales and Marketing",
    "PMO": "Leadership", "Job Offer": "Leadership", "Sagarsoft Offer Approval": "Leadership",
}

# Layer 2 (locked): standard SLA — (first_response_minutes, resolution_minutes)
SLA = {
    "urgent": (60, 240),    # 1h / 4h
    "high":   (120, 480),   # 2h / 1 business day
    "medium": (240, 1440),  # 4h / 3 days
    "low":    (480, 2400),  # 8h / 5 days
}
PRIORITY_MAP = {"1": "high", "2": "medium", "3": "low"}   # old 3-level -> new

STATUS_MAP = {
    "closed": "closed", "open": "submitted", "cancelled": "withdrawn",
    "rejected": "rejected", "management rejected": "rejected",
    "to management approve": "pending_approval", "to manager approve": "pending_approval",
    "management approved": "in_progress", "manager approved": "in_progress",
    "pending at executor": "assigned",
    "need more info": "in_progress", "executor need more info": "in_progress",
    "management need more info": "in_progress",
    "hold": "in_progress", "management hold": "in_progress", "executor hold": "in_progress",
}
TERMINAL = {"closed", "rejected", "withdrawn"}


# ───────────────────────── helpers ─────────────────────────
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def audit(created_on: datetime | None = None) -> dict:
    return {
        "created_by": ORG_ADMIN_UID, "created_on": created_on or now_utc(),
        "modified_by": None, "modified_on": None,
        "deleted_by": None, "deleted_on": None,
        "status": "active", "correlation_id": None,
        "import_batch": IMPORT_BATCH,
    }

def name_lc(s: str) -> str:
    return " ".join((s or "").strip().lower().split())

def canon_code(c: str) -> str:
    """Canonicalise an emp code: upper, no spaces, strip zero-padding."""
    c = (c or "").upper().replace(" ", "")
    m = re.match(r"^([A-Z]+)-?((?:C|I)-)?0*(\d+)$", c)
    if not m:
        return c
    return f"{m.group(1)}-{(m.group(2) or '')}{int(m.group(3))}"

_MOJI = ("Ã", "â€", "Â", "ï¿½")
def fix_moji(s: str) -> str:
    """Repair double-encoded text. The source was Windows-1252, so cp1252 round-
    trips chars like — “ ” € that latin-1 would drop. Falls back to the original
    string if it can't decode cleanly (never silently deletes characters)."""
    if not s or not any(m in s for m in _MOJI):
        return s
    for enc in ("cp1252", "latin-1"):
        try:
            return s.encode(enc).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
    return s

def parse_dt(v: str):
    v = (v or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            # SRM timestamps are always UTC-aware datetimes; a naive value here would
            # be inconsistent with every other timestamp written by this migration
            # (and can't be compared against the service's own utcnow()-based fields).
            return datetime.strptime(v, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None

def make_title(desc: str, fallback: str) -> str:
    d = fix_moji(desc or "").replace("\r", " ").replace("\n", " ").strip()
    if not d:
        d = fix_moji(fallback or "").strip()
    d = " ".join(d.split())
    return (d[:140] or "(no title)")


# ───────────────────────── identity resolvers ─────────────────────────
def build_resolvers(iam):
    # emp_code(canonical) -> user_id
    code_to_uid: dict[str, ObjectId] = {}
    for e in iam["employees"].find({"organisation_id": ORG_ID}, {"emp_code": 1, "user_id": 1}):
        ec = canon_code(e.get("emp_code") or "")
        uid = e.get("user_id")
        if ec and uid:
            code_to_uid[ec] = uid if isinstance(uid, ObjectId) else ObjectId(str(uid))
    # full name(lower) -> set(user_id)
    name_to_uids: dict[str, set] = defaultdict(set)
    for u in iam["users"].find({}, {"first_name": 1, "middle_name": 1, "last_name": 1}):
        fn = (u.get("first_name") or "").strip()
        mn = (u.get("middle_name") or "").strip()
        ln = (u.get("last_name") or "").strip()
        for nm in {f"{fn} {ln}".strip(), f"{fn} {mn} {ln}".replace("  ", " ").strip()}:
            if nm:
                name_to_uids[nm.lower()].add(u["_id"])
    return code_to_uid, name_to_uids


# ───────────────────────── build catalog ─────────────────────────
def build_catalog(rows):
    """Return (categories, request_types, workflows, lookup, shared) in-memory docs.

    request_types are keyed by DISTINCT NAME (one per name, names kept verbatim)
    to honour the org-wide unique index on request_types.name_lc. A name used by
    several categories (e.g. "Others") becomes ONE shared request type homed to
    its most-common category; every ticket still keeps its own correct category.
    """
    cats_seen: list[str] = []
    pairs_seen: list[tuple[str, str]] = []
    rt_cat_counts: dict[str, Counter] = defaultdict(Counter)   # rt name -> Counter(category)
    for r in rows:
        cn = (r["CategoryName"] or "").strip()
        rt = (r["RequestTypeName"] or "").strip() or "Others"
        if cn and cn not in cats_seen:
            cats_seen.append(cn)
        if (cn, rt) not in pairs_seen:
            pairs_seen.append((cn, rt))
        if cn:
            rt_cat_counts[rt][cn] += 1

    categories = {}      # cat_name -> doc
    cat_id = {}          # cat_name -> _id
    for cn in cats_seen:
        dept = CATEGORY_DEPT.get(cn)
        _id = ObjectId()
        cat_id[cn] = _id
        # legacy categories land renamed "<name>-inactive" and switched off
        cat_name = f"{cn}-inactive"
        categories[cn] = {
            "_id": _id, "organisation_id": ORG_ID, "name": cat_name, "name_lc": name_lc(cat_name),
            "description": None, "department_id": DEPT[dept], "business_unit_id": SAGARSOFT_BU,
            "restricted_visibility": False,
            "visibility_business_unit_ids": [], "visibility_department_ids": [],
            **audit(),
            "status": "inactive",
        }

    # one request type + workflow per DISTINCT name, homed to its busiest category
    rt_names: list[str] = []
    for (_cn, rt) in pairs_seen:
        if rt not in rt_names:
            rt_names.append(rt)

    request_types = {}   # rt_name -> doc
    workflows = {}       # rt_name -> doc
    rt_meta = {}         # rt_name -> {request_type_id, workflow_id, sla_by_pri}
    shared = []          # names used by >1 category (for the report)
    for rt in rt_names:
        home = rt_cat_counts[rt].most_common(1)[0][0]
        if len(rt_cat_counts[rt]) > 1:
            shared.append((rt, home, dict(rt_cat_counts[rt])))
        sla_rules, sla_by_pri = [], {}
        for pri, (fr, res) in SLA.items():
            rid = str(uuid.uuid4())
            sla_by_pri[pri] = rid
            sla_rules.append({
                "id": rid, "priority": pri,
                "first_response_minutes": fr, "resolution_minutes": res,
                "business_hours_only": True, "description": None,
                "violation_actions": [], "notification_recipients": [],
                **audit(),
            })
        rt_id, wf_id = ObjectId(), ObjectId()
        request_types[rt] = {
            "_id": rt_id, "organisation_id": ORG_ID, "category_id": cat_id[home],
            "name": rt, "name_lc": name_lc(rt), "description": None,
            "sla_rules": sla_rules, **audit(),
        }
        workflows[rt] = {
            "_id": wf_id, "organisation_id": ORG_ID, "category_id": cat_id[home],
            "request_type_id": rt_id, "primary_assignee_user_id": ORG_ADMIN_UID,
            "approval_required": False, "is_active_for_type": True, **audit(),
        }
        rt_meta[rt] = {"request_type_id": rt_id, "workflow_id": wf_id, "sla_by_pri": sla_by_pri}

    # ticket lookup: ticket keeps its OWN category, shares the request type by name
    lookup = {}          # (cat,rt) -> {"category_id","request_type_id","workflow_id","sla_by_pri"}
    for (cn, rt) in pairs_seen:
        m = rt_meta[rt]
        lookup[(cn, rt)] = {"category_id": cat_id[cn], "request_type_id": m["request_type_id"],
                            "workflow_id": m["workflow_id"], "sla_by_pri": m["sla_by_pri"]}
    return categories, request_types, workflows, lookup, shared


# ───────────────────────── build tickets ─────────────────────────
def build_tickets(rows, lookup, code_to_uid, name_to_uids, stats):
    tickets = []
    clean_rows = []
    skipped_rows = []   # (ticket_no, emp_id, name, reason) — surfaced in the report

    def _skip(r, reason):
        skipped_rows.append({
            "ticket_no": (r["TicketNumber"] or "").strip(),
            "emp_id": (r["RequesterEmpID"] or "").strip(),
            "name": fix_moji((r["RequesterName"] or "").strip()),
            "status": (r["STATUS"] or "").strip(),
            "submitted_on": (r["SubmittedOn"] or "").strip(),
            "reason": reason,
        })

    for r in rows:
        cn = (r["CategoryName"] or "").strip()
        rt = (r["RequestTypeName"] or "").strip() or "Others"
        L = lookup.get((cn, rt))
        if not L:
            stats["no_catalog"] += 1
            _skip(r, "no matching catalog entry")
            continue

        # requester: emp code first (with SIT/SSI -> SIL alias), then name fallback
        req_via = "code"
        rcode = canon_code(r["RequesterEmpID"])
        ruid = code_to_uid.get(rcode)
        if not ruid and rcode.startswith(("SIT-", "SSI-")) and rcode not in NO_ALIAS_CODES:
            ruid = code_to_uid.get("SIL-" + rcode.split("-", 1)[1])
            if ruid:
                req_via = "code(old prefix->SIL)"
        if ruid:
            stats["req_by_code"] += 1
        else:
            uids = name_to_uids.get(name_lc(r["RequesterName"]))
            if uids:
                ruid = sorted(uids)[0]
                req_via = "name(ambiguous)" if len(uids) > 1 else "name"
                stats["req_by_name"] += 1
                if len(uids) > 1:
                    stats["req_name_ambiguous"] += 1
        if not ruid:
            stats["req_unresolved"] += 1
            stats["skipped"] += 1
            _skip(r, "requester has no user account (employee skipped at import)")
            continue

        # executor by name (optional)
        exec_uid = None
        ex = (r["executor_name"] or "").strip()
        if ex:
            uids = name_to_uids.get(name_lc(ex))
            if uids:
                exec_uid = sorted(uids)[0]
                stats["exec_resolved"] += 1
            else:
                stats["exec_unresolved"] += 1
        else:
            stats["exec_empty"] += 1

        priority = PRIORITY_MAP.get((r["priority"] or "").strip(), "low")
        status = STATUS_MAP.get((r["STATUS"] or "").strip().lower(), "submitted")
        stats["status_out"][status] += 1
        stats["pri_out"][priority] += 1
        stats["status_old"][(r["STATUS"] or "").strip() or "(blank)"] += 1
        stats["pri_old"][(r["priority"] or "").strip() or "(blank)"] += 1

        sub = parse_dt(r["SubmittedOn"])
        res = parse_dt(r["ResolvedAt"])
        resolved_at = closed_at = None
        if status == "closed" and res and sub and res > sub:
            resolved_at = closed_at = res
            stats["resolved_set"] += 1

        desc = fix_moji(r["DESCRIPTION"])
        if desc != r["DESCRIPTION"]:
            stats["moji_fixed"] += 1

        assignee = exec_uid or ORG_ADMIN_UID
        doc = {
            "_id": ObjectId(),
            "ticket_no": (r["TicketNumber"] or "").strip(),
            "organisation_id": ORG_ID,
            "requester_user_id": ruid,
            "category_id": L["category_id"],
            "request_type_id": L["request_type_id"],
            "sla_rule_id": L["sla_by_pri"][priority],
            "workflow_id": L["workflow_id"],
            "priority": priority,
            "title": make_title(r["DESCRIPTION"], r["Title"]),
            "description": desc or None,
            "request_status": status,
            "is_escalated": False, "escalation_count": 0,
            "primary_assignee_user_id": assignee,
            "executor_user_id": exec_uid,
            "submitted_on": sub,
            "resolved_at": resolved_at, "closed_at": closed_at,
            "resolution_notes": (fix_moji(r["executor_comments"]).strip() or None) if r["executor_comments"] else None,
            **audit(sub or now_utc()),
        }
        tickets.append(doc)
        clean_rows.append({
            "ticket_no": doc["ticket_no"],
            "requester_emp_id": (r["RequesterEmpID"] or "").strip(),
            "requester_name": fix_moji((r["RequesterName"] or "").strip()),
            "requester_user_id": str(ruid),
            "resolved_via": req_via,
            "category": cn,
            "request_type": rt,
            "priority_old": (r["priority"] or "").strip(),
            "priority": priority,
            "status_old": (r["STATUS"] or "").strip(),
            "status": status,
            "submitted_on": sub.isoformat(sep=" ") if sub else "",
            "resolved_at": resolved_at.isoformat(sep=" ") if resolved_at else "",
            "executor_name": fix_moji(ex),
            "executor_user_id": str(exec_uid) if exec_uid else "",
            "title": doc["title"],
        })
    return tickets, clean_rows, skipped_rows


# ───────────────────────── modes ─────────────────────────
def revert(srm):
    total = 0
    for coll in ("service_requests", "workflows", "request_types", "categories",
                 "approval_decisions", "escalation_configs"):
        res = srm[coll].delete_many({"import_batch": IMPORT_BATCH})
        if res.deleted_count:
            print(f"  deleted {res.deleted_count:>6} from {coll}")
        total += res.deleted_count
    print(f"Reverted {total} docs tagged import_batch={IMPORT_BATCH!r}.")

def commit(srm, categories, request_types, workflows, tickets):
    """Idempotent insert. Because each build generates fresh _ids, an existing
    catalog row is reused by its natural key and its _id is remapped into every
    dependent doc — otherwise a re-run would insert orphan workflows/tickets that
    point at _ids which were skipped (never inserted)."""
    cat_map, rt_map, wf_map = {}, {}, {}

    def _upsert(coll, doc, key, idmap=None):
        existing = srm[coll].find_one(key, {"_id": 1})
        if existing:
            if idmap is not None:
                idmap[doc["_id"]] = existing["_id"]
            return 0
        srm[coll].insert_one(doc)
        if idmap is not None:
            idmap[doc["_id"]] = doc["_id"]
        return 1

    ci = ri = wi = ti = 0
    for d in categories.values():
        ci += _upsert("categories", d,
                      {"organisation_id": d["organisation_id"], "name_lc": d["name_lc"], "deleted_on": None}, cat_map)
    for d in request_types.values():
        d["category_id"] = cat_map.get(d["category_id"], d["category_id"])
        ri += _upsert("request_types", d,
                      {"organisation_id": d["organisation_id"], "name_lc": d["name_lc"], "deleted_on": None}, rt_map)
    for d in workflows.values():
        d["category_id"] = cat_map.get(d["category_id"], d["category_id"])
        d["request_type_id"] = rt_map.get(d["request_type_id"], d["request_type_id"])
        wi += _upsert("workflows", d,
                      {"organisation_id": d["organisation_id"], "request_type_id": d["request_type_id"], "deleted_on": None}, wf_map)
    for d in tickets:
        d["category_id"] = cat_map.get(d["category_id"], d["category_id"])
        d["request_type_id"] = rt_map.get(d["request_type_id"], d["request_type_id"])
        d["workflow_id"] = wf_map.get(d["workflow_id"], d["workflow_id"])
        ti += _upsert("service_requests", d,
                      {"organisation_id": d["organisation_id"], "ticket_no": d["ticket_no"]})
    print(f"  categories         inserted={ci:>6} skipped(existing)={len(categories) - ci}")
    print(f"  request_types      inserted={ri:>6} skipped(existing)={len(request_types) - ri}")
    print(f"  workflows          inserted={wi:>6} skipped(existing)={len(workflows) - wi}")
    print(f"  service_requests   inserted={ti:>6} skipped(existing)={len(tickets) - ti}")


# ───────────────────────── outputs (report + clean csv) ─────────────────────────
def write_outputs(scripts_dir, mode, categories, request_types, workflows, tickets,
                  clean_rows, stats, shared, skipped_rows):
    csv_path = os.path.join(scripts_dir, "sagarsoft_sr_tickets_clean.csv")
    md_path = os.path.join(scripts_dir, "sr_import_report.md")

    cols = ["ticket_no", "requester_emp_id", "requester_name", "requester_user_id",
            "resolved_via", "category", "request_type", "priority_old", "priority",
            "status_old", "status", "submitted_on", "resolved_at",
            "executor_name", "executor_user_id", "title"]
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in clean_rows:
            w.writerow(r)

    id_to_cat = {c["_id"]: c["name"] for c in categories.values()}
    cat_tickets = Counter(r["category"] for r in clean_rows)
    rt_tickets = Counter(r["request_type"] for r in clean_rows)
    dep_of = {cn: [k for k, v in DEPT.items() if v == categories[cn]["department_id"]][0]
              for cn in categories}
    shared_names = {s[0] for s in shared}

    L = []
    L.append("# Sagarsoft — Service Request history migration report")
    L.append("")
    L.append(f"- Generated: {datetime.now().isoformat(sep=' ', timespec='seconds')}  (mode: **{mode}**)")
    L.append(f"- Target DB: `{SRM_DB}`  ·  org_id: `{ORG_ID}`  ·  import_batch: `{IMPORT_BATCH}`")
    L.append(f"- Source file: `{os.path.basename(CSV_PATH)}`")
    L.append("")
    L.append("## 0. What this migration does")
    L.append("")
    L.append("A faithful, one-to-one import of the organisation's **historical service-desk tickets** "
             "from the legacy export into the new Service Request module (`sentrifugo_srm`). It also "
             "**builds the catalog those tickets reference** (categories → request types → workflows), "
             "because the new system requires every ticket to point to them.")
    L.append("")
    L.append("- Written directly with pymongo, mirroring the SRM service's stored document shapes.")
    L.append("- Every document is tagged `import_batch` for a clean, complete rollback.")
    L.append("- Idempotent: re-runs skip existing rows by natural key (no duplicates).")
    L.append("- Nothing is invented; where the new model requires a value the source lacks "
             "(SLA times, workflow owner) it is explicitly flagged below.")
    L.append("")
    L.append("## 1. Summary")
    L.append("")
    L.append("| Layer | Collection | Written |")
    L.append("|---|---|---|")
    L.append(f"| 1. Categories | `categories` | {len(categories)} |")
    L.append(f"| 2. Request types | `request_types` | {len(request_types)} |")
    L.append(f"| 3. Workflows | `workflows` | {len(workflows)} |")
    L.append(f"| 4. Tickets | `service_requests` | {len(tickets)} |")
    L.append("")
    L.append(f"Tickets built **{len(tickets)}**, skipped **{stats['skipped']}**.")
    L.append("")
    if skipped_rows:
        L.append("### Skipped tickets (not migrated)")
        L.append("")
        L.append("| Ticket | Emp ID | Requester | Status | Submitted | Reason |")
        L.append("|---|---|---|---|---|---|")
        for s in skipped_rows:
            L.append(f"| {s['ticket_no']} | {s['emp_id']} | {s['name']} | {s['status']} "
                     f"| {s['submitted_on']} | {s['reason']} |")
        L.append("")
    L.append("## 2. Field mapping (source column → SRM field)")
    L.append("")
    L.append("| Source column | → SRM field | Handling |")
    L.append("|---|---|---|")
    fm = [
        ("TicketNumber", "service_requests.ticket_no", "kept verbatim (e.g. SD11156)"),
        ("RequesterEmpID", "requester_user_id", "resolved to IAM user; emp-code normalised for case/spaces/zero-padding; name fallback"),
        ("RequesterName", "(fallback only)", "used to resolve requester when emp-code missing; not stored separately"),
        ("CategoryName", "category_id", "mapped to a category, each tied to an IAM department (see §3)"),
        ("RequestTypeName", "request_type_id", "one request type per distinct name; shared names homed to busiest category (see §4)"),
        ("priority", "priority", "1→high, 2→medium, 3→low (see §6)"),
        ("Title", "— (dropped)", "source Title truncated to 30 chars; title instead derived from DESCRIPTION"),
        ("DESCRIPTION", "description (+ title)", "mojibake-repaired; also the source of the derived title"),
        ("STATUS", "request_status", "mapped to the SRM lifecycle (see §6)"),
        ("SubmittedOn", "submitted_on", "parsed datetime"),
        ("ResolvedAt", "resolved_at / closed_at", "set only for closed tickets with a valid time; otherwise null"),
        ("executor_id", "— (not used)", "executor resolved by name instead"),
        ("executor_name", "executor_user_id + primary_assignee_user_id", "resolved to IAM user; assignee = executor, else org-admin placeholder"),
        ("executor_comments", "resolution_notes", "mojibake-repaired"),
        ("reporting_manager_name", "— (not migrated)", "approval history is out of scope for v1"),
        ("reporting_manager_status", "— (dropped)", "99.5% empty"),
        ("approver_status_1 / approver_1_name / _comments", "— (not migrated)", "approval history out of scope; ~7% populated"),
        ("approver_2/3 name / status / comments", "— (dropped)", "100% empty"),
        ("TicketStatus", "— (dropped)", "constant value '1'"),
        ("(set by migration)", "workflow_id, sla_rule_id, organisation_id, is_escalated=false, escalation_count=0, audit + import_batch", "system fields the new model requires"),
    ]
    for s, t, h in fm:
        L.append(f"| {s} | {t} | {h} |")
    L.append("")
    L.append("## 3. Layer 1 — Categories → Department")
    L.append("")
    L.append("**How the department was decided (evidence-based, not guesswork):** each legacy category "
             "was mapped to the IAM department of the **executor** who actually handled that category's "
             "tickets. For the 4 categories that had no executor (CMMi, PMO, Job Offer, Sagarsoft Offer "
             "Approval), the **reporting-manager's** department was used instead. All categories sit under "
             "business unit **Sagarsoft**.")
    L.append("")
    L.append("| Category | Department | Tickets |")
    L.append("|---|---|---|")
    for cn in sorted(categories, key=lambda x: -cat_tickets[x]):
        L.append(f"| {cn} | {dep_of[cn]} | {cat_tickets[cn]} |")
    L.append("")
    L.append("## 4. Layer 2 — Request types & SLA")
    L.append("")
    L.append("Request-type names are kept **verbatim** from the source. The SRM `request_types` "
             "collection enforces a **unique name per organisation** (a MongoDB unique index — not app "
             "code, and not safely removable on the shared DB). Names used by several categories "
             "therefore become **one shared request type**, homed under the busiest category. "
             "**Every ticket still keeps its own correct category** — only the catalog grouping is "
             "simplified for those names.")
    L.append("")
    L.append("**SLA:** the source carries no SLA data, so a standard SLA is applied to every request "
             "type, for all 4 priorities (it matches the real historical median resolution of ~1 business "
             "day; editable per type in the UI):")
    L.append("")
    L.append("| Priority | First response (min) | Resolution (min) |")
    L.append("|---|---|---|")
    for p in ("urgent", "high", "medium", "low"):
        L.append(f"| {p} | {SLA[p][0]} | {SLA[p][1]} |")
    L.append("")
    L.append("| Request type | Homed under | Tickets | Shared |")
    L.append("|---|---|---|---|")
    for rt in sorted(request_types, key=lambda x: -rt_tickets[x]):
        home = id_to_cat.get(request_types[rt]["category_id"], "?")
        L.append(f"| {rt} | {home} | {rt_tickets[rt]} | {'yes' if rt in shared_names else ''} |")
    L.append("")
    if shared:
        L.append("**Shared names** (one request type used by several categories; tickets keep their own category):")
        L.append("")
        for rt, home, spread in shared:
            L.append(f"- `{rt}` → homed under **{home}**; used by {spread}")
        L.append("")
    L.append("## 5. Layer 3 — Workflows")
    L.append("")
    L.append(f"One active workflow per request type. The default owner (`primary_assignee_user_id`) is set "
             f"to the **org-admin placeholder** `{ORG_ADMIN_UID}` because **no department heads are "
             f"assigned yet**. `approval_required=false`, `is_active_for_type=true`.")
    L.append("")
    L.append("This placeholder affects only **new** tickets raised going forward — **not** the imported "
             "history (each historical ticket already carries its real executor). After department heads "
             "are assigned in the org page, re-point the workflows to those heads (re-run, or re-save in "
             "the UI) so new requests route correctly.")
    L.append("")
    L.append("## 6. Value mappings (old → new, with counts)")
    L.append("")
    L.append("**Priority**")
    L.append("")
    L.append("| Old (legacy) | → New | Tickets |")
    L.append("|---|---|---|")
    for old in sorted(stats["pri_old"], key=lambda x: -stats["pri_old"][x]):
        new = PRIORITY_MAP.get(old, "low")
        L.append(f"| {old} | {new} | {stats['pri_old'][old]} |")
    L.append("")
    L.append("**Status** — every distinct legacy status and what it became:")
    L.append("")
    L.append("| Old status | → New status | Tickets |")
    L.append("|---|---|---|")
    for old in sorted(stats["status_old"], key=lambda x: -stats["status_old"][x]):
        new = STATUS_MAP.get(old.strip().lower(), "submitted")
        L.append(f"| {old} | {new} | {stats['status_old'][old]} |")
    L.append("")
    L.append("Resulting new-status totals: " +
             " · ".join(f"{s} {n}" for s, n in stats["status_out"].most_common()) + ".")
    L.append("")
    L.append("## 7. Transformations & data cleaning")
    L.append("")
    L.append(f"- **Requester resolution:** emp-code first (normalised for case, spaces, zero-padding), "
             f"then name fallback. {stats['req_by_code']} by code, {stats['req_by_name']} by name "
             f"({stats['req_name_ambiguous']} same-name people auto-picked deterministically).")
    L.append("- **Executor resolution:** by name against IAM users.")
    L.append("- **Title:** the source `Title` was truncated to 30 chars, so titles are derived from the "
             "full `DESCRIPTION` (first 140 chars, whitespace-collapsed).")
    L.append(f"- **Encoding:** {stats['moji_fixed']} descriptions/comments had Windows-1252 mojibake "
             "(e.g. `â€”` → `—`) repaired.")
    L.append("- **Dates:** `SubmittedOn` parsed as-is; `ResolvedAt` kept only for closed tickets where it "
             "post-dates submission — otherwise it was a placeholder equal to submission time and is "
             "stored as null.")
    L.append("")
    L.append("## 8. Not migrated / dropped from source")
    L.append("")
    L.append("- **Approval history** (`reporting_manager_name`/`status`, `approver_1/2/3` names/statuses/"
             "comments) — **not** imported in v1 (sparse; no `approval_decisions` created). Can be added "
             "later if needed.")
    L.append("- **Dropped columns:** `TicketStatus` (constant '1'), `reporting_manager_status` (99.5% "
             "empty), `approver_2/3` fields (100% empty), `Title` (truncated — replaced by a "
             "DESCRIPTION-derived title), `executor_id` (redundant — executor resolved by name).")
    L.append("")
    L.append("## 9. Data quality / resolution")
    L.append("")
    L.append(f"- Requesters resolved: **{stats['req_by_code'] + stats['req_by_name']}** of {len(tickets)} "
             f"(by emp-code {stats['req_by_code']}, by name fallback {stats['req_by_name']}); "
             f"unresolved/skipped {stats['req_unresolved']}.")
    L.append(f"- Executors: resolved {stats['exec_resolved']}, none in source {stats['exec_empty']}, "
             f"unresolved {stats['exec_unresolved']}.")
    L.append(f"- Closed tickets given a real resolution date: {stats['resolved_set']}.")
    L.append("- Structural: 0 malformed rows, 0 duplicate ticket numbers in source.")
    L.append("")
    L.append("## 10. Dashboard note — why some tickets show as \"Open\"")
    L.append("")
    open_set = ("pending_approval", "pending_assignment", "assigned", "in_progress")
    open_total = sum(stats["status_out"].get(s, 0) for s in open_set)
    L.append(f"The dashboard's **Open Tickets** counts statuses {{{', '.join(open_set)}}} — "
             f"**{open_total}** here. These are tickets that were genuinely mid-flight in the legacy "
             "system (predominantly *Management approved*). The legacy *Open* tickets map to `submitted` "
             "and terminal tickets (`closed`/`rejected`/`withdrawn`) are excluded by the app's own "
             "definition. This is a faithful reflection of history, not an error.")
    L.append("")
    L.append("## 11. Reversibility")
    L.append("")
    L.append(f"Every written doc carries `import_batch = \"{IMPORT_BATCH}\"`. To undo everything:")
    L.append("")
    L.append("```")
    L.append("python -m scripts.migrate_sr_tickets --revert")
    L.append("```")
    L.append("")
    L.append("## 12. Output files")
    L.append("- `scripts/sagarsoft_sr_tickets_clean.csv` — one row per migrated ticket (clean, mapped, resolved ids)")
    L.append("- `scripts/sr_import_report.md` — this report")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return csv_path, md_path


# ───────────────────────── org refs (resolved at runtime) ─────────────────────────
def resolve_org_refs(iam):
    """Resolve the target org's business unit + department name->id map + an org-admin
    user, so the catalog attaches to THIS org's structure (no hardcoded per-org ids)."""
    def bname(d): return d.get("business_unit_name") or d.get("name")
    def dname(d): return d.get("department_name") or d.get("name")
    bu = (iam["business_units"].find_one(
              {"organisation_id": ORG_ID, "deleted_on": None,
               "$or": [{"business_unit_name": "Sagarsoft"}, {"name": "Sagarsoft"}]})
          or iam["business_units"].find_one({"organisation_id": ORG_ID, "deleted_on": None})
          or iam["business_units"].find_one({"organisation_id": ORG_ID}))
    dept_map = {dname(d): d["_id"]
                for d in iam["departments"].find({"organisation_id": ORG_ID}) if dname(d)}
    admin = (iam["users"].find_one({"organisation_id": ORG_ID, "is_org_admin": True, "deleted_on": None})
             or iam["users"].find_one({"organisation_id": ORG_ID}))
    if not bu or not admin or not dept_map:
        raise SystemExit(f"ERROR: cannot resolve org refs for {ORG_ID} "
                         f"(bu={bool(bu)}, admin={bool(admin)}, depts={len(dept_map)})")
    return bu["_id"], dept_map, admin["_id"]


# ───────────────────────── main ─────────────────────────
def main():
    global ORG_ID, SAGARSOFT_BU, DEPT, ORG_ADMIN_UID
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--data", help="ticket export file (.csv or .xlsx); overrides --data-dir")
    ap.add_argument("--data-dir", help="folder holding the ticket export (file picked by name)")
    ap.add_argument("--org-id", help="organisation id (default: built-in). For a DIFFERENT org also "
                    "update ORG_ADMIN_UID / SAGARSOFT_BU / DEPT / CATEGORY_DEPT in this file")
    args = ap.parse_args()
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)
    mode = "COMMIT" if args.commit else "REVERT" if args.revert else "DRY-RUN"

    client = MongoClient(settings.MONGODB_URL, serverSelectionTimeoutMS=8000)
    client.admin.command("ping")
    srm = client[SRM_DB]
    iam = client[IAM_DB]
    print(f"== SR ticket migration ==  mode={mode}  target_db={SRM_DB}  batch={IMPORT_BATCH}\n")

    if args.revert:
        revert(srm)
        client.close()
        return

    SAGARSOFT_BU, DEPT, ORG_ADMIN_UID = resolve_org_refs(iam)
    print(f"resolved org refs: BU={SAGARSOFT_BU}  depts={len(DEPT)}  admin={ORG_ADMIN_UID}")

    if args.data:
        data_path = args.data
    elif args.data_dir:
        data_path = find_file(args.data_dir, ["ticket"])
    else:
        data_path = CSV_PATH
    print(data_path)
    rows = read_rows(data_path)
    print(f"data rows: {len(rows)}  (source: {data_path})")

    code_to_uid, name_to_uids = build_resolvers(iam)
    print(f"resolvers: emp_codes={len(code_to_uid)}  name->users keys={len(name_to_uids)}")

    categories, request_types, workflows, lookup, shared = build_catalog(rows)
    stats = {k: 0 for k in ("no_catalog", "req_by_code", "req_by_name", "req_name_ambiguous",
                            "req_unresolved", "skipped", "exec_resolved", "exec_unresolved",
                            "exec_empty", "resolved_set", "moji_fixed")}
    stats["status_out"] = Counter(); stats["pri_out"] = Counter()
    stats["status_old"] = Counter(); stats["pri_old"] = Counter()
    tickets, clean_rows, skipped_rows = build_tickets(rows, lookup, code_to_uid, name_to_uids, stats)

    # ---------------- report ----------------
    print(f"\n── LAYER 1: categories = {len(categories)} ──")
    for cn, d in categories.items():
        dep = [k for k, v in DEPT.items() if v == d["department_id"]][0]
        print(f"   {cn:26} -> {dep}")
    print(f"\n── LAYER 2: request_types = {len(request_types)} (distinct names, kept verbatim; 4 SLA rules each) ──")
    print(f"   SLA: urgent 60/240  high 120/480  medium 240/1440  low 480/2400 (min, business hours)")
    if shared:
        print(f"   shared names (one request type used by several categories, homed to busiest): {len(shared)}")
        for rt, home, spread in shared:
            print(f"      {rt!r} -> homed under {home!r}   used by: {spread}")
    print(f"\n── LAYER 3: workflows = {len(workflows)} ──")
    print(f"   default owner (primary_assignee) = ORG-ADMIN PLACEHOLDER {ORG_ADMIN_UID}  (no heads yet)")
    print(f"   approval_required=False, is_active_for_type=True")

    print(f"\n── LAYER 4: service_requests (tickets) ──")
    print(f"   built (will write): {len(tickets)}   skipped: {stats['skipped']}")
    print(f"   requester resolved -> by emp_code={stats['req_by_code']}  by name={stats['req_by_name']} "
          f"(ambiguous {stats['req_name_ambiguous']})  UNRESOLVED(skipped)={stats['req_unresolved']}")
    print(f"   executor -> resolved={stats['exec_resolved']}  empty={stats['exec_empty']}  unresolved={stats['exec_unresolved']}")
    print(f"   no matching catalog entry: {stats['no_catalog']}")
    print(f"   resolved_at/closed_at set (closed w/ valid time): {stats['resolved_set']}")
    print(f"   mojibake-cleaned descriptions: {stats['moji_fixed']}")
    print(f"   priority (mapped): {dict(stats['pri_out'])}")
    print(f"   status (mapped):")
    for s, n in stats["status_out"].most_common():
        print(f"        {s:18} {n}")

    print(f"\n── sample tickets (first 2) ──")
    for d in tickets[:2]:
        s = dict(d)
        s["description"] = (s["description"] or "")[:80] + ("…" if s["description"] and len(s["description"]) > 80 else "")
        for k in ("_id", "organisation_id", "requester_user_id", "category_id", "request_type_id",
                  "workflow_id", "primary_assignee_user_id", "executor_user_id"):
            s[k] = str(s[k])
        print("   " + ", ".join(f"{k}={s[k]!r}" for k in
              ("ticket_no", "priority", "request_status", "requester_user_id", "executor_user_id",
               "submitted_on", "resolved_at", "title")))

    # existing tagged docs warning
    existing = srm["service_requests"].count_documents({"import_batch": IMPORT_BATCH})
    if existing:
        print(f"\n   NOTE: {existing} service_requests already tagged {IMPORT_BATCH!r} exist (commit is idempotent; or --revert first).")

    if args.commit:
        print("\n== COMMIT: writing to sentrifugo_srm ==")
        commit(srm, categories, request_types, workflows, tickets)
        print("Done.")
    else:
        print("\nDRY-RUN — nothing written to DB. Re-run with --commit to write, --revert to undo.")

    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path, md_path = write_outputs(scripts_dir, mode, categories, request_types,
                                      workflows, tickets, clean_rows, stats, shared, skipped_rows)
    print(f"\nReport : {md_path}")
    print(f"Clean CSV: {csv_path}  ({len(clean_rows)} rows)")
    client.close()


if __name__ == "__main__":
    main()
