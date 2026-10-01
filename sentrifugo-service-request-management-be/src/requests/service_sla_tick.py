"""SLA tick — Chapter 8.

Driven by the in-process loop in ``requests/sla_scheduler.py``. The original
design had the Schedule Service calling this every 60s over
``/_internal/jobs/sla-tick``, but that service is message-driven and has no
scheduler, so nothing ever called it — which is why no ticket has ever
escalated. The endpoint still exists for an external cron; set
SLA_TICK_INTERVAL_SECONDS=0 to use it instead of the loop.

Algorithm:
  1. Now = utcnow().
  2. Claim up to 500 due entries out of Mongo (``sla_store.claim_due``). Each is
     taken with an atomic find-and-update, so replicas cannot pop the same one.
     Claiming deletes: an entry is consumed whether or not it is acted on.
  3. Each entry is `{ticket_id}:{event}`, event ∈ {first_response, resolution,
     auto_escalate, pre_notify}.
     - Discard if older than settings.SLA_ENFORCE_FROM.
     - Load ticket; skip if in SLA_INACTIVE_STATUSES.
     - auto_escalate / pre_notify are the workflow's own timers, gated behind
       SLA_AUTO_ESCALATE_ENABLED (default off).
     - Discard if the ticket's SLA rule is no longer in force — rule or
       request type deactivated or soft-deleted, or the id no longer resolves.
       Nothing is emitted for these: a deadline means nothing without the rule
       that set it, and mailing an assignee about an SLA an admin switched off
       is the bug this guard exists for.
     - Otherwise emit SLA_BREACHED, mail the assignee, and apply
       violation_actions:
        * change_priority → bump one step, capped at URGENT.
        * reassign → route to the workflow's escalate_to_user_id.
        * send_alert / send_notification are not handled here. They used to
          publish to `srm.request.sla.*`, which nothing consumes; recipients are
          now mailed directly by ``_notify_recipients`` when an action actually
          took effect.
  4. Return a summary.

Known gap: the `warnings` branch below is unreachable — claim_due already
filters to due_at <= now, so `breached` is always true. SLARule has no
warning-threshold field to drive a real pre-warning.
"""
from __future__ import annotations

import logging
from typing import Any

from ..audit import emit_activity
from ..common.timestamps import utcnow
from ..config import settings
from ..integrations.iam_client import get_iam_client
from ..models import (
    ActivityEventEnum,
    EscalationConfig,
    HandoffEvent,
    HandoffKindEnum,
    PriorityEnum,
    PRIORITY_ORDER,
    RequestStatusEnum,
    SLA_INACTIVE_STATUSES,
    SLARule,
    SLAViolationAction,
    ServiceRequest,
    SYSTEM_ACTOR_ID,
    TERMINAL_STATUSES,
)
from ..rabbitmq import publish_event
from ..sla_store import claim_due, enrol
from .utils.self_dealing import is_requester
from .utils.sla import rule_in_force as sla_rule_in_force
from .utils.watcher import notify_watcher_if_subscribed

logger = logging.getLogger(__name__)

MAX_PER_TICK = 500


async def run_sla_tick() -> dict[str, int]:
    now = utcnow()
    now_ts = now.timestamp()

    # Claim and remove in one step per entry — see sla_store.claim_due. The
    # entries are already consumed by the time we start processing them, which
    # is the behaviour this loop was written against.
    try:
        entries = await claim_due(now, MAX_PER_TICK)
    except Exception as e:  # noqa: BLE001
        logger.warning("sla_tick.claim.failed err=%s", e)
        return {"processed": 0, "warnings": 0, "breaches": 0, "errors": 1}

    if not entries:
        return {"processed": 0, "warnings": 0, "breaches": 0}

    # Deadlines older than the cutoff are discarded unacted-on — see
    # settings.SLA_ENFORCE_FROM. Resolved once per tick rather than per entry.
    cutoff_ts = (
        settings.SLA_ENFORCE_FROM.timestamp()
        if settings.SLA_ENFORCE_FROM is not None
        else None
    )

    warnings = 0
    breaches = 0
    processed = 0
    skipped_historical = 0
    skipped_no_rule = 0

    for member, score in entries:
        processed += 1
        try:
            # Before anything else, including loading the ticket: a discarded
            # entry must cost one comparison, not a database read. The entry is
            # already claimed and deleted, so skipping drops it for good — which
            # is the point. Moving the cutoff back later will not resurrect it.
            if cutoff_ts is not None and score < cutoff_ts:
                skipped_historical += 1
                continue

            parts = member.split(":")
            ticket_id = parts[0]
            event_kind = parts[1] if len(parts) > 1 else "resolution"
            sr = await ServiceRequest.get(ticket_id)
            if sr is None or sr.deleted_on is not None:
                continue
            if sr.request_status in SLA_INACTIVE_STATUSES:
                continue

            # Workflow-level timers — independent of SLA deadlines, and gated
            # separately. These share this store and this function with the SLA
            # rule's deadlines, so enabling the tick would otherwise switch on
            # workflow escalation at the same time, whether or not the org
            # configured it deliberately.
            #
            # `_apply_workflow_auto_escalate` now records what the manual
            # escalate flow records — HandoffEvent, escalation_reason,
            # previous_executor_user_id — and emails the new owner, so the
            # original reason for keeping this off is addressed. What remains
            # is a rollout decision: turning the flag on starts moving tickets
            # between people on a timer, and every workflow with Escalation
            # Rules already switched on begins acting immediately.
            #
            # One consequence to accept before enabling: auto-escalation sets
            # `is_escalated`, which blocks the executor's own Escalate button
            # (service_assign.py:581). Defensible — the ticket *has* escalated
            # — but it is a capability they lose without acting.
            #
            # Note the entry has already been claimed above, so skipping
            # consumes it: a ticket whose timer passed while this was off will
            # not escalate later once it is enabled.
            if event_kind in ("auto_escalate", "pre_notify"):
                if not settings.SLA_AUTO_ESCALATE_ENABLED:
                    logger.info(
                        "sla_tick.workflow_timer_skipped sr=%s kind=%s "
                        "(SLA_AUTO_ESCALATE_ENABLED=false)",
                        sr.id,
                        event_kind,
                    )
                    continue
                if event_kind == "auto_escalate":
                    await _apply_workflow_auto_escalate(sr)
                else:
                    await _emit_pre_escalation_warning(sr)
                continue

            # Resolve the rule the ticket was raised under, honouring the same
            # active/deleted filters `resolve_sla_for_priority` applies. Without
            # them a rule switched to INACTIVE — the only per-priority off
            # switch the FE offers, since `_check_rules` makes all four
            # priorities mandatory and a rule can never be removed — still read
            # as live here, and its violation actions kept running.
            #
            # `rule is None` therefore means "this ticket's SLA is no longer in
            # force", covering four cases that were previously invisible: the
            # rule deactivated or soft-deleted, the request type deactivated or
            # soft-deleted. The entry is then dropped entirely — see the gate
            # below.
            # Shared with the detail page's SLA panel (`utils.sla.rule_in_force`)
            # so the two cannot drift: what suppresses the breach email must be
            # exactly what suppresses the breach badge.
            rule, rule_gone_reason = await sla_rule_in_force(sr)

            # No rule in force → no breach. Nothing below this line runs: no
            # SLA_BREACHED event, no activity entry, no email, no violation
            # actions. A deadline is only meaningful as the deadline *of a
            # rule*, and an admin who switched that rule off has said they do
            # not want it enforced — the email in particular went to a real
            # assignee about an SLA nobody was holding them to.
            #
            # The entry was claimed and deleted before we got here, so this
            # drops it permanently. Re-activating the rule will not resurrect
            # deadlines that passed while it was off; tickets raised after the
            # re-activation enrol fresh ones. That is the intended trade —
            # re-firing a backlog of suppressed breaches on re-activation would
            # be a mailshot.
            if rule is None:
                skipped_no_rule += 1
                logger.info(
                    "sla_tick.rule_not_in_force sr=%s kind=%s reason=%s "
                    "sla_rule_id=%s request_type=%s — deadline discarded, no "
                    "breach raised",
                    sr.id,
                    event_kind,
                    rule_gone_reason,
                    sr.sla_rule_id,
                    sr.request_type_id,
                )
                continue

            # A negative score → pre-alert entry (we don't currently enrol
            # pre-alerts separately; treat anything past `now` as a breach).
            breached = score <= now_ts
            if breached:
                breaches += 1
                await publish_event(
                    "sla_breached",
                    {
                        "service_request_id": str(sr.id),
                        "ticket_no": sr.ticket_no,
                        "event_kind": event_kind,
                    },
                )
                await notify_watcher_if_subscribed(
                    sr.workflow_id,
                    "sla_breach",
                    {
                        "service_request_id": str(sr.id),
                        "ticket_no": sr.ticket_no,
                        "event_kind": event_kind,
                    },
                )
                try:
                    await emit_activity(
                        event=ActivityEventEnum.SLA_BREACHED,
                        service_request_id=str(sr.id),
                        actor_user_id="system",
                        organisation_id=str(sr.organisation_id),
                        details={"event_kind": event_kind},
                    )
                except Exception:  # noqa: BLE001
                    pass

                try:
                    from ..email_events import notify_sla_breached
                    from ..common.email_resolver import resolve_user_info
                    from ..models import Category
                    cat = await Category.get(sr.category_id)
                    # Who to tell. An assigned ticket has one owner and they are
                    # the answer. An UNASSIGNED one does not — it is still
                    # sitting in the category's pool, so everyone who could have
                    # picked it up needs to know it breached.
                    #
                    # That means the whole roster, primary and secondary alike.
                    # Secondaries work the same queue (`resolve_workforce` lets
                    # them execute and self-assign); excluding them from the
                    # breach alert told half the pool nothing about a ticket
                    # they were free to pick up.
                    #
                    # This used to send to `primary_assignee_user_id` alone,
                    # which names a single person chosen by array order — the
                    # breach alert was a lottery.
                    if sr.executor_user_id:
                        recipient_ids = [str(sr.executor_user_id)]
                    else:
                        recipient_ids = [
                            str(e.user_id)
                            for e in ((cat.executors if cat else None) or [])
                        ] or (
                            # Legacy category with no roster — fall back to the
                            # ticket's stored assignee, which is all there is.
                            [str(sr.primary_assignee_user_id)]
                            if sr.primary_assignee_user_id
                            else []
                        )
                    if recipient_ids:
                        req_info = await resolve_user_info(str(sr.requester_user_id))
                        cat_name = cat.name if cat else ""
                        exec_name = ""
                        if sr.executor_user_id:
                            exec_info = await resolve_user_info(str(sr.executor_user_id))
                            exec_name = exec_info.get("name", "")
                        sla_due = ""
                        if event_kind == "first_response" and sr.first_response_due_by:
                            sla_due = sr.first_response_due_by.isoformat()
                        elif sr.resolution_due_by:
                            sla_due = sr.resolution_due_by.isoformat()
                        # One address failing must not cost the others their
                        # mail, so each recipient is resolved and sent
                        # independently rather than as a batch.
                        sent = 0
                        for rid in recipient_ids:
                            a_info = await resolve_user_info(rid)
                            if not a_info["email"]:
                                # This is why a breach can be recorded with
                                # nobody told: no address, no mail, and until
                                # this line no trace of either.
                                logger.warning(
                                    "sla_tick.breach_email_skipped sr=%s kind=%s "
                                    "recipient=%s — no address resolved",
                                    sr.id,
                                    event_kind,
                                    rid,
                                )
                                continue
                            await notify_sla_breached(
                                assignee_email=a_info["email"],
                                assignee_name=a_info["name"],
                                ticket_no=sr.ticket_no,
                                title=sr.title,
                                sr_id=str(sr.id),
                                description=sr.description or "",
                                breach_type=event_kind,
                                requester_name=req_info.get("name", ""),
                                category_name=cat_name,
                                priority=sr.priority.value if sr.priority else "",
                                sla_due_at=sla_due,
                                executor_name=exec_name,
                                tenant_id=str(sr.organisation_id),
                                # Without this every recipient lands on the same
                                # outbox key (routing_key + suffix, uniquely
                                # indexed) and `outbox.publish` treats the
                                # repeats as already-sent — so only the first
                                # person in the list was ever mailed, silently,
                                # while `sent` counted them all. Fanning out to
                                # the roster does nothing until the key varies
                                # per recipient.
                                idempotency_discriminator=a_info["email"],
                            )
                            sent += 1
                        if sent == 0:
                            logger.warning(
                                "sla_tick.breach_email_none_sent sr=%s kind=%s "
                                "candidates=%s — breach recorded, nobody mailed",
                                sr.id,
                                event_kind,
                                recipient_ids,
                            )
                    else:
                        logger.warning(
                            "sla_tick.breach_email_skipped sr=%s kind=%s — ticket "
                            "has no executor and its category names no primary",
                            sr.id,
                            event_kind,
                        )
                except Exception:  # noqa: BLE001 — a failed mail must not stop the tick
                    logger.warning(
                        "sla_tick.breach_email_failed sr=%s kind=%s",
                        sr.id,
                        event_kind,
                        exc_info=True,
                    )

                # `rule` is non-None past the gate above; the check is kept as a
                # type narrowing, not a behavioural branch.
                if rule:
                    await _apply_violation_actions(sr, rule, event_kind)
            else:
                warnings += 1
                await publish_event(
                    "sla_warning",
                    {
                        "service_request_id": str(sr.id),
                        "ticket_no": sr.ticket_no,
                        "event_kind": event_kind,
                    },
                )
                try:
                    await emit_activity(
                        event=ActivityEventEnum.SLA_WARNING,
                        service_request_id=str(sr.id),
                        actor_user_id="system",
                        organisation_id=str(sr.organisation_id),
                        details={"event_kind": event_kind},
                    )
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            logger.exception("sla_tick.entry_failed member=%s err=%s", member, e)

    if skipped_historical:
        # Loud on purpose: a backlog being discarded is the expected shape of the
        # first ticks after a cutoff is set, but it is also what a cutoff left
        # accidentally in the future looks like. Whichever it is, say so.
        logger.info(
            "sla_tick.skipped_historical count=%d cutoff=%s",
            skipped_historical,
            settings.SLA_ENFORCE_FROM,
        )

    if skipped_no_rule:
        # Expected in small numbers — tickets raised under a rule an admin has
        # since switched off. A large or growing count means something else:
        # most likely rule ids being re-minted on save, which `reason=` in the
        # per-entry log above distinguishes.
        logger.info("sla_tick.skipped_no_rule count=%d", skipped_no_rule)

    return {
        "processed": processed,
        "warnings": warnings,
        "breaches": breaches,
        "skipped_historical": skipped_historical,
        "skipped_no_rule": skipped_no_rule,
    }


async def _notify_recipients(
    sr: ServiceRequest, rule: SLARule, event_kind: str = "resolution"
) -> None:
    """Email the rule's configured recipients that an action was taken.

    Called only once at least one violation action has actually taken effect, so
    the ticket state read here is post-action — which is what makes the existing
    ``srm_sla_breached_v1`` template carry the outcome for free: `priority` shows
    the bumped value.

    *event_kind* selects which deadline the mail describes. It has to be passed
    through rather than assumed: violation actions run for a ``first_response``
    breach just as they do for ``resolution``, so hardcoding the latter mislabels
    the mail and quotes the wrong due date.

    Addresses come from the snapshot taken when the request type was saved; the
    tick cannot resolve them itself (no user token, and IAM has no service
    principal). A rule saved before that snapshot existed has no contacts and
    silently emails nobody — re-saving the request type populates them.
    """
    if not rule.notification_recipient_contacts:
        if rule.notification_recipients:
            logger.warning(
                "sla_notify.no_contacts rule=%s recipients=%d — re-save the request "
                "type to resolve their addresses",
                rule.id,
                len(rule.notification_recipients),
            )
        return

    from ..email_events import notify_sla_breached
    from ..models import Category

    cat = await Category.get(sr.category_id)
    due = (
        sr.first_response_due_by
        if event_kind == "first_response"
        else sr.resolution_due_by
    )
    for contact in rule.notification_recipient_contacts:
        try:
            await notify_sla_breached(
                assignee_email=contact.email,
                assignee_name=contact.name,
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                breach_type=event_kind,
                category_name=cat.name if cat else "",
                priority=sr.priority.value if sr.priority else "",
                sla_due_at=due.isoformat() if due else "",
                tenant_id=str(sr.organisation_id),
                # Without this every contact would land on the same outbox
                # idempotency key (routing_key + suffix, uniquely indexed), and
                # `outbox.publish` treats a duplicate as already-sent — so only
                # the first recipient would be mailed, silently. The key also has
                # to differ from the assignee's mail for the same ticket and
                # deadline, which is built from the same suffix.
                idempotency_discriminator=contact.email,
            )
        except Exception:  # noqa: BLE001 — one bad address must not stop the rest
            logger.warning(
                "sla_notify.send_failed sr=%s to=%s", sr.id, contact.email, exc_info=True
            )


async def _apply_violation_actions(
    sr: ServiceRequest, rule: SLARule, event_kind: str = "resolution"
) -> None:
    """Run the rule's violation actions, then notify recipients if any took effect.

    *event_kind* is which deadline fired — ``first_response`` or ``resolution``.
    It is carried through only so the notification describes the right one; the
    actions themselves are the same either way, since a rule's violation_actions
    are not per-deadline.

    The FE offers only Change Priority and Reassign, and auto-appends
    send_notification whenever either is ticked — so "an action is configured"
    and "send_notification is present" are the same signal, and we key the
    notification off what actually *executed* rather than off the action list.
    An action that no-ops (priority already URGENT, reassign with no target)
    notifies nobody, because nothing happened worth reporting.

    SEND_ALERT / SEND_NOTIFICATION are therefore no longer handled here: they
    used to publish to `srm.request.sla.*`, which no service consumes, so the
    recipients configured in the FE were never emailed at all.
    """
    acted = False
    for action in rule.violation_actions:
        try:
            if action == SLAViolationAction.CHANGE_PRIORITY:
                idx = PRIORITY_ORDER.index(sr.priority)
                if idx < len(PRIORITY_ORDER) - 1:
                    sr.priority = PRIORITY_ORDER[idx + 1]
                    sr.modified_on = utcnow()
                    sr.modified_by = SYSTEM_ACTOR_ID
                    await sr.save()
                    acted = True
                    try:
                        await emit_activity(
                            event=ActivityEventEnum.PRIORITY_CHANGED,
                            service_request_id=str(sr.id),
                            actor_user_id="system",
                            organisation_id=str(sr.organisation_id),
                            details={"new_priority": sr.priority.value},
                        )
                    except Exception:  # noqa: BLE001
                        pass
            elif action == SLAViolationAction.REASSIGN:
                ec = await EscalationConfig.find_one(
                    {"workflow_id": sr.workflow_id, "deleted_on": None}
                )
                # A target is unavoidable — Reassign is ticked on the Request
                # Type page, but the only user to reassign *to* lives on the
                # Workflow page. Without one there is nothing to do.
                #
                # `auto_escalate_enabled` is deliberately NOT required. That
                # switch governs the workflow's own time-based escalation timer
                # ("escalate N minutes after submission"); this is a different
                # trigger to the same target. Gating on it meant ticking Reassign
                # did nothing, with no error, because a toggle on another screen
                # was off.
                if not ec or not ec.escalate_to_user_id:
                    logger.warning(
                        "sla_reassign.no_target sr=%s workflow=%s — Reassign is "
                        "configured on the SLA rule but the workflow has no "
                        "escalate_to_user_id",
                        sr.id,
                        sr.workflow_id,
                    )
                    continue
                target = ec.escalate_to_user_id
                if target == (sr.executor_user_id or sr.escalation_override_approver_user_id):
                    continue  # already there — skip
                # The SLA target is a fixed user on the workflow, so sooner or
                # later it is the same person as some ticket's requester. Hand
                # it to them and they execute or approve their own request —
                # the same conflict the manual paths reject, arrived at with
                # nobody in the loop to notice. Skip loudly instead.
                if is_requester(sr, target):
                    logger.warning(
                        "sla_reassign.target_is_requester sr=%s target=%s — skipped",
                        sr.id,
                        target,
                    )
                    continue
                previous = sr.executor_user_id
                auto_assigned = False
                if sr.request_status in (
                    RequestStatusEnum.ASSIGNED,
                    RequestStatusEnum.IN_PROGRESS,
                ):
                    sr.executor_user_id = target
                elif sr.request_status == RequestStatusEnum.PENDING_APPROVAL:
                    sr.escalation_override_approver_user_id = target
                elif sr.request_status in (
                    RequestStatusEnum.PENDING_ASSIGNMENT,
                    RequestStatusEnum.SUBMITTED,
                ):
                    # Dept head never picked an executor — bypass and jump
                    # the ticket to ASSIGNED with the escalation target.
                    sr.executor_user_id = target
                    sr.request_status = RequestStatusEnum.ASSIGNED
                    auto_assigned = True
                else:
                    continue  # terminal/unknown — don't bump escalation_count
                sr.is_escalated = True
                sr.escalation_count += 1
                sr.escalated_at = utcnow()
                sr.modified_on = utcnow()
                sr.modified_by = SYSTEM_ACTOR_ID
                await sr.save()
                acted = True

                if auto_assigned:
                    await publish_event(
                        "assigned",
                        {
                            "service_request_id": str(sr.id),
                            "ticket_no": sr.ticket_no,
                            "executor_user_id": str(target),
                            "actor_user_id": "system",
                            "reason": "sla_breach_auto_reassign",
                        },
                    )
                    await notify_watcher_if_subscribed(
                        sr.workflow_id,
                        "assignment",
                        {
                            "service_request_id": str(sr.id),
                            "ticket_no": sr.ticket_no,
                            "executor_user_id": str(target),
                            "reason": "sla_breach_auto_reassign",
                        },
                    )
                    try:
                        await emit_activity(
                            event=ActivityEventEnum.ASSIGNED,
                            service_request_id=str(sr.id),
                            actor_user_id="system",
                            organisation_id=str(sr.organisation_id),
                            details={
                                "executor_user_id": str(target),
                                "reason": "sla_breach_bypass_head",
                            },
                        )
                    except Exception:  # noqa: BLE001
                        pass

                await publish_event(
                    "escalated",
                    {
                        "service_request_id": str(sr.id),
                        "ticket_no": sr.ticket_no,
                        "previous_owner_user_id": str(previous) if previous else None,
                        "new_owner_user_id": str(target),
                        "reason": "sla_breach_auto_reassign",
                        "actor_user_id": "system",
                    },
                )
                await notify_watcher_if_subscribed(
                    sr.workflow_id,
                    "escalation",
                    {
                        "service_request_id": str(sr.id),
                        "ticket_no": sr.ticket_no,
                        "new_owner_user_id": str(target),
                        "reason": "sla_breach_auto_reassign",
                    },
                )
                try:
                    await emit_activity(
                        event=ActivityEventEnum.ESCALATED,
                        service_request_id=str(sr.id),
                        actor_user_id="system",
                        organisation_id=str(sr.organisation_id),
                        details={"reason": "sla_breach", "to": str(target)},
                    )
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            logger.exception("violation_action.failed action=%s err=%s", action, e)

    # Recipients hear about it only if something actually happened — see the
    # docstring. Sent after the loop so the ticket state (and so the email's
    # `priority` field) reflects the outcome.
    if acted:
        await _notify_recipients(sr, rule, event_kind)


AUTO_ESCALATION_REASON = "Auto-escalated: no progress within the workflow's escalation window"


async def _apply_workflow_auto_escalate(sr: ServiceRequest) -> None:
    """Workflow-level escalation timer fired (event_kind == 'auto_escalate').

    Runs on the EscalationConfig.escalate_after_minutes timer, independent of
    any SLA rule breach, and records the same trail the manual Escalate button
    does (``service_assign.escalate``) — a HandoffEvent, an escalation reason,
    ``previous_executor_user_id``, and an email to the new owner. Anything less
    and the ticket changes hands with nobody told and no history explaining
    why, which is what kept this path switched off.

    The one deliberate divergence from the manual flow: no approval-slate reset.
    Manual escalation is executor → dept head and starts the new owner on a
    clean timeline; this is a timer redirect to a fixed target, so the ticket's
    approval state is left exactly as it was.
    """
    ec = await EscalationConfig.find_one(
        {"workflow_id": sr.workflow_id, "deleted_on": None}
    )
    if (
        not ec
        or not ec.auto_escalate_enabled
        or not ec.escalate_to_user_id
    ):
        return
    target = ec.escalate_to_user_id
    if target == (sr.executor_user_id or sr.escalation_override_approver_user_id):
        return  # already there — nothing to do
    # See the matching guard in the SLA-violation reassign path above: a fixed
    # workflow target must never become the handler of its own requester's
    # ticket.
    if is_requester(sr, target):
        logger.warning(
            "auto_escalate.target_is_requester sr=%s target=%s — skipped",
            sr.id,
            target,
        )
        return
    previous = sr.executor_user_id
    now = utcnow()
    auto_assigned = False
    in_executor_phase = False
    if sr.request_status in (
        RequestStatusEnum.ASSIGNED,
        RequestStatusEnum.IN_PROGRESS,
    ):
        # Snapshot who we're handing off from, so reassign can't bounce the
        # ticket straight back to them — same guard the manual flow applies.
        sr.previous_executor_user_id = previous
        sr.executor_user_id = target
        in_executor_phase = True
    elif sr.request_status == RequestStatusEnum.PENDING_APPROVAL:
        sr.escalation_override_approver_user_id = target
    elif sr.request_status in (
        RequestStatusEnum.PENDING_ASSIGNMENT,
        RequestStatusEnum.SUBMITTED,
    ):
        # Dept head never picked an executor — escalation target becomes
        # the executor directly and the ticket leaps to ASSIGNED.
        sr.executor_user_id = target
        sr.request_status = RequestStatusEnum.ASSIGNED
        auto_assigned = True
    else:
        return  # terminal / unknown — nothing to do
    sr.is_escalated = True
    sr.escalation_count += 1
    sr.escalated_at = now
    sr.escalation_reason = AUTO_ESCALATION_REASON
    sr.modified_on = now
    sr.modified_by = SYSTEM_ACTOR_ID
    await sr.save()

    # Immutable phase snapshot — the ticket's ownership history. Only for an
    # executor handoff; the approval-phase override and the never-assigned
    # bypass aren't handoffs between executors and have no phase to close.
    if in_executor_phase:
        try:
            prior_handoffs = await HandoffEvent.find(
                {"service_request_id": sr.id, "deleted_on": None}
            ).count()
            await HandoffEvent(
                service_request_id=sr.id,
                organisation_id=sr.organisation_id,
                kind=HandoffKindEnum.ESCALATION,
                phase_index=prior_handoffs + 1,
                from_user_id=previous,
                to_user_id=target,
                reason=AUTO_ESCALATION_REASON,
                assigned_at=sr.assigned_at,
                first_response_at=sr.first_response_at,
                approval_triggered_at=sr.approval_triggered_at,
                happened_at=now,
                created_by=SYSTEM_ACTOR_ID,
                created_on=now,
            ).insert()
        except Exception:  # noqa: BLE001
            logger.warning("auto_escalate.handoff_failed sr=%s", sr.id, exc_info=True)

    # Tell the new owner. The tick has no user token, so addresses resolve via
    # the service path (same as the SLA-breach email above).
    try:
        from ..common.email_resolver import resolve_user_info
        from ..email_events import notify_request_escalated
        from ..models import Category

        target_info = await resolve_user_info(str(target))
        req_info = await resolve_user_info(str(sr.requester_user_id))
        cat = await Category.get(sr.category_id)
        if target_info["email"]:
            await notify_request_escalated(
                escalation_target_email=target_info["email"],
                escalation_target_name=target_info["name"],
                requester_email=req_info.get("email", ""),
                requester_name=req_info.get("name", ""),
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                reason=AUTO_ESCALATION_REASON,
                category_name=cat.name if cat else "",
                priority=sr.priority.value if sr.priority else "",
                tenant_id=str(sr.organisation_id),
            )
    except Exception:  # noqa: BLE001
        logger.warning("auto_escalate.email_failed sr=%s", sr.id, exc_info=True)

    # If we auto-assigned (bypassing the dept head), emit the "assigned"
    # event too so email/audit/watcher consumers see a normal assignment
    # transition alongside the escalation.
    if auto_assigned:
        await publish_event(
            "assigned",
            {
                "service_request_id": str(sr.id),
                "ticket_no": sr.ticket_no,
                "executor_user_id": str(target),
                "actor_user_id": "system",
                "reason": "workflow_auto_escalate_timer",
            },
        )
        await notify_watcher_if_subscribed(
            sr.workflow_id,
            "assignment",
            {
                "service_request_id": str(sr.id),
                "ticket_no": sr.ticket_no,
                "executor_user_id": str(target),
                "reason": "workflow_auto_escalate_timer",
            },
        )
        try:
            await emit_activity(
                event=ActivityEventEnum.ASSIGNED,
                service_request_id=str(sr.id),
                actor_user_id="system",
                organisation_id=str(sr.organisation_id),
                details={
                    "executor_user_id": str(target),
                    "reason": "workflow_auto_escalate_bypass_head",
                },
            )
        except Exception:  # noqa: BLE001
            pass

    await publish_event(
        "escalated",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "previous_owner_user_id": str(previous) if previous else None,
            "new_owner_user_id": str(target),
            "reason": "workflow_auto_escalate_timer",
            "actor_user_id": "system",
        },
    )
    await notify_watcher_if_subscribed(
        sr.workflow_id,
        "escalation",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "new_owner_user_id": str(target),
            "reason": "workflow_auto_escalate_timer",
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.ESCALATED,
            service_request_id=str(sr.id),
            actor_user_id="system",
            organisation_id=str(sr.organisation_id),
            details={
                "reason": "workflow_auto_escalate",
                "from": str(previous) if previous else None,
                "to": str(target),
            },
        )
    except Exception:  # noqa: BLE001
        pass


async def _emit_pre_escalation_warning(sr: ServiceRequest) -> None:
    """Pre-notify timer fired (event_kind == 'pre_notify').

    Emits a warning event; no state change. The intent is "heads up — this
    ticket will auto-escalate in N minutes if it doesn't move".

    Incomplete: ``sla_warning`` goes to a routing key no service consumes, so
    the current owner is never actually warned. Finishing it needs an email
    template that does not exist yet (the breach template would misdescribe a
    warning), so it is left emitting events only rather than sending something
    misleading. Harmless meanwhile — this path changes no ticket state.
    """
    ec = await EscalationConfig.find_one(
        {"workflow_id": sr.workflow_id, "deleted_on": None}
    )
    if not ec or not ec.pre_notify_enabled:
        return
    await publish_event(
        "sla_warning",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "event_kind": "pre_escalation",
            "minutes_before_escalation": ec.pre_notify_minutes_before,
            "escalate_to_user_id": str(ec.escalate_to_user_id),
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.SLA_WARNING,
            service_request_id=str(sr.id),
            actor_user_id="system",
            organisation_id=str(sr.organisation_id),
            details={
                "event_kind": "pre_escalation",
                "minutes_before": ec.pre_notify_minutes_before,
            },
        )
    except Exception:  # noqa: BLE001
        pass


async def rebuild_sla_cursor() -> dict[str, int]:
    """Reconcile in-flight tickets missing from the deadline store (safety net).

    Enrolment is an upsert, so re-running this is harmless: a ticket already
    enrolled has its deadline rewritten to the same value rather than gaining a
    second entry.

    Only rebuilds ``first_response`` and ``resolution`` — the workflow timers
    (``auto_escalate``, ``pre_notify``) are not derivable from the ticket alone,
    they need the workflow's EscalationConfig. ``reenrol_workflow_timers``
    covers those.

    Selects on SLA_INACTIVE_STATUSES, not TERMINAL_STATUSES, so resolved tickets
    stay out — they have met their resolution SLA and re-enrolling them would
    breach every one of them on the next tick.

    Still a blunt instrument on an existing database: it enrols the whole
    in-flight backlog, and those deadlines are almost all in the past, so the
    ticks that follow claim them 500 at a time. ``settings.SLA_ENFORCE_FROM`` is
    what keeps that from turning into a mailshot — set it before calling this.
    """
    non_terminal = [
        s.value for s in RequestStatusEnum
        if s not in SLA_INACTIVE_STATUSES
    ]
    srs = await ServiceRequest.find(
        {
            "request_status": {"$in": non_terminal},
            "resolution_due_by": {"$ne": None},
        }
    ).to_list()
    entries: dict[str, float] = {}
    for sr in srs:
        if sr.first_response_due_by and sr.first_response_at is None:
            entries[f"{sr.id}:first_response"] = sr.first_response_due_by.timestamp()
        if sr.resolution_due_by:
            entries[f"{sr.id}:resolution"] = sr.resolution_due_by.timestamp()
    enrolled = await enrol(entries)
    return {"reconciled": enrolled}
