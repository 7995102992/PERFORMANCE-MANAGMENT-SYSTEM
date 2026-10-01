"""Shared helpers for working with IAM user/employee data."""
from __future__ import annotations

from bson import ObjectId as _OID


def try_oid(val: str):
    try:
        return _OID(val)
    except Exception:
        return val


_MANAGER_ACLS = {"editor", "admin"}


def is_manager(permissions: dict) -> bool:
    """Check service_request module acl — editor/admin means manager."""
    entry = permissions.get("service_request")
    if not entry or not isinstance(entry, dict):
        return False
    acl = (entry.get("acl") or "").lower()
    return acl in _MANAGER_ACLS


def user_name(u: dict | None) -> str | None:
    if not u:
        return None
    name = u.get("display_name")
    if name:
        return name
    first = u.get("first_name") or u.get("firstName") or ""
    last = u.get("last_name") or u.get("lastName") or ""
    full = f"{first} {last}".strip()
    return full or u.get("name") or None
