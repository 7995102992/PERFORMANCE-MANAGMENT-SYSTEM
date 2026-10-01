"""Local replica of IAM departments — the fallback that keeps request-time
department lookups working when IAM is unreachable.

Two write paths feed the ``departments`` collection:

  * **write-through** — every successful live IAM department read is persisted
    here (:func:`upsert_from_read`), so anything seen at least once survives a
    later IAM outage.
  * **events** — the IAM domain-events consumer applies department.created /
    .updated (:func:`upsert_from_event`) and .deleted (:func:`mark_deleted`),
    so the copy stays fresh and covers departments that were never read.

:func:`get` returns the last-known IAM department dict (the verbatim read
response when we have one), so a fallback hit is shaped like a live read and
callers can treat the two identically.

IAM owns departments; nothing here writes back to IAM.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from ..models import DepartmentReplica

logger = logging.getLogger(__name__)


# IAM serialises departments inconsistently across endpoints/events (snake_case
# stored fields vs camelCase response aliases), so probe every known spelling.
def _first(d: dict, *keys: str) -> str | None:
    for k in keys:
        v = d.get(k)
        if v:
            return str(v)
    return None


def _head_of(d: dict) -> str | None:
    return _first(d, "head_user_id", "department_head", "departmentHead")


def _name_of(d: dict) -> str | None:
    return _first(d, "name", "department_name", "departmentName")


def _org_of(d: dict) -> str | None:
    return _first(d, "organisation_id", "organisationId", "org_id")


def _id_of(d: dict) -> str:
    return _first(d, "id", "_id", "department_id") or ""


async def upsert_from_read(dept: dict) -> None:
    """Persist a live IAM department response as the durable fallback copy."""
    dep_id = _id_of(dept)
    if not dep_id:
        return
    await _upsert(dep_id, dept, source="read")


async def upsert_from_event(payload: dict) -> None:
    """Apply a department.created / department.updated event payload."""
    dep_id = _id_of(payload)
    if not dep_id:
        logger.warning("dept_replica.event_missing_id payload=%s", payload)
        return
    await _upsert(dep_id, payload, source="event")


async def mark_deleted(department_id: str) -> None:
    """Tombstone a department on a department.deleted event."""
    coll = DepartmentReplica.get_motor_collection()
    await coll.update_one(
        {"_id": str(department_id)},
        {"$set": {"is_deleted": True, "synced_at": _now()}},
    )


async def list_by_org(organisation_id: str | None) -> list[dict]:
    """Return last-known (non-deleted) departments, optionally org-scoped."""
    coll = DepartmentReplica.get_motor_collection()
    query: dict[str, Any] = {"is_deleted": {"$ne": True}}
    if organisation_id:
        query["organisation_id"] = str(organisation_id)
    out: list[dict] = []
    for doc in await coll.find(query).to_list(length=None):
        raw = dict(doc.get("raw") or {})
        raw.setdefault("id", doc.get("_id"))
        out.append(raw)
    return out


async def get(department_id: str) -> dict | None:
    """Return the last-known IAM department dict, or None if unknown/deleted."""
    coll = DepartmentReplica.get_motor_collection()
    doc = await coll.find_one({"_id": str(department_id)})
    if not doc or doc.get("is_deleted"):
        return None
    # Start from the verbatim read response when present, then backfill the
    # keys callers depend on from the normalised columns (covers event-only
    # rows whose raw is sparse).
    result: dict[str, Any] = dict(doc.get("raw") or {})
    result.setdefault("id", str(department_id))
    if doc.get("head_user_id") and not _head_of(result):
        result["head_user_id"] = doc["head_user_id"]
    if doc.get("name") and not _name_of(result):
        result["name"] = doc["name"]
    if doc.get("organisation_id") and not _org_of(result):
        result["organisation_id"] = doc["organisation_id"]
    return result


# ── internals ────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _upsert(dep_id: str, data: dict, *, source: str) -> None:
    set_fields: dict[str, Any] = {
        "is_deleted": False,
        "source": source,
        "synced_at": _now(),
    }
    name, org, head = _name_of(data), _org_of(data), _head_of(data)
    if name is not None:
        set_fields["name"] = name
    if org is not None:
        set_fields["organisation_id"] = org
    # Only overwrite the head when the payload actually carries one — a
    # created/updated event with a null head must not erase a head we already
    # learned from a live read.
    if head is not None:
        set_fields["head_user_id"] = head

    coll = DepartmentReplica.get_motor_collection()
    if source == "read":
        # Full response — store verbatim so a fallback hit mirrors a live read.
        set_fields["raw"] = data
    else:
        # Event payloads are partial; merge non-null fields into existing raw
        # rather than clobbering a richer stored copy.
        existing = await coll.find_one({"_id": dep_id}, {"raw": 1})
        raw = dict((existing or {}).get("raw") or {})
        raw.update({k: v for k, v in data.items() if v is not None})
        set_fields["raw"] = raw

    await coll.update_one({"_id": dep_id}, {"$set": set_fields}, upsert=True)
