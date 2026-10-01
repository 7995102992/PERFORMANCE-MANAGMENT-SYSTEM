from __future__ import annotations

import io
import logging
import re
from datetime import datetime
from typing import Any

from openpyxl import Workbook, load_workbook

from ..audit import emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.access import (
    can_access_client,
    hidden_client_ids,
    is_scope_exempt,
    own_client_ids,
    own_project_ids,
)
from ..common.excel import (
    add_list_dropdown,
    add_sheet_dropdown,
    col_letter_for,
    format_date_column,
    parse_header,
    write_header_row,
)
from ..common.names import normalize_name, to_name_lc
from ..common.object_id import is_valid_object_id
from ..common.pagination import PageParams, compute_skip
from ..common.search import regex_contains
from ..common.timestamps import utcnow
from ..common.user_resolver import resolve_user_names, resolve_users_org_units
from ..exceptions import (
    ClientNotFound,
    InvalidInternalProjectHead,
    ProjectCodeExists,
    ProjectHasPendingTimesheets,
    ProjectHasResources,
    ProjectNameExists,
    ProjectNotFound,
)
from ..models import Client, ClientProjectHead, Project, ProjectApprovalStatusEnum, ProjectStatusEnum, ProjectTask, ProjectTypeEnum, ResourceAssignment, StatusEnum, Task, TimesheetProjectApproval
from .schemas import ProjectCreate, ProjectUpdate

logger = logging.getLogger(__name__)


def _to_out(doc: Project, client_name: str | None, head_names: list[str]) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "client_id": str(doc.client_id),
        "client_name": client_name,
        "name": doc.name,
        "code": doc.code,
        "description": doc.description,
        "project_type": doc.project_type,
        "project_status": doc.project_status,
        "start_date": doc.start_date,
        "end_date": doc.end_date,
        "budget_hours": doc.budget_hours,
        "budget_cost": doc.budget_cost,
        "billable_rate": doc.billable_rate,
        "billable_rate_type": doc.billable_rate_type,
        "billable_on": doc.billable_on,
        "currency": doc.currency,
        "project_head_ids": [str(x) for x in doc.project_head_ids],
        "project_head_names": head_names,
        "is_internal": doc.is_internal,
        "send_alerts": doc.send_alerts,
        "client_approval_required": doc.client_approval_required,
        "status": doc.status,
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_on": doc.created_on,
        "modified_by": str(doc.modified_by) if doc.modified_by else None,
        "modified_on": doc.modified_on,
    }


async def _resolve_head_names(head_ids: list, organisation_id) -> dict[Any, str]:
    """Names for ``project_head_ids``, whichever kind of head each id names.

    The field is polymorphic. An internal head is an IAM user id; a client-side head
    is a ``ClientProjectHead`` row, which lives in a different collection entirely
    and has no IAM user of its own id. Asking only IAM is why client projects showed
    a blank head column while internal ones looked fine — the id was in the payload,
    so nothing looked broken until you compared the two.

    Each source is batched and independently fail-open: a name is a label, so losing
    either lookup costs the caller a label, never the project.

    Args:
        head_ids: The union of ``project_head_ids`` across the page.
        organisation_id: The viewer's organisation — a tenant guard on both lookups.

    Returns:
        ``{head_id: name}``, keyed by ObjectId. Ids that resolve to neither kind —
        a head deleted out from under the project — are simply absent, and the
        caller renders the remaining names.
    """
    if not head_ids:
        return {}

    names: dict[Any, str] = {}
    try:
        names.update(await resolve_user_names([str(h) for h in head_ids], organisation_id))
    except Exception:
        logger.exception("project head names unavailable from IAM — trying client heads")

    missing = [h for h in head_ids if h not in names]
    if not missing:
        return names

    try:
        heads = await ClientProjectHead.find({
            "_id": {"$in": missing},
            "organisation_id": organisation_id,
            "deleted_on": None,
        }).to_list()
    except Exception:
        logger.exception("client project head names unavailable — returning ids only")
        return names

    for h in heads:
        # Falls back to the email so a head with no name on record still reads as a
        # person rather than as a blank cell.
        label = f"{h.first_name or ''} {h.last_name or ''}".strip() or h.email
        if label:
            names[h.id] = label
    return names


async def _with_names(docs: list[Project], user: UserBase) -> list[dict[str, Any]]:
    """Render projects with their client and project-head names resolved.

    Both are batched across the whole page — one client query and one IAM query —
    so callers never need a second round trip per project just to show a name.
    """
    if not docs:
        return []

    organisation_id = user.organisation_id

    clients = await Client.find(
        {"_id": {"$in": list({d.client_id for d in docs})}}
    ).to_list()
    client_names = {c.id: c.name for c in clients}

    head_ids = list({h for d in docs for h in (d.project_head_ids or [])})
    head_names = await _resolve_head_names(head_ids, organisation_id)

    return [
        _to_out(
            d,
            client_names.get(d.client_id),
            [head_names[h] for h in (d.project_head_ids or []) if h in head_names],
        )
        for d in docs
    ]


async def _visible_client_filter(user: UserBase) -> dict[str, Any]:
    """Base client query for the viewer: the organisation's live clients, narrowed
    to the ones a non-admin owns."""
    filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    own_clients = await own_client_ids(user)
    if own_clients is not None:
        filt["_id"] = {"$in": list(own_clients)}
    return filt


async def _load_or_404(project_id: str, user: UserBase) -> Project:
    if not is_valid_object_id(project_id):
        raise ProjectNotFound()
    doc = await Project.get(project_id)
    if doc is None or doc.deleted_on is not None or doc.organisation_id != user.organisation_id:
        raise ProjectNotFound()
    # Hide projects whose client is outside the viewer's business unit / department.
    if not is_scope_exempt(user, action="manage_projects"):
        client = await Client.get(doc.client_id)
        if client is not None and not await can_access_client(user, client, action="manage_projects"):
            raise ProjectNotFound()
    # Non-admins only reach the projects they own (head / creator / manager assignment).
    own = await own_project_ids(user)
    if own is not None and doc.id not in own:
        raise ProjectNotFound()
    return doc


def _project_code_candidates(name: str):
    """Yield project-code candidates for ``name``, shortest first: the derived
    base, then progressively longer versions by appending the next letter of the
    name (mirrors the frontend rules; uppercased, non-alphanumerics stripped).

    base — 1 word → first 3 letters; 2 words → 1 + 2 letters; 3+ words → first
    letter of each word. The "tail" extends the base one letter at a time.
    """
    words = [re.sub(r"[^A-Za-z0-9]", "", w).upper() for w in (name or "").split()]
    words = [w for w in words if w]
    if not words:
        yield "PRJ"
        return
    if len(words) == 1:
        base, tail = words[0][:3], words[0][3:]
    elif len(words) == 2:
        base, tail = words[0][:1] + words[1][:2], words[1][2:] + words[0][1:]
    else:
        base, tail = "".join(w[0] for w in words), "".join(w[1:] for w in words)
    yield base
    cur = base
    for ch in tail:
        cur += ch
        yield cur


def _derive_project_code(name: str) -> str:
    """The base/display project code for ``name`` (first candidate)."""
    return next(iter(_project_code_candidates(name)), "PRJ")


async def generate_project_code(name: str, organisation_id, taken: set[str] | None = None) -> str:
    """Return a unique project code derived from ``name`` for the organisation.

    On collision, extends the code with the next letter of the name (GAM → GAMI →
    GAMIN …) rather than a numeric suffix, until it clashes with neither an
    existing project nor anything in ``taken`` (for batch generation).
    """
    taken = taken or set()

    async def _is_free(code: str) -> bool:
        if code in taken:
            return False
        return await Project.find_one(
            {"organisation_id": organisation_id, "code": code, "deleted_on": None}
        ) is None

    last = "PRJ"
    for candidate in _project_code_candidates(name):
        last = candidate
        if await _is_free(candidate):
            return candidate
    # Every letter-extension is taken (extremely unlikely) → numeric fallback.
    n = 1
    while True:
        n += 1
        candidate = f"{last}{n}"
        if await _is_free(candidate):
            return candidate


async def _validate_internal_project_heads(head_ids: list[str], client: Client) -> None:
    """For an internal project, each head must be an EMPLOYEE within the client's
    business-unit / department scope (the same eligible set the Resources tab and the
    project-head picker use).

    Eligible = has an IAM employee record whose business_unit_id is in the client's
    ``business_unit_ids`` AND whose department_id is in the client's ``department_ids``
    — the business unit, and a department within it. A client that leaves one axis
    unscoped is unrestricted on that axis.
    """
    if not head_ids:
        return
    client_bus = {str(b) for b in (client.business_unit_ids or [])}
    client_depts = {str(d) for d in (client.department_ids or [])}
    placements = await resolve_users_org_units([str(h) for h in head_ids])
    for h in head_ids:
        bu, dept = placements.get(str(h), (None, None))
        if bu is None and dept is None:
            raise InvalidInternalProjectHead()  # not an employee
        if client_bus and (bu is None or str(bu) not in client_bus):
            raise InvalidInternalProjectHead()
        if client_depts and (dept is None or str(dept) not in client_depts):
            raise InvalidInternalProjectHead()


async def create_project(body: ProjectCreate, user: UserBase) -> dict[str, Any]:
    client = await Client.get(body.client_id)
    if client is None or client.deleted_on is not None or client.organisation_id != user.organisation_id:
        raise ClientNotFound()
    # Can't create a project under a client outside the viewer's BU / department.
    if not await can_access_client(user, client, action="manage_projects"):
        raise ClientNotFound()
    # Non-admins can only create under a client they already own.
    own_clients = await own_client_ids(user)
    if own_clients is not None and client.id not in own_clients:
        raise ClientNotFound()

    name = normalize_name(body.name)
    name_lc = to_name_lc(name)

    existing = await Project.find_one(
        {"organisation_id": user.organisation_id, "name_lc": name_lc, "deleted_on": None}
    )
    if existing:
        raise ProjectNameExists()

    if body.code:
        code_exists = await Project.find_one(
            {"organisation_id": user.organisation_id, "code": body.code.strip(), "deleted_on": None}
        )
        if code_exists:
            raise ProjectCodeExists()

    # Internal projects: heads are employees in the client's BU/department scope.
    if body.is_internal:
        await _validate_internal_project_heads(body.project_head_ids, client)

    now = utcnow()
    start_date = datetime.fromisoformat(body.start_date) if body.start_date else None
    end_date = datetime.fromisoformat(body.end_date) if body.end_date else None

    doc = Project(
        organisation_id=user.organisation_id,
        client_id=body.client_id,
        name=name,
        name_lc=name_lc,
        code=body.code.strip() if body.code else None,
        description=body.description,
        project_type=body.project_type,
        project_status=ProjectStatusEnum.ACTIVE,
        start_date=start_date,
        end_date=end_date,
        budget_hours=body.budget_hours if not body.budget_cost else None,
        budget_cost=body.budget_cost if not body.budget_hours else None,
        billable_rate=body.billable_rate,
        billable_rate_type=body.billable_rate_type,
        billable_on=body.billable_on,
        currency=body.currency,
        project_head_ids=body.project_head_ids,
        is_internal=body.is_internal,
        send_alerts=body.send_alerts,
        client_approval_required=body.client_approval_required,
        status=StatusEnum.ACTIVE,
        created_by=user.id,
        created_on=now,
    )
    await doc.insert()

    await emit_audit(
        action="project.created",
        resource=f"project:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"project_name": doc.name, "project_code": doc.code},
    )

    global_tasks = await Task.find(
        {"organisation_id": user.organisation_id, "is_global": True, "deleted_on": None}
    ).to_list()
    for gt in global_tasks:
        pt = ProjectTask(
            organisation_id=user.organisation_id,
            project_id=doc.id,
            task_id=gt.id,
            is_active=True,
            created_by=user.id,
            created_on=now,
        )
        await pt.insert()

    return (await _with_names([doc], user))[0]


async def list_projects(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    status: str = "active",
    client_id: str | None = None,
    project_type: str | None = None,
) -> dict[str, Any]:
    from beanie import PydanticObjectId
    filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    if status and status != "all":
        filt["status"] = status
    if client_id:
        filt["client_id"] = PydanticObjectId(client_id)
    if project_type:
        filt["project_type"] = project_type

    # Restrict to projects whose client is in the viewer's BU / department.
    hidden = await hidden_client_ids(user, action="manage_projects")
    if hidden:
        if "client_id" in filt:
            if filt["client_id"] in hidden:
                return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        else:
            filt["client_id"] = {"$nin": hidden}

    # Non-admins only see their own projects.
    own = await own_project_ids(user)
    if own is not None:
        if not own:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        filt["_id"] = {"$in": list(own)}

    term = regex_contains(q)
    if term:
        filt["$or"] = [
            {"name_lc": term},
            {"code": term},
        ]

    skip = compute_skip(p)
    total = await Project.find(filt).count()
    items = await Project.find(filt).sort("-created_on").skip(skip).limit(p.page_size).to_list()
    items_out = await _with_names(items, user)
    return {"items": items_out, "total": total, "page": p.page, "page_size": p.page_size}


async def get_project(project_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(project_id, user)
    return (await _with_names([doc], user))[0]


async def update_project(project_id: str, body: ProjectUpdate, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(project_id, user)
    update_data = body.model_dump(exclude_unset=True)

    if "name" in update_data and update_data["name"]:
        new_name = normalize_name(update_data["name"])
        new_name_lc = to_name_lc(new_name)
        if new_name_lc != doc.name_lc:
            existing = await Project.find_one(
                {"organisation_id": user.organisation_id, "name_lc": new_name_lc, "deleted_on": None}
            )
            if existing and str(existing.id) != str(doc.id):
                raise ProjectNameExists()
        doc.name = normalize_name(update_data["name"])
        doc.name_lc = to_name_lc(doc.name)

    if "code" in update_data and update_data["code"]:
        code = update_data["code"].strip()
        if code != doc.code:
            code_exists = await Project.find_one(
                {"organisation_id": user.organisation_id, "code": code, "deleted_on": None}
            )
            if code_exists and str(code_exists.id) != str(doc.id):
                raise ProjectCodeExists()
            doc.code = code

    # Re-validate internal heads when the project is (or becomes) internal and
    # its heads or internal flag change.
    effective_internal = update_data.get("is_internal", doc.is_internal)
    if effective_internal and ("project_head_ids" in update_data or "is_internal" in update_data):
        heads = update_data.get("project_head_ids")
        if heads is None:
            heads = [str(x) for x in doc.project_head_ids]
        client = await Client.get(doc.client_id)
        if client is not None:
            await _validate_internal_project_heads(heads, client)

    for field in ("description", "project_type", "start_date", "end_date", "budget_hours", "budget_cost", "billable_rate", "billable_rate_type", "billable_on", "currency", "project_head_ids", "is_internal", "send_alerts", "client_approval_required"):
        if field in update_data:
            val = update_data[field]
            if field in ("start_date", "end_date") and isinstance(val, str):
                val = datetime.fromisoformat(val)
            setattr(doc, field, val)

    if "budget_hours" in update_data and update_data["budget_hours"] is not None:
        doc.budget_cost = None
    elif "budget_cost" in update_data and update_data["budget_cost"] is not None:
        doc.budget_hours = None

    if "project_status" in update_data and update_data["project_status"]:
        doc.project_status = ProjectStatusEnum(update_data["project_status"])

    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    await emit_audit(
        action="project.updated",
        resource=f"project:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"project_name": doc.name, "project_code": doc.code},
        changed_fields=list(body.model_dump(exclude_unset=True).keys()),
    )

    return (await _with_names([doc], user))[0]


async def delete_project(project_id: str, user: UserBase) -> None:
    doc = await _load_or_404(project_id, user)

    in_use = await ResourceAssignment.find(
        {"project_id": doc.id, "deleted_on": None, "status": "active"}
    ).count()
    if in_use > 0:
        raise ProjectHasResources()

    # Don't delete a project that still has timesheets awaiting a decision.
    pending = await TimesheetProjectApproval.find({
        "project_id": doc.id,
        "status": {"$in": [
            ProjectApprovalStatusEnum.SUBMITTED.value,
            ProjectApprovalStatusEnum.RESUBMITTED.value,
            ProjectApprovalStatusEnum.L1_APPROVED.value,
        ]},
        "deleted_on": None,
    }).count()
    if pending > 0:
        raise ProjectHasPendingTimesheets()

    now = utcnow()
    doc.deleted_on = now
    doc.deleted_by = user.id
    doc.status = StatusEnum.INACTIVE
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    await emit_audit(
        action="project.deleted",
        resource=f"project:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"project_name": doc.name, "project_code": doc.code},
    )


# ── Template / Import / Export ────────────────────────────────

TEMPLATE_COLUMNS = [
    "Project Name",
    "Client Name",
    "Description",
    "Project Type",
    "Billable Rate Type",
    "Hourly Rate",
    "Currency",
    "Start Date",
    "End Date",
    "Budget Hours",
    "Client Approval Required",
    "Is Internal",
]

COLUMN_FIELD_MAP = {
    "project name": "name",
    "client name": "client_name",
    "description": "description",
    "project type": "project_type",
    "billable rate type": "billable_rate_type",
    "hourly rate": "billable_rate",
    "currency": "currency",
    "start date": "start_date",
    "end date": "end_date",
    "budget hours": "budget_hours",
    "client approval required": "client_approval_required",
    "is internal": "is_internal",
}

# Accepted truthy/falsy spellings for the "Client Approval Required" column.
BOOL_TRUE_VALUES = {"true", "yes", "1"}
BOOL_FALSE_VALUES = {"false", "no", "0"}
VALID_BOOL_VALUES = BOOL_TRUE_VALUES | BOOL_FALSE_VALUES

# Columns whose value is mandatory for project creation (marked with " *").
TEMPLATE_REQUIRED_COLUMNS = {
    "Project Name",
    "Client Name",
}

# Header tooltips with format hints (keyed by column label).
TEMPLATE_COLUMN_HINTS = {
    "Project Type": "Time & Materials | Fixed Fee | Non-Billable",
    "Hourly Rate": "Numeric, e.g. 100",
    "Currency": "USD | INR | EUR | GBP",
    "Start Date": "YYYY-MM-DD",
    "End Date": "YYYY-MM-DD",
    "Budget Hours": "Numeric",
    "Client Approval Required": "True or False",
    "Is Internal": "True or False (internal projects have no client heads)",
}

# In-cell dropdown option lists.
PROJECT_TYPE_OPTIONS = ["Time & Materials", "Fixed Fee", "Non-Billable"]
CURRENCY_OPTIONS = ["USD", "INR", "EUR", "GBP"]
CLIENT_APPROVAL_OPTIONS = ["True", "False"]
IS_INTERNAL_OPTIONS = ["True", "False"]
BILLABLE_OPTIONS = ["Yes", "No"]

TASK_SHEET_COLUMNS = [
    "Project Name",
    "Task Name",
    "Description",
    "Billable",
    "Estimated Hours",
    "Billable Rate",
]

TASK_SHEET_FIELD_MAP = {
    "project name": "project_name",
    "task name": "task_name",
    "description": "description",
    "billable": "is_billable",
    "estimated hours": "estimated_hours",
    "billable rate": "billable_rate",
}

# Columns whose value is mandatory in the Tasks sheet (marked with " *").
TASK_SHEET_REQUIRED_COLUMNS = {
    "Project Name",
    "Task Name",
}

PROJECT_TYPE_MAP = {
    "time & materials": ProjectTypeEnum.TIME_AND_MATERIALS,
    "time and materials": ProjectTypeEnum.TIME_AND_MATERIALS,
    "time_and_materials": ProjectTypeEnum.TIME_AND_MATERIALS,
    "fixed fee": ProjectTypeEnum.FIXED_FEE,
    "fixed_fee": ProjectTypeEnum.FIXED_FEE,
    "non-billable": ProjectTypeEnum.NON_BILLABLE,
    "non billable": ProjectTypeEnum.NON_BILLABLE,
    "non_billable": ProjectTypeEnum.NON_BILLABLE,
}


async def generate_template(user: UserBase) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Projects"
    write_header_row(
        ws,
        TEMPLATE_COLUMNS,
        required_columns=TEMPLATE_REQUIRED_COLUMNS,
        hints=TEMPLATE_COLUMN_HINTS,
    )

    # Client Name dropdown sourced from the org's existing clients (long, dynamic
    # list → hidden helper sheet rather than an inline list).
    clients = await Client.find(await _visible_client_filter(user)).sort("name").to_list()
    client_names = [c.name for c in clients]
    add_sheet_dropdown(
        wb,
        ws,
        col_letter_for(TEMPLATE_COLUMNS, "Client Name"),
        client_names,
        error="Pick an existing client from the dropdown.",
    )

    # In-cell dropdowns for the enumerated columns.
    add_list_dropdown(ws, col_letter_for(TEMPLATE_COLUMNS, "Project Type"), PROJECT_TYPE_OPTIONS)
    add_list_dropdown(ws, col_letter_for(TEMPLATE_COLUMNS, "Currency"), CURRENCY_OPTIONS)
    add_list_dropdown(
        ws,
        col_letter_for(TEMPLATE_COLUMNS, "Client Approval Required"),
        CLIENT_APPROVAL_OPTIONS,
        error="Please select True or False.",
        prompt="Select True if client approval is required for timesheets on this project.",
        prompt_title="Client Approval Required",
    )
    add_list_dropdown(
        ws,
        col_letter_for(TEMPLATE_COLUMNS, "Is Internal"),
        IS_INTERNAL_OPTIONS,
        error="Please select True or False.",
        prompt="Select True for an internal project (heads are employees, set later — not via import).",
        prompt_title="Is Internal",
    )

    # Force the date columns to store real dates so they import as YYYY-MM-DD
    # regardless of the user's Excel locale.
    format_date_column(ws, col_letter_for(TEMPLATE_COLUMNS, "Start Date"))
    format_date_column(ws, col_letter_for(TEMPLATE_COLUMNS, "End Date"))

    # Tasks sheet for detailed task definitions per project
    ts = wb.create_sheet("Tasks")
    write_header_row(ts, TASK_SHEET_COLUMNS, required_columns=TASK_SHEET_REQUIRED_COLUMNS)
    add_list_dropdown(ts, col_letter_for(TASK_SHEET_COLUMNS, "Billable"), BILLABLE_OPTIONS)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


EXPORT_COLUMNS = [
    "Project Name",
    "Client Name",
    "Project Code",
    "Description",
    "Project Type",
    "Hourly Rate",
    "Currency",
    "Start Date",
    "End Date",
    "Budget Hours",
    "Client Approval Required",
    "Status",
    "Created On",
]


async def export_projects(user: UserBase) -> bytes:
    export_filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    hidden = await hidden_client_ids(user, action="manage_projects")
    if hidden:
        export_filt["client_id"] = {"$nin": hidden}
    own = await own_project_ids(user)
    if own is not None:
        export_filt["_id"] = {"$in": list(own)}
    docs = await Project.find(export_filt).sort("-created_on").to_list()

    client_ids = list({d.client_id for d in docs})
    clients = await Client.find({"_id": {"$in": client_ids}}).to_list()
    client_map = {str(c.id): c.name for c in clients}

    wb = Workbook()
    ws = wb.active
    ws.title = "Projects"
    ws.append(EXPORT_COLUMNS)
    for d in docs:
        ws.append([
            d.name,
            client_map.get(str(d.client_id), ""),
            d.code or "",
            d.description or "",
            d.project_type.value if hasattr(d.project_type, "value") else str(d.project_type),
            d.billable_rate or "",
            d.currency,
            d.start_date.strftime("%Y-%m-%d") if d.start_date else "",
            d.end_date.strftime("%Y-%m-%d") if d.end_date else "",
            d.budget_hours or "",
            "True" if d.client_approval_required else "False",
            (d.project_status.value if hasattr(d.project_status, "value") else str(d.project_status)).replace("_", " ").title(),
            d.created_on.strftime("%Y-%m-%d %H:%M") if d.created_on else "",
        ])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _parse_bool(val: str, default: bool = True) -> bool:
    if not val:
        return default
    cleaned = val.strip().lower()
    if cleaned in BOOL_TRUE_VALUES:
        return True
    if cleaned in BOOL_FALSE_VALUES:
        return False
    return default


def _parse_float(val: str | None) -> float | None:
    if not val:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


async def validate_import_projects(file_bytes: bytes, user: UserBase) -> dict[str, Any]:
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True)
    ws = wb["Projects"] if "Projects" in wb.sheetnames else wb.active

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if not rows:
        return {"total": 0, "rows": [{"row": 0, "status": "error", "reason": "Empty file", "data": {}}]}

    header = parse_header(rows[0])

    required_headers = {col.lower() for col in TEMPLATE_COLUMNS}
    found_headers = {h for h in header if h}
    missing = required_headers - found_headers
    if missing:
        missing_display = ", ".join(sorted(col for col in TEMPLATE_COLUMNS if col.lower() in missing))
        return {"total": 0, "rows": [{"row": 1, "status": "error", "reason": f"Missing required columns in Projects sheet: {missing_display}", "data": {}}]}

    field_map: list[str | None] = [COLUMN_FIELD_MAP.get(h) for h in header]

    all_clients = await Client.find(await _visible_client_filter(user)).to_list()
    client_name_map = {c.name.strip().lower(): str(c.id) for c in all_clients}

    result_rows: list[dict[str, Any]] = []

    for row_idx, row in enumerate(rows[1:], start=2):
        record: dict[str, Any] = {}
        for col_idx, cell in enumerate(row):
            if col_idx < len(field_map) and field_map[col_idx] and cell is not None:
                record[field_map[col_idx]] = str(cell).strip()

        name = record.get("name", "").strip()
        if not name:
            result_rows.append({"row": row_idx, "status": "error", "reason": "Project Name is required", "data": record})
            continue

        client_name = record.get("client_name", "").strip()
        if not client_name:
            result_rows.append({"row": row_idx, "status": "error", "reason": "Client Name is required", "data": record})
            continue

        if not client_name_map.get(client_name.lower()):
            result_rows.append({"row": row_idx, "status": "error", "reason": f"Client '{client_name}' not found", "data": record})
            continue

        name = normalize_name(name)
        name_lc = to_name_lc(name)

        existing = await Project.find_one(
            {"organisation_id": user.organisation_id, "name_lc": name_lc, "deleted_on": None}
        )
        if existing:
            result_rows.append({"row": row_idx, "status": "existing", "reason": f"Project '{name}' already exists", "data": {**record, "name": name}})
            continue

        # Project Code is auto-generated on import — no longer validated here.

        try:
            if record.get("start_date"):
                datetime.fromisoformat(record["start_date"])
        except (ValueError, TypeError):
            result_rows.append({"row": row_idx, "status": "error", "reason": "Invalid Start Date format (use YYYY-MM-DD)", "data": record})
            continue

        try:
            if record.get("end_date"):
                datetime.fromisoformat(record["end_date"])
        except (ValueError, TypeError):
            result_rows.append({"row": row_idx, "status": "error", "reason": "Invalid End Date format (use YYYY-MM-DD)", "data": record})
            continue

        cap_raw = record.get("client_approval_required", "").strip().lower()
        if cap_raw and cap_raw not in VALID_BOOL_VALUES:
            result_rows.append({"row": row_idx, "status": "error", "reason": "Client Approval Required must be True or False", "data": record})
            continue

        internal_raw = record.get("is_internal", "").strip().lower()
        if internal_raw and internal_raw not in VALID_BOOL_VALUES:
            result_rows.append({"row": row_idx, "status": "error", "reason": "Is Internal must be True or False", "data": record})
            continue

        result_rows.append({"row": row_idx, "status": "new", "reason": None, "data": {**record, "name": name}})

    # ── Sheet 2: Tasks (optional) ─────────────────────────────
    task_rows_result: list[dict[str, Any]] = []
    if "Tasks" in wb.sheetnames:
        ts = wb["Tasks"]
        task_rows = list(ts.iter_rows(min_row=1, values_only=True))
        if task_rows:
            t_header = parse_header(task_rows[0])
            required_task_headers = {col.lower() for col in TASK_SHEET_COLUMNS}
            found_task_headers = {h for h in t_header if h}
            t_missing = required_task_headers - found_task_headers
            if t_missing:
                missing_display = ", ".join(sorted(col for col in TASK_SHEET_COLUMNS if col.lower() in t_missing))
                task_rows_result.append({"row": 1, "status": "error", "reason": f"Tasks sheet missing required columns: {missing_display}", "data": {}})
            else:
                t_field_map: list[str | None] = [TASK_SHEET_FIELD_MAP.get(h) for h in t_header]
                all_projects = await Project.find(
                    {"organisation_id": user.organisation_id, "deleted_on": None}
                ).to_list()
                project_name_lookup = {p.name_lc: str(p.id) for p in all_projects}
                # Only shared tasks get linked by name; one owned by another project
                # is not reusable, so the import would create a new task instead.
                all_tasks = await Task.find(
                    {"organisation_id": user.organisation_id, "deleted_on": None, "project_id": None}
                ).to_list()
                task_name_lookup = {t.name_lc for t in all_tasks}

                for t_row_idx, t_row in enumerate(task_rows[1:], start=2):
                    t_record: dict[str, Any] = {}
                    for col_idx, cell in enumerate(t_row):
                        if col_idx < len(t_field_map) and t_field_map[col_idx] and cell is not None:
                            t_record[t_field_map[col_idx]] = str(cell).strip()

                    project_name_raw = t_record.get("project_name", "").strip()
                    task_name_raw = t_record.get("task_name", "").strip()

                    if not project_name_raw:
                        task_rows_result.append({"row": t_row_idx, "status": "error", "reason": "Tasks sheet: Project Name is required", "data": t_record})
                        continue
                    if not task_name_raw:
                        task_rows_result.append({"row": t_row_idx, "status": "error", "reason": "Tasks sheet: Task Name is required", "data": t_record})
                        continue

                    proj_name_lc = to_name_lc(normalize_name(project_name_raw))
                    if proj_name_lc not in project_name_lookup:
                        task_rows_result.append({"row": t_row_idx, "status": "error", "reason": f"Tasks sheet: Project '{project_name_raw}' not found", "data": t_record})
                        continue

                    task_name_lc = to_name_lc(normalize_name(task_name_raw))
                    if task_name_lc in task_name_lookup:
                        task_rows_result.append({"row": t_row_idx, "status": "existing", "reason": f"Task '{normalize_name(task_name_raw)}' already exists and will be linked", "data": t_record})
                    else:
                        task_rows_result.append({"row": t_row_idx, "status": "new", "reason": None, "data": t_record})

    wb.close()
    return {
        "total": len(rows) - 1,
        "rows": result_rows,
        "task_total": len(task_rows_result),
        "task_rows": task_rows_result,
    }


async def bulk_import_projects(file_bytes: bytes, user: UserBase) -> dict[str, Any]:
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True)

    # ── Sheet 1: Projects ─────────────────────────────────────
    ws = wb["Projects"] if "Projects" in wb.sheetnames else wb.active

    rows = list(ws.iter_rows(min_row=1, values_only=True))
    if not rows:
        return {"total": 0, "created": 0, "errors": [{"row": 0, "error": "Empty file"}]}

    header = parse_header(rows[0])

    required_headers = {col.lower() for col in TEMPLATE_COLUMNS}
    found_headers = {h for h in header if h}
    missing = required_headers - found_headers
    if missing:
        missing_display = ", ".join(sorted(col for col in TEMPLATE_COLUMNS if col.lower() in missing))
        return {"total": 0, "created": 0, "errors": [{"row": 1, "error": f"Missing required columns in Projects sheet: {missing_display}"}]}

    field_map: list[str | None] = [COLUMN_FIELD_MAP.get(h) for h in header]

    # Pre-load clients
    all_clients = await Client.find(await _visible_client_filter(user)).to_list()
    client_name_map = {c.name.strip().lower(): str(c.id) for c in all_clients}

    # Pre-load tasks
    # Only shared (organisation-level) tasks are reusable across projects. A task
    # owned by another project must not be linked here — the import creates this
    # project its own task of that name instead.
    all_tasks = await Task.find(
        {"organisation_id": user.organisation_id, "deleted_on": None, "project_id": None}
    ).to_list()
    shared_task_map = {t.name.strip().lower(): t for t in all_tasks}
    # Tasks created by this import, keyed by (project id, task name).
    project_task_map: dict[tuple[Any, str], Task] = {}

    created = 0
    errors: list[dict[str, Any]] = []
    now = utcnow()
    # Track created projects by name_lc → doc for Tasks sheet linking
    project_name_map: dict[str, Project] = {}
    # Auto-generated project codes used so far this batch (for uniqueness)
    used_codes: set[str] = set()

    for row_idx, row in enumerate(rows[1:], start=2):
        record: dict[str, Any] = {}
        for col_idx, cell in enumerate(row):
            if col_idx < len(field_map) and field_map[col_idx] and cell is not None:
                record[field_map[col_idx]] = str(cell).strip()

        name = record.get("name", "").strip()
        if not name:
            errors.append({"row": row_idx, "error": "Project Name is required"})
            continue

        client_name = record.get("client_name", "").strip()
        if not client_name:
            errors.append({"row": row_idx, "error": "Client Name is required"})
            continue

        client_id = client_name_map.get(client_name.lower())
        if not client_id:
            errors.append({"row": row_idx, "error": f"Client '{client_name}' not found"})
            continue

        name = normalize_name(name)
        name_lc = to_name_lc(name)

        existing = await Project.find_one(
            {"organisation_id": user.organisation_id, "name_lc": name_lc, "deleted_on": None}
        )
        if existing:
            errors.append({"row": row_idx, "error": f"Project '{name}' already exists"})
            continue

        # Project Code is auto-generated from the name (unique per org + batch).
        code = await generate_project_code(name, user.organisation_id, taken=used_codes)
        used_codes.add(code)

        pt_raw = record.get("project_type", "").strip().lower()
        project_type = PROJECT_TYPE_MAP.get(pt_raw, ProjectTypeEnum.TIME_AND_MATERIALS)

        start_date = None
        end_date = None
        try:
            if record.get("start_date"):
                start_date = datetime.fromisoformat(record["start_date"])
        except (ValueError, TypeError):
            errors.append({"row": row_idx, "error": "Invalid Start Date format (use YYYY-MM-DD)"})
            continue
        try:
            if record.get("end_date"):
                end_date = datetime.fromisoformat(record["end_date"])
        except (ValueError, TypeError):
            errors.append({"row": row_idx, "error": "Invalid End Date format (use YYYY-MM-DD)"})
            continue

        billable_rate = None
        budget_hours = None
        try:
            if record.get("billable_rate"):
                billable_rate = float(record["billable_rate"])
        except (ValueError, TypeError):
            pass
        try:
            if record.get("budget_hours"):
                budget_hours = float(record["budget_hours"])
        except (ValueError, TypeError):
            pass

        currency = record.get("currency", "USD").strip().upper() or "USD"

        cap_raw = record.get("client_approval_required", "").strip().lower()
        if cap_raw and cap_raw not in VALID_BOOL_VALUES:
            errors.append({"row": row_idx, "error": "Client Approval Required must be True or False"})
            continue
        client_approval_required = _parse_bool(record.get("client_approval_required", ""), True)

        internal_raw = record.get("is_internal", "").strip().lower()
        if internal_raw and internal_raw not in VALID_BOOL_VALUES:
            errors.append({"row": row_idx, "error": "Is Internal must be True or False"})
            continue
        is_internal = _parse_bool(record.get("is_internal", ""), False)

        doc = Project(
            organisation_id=user.organisation_id,
            client_id=client_id,
            name=name,
            name_lc=name_lc,
            code=code,
            description=record.get("description"),
            project_type=project_type,
            project_status=ProjectStatusEnum.ACTIVE,
            start_date=start_date,
            end_date=end_date,
            budget_hours=budget_hours,
            billable_rate=billable_rate,
            currency=currency,
            client_approval_required=client_approval_required,
            is_internal=is_internal,
            status=StatusEnum.ACTIVE,
            created_by=user.id,
            created_on=now,
        )
        await doc.insert()
        created += 1
        project_name_map[name_lc] = doc

    # ── Sheet 2: Tasks (optional) ─────────────────────────────
    if "Tasks" in wb.sheetnames:
        ts = wb["Tasks"]
        task_rows = list(ts.iter_rows(min_row=1, values_only=True))

        if task_rows:
            t_header = parse_header(task_rows[0])

            required_task_headers = {col.lower() for col in TASK_SHEET_COLUMNS}
            found_task_headers = {h for h in t_header if h}
            t_missing = required_task_headers - found_task_headers
            if t_missing:
                missing_display = ", ".join(sorted(col for col in TASK_SHEET_COLUMNS if col.lower() in t_missing))
                errors.append({"row": 1, "error": f"Tasks sheet missing required columns: {missing_display}"})
            else:
                t_field_map: list[str | None] = [TASK_SHEET_FIELD_MAP.get(h) for h in t_header]

                # Also load existing projects for linking tasks to pre-existing projects
                all_projects = await Project.find(
                    {"organisation_id": user.organisation_id, "deleted_on": None}
                ).to_list()
                for p in all_projects:
                    if p.name_lc not in project_name_map:
                        project_name_map[p.name_lc] = p

                for t_row_idx, t_row in enumerate(task_rows[1:], start=2):
                    t_record: dict[str, Any] = {}
                    for col_idx, cell in enumerate(t_row):
                        if col_idx < len(t_field_map) and t_field_map[col_idx] and cell is not None:
                            t_record[t_field_map[col_idx]] = str(cell).strip()

                    project_name_raw = t_record.get("project_name", "").strip()
                    task_name_raw = t_record.get("task_name", "").strip()

                    if not project_name_raw:
                        errors.append({"row": t_row_idx, "error": "Tasks sheet: Project Name is required"})
                        continue
                    if not task_name_raw:
                        errors.append({"row": t_row_idx, "error": "Tasks sheet: Task Name is required"})
                        continue

                    proj_name_lc = to_name_lc(normalize_name(project_name_raw))
                    project_doc = project_name_map.get(proj_name_lc)
                    if not project_doc:
                        errors.append({"row": t_row_idx, "error": f"Tasks sheet: Project '{project_name_raw}' not found"})
                        continue

                    task_name = normalize_name(task_name_raw)
                    task_name_lc = to_name_lc(task_name)

                    # Reuse a shared task of that name, else give this project its own.
                    task = shared_task_map.get(task_name_lc) or project_task_map.get(
                        (project_doc.id, task_name_lc)
                    )
                    if not task:
                        is_billable = _parse_bool(t_record.get("is_billable", ""), True)
                        task = Task(
                            organisation_id=user.organisation_id,
                            project_id=project_doc.id,
                            name=task_name,
                            name_lc=task_name_lc,
                            description=t_record.get("description"),
                            is_global=False,
                            is_billable=is_billable,
                            status=StatusEnum.ACTIVE,
                            created_by=user.id,
                            created_on=now,
                        )
                        await task.insert()
                        project_task_map[(project_doc.id, task_name_lc)] = task

                    # Assign task to project
                    existing_pt = await ProjectTask.find_one(
                        {"project_id": project_doc.id, "task_id": task.id, "deleted_on": None}
                    )
                    if not existing_pt:
                        est_hours = _parse_float(t_record.get("estimated_hours"))
                        bill_rate = _parse_float(t_record.get("billable_rate"))
                        pt = ProjectTask(
                            organisation_id=user.organisation_id,
                            project_id=project_doc.id,
                            task_id=task.id,
                            is_active=True,
                            estimated_hours=est_hours,
                            billable_rate=bill_rate,
                            created_by=user.id,
                            created_on=now,
                        )
                        await pt.insert()

    wb.close()

    await emit_audit(
        action="project.imported",
        resource=f"organisation:{user.organisation_id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        details={"count": created},
    )

    return {"total": len(rows) - 1, "created": created, "errors": errors}


# ── Timeline (audit log proxy) ──────────────────────────────

async def get_project_timeline(
    project_id: str,
    user: UserBase,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    doc = await _load_or_404(project_id, user)

    from ..config import settings
    if not settings.LOGGING_BASE_URL or not settings.LOGGING_API_KEY:
        return []

    import httpx
    from datetime import timezone

    start = doc.created_on or datetime(2024, 1, 1, tzinfo=timezone.utc)
    end = utcnow()

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{settings.LOGGING_BASE_URL}/logs",
                params={
                    "start_time": start.isoformat(),
                    "end_time": end.isoformat(),
                    "module": "timesheet",
                    "limit": 500,
                    "offset": 0,
                },
                headers={"X-API-Key": settings.LOGGING_API_KEY},
            )
            resp.raise_for_status()
    except Exception as exc:
        logger.warning("Failed to fetch audit logs: %s", repr(exc))
        return []

    import json
    body = resp.json()
    entries = body.get("data", [])

    resource_key = f"project:{project_id}"
    filtered = []
    for entry in entries:
        if entry.get("resource") == resource_key:
            meta = entry.get("metadata")
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except Exception:
                    meta = {}
            filtered.append({
                "timestamp": entry.get("timestamp"),
                "action": entry.get("action"),
                "actor_id": entry.get("actor_id"),
                "details": meta.get("details", {}) if isinstance(meta, dict) else {},
            })
        if len(filtered) >= limit:
            break

    return filtered
