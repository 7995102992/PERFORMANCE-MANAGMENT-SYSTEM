"""Bulk employee upload helpers — parsing, validation, template generation.

Handles column jumble (any order, any case, extra cols ignored, aliases).
Matches header names to canonical field names via HEADER_ALIASES.
Master data fields (employment_type, gender, etc.) are resolved by value → ObjectId.
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime
from typing import Any, Optional

from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation


# ─── Canonical field → accepted aliases (all lowercased/normalized) ──────────

HEADER_ALIASES: dict[str, list[str]] = {
    "first_name":          ["first name", "firstname", "given name"],
    "last_name":           ["last name", "lastname", "surname", "family name"],
    "business_unit":       ["business unit", "bu"],
    "work_email":          ["email address", "work email", "email", "work email address", "office email"],
    "department":          ["department", "dept"],
    "designation":         ["designation", "job level", "job title", "position"],
    "role":                ["role", "user role", "policy"],
    "employment_type":     ["employment type", "emp type"],
    "employment_status":   ["employee status", "employment status", "emp status"],
    "project_status":      ["project status", "allocation status", "allocation", "resourcing status"],
    "source_of_hire":      ["source of hire", "hiring source", "source"],
    "date_of_joining":     ["date of joining", "doj", "joining date"],
    "dob":                 ["date of birth", "dob", "birth date"],
    "gender":              ["gender"],
    "marital_status":      ["marital status"],
    "about_me":            ["about me", "about", "bio"],
    "reporting_manager":   ["reporting manager", "manager", "l1 manager"],
    "pan":                 ["pan", "pan number", "pan card"],
    "aadhaar":             ["aadhaar", "aadhaar number", "aadhar"],
    "work_phone":          ["work phone number", "work phone"],
    "work_phone_extension":["work phone extension", "work phone ext", "extension"],
    "pres_addr_line1":     ["address line 1(present address)", "present address line 1", "pres addr 1"],
    "pres_addr_line2":     ["address line 2(present address)", "present address line 2", "pres addr 2"],
    "pres_city":           ["city(present address)", "present city", "pres city"],
    "pres_state":          ["state(present address)", "present state", "pres state"],
    "pres_country":        ["country(present address)", "present country", "pres country"],
    "pres_zip":            ["postal code(present address)", "present postal code", "present zip", "pres zip"],
    "perm_addr_line1":     ["address line 1(permanent address)", "permanent address line 1", "perm addr 1"],
    "perm_addr_line2":     ["address line 2(permanent address)", "permanent address line 2", "perm addr 2"],
    "perm_city":           ["city(permanent address)", "permanent city", "perm city"],
    "perm_state":          ["state(permanent address)", "permanent state", "perm state"],
    "perm_country":        ["country(permanent address)", "permanent country", "perm country"],
    "perm_zip":            ["postal code(permanent address)", "permanent postal code", "permanent zip", "perm zip"],
    "personal_phone":      ["personal mobile number", "personal phone", "mobile number"],
    "personal_email":      ["personal email address", "personal email"],
    "date_of_exit":        ["date of exit", "exit date", "last working day"],
    "bank_account_holder": ["bank account holder name", "account holder name", "bank holder name"],
    "bank_account_number": ["account number", "bank account number"],
    "bank_ifsc_code":      ["ifsc code", "ifsc", "bank ifsc code", "bank ifsc"],
    "bank_name":           ["bank name"],
}

# Only the absolute minimum for a draft employee record. Format / FK / cross-field
# checks still apply to any value the admin DOES provide — see validate_row.
REQUIRED_FIELDS = ["first_name", "last_name", "work_email", "business_unit", "department", "designation", "role", "employment_type", "employment_status", "project_status", "gender", "marital_status"]

# Reporting Manager cell values that mean "no L1 manager" (matches the form's
# "Not Applicable" dropdown option). Blank is also treated as no-manager.
NO_MANAGER_VALUES = {"not applicable", "n/a", "na", "none"}

PRETTY_LABELS: dict[str, str] = {
    "first_name": "First Name",
    "last_name": "Last Name",
    "business_unit": "Business Unit",
    "work_email": "Email Address",
    "department": "Department",
    "designation": "Designation",
    "role": "Role",
    "employment_type": "Employment Type",
    "employment_status": "Employee Status",
    "project_status": "Project Status",
    "source_of_hire": "Source of Hire",
    "date_of_joining": "Date of Joining",
    "dob": "Date of Birth",
    "gender": "Gender",
    "marital_status": "Marital Status",
    "about_me": "About Me",
    "reporting_manager": "Reporting Manager",
    "pan": "PAN",
    "aadhaar": "Aadhaar",
    "work_phone": "Work Phone Number",
    "work_phone_extension": "Work Phone Extension",
    "pres_addr_line1": "Address Line 1(Present Address)",
    "pres_addr_line2": "Address Line 2(Present Address)",
    "pres_city": "City(Present Address)",
    "pres_state": "State(Present Address)",
    "pres_country": "Country(Present Address)",
    "pres_zip": "Postal Code(Present Address)",
    "perm_addr_line1": "Address Line 1(Permanent Address)",
    "perm_addr_line2": "Address Line 2(Permanent Address)",
    "perm_city": "City(Permanent Address)",
    "perm_state": "State(Permanent Address)",
    "perm_country": "Country(Permanent Address)",
    "perm_zip": "Postal Code(Permanent Address)",
    "personal_phone": "Personal Mobile Number",
    "personal_email": "Personal Email Address",
    "date_of_exit": "Date of Exit",
    "bank_account_holder": "Bank Account Holder Name",
    "bank_account_number": "Account Number",
    "bank_ifsc_code":      "IFSC Code",
    "bank_name":           "Bank Name",
}

TEMPLATE_COLUMN_ORDER = [
    # Mandatory fields first
    *REQUIRED_FIELDS,
    # Then the rest in logical grouping
    *[k for k in PRETTY_LABELS if k not in REQUIRED_FIELDS],
]

# Master data categories that need ObjectId resolution
MASTER_DATA_FIELDS: dict[str, str] = {
    "employment_type": "EMPLOYMENT_TYPES",
    "employment_status": "EMPLOYMENT_STATUSES",
    "project_status": "PROJECT_STATUSES",
    "source_of_hire": "SOURCES_OF_HIRE",
    "gender": "GENDERS",
    "marital_status": "MARITAL_STATUSES",
}


# ─── Header normalization + column map ──────────────────────────────────────

def normalize_header(raw: str) -> str:
    if raw is None:
        return ""
    s = str(raw).strip().lower()
    s = s.replace("*", "").replace(":", "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def build_column_map(headers: list[Any]) -> dict[str, int]:
    normalized = [normalize_header(h) for h in headers]
    result: dict[str, int] = {}
    for canonical, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            if alias in normalized:
                result[canonical] = normalized.index(alias)
                break
    return result


def missing_required_columns(column_map: dict[str, int]) -> list[str]:
    return [PRETTY_LABELS[f] for f in REQUIRED_FIELDS if f not in column_map]


# ─── Cell value parsing ─────────────────────────────────────────────────────

def cell_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v.is_integer():
            return str(int(v))
        return str(v)
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return str(v).strip()


def parse_date(v: Any) -> Optional[date]:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    for fmt in DATE_INPUT_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def date_status(raw: Any) -> str:
    """Classify a date cell: 'empty' | 'valid' | 'invalid'. Used to give precise errors."""
    if raw is None:
        return "empty"
    if isinstance(raw, (date, datetime)):
        return "valid"
    s = str(raw).strip()
    if not s:
        return "empty"
    return "valid" if parse_date(s) is not None else "invalid"


def split_multi(raw: Any) -> list[str]:
    """Split a multi-value cell on commas/semicolons/pipes/newlines. Trim each."""
    if raw is None:
        return []
    s = str(raw).strip()
    if not s:
        return []
    parts = re.split(r"[,;|\n]", s)
    return [p.strip() for p in parts if p.strip()]


def normalize_aadhaar(raw: str) -> str:
    """Strip spaces/dashes from Aadhaar input — admins often paste '1234 5678 9012'."""
    return re.sub(r"[\s\-]", "", raw or "")


def normalize_phone(raw: str) -> str:
    """Strip spaces/dashes/parentheses from phone — keep + and digits."""
    return re.sub(r"[\s\-()]", "", raw or "")


def normalize_md_value(raw: str) -> str:
    """Normalize a master-data value for lenient matching.

    Collapses hyphens / underscores / whitespace to a single space and lowercases,
    so 'Full Time', 'full-time', 'FULL_TIME' all match the stored 'Full-Time'.
    """
    s = (raw or "").strip().lower()
    s = re.sub(r"[\s\-_]+", " ", s)
    return s.strip()


def parse_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


EMAIL_RE      = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
EMAIL_SEARCH_RE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")  # find an email inside a larger string
PAN_RE        = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")
AADHAAR_RE    = re.compile(r"^\d{12}$")


def extract_manager_email(raw: str) -> str:
    """Pull the work email out of a Reporting Manager cell.

    The dropdown value is "Name - email", but admins may also paste a bare email.
    Returns the lowercased email, or "" if none is found.
    """
    if not raw:
        return ""
    m = EMAIL_SEARCH_RE.search(raw)
    return m.group(0).lower() if m else ""
PHONE_RE      = re.compile(r"^\+?\d{10,15}$")  # 10-15 digits, optional leading +
IFSC_RE       = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
ACCOUNT_NO_RE = re.compile(r"^\d{9,18}$")
# Most common formats first — parser tries each in order
DATE_INPUT_FORMATS = (
    "%d/%m/%Y",   # 31/12/2024  — most common in India
    "%d-%m-%Y",   # 31-12-2024
    "%Y-%m-%d",   # 2024-12-31  — ISO / Excel default
    "%m/%d/%Y",   # 12/31/2024  — US format
    "%m-%d-%Y",   # 12-31-2024
    "%d-%b-%Y",   # 31-Dec-2024
    "%d-%b-%y",   # 31-Dec-24
    "%d %b %Y",   # 31 Dec 2024
)

# Human-readable list shown in validation error messages
_DATE_FORMAT_HINT = "DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD-Mon-YYYY"


# ─── Read file (xlsx or csv) into list of rows ──────────────────────────────

def read_file_to_rows(file_bytes: bytes, filename: str) -> list[list[Any]]:
    name = (filename or "").lower()
    if name.endswith(".csv"):
        import csv
        text = file_bytes.decode("utf-8-sig")
        reader = csv.reader(io.StringIO(text))
        return [list(row) for row in reader]
    wb = load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    ws = wb.active
    rows = []
    for row in ws.iter_rows(values_only=True):
        rows.append(list(row))
    return rows


# ─── Parse a single row → canonical dict ────────────────────────────────────

def parse_row(row: list[Any], column_map: dict[str, int]) -> dict[str, Any]:
    def get(field: str) -> Any:
        idx = column_map.get(field)
        if idx is None or idx >= len(row):
            return None
        return row[idx]

    raw_doj = get("date_of_joining")
    raw_dob = get("dob")
    raw_doe = get("date_of_exit")

    return {
        "first_name": cell_str(get("first_name")),
        "last_name": cell_str(get("last_name")),
        "business_unit": cell_str(get("business_unit")),
        "work_email": cell_str(get("work_email")).lower(),
        "department": cell_str(get("department")),
        "designation": cell_str(get("designation")),
        "role": cell_str(get("role")),
        "employment_type": cell_str(get("employment_type")),
        "employment_status": cell_str(get("employment_status")),
        "project_status": cell_str(get("project_status")),
        "source_of_hire": cell_str(get("source_of_hire")) or None,
        "date_of_joining": parse_date(raw_doj),
        "_doj_status": date_status(raw_doj),
        "dob": parse_date(raw_dob),
        "_dob_status": date_status(raw_dob),
        "gender": cell_str(get("gender")),
        "marital_status": cell_str(get("marital_status")) or None,
        "about_me": cell_str(get("about_me")) or None,
        "reporting_manager": cell_str(get("reporting_manager")) or None,
        "pan": (cell_str(get("pan")) or "").upper() or None,
        "aadhaar": normalize_aadhaar(cell_str(get("aadhaar"))) or None,
        "work_phone": normalize_phone(cell_str(get("work_phone"))) or None,
        "work_phone_extension": cell_str(get("work_phone_extension")) or None,
        "pres_addr_line1": cell_str(get("pres_addr_line1")),
        "pres_addr_line2": cell_str(get("pres_addr_line2")) or None,
        "pres_city": cell_str(get("pres_city")),
        "pres_state": cell_str(get("pres_state")),
        "pres_country": cell_str(get("pres_country")),
        "pres_zip": cell_str(get("pres_zip")) or None,
        "perm_addr_line1": cell_str(get("perm_addr_line1")),
        "perm_addr_line2": cell_str(get("perm_addr_line2")) or None,
        "perm_city": cell_str(get("perm_city")),
        "perm_state": cell_str(get("perm_state")),
        "perm_country": cell_str(get("perm_country")),
        "perm_zip": cell_str(get("perm_zip")) or None,
        "personal_phone": normalize_phone(cell_str(get("personal_phone"))) or None,
        "personal_email": (cell_str(get("personal_email")) or "").lower() or None,
        "date_of_exit": parse_date(raw_doe),
        "_doe_status": date_status(raw_doe),
        "bank_account_holder": cell_str(get("bank_account_holder")) or None,
        "bank_account_number": cell_str(get("bank_account_number")) or None,
        "bank_ifsc_code": (cell_str(get("bank_ifsc_code")) or "").upper() or None,
        "bank_name": cell_str(get("bank_name")) or None,
    }


def row_is_empty(parsed: dict[str, Any]) -> bool:
    return not parsed.get("work_email") and not parsed.get("first_name") and not parsed.get("last_name")


# ─── Validate a parsed row ──────────────────────────────────────────────────

def validate_row(
    parsed: dict[str, Any],
    bu_name_to_id: dict[str, str],
    dept_name_to_bu_ids: dict[str, list[str]],
    dept_name_to_id: dict[str, str],
    desg_name_to_id: dict[str, str],
    role_name_to_id: dict[str, str],
    md_maps: dict[str, dict[str, str]],
    manager_lookup: dict[str, str],
    country_names_lower: set[str],
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    """Return (errors, enriched_parsed) — enriched has resolved FK IDs.

    `manager_lookup` is keyed by work email only (lowercased) — names are ambiguous.
    """
    errors: list[dict[str, str]] = []
    add = lambda f, m: errors.append({"field": f, "message": m})

    # ─── Required-field presence ─────────────────────────────────────────────────
    for field in REQUIRED_FIELDS:
        if not parsed.get(field):
            add(field, f"{PRETTY_LABELS[field]} is required")

    # ─── Date validation: only flag invalid formats; absence is allowed ────────
    for field, status_key in (
        ("date_of_joining", "_doj_status"),
        ("dob",             "_dob_status"),
        ("date_of_exit",    "_doe_status"),
    ):
        if parsed.get(status_key) == "invalid":
            add(field, f"{PRETTY_LABELS[field]} has an unrecognized date format. Accepted formats: {_DATE_FORMAT_HINT}")

    # ─── Cross-date sanity ──────────────────────────────────────────────────────
    today = date.today()
    if parsed.get("dob") and parsed["dob"] >= today:
        add("dob", "Date of Birth must be in the past")
    if parsed.get("date_of_joining") and parsed["date_of_joining"] > today:
        add("date_of_joining", "Date of Joining cannot be in the future")
    if parsed.get("date_of_joining") and parsed.get("date_of_exit"):
        if parsed["date_of_exit"] < parsed["date_of_joining"]:
            add("date_of_exit", "Date of Exit cannot be before Date of Joining")

    # ─── Email format ───────────────────────────────────────────────────────────
    work_email = parsed.get("work_email")
    if work_email and not EMAIL_RE.match(work_email):
        add("work_email", "Invalid work email format")

    pers_email = parsed.get("personal_email")
    if pers_email and not EMAIL_RE.match(pers_email):
        add("personal_email", "Invalid personal email format")
    if work_email and pers_email and work_email == pers_email:
        add("personal_email", "Personal email must be different from work email")

    # ─── Phone format ──────────────────────────────────────────────────────────
    if parsed.get("personal_phone") and not PHONE_RE.match(parsed["personal_phone"]):
        add("personal_phone", "Personal phone must be 10–15 digits")
    if parsed.get("work_phone") and not PHONE_RE.match(parsed["work_phone"]):
        add("work_phone", "Work phone must be 10–15 digits")

    # ─── Identity formats ──────────────────────────────────────────────────────
    if parsed.get("pan") and not PAN_RE.match(parsed["pan"]):
        add("pan", "PAN must be in format ABCDE1234F")
    if parsed.get("aadhaar") and not AADHAAR_RE.match(parsed["aadhaar"]):
        add("aadhaar", "Aadhaar must be 12 digits")

    # ─── BU / Dept / Designation name resolution ───────────────────────────────
    bu_id, dept_id, desg_id = None, None, None

    bu_key = (parsed.get("business_unit") or "").lower().strip()
    if bu_key:
        bu_id = bu_name_to_id.get(bu_key)
        if not bu_id:
            add("business_unit", f"Business Unit '{parsed['business_unit']}' not found or inactive")

    dept_key = (parsed.get("department") or "").lower().strip()
    if dept_key:
        dept_id = dept_name_to_id.get(dept_key)
        if not dept_id:
            add("department", f"Department '{parsed['department']}' not found or inactive")
        elif bu_id and bu_id not in dept_name_to_bu_ids.get(dept_key, []):
            add("department", f"Department '{parsed['department']}' is not under Business Unit '{parsed['business_unit']}'")

    desg_key = (parsed.get("designation") or "").lower().strip()
    if desg_key:
        # Designations are org-level now — resolve by name within the org;
        # they are no longer scoped to a department.
        desg_id = desg_name_to_id.get(desg_key)
        if not desg_id:
            add("designation", f"Designation '{parsed['designation']}' not found or inactive")

    role_id = None
    role_key = (parsed.get("role") or "").lower().strip()
    if role_key:
        role_id = role_name_to_id.get(role_key)
        if not role_id:
            add("role", f"Role '{parsed['role']}' not found or inactive")

    # ─── Bank details validation (optional fields, format-only) ───────────────
    acct = parsed.get("bank_account_number")
    ifsc = parsed.get("bank_ifsc_code")
    if acct and not ACCOUNT_NO_RE.match(acct):
        add("bank_account_number", "Account number must be 9–18 digits")
    if ifsc and not IFSC_RE.match(ifsc):
        add("bank_ifsc_code", "IFSC code must be in format ABCD0123456 (e.g. SBIN0001234)")
    if acct and not ifsc:
        add("bank_ifsc_code", "IFSC code is required when account number is provided")
    if ifsc and not acct:
        add("bank_account_number", "Account number is required when IFSC code is provided")

    # ─── Country validation ────────────────────────────────────────────────────
    for prefix, label_prefix in (("pres", "Present Address"), ("perm", "Permanent Address")):
        country = (parsed.get(f"{prefix}_country") or "").strip()
        if country and country.lower() not in country_names_lower:
            add(f"{prefix}_country", f"Country '{country}' is not recognized in {label_prefix}")

    # ─── Master data resolution (value → ObjectId) ─────────────────────────────
    resolved_md: dict[str, Optional[str]] = {}
    for field, category in MASTER_DATA_FIELDS.items():
        raw = (parsed.get(field) or "").strip()
        if not raw:
            resolved_md[f"{field}_id"] = None
            continue
        md_id = md_maps.get(category, {}).get(normalize_md_value(raw))
        if md_id:
            resolved_md[f"{field}_id"] = md_id
        else:
            resolved_md[f"{field}_id"] = None
            if field in REQUIRED_FIELDS:
                add(field, f"'{raw}' not found in {PRETTY_LABELS[field]} options")

    # ─── Reporting Manager → L1 (matched by work EMAIL only) ──────────────────
    # Names are ambiguous (duplicates), so only the manager's work email resolves.
    # Blank or an explicit "Not Applicable" / "N/A" means the employee has no L1
    # manager (e.g. the org head) — mirrors the "Not Applicable" option in the form.
    l1_manager_id = None
    mgr_raw = (parsed.get("reporting_manager") or "").strip()
    if mgr_raw and mgr_raw.lower() not in NO_MANAGER_VALUES:
        mgr_email = extract_manager_email(mgr_raw)
        l1_manager_id = manager_lookup.get(mgr_email) if mgr_email else None
        if not l1_manager_id:
            add("reporting_manager", f"Manager '{mgr_raw}' not found (pick from the dropdown or enter the manager's work email, or 'Not Applicable')")

    # Roles are derived from the designation — any Policies column in the sheet
    # is ignored (kept only for backward-compatible template layout).
    enriched = {
        **parsed,
        "business_unit_id": bu_id,
        "department_id": dept_id,
        "designation_id": desg_id,
        "role_id": role_id,
        "l1_manager_id": l1_manager_id,
        **resolved_md,
    }
    return errors, enriched


# ─── Template builder ───────────────────────────────────────────────────────

def build_template_xlsx(
    bu_names: list[str],
    dept_names: list[str],
    desg_names: list[str],
    role_names: list[str],
    country_names: list[str],
    emp_labels: list[str],
    md_options: dict[str, list[str]],
    bu_to_depts: Optional[dict[str, list[str]]] = None,
    state_names: Optional[list[str]] = None,
    city_names: Optional[list[str]] = None,
) -> bytes:
    """Return xlsx bytes with headers + dropdowns from org data + master data.

    `emp_labels` is a list of manager work emails (the manager dropdown values).

    When `bu_to_depts` is provided, the Department column cascades from the BU
    selection. Designations are org-level → a flat dropdown.
    """
    wb = Workbook()
    ws = wb.active
    ws.title = "EmployeeUpload"

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="366092")
    required_fill = PatternFill("solid", fgColor="244062")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for col_idx, canonical in enumerate(TEMPLATE_COLUMN_ORDER, start=1):
        label = PRETTY_LABELS[canonical]
        is_required = canonical in REQUIRED_FIELDS
        if is_required:
            label = f"{label} *"
        cell = ws.cell(row=1, column=col_idx, value=label)
        cell.font = header_font
        cell.fill = required_fill if is_required else header_fill
        cell.alignment = center
        ws.column_dimensions[get_column_letter(col_idx)].width = max(len(label) + 4, 18)

    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 28

    # Instructions row (row 2) — gets overwritten if user starts at row 2; recommend they start row 3
    notes = {
        "aadhaar": "12 digits",
        "pan": "ABCDE1234F",
        "personal_phone": "10-15 digits",
        "reporting_manager": "Work email, or 'Not Applicable'",
        "date_of_joining": "DD/MM/YYYY",
        "dob": "DD/MM/YYYY",
        "date_of_exit": "DD/MM/YYYY",
    }

    # Hidden reference sheet for large dropdown lists
    ref = wb.create_sheet("_REF")
    ref.sheet_state = "hidden"

    # Reporting Manager dropdown: lead with "Not Applicable" (no L1 manager),
    # then the actual employees — mirrors the form's manager dropdown.
    mgr_labels = ["Not Applicable", *emp_labels]

    ref_columns: list[tuple[str, list[str]]] = [
        ("A", bu_names),
        ("B", dept_names),
        ("C", desg_names),
        ("D", country_names),
        ("E", mgr_labels),
        ("F", md_options.get("EMPLOYMENT_TYPES", [])),
        ("G", md_options.get("EMPLOYMENT_STATUSES", [])),
        ("H", md_options.get("SOURCES_OF_HIRE", [])),
        ("I", md_options.get("GENDERS", [])),
        ("J", md_options.get("MARITAL_STATUSES", [])),
        ("K", md_options.get("PROJECT_STATUSES", [])),
        ("O", role_names or []),
        ("L", state_names or []),
        ("Q", city_names or []),
    ]

    for col_letter, values in ref_columns:
        col_num = ord(col_letter) - ord("A") + 1
        for i, v in enumerate(values, start=1):
            ref.cell(row=i, column=col_num, value=v)

    def add_ref_dropdown(col_canonical: str, ref_col: str, count: int, allow_freeform: bool = False):
        if count == 0 or col_canonical not in TEMPLATE_COLUMN_ORDER:
            return
        col_idx = TEMPLATE_COLUMN_ORDER.index(col_canonical) + 1
        letter = get_column_letter(col_idx)
        formula = f"=_REF!${ref_col}$1:${ref_col}${count}"
        dv = DataValidation(
            type="list",
            formula1=formula,
            allow_blank=True,
            showErrorMessage=not allow_freeform,
        )
        dv.error = "Pick a value from the dropdown"
        ws.add_data_validation(dv)
        dv.add(f"{letter}2:{letter}1001")

    # Department still cascades from BU; designations are org-level (flat).
    use_cascading = bool(bu_to_depts)

    # BU always uses flat dropdown
    add_ref_dropdown("business_unit", "A", len(bu_names))

    if use_cascading:
        # ── BU → Dept lookup table in _REF columns M, N ──
        for i, bu_name in enumerate(bu_names, start=1):
            ref.cell(row=i, column=13, value=bu_name)
            ref.cell(row=i, column=14, value=i)

        # ── Hidden sheet: one column per BU with its departments ──
        bu_dept_ws = wb.create_sheet("_BU_DEPTS")
        bu_dept_ws.sheet_state = "hidden"
        for col_idx, bu_name in enumerate(bu_names, start=1):
            depts_for_bu = bu_to_depts.get(bu_name, [])
            for row_idx, d_name in enumerate(depts_for_bu, start=1):
                bu_dept_ws.cell(row=row_idx, column=col_idx, value=d_name)
            if depts_for_bu:
                cl = get_column_letter(col_idx)
                dn = DefinedName(name=f"BU_{col_idx}",
                                 attr_text=f"'_BU_DEPTS'!${cl}$1:${cl}${len(depts_for_bu)}")
                wb.defined_names.add(dn)

        # ── Cascading data validation for Department (based on BU) ──
        bu_col_letter = get_column_letter(TEMPLATE_COLUMN_ORDER.index("business_unit") + 1)
        dept_col_letter = get_column_letter(TEMPLATE_COLUMN_ORDER.index("department") + 1)
        dept_formula = (
            f'=INDIRECT("BU_"&VLOOKUP({bu_col_letter}2,'
            f"_REF!$M$1:$N${len(bu_names)},2,FALSE))"
        )
        dv_dept = DataValidation(type="list", formula1=dept_formula,
                                 allow_blank=True, showErrorMessage=False)
        ws.add_data_validation(dv_dept)
        dv_dept.add(f"{dept_col_letter}2:{dept_col_letter}1001")

        # Designations are org-level now → flat dropdown (not cascaded by dept).
        add_ref_dropdown("designation", "C", len(desg_names))
    else:
        add_ref_dropdown("department", "B", len(dept_names))
        add_ref_dropdown("designation", "C", len(desg_names))

    add_ref_dropdown("pres_country",      "D", len(country_names))
    add_ref_dropdown("perm_country",      "D", len(country_names))
    add_ref_dropdown("reporting_manager", "E", len(mgr_labels))
    add_ref_dropdown("employment_type",   "F", len(md_options.get("EMPLOYMENT_TYPES", [])))
    add_ref_dropdown("employment_status", "G", len(md_options.get("EMPLOYMENT_STATUSES", [])))
    add_ref_dropdown("project_status",    "K", len(md_options.get("PROJECT_STATUSES", [])))
    add_ref_dropdown("role",              "O", len(role_names or []))
    add_ref_dropdown("source_of_hire",    "H", len(md_options.get("SOURCES_OF_HIRE", [])))
    add_ref_dropdown("gender",            "I", len(md_options.get("GENDERS", [])))
    add_ref_dropdown("marital_status",    "J", len(md_options.get("MARITAL_STATUSES", [])))
    add_ref_dropdown("pres_state",        "L", len(state_names or []), allow_freeform=True)
    add_ref_dropdown("perm_state",        "L", len(state_names or []), allow_freeform=True)
    add_ref_dropdown("pres_city",         "Q", len(city_names or []), allow_freeform=True)
    add_ref_dropdown("perm_city",         "Q", len(city_names or []), allow_freeform=True)

    # Header tooltips for format hints
    for canonical, hint in notes.items():
        if canonical not in TEMPLATE_COLUMN_ORDER:
            continue
        col_idx = TEMPLATE_COLUMN_ORDER.index(canonical) + 1
        cell = ws.cell(row=1, column=col_idx)
        cell.comment = Comment(f"Format: {hint}", "System")

    # Format date columns as text so Excel doesn't reinterpret DD/MM as MM/DD
    for date_col in ("date_of_joining", "dob", "date_of_exit"):
        if date_col not in TEMPLATE_COLUMN_ORDER:
            continue
        col_idx = TEMPLATE_COLUMN_ORDER.index(date_col) + 1
        col_letter = get_column_letter(col_idx)
        for row_num in range(2, 1002):
            ws[f"{col_letter}{row_num}"].number_format = "@"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
