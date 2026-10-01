from __future__ import annotations

import io
import logging
import re
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

from ..audit import emit_audit
from ..auth.service import send_activation_email
from ..auth.utils.dependencies import UserBase
from ..common.access import can_access_client, hidden_client_ids, own_client_ids
from ..common.excel import parse_header, write_header_row
from ..common.names import normalize_name, to_name_lc
from ..common.object_id import is_valid_object_id
from ..common.pagination import PageParams, compute_skip
from ..common.search import regex_contains
from ..common.timestamps import utcnow
from ..common.user_resolver import create_iam_user, fetch_bu_department_map, fetch_country_names, fetch_country_state_map, fetch_scope_options, find_iam_user_by_email, resolve_scope_names, update_iam_user
from ..exceptions import ClientHasProjects, ClientNameExists, ClientNotFound
from ..models import Client, Project, StatusEnum
from .schemas import ClientCreate, ClientUpdate

logger = logging.getLogger(__name__)


def _to_out(doc: Client) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "name": doc.name,
        "contact_person": doc.contact_person,
        "contact_email": doc.contact_email,
        "contact_phone": doc.contact_phone,
        "address": doc.address,
        "country": doc.country,
        "state": doc.state,
        "fax": doc.fax,
        "contact_user_id": str(doc.contact_user_id) if doc.contact_user_id else None,
        "portal_access_enabled": doc.portal_access_enabled,
        "notes": doc.notes,
        "business_unit_ids": [str(x) for x in doc.business_unit_ids],
        "department_ids": [str(x) for x in doc.department_ids],
        "business_unit_names": None,
        "department_names": None,
        "status": doc.status,
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_on": doc.created_on,
        "modified_by": str(doc.modified_by) if doc.modified_by else None,
        "modified_on": doc.modified_on,
    }


async def _attach_scope_names(items: list[dict[str, Any]]) -> None:
    """Fill ``business_unit_names`` / ``department_names`` on each out-dict by
    resolving the ids from IAM (batched: one query per type for the whole list)."""
    bu_ids = {i for it in items for i in (it.get("business_unit_ids") or [])}
    dept_ids = {i for it in items for i in (it.get("department_ids") or [])}
    bu_map = await resolve_scope_names("business_unit", list(bu_ids)) if bu_ids else {}
    dept_map = await resolve_scope_names("department", list(dept_ids)) if dept_ids else {}
    for it in items:
        it["business_unit_names"] = [bu_map.get(i, "") for i in (it.get("business_unit_ids") or [])]
        it["department_names"] = [dept_map.get(i, "") for i in (it.get("department_ids") or [])]


async def _find_by_name(organisation_id: str, name_lc: str) -> Client | None:
    return await Client.find_one(
        {"organisation_id": organisation_id, "name_lc": name_lc, "deleted_on": None}
    )


async def _load_or_404(client_id: str, user: UserBase) -> Client:
    if not is_valid_object_id(client_id):
        raise ClientNotFound()
    doc = await Client.get(client_id)
    if doc is None or doc.deleted_on is not None or doc.organisation_id != user.organisation_id:
        raise ClientNotFound()
    if not await can_access_client(user, doc, action="manage_clients"):
        raise ClientNotFound()
    # Non-admins only reach clients behind their own projects (or ones they created).
    own = await own_client_ids(user)
    if own is not None and doc.id not in own:
        raise ClientNotFound()
    return doc


async def _portal_login_for(
    email: str, first_name: str, last_name: str, user: UserBase,
) -> str | None:
    """The IAM login a client contact signs in with, if they already have one.

    An address that already has a login — an employee, or the contact of another
    client — is linked as-is and gets no mail: an activation mail carries a live
    password-reset link, and issuing one for somebody's existing account because an
    admin typed their address into a client form is not what the caller asked for.

    Provisioning a login for a brand-new contact is currently switched off, so the
    client record is simply saved without one and no mail goes out. Restore the block
    below to bring account creation and the activation mail back; the callers already
    handle a ``None`` here by leaving ``contact_user_id`` unset.
    """
    existing = await find_iam_user_by_email(email)
    if existing:
        logger.info("client contact reuses an existing IAM login user_id=%s", existing)
        return existing

    logger.info("client contact has no IAM login; account creation is disabled")
    return None

    # user_id = await create_iam_user(
    #     email=email,
    #     first_name=first_name,
    #     last_name=last_name,
    #     organisation_id=str(user.organisation_id),
    #     created_by=str(user.id),
    # )
    # await send_activation_email(
    #     user_id=user_id,
    #     email=email,
    #     full_name=f"{first_name} {last_name}".strip(),
    #     tenant_id=str(user.organisation_id),
    # )
    # return user_id


async def create_client(body: ClientCreate, user: UserBase) -> dict[str, Any]:
    name = normalize_name(body.name)
    name_lc = to_name_lc(name)

    if await _find_by_name(user.organisation_id, name_lc):
        raise ClientNameExists()

    contact_user_id = body.contact_user_id

    if body.portal_access_enabled and body.contact_email and not contact_user_id:
        parts = (body.contact_person or name).split(None, 1)
        first_name = parts[0] if parts else name
        last_name = parts[1] if len(parts) > 1 else ""
        contact_user_id = await _portal_login_for(
            body.contact_email, first_name, last_name, user,
        )

    now = utcnow()
    doc = Client(
        organisation_id=user.organisation_id,
        name=name,
        name_lc=name_lc,
        contact_person=body.contact_person,
        contact_email=body.contact_email,
        contact_phone=body.contact_phone,
        address=body.address,
        country=body.country,
        state=body.state,
        fax=body.fax,
        contact_user_id=contact_user_id,
        portal_access_enabled=body.portal_access_enabled,
        notes=body.notes,
        business_unit_ids=body.business_unit_ids or [],
        department_ids=body.department_ids or [],
        status=body.status,
        created_by=user.id,
        created_on=now,
    )
    await doc.insert()
    await emit_audit(
        action="client.created",
        resource=f"client:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": doc.name},
    )
    out = _to_out(doc)
    await _attach_scope_names([out])
    return out


async def list_clients(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    status: str = "active",
) -> dict[str, Any]:
    filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    if status and status != "all":
        filt["status"] = status
    term = regex_contains(q)
    if term:
        filt["$or"] = [
            {"name_lc": term},
            {"contact_person": term},
        ]

    # Restrict to the viewer's business unit / department (admins see all).
    hidden = await hidden_client_ids(user, action="manage_clients")
    if hidden:
        filt["_id"] = {"$nin": hidden}

    # Non-admins only see the clients behind their own projects.
    own = await own_client_ids(user)
    if own is not None:
        if not own:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        filt.setdefault("_id", {})["$in"] = list(own)

    skip = compute_skip(p)
    total = await Client.find(filt).count()
    items = await Client.find(filt).sort("-created_on").skip(skip).limit(p.page_size).to_list()
    out_items = [_to_out(c) for c in items]
    await _attach_scope_names(out_items)
    return {"items": out_items, "total": total, "page": p.page, "page_size": p.page_size}


async def get_client(client_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(client_id, user)
    out = _to_out(doc)
    await _attach_scope_names([out])
    return out


async def update_client(client_id: str, body: ClientUpdate, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(client_id, user)
    update_data = body.model_dump(exclude_unset=True)

    if "name" in update_data and update_data["name"]:
        new_name = normalize_name(update_data["name"])
        new_name_lc = to_name_lc(new_name)
        if new_name_lc != doc.name_lc:
            if await _find_by_name(user.organisation_id, new_name_lc):
                raise ClientNameExists()
        doc.name = new_name
        doc.name_lc = to_name_lc(new_name)

    for field in ("contact_person", "contact_email", "contact_phone", "address", "country", "state", "fax", "contact_user_id", "portal_access_enabled", "notes"):
        if field in update_data:
            setattr(doc, field, update_data[field])

    # business_unit_ids / department_ids are ObjectId references — coerce explicitly
    # (attribute assignment doesn't validate, so raw strs would persist as strings).
    if "business_unit_ids" in update_data or "department_ids" in update_data:
        from beanie import PydanticObjectId
        for id_field in ("business_unit_ids", "department_ids"):
            if id_field in update_data:
                vals = update_data[id_field]
                setattr(doc, id_field, [PydanticObjectId(x) for x in vals] if vals else [])

    if "status" in update_data and update_data["status"] is not None:
        doc.status = StatusEnum(update_data["status"])

    portal_enabled = doc.portal_access_enabled
    contact_email = doc.contact_email

    if portal_enabled and contact_email and not doc.contact_user_id:
        parts = (doc.contact_person or doc.name).split(None, 1)
        first_name = parts[0] if parts else doc.name
        last_name = parts[1] if len(parts) > 1 else ""
        doc.contact_user_id = await _portal_login_for(
            contact_email, first_name, last_name, user,
        )
    elif doc.contact_user_id and (
        "contact_email" in update_data
        or "contact_person" in update_data
    ):
        parts = (doc.contact_person or doc.name).split(None, 1)
        first_name = parts[0] if parts else doc.name
        last_name = parts[1] if len(parts) > 1 else ""
        await update_iam_user(
            str(doc.contact_user_id),
            modified_by=str(user.id),
            email=doc.contact_email,
            first_name=first_name,
            last_name=last_name,
        )

    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()
    await emit_audit(
        action="client.updated",
        resource=f"client:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": doc.name},
        changed_fields=list(body.model_dump(exclude_unset=True).keys()),
    )
    out = _to_out(doc)
    await _attach_scope_names([out])
    return out


async def delete_client(client_id: str, user: UserBase) -> None:
    doc = await _load_or_404(client_id, user)

    in_use = await Project.find(
        {"organisation_id": user.organisation_id, "client_id": doc.id, "deleted_on": None}
    ).count()
    if in_use > 0:
        raise ClientHasProjects()

    now = utcnow()
    doc.deleted_on = now
    doc.deleted_by = user.id
    doc.status = StatusEnum.INACTIVE
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()
    await emit_audit(
        action="client.deleted",
        resource=f"client:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"name": doc.name},
    )


TEMPLATE_COLUMNS = [
    "Client Name",
    "Contact Person",
    "Contact Email",
    "Contact Phone",
    "Address",
    "Country",
    "State",
    "Fax",
    "Notes",
    "Business Units",
    "Departments",
]

COLUMN_FIELD_MAP = {
    "client name": "name",
    "contact person": "contact_person",
    "contact email": "contact_email",
    "contact phone": "contact_phone",
    "address": "address",
    "country": "country",
    "state": "state",
    "fax": "fax",
    "notes": "notes",
    "business units": "business_units",
    "departments": "departments",
}


def _split_scope_names(raw: str | None) -> list[str]:
    """Split a multi-value cell ("BU One, BU Two") into trimmed names."""
    if not raw:
        return []
    return [n.strip() for n in re.split(r"[,;\n]", str(raw)) if n.strip()]


def _resolve_scope(raw: str | None, name_to_id: dict) -> tuple[list, list[str]]:
    """Map comma-separated names to ids via ``name_to_id`` (lowercased keys).
    Returns (resolved_ids, unknown_names)."""
    ids, unknown = [], []
    for nm in _split_scope_names(raw):
        oid = name_to_id.get(nm.lower())
        if oid is not None:
            ids.append(oid)
        else:
            unknown.append(nm)
    return ids, unknown

# Columns that are mandatory for client creation (marked with " *" in template)
TEMPLATE_REQUIRED_COLUMNS = {
    "Client Name",
    "Contact Person",
    "Contact Phone",
    "Country",
    "State",
}

# Model-field keys that must be present on every imported row, with their labels
REQUIRED_FIELD_LABELS = {
    "name": "Client Name",
    "contact_person": "Contact Person",
    "contact_phone": "Contact Phone",
    "country": "Country",
    "state": "State",
}


def _missing_required_fields(record: dict[str, Any]) -> list[str]:
    """Return the pretty labels of required fields absent/blank in a parsed row."""
    return [
        label
        for field, label in REQUIRED_FIELD_LABELS.items()
        if not str(record.get(field, "") or "").strip()
    ]

# Header tooltips with format hints (keyed by column label)
TEMPLATE_COLUMN_HINTS = {
    "Contact Email": "e.g. client@example.com",
    "Contact Phone": "10-15 digits",
    "Fax": "Optional",
    "Notes": "Optional free text",
    "Business Units": "Optional; comma-separated names (see Reference sheet)",
    "Departments": "Optional; comma-separated names (see Reference sheet)",
}


async def generate_template(user: UserBase) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Clients"

    write_header_row(
        ws,
        TEMPLATE_COLUMNS,
        required_columns=TEMPLATE_REQUIRED_COLUMNS,
        hints=TEMPLATE_COLUMN_HINTS,
    )

    # ── Cascading Country → State dropdowns (mirrors IAM employee template) ────
    country_names = await fetch_country_names()
    country_to_states = await fetch_country_state_map()
    # Only offer countries that actually have states, in a stable sorted order
    countries_with_states = [c for c in country_names if country_to_states.get(c)]

    ref = wb.create_sheet("_REF")
    ref.sheet_state = "hidden"
    # Col A: all country names (Country dropdown source)
    for i, c in enumerate(country_names, start=1):
        ref.cell(row=i, column=1, value=c)
    # Cols C,D: country_name -> column-index lookup table (for VLOOKUP)
    for i, c in enumerate(countries_with_states, start=1):
        ref.cell(row=i, column=3, value=c)   # C: country name
        ref.cell(row=i, column=4, value=i)   # D: 1-based column index in _CO_STATES

    # Hidden sheet: one column per country holding its states + a named range CO_{idx}
    co_states_ws = wb.create_sheet("_CO_STATES")
    co_states_ws.sheet_state = "hidden"
    for col_idx, country in enumerate(countries_with_states, start=1):
        states = country_to_states.get(country, [])
        for row_idx, st in enumerate(states, start=1):
            co_states_ws.cell(row=row_idx, column=col_idx, value=st)
        if states:
            cl = get_column_letter(col_idx)
            wb.defined_names.add(DefinedName(
                name=f"CO_{col_idx}",
                attr_text=f"'_CO_STATES'!${cl}$1:${cl}${len(states)}",
            ))

    country_col = get_column_letter(TEMPLATE_COLUMNS.index("Country") + 1)
    state_col = get_column_letter(TEMPLATE_COLUMNS.index("State") + 1)

    # Country dropdown: flat list from _REF column A
    if country_names:
        dv_country = DataValidation(
            type="list",
            formula1=f"=_REF!$A$1:$A${len(country_names)}",
            allow_blank=True,
            showErrorMessage=True,
        )
        dv_country.error = "Pick a value from the dropdown"
        ws.add_data_validation(dv_country)
        dv_country.add(f"{country_col}2:{country_col}1001")

    # State dropdown: cascades off the selected Country via INDIRECT + VLOOKUP
    if countries_with_states:
        state_formula = (
            f'=INDIRECT("CO_"&VLOOKUP({country_col}2,'
            f"_REF!$C$1:$D${len(countries_with_states)},2,FALSE))"
        )
        dv_state = DataValidation(
            type="list",
            formula1=state_formula,
            allow_blank=True,
            showErrorMessage=False,  # don't block when no country picked yet / typo
        )
        ws.add_data_validation(dv_state)
        dv_state.add(f"{state_col}2:{state_col}1001")

    # ── Cascading Business Unit → Department dropdowns ──────────────────────
    # Department options are filtered by the Business Unit picked in the same row,
    # using the same INDIRECT + VLOOKUP cascade as Country → State above.
    bu_dept_map = await fetch_bu_department_map(user.organisation_id)
    bu_names = sorted(bu_dept_map.keys(), key=str.lower)
    bus_with_depts = [b for b in bu_names if bu_dept_map[b]]

    if bu_names:
        bu_ref = wb.create_sheet("_BU_REF")
        bu_ref.sheet_state = "hidden"
        # Col A: all BU names (Business Units dropdown source)
        for i, b in enumerate(bu_names, start=1):
            bu_ref.cell(row=i, column=1, value=b)
        # Cols C,D: bu_name -> column-index lookup table (for VLOOKUP)
        for i, b in enumerate(bus_with_depts, start=1):
            bu_ref.cell(row=i, column=3, value=b)   # C: BU name
            bu_ref.cell(row=i, column=4, value=i)   # D: 1-based column index in _BU_DEPTS

        # Hidden sheet: one column per BU holding its departments + named range BU_{idx}
        bu_depts_ws = wb.create_sheet("_BU_DEPTS")
        bu_depts_ws.sheet_state = "hidden"
        for col_idx, b in enumerate(bus_with_depts, start=1):
            depts = bu_dept_map.get(b, [])
            for row_idx, dn in enumerate(depts, start=1):
                bu_depts_ws.cell(row=row_idx, column=col_idx, value=dn)
            if depts:
                cl = get_column_letter(col_idx)
                wb.defined_names.add(DefinedName(
                    name=f"BU_{col_idx}",
                    attr_text=f"'_BU_DEPTS'!${cl}$1:${cl}${len(depts)}",
                ))

        bu_col = get_column_letter(TEMPLATE_COLUMNS.index("Business Units") + 1)
        dept_col = get_column_letter(TEMPLATE_COLUMNS.index("Departments") + 1)

        # Business Units dropdown: flat list from _BU_REF column A
        dv_bu = DataValidation(
            type="list",
            formula1=f"=_BU_REF!$A$1:$A${len(bu_names)}",
            allow_blank=True,
            showErrorMessage=True,
        )
        dv_bu.error = "Pick a value from the dropdown"
        ws.add_data_validation(dv_bu)
        dv_bu.add(f"{bu_col}2:{bu_col}1001")

        # Departments dropdown: cascades off the selected Business Unit
        if bus_with_depts:
            dept_formula = (
                f'=INDIRECT("BU_"&VLOOKUP({bu_col}2,'
                f"_BU_REF!$C$1:$D${len(bus_with_depts)},2,FALSE))"
            )
            dv_dept = DataValidation(
                type="list",
                formula1=dept_formula,
                allow_blank=True,
                showErrorMessage=False,  # don't block when no BU picked yet
            )
            ws.add_data_validation(dv_dept)
            dv_dept.add(f"{dept_col}2:{dept_col}1001")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


EXPORT_COLUMNS = [
    "Client Name",
    "Contact Person",
    "Contact Email",
    "Contact Phone",
    "Address",
    "Country",
    "State",
    "Fax",
    "Notes",
    "Business Units",
    "Departments",
    "Status",
    "Created On",
]


async def export_clients(user: UserBase) -> bytes:
    export_filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    hidden = await hidden_client_ids(user, action="manage_clients")
    if hidden:
        export_filt["_id"] = {"$nin": hidden}
    own = await own_client_ids(user)
    if own is not None:
        export_filt.setdefault("_id", {})["$in"] = list(own)
    docs = await Client.find(export_filt).sort("-created_on").to_list()

    # Batch-resolve business-unit / department names across all clients.
    bu_name_map = await resolve_scope_names(
        "business_unit", list({i for d in docs for i in (d.business_unit_ids or [])})
    )
    dept_name_map = await resolve_scope_names(
        "department", list({i for d in docs for i in (d.department_ids or [])})
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Clients"
    ws.append(EXPORT_COLUMNS)
    for d in docs:
        ws.append([
            d.name,
            d.contact_person or "",
            d.contact_email or "",
            d.contact_phone or "",
            d.address or "",
            d.country or "",
            d.state or "",
            d.fax or "",
            d.notes or "",
            ", ".join(bu_name_map.get(str(i), "") for i in (d.business_unit_ids or [])),
            ", ".join(dept_name_map.get(str(i), "") for i in (d.department_ids or [])),
            d.status.value if hasattr(d.status, "value") else str(d.status),
            d.created_on.strftime("%Y-%m-%d %H:%M") if d.created_on else "",
        ])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def validate_import_clients(file_bytes: bytes, user: UserBase) -> dict[str, Any]:
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True)
    ws = wb.active

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if not rows:
        return {"total": 0, "rows": [{"row": 0, "status": "error", "reason": "Empty file", "data": {}}]}

    header = parse_header(rows[0])

    required_headers = {col.lower() for col in TEMPLATE_COLUMNS}
    found_headers = {h for h in header if h}
    missing = required_headers - found_headers
    if missing:
        missing_display = ", ".join(sorted(col for col in TEMPLATE_COLUMNS if col.lower() in missing))
        return {"total": 0, "rows": [{"row": 1, "status": "error", "reason": f"Missing required columns: {missing_display}", "data": {}}]}

    field_map: list[str | None] = [COLUMN_FIELD_MAP.get(h) for h in header]
    bu_map = {n.lower(): i for n, i in await fetch_scope_options("business_unit", user.organisation_id)}
    dept_map = {n.lower(): i for n, i in await fetch_scope_options("department", user.organisation_id)}
    result_rows: list[dict[str, Any]] = []

    for row_idx, row in enumerate(rows[1:], start=2):
        record: dict[str, Any] = {}
        for col_idx, cell in enumerate(row):
            if col_idx < len(field_map) and field_map[col_idx] and cell is not None:
                record[field_map[col_idx]] = str(cell).strip()

        missing_fields = _missing_required_fields(record)
        if missing_fields:
            result_rows.append({"row": row_idx, "status": "error", "reason": f"Missing required value(s): {', '.join(missing_fields)}", "data": record})
            continue

        _, bad_bu = _resolve_scope(record.get("business_units"), bu_map)
        _, bad_dept = _resolve_scope(record.get("departments"), dept_map)
        if bad_bu or bad_dept:
            result_rows.append({"row": row_idx, "status": "error", "reason": f"Unknown business unit/department: {', '.join(bad_bu + bad_dept)}", "data": record})
            continue

        name = normalize_name(record["name"].strip())
        name_lc = to_name_lc(name)

        if await _find_by_name(user.organisation_id, name_lc):
            result_rows.append({"row": row_idx, "status": "existing", "reason": f"Client '{name}' already exists", "data": {**record, "name": name}})
        else:
            result_rows.append({"row": row_idx, "status": "new", "reason": None, "data": {**record, "name": name}})

    wb.close()
    return {"total": len(rows) - 1, "rows": result_rows}


async def bulk_import_clients(file_bytes: bytes, user: UserBase) -> dict[str, Any]:
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True)
    ws = wb.active

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if not rows:
        return {"total": 0, "created": 0, "errors": [{"row": 0, "error": "Empty file"}]}

    header = parse_header(rows[0])

    required_headers = {col.lower() for col in TEMPLATE_COLUMNS}
    found_headers = {h for h in header if h}
    missing = required_headers - found_headers
    if missing:
        missing_display = ", ".join(sorted(col for col in TEMPLATE_COLUMNS if col.lower() in missing))
        return {"total": 0, "created": 0, "errors": [{"row": 1, "error": f"Missing required columns: {missing_display}"}]}

    field_map: list[str | None] = [COLUMN_FIELD_MAP.get(h) for h in header]
    bu_map = {n.lower(): i for n, i in await fetch_scope_options("business_unit", user.organisation_id)}
    dept_map = {n.lower(): i for n, i in await fetch_scope_options("department", user.organisation_id)}

    created = 0
    errors: list[dict[str, Any]] = []
    now = utcnow()

    for row_idx, row in enumerate(rows[1:], start=2):
        record: dict[str, Any] = {}
        for col_idx, cell in enumerate(row):
            if col_idx < len(field_map) and field_map[col_idx] and cell is not None:
                record[field_map[col_idx]] = str(cell).strip()

        missing_fields = _missing_required_fields(record)
        if missing_fields:
            errors.append({"row": row_idx, "error": f"Missing required value(s): {', '.join(missing_fields)}"})
            continue

        business_unit_ids, bad_bu = _resolve_scope(record.get("business_units"), bu_map)
        department_ids, bad_dept = _resolve_scope(record.get("departments"), dept_map)
        if bad_bu or bad_dept:
            errors.append({"row": row_idx, "error": f"Unknown business unit/department: {', '.join(bad_bu + bad_dept)}"})
            continue

        name = normalize_name(record["name"].strip())
        name_lc = to_name_lc(name)

        if await _find_by_name(user.organisation_id, name_lc):
            errors.append({"row": row_idx, "error": f"Client '{name}' already exists"})
            continue

        doc = Client(
            organisation_id=user.organisation_id,
            name=name,
            name_lc=name_lc,
            contact_person=record.get("contact_person"),
            contact_email=record.get("contact_email"),
            contact_phone=record.get("contact_phone"),
            address=record.get("address"),
            country=record.get("country"),
            state=record.get("state"),
            fax=record.get("fax"),
            notes=record.get("notes"),
            business_unit_ids=business_unit_ids,
            department_ids=department_ids,
            status=StatusEnum.ACTIVE,
            created_by=user.id,
            created_on=now,
        )
        await doc.insert()
        created += 1

    wb.close()
    if created:
        await emit_audit(
            action="client.imported",
            resource=f"organisation:{user.organisation_id}",
            actor_id=str(user.id),
            organisation_id=str(user.organisation_id),
            details={"count": created},
        )
    return {"total": len(rows) - 1, "created": created, "errors": errors}
