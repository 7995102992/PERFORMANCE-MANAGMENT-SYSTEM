"""Resolve user email/name for email notifications.

Tries the IAM get_user call; falls back to session data or empty string.
"""
from __future__ import annotations

import logging

from ..integrations.iam_client import get_iam_client
from .iam_helpers import user_name

logger = logging.getLogger(__name__)


async def resolve_user_info(
    user_id: str, *, access_token: str | None = None
) -> dict:
    """Return {email, name} for a user/employee ID."""
    iam = get_iam_client()
    try:
        data = await iam.get_user(user_id, access_token=access_token)
    except Exception:
        data = None
    if not data:
        # Callers guard on a truthy email and skip sending, so an unresolved
        # user is a mail that silently never goes out. Say something: without
        # this line "nobody was emailed" and "nothing happened" look identical
        # in the logs, which is how the SLA breach email went unnoticed.
        logger.warning("resolve_user_info.unresolved user_id=%s", user_id)
        return {"email": "", "name": ""}
    email = (
        data.get("email")
        or data.get("workEmail")
        or data.get("work_email")
        or ""
    )
    if not email:
        logger.warning("resolve_user_info.no_email user_id=%s", user_id)
    name = user_name(data) or ""
    return {"email": email, "name": name}
