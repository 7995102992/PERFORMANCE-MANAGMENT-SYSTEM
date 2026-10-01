"""Raise-new-request flow — Chapter 5.

Central endpoint of the ticket lifecycle. One atomic flow:
  1. validate category + request_type + active workflow + SLA rule
  2. generate ticket number (atomic per-org-per-year)
  3. compute SLA deadlines (business-hours-aware)
  4. insert ServiceRequest + ATTACHMENT rows
  5. enrol {ticket_id}:first_response, :resolution in the SLA deadline store
  6. publish srm.request.submitted
  7. audit.emit(request.submitted)
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import date
from typing import Any

from fastapi import UploadFile

from ..audit import emit_activity, emit_audit
from ..auth.utils.dependencies import UserBase
from ..common.iam_helpers import try_oid
from ..common.names import safe_filename
from ..common.timestamps import utcnow
from ..database import get_client
from ..exceptions import (
    AttachmentCountExceeded,
    AttachmentFormat,
    AttachmentTooLarge,
    CategoryNotFound,
    CategoryRosterNotConfigured,
    ExecutorInvalid,
    IdempotencyMismatch,
    NoActiveWorkflow,
    NoSlaAvailable,
    RequestTypeNotFound,
)
from ..integrations.storage_client import (
    ALLOWED_MIME_TYPES,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_TICKET,
    put_upload_file,
    delete as storage_delete,
)
from ..models import (
    ActivityEventEnum,
    Attachment,
    ApprovalLevel,
    Approver,
    BusinessHours,
    Category,
    EscalationConfig,
    ExecutorRoleEnum,
    OrgSrConfig,
    PriorityEnum,
    RequestStatusEnum,
    RequestType,
    SLARule,
    ServiceRequest,
    StatusEnum,
    Workflow,
)
from ..rabbitmq import publish_event
from ..rabbitmq.outbox import publish as outbox_publish
from ..request_types.service import resolve_sla_for_priority
from ..workflows.service import find_active_workflow
from .schemas import RaiseRequestBody
from .utils.id_generator import next_ticket_number
from .utils.sla import compute_deadline
from ..sla_store import enrol
from ..valkey import get_valkey, idempotency_key

logger = logging.getLogger(__name__)


async def _org_config(organisation_id: str) -> OrgSrConfig:
    doc = await OrgSrConfig.find_one({"organisation_id": try_oid(organisation_id)})
    if doc is None:
        doc = OrgSrConfig(
            organisation_id=organisation_id,
            executor_can_close=True,
            business_hours=BusinessHours(),
            holidays=[],
            timezone="UTC",
        )
        await doc.insert()
    return doc


async def _validate_attachments(files: list[UploadFile]) -> None:
    if len(files) > MAX_ATTACHMENTS_PER_TICKET:
        raise AttachmentCountExceeded()
    for f in files:
        if f.content_type not in ALLOWED_MIME_TYPES:
            raise AttachmentFormat()
        # Size check via spooled file.
        f.file.seek(0, 2)  # os.SEEK_END
        size = f.file.tell()
        f.file.seek(0)
        if size > MAX_ATTACHMENT_BYTES:
            raise AttachmentTooLarge()


async def _check_idempotency(
    user_id: str, client_key: str, payload_hash: str
) -> dict[str, Any] | None:
    """Returns a previously-stored response if the same key+hash replays, raises on mismatch."""
    try:
        cache = get_valkey()
        key = idempotency_key(user_id, client_key)
        raw = await cache.get(key)
        if raw:
            rec = json.loads(raw)
            if rec.get("hash") == payload_hash:
                return rec.get("response")
            raise IdempotencyMismatch()
    except IdempotencyMismatch:
        raise
    except Exception:  # noqa: BLE001
        logger.warning("idempotency.read.skipped")
    return None


async def _store_idempotency(
    user_id: str, client_key: str, payload_hash: str, response_json: dict[str, Any]
) -> None:
    try:
        cache = get_valkey()
        await cache.setex(
            idempotency_key(user_id, client_key),
            24 * 3600,
            json.dumps({"hash": payload_hash, "response": response_json}, default=str),
        )
    except Exception:  # noqa: BLE001
        logger.warning("idempotency.write.skipped")


def _payload_hash(body: RaiseRequestBody) -> str:
    canonical = json.dumps(body.model_dump(mode="json"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def raise_request(
    body: RaiseRequestBody,
    files: list[UploadFile] | None,
    user: UserBase,
    *,
    idempotency_header: str | None = None,
) -> dict[str, Any]:
    files = files or []
    await _validate_attachments(files)

    payload_hash = _payload_hash(body)
    if idempotency_header:
        cached = await _check_idempotency(user.id, idempotency_header, payload_hash)
        if cached is not None:
            return cached

    cat = await Category.get(body.category_id)
    if (
        cat is None
        or cat.deleted_on is not None
        or str(cat.organisation_id) != user.organisation_id
        or cat.status != StatusEnum.ACTIVE
    ):
        raise CategoryNotFound()
    # Visibility scope: a restricted category may only be raised by members of
    # its business unit + department (admins bypass). Return NotFound rather
    # than Forbidden so we don't leak the existence of categories the
    # requester isn't entitled to see.
    if cat.restricted_visibility and not (user.is_super_admin or user.is_org_admin):
        from ..categories.service import (
            _effective_visibility_bus,
            _effective_visibility_depts,
        )

        if (
            not user.business_unit_id
            or not user.department_id
            or str(user.business_unit_id) not in _effective_visibility_bus(cat)
            or str(user.department_id) not in _effective_visibility_depts(cat)
        ):
            raise CategoryNotFound()
    # The category has to name someone who can run the ticket before it will
    # accept one. Two shapes fail: no roster at all, and a roster carrying only
    # secondaries (pre-validation documents — `categories/schemas.py` has
    # required a primary on any non-empty roster since).
    #
    # This is what lets escalation stop falling back to the department head.
    # That fallback existed because tickets could be raised into categories
    # with no primary, leaving nobody holding the assign / reassign / escalation
    # -target powers — so escalation reached for the head, who since D3 was
    # removed holds nothing on the category at all. Closing the gap here means
    # every new ticket has a real primary behind it, and the fallback has
    # nothing left to catch.
    #
    # Deliberately not enforced at category save: an admin should still be able
    # to create a category and staff it afterwards. It just cannot be used yet.
    if not any(
        e.role == ExecutorRoleEnum.PRIMARY for e in (cat.executors or [])
    ):
        raise CategoryRosterNotConfigured(cat.name or "")
    rt = await RequestType.get(body.request_type_id)
    if (
        rt is None
        or rt.deleted_on is not None
        or str(rt.organisation_id) != user.organisation_id
        or str(rt.category_id) != str(cat.id)
        or rt.status != StatusEnum.ACTIVE
    ):
        raise RequestTypeNotFound()
    workflow = await find_active_workflow(str(rt.id))
    if workflow is None:
        raise NoActiveWorkflow()
    sla_rule = await resolve_sla_for_priority(str(rt.id), body.priority)
    if sla_rule is None:
        raise NoSlaAvailable()

    # Validate the optional requester-picked executor against the category's
    # department (the same scope used for the executor dropdown). The
    # requester cannot pick themselves.
    chosen_executor_user_id: str | None = None
    if body.executor_user_id:
        if str(body.executor_user_id) == user.id:
            from ..exceptions import Forbidden
            raise Forbidden("Requester cannot be the executor of their own ticket")
        from ..categories.service import category_department_ids
        cat_dept_ids = category_department_ids(cat)
        if cat_dept_ids:
            from ..integrations.iam_client import get_iam_client as _get_iam
            iam = _get_iam()
            # Membership check on the chosen executor — IAM caps list limit at
            # 100, so look up the single employee instead of scanning the dept.
            emp = await iam.get_employee(
                str(body.executor_user_id), access_token=user.access_token
            )
            emp_dept_id = str(
                (emp or {}).get("department_id")
                or (emp or {}).get("departmentId")
                or ""
            )
            # Any of the category's departments will do — the ticket is routed
            # to all of them.
            if not emp or emp_dept_id not in {str(d) for d in cat_dept_ids}:
                raise ExecutorInvalid()
            # A configured roster narrows the pool further — otherwise raising
            # with `executor_user_id` would be a way around it, handing work to
            # a department member the executor picker never offers. Only applies
            # once a roster exists, so legacy categories are unaffected.
            if cat.executors:
                from ..categories.service import _department_meta, resolve_workforce
                meta = await _department_meta(cat_dept_ids, user)
                head_ids = [
                    m["head_user_id"] for m in meta.values() if m.get("head_user_id")
                ]
                # Roster only (D8 removed). Passing the department check above
                # no longer puts anyone in the pool, so the caller's own id is
                # not seeded into `members` any more — that seeding existed
                # purely to model the non-exclusive default without a second
                # IAM sweep.
                if str(body.executor_user_id) not in resolve_workforce(
                    cat, head_ids
                ):
                    raise ExecutorInvalid(
                        "That person is not on this category's executor "
                        "roster, so the ticket cannot be raised directly to "
                        "them. Add them to the roster, or leave the executor "
                        "unset and let a primary assign it."
                    )
        chosen_executor_user_id = str(body.executor_user_id)

    cfg = await _org_config(user.organisation_id)
    now = utcnow()
    holidays = {date.fromisoformat(h) for h in cfg.holidays or []}
    first_response_due_by = compute_deadline(
        now,
        sla_rule.first_response_minutes,
        business_hours_only=sla_rule.business_hours_only,
        org_tz=cfg.timezone,
        business_hours=cfg.business_hours,
        holidays=holidays,
    )
    resolution_due_by = compute_deadline(
        now,
        sla_rule.resolution_minutes,
        business_hours_only=sla_rule.business_hours_only,
        org_tz=cfg.timezone,
        business_hours=cfg.business_hours,
        holidays=holidays,
    )

    ticket_no = await next_ticket_number(user.organisation_id, now=now)

    # Status selection (executor-driven approval flow):
    #   - executor picked → ASSIGNED (skip PENDING_ASSIGNMENT).
    #   - no pick → PENDING_ASSIGNMENT (open ticket; any dept employee can
    #     self-assign — see service_assign.assign_executor).
    # Approval is no longer an up-front gate: if the workflow has approval
    # levels configured, the executor may later POST /submit-for-approval
    # to push the ticket into PENDING_APPROVAL. workflow.approval_required
    # is now interpreted as "approval is available for this workflow" — not
    # "approval before assignment."
    if chosen_executor_user_id:
        initial_status = RequestStatusEnum.ASSIGNED
    else:
        initial_status = RequestStatusEnum.PENDING_ASSIGNMENT
    current_level_index = None

    # Who holds primary-assignee rights on this ticket — read off the category's
    # CURRENT roster, not `workflow.primary_assignee_user_id`.
    #
    # That workflow field is written once, when the workflow is created, and
    # never revisited. Edit the roster afterwards and every new ticket still
    # named whoever was first back then — including people since removed from
    # the roster, moved to another team, or gone from the company. It is not a
    # display value: `require_primary_assignee`, `assign_executor`,
    # `reassign_executor` and `escalate` all grant on this field alone, so the
    # drift handed real authority to people the roster says hold nothing. It is
    # the same defect that put a department head on these tickets, one layer
    # down.
    #
    # Reading it live costs nothing — `cat` is already loaded — and it cannot go
    # stale. The workflow snapshot stays as the fallback for legacy categories
    # with no roster at all, which is the only case that has no primary to name.
    _first_primary = next(
        (
            e
            for e in (cat.executors or [])
            if e.role == ExecutorRoleEnum.PRIMARY
        ),
        None,
    )
    primary_assignee_user_id = (
        str(_first_primary.user_id)
        if _first_primary
        else workflow.primary_assignee_user_id
    )

    sr = ServiceRequest(
        ticket_no=ticket_no,
        organisation_id=user.organisation_id,
        requester_user_id=user.id,
        category_id=str(cat.id),
        request_type_id=str(rt.id),
        sla_rule_id=str(sla_rule.id),
        workflow_id=str(workflow.id),
        priority=body.priority,
        title=body.title,
        description=body.description,
        request_status=initial_status,
        primary_assignee_user_id=primary_assignee_user_id,
        executor_user_id=chosen_executor_user_id,
        current_level_index=current_level_index,
        submitted_on=now,
        assigned_at=now if chosen_executor_user_id else None,
        first_response_due_by=first_response_due_by,
        resolution_due_by=resolution_due_by,
        created_by=user.id,
        created_on=now,
    )
    uploaded_keys: list[str] = []
    try:
        await sr.insert()
        attachments: list[Attachment] = []
        for f in files:
            storage_key, size_bytes = await put_upload_file(
                f"srm/{user.organisation_id}/{sr.id}", f
            )
            uploaded_keys.append(storage_key)
            att = Attachment(
                service_request_id=str(sr.id),
                # Normalised before storage — the raw client filename is echoed
                # back in the detail view and the download response.
                filename=safe_filename(f.filename),
                mime_type=f.content_type or "application/octet-stream",
                size_bytes=size_bytes,
                storage_key=storage_key,
                uploaded_by=user.id,
                uploaded_on=now,
                created_by=user.id,
                created_on=now,
            )
            await att.insert()
            attachments.append(att)
    except Exception:
        # Cleanup uploaded objects on partial failure.
        for k in uploaded_keys:
            try:
                await storage_delete(k)
            except Exception:  # noqa: BLE001
                pass
        try:
            await sr.delete()
        except Exception:  # noqa: BLE001
            pass
        raise

    # Enroll both deadlines for the SLA tick.
    try:
        deadline_entries: dict[str, float] = {
            f"{sr.id}:first_response": first_response_due_by.timestamp(),
            f"{sr.id}:resolution": resolution_due_by.timestamp(),
        }
        # Workflow-level escalation (independent of SLA breach): enroll the
        # auto-escalate timer and the pre-notify warning when the workflow's
        # EscalationConfig says so. The SLA tick consumes these entries the
        # same way it consumes first_response/resolution deadlines — same
        # store, distinct member suffix per event kind.
        #
        # `workflow.id`, not `str(...)`: `EscalationConfig.workflow_id` is a
        # PydanticObjectId, so Mongo stores an ObjectId and a string never
        # matches it. Every other lookup of this document passes the raw id
        # (service_sla_tick.py, workflows/service.py, utils/watcher.py).
        try:
            ec = await EscalationConfig.find_one(
                {"workflow_id": workflow.id, "deleted_on": None}
            )
        except Exception:  # noqa: BLE001
            # Never silently: a swallowed NameError here is precisely how this
            # block sat dead, enrolling nothing and logging nothing.
            logger.warning(
                "enrol.escalation_config.failed id=%s workflow=%s",
                sr.id,
                workflow.id,
                exc_info=True,
            )
            ec = None
        if (
            ec
            and ec.auto_escalate_enabled
            and ec.escalate_to_user_id
            and ec.escalate_after_minutes
            and ec.escalate_after_minutes > 0
        ):
            from datetime import timedelta
            escalate_at = now + timedelta(minutes=ec.escalate_after_minutes)
            deadline_entries[f"{sr.id}:auto_escalate"] = escalate_at.timestamp()
            if (
                ec.pre_notify_enabled
                and ec.pre_notify_minutes_before
                and ec.pre_notify_minutes_before > 0
                and ec.pre_notify_minutes_before < ec.escalate_after_minutes
            ):
                pre_notify_at = escalate_at - timedelta(
                    minutes=ec.pre_notify_minutes_before
                )
                deadline_entries[f"{sr.id}:pre_notify"] = pre_notify_at.timestamp()
        await enrol(deadline_entries)
    except Exception:  # noqa: BLE001
        logger.warning("enrol.sla.failed id=%s", sr.id)

    # Events.
    event_payload = {
        "ticket_no": ticket_no,
        "service_request_id": str(sr.id),
        "organisation_id": user.organisation_id,
        "requester_user_id": user.id,
        "category_id": str(cat.id),
        "request_type_id": str(rt.id),
        "priority": body.priority.value,
        "status": initial_status.value,
        "first_response_due_by": first_response_due_by.isoformat(),
        "resolution_due_by": resolution_due_by.isoformat(),
    }
    await publish_event("submitted", event_payload)

    # Journey timeline: a "Service request raised" node + a +1 to the per-FY SR
    # count (IAM consumes this off the shared domain_events bus).
    try:
        await outbox_publish(
            "service_request.raised",
            {
                "user_id": user.id,
                "organisation_id": user.organisation_id,
                "sr_id": str(sr.id),
                "ticket_no": ticket_no,
                "title": body.title,
                "category": cat.name,
                "raised_on": now.isoformat(),
            },
            idempotency_key=f"service_request.raised:{sr.id}",
        )
    except Exception:  # noqa: BLE001
        logger.warning("journey.service_request.raised.failed ticket=%s", ticket_no)

    try:
        await emit_activity(
            event=ActivityEventEnum.SUBMITTED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"ticket_no": ticket_no, "priority": body.priority.value},
        )
        await emit_audit(
            event="request.submitted",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(sr.id), "ticket_no": ticket_no},
        )
    except Exception:  # noqa: BLE001
        pass

    # If the requester picked an executor and the ticket landed directly in
    # ASSIGNED (no approval required), emit the assignment event so the
    # downstream consumers + dashboards behave the same way they do when a
    # primary calls assign-executor.
    if chosen_executor_user_id and initial_status == RequestStatusEnum.ASSIGNED:
        try:
            await publish_event(
                "assigned",
                {
                    "service_request_id": str(sr.id),
                    "ticket_no": ticket_no,
                    "executor_user_id": chosen_executor_user_id,
                    "actor_user_id": user.id,
                    "notes": None,
                },
            )
            await emit_activity(
                event=ActivityEventEnum.ASSIGNED,
                service_request_id=str(sr.id),
                actor_user_id=user.id,
                organisation_id=user.organisation_id,
                details={"executor_user_id": chosen_executor_user_id},
            )
        except Exception:  # noqa: BLE001
            pass

    # Email notifications.
    try:
        from ..email_events import (
            notify_request_submitted,
            notify_approval_pending,
            notify_request_intimation,
            notify_executor_assigned,
        )
        from ..common.email_resolver import resolve_user_info
        from ..config import settings as _settings

        requester_info = {"email": user.email or "", "name": user.display_name or user.first_name or ""}
        if requester_info["email"]:
            await notify_request_submitted(
                requester_email=requester_info["email"],
                requester_name=requester_info["name"],
                ticket_no=ticket_no,
                title=body.title,
                sr_id=str(sr.id),
                description=body.description or "",
                priority=body.priority.value,
                category_name=cat.name,
                submitted_at=sr.submitted_on.isoformat() if sr.submitted_on else "",
                tenant_id=user.organisation_id,
            )

        # Executor email when the ticket was assigned directly at creation.
        if chosen_executor_user_id and initial_status == RequestStatusEnum.ASSIGNED:
            exec_info = await resolve_user_info(
                chosen_executor_user_id, access_token=user.access_token
            )
            if exec_info["email"]:
                await notify_executor_assigned(
                    executor_email=exec_info["email"],
                    executor_name=exec_info["name"],
                    requester_email=requester_info["email"],
                    requester_name=requester_info["name"],
                    ticket_no=ticket_no,
                    title=body.title,
                    sr_id=str(sr.id),
                    description=body.description or "",
                    category_name=cat.name,
                    priority=body.priority.value,
                    sla_due_at=resolution_due_by.isoformat(),
                    tenant_id=user.organisation_id,
                )

        # Approval-pending emails are no longer fired at create time —
        # approval is now executor-triggered (POST /submit-for-approval).
        # That endpoint fans out approver emails when the executor submits.

        # ── Roster intimation ────────────────────────────────────────────
        # Every executor on the category's roster — primary *and* secondary,
        # and nobody else — is told a ticket has landed in their category.
        #
        # This used to mail every employee of every department the category
        # names. That put each ticket in the inbox of dozens of people who
        # would never touch it while the secondaries who actually work the
        # queue were only reached by accident of department membership. The
        # roster is the authoritative answer to "who works this category"
        # (`categories.service.resolve_workforce`), so it is the audience.
        #
        # `settings.ROSTER_INTIMATION_ENABLED` is the kill switch (default on).
        # No recipient cap: a roster is a hand-picked list, not a headcount.
        roster = list(cat.executors or [])
        if _settings.ROSTER_INTIMATION_ENABLED and roster:
            # Two people already have this ticket in their inbox from the mails
            # sent above, and a second copy of "a request was raised" is noise:
            # the requester (request_submitted) and, when the ticket was routed
            # straight to someone at creation, that executor (executor_assigned).
            already_mailed = {str(user.id)}
            if chosen_executor_user_id and initial_status == RequestStatusEnum.ASSIGNED:
                already_mailed.add(str(chosen_executor_user_id))

            seen: set[str] = set()
            sent_by_role: dict[str, int] = {"primary": 0, "secondary": 0}
            unresolved: list[str] = []
            for ex in roster:
                if str(ex.user_id) in already_mailed:
                    continue
                # `email` is the snapshot taken when the roster was saved. A
                # roster saved before that snapshot existed carries "", so fall
                # back to IAM rather than silently skipping the person.
                email_addr = (ex.email or "").strip()
                if not email_addr:
                    info = await resolve_user_info(
                        str(ex.user_id), access_token=user.access_token
                    )
                    email_addr = (info["email"] or "").strip()
                    ex_name = info["name"] or email_addr
                else:
                    ex_name = ex.name or email_addr
                if not email_addr:
                    unresolved.append(str(ex.user_id))
                    continue
                if email_addr.lower() in seen:
                    continue
                seen.add(email_addr.lower())
                await notify_request_intimation(
                    recipient_email=email_addr,
                    recipient_name=ex_name,
                    ticket_no=ticket_no,
                    title=body.title,
                    sr_id=str(sr.id),
                    description=body.description or "",
                    priority=body.priority.value,
                    category_name=cat.name,
                    department_name=ex.department_name or "",
                    requester_name=requester_info["name"],
                    submitted_at=sr.submitted_on.isoformat() if sr.submitted_on else "",
                    tenant_id=user.organisation_id,
                )
                sent_by_role[ex.role.value] = sent_by_role.get(ex.role.value, 0) + 1
            logger.info(
                "email.roster_intimation.published ticket=%s category=%s "
                "primary=%d secondary=%d roster=%d",
                ticket_no,
                cat.name,
                sent_by_role.get("primary", 0),
                sent_by_role.get("secondary", 0),
                len(roster),
            )
            if unresolved:
                # Same reasoning as resolve_user_info's own warning: without
                # this, "rostered but never mailed" leaves no trace at all.
                logger.warning(
                    "email.roster_intimation.no_address ticket=%s users=%s",
                    ticket_no,
                    ",".join(unresolved),
                )
    except Exception:  # noqa: BLE001
        logger.warning("email.submitted.failed ticket=%s", ticket_no)

    response = {
        "id": str(sr.id),
        "ticket_no": ticket_no,
        "status": initial_status.value,
        "submitted_on": now.isoformat(),
        "first_response_due_by": first_response_due_by.isoformat(),
        "resolution_due_by": resolution_due_by.isoformat(),
        "requester_user_id": user.id,
        "category_id": str(cat.id),
        "request_type_id": str(rt.id),
        "sla_rule_id": str(sla_rule.id),
        "workflow_id": str(workflow.id),
        # Echo what was actually stored on the ticket, not the workflow's
        # snapshot — they differ whenever the roster has moved on.
        "primary_assignee_user_id": str(primary_assignee_user_id),
        "executor_user_id": chosen_executor_user_id,
        "priority": body.priority.value,
        "title": body.title,
        "description": body.description,
        "attachments": [
            {"id": str(a.id), "filename": a.filename, "size_bytes": a.size_bytes}
            for a in attachments
        ],
    }

    if idempotency_header:
        await _store_idempotency(user.id, idempotency_header, payload_hash, response)

    return response
