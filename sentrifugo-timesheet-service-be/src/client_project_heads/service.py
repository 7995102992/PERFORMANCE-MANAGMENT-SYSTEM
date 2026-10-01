from __future__ import annotations

import logging
from typing import Any

from ..audit import emit_audit
from ..auth.service import send_activation_email
from ..auth.utils.dependencies import UserBase
from ..common.access import can_access_client, hidden_client_ids, own_client_ids
from ..common.pagination import PageParams, compute_skip
from ..common.search import MAX_SEARCH_LENGTH
from ..common.timestamps import utcnow
from ..common.user_resolver import (
    create_iam_user,
    fetch_employees_in_scope,
    find_iam_user_by_email,
    update_iam_user,
)
from ..exceptions import (
    ClientNotFound,
    ClientProjectHeadEmailExists,
    ClientProjectHeadNotFound,
)
from ..models import Client, ClientProjectHead, StatusEnum
from .schemas import ClientProjectHeadCreate, ClientProjectHeadUpdate, ProjectHeadBulkAssign

logger = logging.getLogger(__name__)


def _to_out(doc: ClientProjectHead) -> dict[str, Any]:
    return {
        "id": str(doc.id),
        "organisation_id": str(doc.organisation_id),
        "client_id": str(doc.client_id),
        "first_name": doc.first_name,
        "last_name": doc.last_name,
        "email": doc.email,
        "phone": doc.phone,
        "iam_user_id": str(doc.iam_user_id) if doc.iam_user_id else None,
        "status": doc.status,
        "created_by": str(doc.created_by) if doc.created_by else None,
        "created_on": doc.created_on,
        "modified_by": str(doc.modified_by) if doc.modified_by else None,
        "modified_on": doc.modified_on,
    }


async def _client_scope_filter(user: UserBase) -> dict[str, Any] | None:
    """A ``client_id`` clause restricting rows to the clients this user may see.

    Project heads hang off clients, so they inherit the client's visibility: the
    viewer's department scope, narrowed for a non-admin to the clients behind their
    own projects — the same rule ``/clients`` applies. Returns None when nothing is
    restricted.
    """
    clause: dict[str, Any] = {}
    hidden = await hidden_client_ids(user, action="manage_clients")
    if hidden:
        clause["$nin"] = hidden
    own = await own_client_ids(user)
    if own is not None:
        clause["$in"] = list(own)
    return clause or None


def _in_scope(client_oid, scope: dict[str, Any]) -> bool:
    """Whether one client id satisfies a scope clause built by `_client_scope_filter`."""
    if "$in" in scope and client_oid not in scope["$in"]:
        return False
    return client_oid not in scope.get("$nin", [])


async def _load_client(client_id: str, user: UserBase) -> Client:
    client = await Client.get(client_id)
    if client is None or client.deleted_on is not None or client.organisation_id != user.organisation_id:
        raise ClientNotFound()
    if not await can_access_client(user, client, action="manage_clients"):
        raise ClientNotFound()
    own = await own_client_ids(user)
    if own is not None and client.id not in own:
        raise ClientNotFound()
    return client


async def _load_or_404(ph_id: str, user: UserBase) -> ClientProjectHead:
    doc = await ClientProjectHead.get(ph_id)
    if doc is None or doc.deleted_on is not None or doc.organisation_id != user.organisation_id:
        raise ClientProjectHeadNotFound()
    # A head is only reachable through a client the viewer can reach.
    own = await own_client_ids(user)
    if own is not None and doc.client_id not in own:
        raise ClientProjectHeadNotFound()
    return doc


async def _assign_head(
    client_oid,
    *,
    first_name: str,
    last_name: str,
    email: str,
    phone: str | None,
    user: UserBase,
) -> ClientProjectHead:
    """Attach one person (employee or external contact) to a client as a project head.

    Whoever already has an IAM login — an employee, or someone who heads another
    client — keeps it: no second user is created and no activation mail is sent. Only
    a genuinely new external contact gets a fresh login + activation mail.
    """
    email = email.lower().strip()

    # Same person, same client → genuine duplicate.
    if await ClientProjectHead.find_one({
        "organisation_id": user.organisation_id,
        "client_id": client_oid,
        "email": email,
        "deleted_on": None,
    }):
        raise ClientProjectHeadEmailExists()

    existing_user_id = await find_iam_user_by_email(email)
    if existing_user_id:
        iam_user_id = existing_user_id
        send_activation = False
    else:
        iam_user_id = await create_iam_user(
            email=email,
            first_name=first_name,
            last_name=last_name,
            organisation_id=str(user.organisation_id),
            created_by=str(user.id),
        )
        send_activation = True

    now = utcnow()
    doc = ClientProjectHead(
        organisation_id=user.organisation_id,
        client_id=client_oid,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        iam_user_id=iam_user_id,
        status=StatusEnum.ACTIVE,
        created_by=user.id,
        created_on=now,
    )
    await doc.insert()

    if send_activation:
        await send_activation_email(
            user_id=iam_user_id,
            email=email,
            full_name=f"{first_name} {last_name}".strip(),
            tenant_id=str(user.organisation_id),
        )

    await emit_audit(
        action="project_head.created",
        resource=f"project_head:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
    )
    return doc


async def create_project_head(body: ClientProjectHeadCreate, user: UserBase) -> dict[str, Any]:
    from beanie import PydanticObjectId
    await _load_client(body.client_id, user)
    doc = await _assign_head(
        PydanticObjectId(body.client_id),
        first_name=body.first_name,
        last_name=body.last_name,
        email=str(body.email),
        phone=body.phone,
        user=user,
    )
    return _to_out(doc)


async def bulk_assign_project_heads(body: ProjectHeadBulkAssign, user: UserBase) -> dict[str, Any]:
    """Assign several project heads to one client in a single call — the multi-select
    save. Entries may mix internal employees and external contacts; both arrive as
    name + email (exactly what /available returns for either group).

    Anyone already heading this client is skipped rather than failing the whole batch.
    """
    from beanie import PydanticObjectId
    await _load_client(body.client_id, user)
    client_oid = PydanticObjectId(body.client_id)

    created: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for head in body.heads:
        try:
            doc = await _assign_head(
                client_oid,
                first_name=head.first_name,
                last_name=head.last_name,
                email=str(head.email),
                phone=head.phone,
                user=user,
            )
            created.append(_to_out(doc))
        except ClientProjectHeadEmailExists:
            skipped.append({
                "email": str(head.email).lower().strip(),
                "reason": "already a project head for this client",
            })

    return {
        "created": created,
        "skipped": skipped,
        "total_created": len(created),
        "total_skipped": len(skipped),
    }


async def list_project_heads(
    user: UserBase,
    p: PageParams,
    *,
    client_id: str | None = None,
) -> dict[str, Any]:
    from beanie import PydanticObjectId
    filt: dict[str, Any] = {"organisation_id": user.organisation_id, "deleted_on": None}
    scope = await _client_scope_filter(user)
    if client_id:
        requested = PydanticObjectId(client_id)
        # An out-of-scope client asked for by id yields nothing rather than leaking.
        if scope and not _in_scope(requested, scope):
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        filt["client_id"] = requested
    elif scope:
        filt["client_id"] = scope
    skip = compute_skip(p)
    total = await ClientProjectHead.find(filt).count()
    items = await ClientProjectHead.find(filt).sort("-created_on").skip(skip).limit(p.page_size).to_list()
    return {"items": [_to_out(i) for i in items], "total": total, "page": p.page, "page_size": p.page_size}


def _search_term(q: str | None) -> str:
    """Normalise a picker search term: trimmed, lowercased, length-capped."""
    return (q or "").strip().lower()[:MAX_SEARCH_LENGTH]


def _matches(term: str, *fields: str | None) -> bool:
    """Whether any field contains ``term`` as a case-insensitive substring."""
    return any(term in (f or "").lower() for f in fields)


async def list_available_project_heads(
    user: UserBase,
    *,
    client_id: str | None = None,
    q: str | None = None,
) -> dict[str, Any]:
    """Candidates for a client's project heads, split into two selectable groups:

    ``employees``      – active employees inside the selected client's business unit
                         AND department scope (internal heads).
    ``external_heads`` – existing external project heads in the org, de-duplicated to
                         one entry per person (not one per client link).

    Anyone already heading the selected client is excluded from both groups, so a
    selection can never collide with an existing assignment.

    Args:
        q: Optional free-text filter applied to both groups, matching on the fields
            the picker labels rows with — first name, last name, full name, email,
            and emp code for employees. Absent or blank leaves the result unchanged.

    The filter is applied after both groups are assembled rather than pushed into
    the queries, because the unfiltered sets are what the exclusion and de-duplication
    rules are computed from: narrowing the reads first would let someone already
    heading the client reappear simply because their name did not match the term.
    Neither group is capped, so nothing is lost by filtering late.
    """
    target = str(client_id) if client_id else None
    term = _search_term(q)

    # ---- who already heads this client (excluded from both groups) ----
    # Scoped like the list: an external head attached only to clients this user
    # cannot see must not surface here either.
    head_filt: dict[str, Any] = {
        "organisation_id": user.organisation_id,
        "deleted_on": None,
        "status": StatusEnum.ACTIVE,
    }
    scope = await _client_scope_filter(user)
    if scope:
        head_filt["client_id"] = scope
    docs = await ClientProjectHead.find(head_filt).sort("-created_on").to_list()

    already_on_target: set[str] = {
        d.email for d in docs if target and str(d.client_id) == target
    }

    # ---- external project heads, de-duplicated per person ----
    client_oids = list({d.client_id for d in docs})
    clients = await Client.find({"_id": {"$in": client_oids}}).to_list() if client_oids else []
    client_name = {str(c.id): c.name for c in clients}

    people: dict[str, dict[str, Any]] = {}
    for d in docs:
        person = people.setdefault(d.email, {
            "id": str(d.id),
            "first_name": d.first_name,
            "last_name": d.last_name,
            "email": d.email,
            "phone": d.phone,
            "iam_user_id": str(d.iam_user_id) if d.iam_user_id else None,
            "client_ids": [],
            "client_names": [],
        })
        person["client_ids"].append(str(d.client_id))
        name = client_name.get(str(d.client_id))
        if name:
            person["client_names"].append(name)

    external = [p for email, p in people.items() if email not in already_on_target]
    external.sort(key=lambda x: (x["first_name"].lower(), x["last_name"].lower()))

    # ---- employees inside the selected client's BU + department scope ----
    employees: list[dict[str, Any]] = []
    if target:
        client = await _load_client(target, user)
        employees = await fetch_employees_in_scope(
            user.organisation_id,
            business_unit_ids=client.business_unit_ids,
            department_ids=client.department_ids,
        )
        # Drop anyone who already heads this client, and anyone already listed as an
        # external head (same person — don't offer them twice).
        external_emails = {p["email"] for p in external}
        employees = [
            e for e in employees
            if e["email"] and e["email"] not in already_on_target
            and e["email"] not in external_emails
        ]

    if term:
        # The full name is matched too, so "venkat r" finds what "venkat" and "r"
        # would each miss when tested against the parts separately.
        external = [
            p for p in external
            if _matches(term, p["first_name"], p["last_name"],
                        f"{p['first_name']} {p['last_name']}", p["email"])
        ]
        employees = [
            e for e in employees
            if _matches(term, e["first_name"], e["last_name"],
                        f"{e['first_name']} {e['last_name']}", e["email"], e["emp_code"])
        ]

    # Counts the matched set, so an empty result reads as "no matches" rather than
    # leaving the caller to guess whether it was truncated.
    return {
        "employees": employees,
        "external_heads": external,
        "total": len(employees) + len(external),
    }


async def get_project_head(ph_id: str, user: UserBase) -> dict[str, Any]:
    doc = await _load_or_404(ph_id, user)
    return _to_out(doc)


async def update_project_head(
    ph_id: str, body: ClientProjectHeadUpdate, user: UserBase
) -> dict[str, Any]:
    doc = await _load_or_404(ph_id, user)
    update_data = body.model_dump(exclude_unset=True)

    if "email" in update_data and update_data["email"]:
        new_email = update_data["email"].lower().strip()
        if new_email != doc.email:
            # Uniqueness is per client, not per organisation — the same person may
            # head other clients.
            conflict = await ClientProjectHead.find_one({
                "organisation_id": user.organisation_id,
                "client_id": doc.client_id,
                "email": new_email,
                "deleted_on": None,
            })
            if conflict:
                raise ClientProjectHeadEmailExists()
        update_data["email"] = new_email

    for field in ("first_name", "last_name", "email", "phone"):
        if field in update_data:
            setattr(doc, field, update_data[field])

    if "status" in update_data and update_data["status"] is not None:
        doc.status = StatusEnum(update_data["status"])

    if doc.iam_user_id and (
        "email" in update_data or "first_name" in update_data or "last_name" in update_data
    ):
        await update_iam_user(
            str(doc.iam_user_id),
            modified_by=str(user.id),
            email=doc.email,
            first_name=doc.first_name,
            last_name=doc.last_name,
        )

    doc.modified_by = user.id
    doc.modified_on = utcnow()
    await doc.save()

    await emit_audit(
        action="project_head.updated",
        resource=f"project_head:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
        changed_fields=list(body.model_dump(exclude_unset=True).keys()),
    )

    return _to_out(doc)


async def delete_project_head(ph_id: str, user: UserBase) -> None:
    doc = await _load_or_404(ph_id, user)
    now = utcnow()
    doc.deleted_on = now
    doc.deleted_by = user.id
    doc.status = StatusEnum.INACTIVE
    doc.modified_by = user.id
    doc.modified_on = now
    await doc.save()

    await emit_audit(
        action="project_head.deleted",
        resource=f"project_head:{doc.id}",
        actor_id=str(user.id),
        organisation_id=str(user.organisation_id),
    )
