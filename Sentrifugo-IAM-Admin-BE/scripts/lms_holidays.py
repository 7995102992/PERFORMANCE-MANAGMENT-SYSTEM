"""Import holidays + plans + classification into the leave (LMS) DB, linked to
employees by HolidayGroup. Dev/migration tool (prod creates these via the LMS API).

Reads:
  - holiday CSV  : HolidayName, DATE, holidayyear, DESCRIPTION, GroupName
  - employee XLSX: the org sheet with a HolidayGroup column

Writes into the LMS DB (sentrifugo_lms), in the exact shape the LMS services use:
  - 1 'Holiday' classification (every holiday uses it)
  - holiday_plans : one per (GroupName, year); BU/dept scope DERIVED from the
                    group's ACTIVE FULL-TIME members (fallback: all BUs + depts)
  - holidays      : each CSV row -> its (group, year) plan, with the plan's scope
  - holiday_plan_employees : each ACTIVE FULL-TIME employee that has a HolidayGroup
                    -> that group's plan for EVERY year

Assignment rule: ACTIVE + FULL-TIME (Permanent / Probation) + non-blank HolidayGroup.
Contractors (Direct/Third Party Contract), inactive, and blank-group are NEVER assigned.

Every created doc is tagged import_batch=MARKER for a clean --revert.

Usage:
    cd Sentrifugo-IAM-Admin-BE
    python -m scripts.lms_holidays              # DRY RUN (report only)
    python -m scripts.lms_holidays --commit     # write into the LMS DB
    python -m scripts.lms_holidays --revert     # delete this import's LMS data
"""

import argparse
import asyncio
import csv
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorClient
from scripts.datafile import read_rows, find_file

from src.config import settings

ORG_ID = ObjectId("6a3e05a5c0470e0bdd9ce9a9")
MIGRATION_USER = ObjectId("6a3e05a5c0470e0bdd9ce9aa")  # org admin (audit created_by)
LMS_DB = "sentrifugo_lms"
MARKER = "holiday_migration"

# Holiday + employee exports (.csv OR .xlsx) — overridable with --holiday-file / --emp-file
HOLIDAY_CSV = Path(r"C:\Users\avirn\OneDrive\Desktop\Sentrifugo 2.0\old data sentrifugo\holiday_export.2026-06-25.xlsx")
EMP_XLSX = Path(r"C:\Users\avirn\OneDrive\Desktop\Sentrifugo 2.0\old data sentrifugo\employees_data_export.2026-06-26.xlsx")
CLASSIFICATION_NAME = "Holiday"
CLASSIFICATION_COLOR = "#6b7280"
# Only plans of this year stay active; every older (or future) year's plan is
# imported with is_active=False so the app shows just the current year.
ACTIVE_PLAN_YEAR = 2026
CONTRACT_TYPES = {"direct contract", "third party contract"}
REPORT_MD = Path(__file__).resolve().parent / "holiday_import_report.md"
NOW = datetime.now(timezone.utc)


def audit() -> dict:
    return {"created_on": NOW, "created_by": MIGRATION_USER, "updated_on": None,
            "updated_by": None, "deleted_on": None, "deleted_by": None,
            "correlation_id": str(uuid.uuid4()), "import_batch": MARKER}


def read_holidays() -> list[dict]:
    return read_rows(HOLIDAY_CSV)


def read_employees() -> list[dict]:
    return read_rows(EMP_XLSX, sheet="Data")


def is_active(r: dict) -> bool:
    return str(r.get("EmployeeStatus")) == "1" and not r.get("DateOfLeaving")


def is_fulltime(r: dict) -> bool:
    return (str(r.get("EmploymentType") or "").strip().lower()) not in CONTRACT_TYPES


def parse_any_date(value):
    """Accept ANY date format -> a `date` (or None). Handles real datetime/date
    cells from Excel and strings in any common layout (ISO, DD/MM/YYYY,
    15-Jan-2018, Jan 15 2018, 15.01.2018, ...). Reusable for every date column."""
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
        return _du.parse(s, dayfirst=True).date()  # dayfirst -> Indian DD/MM
    except Exception:
        return None


def parse_holidays(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Normalize raw holiday rows; skip any with no group or an unparseable date."""
    clean, skipped = [], []
    for r in rows:
        g = str(r.get("GroupName") or "").strip()
        d = parse_any_date(r.get("DATE"))
        if not g or d is None:
            skipped.append(r); continue
        ytxt = str(r.get("holidayyear") or "").strip()
        try:
            y = int(float(ytxt)) if ytxt else d.year
        except Exception:
            y = d.year
        clean.append({"group": g, "year": y, "date": d.isoformat(),
                      "name": str(r.get("HolidayName") or "").strip(),
                      "desc": (str(r.get("DESCRIPTION") or "").strip() or None)})
    return clean, skipped


async def main():
    global HOLIDAY_CSV, EMP_XLSX, ORG_ID
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="write into the LMS DB (default: dry run)")
    ap.add_argument("--revert", action="store_true", help="delete this import's LMS data, then exit")
    ap.add_argument("--holiday-file", help="holiday export (.csv/.xlsx); overrides --data-dir")
    ap.add_argument("--emp-file", help="employee export (.csv/.xlsx); overrides --data-dir")
    ap.add_argument("--data-dir", help="folder holding the export files (files picked by name)")
    ap.add_argument("--org-id", help="organisation id (default: the built-in one)")
    args = ap.parse_args()
    if args.holiday_file:
        HOLIDAY_CSV = Path(args.holiday_file)
    elif args.data_dir:
        HOLIDAY_CSV = find_file(args.data_dir, ["holiday"], exclude="employee")
    if args.emp_file:
        EMP_XLSX = Path(args.emp_file)
    elif args.data_dir:
        EMP_XLSX = find_file(args.data_dir, ["employee"])
    if args.org_id:
        ORG_ID = ObjectId(args.org_id)

    client = AsyncIOMotorClient(settings.MONGODB_URL)
    lms = client[LMS_DB]

    if args.revert:
        out = {}
        for col in ("holiday_plan_employees", "holidays", "holiday_plans", "holiday_classifications"):
            out[col] = (await lms[col].delete_many({"import_batch": MARKER})).deleted_count
        print("Reverted (LMS):", out)
        client.close()
        return

    if not HOLIDAY_CSV.exists() or not EMP_XLSX.exists():
        print("ERROR: source files missing.")
        return

    clean_hols, skipped_hols = parse_holidays(read_holidays())
    emps = read_employees()

    # LMS employees: email -> {user_id, bu_id, dept_id}
    lms_emp: dict[str, dict] = {}
    async for e in lms["employees"].find({"organisation_id": ORG_ID}):
        em = (e.get("work_email") or "").strip().lower()
        if em:
            lms_emp[em] = {"user_id": e.get("user_id"),
                           "bu_id": e.get("business_unit_id"),
                           "dept_id": e.get("department_id")}

    # XLSX deduped by email (prefer the active row)
    by_email: dict[str, dict] = {}
    for r in emps:
        em = str(r.get("EmailAddress") or "").strip().lower()
        if not em:
            continue
        if em not in by_email or (is_active(r) and not is_active(by_email[em])):
            by_email[em] = r

    # Assignable = active + full-time + has a group + matched in the LMS
    group_members: dict[str, list[dict]] = defaultdict(list)
    assignable: list[tuple] = []   # (email, group, user_id)
    excl = Counter()
    for em, r in by_email.items():
        g = str(r.get("HolidayGroup") or "").strip()
        if not is_active(r):
            excl["inactive"] += 1; continue
        if not is_fulltime(r):
            excl["contractor"] += 1; continue
        if not g:
            excl["blank_group"] += 1; continue
        le = lms_emp.get(em)
        if not le or not le.get("user_id"):
            excl["not_in_lms"] += 1; continue
        group_members[g].append(le)
        assignable.append((em, g, le["user_id"]))

    all_bus = [b["_id"] async for b in lms["business_units"].find({"org_id": ORG_ID})]
    all_depts = [d["_id"] async for d in lms["departments"].find({"org_id": ORG_ID})]

    def group_scope(g: str):
        mem = group_members.get(g, [])
        bus = {m["bu_id"] for m in mem if m.get("bu_id")} or set(all_bus)
        depts = {m["dept_id"] for m in mem if m.get("dept_id")} or set(all_depts)
        return list(bus), list(depts)

    plan_keys = sorted({(h["group"], h["year"]) for h in clean_hols})
    groups = sorted({g for g, _ in plan_keys})
    asg_by_group = Counter(g for _, g, _ in assignable)

    # ── report (built for both dry + commit) ──────────────────────────────
    lines = [f"# Holiday import report ({'COMMITTED' if args.commit else 'DRY RUN'}) — {NOW:%Y-%m-%d %H:%M}\n",
             "## Summary\n",
             f"- Source holidays: **{len(clean_hols)}** (skipped {len(skipped_hols)} unparseable)  |  "
             f"groups: **{len(groups)}**  |  plans (group×year): **{len(plan_keys)}**",
             f"- Plan status: **{sum(1 for _, y in plan_keys if y == ACTIVE_PLAN_YEAR)}** active "
             f"({ACTIVE_PLAN_YEAR}) / **{sum(1 for _, y in plan_keys if y != ACTIVE_PLAN_YEAR)}** inactive (other years)",
             f"- Classification: **{CLASSIFICATION_NAME}** (all holidays)",
             f"- Assignable employees (active full-time w/ group): **{len(assignable)}**",
             f"- Excluded from assignment: " + ", ".join(f"{k}={v}" for k, v in sorted(excl.items())) + "\n",
             "## Plans & assignments by group\n",
             "| Group | years | holidays | members assigned |", "|---|---|---|---|"]
    hol_by_group = Counter(h["group"] for h in clean_hols)
    yrs_by_group = defaultdict(set)
    for g, y in plan_keys:
        yrs_by_group[g].add(y)
    for g in groups:
        ys = sorted(yrs_by_group[g])
        lines.append(f"| {g} | {ys[0]}–{ys[-1]} ({len(ys)}) | {hol_by_group[g]} | {asg_by_group.get(g, 0)} |")
    assign_total = sum(asg_by_group[g] * len(yrs_by_group[g]) for g in groups)
    lines.append(f"\n- **Total assignment rows** (employee × group-year): ~**{assign_total}**\n")

    print("\n".join(lines))

    if not args.commit:
        REPORT_MD.write_text("\n".join(lines), encoding="utf-8")
        print(f"\nDRY RUN — no writes. Report: {REPORT_MD}")
        client.close()
        return

    # ── commit ────────────────────────────────────────────────────────────
    for col in ("holiday_plan_employees", "holidays", "holiday_plans", "holiday_classifications"):
        await lms[col].delete_many({"import_batch": MARKER})

    cdoc = {"org_id": ORG_ID, "name": CLASSIFICATION_NAME, "color": CLASSIFICATION_COLOR, **audit()}
    await lms["holiday_classifications"].insert_one(cdoc)
    cls_id = cdoc["_id"]

    plan_meta: dict[tuple, tuple] = {}   # (group, year) -> (plan_id, bus, depts)
    for g, y in plan_keys:
        bus, depts = group_scope(g)
        pdoc = {"name": f"{g} {y}", "year": y, "business_unit_ids": bus, "department_ids": depts,
                "reminder_settings": {"enabled": False, "days_before": 2},
                "notify_employees": None, "reprocess_leaves": None,
                "org_id": ORG_ID, "is_active": y == ACTIVE_PLAN_YEAR, **audit()}
        await lms["holiday_plans"].insert_one(pdoc)
        plan_meta[(g, y)] = (pdoc["_id"], bus, depts)

    hol_docs = []
    for h in clean_hols:
        pid, bus, depts = plan_meta[(h["group"], h["year"])]
        hol_docs.append({
            "name": h["name"], "date": h["date"],
            "reminder": {"enabled": False, "days_before": 2},
            "description": h["desc"],
            "notify_employees": None, "reprocess_leaves": None,
            "classification_id": cls_id, "business_unit_ids": bus,
            "applicable_department_ids": depts, "plan_id": pid, "org_id": ORG_ID, **audit()})
    if hol_docs:
        await lms["holidays"].insert_many(hol_docs)

    group_years = defaultdict(list)
    for (g, y), (pid, _, _) in plan_meta.items():
        group_years[g].append(pid)
    assign_docs = []
    for _em, g, uid in assignable:
        for pid in group_years.get(g, []):
            assign_docs.append({"plan_id": pid, "org_id": ORG_ID, "user_id": uid, **audit()})
    for i in range(0, len(assign_docs), 1000):
        await lms["holiday_plan_employees"].insert_many(assign_docs[i:i + 1000])

    REPORT_MD.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nCOMMITTED to LMS: 1 classification, {len(plan_keys)} plans, "
          f"{len(hol_docs)} holidays, {len(assign_docs)} assignments. Report: {REPORT_MD}")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
