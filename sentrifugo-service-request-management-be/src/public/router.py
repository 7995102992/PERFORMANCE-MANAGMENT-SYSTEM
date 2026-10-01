"""Unauthenticated act-from-email endpoints.

Deliberately session-less: the caller is identified by a single-use token minted
when the approval notification was sent. See `requests.action_tokens` for the
security trade this represents.

Two rules hold this together:

* **POST only.** The emailed URL points at a landing page, which then POSTs. Mail
  clients and security scanners prefetch links, so a GET that decides anything
  would let a scanner approve tickets nobody clicked. The one GET here reads and
  never mutates.
* **No relaxed domain path.** Redemption calls the same `approve` / `reject` the
  UI calls. The token supplies *who*; every scope, permission and state check
  still runs, so an emailed link can never exceed what its recipient could do in
  the app.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..audit import emit_audit
from ..requests.action_tokens import (
    ROLE_L1,
    ROLE_L2,
    actor_from_token,
    burn_token,
    validate_token,
)
from ..requests.schemas import ApproveBody, RejectBody
from ..requests.service_actions import approve as domain_approve
from ..requests.service_actions import reject as domain_reject

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["public-actions"])


class TokenApproveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1)
    level: int = Field(1, ge=1, le=2)
    remarks: str | None = Field(None, max_length=1000)


class TokenRejectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1)
    level: int = Field(1, ge=1, le=2)
    # The domain requires a reason, so the landing page must collect one before
    # it POSTs — same rule the in-app reject dialog follows.
    reason: str = Field(min_length=1, max_length=2000)


def _role(level: int) -> str:
    return ROLE_L1 if level == 1 else ROLE_L2


async def _log_redemption(tok, sr_id: str, action: str) -> None:
    """Record that this decision arrived from an inbox, not the app.

    Best-effort: the decision is already committed by the time we get here, so
    an audit hiccup must not turn a successful approval into an error.
    """
    try:
        await emit_audit(
            event=f"request.{action}",
            actor_user_id=str(tok.actor_id),
            organisation_id=str(tok.organisation_id),
            details={
                "service_request_id": sr_id,
                "via": "email_link",
                "actor_role": tok.actor_role,
            },
        )
    except Exception:  # noqa: BLE001
        logger.warning("public_action.audit_failed sr=%s action=%s", sr_id, action)


@router.post("/requests/{request_id}/approve")
async def public_approve(request_id: str, body: TokenApproveBody) -> dict:
    """Approve from an emailed link."""
    tok = await validate_token(body.token, request_id, role=_role(body.level))
    user = await actor_from_token(tok)

    # The same call the UI makes — not a copy, not a relaxed variant.
    result = await domain_approve(request_id, ApproveBody(remarks=body.remarks), user)

    # Burned only now. Had the domain refused — wrong state, someone else got
    # there first — the token stays usable so the recipient can retry.
    await burn_token(tok, "approved")
    await _log_redemption(tok, request_id, "approved")
    return {"status": "approved", "request": result}


@router.post("/requests/{request_id}/reject")
async def public_reject(request_id: str, body: TokenRejectBody) -> dict:
    """Reject from an emailed link."""
    tok = await validate_token(body.token, request_id, role=_role(body.level))
    user = await actor_from_token(tok)

    result = await domain_reject(request_id, RejectBody(reason=body.reason), user)

    await burn_token(tok, "rejected")
    await _log_redemption(tok, request_id, "rejected")
    return {"status": "rejected", "request": result}


@router.get("/requests/{request_id}/action-context")
async def public_action_context(request_id: str, token: str, level: int = 1) -> dict:
    """What the landing page needs to render before it POSTs.

    Read-only by design: this is the one endpoint a link prefetcher can reach,
    so it must not mutate anything — it does not burn the token, and calling it
    repeatedly is harmless. It exists so the page can show *which* ticket is
    being decided instead of asking for a blind confirmation.

    Raises the same INVALID_TOKEN / TOKEN_EXPIRED the POSTs do, letting the page
    show the right message without attempting the action first.
    """
    tok = await validate_token(token, request_id, role=_role(level))
    from ..models import ServiceRequest

    sr = await ServiceRequest.get(request_id)
    if sr is None or sr.deleted_on is not None:
        from ..exceptions import DomainException

        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    return {
        "request_id": str(sr.id),
        "ticket_no": sr.ticket_no,
        "title": sr.title,
        "description": sr.description,
        "priority": sr.priority.value if sr.priority else None,
        "status": sr.request_status,
        "current_level_index": sr.current_level_index,
        "approval_level": tok.actor_role,
        "actor_email": tok.actor_email,
        "expires_at": tok.expires_at,
    }
