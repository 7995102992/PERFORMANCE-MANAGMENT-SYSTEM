"""RequestType + SLA service layer — Chapters 2, 3, 5."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from pymongo.errors import DuplicateKeyError

from ..audit import emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.iam_helpers import try_oid
from ..common.names import normalize_name, search_regex, to_name_lc
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow

from ..exceptions import (
    CategoryNotFound,
    NotificationRecipientUnresolved,
    RequestTypeInUse,
    RequestTypeNameExists,
    RequestTypeNotFound,
    SlaRulePriorityExists,
)
from ..models import (
    Category,
    ContactSnapshot,
    PriorityEnum,
    PRIORITY_ORDER,
    RequestStatusEnum,
    RequestType,
    SLARule,
    ServiceRequest,
    StatusEnum,
    TERMINAL_STATUSES,
    Workflow,
)
from .schemas import RequestTypeCreate, RequestTypeUpdate, SLARuleIn

logger = logging.getLogger(__name__)


def _rt_base(rt: RequestType) -> dict[str, Any]:
    return {
        "id": str(rt.id),
        "organisation_id": str(rt.organisation_id),
        "category_id": str(rt.category_id),
        "name": rt.name,
        "description": rt.description,
        "status": rt.status,
        "created_by": str(rt.created_by) if rt.created_by else None,
        "created_on": rt.created_on,
        "modified_by": str(rt.modified_by) if rt.modified_by else None,
        "modified_on": rt.modified_on,
    }


def _sla_out(r: SLARule) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "priority": r.priority,
        "first_response_minutes": r.first_response_minutes,
        "resolution_minutes": r.resolution_minutes,
        "business_hours_only": r.business_hours_only,
        "description": r.description,
        "violation_actions": r.violation_actions,
        "notification_recipients": [str(x) for x in r.notification_recipients],
        "status": r.status,
    }


async def _load_category(category_id: str, organisation_id: str) -> Category:
    cat = await Category.get(category_id)
    if (
        cat is None
        or cat.deleted_on is not None
        or str(cat.organisation_id) != organisation_id
    ):
        raise CategoryNotFound()
    return cat


async def _load_rt(request_type_id: str, organisation_id: str) -> RequestType:
    rt = await RequestType.get(request_type_id)
    if (
        rt is None
        or rt.deleted_on is not None
        or str(rt.organisation_id) != organisation_id
    ):
        raise RequestTypeNotFound()
    return rt


async def _resolve_recipient_contacts(
    rules: list[SLARuleIn], user: UserBase
) -> dict[str, ContactSnapshot]:
    """Resolve every rule's `notification_recipients` to addresses, once each.

    The SLA tick emails these people on breach but cannot look them up: it has
    no user token, and IAM has no service principal. So we resolve while we
    still hold the admin's token and store the result on the rule. See
    ``ContactSnapshot``.

    Resolved across *all* rules at once, deduped and concurrently: the FE sends
    all four priorities on every save, each allowing up to 20 recipients, so the
    naive per-rule sequential loop is up to 80 serial IAM calls against a 5s
    timeout. Recipients also repeat across priorities in practice, so the dedupe
    alone usually collapses this to a handful.

    Returns a {user_id: contact} map; callers pick out the ids their rule names.

    Raises NotificationRecipientUnresolved if any id has no address — this is a
    hard failure on purpose. An address missed here is missed forever (the tick
    can never fill it in), so the alternative is a rule that saves cleanly and
    then quietly notifies nobody.
    """
    from ..common.email_resolver import resolve_user_info

    ids = {str(r) for rule in rules for r in (rule.notification_recipients or [])}
    if not ids:
        return {}

    async def _one(rid: str) -> tuple[str, ContactSnapshot | None]:
        try:
            info = await resolve_user_info(rid, access_token=user.access_token)
        except Exception:  # noqa: BLE001
            logger.warning("recipient_contact.resolve_failed id=%s", rid, exc_info=True)
            return rid, None
        if not info.get("email"):
            return rid, None
        return rid, ContactSnapshot(
            user_id=rid, email=info["email"], name=info.get("name") or ""
        )

    resolved = await asyncio.gather(*(_one(i) for i in ids))
    contacts = {rid: c for rid, c in resolved if c is not None}

    missing = sorted(ids - contacts.keys())
    if missing:
        logger.warning("recipient_contact.unresolved ids=%s — rejecting save", missing)
        raise NotificationRecipientUnresolved(missing)
    return contacts


def _contacts_for(
    rule: SLARuleIn, contacts: dict[str, ContactSnapshot]
) -> list[ContactSnapshot]:
    return [
        contacts[str(r)]
        for r in (rule.notification_recipients or [])
        if str(r) in contacts
    ]


# ---------- Chapter 2: create atomic ----------

async def create_request_type(body: RequestTypeCreate, user: UserBase) -> dict[str, Any]:
    await _load_category(body.category_id, user.organisation_id)

    name = normalize_name(body.name)
    name_lc = to_name_lc(name)


    now = utcnow()
    contacts = await _resolve_recipient_contacts(body.sla_rules, user)
    try:
        rules: list[SLARule] = []
        for r in body.sla_rules:
            rules.append(SLARule(
                priority=r.priority,
                first_response_minutes=r.first_response_minutes,
                resolution_minutes=r.resolution_minutes,
                business_hours_only=r.business_hours_only,
                description=r.description,
                violation_actions=r.violation_actions,
                notification_recipients=r.notification_recipients,
                notification_recipient_contacts=_contacts_for(r, contacts),
                status=r.status,
                created_by=user.id,
                created_on=now,
            ))
        
        rt = RequestType(
            organisation_id=user.organisation_id,
            category_id=body.category_id,
            name=name,
            name_lc=name_lc,
            description=body.description,
            status=body.status,
            created_by=user.id,
            created_on=now,
            sla_rules=rules
        )
        await rt.insert()
    except DuplicateKeyError as e:
        if "priority" in str(e).lower():
            raise SlaRulePriorityExists() from e
        raise RequestTypeNameExists() from e

    try:
        await emit_audit(
            event="request_type.created",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(rt.id), "name": rt.name, "sla_count": len(rules)},
        )
    except Exception:  # noqa: BLE001
        pass

    out = _rt_base(rt)
    out["sla_rules"] = [_sla_out(r) for r in rt.sla_rules]
    return out

# ---------- Chapter 3: list/detail/update/delete ----------

async def list_request_types(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    category_id: str | None = None,
    priority: PriorityEnum | None = None,
    status: str | None = None,
    has_active_workflow: bool = False,
) -> dict[str, Any]:
    rt_filter: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "deleted_on": None,
    }
    if category_id:
        rt_filter["category_id"] = try_oid(category_id)
    # Applied before `has_active_workflow`, which pins status to "active" for
    # its own reasons — an explicit `status=inactive` alongside it would be a
    # contradiction, and letting that branch win keeps the Raise-Request slider
    # behaving the same however the caller filters.
    if status:
        rt_filter["status"] = status
    # Escaped + length-capped — see common.names.search_regex.
    q_lc = search_regex((q or "").lower())
    if q_lc:
        rt_filter["name_lc"] = {"$regex": q_lc, "$options": "i"}
    # Used by the Raise-Request slider so plain employees only see RTs that
    # have an active workflow attached (no manage_workflows perm needed).
    if has_active_workflow:
        rt_filter["status"] = "active"
        from ..models import Workflow
        wfs = await Workflow.find({
            "organisation_id": user.org_oid,
            "status": "active",
            "deleted_on": None,
        }).to_list()
        active_rt_ids = list({w.request_type_id for w in wfs})
        if not active_rt_ids:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        from bson import ObjectId as _OID
        active_oids: list[Any] = []
        for rid in active_rt_ids:
            try:
                active_oids.append(_OID(rid))
            except Exception:
                active_oids.append(rid)
        rt_filter["_id"] = {"$in": active_oids}

    # Active request types first, then inactive ones; newest first within each
    # group. StatusEnum only holds "active"/"inactive", so an ascending sort on
    # status already puts active ahead of inactive.
    rts = await RequestType.find(rt_filter).sort("+status", "-created_on").to_list()
    rt_ids = [str(rt.id) for rt in rts]
    if not rt_ids:
        return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}

    # Fetch categories + SLA rules for the filtered request_types.
    from bson import ObjectId as _OID
    cat_ids = list({rt.category_id for rt in rts})
    cat_oids = []
    for cid in cat_ids:
        try:
            cat_oids.append(_OID(cid))
        except Exception:
            cat_oids.append(cid)
    cats = {
        str(c.id): c.name
        for c in await Category.find({"_id": {"$in": cat_oids}}).to_list()
    }

    # Emit one row per (rt, rule) to match the wireframe's table shape.
    rows: list[dict[str, Any]] = []
    for rt in rts:
        rows.append(
            {
                "request_type_id": str(rt.id),
                "category_id": str(rt.category_id),
                "category_name": cats.get(str(rt.category_id)),
                "request_type_name": rt.name,
                "status": rt.status,
            }
        )

    total = len(rows)
    start = compute_skip(p)
    end = start + p.page_size
    return {
        "items": rows[start:end],
        "total": total,
        "page": p.page,
        "page_size": p.page_size,
    }


async def export_request_types(
    user: UserBase,
    *,
    q: str | None = None,
    category_id: str | None = None,
    priority: PriorityEnum | None = None,
    status: str | None = None,
) -> bytes:
    """Build an xlsx workbook of the request type / SLA table and return bytes.

    Honors the same q / category_id / priority / status filters as list_request_types
    but ignores pagination — exports every matching row.
    """
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    from bson import ObjectId as _OID

    rt_filter: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "deleted_on": None,
    }
    if category_id:
        rt_filter["category_id"] = try_oid(category_id)
    # Escaped + length-capped — see common.names.search_regex.
    q_lc = search_regex((q or "").lower())
    if q_lc:
        rt_filter["name_lc"] = {"$regex": q_lc, "$options": "i"}
    # "status" means the request type's own status, matching the list endpoint
    # and the category / workflow exports. Deactivating a request type does not
    # touch its embedded SLA rules, so filtering on rule status here would let
    # an inactive request type through as "active".
    if status and status.lower() != "all":
        rt_filter["status"] = status.lower()

    # Same ordering as the list endpoint: active rows first, then inactive,
    # newest first within each group.
    rts = await RequestType.find(rt_filter).sort("+status", "-created_on").to_list()
    rt_ids = [str(rt.id) for rt in rts]

    cats: dict[str, str] = {}
    if rt_ids:
        cat_ids = list({rt.category_id for rt in rts})
        cat_oids: list[Any] = []
        for cid in cat_ids:
            try:
                cat_oids.append(_OID(cid))
            except Exception:
                cat_oids.append(cid)
        cats = {
            str(c.id): c.name
            for c in await Category.find({"_id": {"$in": cat_oids}}).to_list()
        }

    rules_by_rt: dict[str, list[SLARule]] = {}
    for rt in rts:
        embedded_rules = [r for r in (rt.sla_rules or []) if not r.deleted_on]
        if priority:
            embedded_rules = [r for r in embedded_rules if r.priority == priority]
        rules_by_rt[str(rt.id)] = embedded_rules

    wb = Workbook()
    ws = wb.active
    ws.title = "Request Types"
    headers = [
        "Category",
        "Request Type",
        "Priority",
        "First Response (min)",
        "Resolution (min)",
        "Business Hours Only",
        "SLA Actions",
        "Status",
    ]
    ws.append(headers)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="334155")
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    for rt in rts:
        for r in rules_by_rt.get(str(rt.id), []):
            ws.append([
                cats.get(str(rt.category_id)) or "",
                rt.name,
                r.priority.value if hasattr(r.priority, "value") else str(r.priority),
                r.first_response_minutes,
                r.resolution_minutes,
                "Yes" if r.business_hours_only else "No",
                ", ".join(
                    (a.value if hasattr(a, "value") else str(a)).replace("_", " ")
                    for a in r.violation_actions
                ),
                rt.status.value if hasattr(rt.status, "value") else str(rt.status),
            ])

    widths = [22, 32, 12, 22, 18, 20, 32, 12]
    for col_idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = w
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def get_request_type(request_type_id: str, user: UserBase) -> dict[str, Any]:
    rt = await _load_rt(request_type_id, user.organisation_id)
    out = _rt_base(rt)
    out["sla_rules"] = [_sla_out(r) for r in rt.sla_rules if not r.deleted_on]
    return out


async def update_request_type(
    request_type_id: str, body: RequestTypeUpdate, user: UserBase
) -> dict[str, Any]:
    rt = await _load_rt(request_type_id, user.organisation_id)
    data = body.model_dump(exclude_unset=True)

    if "category_id" in data and data["category_id"] and data["category_id"] != rt.category_id:
        # Block if any non-terminal ticket / active workflow references this rt.
        _ = await _check_rt_not_in_use(rt)
        await _load_category(data["category_id"], user.organisation_id)
        rt.category_id = data["category_id"]

    if "name" in data and data["name"]:
        new_name = normalize_name(data["name"])
        new_name_lc = to_name_lc(new_name)
        rt.name = new_name
        rt.name_lc = new_name_lc

    if "description" in data:
        rt.description = data["description"]
    if "status" in data and data["status"] is not None:
        rt.status = StatusEnum(data["status"])

    # Replace SLA rules if sent.
    if body.sla_rules is not None:
        now = utcnow()
        contacts = await _resolve_recipient_contacts(body.sla_rules, user)
        # Carry each priority's existing rule id across the replace. The list is
        # rebuilt wholesale, and `SLARule.id` defaults to a fresh uuid4, so every
        # save used to re-mint all four ids — which dangled `sr.sla_rule_id` on
        # every in-flight ticket raised under this type. The SLA tick resolves
        # its rule by that id, so from the next save onwards those tickets
        # breached with no rule found and their violation actions silently
        # stopped running.
        #
        # Priority is the natural key: `RequestTypeUpdate._check_rules` requires
        # all four priorities exactly once, so a rule can never be added,
        # removed or reordered — only edited in place. `SLARuleIn` carries no
        # id, so matching on priority is also what keeps this a backend-only
        # change.
        existing_ids = {r.priority: r.id for r in (rt.sla_rules or [])}
        existing_created = {
            r.priority: (r.created_by, r.created_on) for r in (rt.sla_rules or [])
        }
        rt.sla_rules = []
        for r in body.sla_rules:
            prior_id = existing_ids.get(r.priority)
            created_by, created_on = existing_created.get(
                r.priority, (user.id, now)
            )
            rule = SLARule(
                priority=r.priority,
                first_response_minutes=r.first_response_minutes,
                resolution_minutes=r.resolution_minutes,
                business_hours_only=r.business_hours_only,
                description=r.description,
                violation_actions=r.violation_actions,
                notification_recipients=r.notification_recipients,
                notification_recipient_contacts=_contacts_for(r, contacts),
                status=r.status,
                # Creation metadata belongs to the original rule; an edit is a
                # modification of it, not a new rule wearing the same id.
                created_by=created_by,
                created_on=created_on,
                modified_by=user.id,
                modified_on=now,
            )
            if prior_id is not None:
                rule.id = prior_id
            rt.sla_rules.append(rule)

    rt.modified_by = user.id
    rt.modified_on = utcnow()
    await rt.save()

    try:
        await emit_audit(
            event="request_type.updated",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(rt.id)},
        )
    except Exception:  # noqa: BLE001
        pass

    out = _rt_base(rt)
    out["sla_rules"] = [_sla_out(r) for r in rt.sla_rules if not r.deleted_on]
    return out





async def _check_rt_not_in_use(rt: RequestType) -> None:
    active_wf = await Workflow.find(
        {
            "request_type_id": rt.id,
            "status": "active",
            "deleted_on": None,
        }
    ).count()
    if active_wf > 0:
        raise RequestTypeInUse()
    open_tickets = await ServiceRequest.find(
        {
            "request_type_id": rt.id,
            "request_status": {
                "$nin": [s.value for s in TERMINAL_STATUSES]
            },
        }
    ).count()
    if open_tickets > 0:
        raise RequestTypeInUse()


async def delete_request_type(request_type_id: str, user: UserBase) -> None:
    rt = await _load_rt(request_type_id, user.organisation_id)
    await _check_rt_not_in_use(rt)
    now = utcnow()
    rt.deleted_on = now
    rt.deleted_by = user.id
    rt.status = StatusEnum.INACTIVE
    rt.modified_by = user.id
    rt.modified_on = now
    await rt.save()
    # Cascade soft-delete embedded SLA rules.
    for r in rt.sla_rules:
        if not r.deleted_on:
            r.deleted_on = now
            r.deleted_by = user.id
    await rt.save()
    try:
        await emit_audit(
            event="request_type.deleted",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(rt.id), "rules_cascaded": len(rt.sla_rules)},
        )
    except Exception:  # noqa: BLE001
        pass


# ---------- Chapter 5: SLA lookup with fallback chain ----------

async def resolve_sla_for_priority(
    request_type_id: str, priority: PriorityEnum
) -> SLARule | None:
    from ..models import RequestType
    rt = await RequestType.get(request_type_id)
    if not rt or rt.deleted_on:
        return None
    by_priority = {r.priority: r for r in (rt.sla_rules or []) if not r.deleted_on}
    if priority in by_priority:
        return by_priority[priority]
    idx = PRIORITY_ORDER.index(priority)
    for p in reversed(PRIORITY_ORDER[:idx]):
        if p in by_priority:
            return by_priority[p]
    return None


# ---------- Chapter 5: active list for dropdowns ----------

async def list_active_categories(organisation_id: str) -> list[dict[str, Any]]:
    cats = await Category.find(
        {
            "organisation_id": try_oid(organisation_id),
            "status": StatusEnum.ACTIVE.value,
            "deleted_on": None,
        }
    ).sort("name_lc").to_list()
    # `department_id` is the deprecated dual-written mirror of
    # `department_ids[0]` (D12), so reading it raw silently drops every
    # department but the first for a multi-department category. Go through
    # `category_department_ids` like every other consumer, and expose the whole
    # list; the scalar is kept alongside it so existing clients don't break.
    from ..categories.service import category_department_ids

    out: list[dict[str, Any]] = []
    for c in cats:
        dept_ids = [str(d) for d in category_department_ids(c)]
        out.append({
            "id": str(c.id),
            "name": c.name,
            "department_id": dept_ids[0] if dept_ids else None,
            "department_ids": dept_ids,
        })
    return out


async def list_active_request_types_for_category(
    organisation_id: str, category_id: str
) -> list[dict[str, Any]]:
    rts = await RequestType.find(
        {
            "organisation_id": try_oid(organisation_id),
            "category_id": try_oid(category_id),
            "status": StatusEnum.ACTIVE.value,
            "deleted_on": None,
        }
    ).sort("name_lc").to_list()
    return [{"id": str(rt.id), "name": rt.name, "description": rt.description} for rt in rts]
