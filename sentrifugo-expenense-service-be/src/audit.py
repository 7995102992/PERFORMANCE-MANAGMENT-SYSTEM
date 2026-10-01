"""Domain-agnostic audit helpers for the Expense service.

Two event vocabularies share one transport:
  - **activity** — user-visible events that power an entity's Activity tab.
  - **audit**    — ops / compliance events for config writes and state changes.

Both publish via the transactional outbox (RabbitMQ). The Logging/Audit
consumer on the other end persists and deduplicates.

Canonical cross-service spec (matches IAM / SRM / payroll):
  * ``module``   = the emitting service — always ``"expense"``.
  * ``action``   = ``"<entity>.<verb>"`` (e.g. ``claim.submitted``).
  * ``resource`` = ``"<entity>:<id>"``.
  * field-level diffs go to ``metadata.changed_fields`` (not nested in details).

Event types are plain strings here: this module deliberately knows nothing
about the expense domain, so domain modules own their own vocabulary.

Callers pass a **flat** ``details`` dict and the tenant as ``organisation_id``;
``outbox.publish_audit_log`` builds the canonical metadata envelope
(``{stream, correlation_id, organisation_id, details, [changed_fields]}``) and
stamps ``correlation_id`` from the request context itself. Do not pre-wrap the
envelope here — it would nest ``details`` twice and leave the tenant null.

Audit emission is best-effort — a broker or outbox failure is logged and
swallowed so it can never break the caller's business transaction.
"""

from __future__ import annotations

from typing import Any

from src.logger import logger
from src.rabbitmq import outbox
from src.rabbitmq.constants import DebugLevel

MODULE = "expense"


async def emit_activity(
    *,
    event: str,
    entity_type: str,
    entity_id: str,
    actor_user_id: str,
    organisation_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Emit a user-visible activity event.

    Args:
        event: Bare verb for the event (e.g. ``"submitted"``). Combined with
            ``entity_type`` into the canonical ``"<entity>.<verb>"`` action.
        entity_type: Entity the event is about (e.g. ``"claim"``).
        entity_id: Identifier of the entity instance.
        actor_user_id: User who performed the action.
        organisation_id: Tenant the entity belongs to.
        details: Extra event-specific payload surfaced to the Activity tab.
    """
    try:
        await outbox.publish_audit_log(
            module=entity_type,
            actor_id=actor_user_id,
            action=f"{entity_type}.{event}",
            resource=f"{entity_type}:{entity_id}",
            debug_level=DebugLevel.EMPLOYEE,
            organisation_id=organisation_id,
            stream="activity",
            metadata={"entity_type": entity_type, "entity_id": entity_id, **(details or {})},
        )
    except Exception as e:
        logger.warning("activity_event.publish_failed", event=event, entity=f"{entity_type}:{entity_id}", error=str(e))


async def emit_audit(
    *,
    event: str,
    actor_user_id: str | None,
    organisation_id: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    """Emit an ops / compliance audit event — config writes, state changes, etc.

    ``event`` is ``"<entity>.<verb>"`` (e.g. ``category.created``). The entity
    instance is identified by ``details["id"]`` — it is lifted into the
    canonical ``resource = "<entity>:<id>"``. A ``details["fields"]`` list (set
    on updates) is lifted into ``metadata.changed_fields``.

    Args:
        event: Qualified ``"<entity>.<verb>"`` event name.
        actor_user_id: User who performed the action; ``"system"`` when absent.
        organisation_id: Tenant the change belongs to.
        details: Event payload; ``id`` and ``fields`` keys are lifted out.
    """
    details = dict(details or {})
    entity_id = details.pop("id", None)
    changed_fields = details.pop("fields", None)
    entity_type = event.split(".", 1)[0]
    resource = f"{entity_type}:{entity_id}" if entity_id else f"{MODULE}:{event}"

    metadata: dict[str, Any] = dict(details)
    if changed_fields is not None:
        metadata["changed_fields"] = changed_fields

    try:
        await outbox.publish_audit_log(
            module=entity_type,
            actor_id=actor_user_id or "system",
            action=event,
            resource=resource,
            debug_level=DebugLevel.ADMIN,
            organisation_id=organisation_id,
            metadata=metadata,
        )
    except Exception as e:
        logger.warning("audit_event.publish_failed", event=event, resource=resource, error=str(e))
