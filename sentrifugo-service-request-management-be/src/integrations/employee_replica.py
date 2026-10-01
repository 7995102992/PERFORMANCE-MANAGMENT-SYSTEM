"""Local replica of IAM users/employees — the fallback that keeps request-time
identity lookups working when IAM is unreachable (approval submit, assign /
reassign, manual escalate, the approver/escalation pickers).

Keyed by **user_id** — the id SRM passes everywhere (approver_user_id,
executor_user_id, head_user_id, requester_user_id). Two write paths feed it:

  * **write-through** — every successful live IAM read is persisted here
    (:func:`upsert_read`), keyed by the id that was looked up.
  * **events** — the IAM consumer applies employee.created / .updated
    (:func:`upsert_event`) and .deleted (:func:`mark_deleted`).

:func:`get` returns the merged last-known doc shaped so callers can read it like
a live /users or /employees response (name/email/org + l1/l2 managers +
policies). IAM owns users; nothing here writes back.

NOTE: this populates lazily (read/event driven). Seeding pre-existing users is
deferred — see the backfill discussion; until then a never-seen user during a
cold IAM outage still misses.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from ..models import EmployeeReplica

logger = logging.getLogger(__name__)


# IAM serialises users/employees with mixed casing across endpoints/events
# (snake_case stored fields vs camelCase response aliases) — probe every spelling.
def _first(d: dict, *keys: str) -> str | None:
    for k in keys:
        v = d.get(k)
        if v:
            return str(v)
    return None


def _name_of(d: dict) -> str | None:
    n = _first(d, "name", "display_name", "displayName", "full_name", "fullName")
    if n:
        return n
    first = d.get("first_name") or d.get("firstName") or ""
    last = d.get("last_name") or d.get("lastName") or ""
    return f"{first} {last}".strip() or None


def _email_of(d: dict) -> str | None:
    return _first(d, "email", "work_email", "workEmail")


def _org_of(d: dict) -> str | None:
    return _first(d, "organisation_id", "organisationId", "org_id")


def _l1_of(d: dict) -> str | None:
    return _first(d, "l1_manager_id", "l1ManagerId")


def _l2_of(d: dict) -> str | None:
    return _first(d, "l2_manager_id", "l2ManagerId")


def _dept_of(d: dict) -> str | None:
    return _first(d, "department_id", "departmentId")


def _policies_of(d: dict) -> list | None:
    p = d.get("policies")
    return p if isinstance(p, list) else None


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def upsert_read(user_id: str, data: dict) -> None:
    """Write-through a live IAM user/employee response, keyed by the looked-up id."""
    if not user_id:
        return
    await _upsert(str(user_id), data, source="read")


async def upsert_event(user_id: str, payload: dict) -> None:
    """Apply an employee.created / employee.updated event payload."""
    if not user_id:
        logger.warning("emp_replica.event_missing_id payload=%s", payload)
        return
    await _upsert(str(user_id), payload, source="event")


async def mark_deleted(user_id: str) -> None:
    """Tombstone a user on an employee.deleted event."""
    coll = EmployeeReplica.get_motor_collection()
    await coll.update_one(
        {"_id": str(user_id)},
        {"$set": {"is_deleted": True, "synced_at": _now()}},
    )


async def get(user_id: str) -> dict | None:
    """Return the last-known user/employee dict, or None if unknown/deleted."""
    coll = EmployeeReplica.get_motor_collection()
    doc = await coll.find_one({"_id": str(user_id)})
    if not doc or doc.get("is_deleted"):
        return None
    # Start from the verbatim read response when present, then backfill the keys
    # callers depend on from the normalised columns (covers event-only rows).
    result: dict[str, Any] = dict(doc.get("raw") or {})
    result.setdefault("id", str(user_id))
    for col, getter in (("name", _name_of), ("email", _email_of), ("organisation_id", _org_of)):
        if doc.get(col) and not getter(result):
            result[col] = doc[col]
    if doc.get("l1_manager_id") and not _l1_of(result):
        result["l1_manager_id"] = doc["l1_manager_id"]
    if doc.get("l2_manager_id") and not _l2_of(result):
        result["l2_manager_id"] = doc["l2_manager_id"]
    if doc.get("policies") and not _policies_of(result):
        result["policies"] = doc["policies"]
    return result


async def list_by_org(organisation_id: str | None, department_id: str | None = None) -> list[dict]:
    """Return last-known (non-deleted) employees, optionally org/dept-scoped."""
    coll = EmployeeReplica.get_motor_collection()
    query: dict[str, Any] = {"is_deleted": {"$ne": True}}
    if organisation_id:
        query["organisation_id"] = str(organisation_id)
    if department_id:
        query["department_id"] = str(department_id)
    out: list[dict] = []
    for doc in await coll.find(query).to_list(length=None):
        raw = dict(doc.get("raw") or {})
        raw.setdefault("id", doc.get("_id"))
        if doc.get("policies") and not _policies_of(raw):
            raw["policies"] = doc["policies"]
        out.append(raw)
    return out


async def list_report_levels_by_manager(
    manager_user_id: str, organisation_id: str | None = None
) -> dict[str, int]:
    """Map of report user id -> 1 or 2, for employees managed by `manager_user_id`.

    1 means the manager is that employee's L1, 2 means L2. L1 wins when the
    same person occupies both slots.

    The reporting tree as this replica last saw it. Because the replica fills
    lazily (see the module docstring), an employee IAM has never handed us is
    absent here — callers that need completeness must treat an empty result as
    "unknown" and fall back to a live IAM sweep rather than "no reports".
    """
    coll = EmployeeReplica.get_motor_collection()
    mid = str(manager_user_id)
    query: dict[str, Any] = {
        "is_deleted": {"$ne": True},
        "$or": [{"l1_manager_id": mid}, {"l2_manager_id": mid}],
    }
    if organisation_id:
        query["organisation_id"] = str(organisation_id)
    docs = await coll.find(
        query, {"_id": 1, "l1_manager_id": 1, "l2_manager_id": 1}
    ).to_list(length=None)
    out: dict[str, int] = {}
    for d in docs:
        out[str(d["_id"])] = 1 if str(d.get("l1_manager_id") or "") == mid else 2
    return out


# ── internals ────────────────────────────────────────────────────────────────

async def _upsert(uid: str, data: dict, *, source: str) -> None:
    set_fields: dict[str, Any] = {"is_deleted": False, "source": source, "synced_at": _now()}
    for col, val in (
        ("employee_id", _first(data, "employee_id")),
        ("name", _name_of(data)),
        ("email", _email_of(data)),
        ("organisation_id", _org_of(data)),
        ("l1_manager_id", _l1_of(data)),
        ("l2_manager_id", _l2_of(data)),
        ("department_id", _dept_of(data)),
    ):
        if val is not None:
            set_fields[col] = val
    pols = _policies_of(data)
    if pols is not None:
        set_fields["policies"] = pols

    coll = EmployeeReplica.get_motor_collection()
    if source == "read":
        # Full response — store verbatim so a fallback hit mirrors a live read.
        set_fields["raw"] = data
    else:
        # Event payloads are partial; merge non-null fields into existing raw.
        existing = await coll.find_one({"_id": uid}, {"raw": 1})
        raw = dict((existing or {}).get("raw") or {})
        raw.update({k: v for k, v in data.items() if v is not None})
        set_fields["raw"] = raw

    await coll.update_one({"_id": uid}, {"$set": set_fields}, upsert=True)
