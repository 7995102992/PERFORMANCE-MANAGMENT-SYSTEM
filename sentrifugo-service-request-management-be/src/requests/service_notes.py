"""Internal notes + activity proxy — Chapter 8."""
from __future__ import annotations

from typing import Any

from ..audit import emit_activity
from ..common.iam_helpers import user_name
from ..auth.utils.dependencies import UserBase
from ..common.timestamps import utcnow
from ..exceptions import (
    InternalNoteBodyRequired,
    InternalNoteForbidden,
    RequestTerminal,
)
from ..integrations.iam_client import get_iam_client
from ..integrations.logging_client import get_logging_client
from ..models import (
    ActivityEventEnum,
    InternalNote,
    ServiceRequest,
    TERMINAL_STATUSES,
)
from ..rabbitmq import publish_event
from .schemas import InternalNoteBody
from .service_detail import compute_capabilities, require_ticket_access


async def _load(sr_id: str, organisation_id: str) -> ServiceRequest:
    sr = await ServiceRequest.get(sr_id)
    if sr is None or sr.deleted_on is not None or str(sr.organisation_id) != organisation_id:
        from ..exceptions import DomainException
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    return sr


async def list_internal_notes(sr_id: str, user: UserBase) -> dict[str, Any]:
    sr = await _load(sr_id, user.organisation_id)
    await require_ticket_access(sr, user)
    # Same gate the FE uses to show the Internal Notes tab — handlers only,
    # never the requester.
    caps = await compute_capabilities(sr, user)
    if not caps["can_see_internal_notes"]:
        raise InternalNoteForbidden()
    rows = (
        await InternalNote.find(
            {"service_request_id": sr.id, "deleted_on": None}
        )
        .sort("-created_on")
        .to_list()
    )
    iam = get_iam_client()
    authors = await iam.get_users(list({str(n.author_user_id) for n in rows}), access_token=user.access_token)
    return {
        "items": [
            {
                "id": str(n.id),
                "author_user_id": str(n.author_user_id),
                "author_name": user_name(authors.get(str(n.author_user_id))),
                "author_role": None,
                "body": n.body,
                "created_on": n.created_on,
            }
            for n in rows
        ],
        "total": len(rows),
    }


async def add_internal_note(
    sr_id: str, body: InternalNoteBody, user: UserBase
) -> dict[str, Any]:
    if not body.body or not body.body.strip():
        raise InternalNoteBodyRequired()
    sr = await _load(sr_id, user.organisation_id)
    if sr.request_status in TERMINAL_STATUSES:
        raise RequestTerminal()
    await require_ticket_access(sr, user)
    # Authorise by ticket relationship (parity with the FE capability): the
    # executor / handler — including a self-assigned executor — can post; the
    # requester cannot, even with a manager policy.
    caps = await compute_capabilities(sr, user)
    if not caps["can_add_internal_note"]:
        raise InternalNoteForbidden()
    now = utcnow()
    note = InternalNote(
        service_request_id=str(sr.id),
        author_user_id=user.id,
        body=body.body,
        created_by=user.id,
        created_on=now,
    )
    await note.insert()
    await publish_event(
        "comment_added",  # internal-note shares the channel for v1
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "internal_note_id": str(note.id),
            "actor_user_id": user.id,
            "stream": "internal_note",
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.INTERNAL_NOTE_ADDED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"internal_note_id": str(note.id)},
        )
    except Exception:  # noqa: BLE001
        pass
    return {
        "id": str(note.id),
        "author_user_id": user.id,
        "body": note.body,
        "created_on": note.created_on,
    }


# ---------- Activity tab proxy ----------

async def get_activity(sr_id: str, user: UserBase, *, limit: int = 200) -> dict[str, Any]:
    sr = await _load(sr_id, user.organisation_id)
    await require_ticket_access(sr, user)
    client = get_logging_client()
    events = await client.query_activity(
        service_request_id=str(sr.id), limit=limit
    )
    # Batch-resolve actor names.
    actor_ids = {e.get("actor_user_id") for e in events if e.get("actor_user_id")}
    iam = get_iam_client()
    users = await iam.get_users(list(actor_ids), access_token=user.access_token)
    items = []
    for e in events:
        uid = e.get("actor_user_id")
        items.append(
            {
                **e,
                "actor_name": user_name(users.get(uid)) if uid else None,
            }
        )
    return {"items": items, "total": len(items)}
