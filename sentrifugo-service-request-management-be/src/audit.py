"""Domain-shaped audit helpers.

Two event vocabularies:
  - ActivityEventEnum  — user-visible (Activity tab)
  - config/ops audit   — free-form "<entity>.<verb>" strings

Both publish via the transactional outbox (RabbitMQ). The Logging/Audit
consumer on the other end persists and deduplicates.

Canonical cross-service spec (matches IAM / schedule):
  * module   = the emitting service — always ``"srm"``.
  * action   = ``"<domain>.<verb>"`` — activity events are request-scoped, so
    they are emitted as ``request.<verb>``; ops events already carry the
    ``<entity>.<verb>`` form (e.g. ``category.created``).
  * resource = ``"<entity>:<id>"`` — derived from the event's entity prefix and
    the ``id`` supplied in ``details``.
  * field-level diffs go to ``metadata.changed_fields`` (not nested in details).
"""
from __future__ import annotations

import logging
from typing import Any

from .models import ActivityEventEnum
from .rabbitmq import outbox
from .rabbitmq.constants import DebugLevel

logger = logging.getLogger("srm.audit")


async def emit_activity(
    *,
    event: ActivityEventEnum,
    service_request_id: str,
    actor_user_id: str,
    organisation_id: str,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> None:
    """User-visible activity event — powers Activity tab (Ch 8)."""
    await outbox.publish_audit_log(
        module="srm",
        actor_id=actor_user_id,
        action=f"request.{event.value}",
        resource=f"request:{service_request_id}",
        debug_level=DebugLevel.EMPLOYEE,
        metadata={
            "stream": "activity",
            "correlation_id": correlation_id,
            "organisation_id": organisation_id,
            "details": {"service_request_id": service_request_id, **(details or {})},
        },
    )


async def emit_audit(
    *,
    event: str,
    actor_user_id: str | None,
    organisation_id: str | None,
    details: dict[str, Any] | None = None,
    correlation_id: str | None = None,
) -> None:
    """Ops / compliance audit event — config writes, state changes, etc.

    ``event`` is ``"<entity>.<verb>"`` (e.g. ``category.created``). The entity
    instance is identified by ``details["id"]`` — it is lifted into the
    canonical ``resource = "<entity>:<id>"``. A ``details["fields"]`` list (set
    on updates) is lifted into ``metadata.changed_fields``.
    """
    details = dict(details or {})
    entity_id = details.pop("id", None)
    changed_fields = details.pop("fields", None)
    entity_type = event.split(".", 1)[0]
    resource = f"{entity_type}:{entity_id}" if entity_id else f"srm:{event}"

    metadata: dict[str, Any] = {
        "stream": "audit",
        "organisation_id": organisation_id,
        "details": details,
        "correlation_id": correlation_id,
    }
    if changed_fields is not None:
        metadata["changed_fields"] = changed_fields

    await outbox.publish_audit_log(
        module="srm",
        actor_id=actor_user_id or "system",
        action=event,
        resource=resource,
        debug_level=DebugLevel.ADMIN,
        metadata=metadata,
    )
