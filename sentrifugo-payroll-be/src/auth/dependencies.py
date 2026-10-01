"""Authentication dependency.

Default flow (matches every sibling service): IAM signs in the user and writes a
session blob to Valkey under ``session:<access_token>``. This service reads that
blob to resolve the caller — no local JWT signing key required. When
``IAM_BASE_URL`` is empty (local dev), an ``X-Payroll-Dev-Session`` header
carrying a JSON user blob is accepted as a stand-in so the API is usable without
a running IAM.
"""

from __future__ import annotations

import json

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from src.auth.schemas import UserBase
from src.config import settings
from src.correlation import set_current_user_id
from src.exceptions import Unauthorized
from src.logger import logger
from src.valkey import get_valkey, session_key

_bearer = HTTPBearer(auto_error=False)


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


def _build_user(raw: dict, token: str) -> UserBase:
    permissions = raw.get("permissions") or {}
    if not isinstance(permissions, dict):
        permissions = {}
    display = raw.get("display_name") or raw.get("full_name") or ""
    return UserBase(
        id=str(raw.get("user_id") or raw.get("id", "")),
        organisation_id=str(raw.get("org_id") or raw.get("organisation_id") or ""),
        business_unit_id=(str(raw["business_unit_id"]) if raw.get("business_unit_id") else None),
        email=raw.get("email"),
        display_name=display,
        full_name=raw.get("full_name"),
        first_name=raw.get("first_name"),
        last_name=raw.get("last_name"),
        is_super_admin=_coerce_bool(raw.get("is_super_admin", False)),
        is_org_admin=_coerce_bool(raw.get("is_org_admin", False)),
        payslip_admin=_coerce_bool(raw.get("payslip_admin", False)),
        auth_method=raw.get("auth_method"),
        permissions=permissions,
        roles=_coerce_list(raw.get("roles", "[]")),
        access_token=token,
    )


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserBase:
    token = _extract_token(request, creds)
    cache = get_valkey()
    try:
        raw_str = await cache.get(session_key(token))
    except Exception as e:
        logger.warning("valkey.get_session.failed", error=str(e))
        raise Unauthorized("Session store unavailable")

    if not raw_str:
        # Local-dev fallback: no IAM configured → accept a dev session header.
        if settings.IAM_BASE_URL == "":
            dev = request.headers.get("X-Payroll-Dev-Session")
            if dev:
                try:
                    user = _build_user(json.loads(dev), token)
                    set_current_user_id(user.id)
                    return user
                except Exception as e:
                    logger.warning("dev_session.parse_failed", error=str(e))
        raise Unauthorized("Session not found or expired")

    try:
        raw = json.loads(raw_str) if isinstance(raw_str, (str, bytes)) else raw_str
    except Exception as e:
        logger.warning("session.parse_failed", error=str(e))
        raise Unauthorized("Session payload malformed")

    user = _build_user(raw, token)
    set_current_user_id(user.id)
    return user
