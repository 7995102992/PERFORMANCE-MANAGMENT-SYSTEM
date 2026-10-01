from __future__ import annotations

import json
import logging

from beanie import PydanticObjectId
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from ...exceptions import Unauthorized
from ...valkey import get_valkey, session_key

logger = logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)


class UserBase(BaseModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId
    email: str | None = None
    display_name: str | None = None
    full_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    auth_method: str | None = None
    permissions: dict = Field(default_factory=dict)
    roles: list[str] = Field(default_factory=list)
    access_token: str | None = None

    def has_permission(self, module: str, action: str) -> bool:
        entry = self.permissions.get(module)
        if not entry:
            return False
        return bool(entry.get("actions", {}).get(action))


def _extract_token(request: Request, creds: HTTPAuthorizationCredentials | None) -> str:
    if creds and creds.credentials:
        return creds.credentials
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    raise Unauthorized("Missing bearer token")


def _coerce_bool(v) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("1", "true", "yes")


def _coerce_list(v) -> list[str]:
    if isinstance(v, list):
        return v
    if not v:
        return []
    try:
        parsed = json.loads(v)
        return parsed if isinstance(parsed, list) else [str(parsed)]
    except Exception:
        return [p.strip() for p in str(v).split(",") if p.strip()]


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserBase:
    token = _extract_token(request, creds)
    cache = get_valkey()
    try:
        raw_str = await cache.get(session_key(token))
    except Exception as e:
        logger.warning("valkey.get_session.failed err=%s", e)
        raise Unauthorized("Session store unavailable")
    if not raw_str:
        from ...config import settings
        # Local-development shim only: a client-supplied identity is never honoured
        # outside development. Anything other than an explicit
        # ENVIRONMENT=development (including unset/empty) is treated as production
        # and falls through to 401.
        if (settings.ENVIRONMENT or "").strip().lower() == "development":
            dev = request.headers.get("X-TSM-Dev-Session")
            if dev:
                try:
                    data = json.loads(dev)
                    return UserBase(**data, access_token=token)
                except Exception as e:
                    logger.warning("dev_session.parse_failed err=%s", e)
        raise Unauthorized("Session not found or expired")

    try:
        raw = json.loads(raw_str) if isinstance(raw_str, (str, bytes)) else raw_str
    except Exception as e:
        logger.warning("session.parse_failed err=%s", e)
        raise Unauthorized("Session payload malformed")

    permissions = raw.get("permissions") or {}
    if not isinstance(permissions, dict):
        permissions = {}

    display = raw.get("display_name") or raw.get("full_name") or ""

    return UserBase(
        id=str(raw.get("user_id") or raw.get("id", "")),
        organisation_id=str(raw.get("org_id") or raw.get("organisation_id") or ""),
        email=raw.get("email"),
        display_name=display,
        full_name=raw.get("full_name"),
        first_name=raw.get("first_name"),
        last_name=raw.get("last_name"),
        is_super_admin=_coerce_bool(raw.get("is_super_admin", False)),
        is_org_admin=_coerce_bool(raw.get("is_org_admin", False)),
        auth_method=raw.get("auth_method"),
        permissions=permissions,
        roles=_coerce_list(raw.get("roles", "[]")),
        access_token=token,
    )
