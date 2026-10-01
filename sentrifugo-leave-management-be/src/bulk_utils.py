import csv
import io
import re
from typing import Optional

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side


HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
HEADER_FILL = PatternFill("solid", fgColor="366092")
HEADER_ALIGNMENT = Alignment(horizontal="center", vertical="center", wrap_text=True)
THIN_BORDER = Border(
    bottom=Side(style="thin", color="D9D9D9"),
)


def _style_worksheet(ws, columns: list[dict]):
    """Apply consistent styling to a worksheet with column definitions.
    Each column dict: {"header": str, "width": int}
    """
    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 30
    for col_idx, col in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col_idx, value=col["header"])
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = HEADER_ALIGNMENT
        ws.column_dimensions[chr(64 + col_idx)].width = col.get("width", 20)


def generate_employee_template_xlsx() -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Employees"
    _style_worksheet(ws, [
        {"header": "Work Email", "width": 35},
        {"header": "Employee Code", "width": 20},
    ])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def generate_shift_template_xlsx(
    employees: list[dict], shift_names: list[str],
) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "ShiftAssignments"
    _style_worksheet(ws, [
        {"header": "Employee Code", "width": 20},
        {"header": "Employee Name", "width": 30},
        {"header": "Shift Name", "width": 25},
    ])
    for i, emp in enumerate(employees, start=2):
        ws.cell(row=i, column=1, value=emp.get("emp_code", ""))
        name_cell = ws.cell(row=i, column=2, value=emp.get("name", ""))
        name_cell.font = Font(color="808080")
        ws.cell(row=i, column=3, value=emp.get("shift_name", ""))

    if shift_names:
        from openpyxl.worksheet.datavalidation import DataValidation
        ref = wb.create_sheet("_REF")
        ref.sheet_state = "hidden"
        for idx, name in enumerate(shift_names, start=1):
            ref.cell(row=idx, column=1, value=name)
        dv = DataValidation(
            type="list",
            formula1=f"=_REF!$A$1:$A${len(shift_names)}",
            allow_blank=True,
            showErrorMessage=True,
        )
        dv.error = "Pick a shift from the dropdown"
        dv.errorTitle = "Invalid Shift"
        ws.add_data_validation(dv)
        dv.add(f"C2:C{max(len(employees) + 1, 1001)}")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def generate_csv_template() -> bytes:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["work_email", "emp_code"])
    return output.getvalue().encode("utf-8")


def _resolve_employee_columns(fieldnames: list[str]) -> tuple[str | None, str | None]:
    header_map = {h.strip().lower().replace(" ", "_"): h for h in fieldnames}
    email_col = (
        header_map.get("work_email")
        or header_map.get("email")
        or header_map.get("mail")
        or header_map.get("email_address")
    )
    code_col = (
        header_map.get("emp_code")
        or header_map.get("employee_code")
        or header_map.get("empcode")
        or header_map.get("employee_id")
    )
    return email_col, code_col


def _parse_xlsx_rows(file_bytes: bytes) -> list[dict]:
    """Parse XLSX and extract rows as dicts keyed by normalised header names."""
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    try:
        raw_headers = next(rows_iter)
    except StopIteration:
        return []
    headers = [str(h).strip() if h else "" for h in raw_headers]
    result = []
    for row in rows_iter:
        d = {headers[i]: (str(row[i]).strip() if row[i] is not None else "") for i in range(len(headers))}
        result.append(d)
    return result


def _is_xlsx(file_bytes: bytes) -> bool:
    return file_bytes[:4] == b"PK\x03\x04"


def parse_employee_rows(file_bytes: bytes) -> list[dict]:
    """Parse an uploaded employee template (CSV or XLSX) and extract the
    work_email and emp_code columns.

    The function inspects the file's magic bytes — xlsx files start with the
    ZIP signature (``PK\\x03\\x04``) — and dispatches to the xlsx parser when
    needed; otherwise it falls back to a UTF-8 CSV reader.

    Returns a list of dicts with ``email`` and ``emp_code`` keys.
    """
    if _is_xlsx(file_bytes):
        raw_rows = _parse_xlsx_rows(file_bytes)
        if not raw_rows:
            return []
        fieldnames = list(raw_rows[0].keys())
        email_col, code_col = _resolve_employee_columns(fieldnames)
        if not email_col and not code_col:
            return []
        rows = []
        for row in raw_rows:
            email = (row.get(email_col, "") if email_col else "").strip()
            emp_code = (row.get(code_col, "") if code_col else "").strip()
            if email or emp_code:
                rows.append({"email": email, "emp_code": emp_code})
        return rows

    try:
        text = file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        # Distinguish "couldn't decode" from "blank file" — without this the
        # caller treats both as empty and surfaces a misleading
        # "No data found" error. A wrong-encoding upload (e.g. UTF-16) deserves
        # a clear, actionable message instead.
        from fastapi import status as _status
        from src.exceptions import DomainException
        raise DomainException(
            message=(
                "Unable to decode file as UTF-8. "
                "Re-save the file as UTF-8 CSV or upload an XLSX."
            ),
            code="INVALID_FILE_ENCODING",
            status_code=_status.HTTP_400_BAD_REQUEST,
        )

    reader = csv.DictReader(io.StringIO(text))

    if not reader.fieldnames:
        return []
    email_col, code_col = _resolve_employee_columns(list(reader.fieldnames))

    if not email_col and not code_col:
        return []

    rows = []
    for row in reader:
        email = (row.get(email_col, "") if email_col else "").strip()
        emp_code = (row.get(code_col, "") if code_col else "").strip()
        if email or emp_code:
            rows.append({"email": email, "emp_code": emp_code})
    return rows


EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


async def find_cross_scope_conflicts(
    db: AsyncIOMotorDatabase,
    *,
    collection: str,
    scope_field: str,
    scope_value: ObjectId,
    user_oids: list,
    scope_name_collection: str,
    scope_label: str,
    org_id,
) -> set:
    """Return the set of user_oids that are already assigned to another scope.

    This is the non-throwing counterpart of ``assert_no_cross_scope_assignment``.
    Use it in *add* (bulk-upload) paths where conflicting employees should be
    silently skipped rather than failing the entire batch.
    """
    from src.utils import to_oid

    if not user_oids:
        return set()

    match_uids = list(user_oids) + [str(x) for x in user_oids]
    # Step 1: find OTHER-scope assignments for these users.
    conflicts = await db[collection].find({
        scope_field: {"$ne": scope_value},
        "user_id": {"$in": match_uids},
        "deleted_on": None,
    }).to_list(length=None)
    if not conflicts:
        return set()

    # Step 2: tenant-scope — keep only conflicts where the other scope belongs
    # to the caller's org (cross-tenant hits are not our concern).
    other_scope_ids = list({c[scope_field] for c in conflicts})
    org_match = [org_id, str(org_id)] if org_id else None
    name_query: dict = {"_id": {"$in": other_scope_ids}}
    if org_match:
        name_query["org_id"] = {"$in": org_match}
    name_docs = await db[scope_name_collection].find(name_query).to_list(length=None)
    same_org_scope_ids = {d["_id"] for d in name_docs}

    same_org_conflicts = [c for c in conflicts if c[scope_field] in same_org_scope_ids]
    if not same_org_conflicts:
        return set()

    # Build the set of conflicting user_oids (normalised to ObjectId)
    return {to_oid(c["user_id"]) for c in same_org_conflicts}


async def assert_no_cross_scope_assignment(
    db: AsyncIOMotorDatabase,
    *,
    collection: str,
    scope_field: str,
    scope_value: ObjectId,
    user_oids: list,
    scope_name_collection: str,
    scope_label: str,
    org_id,
) -> None:
    """Raise DomainException if any user_oid has an active assignment in a
    DIFFERENT scope of the given collection — scoped to the caller's org.

    Enforces the product rule: each employee may be assigned to only one
    holiday plan / work calendar / shift calendar at a time. Use this as a
    defensive guard in service write paths (add/sync) so invalid data can
    never be written even if the FE skipped the bulk-validate step.

    ``org_id`` is required so that in a multi-tenant deployment we never
    cross-reference assignments belonging to a different organisation.
    """
    from src.utils import to_oid
    from src.exceptions import DomainException
    from fastapi import status

    if not user_oids:
        return
    match_uids = list(user_oids) + [str(x) for x in user_oids]
    # Step 1: find OTHER-scope assignments for these users. Don't filter by
    # org_id on the assignment collection — legacy rows may lack the field.
    conflicts = await db[collection].find({
        scope_field: {"$ne": scope_value},
        "user_id": {"$in": match_uids},
        "deleted_on": None,
    }).to_list(length=None)
    if not conflicts:
        return

    # Step 2: tenant-scope by looking up the conflicting scopes (plans /
    # calendars always have org_id) and keeping only those that belong to
    # the caller's org. Cross-tenant hits get filtered out here.
    other_scope_ids = list({c[scope_field] for c in conflicts})
    org_match = [org_id, str(org_id)] if org_id else None
    name_query: dict = {"_id": {"$in": other_scope_ids}}
    if org_match:
        name_query["org_id"] = {"$in": org_match}
    name_docs = await db[scope_name_collection].find(name_query).to_list(length=None)
    same_org_scope_ids = {d["_id"] for d in name_docs}
    name_by_id = {d["_id"]: d.get("name") for d in name_docs}

    same_org_conflicts = [c for c in conflicts if c[scope_field] in same_org_scope_ids]
    if not same_org_conflicts:
        return  # The only conflicts were in other tenants — not our concern.

    # Build a per-user list of conflicting scope names (current tenant only)
    by_user: dict = {}
    for c in same_org_conflicts:
        uid_norm = to_oid(c["user_id"])
        by_user.setdefault(uid_norm, set()).add(
            name_by_id.get(c[scope_field], f"unknown {scope_label}")
        )

    # Resolve human-readable labels (name + emp_code) for the conflicting users
    # so the error message is actionable instead of just a list of ObjectIds.
    conflict_uids = list(by_user.keys())
    uid_match = list(conflict_uids) + [str(x) for x in conflict_uids]
    emp_docs = await db["employees"].find(
        {"user_id": {"$in": uid_match}, "is_deleted": {"$ne": True}},
        {"user_id": 1, "name": 1, "first_name": 1, "last_name": 1, "emp_code": 1},
    ).to_list(length=None)
    label_by_uid: dict = {}
    for e in emp_docs:
        u_norm = to_oid(e.get("user_id"))
        name = (
            e.get("name")
            or f"{e.get('first_name', '') or ''} {e.get('last_name', '') or ''}".strip()
        ).strip()
        code = e.get("emp_code") or ""
        if name and code:
            label_by_uid[u_norm] = f"{name} ({code})"
        elif name:
            label_by_uid[u_norm] = name
        elif code:
            label_by_uid[u_norm] = code

    # Build a readable error message: prefer "Name (emp_code)" → "Name" → "emp_code" → fall back to user id
    parts = [
        f"{label_by_uid.get(uid, f'user {uid}')} is already assigned to "
        f"{scope_label} {', '.join(repr(n) for n in sorted(names))}"
        for uid, names in by_user.items()
    ]
    raise DomainException(
        message=(
            f"Cannot assign — each employee may belong to only one {scope_label}. "
            + "; ".join(parts)
            + ". Remove the existing assignment first."
        ),
        code=f"ALREADY_ASSIGNED_TO_ANOTHER_{scope_label.upper().replace(' ', '_')}",
        status_code=status.HTTP_409_CONFLICT,
    )


async def validate_bulk_rows(
    db: AsyncIOMotorDatabase,
    parsed_rows: list[dict],
    eligible_dept_ids: list[ObjectId],
    assigned_collection: str,
    assigned_id_field: str,
    assigned_id_value: ObjectId,
    *,
    scope_name_collection: str | None = None,
    scope_label: str = "scope",
    org_id=None,
) -> dict:
    """Validate parsed rows for bulk assignment. When ``org_id`` is supplied,
    the same-scope and cross-scope lookups are tenant-scoped — important for
    multi-tenant deployments where the same collection holds rows for many
    organisations.
    """
    from src.utils import to_oid

    # Tenant scoping: don't filter the assignment collection by org_id (legacy
    # rows may lack the field). Filter by org via the scope_name collection
    # (plans/calendars always have org_id) which is what we look up to resolve
    # the conflicting scope's name anyway.
    org_match = [org_id, str(org_id)] if org_id else None

    same_scope_query: dict = {assigned_id_field: assigned_id_value, "deleted_on": None}
    existing_docs = await db[assigned_collection].find(same_scope_query).to_list(length=None)
    # Canonical user_id form is ObjectId; normalize when building the set so
    # "already-assigned" detection works regardless of how legacy rows are stored.
    existing_user_ids = {to_oid(doc["user_id"]) for doc in existing_docs}

    # Pre-compute cross-scope assignments — users already in a DIFFERENT scope
    # of the same collection (other plan / other calendar). Keep only conflicts
    # where the OTHER scope is in the same org as the caller (cross-tenant
    # hits get filtered out).
    cross_scope_by_user: dict = {}
    if scope_name_collection:
        other_docs = await db[assigned_collection].find({
            assigned_id_field: {"$ne": assigned_id_value},
            "deleted_on": None,
        }).to_list(length=None)
        if other_docs:
            other_scope_ids = list({d[assigned_id_field] for d in other_docs})
            name_query: dict = {"_id": {"$in": other_scope_ids}}
            if org_match:
                name_query["org_id"] = {"$in": org_match}
            name_docs = await db[scope_name_collection].find(name_query).to_list(length=None)
            same_org_scope_ids = {d["_id"] for d in name_docs}
            name_by_id = {d["_id"]: d.get("name", "(unnamed)") for d in name_docs}
            for d in other_docs:
                if d[assigned_id_field] not in same_org_scope_ids:
                    continue  # skip cross-tenant hits
                uid_norm = to_oid(d["user_id"])
                cross_scope_by_user.setdefault(uid_norm, set()).add(
                    name_by_id.get(d[assigned_id_field], "(unknown)")
                )

    dept_name_map = {}
    if eligible_dept_ids:
        dept_docs = await db["departments"].find(
            {"_id": {"$in": eligible_dept_ids}}
        ).to_list(length=None)
        dept_name_map = {
            doc["_id"]: doc.get("name", str(doc["_id"])) for doc in dept_docs
        }

    rows = []
    seen_emails: set[str] = set()
    seen_codes: set[str] = set()
    valid_count = 0
    error_count = 0
    duplicate_count = 0

    for i, parsed in enumerate(parsed_rows):
        row_num = i + 1
        email = parsed.get("email", "").strip().lower()
        emp_code = parsed.get("emp_code", "").strip()
        errors: list[str] = []

        if not email and not emp_code:
            errors.append("Both email and employee code are empty")
            rows.append(_row(row_num, email, emp_code, "error", errors=errors))
            error_count += 1
            continue

        if email and not EMAIL_RE.match(email):
            errors.append("Invalid email format")
            rows.append(_row(row_num, email, emp_code, "error", errors=errors))
            error_count += 1
            continue

        # Intra-file duplicate
        if (email and email in seen_emails) or (emp_code and emp_code.lower() in seen_codes):
            errors.append("Duplicate entry in file")
            rows.append(_row(row_num, email, emp_code, "error", errors=errors))
            error_count += 1
            continue
        if email:
            seen_emails.add(email)
        if emp_code:
            seen_codes.add(emp_code.lower())

        # Lookup: email → users.email / employees.work_email, emp_code → employees.emp_code
        user_doc: Optional[dict] = None
        employee: Optional[dict] = None

        # Step 1: Resolve user from email — try users.email, then users.work_email
        if email:
            email_regex = re.compile(f"^{re.escape(email)}$", re.IGNORECASE)
            user_doc = await db["users"].find_one(
                {"email": email_regex, "is_deleted": {"$ne": True}}
            )
            if not user_doc:
                user_doc = await db["users"].find_one(
                    {"work_email": email_regex, "is_deleted": {"$ne": True}}
                )

        # Step 2: Resolve employee from emp_code
        if emp_code:
            employee = await db["employees"].find_one({
                "emp_code": re.compile(f"^{re.escape(emp_code)}$", re.IGNORECASE),
                "is_deleted": {"$ne": True},
            })

        # Step 3: If email found a user but no employee yet, find employee by user_id
        if user_doc and not employee:
            employee = await db["employees"].find_one({
                "user_id": user_doc["_id"],
                "is_deleted": {"$ne": True},
            })

        # Step 4: If no user and no employee found by emp_code, try employees.work_email
        if email and not employee:
            employee = await db["employees"].find_one({
                "work_email": re.compile(f"^{re.escape(email)}$", re.IGNORECASE),
                "is_deleted": {"$ne": True},
            })

        # Step 5: If we have employee but no user, resolve user from employee.user_id
        if employee and not user_doc:
            emp_user_id = employee.get("user_id")
            if emp_user_id:
                user_doc = await db["users"].find_one({
                    "_id": emp_user_id,
                    "is_deleted": {"$ne": True},
                })

        if not employee:
            errors.append("Employee not found in system")
            rows.append(_row(row_num, email, emp_code, "error", errors=errors))
            error_count += 1
            continue

        # Step 6: If both email and emp_code provided, verify they resolve to the same employee
        if email and emp_code and user_doc and employee:
            emp_user_id = employee.get("user_id")
            if emp_user_id and user_doc["_id"] != emp_user_id:
                errors.append("Email and employee code belong to different employees")
                rows.append(_row(row_num, email, emp_code, "error", errors=errors))
                error_count += 1
                continue

        # Resolve user_id — employee.user_id is authoritative, user_doc._id as fallback
        user_id = employee.get("user_id") or (user_doc["_id"] if user_doc else None)
        if not user_id:
            errors.append("Cannot resolve user identity for this employee")
            rows.append(_row(row_num, email, emp_code, "error", errors=errors))
            error_count += 1
            continue

        name = (
            employee.get("name")
            or f"{employee.get('first_name', '')} {employee.get('last_name', '')}".strip()
            or (f"{user_doc.get('first_name', '')} {user_doc.get('last_name', '')}".strip() if user_doc else "")
            or None
        )
        resolved_code = employee.get("emp_code") or emp_code
        emp_dept_id = employee.get("department_id")
        dept_name = dept_name_map.get(emp_dept_id) if emp_dept_id else None

        if emp_dept_id and not dept_name:
            dept_doc = await db["departments"].find_one({"_id": emp_dept_id})
            if dept_doc:
                dept_name = dept_doc.get("name", str(emp_dept_id))

        if eligible_dept_ids and emp_dept_id and emp_dept_id not in eligible_dept_ids:
            errors.append(f"Employee belongs to '{dept_name or 'unknown'}' which is not part of this plan")
            rows.append(_row(row_num, email, resolved_code, "error", user_id=user_id, name=name, department=dept_name, errors=errors))
            error_count += 1
            continue

        # Cross-scope check first (different plan / calendar than the one being uploaded).
        # If the employee is already in some OTHER scope, that's an error the
        # admin must resolve before they can be assigned here.
        user_oid = to_oid(user_id)
        if user_oid and user_oid in cross_scope_by_user:
            other_names = sorted(cross_scope_by_user[user_oid])
            errors.append(
                f"Already assigned to another {scope_label}: {', '.join(repr(n) for n in other_names)}"
                f" — remove them from there first"
            )
            rows.append(_row(row_num, email, resolved_code, "error", user_id=user_id, name=name, department=dept_name, errors=errors))
            error_count += 1
            continue

        # Same-scope duplicate (already in THIS plan/calendar — no-op on save).
        if user_oid and user_oid in existing_user_ids:
            rows.append(_row(row_num, email, resolved_code, "duplicate", user_id=user_id, name=name, department=dept_name, errors=["Already assigned"]))
            duplicate_count += 1
            continue

        rows.append(_row(row_num, email, resolved_code, "valid", user_id=user_id, name=name, department=dept_name))
        valid_count += 1

    return {
        "total_rows": len(parsed_rows),
        "valid_count": valid_count,
        "error_count": error_count,
        "duplicate_count": duplicate_count,
        "rows": rows,
    }


def _row(
    row_num: int, email: str, emp_code: str, status: str, *,
    user_id=None, name=None, department=None, errors: list[str] | None = None,
) -> dict:
    return {
        "row_num": row_num,
        "email": email,
        "emp_code": emp_code,
        "status": status,
        "user_id": str(user_id) if user_id else None,
        "name": name,
        "department": department,
        "errors": errors or [],
    }
