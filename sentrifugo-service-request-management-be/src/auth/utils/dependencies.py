"""Auth dependencies.

Per Foundation §10: SRM does not validate JWTs itself. IAM writes a session
projection to Valkey at `session:<access_token>` and SRM reads it. The
bearer token in the Authorization header is used verbatim as the key.

If the session is missing or expired → 401. The projection payload shape is
IAM-defined (single writer = source of truth). IAM stores the session as a
JSON-encoded string via `valkey.set(...)`; we read with `get` + `json.loads`:

    {
      "user_id":          str,
      "org_id":           str,
      "email":            str (optional),
      "full_name":        str (optional),
      "first_name":       str (optional),
      "last_name":        str (optional),
      "is_super_admin":   bool,
      "is_org_admin":     bool,
      "auth_method":      str (optional),
      "permissions": {
          "<module>": {
              "acl": "admin|editor|viewer",
              "actions": {"create": bool, "read": bool, "update": bool,
                          "delete": bool, "export": bool}
          }
      },
      "roles":            list[str]   # optional
    }
"""
from __future__ import annotations

import json
import logging

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from ...exceptions import Unauthorized
from ...valkey import get_valkey, session_key

logger = logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)


class UserBase(BaseModel):
    id: str
    organisation_id: str
    email: str | None = None
    display_name: str | None = None
    full_name: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    is_super_admin: bool = False
    is_org_admin: bool = False
    auth_method: str | None = None
    # IAM's nested permission grid: {module: {acl, actions: {action: bool}}}
    permissions: dict = Field(default_factory=dict)
    roles: list[str] = Field(default_factory=list)
    # IAM-resolved department id + business unit id (from EmployeeDocument).
    # None for users without an employee record (super admins, cross-org
    # accounts). Used to scope visibility of restricted catalog categories.
    department_id: str | None = None
    business_unit_id: str | None = None
    access_token: str | None = None  # echoed back, useful for idempotency keying

    def has_permission(self, module: str, action: str) -> bool:
        entry = self.permissions.get(module)
        if not entry:
            return False
        return bool(entry.get("actions", {}).get(action))

    @property
    def oid(self):
        """User id as an ObjectId for Mongo filters/comparisons (None if unset)."""
        from bson import ObjectId
        return ObjectId(self.id) if ObjectId.is_valid(self.id) else None

    @property
    def org_oid(self):
        """Organisation id as an ObjectId for Mongo filters (None for super admin)."""
        from bson import ObjectId
        return ObjectId(self.organisation_id) if ObjectId.is_valid(self.organisation_id) else None


def _extract_token(request: Request, creds: HTTPAuthorizationCredentials | None) -> str:
    # FastAPI's HTTPBearer handles the Authorization header; we also tolerate
    # the raw header for test clients that bypass the security schema.
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
    except Exception:  # noqa: BLE001
        return [p.strip() for p in str(v).split(",") if p.strip()]


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> UserBase:
    token = _extract_token(request, creds)
    cache = get_valkey()
    raw_str = await cache.get(session_key(token))
    if not raw_str:
        # Dev-only escape hatch — accept a JSON-encoded session via header
        # X-SRM-Dev-Session for local testing when IAM isn't running.
        # Honoured ONLY when ENVIRONMENT == "development" AND the IAM client is
        # in stub mode. Any other environment (including unset / blank, which
        # settings reads as production) ignores the header and 401s: the header
        # is self-asserted, so outside development it is a tenant takeover.
        from ...config import settings
        if settings.IS_DEVELOPMENT and settings.IAM_BASE_URL == "":
            dev = request.headers.get("X-SRM-Dev-Session")
            if dev:
                try:
                    data = json.loads(dev)
                    return UserBase(**data, access_token=token)
                except Exception as e:  # noqa: BLE001
                    logger.warning("dev_session.parse_failed err=%s", e)
        raise Unauthorized("Session not found or expired")

    try:
        raw = json.loads(raw_str) if isinstance(raw_str, (str, bytes)) else raw_str
    except Exception as e:  # noqa: BLE001
        logger.warning("session.parse_failed err=%s", e)
        raise Unauthorized("Session payload malformed")

    permissions = raw.get("permissions") or {}
    if not isinstance(permissions, dict):
        logger.warning("session.permissions.unexpected_shape type=%s", type(permissions).__name__)
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
        department_id=raw.get("department_id"),
        business_unit_id=raw.get("business_unit_id"),
        access_token=token,
    )
