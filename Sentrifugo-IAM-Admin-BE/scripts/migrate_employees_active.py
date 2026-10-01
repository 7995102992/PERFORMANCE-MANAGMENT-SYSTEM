"""Import the Sagarsoft employee CSV export into the existing 'sagarsoft' org.

Rules (agreed in planning):
  * ONE BU: Sagarsoft (prefix SIL). No Sapplica BU — ex-Sapplica (SIT) employees
    are converted into Sagarsoft with their number kept (SIT-0143 -> SIL-0143).
  * REUSE-IF-EXISTS: if the org already has the BU (by name) / departments /
    designations (by name) from an app setup, they are reused — only missing ones
    are created. Reused docs are NOT deleted by cleanup/revert (no marker) and get
    no duplicate events; a reused BU has its emp-code counters advanced to resume
    after both the imported max and anything the app already issued.
  * emp_code keeps the EXACT number from the sheet; full-time => SIL-<num>,
    contract => SIL-C-<num>. SSI-0110 -> Sagarsoft as SIL-0110 (number free).
    After import the BU counters are set so the normal generator resumes at max+1.
  * employment_type: Permanent/Probation/blank => full-time; Direct/Third Party
    Contract => contract. employment_status: active rows map from the type
    (permanent/probation/direct-contract/third-party-contract); LEFT rows => Exit.
  * Active only if EmployeeStatus 1 AND no DateOfLeaving => user ACTIVE + test@123.
    Otherwise (status 0 OR a leaving date) => user EXIT, no password,
    date_of_exit = DateOfLeaving.
  * 'admin' and 'SIL-01' are SKIPPED entirely (an org admin is created separately,
    outside this import).
  * Skipped junk: 1234, SIL-099999, BGCK273.
  * Skipped conflicts: SIT-0158, SIT-0159 — their SIL numbers are already occupied
    by existing Sagarsoft employees (SIL-0158 Gopi Mora, SIL-0159 Vishwanth Gunna).
  * Duplicate emails / emails already in the DB: all kept; the extra one gets a
    +<empid> tag so the unique-email index accepts it (none dropped).
  * Designations + Departments created at org level. '&' -> 'and' in dept names
    merges 'Finance & Accounts' into 'Finance and Accounts'. DEPT_MERGES folds
    'General Admin' -> 'Admin and Facilities' and 'IT-Technical-Sun-Mon-Weekend'
    -> 'IT Technical'. Every department maps to the single Sagarsoft BU; each
    employee maps to its Department.
  * Org is set active (single-BU + setup_progress) so the data shows in the app.
  * Audit created_on/modified_on come from the sheet; created_by/modified_by = MARKER.

Idempotent: a --commit run first deletes any prior data created by this importer
(created_by == MARKER, scoped to the sagarsoft org), then re-inserts.

This is the ALREADY-ACTIVATED variant: active employees are created ACTIVE with a
password (test@123) — no activation email. It also holds the shared engine; the
activation variant (scripts/migrate_employees_activation.py) reuses it with
mode='activation' to instead create active employees PENDING and enqueue an
activation email (outbox -> RabbitMQ -> schedule service). Left/inactive employees
and rehire stints are never emailed in either variant.

Both variants also write the report (sagarsoft_import_report.{md,csv}) and the
clean data CSV (sagarsoft_employees_clean.csv).

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.migrate_employees_active                 # DRY RUN (report only)
    python -m scripts.migrate_employees_active --commit        # already-activated import
    python -m scripts.migrate_employees_active --revert        # undo the import
    python -m scripts.migrate_employees_activation --commit    # import + send activation
"""

import argparse
import asyncio
import csv
import re
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

from beanie import PydanticObjectId, init_beanie
from motor.motor_asyncio import AsyncIOMotorClient

from src.auth.models import UserDocument
from src.auth.utils.tools import get_password_hash
from src.config import settings
from src.correlation import get_correlation_id
from src.master_data.models import MasterDataDocument
from src.models import OutboxEventDocument, StatusEnum
from src.rabbitmq import outbox
from src.modules.organisation.models import (
    AddressDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    EmployeeDocument,
    OrganisationDocument,
)
from bson import ObjectId
from scripts.datafile import read_rows, find_file  # read .csv/.xlsx; find file in a folder

# ── Config ────────────────────────────────────────────────────────────────
# Employee export (.csv OR .xlsx) — overridable with --csv
DEFAULT_CSV = Path(r"C:\Users\avirn\OneDrive\Desktop\Sentrifugo 2.0\old data sentrifugo\employees_data_export.2026-06-26.xlsx")
ORG_ADMIN_EMAIL = "admin+sil@sagarsoft.in"
ORG_ID_FALLBACK = "6a4c8cae5457ae1842d39985"
MARKER = "import_sagarsoft"
DEFAULT_PASSWORD = "test@123"
PAD = 4  # zero-pad width for NEW codes generated after import

NOW = datetime.now(timezone.utc)
TS = NOW.strftime("%Y%m%d_%H%M%S")
REPORT_DIR = Path(__file__).resolve().parent
CLEAN_CSV = REPORT_DIR / "sagarsoft_employees_clean.csv"

# employment_status key -> display value, for the clean CSV.
STATUS_DISPLAY = {
    "permanent": "Permanent", "probation": "Probation",
    "direct-contract": "Direct Contract", "third-party-contract": "Third Party Contract",
}

# Rows to drop entirely:
#   admin / SIL-01        -> old admin accounts; an org admin is created separately
#   1234 / SIL-099999 / BGCK273 -> junk / test rows
#   SIT-0158 / SIT-0159   -> SIL number already occupied by an existing Sagarsoft
#                            employee (SIL-0158 Gopi Mora, SIL-0159 Vishwanth Gunna)
SKIP_IDS = {"1234", "SIL-099999", "BGCK273", "admin", "SIL-01", "SIT-0158", "SIT-0159"}
SKIP_REASONS = {
    "admin": "old admin account (org admin created separately)",
    "SIL-01": "old admin account (org admin created separately)",
    "SIT-0158": "SIL-0158 already occupied (Gopi Mora)",
    "SIT-0159": "SIL-0159 already occupied (Vishwanth Gunna)",
}
CONTRACT_TYPES = {"direct contract", "third party contract"}

# Department merges (applied after norm_dept): fold one department into another.
DEPT_MERGES = {
    "General Admin": "Admin and Facilities",
    "IT-Technical-Sun-Mon-Weekend": "IT Technical",
}

# Duplicate-email winners: email -> employeeId to KEEP (the other row is dropped).
DUP_WINNERS = {
    "ajay.chada@sagarsoft.in": "SIL-0905",
    "karthik.godishala@sagarsoft.in": "SIL-5272",
    "narsingarao.katta@sagarsoft.in": "SIL-0647",
    "prasanth.vangavolu@sagarsoft.in": "SIL-0982",
    "prateek.kumar@sagarsoft.in": "SIL-5288",
    "rajireddy.kesireddy@sagarsoft.in": "SIL-0780",
    "sandeep.prajapati@sagarsoft.in": "SIL-5292",
    "sridevi.reddy@sagarsoft.in": "SIL-0919",
    "srinivas.gungwar@sagarsoft.in": "SIL-0830",
    "surender.lade@sagarsoft.in": "SIL-0995",
    "tharic.akram@sagarsoft.in": "SIL-5287",
}

# CSV EmploymentType -> employment_status key (active rows only; left rows => exit).
TYPE_TO_STATUS_KEY = {
    "permanent": "permanent",
    "probation": "probation",
    "direct contract": "direct-contract",
    "third party contract": "third-party-contract",
    "": "permanent",  # blank => default to permanent
}

# Single BU: everyone (incl. ex-Sapplica SIT rows) goes into Sagarsoft.
BUS = {
    "sagarsoft": {
        "name": "Sagarsoft", "prefix": "SIL",
        "address": {"country": "India", "state": "Telangana", "city": "Hyderabad",
                    "zip_code": "500081", "address_line_1": "Sagarsoft, Madhapur, HITEC City"},
        "incorporation": date(2003, 6, 9),
    },
}


# ── Helpers ───────────────────────────────────────────────────────────────
def norm_name(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def sorted_key(s: str) -> str:
    """Token-order-insensitive key so 'Arsid Srinivas' matches 'Srinivas Arsid'."""
    return " ".join(sorted(norm_name(s).split()))


def written_prefix(emp_id: str) -> str:
    m = re.match(r"^([A-Za-z]+)", (emp_id or "").strip())
    return m.group(1) if m else ""


def code_number(emp_id: str) -> str:
    """Exact numeric suffix as written (with leading zeros). '' if none."""
    m = re.match(r"^[A-Za-z]*[-]?(\d+)$", (emp_id or "").strip())
    return m.group(1) if m else ""


def norm_dept(s: str) -> str:
    """Normalize a department name: trim, collapse spaces, and '&' -> 'and' so
    'Finance & Accounts' and 'Finance and Accounts' merge into one department."""
    return re.sub(r"\s+", " ", (s or "").replace("&", "and").strip())


def parse_date(value):
    """Accept ANY date format -> a `date` (or None). Handles real datetime/date
    cells (Excel) and strings in any layout (ISO, DD/MM/YYYY, 15-Jan-2018, ...)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    if not s:
        return None
    try:
        from dateutil import parser as _du
        return _du.parse(s, dayfirst=True).date()
    except Exception:
        return None


def parse_dt(value):
    """Accept ANY datetime format -> a tz-aware UTC datetime (or None)."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    s = str(value).strip()
    if not s:
        return None
    try:
        from dateutil import parser as _du
        dt = _du.parse(s, dayfirst=True)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


# ── Parse phase (pure; no DB) ─────────────────────────────────────────────
def parse_rows(rows: list[dict]) -> tuple[list[dict], dict]:
    """Classify every CSV row. Returns (records, maxes)."""
    records: list[dict] = []
    seen_emails: set[str] = set()
    maxes = {"sagarsoft": {"F": 0, "C": 0}}

    for r in rows:
        raw_id = (r.get("employeeId") or "").strip()
        email = (r.get("EmailAddress") or "").strip().lower()
        first = (r.get("FirstName") or "").strip()
        last = (r.get("LastName") or "").strip()
        etype = (r.get("EmploymentType") or "").strip()
        estat = (r.get("EmployeeStatus") or "").strip()

        dept = norm_dept(r.get("Department"))
        rec = {
            "raw_id": raw_id, "email": email, "first": first, "last": last,
            "etype": etype, "estat": estat,
            "gender": (r.get("Gender") or "").strip(),
            "marital": (r.get("MaritalStatus") or "").strip(),
            "designation": (r.get("Designation") or "").strip(),
            "department": DEPT_MERGES.get(dept, dept),
            "doj": parse_date(r.get("DateOfJoining")),
            "dol": parse_date(r.get("DateOfLeaving")),
            "mgr1": (r.get("ReportingManager") or "").strip(),
            "mgr2": (r.get("L2ReportingManager") or r.get("l2ReportingManager") or "").strip(),
            "created_on": parse_dt(r.get("createddate")) or NOW,
            "modified_on": parse_dt(r.get("modifieddate")) or NOW,
            "conversions": [],
        }
        if dept in DEPT_MERGES:
            rec["conversions"].append(f"dept '{dept}' -> '{DEPT_MERGES[dept]}'")

        if raw_id in SKIP_IDS:
            rec.update(action="skip", reason=SKIP_REASONS.get(raw_id, "junk/test row"))
            records.append(rec); continue

        if not email:
            rec.update(action="skip", reason="no email")
            records.append(rec); continue

        # Duplicate-email handling. We keep BOTH records (people leave & rejoin).
        # Since email is a unique login id, the OLD/duplicate (inactive) record is
        # imported with a +<empid> tagged email so the DB accepts it; the real
        # email stays on the primary (active / most-recent) record.
        is_old_dup = False
        if email in DUP_WINNERS:
            is_old_dup = raw_id != DUP_WINNERS[email]
        elif email in seen_emails:
            is_old_dup = True
        else:
            seen_emails.add(email)

        rec["orig_email"] = email
        rec["is_old_dup"] = is_old_dup
        if is_old_dup:
            # Rejoined person: SAME real email. We do NOT make a second account or a
            # tagged email — this earlier stint is linked to the current stint's user
            # at insert time and flagged is_rehire (see the creation loop).
            kept = DUP_WINNERS.get(rec["orig_email"], "earlier row")
            rec["conversions"].append(f"rehire: earlier stint of {kept} — linked to one real-email account")

        # --- insert ---
        # Everyone goes into the single Sagarsoft BU. Ex-Sapplica (SIT) rows keep
        # their number but get the SIL prefix (conflicting numbers are in SKIP_IDS).
        is_contract = etype.lower() in CONTRACT_TYPES
        bu_key = "sagarsoft"
        new_prefix = BUS[bu_key]["prefix"]
        num = code_number(raw_id)
        if not num:
            rec.update(action="skip", reason="emp id has no number")
            records.append(rec); continue

        emp_code = f"{new_prefix}-C-{num}" if is_contract else f"{new_prefix}-{num}"

        # Active only if marked active (status 1) AND there is no leaving date.
        # A DateOfLeaving always forces inactive, even if the status flag is stale.
        active = estat == "1" and rec["dol"] is None

        wp = written_prefix(raw_id)
        if wp != new_prefix:
            rec["conversions"].append(f"prefix {wp}->{new_prefix}")
        if is_contract:
            rec["conversions"].append("contract -> -C- code")
        if not active:
            why = "has leaving date" if (estat == "1" and rec["dol"] is not None) else "left"
            rec["conversions"].append(f"{why} -> Exit/inactive")

        rec.update(
            action="insert", reason="", bu_key=bu_key, is_contract=is_contract,
            emp_code=emp_code, user_status="active" if active else "exit",
        )

        letter = "C" if is_contract else "F"
        try:
            maxes[bu_key][letter] = max(maxes[bu_key][letter], int(num))
        except ValueError:
            pass
        records.append(rec)

    return records, maxes


# ── DB write phase ─────────────────────────────────────────────────────────
async def _md_id(category: str, key: str):
    """Return the _id of a global master_data entry (ignores is_active)."""
    doc = await MasterDataDocument.find_one(
        MasterDataDocument.category == category,
        MasterDataDocument.key == key,
        MasterDataDocument.organisation_id == None,  # noqa: E711
    )
    if not doc:  # fall back to any (org-scoped) match
        doc = await MasterDataDocument.find_one(
            MasterDataDocument.category == category, MasterDataDocument.key == key
        )
    return doc.id if doc else None


async def _ensure_status(key: str, value: str):
    existing = await MasterDataDocument.find_one(
        MasterDataDocument.category == "EMPLOYMENT_STATUSES",
        MasterDataDocument.key == key,
    )
    if existing:
        return existing.id
    doc = MasterDataDocument(category="EMPLOYMENT_STATUSES", key=key, value=value,
                             organisation_id=None, is_active=True, is_custom=False)
    await doc.insert()
    print(f"  + master data EMPLOYMENT_STATUSES/{key} created")
    return doc.id


async def _md_map(category: str) -> dict:
    """value-lower AND key -> id, for one category."""
    out: dict[str, PydanticObjectId] = {}
    for d in await MasterDataDocument.find(MasterDataDocument.category == category).to_list():
        out[(d.value or "").strip().lower()] = d.id
        out[(d.key or "").strip().lower()] = d.id
    return out


async def cleanup(org_id: PydanticObjectId):
    print("Cleaning up any previous import (marker=%s)..." % MARKER)
    emp = await EmployeeDocument.find({"created_by": MARKER}).delete()
    usr = await UserDocument.find({"created_by": MARKER}).delete()
    des = await DesignationDocument.find({"organisation_id": org_id, "created_by": MARKER}).delete()
    dep = await DepartmentDocument.find({"organisation_id": org_id, "created_by": MARKER}).delete()
    addrs = await AddressDocument.find({"created_by": MARKER}).delete()
    bus = await BusinessUnitDocument.find({"organisation_id": org_id, "created_by": MARKER}).delete()
    print(f"  removed: {getattr(emp,'deleted_count',0)} employees, {getattr(usr,'deleted_count',0)} users, "
          f"{getattr(des,'deleted_count',0)} designations, {getattr(dep,'deleted_count',0)} departments, "
          f"{getattr(bus,'deleted_count',0)} BUs, {getattr(addrs,'deleted_count',0)} addresses")


async def finalize_emails(records: list[dict]) -> list[dict]:
    """Ensure every insert email is unique vs users ALREADY in the DB (e.g. the
    super admin, whose email also appears as an employee row) and vs each other.
    Any collision gets a +<empid> tag. Returns rows tagged for a DB collision."""
    existing = {(u.email or "").lower()
                for u in await UserDocument.find({"created_by": {"$ne": MARKER}}).to_list()}
    used = set(existing)
    db_collisions = []
    # A rehire (is_old_dup) skips the collision check ONLY when it has a real kept
    # (non-dup) account to link to — that account holds the login; the rehire inserts
    # no user of its own. A rehire with NO kept account (winner skipped/absent) is
    # treated like a normal new account here, so it still gets checked/tagged and can
    # never insert an untagged colliding email.
    kept_emails = {r.get("orig_email") for r in records
                   if r["action"] == "insert" and not r.get("is_old_dup")}
    for r in [x for x in records if x["action"] == "insert"
              and not (x.get("is_old_dup") and x.get("orig_email") in kept_emails)]:
        em = r["email"]
        if em in used:
            local, _, domain = em.partition("@")
            em = f"{local}+{r['raw_id']}@{domain}".lower()
            r["email"] = em
            r["db_collision"] = True
            r["conversions"].append(f"email already in system -> tagged {em}")
            db_collisions.append(r)
        used.add(em)
    return db_collisions


def audit(created_on=None, modified_on=None):
    return {
        "created_by": MARKER, "created_on": created_on or NOW,
        "modified_by": MARKER, "modified_on": modified_on or NOW,
    }


async def run(records: list[dict], maxes: dict, org_id: PydanticObjectId,
              mode: str = "active", emit_events: bool = False):
    """mode='active' => active employees created ACTIVE with password (already
    activated). mode='activation' => active employees created PENDING and an
    activation email is enqueued (outbox -> RabbitMQ -> schedule service).

    emit_events=True publishes the SAME domain events the IAM API fires
    (business_unit.created / department.created / employee.created) to the outbox,
    so the live relay -> RabbitMQ delivers them to downstream services (leave needs
    BU + dept; timesheet / service-request consume employees)."""
    # 1. master data
    et = {"full-time": await _md_id("EMPLOYMENT_TYPES", "full-time"),
          "contract": await _md_id("EMPLOYMENT_TYPES", "contract")}
    es = {
        "permanent": await _md_id("EMPLOYMENT_STATUSES", "permanent"),
        "probation": await _md_id("EMPLOYMENT_STATUSES", "probation"),
        "exit": await _md_id("EMPLOYMENT_STATUSES", "exit"),
        "direct-contract": await _ensure_status("direct-contract", "Direct Contract"),
        "third-party-contract": await _ensure_status("third-party-contract", "Third Party Contract"),
    }
    gmap = await _md_map("GENDERS")
    mmap = await _md_map("MARITAL_STATUSES")
    missing = [k for k, v in {**et, **es}.items() if not v]
    if missing:
        raise RuntimeError(f"Missing required master data: {missing}. Run seed_master_data first.")

    # 2. BUs — REUSE an existing BU with the same name (org may already have its
    # setup done in the app); only create when missing. Reused BUs get their
    # emp-code counters advanced so the app's generator resumes AFTER both the
    # imported max and anything the app already issued. No event for reused BUs
    # (the app already emitted it at creation).
    bu_ids: dict[str, PydanticObjectId] = {}
    for key, cfg in BUS.items():
        start = {"F": maxes[key]["F"] + 1}
        pad = {"F": PAD}
        if maxes[key]["C"]:
            start["C"] = maxes[key]["C"] + 1
            pad["C"] = PAD

        # The setup BU's name won't match exactly (e.g. "Sagarsoft (India) Limited"),
        # so match loosely: name contains 'sagarsoft' OR prefix SIL — and if the org
        # has exactly ONE BU, just use it (single-BU org).
        org_bus = await BusinessUnitDocument.find(
            BusinessUnitDocument.organisation_id == org_id,
            BusinessUnitDocument.deleted_on == None,  # noqa: E711
        ).to_list()
        existing = next((b for b in org_bus
                         if key in (b.business_unit_name or "").lower()
                         or (b.emp_code_prefix or "").upper() == cfg["prefix"]),
                        org_bus[0] if len(org_bus) == 1 else None)
        if existing:
            cur_start = existing.emp_code_start_from or {}
            cur_last = existing.emp_code_last_numbers or {}
            new_start, new_last = dict(cur_start), dict(cur_last)
            for letter in start:
                # next number the app would issue = start_from + counter
                app_next = cur_start.get(letter, 0) + cur_last.get(letter, 0)
                new_start[letter] = max(start[letter], app_next)
                new_last[letter] = 0
            existing.emp_code_start_from = new_start
            existing.emp_code_last_numbers = new_last
            existing.emp_code_padding = {**(existing.emp_code_padding or {}), **pad}
            if not existing.emp_code_prefix:  # generator needs one; don't override theirs
                existing.emp_code_prefix = cfg["prefix"]
            await existing.save()
            bu_ids[key] = existing.id
            print(f"  BU '{existing.business_unit_name}' already exists — REUSED "
                  f"(id={existing.id}), counters resume at {new_start}")
            continue

        addr = AddressDocument(**cfg["address"], **audit())
        await addr.insert()
        bu = BusinessUnitDocument(
            organisation_id=org_id, address_id=addr.id, business_unit_name=cfg["name"],
            emp_code_prefix=cfg["prefix"], date_of_incorporation=cfg["incorporation"],
            currency="INR", time_zone="Asia/Kolkata", time_format="24hr", is_active=True,
            emp_code_last_numbers={k: 0 for k in start}, emp_code_start_from=start,
            emp_code_padding=pad, **audit(),
        )
        await bu.insert()
        bu_ids[key] = bu.id
        print(f"  BU {cfg['name']} ({cfg['prefix']}) created, start_from={start}")
        if emit_events:
            await outbox.publish("business_unit.created", {
                "correlation_id": get_correlation_id(),
                "business_unit_id": str(bu.id), "organisation_id": str(org_id),
                "name": cfg["name"], "is_subsidiary": False, "is_active": True,
                "head_user_id": None, "time_zone": "Asia/Kolkata", "currency": "INR",
            }, idempotency_key=f"business_unit.created:{bu.id}")

    # 3. designations (org-level, verbatim) — reuse existing ones by name
    existing_desg = {(d.designation_name or "").strip().lower(): d.id
                     for d in await DesignationDocument.find(
                         DesignationDocument.organisation_id == org_id,
                         DesignationDocument.deleted_on == None).to_list()}  # noqa: E711
    desg_ids: dict[str, PydanticObjectId] = {}
    desg_created = 0
    desg_names = sorted({r["designation"] for r in records if r["action"] == "insert" and r["designation"]})
    for name in desg_names:
        if name.strip().lower() in existing_desg:
            desg_ids[name] = existing_desg[name.strip().lower()]
            continue
        d = DesignationDocument(organisation_id=org_id, designation_name=name,
                                description="", is_active=True, **audit())
        await d.insert()
        desg_ids[name] = d.id
        desg_created += 1
    print(f"  designations: {desg_created} created, {len(desg_ids) - desg_created} reused")

    # 3b. departments — reuse existing ones by name; create only the missing,
    # mapped to the single BU. No event for reused departments.
    existing_dept = {(d.department_name or "").strip().lower(): d.id
                     for d in await DepartmentDocument.find(
                         DepartmentDocument.organisation_id == org_id,
                         DepartmentDocument.deleted_on == None).to_list()}  # noqa: E711
    dept_bu: dict[str, Counter] = {}
    for r in records:
        if r["action"] == "insert" and r["department"]:
            dept_bu.setdefault(r["department"], Counter())[r["bu_key"]] += 1
    dept_ids: dict[str, PydanticObjectId] = {}
    dept_created = 0
    for name, counter in sorted(dept_bu.items()):
        if name.strip().lower() in existing_dept:
            dept_ids[name] = existing_dept[name.strip().lower()]
            continue
        bu_list = [bu_ids[k] for k in counter]
        primary = bu_ids[counter.most_common(1)[0][0]]
        dep = DepartmentDocument(
            organisation_id=org_id, department_name=name,
            business_units=bu_list, primary_business_unit=primary,
            is_active=True, **audit(),
        )
        await dep.insert()
        dept_ids[name] = dep.id
        dept_created += 1
        if emit_events:
            await outbox.publish("department.created", {
                "correlation_id": get_correlation_id(),
                "department_id": str(dep.id), "organisation_id": str(org_id),
                "name": name, "business_unit_ids": [str(b) for b in bu_list],
                "business_unit_id": str(primary), "is_active": True,
                "department_head": None, "department_code": None,
            }, idempotency_key=f"department.created:{dep.id}")
    print(f"  departments: {dept_created} created, {len(dept_ids) - dept_created} reused")

    # 4. employee users + employee docs
    # (no org-admin creation here — 'admin' / 'SIL-01' are skipped; an org admin
    # is created separately, outside this import)
    name_to_uid: dict[str, list[tuple[PydanticObjectId, bool]]] = {}
    sorted_to_uid: dict[str, list[tuple[PydanticObjectId, bool]]] = {}
    inserts = [x for x in records if x["action"] == "insert"]
    # Process the kept (real-email) account before any earlier stint of the same
    # person, so the rehire links to a user that already exists.
    inserts.sort(key=lambda r: bool(r.get("is_old_dup")))
    pending_activation: list[tuple] = []  # (user_id, email, full_name) for activation mode
    email_to_winner: dict[str, tuple] = {}  # orig_email -> (user_id, kept_emp_code)
    for r in inserts:
        active = r["user_status"] == "active"
        # Rejoined person: an earlier stint whose kept (current) account we already
        # made. Reuse that ONE real-email user — no second login, no tagged email —
        # and keep this stint's employee record, flagged is_rehire.
        is_rehire = bool(r.get("is_old_dup")) and r.get("orig_email") in email_to_winner
        if is_rehire:
            uid, keeper_code = email_to_winner[r["orig_email"]]
            r["_uid"] = uid
            r["_rehire_keeper_code"] = keeper_code
        else:
            # Active employees: 'active' mode => ACTIVE + password; 'activation' mode =>
            # INACTIVE/pending (no password) and an activation email is sent below.
            # Left/inactive employees => EXIT, never a password or email, in both modes.
            if not active:
                u_status, u_pw, u_pwchanged = StatusEnum.EXIT, None, None
            elif mode == "activation":
                u_status, u_pw, u_pwchanged = StatusEnum.INACTIVE, None, None
            else:
                u_status, u_pw, u_pwchanged = StatusEnum.ACTIVE, get_password_hash(DEFAULT_PASSWORD), NOW
            u = UserDocument(
                email=r["email"], password_hash=u_pw,
                auth_method="local", first_name=r["first"] or "-", last_name=r["last"] or "",
                gender=gmap.get(r["gender"].lower()), marital_status=mmap.get(r["marital"].lower()),
                status=u_status, organisation_id=org_id, policy_ids=[],
                password_changed_at=u_pwchanged,
                **audit(r["created_on"], r["modified_on"]),
            )
            await u.insert()
            r["_uid"] = u.id
            email_to_winner.setdefault(r.get("orig_email") or r["email"], (u.id, r["emp_code"]))
            if active and mode == "activation":
                pending_activation.append((u.id, r["email"], f"{r['first']} {r['last']}".strip()))
            full = f"{r['first']} {r['last']}"
            name_to_uid.setdefault(norm_name(full), []).append((u.id, active))
            sorted_to_uid.setdefault(sorted_key(full), []).append((u.id, active))

        status_id = es["exit"] if not active else es[TYPE_TO_STATUS_KEY.get(r["etype"].lower(), "permanent")]
        emp = EmployeeDocument(
            organisation_id=org_id, user_id=r["_uid"], emp_code=r["emp_code"],
            business_unit_id=bu_ids[r["bu_key"]], department_id=dept_ids.get(r["department"]),
            designation_id=desg_ids.get(r["designation"]),
            employment_type=et["contract"] if r["is_contract"] else et["full-time"],
            employment_status=status_id,
            date_of_joining=r["doj"], date_of_exit=r["dol"] if not active else None,
            **audit(r["created_on"], r["modified_on"]),
        )
        await emp.insert()
        r["_eid"] = emp.id
        r["_status_id"] = status_id
        if is_rehire:
            # EmployeeDocument has no rehire fields — set them raw. Flag this earlier
            # stint, and mark the kept stint as having a prior one (both kept).
            coll = EmployeeDocument.get_motor_collection()
            await coll.update_one(
                {"_id": emp.id},
                {"$set": {"is_rehire": True, "rehire_primary_user_id": uid,
                          "rehire_primary_emp_code": keeper_code}})
            await coll.update_one(
                {"organisation_id": org_id, "user_id": uid, "emp_code": keeper_code},
                {"$set": {"has_prior_stint": True, "prior_emp_code": r["emp_code"]}})

    # 6. manager resolution (pass 2, by name)
    def resolve(name: str):
        cands = name_to_uid.get(norm_name(name)) or sorted_to_uid.get(sorted_key(name)) or []
        if not cands:
            return None
        active = [uid for uid, a in cands if a]
        return active[0] if active else cands[0][0]

    unresolved = set()
    for r in inserts:
        l1 = resolve(r["mgr1"]) if r["mgr1"] else None
        l2 = resolve(r["mgr2"]) if r["mgr2"] else None
        r["_l1"], r["_l2"] = l1, l2
        if r["mgr1"] and not l1:
            unresolved.add(r["mgr1"])
        if r["mgr2"] and not l2:
            unresolved.add(r["mgr2"])
        if l1 or l2:
            emp = await EmployeeDocument.get(r["_eid"])
            emp.l1_manager_id = l1
            emp.l2_manager_id = l2
            await emp.save()
    print(f"  managers resolved; {len(unresolved)} distinct names unresolved")

    # 6a. emit employee.created events (matches the API) so downstream services
    # (timesheet / service-request) sync. The leave service ignores these (it
    # fetches employees via RPC); it only needs the BU + dept events above.
    if emit_events:
        for r in inserts:
            await outbox.publish("employee.created", {
                "correlation_id": get_correlation_id(),
                "user_id": str(r["_uid"]), "employee_id": str(r["_eid"]),
                "organisation_id": str(org_id), "emp_code": r["emp_code"],
                "work_email": r["email"], "name": f"{r['first']} {r['last']}".strip(),
                "first_name": r["first"], "last_name": r["last"],
                "l1_manager_id": str(r["_l1"]) if r.get("_l1") else None,
                "l2_manager_id": str(r["_l2"]) if r.get("_l2") else None,
                "designation_id": str(desg_ids[r["designation"]]) if r["designation"] in desg_ids else None,
                "department_id": str(dept_ids[r["department"]]) if r["department"] in dept_ids else None,
                "business_unit_id": str(bu_ids[r["bu_key"]]),
                "employment_status": str(r["_status_id"]) if r.get("_status_id") else None,
                "project_status": None,
                "date_of_joining": str(r["doj"]) if r["doj"] else None,
            }, idempotency_key=f"employee.created:{r['_uid']}")
        print(f"  emitted sync events: {len(BUS)} BU + {len(dept_ids)} dept + "
              f"{len(inserts)} employee -> outbox (relay will deliver)")

    # 6b. activation emails (activation mode only): enqueue via the SAME path the
    # create flow uses — store tokens in Valkey + publish an outbox event that the
    # relay -> RabbitMQ -> schedule service turns into a real email. Inactive/left
    # employees and rehire stints are never emailed.
    if mode == "activation" and pending_activation:
        from src.valkey import init_valkey
        from src.auth.service import send_activation_email
        await init_valkey()
        sent = 0
        for uid, email, name in pending_activation:
            try:
                await send_activation_email(str(uid), email, name, tenant_id=str(org_id))
                sent += 1
            except Exception as exc:
                print(f"  activation email FAILED for {email}: {exc}")
        print(f"  activation events enqueued for {sent}/{len(pending_activation)} active employees")

    # 7. activate the org + mark setup progress so the data shows in the app
    org = await OrganisationDocument.get(ObjectId(org_id))
    if org:
        org.is_multiple_business_units = False  # single BU (Sagarsoft only)
        org.setup_status = "active"
        org.setup_progress = {
            "organisation": "completed", "business_units": "completed",
            "departments": "completed", "org_documents": "pending",
            "policies": "pending", "designations": "completed",
            "bands": "pending", "pay_grades": "pending",
            "employees": "completed", "assign_head": "pending",
        }
        await org.save()
        print("  org activated (setup_status=active, single-BU, progress updated)")
    return unresolved


def dryrun_managers(records):
    names = {norm_name(f"{r['first']} {r['last']}") for r in records if r["action"] == "insert"}
    sorted_names = {sorted_key(f"{r['first']} {r['last']}") for r in records if r["action"] == "insert"}
    unresolved = set()
    for r in records:
        if r["action"] != "insert":
            continue
        for m in (r["mgr1"], r["mgr2"]):
            if m and norm_name(m) not in names and sorted_key(m) not in sorted_names:
                unresolved.add(m)
    return unresolved


# ── Report ─────────────────────────────────────────────────────────────────
def write_report(records, maxes, unresolved, mode: str = "active", write_files: bool = True):
    """Build the report. Files are written ONLY when write_files (a successful
    commit) — any existing report files are removed first and replaced. On a dry
    run the summary is printed to the console only (no files)."""
    csv_path = REPORT_DIR / "sagarsoft_import_report.csv"
    md_path = REPORT_DIR / "sagarsoft_import_report.md"

    csv_rows = [["raw_id", "action", "emp_code", "bu", "department", "type", "user_status",
                 "email", "name", "conversions", "reason"]]
    for r in records:
        csv_rows.append([
            r["raw_id"], r["action"], r.get("emp_code", ""),
            r.get("bu_key", ""), r.get("department", ""),
            "contract" if r.get("is_contract") else ("" if r["action"] != "insert" else "full-time"),
            r.get("user_status", ""), r["email"], f"{r['first']} {r['last']}".strip(),
            "; ".join(r["conversions"]), r["reason"],
        ])

    inserts = [r for r in records if r["action"] == "insert"]
    ex_sapplica = sum(1 for r in inserts if written_prefix(r["raw_id"]).upper() == "SIT")
    contracts = sum(1 for r in inserts if r["is_contract"])
    active = sum(1 for r in inserts if r["user_status"] == "active")
    tagged = [r for r in inserts if r.get("email") != r.get("orig_email")]
    rehires = [r for r in inserts if r.get("is_old_dup")]
    skipped = [r for r in records if r["action"] == "skip"]
    dept_bu = {}
    for r in inserts:
        if r["department"]:
            dept_bu.setdefault(r["department"], Counter())[r["bu_key"]] += 1
    no_dept = sum(1 for r in inserts if not r["department"])
    dol_forced = sum(1 for r in inserts if r["estat"] == "1" and r["dol"] is not None)

    lines = []
    state = "COMMITTED" if write_files else "DRY RUN (preview only)"
    lines.append(f"# Sagarsoft employee import report ({state}, mode={mode}) — {TS}\n")
    lines.append("## Summary\n")
    lines.append(f"- Total CSV rows: **{len(records)}**")
    lines.append(f"- Inserted employees: **{len(inserts)}** — single BU Sagarsoft "
                 f"(incl. {ex_sapplica} ex-Sapplica SIT->SIL; "
                 f"contract {contracts}, full-time {len(inserts)-contracts}; active {active}, left {len(inserts)-active})")
    lines.append("- Org-admin users: **0** (admin / SIL-01 skipped — org admin created separately)")
    lines.append(f"- Rehires (rejoined people) linked to ONE real-email account: **{len(rehires)}** "
                 f"(both stints kept; no second login, no tagged email)")
    lines.append(f"- Emails already in the DB given a `+<empid>` tagged email: **{len(tagged)}** (0 dropped)")
    lines.append(f"- Departments: **{len(dept_bu)}** (employees with no department: {no_dept})")
    lines.append(f"- Forced inactive by a leaving date despite status=1: **{dol_forced}**")
    lines.append(f"- Skipped (junk/no email/no number): **{len(skipped)}**")
    lines.append(f"- Unresolved manager names: **{len(unresolved)}**\n")

    lines.append("## Departments (mapped to BUs)\n")
    for name, counter in sorted(dept_bu.items(), key=lambda x: -sum(x[1].values())):
        spread = ", ".join(f"{BUS[k]['name']} {n}" for k, n in counter.most_common())
        lines.append(f"- **{name}** — {sum(counter.values())} emp ({spread})")
    lines.append("")

    lines.append("## Next auto-generated codes (resumed flow)\n")
    lines.append(f"- Sagarsoft full-time: `SIL-{maxes['sagarsoft']['F']+1:0{PAD}d}` | "
                 f"contract: `SIL-C-{maxes['sagarsoft']['C']+1:0{PAD}d}`\n")

    lines.append("## Rehires — rejoined people linked to ONE real-email account\n")
    lines.append("Same person, different employee codes, **same email**. We keep BOTH employee stints, "
                 "link the earlier stint to the current account's user (no new login, no tagged email), "
                 "flag the earlier stint `is_rehire` and the current stint `has_prior_stint`.\n")
    if rehires:
        lines.append("| Earlier stint (rehire) | Linked to kept account | Real email |")
        lines.append("|---|---|---|")
        for r in rehires:
            keeper = r.get("_rehire_keeper_code") or DUP_WINNERS.get(r.get("orig_email"), "?")
            lines.append(f"| `{r['emp_code']}` ({r['raw_id']}) | `{keeper}` | <{r.get('orig_email','')}> |")
    else:
        lines.append("_None detected._")
    lines.append("")

    lines.append("## Emails already in the system — given a unique tagged email\n")
    lines.append("_Not rehires. These CSV emails already existed in the DB (e.g. the super admin), so the "
                 "imported row got a `+<empid>` tag to satisfy the unique-email rule._\n")
    for r in tagged:
        lines.append(f"- `{r['raw_id']}` — real <{r['orig_email']}> "
                     f"imported as `{r['emp_code']}` with email <{r['email']}>")
    lines.append("")

    lines.append("## Skipped\n")
    for r in skipped:
        lines.append(f"- `{r['raw_id']}` <{r['email']}> — {r['reason']}")
    lines.append("")

    lines.append("## Unresolved manager names (left null)\n")
    for n in sorted(unresolved):
        lines.append(f"- {n}")
    lines.append(f"\n_Per-row detail: {csv_path.name}_\n")

    if write_files:
        for p in (csv_path, md_path):
            if p.exists():
                p.unlink()
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows(csv_rows)
        md_path.write_text("\n".join(lines), encoding="utf-8")
        print(f"\nReport written (replaced existing):\n  {md_path}\n  {csv_path}")
    print("\n".join(lines[:18]))


def write_clean_csv(records: list[dict]):
    """Write the cleaned/converted dataset (as imported) to sagarsoft_employees_clean.csv.
    Built from the in-memory records — no DB read needed."""
    inserts = [r for r in records if r["action"] == "insert"]
    # name -> emp_code for managers (prefer the active record on a name clash)
    name_code: dict[str, str] = {}
    skey_code: dict[str, str] = {}
    for r in inserts:
        nk = norm_name(f"{r['first']} {r['last']}")
        if nk not in name_code or r["user_status"] == "active":
            name_code[nk] = r["emp_code"]
        skey_code.setdefault(sorted_key(f"{r['first']} {r['last']}"), r["emp_code"])

    def mcode(name: str) -> str:
        if not name:
            return ""
        return name_code.get(norm_name(name)) or skey_code.get(sorted_key(name), "")

    def estatus(r: dict) -> str:
        if r["user_status"] != "active":
            return "Exit"
        return STATUS_DISPLAY.get(TYPE_TO_STATUS_KEY.get(r["etype"].lower(), "permanent"), "Permanent")

    rows = sorted(inserts, key=lambda r: r["emp_code"])
    if CLEAN_CSV.exists():
        CLEAN_CSV.unlink()
    with open(CLEAN_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["emp_code", "first_name", "last_name", "email", "business_unit", "department",
                    "designation", "employment_type", "employment_status", "account_status",
                    "gender", "marital_status", "date_of_joining", "date_of_exit",
                    "l1_manager", "l1_manager_code", "l2_manager", "l2_manager_code",
                    "created_on", "modified_on"])
        for r in rows:
            inactive = r["user_status"] != "active"
            w.writerow([
                r["emp_code"], r["first"], r["last"], r["email"], BUS[r["bu_key"]]["name"],
                r["department"], r["designation"],
                "Contract" if r["is_contract"] else "Full-Time", estatus(r), r["user_status"],
                r["gender"], r["marital"],
                r["doj"].isoformat() if r["doj"] else "",
                r["dol"].isoformat() if (r["dol"] and inactive) else "",
                r["mgr1"], mcode(r["mgr1"]), r["mgr2"], mcode(r["mgr2"]),
                r["created_on"].isoformat() if r["created_on"] else "",
                r["modified_on"].isoformat() if r["modified_on"] else "",
            ])
    print(f"Clean data CSV written: {CLEAN_CSV} ({len(rows)} rows)")


# ── Entry ────────────────────────────────────────────────────────────────
async def main(mode: str = "active"):
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="write to the DB (default: dry run)")
    ap.add_argument("--revert", action="store_true", help="delete everything this importer created, then exit")
    ap.add_argument("--emit-events", action="store_true",
                    help="publish business_unit/department/employee.created events to the outbox so "
                         "downstream services (leave, timesheet, service-request) sync")
    ap.add_argument("--csv", help="employee export file (.csv or .xlsx); overrides --data-dir")
    ap.add_argument("--data-dir", help="folder holding the export files (file picked by name)")
    ap.add_argument("--org-id", help="organisation id to import into (default: resolve from admin email)")
    args = ap.parse_args()

    # A revert only deletes by marker — it never reads the export file, so don't
    # require one (the orchestrator doesn't forward --data-dir on revert).
    if not args.revert:
        if args.csv:
            csv_path = Path(args.csv)
        elif args.data_dir:
            csv_path = find_file(args.data_dir, ["employee"])
        else:
            csv_path = DEFAULT_CSV
        if not csv_path.exists():
            print(f"ERROR: data file not found at {csv_path}")
            sys.exit(1)
        rows = read_rows(csv_path)

        records, maxes = parse_rows(rows)
        print(f"Parsed {len(rows)} rows. (mode={mode})")
        if mode == "activation" and args.commit:
            n_active = sum(1 for r in records if r["action"] == "insert" and r["user_status"] == "active")
            print(f"  !! ACTIVATION MODE: this will enqueue activation emails for {n_active} active "
                  f"employees via the outbox -> RabbitMQ -> schedule service.")

    if not settings.MONGODB_URL:
        print("ERROR: MONGODB_URL not configured.")
        sys.exit(1)
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    await init_beanie(
        database=client.get_default_database(),
        document_models=[UserDocument, OrganisationDocument, BusinessUnitDocument,
                         DepartmentDocument, DesignationDocument, EmployeeDocument,
                         AddressDocument, MasterDataDocument, OutboxEventDocument],
    )

    admin = None
    if args.org_id:
        org_id = PydanticObjectId(args.org_id)
    else:
        admin = await UserDocument.find_one(UserDocument.email == ORG_ADMIN_EMAIL.lower())
        org_id = admin.organisation_id if admin else PydanticObjectId(ORG_ID_FALLBACK)
    org = await OrganisationDocument.get(org_id)
    if not org:
        print(f"ERROR: org not found (admin={'yes' if admin else 'no'}, org_id={org_id}).")
        client.close()
        sys.exit(1)
    print(f"Org: {org.legal_name} (id={org_id})")

    if args.revert:
        await cleanup(org_id)
        print("Revert complete — all import_sagarsoft data removed "
              "(the 2 added master-data statuses are left in place).")
        client.close()
        return

    db_collisions = await finalize_emails(records)
    if db_collisions:
        print(f"  {len(db_collisions)} CSV email(s) already exist in the DB -> tagged: "
              + ", ".join(f"{r['raw_id']}({r['orig_email']})" for r in db_collisions))

    if args.commit:
        await cleanup(org_id)
        unresolved = await run(records, maxes, org_id, mode=mode, emit_events=args.emit_events)
    else:
        print("DRY RUN — no DB writes. (managers resolved against in-file names only)")
        unresolved = dryrun_managers(records)

    # Report + clean CSV are (re)generated ONLY on a successful commit — existing
    # ones are removed and replaced. A dry run prints the summary to console only.
    if args.commit:
        write_report(records, maxes, unresolved, mode=mode, write_files=True)
        write_clean_csv(records)
    else:
        write_report(records, maxes, unresolved, mode=mode, write_files=False)
    client.close()


if __name__ == "__main__":
    asyncio.run(main("active"))
