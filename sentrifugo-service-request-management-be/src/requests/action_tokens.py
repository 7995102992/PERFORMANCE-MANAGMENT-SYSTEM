"""Act-from-email: minting, validating and redeeming approval action tokens.

A recipient clicks Approve or Reject in their mail, lands on a page, and the
decision is recorded — no login, no session.

The token answers exactly one question: **who is acting**. Everything else —
may they act, is the ticket in a state that allows it, are they still the
current approver — is decided by the same domain function the UI calls. A link
can therefore never do something its recipient could not do in the app.

These links are bearer credentials: whoever holds the URL can act as the person
it was minted for, from any device. What limits the blast radius is that they
are single-use, short-lived, scoped to one recipient, one resource and one
capacity, and that the domain path still enforces everything. What does *not*
help is HTTPS or an unguessable UUID — the risk is the link being legitimately
forwarded, not intercepted.
"""
from __future__ import annotations

import logging
from datetime import timedelta, timezone
from typing import Any
from uuid import uuid4

from ..auth.utils.dependencies import UserBase
from ..common.timestamps import utcnow
from ..config import settings
from ..exceptions import ActionTokenExpired, InvalidActionToken
from ..integrations.iam_client import get_iam_client
from ..models import ActionToken, ServiceRequest

logger = logging.getLogger(__name__)

# Capacities a link can be minted for. Matched at redemption so an L1 link
# cannot be POSTed at the L2 endpoint to cast the other level's decision.
ROLE_L1 = "approver_l1"
ROLE_L2 = "approver_l2"


def role_for_level(level_index: int) -> str:
    return ROLE_L1 if level_index == 1 else ROLE_L2


async def mint_action_token(
    sr: ServiceRequest, *, actor_id: Any, actor_email: str, actor_role: str
) -> str | None:
    """Mint one single-use token for one recipient. Never raises.

    Returns None if minting fails, and the caller sends the mail without action
    buttons: a notification missing a button is a far better outcome than a
    missing notification — the recipient can still act in the app.

    One token per recipient, never one shared across everyone notified: a link
    acts as whoever it was minted for, so a shared token would let a forwarded
    mail act as the wrong person.
    """
    if not actor_id or not actor_email:
        return None
    try:
        token = str(uuid4())
        await ActionToken(
            organisation_id=sr.organisation_id,
            token=token,
            resource_id=sr.id,
            actor_id=actor_id,
            actor_email=actor_email,
            actor_role=actor_role,
            expires_at=utcnow()
            + timedelta(days=settings.EMAIL_ACTION_TOKEN_DAYS),
            created_on=utcnow(),
        ).insert()
        return token
    except Exception:  # noqa: BLE001 — never let this cost us the notification
        logger.exception("action_token.mint_failed resource=%s", str(sr.id))
        return None


async def validate_token(
    token: str, resource_id: str, *, role: str
) -> ActionToken:
    """Resolve a token for one resource and capacity, or raise.

    Checked in order — exists and unused, right resource, right capacity, then
    expiry — so an expired link reports TOKEN_EXPIRED rather than being lumped
    in with every other rejection. The page can then say something useful.
    """
    if not token:
        raise InvalidActionToken()
    tok = await ActionToken.find_one({"token": token, "deleted_on": None})
    if tok is None or tok.used_at is not None:
        raise InvalidActionToken()
    if str(tok.resource_id) != str(resource_id):
        raise InvalidActionToken()
    if tok.actor_role != role:
        raise InvalidActionToken()
    # BSON has no timezone, so a datetime read back from Mongo is naive while
    # `utcnow()` is aware — comparing them directly raises TypeError, which
    # would turn every redemption into a 500. Normalise before comparing.
    expires_at = tok.expires_at
    if expires_at is not None:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < utcnow():
            raise ActionTokenExpired()
    return tok


async def actor_from_token(tok: ActionToken) -> UserBase:
    """Build the acting user from the token, hydrating flags from IAM.

    Fails closed. The domain path waives some scoping for admins, so a synthetic
    user missing those flags is *narrower* than the same person's real session —
    never wider. If the IAM lookup errors we leave the flags off and accept the
    stricter answer rather than widening scope because a lookup failed.
    """
    user = UserBase(
        id=str(tok.actor_id),
        organisation_id=str(tok.organisation_id),
        email=tok.actor_email,
        display_name="",
    )
    try:
        data = await get_iam_client().get_user(str(tok.actor_id)) or {}
        user.display_name = (
            data.get("display_name")
            or data.get("full_name")
            or f"{data.get('first_name') or ''} {data.get('last_name') or ''}".strip()
        )
        user.is_super_admin = bool(data.get("is_super_admin"))
        user.is_org_admin = bool(data.get("is_org_admin"))
        perms = data.get("permissions")
        if isinstance(perms, dict):
            user.permissions = perms
        user.department_id = data.get("department_id") or None
        user.business_unit_id = data.get("business_unit_id") or None
    except Exception:  # noqa: BLE001
        logger.warning(
            "action_token.actor_hydrate_failed actor=%s — proceeding unflagged",
            str(tok.actor_id),
        )
    return user


async def burn_token(tok: ActionToken, action: str) -> None:
    """Mark the token spent. Call only *after* the action has succeeded.

    If the domain refused — wrong state, out of scope, someone else decided
    first — the token stays unused so the recipient can retry once the cause is
    gone. Burning on failure turns a transient problem into a dead link.
    """
    tok.used_at = utcnow()
    tok.used_action = action
    tok.modified_on = utcnow()
    await tok.save()


# Kept well past expiry so a late click still answers TOKEN_EXPIRED ("this link
# has expired") instead of the misleading INVALID_TOKEN ("already used"). Only
# after this does the row stop earning its keep.
TOKEN_RETENTION_DAYS = 30


async def purge_expired_tokens(retention_days: int = TOKEN_RETENTION_DAYS) -> dict:
    """Delete tokens long past expiry. Safe to run repeatedly.

    There is deliberately no TTL index on `expires_at`: Mongo would drop the row
    the moment it expired, and the very next click would report INVALID_TOKEN —
    telling the recipient the link was already used when it merely aged out. The
    grace window here is what keeps that message honest, and this sweep is what
    stops the collection growing without bound.
    """
    cutoff = utcnow() - timedelta(days=retention_days)
    res = await ActionToken.get_motor_collection().delete_many(
        {"expires_at": {"$lt": cutoff}}
    )
    logger.info(
        "action_token.purged deleted=%d retention_days=%d",
        res.deleted_count, retention_days,
    )
    return {"deleted": res.deleted_count, "retention_days": retention_days}
