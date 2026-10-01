"""EscalationConfig.notify_on subscription support.

The 4 checkboxes the user can pick in the workflow form (assignment,
approval, escalation, sla_breach) are stored on ``EscalationConfig.notify_on``.
This helper is the one place that reads them: when a corresponding runtime
event fires, the workflow's escalation target gets copied on it so they can
watch tickets they own escalation responsibility for.

The escalate_to_user_id is the only "additional recipient" derivable from
the workflow today (the SLA rule has its own ``notification_recipients``
list — that one is consumed by ``_apply_violation_actions`` and stays
separate).
"""
from __future__ import annotations

import logging

from ...models import EscalationConfig
from ...rabbitmq import publish_event

logger = logging.getLogger(__name__)


# Event keys must match what the FE writes into ``notify_on`` (see
# Sentrifugo-FE/src/pages/service-request/workflow/WorkflowForm.tsx).
NOTIFY_ON_EVENTS = {"assignment", "approval", "escalation", "sla_breach"}


async def notify_watcher_if_subscribed(
    workflow_id: str | None,
    event_type: str,
    payload: dict,
) -> None:
    """If this workflow subscribes the escalation target to *event_type*,
    publish a watcher copy of the event so the email service notifies them.

    No-op when workflow_id is missing, the event type isn't in our known
    set, no EscalationConfig exists, the event isn't in notify_on, or no
    escalate_to_user_id is configured. Failure is swallowed and logged —
    watcher notifications must never break the primary action.
    """
    if not workflow_id or event_type not in NOTIFY_ON_EVENTS:
        return
    try:
        ec = await EscalationConfig.find_one(
            {"workflow_id": workflow_id, "deleted_on": None}
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("watcher.lookup.failed workflow=%s err=%s", workflow_id, e)
        return
    if not ec or not ec.escalate_to_user_id:
        return
    if event_type not in (ec.notify_on or []):
        return
    try:
        await publish_event(
            "watcher_notify",
            {
                "event_type": event_type,
                "watcher_user_id": str(ec.escalate_to_user_id),
                **payload,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("watcher.publish.failed workflow=%s err=%s", workflow_id, e)
