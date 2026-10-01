"""Audit helpers for the timesheet service.

Canonical cross-service spec (matches IAM / SRM / schedule):
  * module   = the emitting service — always ``"timesheet"``.
  * action   = ``"<entity>.<verb>"`` (dotted; the routing key is sanitized
    downstream in ``publish_audit_log``).
  * resource = ``"<entity>:<id>"`` — the specific record the event is about.
  * metadata = canonical envelope ``{stream, correlation_id, organisation_id,
    details, [changed_fields]}``.

Two streams:
  * ``emit_activity`` — user-visible (Activity tab), ``DebugLevel.EMPLOYEE``.
  * ``emit_audit``    — ops/compliance (config & CRUD writes), ``DebugLevel.ADMIN``.

Both go through ``publish_audit_log``, which is bypass-proof (swallows failures),
so neither helper can break the caller — no per-call-site try/except required.
"""
from __future__ import annotations

import logging
from typing import Any

from .rabbitmq import outbox
from .rabbitmq.constants import DebugLevel

logger = logging.getLogger("tsm.audit")


async def emit_activity(
    *,
    action: str,
    resource: str,
    actor_id: str,
    organisation_id: str | None,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> None:
    """User-visible activity event — powers the Activity tab.

    ``action`` is dotted ``"<entity>.<verb>"`` (e.g. ``"timesheet.submitted"``);
    ``resource`` is ``"<entity>:<id>"`` (e.g. ``f"timesheet:{ts_id}"``).
    """
    await outbox.publish_audit_log(
        module="timesheet",
        actor_id=actor_id,
        action=action,
        resource=resource,
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

    ``action`` is dotted ``"<entity>.<verb>"`` (e.g. ``"client.created"``);
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

    await outbox.publish_audit_log(
        module="timesheet",
        actor_id=actor_id or "system",
        action=action,
        resource=resource,
        debug_level=DebugLevel.ADMIN,
        metadata=metadata,
    )
