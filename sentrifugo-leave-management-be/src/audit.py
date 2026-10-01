"""Audit helpers for the leave-management service.

Canonical cross-service spec (matches IAM / SRM / schedule / timesheet):
  * module   = the emitting service — always ``"lms"``.
  * action   = ``"<entity>.<verb>"`` (dotted; the routing key is derived as
    ``audit.<action with dots->underscores>`` so it matches the central Logging
    Service's ``audit.*`` binding on the shared ``audit_events`` exchange).
  * resource = ``"<entity>:<id>"`` — the specific record the event is about.
  * metadata = canonical envelope ``{stream, correlation_id, organisation_id,
    details, [changed_fields]}``.

Two streams:
  * ``emit_activity`` — user-visible (Activity), ``DebugLevel.EMPLOYEE``.
  * ``emit_audit``    — ops/compliance (config & CRUD writes), ``DebugLevel.ADMIN``.

Both write to the transactional outbox (``outbox_events``) tagged with the shared
``audit_events`` exchange; the outbox relay publishes them reliably. Bypass-proof:
failures are logged and swallowed so a failed audit never breaks the caller.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from src.database import get_db
from src.logger import logger
from src.messaging.constants.events import DebugLevel, EventTypes
from src.messaging.outbox.models import outbox_event_to_mongo_doc

# Shared cross-service audit exchange (same name used by IAM / SRM / schedule /
# timesheet). The central Logging Service binds ``audit.*`` on this exchange.
AUDIT_EXCHANGE = "audit_events"
MODULE = "lms"


async def _publish(
    *,
    action: str,
    resource: str,
    actor_id: str | None,
    debug_level: DebugLevel,
    metadata: dict[str, Any],
) -> None:
    """Write a canonical audit event to the outbox. Never raises."""
    try:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "module": MODULE,
            "actor_id": actor_id or "system",
            "action": action,
            "resource": resource,
            "debug_level": int(debug_level),
            "metadata": metadata,
        }
        # Single-segment routing key so it matches the Logging Service's
        # ``audit.*`` binding (e.g. ``leave_request.applied`` -> ``audit.leave_request_applied``).
        routing_key = f"audit.{action.replace('.', '_')}"
        doc = outbox_event_to_mongo_doc(
            event_type=EventTypes.AUDIT,
            routing_key=routing_key,
            payload=payload,
            exchange=AUDIT_EXCHANGE,
        )
        db = get_db()
        await db["outbox_events"].insert_one(doc)
    except Exception as exc:  # noqa: BLE001 — audit must never break the operation
        logger.warning(
            "Audit emit failed (non-blocking)", action=action, error=repr(exc)
        )


async def emit_activity(
    *,
    action: str,
    resource: str,
    actor_id: str | None,
    organisation_id: str | None = None,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> None:
    """User-visible activity event — powers cross-service Activity views.

    ``action`` is dotted ``"<entity>.<verb>"`` (e.g. ``"leave_request.applied"``);
    ``resource`` is ``"<entity>:<id>"``.
    """
    await _publish(
        action=action,
        resource=resource,
        actor_id=actor_id,
        debug_level=DebugLevel.EMPLOYEE,
        metadata={
            "stream": "activity",
            "correlation_id": correlation_id,
            "organisation_id": organisation_id,
            "details": details or {},
        },
    )


async def emit_audit(
    *,
    action: str,
    resource: str,
    actor_id: str | None,
    organisation_id: str | None = None,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
    changed_fields: list[str] | None = None,
) -> None:
    """Ops / compliance audit event — config writes, CRUD, state changes.

    ``action`` is dotted ``"<entity>.<verb>"`` (e.g. ``"leave_type.created"``);
    ``resource`` is ``"<entity>:<id>"``. Pass ``changed_fields`` on updates.
    """
    metadata: dict[str, Any] = {
        "stream": "audit",
        "correlation_id": correlation_id,
        "organisation_id": organisation_id,
        "details": details or {},
    }
    if changed_fields is not None:
        metadata["changed_fields"] = changed_fields

    await _publish(
        action=action,
        resource=resource,
        actor_id=actor_id or "system",
        debug_level=DebugLevel.ADMIN,
        metadata=metadata,
    )
