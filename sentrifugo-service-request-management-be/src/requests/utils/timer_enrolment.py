"""Re-enrol workflow-driven SLA-tick timers for in-flight tickets.

When EscalationConfig changes on a workflow (escalate_after_minutes,
pre_notify_minutes_before, or the master/pre-notify toggles), any
already-submitted tickets under that workflow have stale deadline entries
that would fire at the OLD time. This helper sweeps every non-terminal
ServiceRequest tied to the workflow and resets the ``auto_escalate`` and
``pre_notify`` entries to match the new EC.

Anchoring: deadlines are recomputed from ``ticket.submitted_on`` (not "now")
so the timer continues to mean "N minutes after submission". If the new
deadline is already in the past, we schedule for a few seconds from now so
the next SLA tick fires immediately — escalation is overdue and shouldn't
silently disappear.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Iterable

from ...common.timestamps import utcnow
from ...models import EscalationConfig, ServiceRequest, SLA_INACTIVE_STATUSES
from ...sla_store import drop, enrol

logger = logging.getLogger(__name__)


def _wants_auto_escalate(ec: EscalationConfig | None) -> bool:
    return bool(
        ec
        and ec.auto_escalate_enabled
        and ec.escalate_to_user_id
        and ec.escalate_after_minutes
        and ec.escalate_after_minutes > 0
    )


def _wants_pre_notify(ec: EscalationConfig | None) -> bool:
    return bool(
        ec
        and _wants_auto_escalate(ec)
        and ec.pre_notify_enabled
        and ec.pre_notify_minutes_before
        and ec.pre_notify_minutes_before > 0
        and ec.pre_notify_minutes_before < ec.escalate_after_minutes
    )


def _ticket_ids_iter(sr_iter: Iterable[ServiceRequest]) -> Iterable[str]:
    for sr in sr_iter:
        yield str(sr.id)


async def reenrol_workflow_timers(
    workflow_id: str, new_ec: EscalationConfig | None
) -> dict[str, int]:
    """Reset auto_escalate + pre_notify deadline entries for every non-terminal
    ticket attached to *workflow_id*.

    Returns a small summary so the caller / logs can see what happened.

    Note the scale: one EscalationConfig edit re-enrols every open ticket on the
    workflow, and any whose escalation window has already elapsed is clamped to
    ``now + 5s`` below — so on an existing database a single workflow save can
    make the entire backlog due on the next tick. ``settings.SLA_ENFORCE_FROM``
    does not help here (these deadlines are freshly stamped, not historical);
    what holds it back today is ``SLA_AUTO_ESCALATE_ENABLED`` being off, which
    makes the tick discard the entries unacted-on. Check which workflows carry
    escalation rules before enabling that flag.
    """
    srs = await ServiceRequest.find({
        "workflow_id": workflow_id,
        "deleted_on": None,
        "request_status": {"$nin": [s.value for s in SLA_INACTIVE_STATUSES]},
    }).to_list()

    summary = {
        "tickets_inspected": len(srs),
        "auto_escalate_enroled": 0,
        "pre_notify_enroled": 0,
        "removed_only": 0,
    }
    if not srs:
        return summary

    add_auto = _wants_auto_escalate(new_ec)
    add_pre = _wants_pre_notify(new_ec)

    now = utcnow()
    new_entries: dict[str, float] = {}
    stale: list[str] = []

    for sr in srs:
        tid = str(sr.id)
        # Always clear old entries first.
        stale.extend((f"{tid}:auto_escalate", f"{tid}:pre_notify"))

        if not add_auto:
            summary["removed_only"] += 1
            continue

        anchor = sr.submitted_on or sr.created_on or now
        escalate_at = anchor + timedelta(minutes=new_ec.escalate_after_minutes)
        # Past-due → push slightly into the future so the tick picks it up
        # promptly without competing with anything else.
        if escalate_at <= now:
            escalate_at = now + timedelta(seconds=5)
        new_entries[f"{tid}:auto_escalate"] = escalate_at.timestamp()
        summary["auto_escalate_enroled"] += 1

        if add_pre:
            pre_notify_at = escalate_at - timedelta(
                minutes=new_ec.pre_notify_minutes_before
            )
            if pre_notify_at <= now:
                pre_notify_at = now + timedelta(seconds=5)
            new_entries[f"{tid}:pre_notify"] = pre_notify_at.timestamp()
            summary["pre_notify_enroled"] += 1

    try:
        # Drop first, then re-enrol: a ticket that keeps its timer is written
        # back in the same call, and one that loses it stays dropped.
        await drop(*stale)
        if new_entries:
            await enrol(new_entries)
    except Exception as e:  # noqa: BLE001
        # Re-enrolment is best-effort. Log and return — the workflow update
        # itself has already succeeded, the worst case is some tickets fire
        # on the old timer one more time before catch-up at next update.
        logger.warning(
            "timer_reenrol.failed workflow=%s err=%s", workflow_id, e
        )
    else:
        logger.info(
            "timer_reenrol.done workflow=%s inspected=%d auto=%d pre=%d removed=%d",
            workflow_id,
            summary["tickets_inspected"],
            summary["auto_escalate_enroled"],
            summary["pre_notify_enroled"],
            summary["removed_only"],
        )
    return summary
