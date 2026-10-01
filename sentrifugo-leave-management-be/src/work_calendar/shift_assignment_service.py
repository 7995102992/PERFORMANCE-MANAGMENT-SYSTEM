import asyncio
import csv
import io

from fastapi import status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import InsertOne, UpdateOne

from src.audit import emit_activity, emit_audit
from src.bulk_utils import (
    assert_no_cross_scope_assignment,
    generate_shift_template_xlsx,
    _is_xlsx,
    _parse_xlsx_rows,
)
from src.employee_enrichment import apply_details, enrich_user_details
from src.exceptions import DomainException
from src.logger import logger
from src.messaging import email_events
from src.models import audit_fields_create, audit_fields_delete, audit_fields_update
from src.utils import to_oid
from src.work_calendar.service import (
    CALENDAR_COLLECTION,
    EMP_MAP_COLLECTION,
    _assert_calendar_active,
)
from src.work_calendar.shifts_service import SHIFT_COLLECTION, _get_calendar_or_raise

SHIFT_ASSIGNMENT_COLLECTION = "work_calendar_shift_assignments"
SCOPE_LABEL = "work calendar shift"


async def _get_shift_or_raise(db: AsyncIOMotorDatabase, shift_id: str, calendar_id: str) -> dict:
    doc = await db[SHIFT_COLLECTION].find_one(
        {"_id": shift_id, "calendar_id": calendar_id, "deleted_on": None}
    )
    if not doc:
        # Resolve the name loosely so the user sees it instead of a raw ID.
        shift_doc = await db[SHIFT_COLLECTION].find_one({"_id": shift_id}, {"name": 1})
        shift_name = (shift_doc or {}).get("name")
        raise DomainException(
            message=(
                f"Shift '{shift_name}' not found in this calendar"
                if shift_name
                else "Selected shift not found in this calendar"
            ),
            code="SHIFT_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return doc


async def get_shift_assignments(
    db: AsyncIOMotorDatabase, calendar_id: str, *, current_user_org_id=None
) -> list[dict]:
    """Return all active shift assignments for a calendar as {user_id, shift_id}.

    Stringifies both fields so the response always serializes cleanly through
    ``ShiftAssignmentResponse`` (Pydantic v2 rejects raw ObjectId on a ``str``
    field, which previously caused a silent 500 and an empty list on the FE).

    ``current_user_org_id`` (from session) tenant-scopes the calendar lookup
    so callers from a different org get 404 instead of cross-tenant data.
    """
    await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    cal_oid = to_oid(calendar_id)
    docs = await db[SHIFT_ASSIGNMENT_COLLECTION].find(
        {"calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    rows = [{"user_id": str(d["user_id"]), "shift_id": str(d["shift_id"])} for d in docs]
    # Enrich so the shift board can render employee cards directly from this
    # response — no IAM employee fetch + client-side join needed.
    details = await enrich_user_details(db, [r["user_id"] for r in rows])
    return [apply_details(r, details) for r in rows]


async def sync_shift_assignments(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    assignments: list[dict],  # list of {user_id, shift_id}
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """
    Sync shift assignments for a calendar.
    - Assignments not in the new list are soft-deleted.
    - Assignments with a changed shift_id are updated.
    - New assignments are inserted.
    Returns {updated: int}.

    ``current_user_org_id`` (from session) tenant-scopes the calendar lookup.
    """
    calendar = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(calendar)
    org_id = calendar["org_id"]
    cal_oid = to_oid(calendar_id)

    # Validate all shift_ids belong to this calendar in a single query
    # (was N round-trips, one per distinct shift).
    shift_ids = {a["shift_id"] for a in assignments}
    if shift_ids:
        found_shifts = await db[SHIFT_COLLECTION].find(
            {"_id": {"$in": list(shift_ids)}, "calendar_id": calendar_id, "deleted_on": None}
        ).to_list(length=None)
        found_shift_ids = {d["_id"] for d in found_shifts}
        missing = [sid for sid in shift_ids if sid not in found_shift_ids]
        if missing:
            raise DomainException(
                message=f"Shift '{missing[0]}' not found in this calendar",
                code="SHIFT_NOT_FOUND",
                status_code=status.HTTP_404_NOT_FOUND,
            )

    # Load current active assignments. Canonical user_id form is ObjectId; we
    # normalize when keying the maps so set diffs work even if existing rows
    # were written as strings via past code paths.
    existing_docs = await db[SHIFT_ASSIGNMENT_COLLECTION].find(
        {"calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    existing_map: dict = {to_oid(d["user_id"]): d for d in existing_docs}

    desired_map: dict = {to_oid(a["user_id"]): a["shift_id"] for a in assignments if a.get("user_id")}

    # Cross-calendar rule: a user may only have shift assignments in ONE
    # calendar. Reject if any user we're about to ADD already has a shift
    # assignment in a different calendar.
    new_user_oids = [uid for uid in desired_map if uid not in existing_map]
    await assert_no_cross_scope_assignment(
        db,
        collection=SHIFT_ASSIGNMENT_COLLECTION,
        scope_field="calendar_id",
        scope_value=cal_oid,
        user_oids=new_user_oids,
        scope_name_collection=CALENDAR_COLLECTION,
        scope_label=SCOPE_LABEL,
        org_id=org_id,
    )

    updated = 0

    # Soft-delete removed assignments (match either ObjectId or str storage form)
    to_remove = set(existing_map) - set(desired_map)
    if to_remove:
        remove_match = list(to_remove) + [str(x) for x in to_remove]
        await db[SHIFT_ASSIGNMENT_COLLECTION].update_many(
            {"calendar_id": cal_oid, "user_id": {"$in": remove_match}, "deleted_on": None},
            {"$set": audit_fields_delete(user_id)},
        )
        updated += len(to_remove)

    # Build sets of users whose shift is new or changed (for bulk email lookup)
    users_to_notify: dict = {}  # uid → shift_id
    for uid, sid in desired_map.items():
        if uid not in existing_map or existing_map[uid]["shift_id"] != sid:
            users_to_notify[uid] = sid

    # Insert new or update changed assignments in a single bulk_write
    # (was one round-trip per assignment).
    ops: list = []
    for uid, sid in desired_map.items():
        if uid not in existing_map:
            # New assignment — always stored as ObjectId user_id
            ops.append(InsertOne({
                "calendar_id": cal_oid,
                "org_id": org_id,
                "user_id": uid,
                "shift_id": sid,
                **audit_fields_create(user_id),
            }))
            updated += 1
        elif existing_map[uid]["shift_id"] != sid:
            # Shift changed
            ops.append(UpdateOne(
                {"_id": existing_map[uid]["_id"]},
                {"$set": {"shift_id": sid, **audit_fields_update(user_id)}},
            ))
            updated += 1
    if ops:
        await db[SHIFT_ASSIGNMENT_COLLECTION].bulk_write(ops, ordered=False)

    # Send email notifications for new/changed assignments. The assignments are
    # already persisted above — a broker/email failure must NOT fail or stall
    # the save (that previously made the request hang, or 500 after the rows
    # were written so a retry saw no diff and reported "0 saved"). Isolate the
    # whole block and fan the publishes out concurrently.
    if users_to_notify:
        try:
            await _notify_shift_assignments(db, calendar, calendar_id, users_to_notify)
        except Exception:
            logger.warning(
                "Failed to publish shift assignment emails (assignments saved)",
                calendar_id=calendar_id,
                exc_info=True,
            )

    logger.info("Shift assignments synced", calendar_id=calendar_id, updated=updated)
    _audit_kwargs = {
        "action": "shift_assignment.synced",
        "resource": f"work_calendar:{calendar_id}",
        "actor_id": user_id,
        "organisation_id": str(org_id),
        "details": {"updated": updated},
    }
    await emit_activity(**_audit_kwargs)
    await emit_audit(**_audit_kwargs)
    return {"updated": updated}


async def _notify_shift_assignments(
    db: AsyncIOMotorDatabase,
    calendar: dict,
    calendar_id: str,
    users_to_notify: dict,  # uid → shift_id
) -> None:
    """Publish shift-assignment emails concurrently. Best-effort: callers wrap
    this in a try/except so messaging issues never break the save."""
    calendar_name = calendar.get("name", "")
    shift_docs = await db[SHIFT_COLLECTION].find(
        {"_id": {"$in": list(set(users_to_notify.values()))}}
    ).to_list(length=None)
    shift_name_map = {d["_id"]: d.get("name", "") for d in shift_docs}

    emp_docs = await db["employees"].find(
        {"user_id": {"$in": list(users_to_notify.keys())}, "is_deleted": {"$ne": True}}
    ).to_list(length=None)
    emp_map = {d["user_id"]: d for d in emp_docs}

    publishes = []
    for uid, sid in users_to_notify.items():
        emp = emp_map.get(uid)
        if emp and emp.get("work_email"):
            publishes.append(email_events.publish_shift_employee_added(
                employee_email=emp["work_email"],
                employee_name=emp.get("name", ""),
                shift_name=shift_name_map.get(sid, ""),
                shift_id=str(sid),
                calendar_name=calendar_name,
                calendar_id=calendar_id,
                tenant_id=str(emp.get("organisation_id", "")),
            ))
    if publishes:
        await asyncio.gather(*publishes)


async def bulk_assign_shift_employees(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    assignments: list[dict],  # list of {user_id, shift_id}
    user_id: str,
    *,
    current_user_org_id=None,
) -> dict:
    """
    Upsert shift assignments from a bulk import.
    Adds or updates — does not remove existing assignments not in the list.
    Returns {updated: int}.

    ``current_user_org_id`` (from session) tenant-scopes the calendar lookup.
    """
    calendar = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(calendar)
    org_id = calendar["org_id"]
    cal_oid = to_oid(calendar_id)

    # Validate all shift_ids belong to this calendar (mirrors sync_shift_assignments).
    shift_ids = {a["shift_id"] for a in assignments}
    for sid in shift_ids:
        await _get_shift_or_raise(db, sid, calendar_id)

    # Validate all user_ids belong to this calendar's employee list. Without
    # this guard, bulk-assign could attach arbitrary users to a calendar's
    # shifts even if they aren't on the calendar.
    calendar_user_ids = {
        to_oid(d["user_id"])
        for d in await db[EMP_MAP_COLLECTION].find(
            {"work_calendar_id": cal_oid, "deleted_on": None}
        ).to_list(length=None)
    }
    for a in assignments:
        if to_oid(a["user_id"]) not in calendar_user_ids:
            emp = await db["employees"].find_one(
                {"user_id": to_oid(a["user_id"])},
                {"name": 1, "first_name": 1, "last_name": 1, "emp_code": 1},
            )
            emp = emp or {}
            emp_name = (
                emp.get("name")
                or f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
                or emp.get("emp_code")
            )
            raise DomainException(
                message=(
                    f"User '{emp_name}' is not assigned to this work calendar"
                    if emp_name
                    else "A selected user is not assigned to this work calendar"
                ),
                code="USER_NOT_ON_CALENDAR",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    existing_docs = await db[SHIFT_ASSIGNMENT_COLLECTION].find(
        {"calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    # Key the lookup map by canonical ObjectId so incoming string user_ids
    # match existing rows regardless of storage shape.
    existing_map: dict = {to_oid(d["user_id"]): d for d in existing_docs}

    # Cross-calendar rule: reject if any user we're about to add already has
    # a shift assignment in a different calendar.
    new_user_oids = [to_oid(a["user_id"]) for a in assignments if to_oid(a["user_id"]) not in existing_map]
    await assert_no_cross_scope_assignment(
        db,
        collection=SHIFT_ASSIGNMENT_COLLECTION,
        scope_field="calendar_id",
        scope_value=cal_oid,
        user_oids=new_user_oids,
        scope_name_collection=CALENDAR_COLLECTION,
        scope_label=SCOPE_LABEL,
        org_id=org_id,
    )

    updated = 0
    bulk_notify: dict = {}  # uid → shift_id for new/changed assignments
    for a in assignments:
        uid = to_oid(a["user_id"])
        sid = a["shift_id"]
        if uid not in existing_map:
            await db[SHIFT_ASSIGNMENT_COLLECTION].insert_one({
                "calendar_id": cal_oid,
                "org_id": org_id,
                "user_id": uid,
                "shift_id": sid,
                **audit_fields_create(user_id),
            })
            updated += 1
            bulk_notify[uid] = sid
        elif existing_map[uid]["shift_id"] != sid:
            await db[SHIFT_ASSIGNMENT_COLLECTION].update_one(
                {"_id": existing_map[uid]["_id"]},
                {"$set": {"shift_id": sid, **audit_fields_update(user_id)}},
            )
            updated += 1
            bulk_notify[uid] = sid

    # Best-effort emails — never let a broker/email failure break the import
    # (rows are already persisted above).
    if bulk_notify:
        try:
            await _notify_shift_assignments(db, calendar, calendar_id, bulk_notify)
        except Exception:
            logger.warning(
                "Failed to publish bulk shift assignment emails (assignments saved)",
                calendar_id=calendar_id,
                exc_info=True,
            )

    logger.info("Shift assignments bulk-assigned", calendar_id=calendar_id, updated=updated)
    _audit_kwargs = {
        "action": "shift_assignment.assigned",
        "resource": f"work_calendar:{calendar_id}",
        "actor_id": user_id,
        "organisation_id": str(org_id),
        "details": {"updated": updated},
    }
    await emit_activity(**_audit_kwargs)
    await emit_audit(**_audit_kwargs)
    return {"updated": updated}


async def generate_shift_assignment_template(
    db: AsyncIOMotorDatabase, calendar_id: str
) -> bytes:
    """
    Generate an XLSX template pre-filled with calendar employees and their
    current shift assignments, with a dropdown for shift names.
    """
    cal_oid = to_oid(calendar_id)

    # Fetch calendar employees
    emp_docs = await db[EMP_MAP_COLLECTION].find(
        {"work_calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    user_ids = [d["user_id"] for d in emp_docs]

    # Fetch current assignments
    assign_docs = await db[SHIFT_ASSIGNMENT_COLLECTION].find(
        {"calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    assign_map: dict[str, str] = {d["user_id"]: d["shift_id"] for d in assign_docs}

    # Fetch shift names
    shift_docs = await db[SHIFT_COLLECTION].find(
        {"calendar_id": calendar_id, "deleted_on": None}
    ).to_list(length=None)
    shift_name_map: dict[str, str] = {d["_id"]: d["name"] for d in shift_docs}
    shift_names = [d["name"] for d in shift_docs]

    # Fetch employee details
    employees = []
    if user_ids:
        emp_records = await db["employees"].find(
            {"user_id": {"$in": user_ids}, "is_deleted": {"$ne": True}}
        ).to_list(length=None)
        user_to_emp: dict[str, dict] = {str(e["user_id"]): e for e in emp_records}
        for uid in user_ids:
            emp = user_to_emp.get(str(uid), {})
            shift_id = assign_map.get(uid, "")
            name = (
                emp.get("name")
                or f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip()
                or ""
            )
            employees.append({
                "emp_code": emp.get("emp_code", ""),
                "name": name,
                "shift_name": shift_name_map.get(shift_id, ""),
            })

    return generate_shift_template_xlsx(employees, shift_names)


async def validate_shift_assignment_bulk(
    db: AsyncIOMotorDatabase,
    calendar_id: str,
    file_bytes: bytes,
    *,
    current_user_org_id=None,
) -> dict:
    """
    Parse and validate a CSV for shift assignments.
    Columns: emp_code, shift_name
    Returns per-row status with resolved user_id and shift_id.

    ``current_user_org_id`` (from session) tenant-scopes the calendar lookup
    AND drives the cross-calendar conflict check — a 404 is raised if the
    calendar belongs to a different organisation.
    """
    cal_oid = to_oid(calendar_id)

    # Resolve the calendar's org_id so every subsequent query is tenant-scoped.
    calendar = await _get_calendar_or_raise(db, calendar_id, expected_org_id=current_user_org_id)
    _assert_calendar_active(calendar)
    org_id = calendar.get("org_id")
    org_match = [org_id, str(org_id)] if org_id else None

    # Fetch calendar employees (only they can be assigned to shifts).
    # Normalize user_id to ObjectId so membership checks work regardless of
    # how existing rows happen to be stored (canonical ObjectId or legacy str).
    emp_docs = await db[EMP_MAP_COLLECTION].find(
        {"work_calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    calendar_user_ids = {to_oid(d["user_id"]) for d in emp_docs}

    # Fetch all shifts for this calendar
    shift_docs = await db[SHIFT_COLLECTION].find(
        {"calendar_id": calendar_id, "deleted_on": None}
    ).to_list(length=None)
    shift_name_to_id: dict[str, str] = {d["name"].lower(): d["_id"] for d in shift_docs}
    shift_id_to_name: dict[str, str] = {d["_id"]: d["name"] for d in shift_docs}

    # Fetch current assignments to detect duplicates and shift changes.
    # Same normalization applied to assignment user_ids.
    assign_docs = await db[SHIFT_ASSIGNMENT_COLLECTION].find(
        {"calendar_id": cal_oid, "deleted_on": None}
    ).to_list(length=None)
    existing_user_shift: dict = {to_oid(d["user_id"]): d["shift_id"] for d in assign_docs}

    # Cross-calendar check: for each user, are they already on a shift in a
    # DIFFERENT calendar within the SAME org? We don't filter the assignment
    # collection by org_id (legacy rows may lack it); instead we tenant-scope
    # via the calendars collection (always has org_id).
    other_assign_docs = await db[SHIFT_ASSIGNMENT_COLLECTION].find(
        {"calendar_id": {"$ne": cal_oid}, "deleted_on": None}
    ).to_list(length=None)
    cross_cal_by_user: dict = {}
    if other_assign_docs:
        other_cal_ids = list({d["calendar_id"] for d in other_assign_docs})
        cal_name_query: dict = {"_id": {"$in": other_cal_ids}}
        if org_match:
            cal_name_query["org_id"] = {"$in": org_match}
        cal_name_docs = await db[CALENDAR_COLLECTION].find(cal_name_query).to_list(length=None)
        same_org_cal_ids = {d["_id"] for d in cal_name_docs}
        cal_name_by_id = {d["_id"]: d.get("name", "(unnamed)") for d in cal_name_docs}
        for d in other_assign_docs:
            if d["calendar_id"] not in same_org_cal_ids:
                continue  # skip cross-tenant hits
            uid_norm = to_oid(d["user_id"])
            cross_cal_by_user.setdefault(uid_norm, set()).add(
                cal_name_by_id.get(d["calendar_id"], "(unknown)")
            )

    # Parse CSV or XLSX
    if _is_xlsx(file_bytes):
        raw_rows = _parse_xlsx_rows(file_bytes)
        if not raw_rows:
            return _empty_result(["No data found. Ensure the file has 'emp_code' and 'shift_name' columns."])
        fieldnames = list(raw_rows[0].keys())
    else:
        try:
            text = file_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            return _empty_result(["Invalid file format. Upload a CSV or XLSX file."])
        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            return _empty_result(["No data found. Ensure the file has 'emp_code' and 'shift_name' columns."])
        fieldnames = list(reader.fieldnames)
        raw_rows = [{h: (row.get(h) or "") for h in fieldnames} for row in reader]

    header_map = {h.strip().lower().replace(" ", "_"): h for h in fieldnames}
    code_col = header_map.get("emp_code") or header_map.get("employee_code") or header_map.get("empcode")
    shift_col = header_map.get("shift_name") or header_map.get("shift") or header_map.get("shift_name")

    if not code_col or not shift_col:
        return _empty_result(["File must have 'emp_code' and 'shift_name' columns."])

    parsed_rows = []
    for row in raw_rows:
        emp_code = (row.get(code_col) or "").strip()
        shift_name = (row.get(shift_col) or "").strip()
        if emp_code or shift_name:
            parsed_rows.append({"emp_code": emp_code, "shift_name": shift_name})

    rows = []
    seen_codes: set[str] = set()
    valid_count = error_count = duplicate_count = change_count = 0

    for i, parsed in enumerate(parsed_rows):
        row_num = i + 1
        emp_code = parsed["emp_code"]
        shift_name = parsed["shift_name"]
        errors: list[str] = []

        if not emp_code:
            errors.append("Employee code is required")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", errors=errors))
            error_count += 1
            continue

        if not shift_name:
            errors.append("Shift name is required")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", errors=errors))
            error_count += 1
            continue

        if emp_code.lower() in seen_codes:
            errors.append("Duplicate employee code in file")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", errors=errors))
            error_count += 1
            continue
        seen_codes.add(emp_code.lower())

        # Resolve employee
        employee = await db["employees"].find_one({
            "emp_code": {"$regex": f"^{emp_code}$", "$options": "i"},
            "is_deleted": {"$ne": True},
        })
        if not employee:
            errors.append(f"Employee '{emp_code}' not found")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", errors=errors))
            error_count += 1
            continue

        # Canonical user_id form is ObjectId — use it for membership/dup checks.
        # Keep a str version for the response payload (FE expects a string).
        user_oid = to_oid(employee.get("user_id"))
        user_id = str(user_oid) if user_oid else ""
        if not user_id:
            errors.append("Cannot resolve user identity for this employee")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", errors=errors))
            error_count += 1
            continue

        if user_oid not in calendar_user_ids:
            errors.append("Employee is not assigned to this work calendar")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", user_id=user_id, errors=errors))
            error_count += 1
            continue

        # Cross-calendar rule: a user may only have a shift assignment in ONE
        # calendar at a time. If already assigned in another, error out.
        if user_oid in cross_cal_by_user:
            other_names = sorted(cross_cal_by_user[user_oid])
            errors.append(
                f"Already has a shift assignment in another calendar: "
                f"{', '.join(repr(n) for n in other_names)} — remove that first"
            )
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", user_id=user_id, errors=errors))
            error_count += 1
            continue

        # Resolve shift
        shift_id = shift_name_to_id.get(shift_name.lower())
        if not shift_id:
            errors.append(f"Shift '{shift_name}' not found in this calendar")
            rows.append(_shift_row(row_num, emp_code, shift_name, "error", user_id=user_id, errors=errors))
            error_count += 1
            continue

        # Duplicate check (same user already on the exact same shift) — keyed by ObjectId
        current_assigned_shift_id = existing_user_shift.get(user_oid)
        if current_assigned_shift_id == shift_id:
            rows.append(_shift_row(row_num, emp_code, shift_name, "duplicate",
                                   user_id=user_id, shift_id=shift_id,
                                   name=_emp_name(employee),
                                   errors=["Already assigned to this shift"]))
            duplicate_count += 1
            continue

        # Shift change (user is in a different shift → will be moved)
        if current_assigned_shift_id:
            current_shift_name = shift_id_to_name.get(current_assigned_shift_id)
            rows.append(_shift_row(row_num, emp_code, shift_name, "change",
                                   user_id=user_id, shift_id=shift_id,
                                   name=_emp_name(employee),
                                   current_shift_name=current_shift_name))
            change_count += 1
            continue

        rows.append(_shift_row(row_num, emp_code, shift_name, "valid",
                               user_id=user_id, shift_id=shift_id,
                               name=_emp_name(employee)))
        valid_count += 1

    return {
        "total_rows": len(parsed_rows),
        "valid_count": valid_count,
        "change_count": change_count,
        "error_count": error_count,
        "duplicate_count": duplicate_count,
        "file_errors": [],
        "rows": rows,
    }


def _emp_name(employee: dict) -> str:
    return (
        employee.get("name")
        or f"{employee.get('first_name', '')} {employee.get('last_name', '')}".strip()
        or ""
    ) or None


def _shift_row(
    row_num: int, emp_code: str, shift_name: str, status: str, *,
    user_id: str | None = None, shift_id: str | None = None,
    name: str | None = None, current_shift_name: str | None = None,
    errors: list[str] | None = None,
) -> dict:
    return {
        "row_num": row_num,
        "status": status,
        "emp_code": emp_code,
        "shift_name": shift_name,
        "user_id": user_id,
        "shift_id": shift_id,
        "name": name,
        "current_shift_name": current_shift_name,
        "errors": errors or [],
    }


def _empty_result(file_errors: list[str]) -> dict:
    return {
        "total_rows": 0, "valid_count": 0, "change_count": 0,
        "error_count": 0, "duplicate_count": 0,
        "file_errors": file_errors, "rows": [],
    }
