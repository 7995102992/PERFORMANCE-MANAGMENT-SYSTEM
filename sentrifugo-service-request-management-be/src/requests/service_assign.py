"""Assign-executor + Escalate — Chapter 7."""
from __future__ import annotations

import logging
from typing import Any

from ..audit import emit_activity
from ..common.iam_helpers import try_oid, user_name
from ..auth.utils.dependencies import UserBase
from ..common.timestamps import utcnow
from ..exceptions import (
    EscalationReasonRequired,
    EscalationTargetInvalid,
    ExecutorInvalid,
    ExecutorSameAsCurrent,
    ExecutorUnresolved,
    Forbidden,
    InvalidStateTransition,
    NoEscalationPrimaryAvailable,
    NotPrimaryAssignee,
    RequestTerminal,
)
from ..integrations.iam_client import get_iam_client
from ..models import (
    ActivityEventEnum,
    Category,
    EscalationConfig,
    ExecutorRoleEnum,
    HandoffEvent,
    HandoffKindEnum,
    RequestStatusEnum,
    ServiceRequest,
    TERMINAL_STATUSES,
)
from ..rabbitmq import publish_event
from .schemas import AssignExecutorBody, EscalateBody
from .utils.self_dealing import deny_requester_actor, is_requester
from .utils.state_machine import status_phrase
from .utils.watcher import notify_watcher_if_subscribed
from .service_detail import (
    _is_executor_of,
    get_request_detail,
    require_ticket_access,
)


logger = logging.getLogger(__name__)


async def _load_non_terminal(sr_id: str, organisation_id: str) -> ServiceRequest:
    sr = await ServiceRequest.get(sr_id)
    if sr is None or sr.deleted_on is not None or str(sr.organisation_id) != organisation_id:
        from ..exceptions import DomainException
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    if sr.request_status in TERMINAL_STATUSES:
        raise RequestTerminal()
    return sr


def _category_dept_ids(cat: Category | None) -> list:
    """The category's departments, tolerating un-migrated documents."""
    from ..categories.service import category_department_ids

    return category_department_ids(cat) if cat else []


async def _ticket_dept_head_ids(cat: Category | None, user: UserBase) -> list[str]:
    """Heads of every department the ticket's category is staffed from.

    A category spans a list of departments now, and each of their heads is an
    implicit primary (D3) — so this is a list, not the single head escalation
    used to be hard-wired to.
    """
    dept_ids = _category_dept_ids(cat)
    if not dept_ids:
        return []
    from ..categories.service import _department_meta

    meta = await _department_meta(dept_ids, user)
    seen: list[str] = []
    for did in [str(d) for d in dept_ids]:
        head = (meta.get(did) or {}).get("head_user_id")
        if head and head not in seen:
            seen.append(head)
    return seen


async def _roster_candidates(cat: Category) -> list[dict[str, Any]]:
    """The category's roster as executor-picker rows.

    Built from the stored roster rather than by filtering a page of department
    employees: IAM caps that page at 100, so a rostered executor who happens to
    sort past the cap would silently vanish from the picker. The name/email
    snapshot taken at save time is what makes this possible without N lookups.

    The roster and nothing else. This used to append every department head
    absent from it, badged "primary", on the old rule that a head was an
    implicit primary — but `_assert_target_in_workforce` resolves eligibility
    through `resolve_workforce`, which stopped honouring heads once a roster
    exists. The picker was therefore offering targets the assign and reassign
    endpoints answer with `ExecutorInvalid`, which is the drift the comment in
    `list_eligible_executors` exists to prevent, running the other way.

    A head who should be assignable is either on the roster or a member of one
    of the category's departments; the second case still reaches the picker via
    `_department_candidate_rows` on a non-exclusive roster. Dropping the head
    lookup also removes an IAM round-trip per department, per call, whose
    result was already being discarded by `resolve_workforce`.
    """
    rows = [
        {
            "user_id": str(e.user_id),
            "employee_id": e.employee_id or "",
            "name": e.name or None,
            "email": e.email or None,
            "designation": None,
            "role": e.role.value,
        }
        for e in cat.executors
    ]
    return rows


async def _assert_target_in_workforce(
    sr: ServiceRequest, executor_user_id, user: UserBase
) -> None:
    """Reject an executor who is not on the category's roster.

    Only enforced once a roster exists. With none configured the pool is the
    whole department and assignment has never been restricted to it, so
    tightening that here would change behaviour for every existing category —
    the one thing the roster rollout is meant to avoid.
    """
    from ..categories.service import _department_employees, resolve_workforce

    cat = await Category.get(sr.category_id)
    if cat is None or not cat.executors:
        return
    head_ids = await _ticket_dept_head_ids(cat, user)
    # This function returns early above when the roster is empty, so the roster
    # is always the answer here (D8 removed) and department members no longer
    # widen it. That makes the `_department_employees` fetch dead weight — it
    # was an IAM round-trip per assign whose result `resolve_workforce` now
    # discards.
    if str(executor_user_id) not in resolve_workforce(cat, head_ids):
        raise ExecutorInvalid(
            "That person is not on this category's executor roster, so they "
            "cannot be given its tickets. Add them to the roster first."
        )


def _employee_candidate_row(emp: dict[str, Any]) -> dict[str, Any]:
    """One picker row built from an IAM employee document.

    `role` is None: a plain department member holds no roster label. The UI
    renders that as an untagged candidate, same as every row in a category that
    has no roster at all.
    """
    first = emp.get("firstName") or emp.get("first_name") or ""
    last = emp.get("lastName") or emp.get("last_name") or ""
    return {
        "user_id": str(emp.get("userId") or emp.get("user_id") or emp.get("id", "")),
        "employee_id": str(emp.get("id", "")),
        "name": f"{first} {last}".strip() or None,
        "email": emp.get("email") or emp.get("workEmail") or None,
        "designation": emp.get("designationName"),
        "role": None,
    }


async def _department_candidate_rows(
    cat: Category, user: UserBase
) -> list[dict[str, Any]]:
    """Every member of the category's departments, as picker rows."""
    from ..categories.service import _department_employees

    employees = (await _department_employees(_category_dept_ids(cat), user)).values()
    return [_employee_candidate_row(emp) for emp in employees]


async def _open_ticket_counts(user_ids: list[str]) -> dict[str, int]:
    """Open-ticket count per candidate, in one aggregation.

    This replaces a `.count()` per row. With the department pool unioned into
    the picker below, that was one query per employee of every selected
    department on each open of the dropdown — fine for a hand-built roster of
    ten, not for a department of two hundred.

    Deliberately unfiltered by organisation and `deleted_on`, matching the
    per-row count it replaces: this is a workload signal, not a report, and
    changing what it counts would silently move everyone's availability flag.
    """
    oids = [try_oid(u) for u in user_ids if u]
    if not oids:
        return {}
    rows = await ServiceRequest.aggregate(
        [
            {
                "$match": {
                    "executor_user_id": {"$in": oids},
                    "request_status": {
                        "$in": [
                            RequestStatusEnum.ASSIGNED.value,
                            RequestStatusEnum.IN_PROGRESS.value,
                        ]
                    },
                }
            },
            {"$group": {"_id": "$executor_user_id", "n": {"$sum": 1}}},
        ]
    ).to_list()
    return {str(r["_id"]): int(r["n"]) for r in rows}


async def list_eligible_executors(sr_id: str, user: UserBase) -> dict[str, Any]:
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    cat = await Category.get(sr.category_id)
    # Mirror the reassign permission rule (service_assign.reassign_executor):
    # the ticket's primary assignee, or anyone holding the dept-head-tier powers
    # on this category. `_can_manage_ticket` is where the roster overrides the
    # manager ACL (D7) — with a roster configured, editor-acl alone is not
    # enough to see the picker.
    from .service_detail import _can_manage_ticket
    # Mirrors the actor rule the two write endpoints now enforce, so the picker
    # can't offer a choice that `assign_executor` / `reassign_executor` refuse.
    deny_requester_actor(sr, user, "choose an executor for")
    is_primary = sr.primary_assignee_user_id == user.oid
    if not is_primary and not await _can_manage_ticket(sr, user, cat):
        raise NotPrimaryAssignee()
    if cat is None:
        return {"items": []}

    if cat.executors:
        # Roster only (D8 removed). The department pool used to be appended here
        # so the picker matched `_assert_target_in_workforce`, which accepted a
        # plain department member; both now answer from the roster alone, so
        # they still agree and this needs no IAM call at all — a configured
        # roster is served entirely from its stored snapshot and is immune to an
        # IAM outage.
        rows = await _roster_candidates(cat)
    else:
        # No roster — every selected department is the pool, exactly as before
        # for the single-department categories that exist today. No try/except:
        # with nothing stored to fall back on, an empty dropdown would be a
        # silent lie, so let the IAM failure surface.
        rows = await _department_candidate_rows(cat, user)

    # Filter first, then price the whole set with one aggregation. Roster rows
    # come first in `rows`, so the dedupe below keeps the labelled entry when
    # someone is both on the roster and in the department.
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        candidate_id = row["user_id"]
        if not candidate_id or candidate_id in seen:
            continue
        # Requester can never be the executor — drop them from the dropdown.
        # Backend also rejects this at assign_executor, this is just so the
        # primary doesn't accidentally see their own requester as an option.
        if candidate_id == str(sr.requester_user_id):
            continue
        # The person who already holds it. `reassign_executor` answers this with
        # ExecutorSameAsCurrent, so offering them is offering a choice that 400s
        # — and after an escalation the current executor is the primary doing
        # the reassigning, i.e. the dropdown was offering them themselves.
        if sr.executor_user_id and candidate_id == str(sr.executor_user_id):
            continue
        # The caller. A primary opening this picker is deciding who *else*
        # handles the ticket, so their own row is noise at best: on an
        # unassigned ticket taking it themselves is what Assign-to-me is for
        # (`can_self_assign`), and on an assigned one the line above already
        # removes them whenever they are the executor.
        #
        # Consequence worth knowing: a primary can no longer take over an
        # already-assigned ticket through Reassign, since Assign-to-me stops at
        # `pending_assignment`. Nobody has asked for that move; if it is wanted,
        # widen `can_self_assign` rather than putting this row back.
        if candidate_id == str(user.id):
            continue
        seen.add(candidate_id)
        candidates.append(row)

    counts = await _open_ticket_counts([c["user_id"] for c in candidates])
    items = [
        {
            **row,
            "availability": (
                "occupied" if counts.get(row["user_id"], 0) >= 5 else "available"
            ),
            "open_tickets": counts.get(row["user_id"], 0),
            # The executor who escalated this ticket away. They used to be
            # filtered out here and rejected outright by `reassign_executor` as
            # a "ping-pong guard" — but that made the block permanent
            # (`previous_executor_user_id` is never cleared), so once someone
            # escalated a ticket they could never be given it back, and a
            # category whose only workable executor was that person had no
            # reassign target at all.
            #
            # Handing it back is a normal outcome: the executor escalated
            # because they were blocked, and the primary unblocked them. The
            # primary is the authority on that call, every handoff is recorded
            # in `handoff_events`, and second-guessing them in the API is not
            # this layer's job. Surfaced as a flag so the picker can label the
            # row instead of hiding it.
            "previously_escalated_by": (
                bool(sr.previous_executor_user_id)
                and row["user_id"] == str(sr.previous_executor_user_id)
            ),
        }
        for row in candidates
    ]
    return {"items": items}


def _no_target_reason(cat: Category | None, sr: ServiceRequest, user: UserBase) -> str:
    """Why `_eligible_escalation_targets` came back empty, in the caller's terms.

    An empty list has three causes and they need different fixes, so a single
    "no eligible target" message would send people looking in the wrong place.
    Legacy shapes are named explicitly because `raise_request` now rejects them
    — any ticket still showing one predates that check.
    """
    if cat is None:
        return "the ticket's category no longer exists."
    primaries = [
        str(e.user_id)
        for e in (cat.executors or [])
        if e.role == ExecutorRoleEnum.PRIMARY
    ]
    if not primaries:
        return (
            f'the category "{cat.name}" has no primary executor configured. '
            "This ticket predates the check that now blocks raising one here."
        )
    from .service_detail import _snapshot_approver_for_level

    # Mirror `_eligible_escalation_targets._usable` exactly. If the two drift,
    # this explains an emptiness the picker did not actually produce.
    excluded = {user.id, str(sr.requester_user_id)}
    deciding = None
    holder = None
    if sr.request_status == RequestStatusEnum.PENDING_APPROVAL:
        deciding = _snapshot_approver_for_level(sr, sr.current_level_index)
        if deciding:
            excluded.add(str(deciding))
    elif sr.executor_user_id:
        holder = str(sr.executor_user_id)
        excluded.add(holder)
    remaining = set(primaries) - excluded
    if not remaining:
        if deciding and set(primaries) == {str(deciding)}:
            return (
                f'the only primary executor on "{cat.name}" is already the '
                "approver holding this ticket, so escalating to them would "
                "not move it anywhere."
            )
        if holder and set(primaries) == {holder}:
            return (
                f'the only primary executor on "{cat.name}" is already the '
                "executor of this ticket, so there is nobody to hand it to. "
                "Escalation moves a ticket between primaries, and this "
                "category has only one."
            )
        if primaries == [str(sr.requester_user_id)]:
            return (
                f'the only primary executor on "{cat.name}" is the person who '
                "raised this ticket, and a ticket cannot be escalated to its "
                "own requester."
            )
        return (
            f'every primary executor on "{cat.name}" is either you, the '
            "requester, or the person already holding the ticket — and "
            "escalation is a hand-off to someone else."
        )
    return f'no primary executor on "{cat.name}" is eligible.'


async def _eligible_escalation_targets(
    sr: ServiceRequest, user: UserBase
) -> list[dict[str, Any]]:
    """The category's primaries, minus the caller — the escalation candidates.

    The roster's primaries and nobody else. Escalation is a choice among them
    rather than a forced hand-off to one person. This answers for BOTH phases:
    the executor phase, where the target takes over the work, and the approval
    phase, where the target takes over the decision. `escalate` validates
    against this same list, so the picker and the endpoint cannot disagree.

    No department-head fallback. It used to be here, because a ticket could be
    raised into a category with no primary and would otherwise have jammed with
    no escalation route at all. That fallback was the last place a head off the
    roster still received category powers D3 had taken away — a head who cannot
    assign or reassign the ticket was still being handed it.

    `raise_request` now refuses a category with no primary, so the shape that
    made the fallback necessary cannot be created. What remains is a category
    whose primaries are all filtered out below — in practice a single primary
    who is also the requester — and that is a configuration gap the caller
    should be told about, not routed around: see `_no_target_reason`.
    """
    from .service_detail import _snapshot_approver_for_level

    cat = await Category.get(sr.category_id)
    if cat is None:
        return []

    def _usable(ids: set[str]) -> set[str]:
        # Never the caller (escalation is a hand-off) and never the requester:
        # `escalate` rejects both, so offering either is offering a choice that
        # 400s — the same reason `list_eligible_executors` filters the requester
        # out of the assign dropdown.
        ids.discard(user.id)
        ids.discard(str(sr.requester_user_id))
        # Approval phase: also drop whoever is already deciding. Escalation here
        # installs an override approver, so naming the person who already holds
        # the decision is a call that succeeds and moves nothing. Only the
        # snapshotted approver is resolvable without another query; legacy
        # workflow-driven tickets fall through and are held by the primaries
        # filter alone.
        if sr.request_status == RequestStatusEnum.PENDING_APPROVAL:
            deciding = _snapshot_approver_for_level(sr, sr.current_level_index)
            if deciding:
                ids.discard(str(deciding))
        else:
            # Executor phase: drop whoever already holds the ticket. Usually
            # that is the caller and the discard above covered it — but a
            # primary may escalate a ticket someone else is executing, and if
            # that executor is themselves a primary they would otherwise show
            # up as a target. `escalate` rejects them (`current_owner`), so
            # offering them is offering a choice that 400s.
            if sr.executor_user_id:
                ids.discard(str(sr.executor_user_id))
        return ids

    # Read straight off the roster rather than through `resolve_primaries`,
    # which falls back to the department heads when no primary is configured —
    # exactly the behaviour being removed here. That helper keeps its fallback
    # for the callers that still want the legacy shape.
    primary_ids = _usable({
        str(e.user_id)
        for e in (cat.executors or [])
        if e.role == ExecutorRoleEnum.PRIMARY
    })
    if not primary_ids:
        return []

    snapshots = {
        str(e.user_id): e
        for e in (cat.executors or [])
        if str(e.user_id) in primary_ids
    }
    unknown = sorted(primary_ids - snapshots.keys())
    docs: dict[str, dict] = {}
    if unknown:
        docs = await get_iam_client().get_users(
            unknown, access_token=user.access_token
        ) or {}

    items: list[dict[str, Any]] = []
    for uid in sorted(primary_ids):
        snap = snapshots.get(uid)
        if snap is not None and snap.name:
            items.append(
                {
                    "user_id": uid,
                    "name": snap.name,
                    "email": snap.email or None,
                    # Always "primary" now. This used to be
                    # `"department_head" if uid in head_ids else "primary"`;
                    # `head_ids` went away with the fallback, and every id
                    # reaching here comes off the roster's PRIMARY rows.
                    "role": "primary",
                }
            )
            continue
        doc = docs.get(uid) or {}
        items.append(
            {
                "user_id": uid,
                "name": user_name(doc),
                "email": doc.get("email") or doc.get("workEmail"),
                "role": "primary",
            }
        )
    return items


async def list_eligible_escalation_targets(
    sr_id: str, user: UserBase
) -> dict[str, Any]:
    """Escalation candidates for the picker.

    Returns 200 with an empty list rather than raising when nobody is eligible —
    this feeds a dropdown, and the caller needs to render the reason inside the
    dialog rather than handle an error on open. `escalate` is where the same
    condition becomes a refusal, since that is a caller trying to act on it.
    """
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    await require_ticket_access(sr, user)
    items = await _eligible_escalation_targets(sr, user)
    if items:
        return {"items": items}
    cat = await Category.get(sr.category_id)
    return {"items": [], "reason": _no_target_reason(cat, sr, user)}


async def assign_executor(
    sr_id: str, body: AssignExecutorBody, user: UserBase
) -> dict[str, Any]:
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status != RequestStatusEnum.PENDING_ASSIGNMENT:
        raise InvalidStateTransition(
            "This ticket already has an executor, so it cannot be assigned "
            f"again — it is {status_phrase(sr.request_status)}. Use Reassign "
            "to hand it to someone else."
        )

    cat = await Category.get(sr.category_id)
    # The requester does not route their own ticket, even when they are one of
    # the category's primaries (see utils/self_dealing). Checked before the
    # role checks so a requester-primary gets the reason, not NotPrimaryAssignee.
    deny_requester_actor(sr, user, "assign an executor to")
    is_primary = sr.primary_assignee_user_id == user.oid or user.is_super_admin
    if not is_primary:
        # A category primary assigns too — `can_assign` (service_detail.py) has
        # offered them the button since the roster change, and gating the
        # endpoint on the ticket's snapshotted assignee alone left every primary
        # who isn't the department head looking at an enabled button that 403s.
        from .service_detail import _is_category_primary
        is_primary = await _is_category_primary(sr, user, cat)
    is_self_assign = str(body.executor_user_id) == user.id

    # Self-assign on an open ticket: anyone who may act as executor on it. The
    # primary assignee may still pick any specific executor for someone else.
    #
    # `_can_act_as_executor` covers roster membership, the no-roster department
    # fallback, the dept head whose employee record may point at a different
    # department, and the manager ACL *only* where no roster overrides it (D7).
    # It is the same helper `can_self_assign` is computed from, so the button
    # and the endpoint can't drift apart.
    is_eligible_self_assign = False
    if is_self_assign and not is_primary:
        from .service_detail import _can_act_as_executor
        is_eligible_self_assign = await _can_act_as_executor(sr, user, cat)

    if not is_primary and not is_eligible_self_assign:
        raise NotPrimaryAssignee()

    # Block assigning the ticket to the requester — they can never be the
    # executor of their own ticket (conflict of interest: they'd approve
    # their own resolution). This covers both self-assign by the requester
    # AND the primary trying to pick the requester via Assign Executor.
    # Super admin bypasses since they bypass all assignment checks.
    if (
        body.executor_user_id == sr.requester_user_id
        and not user.is_super_admin
    ):
        from ..exceptions import Forbidden
        raise Forbidden("Requester cannot be the executor of their own ticket")

    iam = get_iam_client()
    if not is_self_assign:
        exec_user = await iam.get_user(str(body.executor_user_id), access_token=user.access_token)
        if not exec_user:
            # Stale roster, not a bad choice — see `ExecutorUnresolved`.
            raise ExecutorUnresolved(str(body.executor_user_id))
        # Self-assign already went through `_is_category_workforce` above; this
        # is the assign-someone-else path, which must match the picker.
        await _assert_target_in_workforce(sr, body.executor_user_id, user)

    now = utcnow()
    sr.executor_user_id = body.executor_user_id
    sr.request_status = RequestStatusEnum.ASSIGNED
    # First assignment wins — keep the original assigned_at on reassignment.
    if sr.assigned_at is None:
        sr.assigned_at = now
    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    await publish_event(
        "assigned",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "executor_user_id": str(body.executor_user_id),
            "actor_user_id": user.id,
            "notes": body.notes,
        },
    )
    await notify_watcher_if_subscribed(
        sr.workflow_id,
        "assignment",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "executor_user_id": str(body.executor_user_id),
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.ASSIGNED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"executor_user_id": str(body.executor_user_id)},
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_executor_assigned
        from ..common.email_resolver import resolve_user_info
        exec_info = await resolve_user_info(str(body.executor_user_id), access_token=user.access_token)
        req_info = await resolve_user_info(str(sr.requester_user_id), access_token=user.access_token)
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        if exec_info["email"]:
            await notify_executor_assigned(
                executor_email=exec_info["email"],
                executor_name=exec_info["name"],
                requester_email=req_info["email"],
                requester_name=req_info["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                category_name=cat_name,
                priority=sr.priority.value if sr.priority else "",
                sla_due_at=sr.resolution_due_by.isoformat() if sr.resolution_due_by else "",
                tenant_id=sr.organisation_id,
            )
        # The roster works this category and the approvers signed off on it, so
        # both hear about a change of hands. `notify_requester=False` keeps the
        # requester's own copy to the single send above instead of one per
        # person here; the actor and the direct recipient are excluded too.
        from .notify_helpers import ticket_recipients
        already = {str(user.id), str(sr.requester_user_id)}
        if sr.executor_user_id:
            already.add(str(sr.executor_user_id))
        for r in await ticket_recipients(
            sr, exclude_user_ids=already, access_token=user.access_token
        ):
            await notify_executor_assigned(
                executor_email=r["email"],
                executor_name=r["name"],
                requester_email="",
                requester_name="",
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                category_name=cat_name,
                notify_requester=False,
                priority=sr.priority.value if sr.priority else "",
                sla_due_at=sr.resolution_due_by.isoformat() if sr.resolution_due_by else "",
                tenant_id=sr.organisation_id,
            )
    except Exception:
        pass

    return await get_request_detail(str(sr.id), user)


async def reassign_executor(
    sr_id: str, body: AssignExecutorBody, user: UserBase
) -> dict[str, Any]:
    from .service_detail import _can_manage_ticket, _is_category_primary
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    cat = await Category.get(sr.category_id)
    # Same rule as assign: raising a ticket does not come with the right to
    # decide who handles it (see utils/self_dealing).
    deny_requester_actor(sr, user, "reassign")
    is_primary = sr.primary_assignee_user_id == user.oid
    is_category_primary = await _is_category_primary(sr, user, cat)
    # `_can_manage_ticket` is the manager path, roster-aware: with a roster
    # configured the ACL grants nothing here and only the primaries reassign (D7).
    if not (is_primary or is_category_primary or await _can_manage_ticket(sr, user, cat)):
        raise NotPrimaryAssignee()
    # Workflow approvers (L1/L2) can't reassign — even when they also hold
    # the manager / primary / dept-head role. Super admin bypasses.
    if not user.is_super_admin:
        is_workflow_approver = user.oid in {
            sr.level_1_approver_user_id,
            sr.level_2_approver_user_id,
        }
        if not is_workflow_approver:
            from ..models import ApprovalLevel, Approver
            _lvl_rows = await ApprovalLevel.find(
                {"workflow_id": sr.workflow_id, "deleted_on": None}
            ).to_list()
            _lvl_ids = [_l.id for _l in _lvl_rows]
            if _lvl_ids:
                _ap_row = await Approver.find_one(
                    {
                        "approval_level_id": {"$in": _lvl_ids},
                        "approver_user_id": user.oid,
                        "deleted_on": None,
                    }
                )
                if _ap_row is not None:
                    is_workflow_approver = True
        if is_workflow_approver:
            raise Forbidden("Workflow approvers cannot reassign this ticket")
    # Post-reassign lockdown: only a category primary (or super admin) may
    # reassign again. Primary assignee / manager are locked out once a
    # reassignment has happened; a primary keeps reassign regardless of whether
    # they are the current executor.
    if sr.reassigned_at and not user.is_super_admin:
        if not is_category_primary:
            raise Forbidden("Ticket has already been reassigned")
    if sr.request_status not in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS):
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so it cannot "
            "be reassigned. Reassignment is only possible while it is assigned "
            "or in progress."
        )
    iam = get_iam_client()
    exec_user = await iam.get_user(str(body.executor_user_id), access_token=user.access_token)
    if not exec_user:
        # Stale roster, not a bad choice — see `ExecutorUnresolved`. This is the
        # likeliest place to meet it: the reassign picker is drawn from the
        # category roster, so a deleted employee stays selectable until an admin
        # prunes them.
        raise ExecutorUnresolved(str(body.executor_user_id))
    if sr.executor_user_id == body.executor_user_id:
        raise ExecutorSameAsCurrent()
    # Same rule `assign_executor` enforces on the first assignment — reassign
    # is the second door to the same room and had no check at all.
    # `_assert_target_in_workforce` below is not a substitute: it returns
    # immediately for a category with no roster, which is the default.
    if is_requester(sr, body.executor_user_id) and not user.is_super_admin:
        raise Forbidden("Requester cannot be the executor of their own ticket")
    await _assert_target_in_workforce(sr, body.executor_user_id, user)
    # The Phase A "ping-pong guard" that used to sit here — rejecting a reassign
    # back to `previous_executor_user_id` — is gone.
    #
    # It read as a guard against bouncing a ticket straight back at the person
    # who escalated it, but nothing ever cleared the field, so the ban was
    # permanent: one escalation and that executor could never receive the ticket
    # again, at any point in its life, by any primary. It also deadlocked any
    # category whose only other workable executor was that same person.
    #
    # Handing a ticket back is a normal outcome — the executor escalated because
    # they were blocked and the primary unblocked them. `_assert_target_in_
    # workforce` above still holds the real constraint (the target must be in
    # the category's workforce), the requester is still refused, and every
    # handoff is recorded in `handoff_events`. The picker labels the row via
    # `previously_escalated_by` so the choice is informed rather than blocked.

    now = utcnow()
    previous = sr.executor_user_id
    sr.executor_user_id = body.executor_user_id

    # Snapshot the phase being closed BEFORE we reset it, so the pre-reassign
    # lifecycle (and SLA) is preserved — the same shared record escalation uses.
    prior_handoffs = await HandoffEvent.find(
        {"service_request_id": sr.id, "deleted_on": None}
    ).count()
    await HandoffEvent(
        service_request_id=sr.id,
        organisation_id=sr.organisation_id,
        kind=HandoffKindEnum.REASSIGNMENT,
        phase_index=prior_handoffs + 1,
        from_user_id=previous,
        to_user_id=body.executor_user_id,
        reason=body.notes,
        assigned_at=sr.assigned_at,
        first_response_at=sr.first_response_at,
        approval_triggered_at=sr.approval_triggered_at,
        happened_at=now,
        created_by=user.id,
        created_on=now,
    ).insert()

    # Reassignment: mark the handoff and reset progress so the new executor
    # starts with a fresh First Response / In Progress flow. Any approvals
    # taken under the previous executor are also wiped — the new executor
    # gets a clean slate and can re-trigger L1/L2 if needed. Activity log
    # preserves the historical record separately.
    sr.reassigned_at = now
    sr.first_response_at = None
    sr.request_status = RequestStatusEnum.ASSIGNED
    sr.approval_triggered_at = None
    sr.level_2_triggered_at = None
    sr.current_level_index = None
    sr.escalation_override_approver_user_id = None
    # Reassign closes the (possibly escalated) phase: clear is_escalated so the
    # new executor can escalate again, and hide the escalation comment (the
    # reason belongs to the closed phase, preserved in handoff_events).
    # escalated_at is kept so the historical Escalated timeline marker still
    # renders (the timeline marker reads escalated_at, not is_escalated).
    sr.is_escalated = False
    sr.escalation_reason = None
    sr.level_1_approver_user_id = None
    sr.level_2_approver_user_id = None
    sr.level_2_default_user_id = None
    sr.level_2_overridden = False
    sr.level_2_override_chosen_by = None
    sr.rejection_reason = None

    # Soft-delete prior approval decisions so the unique index on
    # (service_request_id, level_index, approver_user_id) doesn't block the
    # new executor from re-triggering with the same approver.
    from ..models import ApprovalDecision
    await ApprovalDecision.find(
        {"service_request_id": sr.id, "deleted_on": None}
    ).update({"$set": {"deleted_on": now, "deleted_by": user.oid}})

    # SLA reset — recompute first_response and resolution deadlines from the
    # reassignment time, then re-seed the deadline store so warnings
    # and breach detection fire against the new clock.
    from datetime import date as _date
    from ..request_types.service import resolve_sla_for_priority
    from .service_create import _org_config
    from .utils.sla import compute_deadline
    from ..sla_store import enrol

    sla_rule = await resolve_sla_for_priority(sr.request_type_id, sr.priority)
    if sla_rule is not None:
        cfg = await _org_config(sr.organisation_id)
        holidays = {_date.fromisoformat(h) for h in (cfg.holidays or [])}
        sr.first_response_due_by = compute_deadline(
            now,
            sla_rule.first_response_minutes,
            business_hours_only=sla_rule.business_hours_only,
            org_tz=cfg.timezone,
            business_hours=cfg.business_hours,
            holidays=holidays,
        )
        sr.resolution_due_by = compute_deadline(
            now,
            sla_rule.resolution_minutes,
            business_hours_only=sla_rule.business_hours_only,
            org_tz=cfg.timezone,
            business_hours=cfg.business_hours,
            holidays=holidays,
        )

    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    # Re-seed the deadline entries for the new clock. Enrolment is an upsert,
    # so this both refreshes entries that are still there and recreates any the
    # prior executor already consumed (first_response is dropped once given).
    if sla_rule is not None:
        try:
            await enrol(
                {
                    f"{sr.id}:first_response": sr.first_response_due_by.timestamp(),
                    f"{sr.id}:resolution": sr.resolution_due_by.timestamp(),
                }
            )
        except Exception:  # noqa: BLE001
            pass

    await publish_event(
        "assigned",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "executor_user_id": str(body.executor_user_id),
            "previous_executor_user_id": str(previous) if previous else None,
            "actor_user_id": user.id,
            "notes": body.notes,
        },
    )
    await notify_watcher_if_subscribed(
        sr.workflow_id,
        "assignment",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "executor_user_id": str(body.executor_user_id),
            "previous_executor_user_id": str(previous) if previous else None,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.REASSIGNED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"from": str(previous) if previous else None, "to": str(body.executor_user_id)},
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_executor_assigned
        from ..common.email_resolver import resolve_user_info
        exec_info = await resolve_user_info(str(body.executor_user_id), access_token=user.access_token)
        req_info = await resolve_user_info(str(sr.requester_user_id), access_token=user.access_token)
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        if exec_info["email"]:
            await notify_executor_assigned(
                executor_email=exec_info["email"],
                executor_name=exec_info["name"],
                requester_email=req_info["email"],
                requester_name=req_info["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                category_name=cat_name,
                priority=sr.priority.value if sr.priority else "",
                sla_due_at=sr.resolution_due_by.isoformat() if sr.resolution_due_by else "",
                tenant_id=sr.organisation_id,
            )
        # The roster works this category and the approvers signed off on it, so
        # both hear about a change of hands. `notify_requester=False` keeps the
        # requester's own copy to the single send above instead of one per
        # person here; the actor and the direct recipient are excluded too.
        from .notify_helpers import ticket_recipients
        already = {str(user.id), str(sr.requester_user_id)}
        if sr.executor_user_id:
            already.add(str(sr.executor_user_id))
        for r in await ticket_recipients(
            sr, exclude_user_ids=already, access_token=user.access_token
        ):
            await notify_executor_assigned(
                executor_email=r["email"],
                executor_name=r["name"],
                requester_email="",
                requester_name="",
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                category_name=cat_name,
                notify_requester=False,
                priority=sr.priority.value if sr.priority else "",
                sla_due_at=sr.resolution_due_by.isoformat() if sr.resolution_due_by else "",
                tenant_id=sr.organisation_id,
            )
    except Exception:
        pass

    return await get_request_detail(str(sr.id), user)


async def escalate(
    sr_id: str, body: EscalateBody, user: UserBase
) -> dict[str, Any]:
    if not body.reason or not body.reason.strip():
        raise EscalationReasonRequired()
    sr = await _load_non_terminal(sr_id, user.organisation_id)
    if sr.request_status not in (
        RequestStatusEnum.PENDING_APPROVAL,
        RequestStatusEnum.ASSIGNED,
        RequestStatusEnum.IN_PROGRESS,
    ):
        raise InvalidStateTransition(
            f"This ticket is {status_phrase(sr.request_status)}, so it cannot "
            "be escalated. Escalation is only possible while it is assigned, "
            "in progress, or waiting on an approval decision."
        )
    # Post-reassign lockdown: only the current executor (after first
    # response) may escalate; primary / manager / current approver are
    # locked out. Super admin always bypasses.
    if sr.reassigned_at and not user.is_super_admin:
        if not (
            sr.executor_user_id == user.oid
            and sr.first_response_at is not None
        ):
            raise Forbidden("Ticket has already been reassigned — escalation closed")

    # Caller relationship check. L1 / L2 approvers cannot escalate — only
    # the executor, primary assignee, or a manager-policy holder may. If the
    # caller is configured as an approver in this workflow, they're blocked
    # from escalation even when they also hold the manager policy.
    # `_is_category_primary` was imported here to refuse a primary's escalation;
    # that refusal is gone (see the Phase A note below), and `_can_manage_ticket`
    # already covers a primary's authority to escalate at all.
    from .service_detail import _can_manage_ticket
    from ..models import ApprovalLevel, Approver
    _cat = await Category.get(sr.category_id)
    # Roster-aware manager check (D7) — with a roster configured, escalation
    # authority sits with the category's primaries, not with the module ACL.
    # The raw ACL is deliberately not accepted here: it applies to every ticket
    # in the organisation, so on its own it let any manager escalate anything.
    _mgr = await _can_manage_ticket(sr, user, _cat)
    is_executor = _is_executor_of(sr, user)
    is_primary = sr.primary_assignee_user_id == user.oid or user.is_super_admin
    if not (_mgr or is_executor or is_primary):
        raise Forbidden("Caller cannot escalate this ticket")
    if not user.is_super_admin:
        is_workflow_approver = user.oid in {
            sr.level_1_approver_user_id,
            sr.level_2_approver_user_id,
        }
        if not is_workflow_approver:
            _lvl_rows = await ApprovalLevel.find(
                {"workflow_id": sr.workflow_id, "deleted_on": None}
            ).to_list()
            _lvl_ids = [_l.id for _l in _lvl_rows]
            if _lvl_ids:
                _ap_row = await Approver.find_one(
                    {
                        "approval_level_id": {"$in": _lvl_ids},
                        "approver_user_id": user.oid,
                        "deleted_on": None,
                    }
                )
                if _ap_row is not None:
                    is_workflow_approver = True
        if is_workflow_approver:
            raise Forbidden("Workflow approvers cannot escalate this ticket")
    # First response must be filed before escalating — for everyone (executor,
    # primary, manager alike). Super admin bypasses for support.
    if sr.first_response_at is None and not user.is_super_admin:
        raise InvalidStateTransition(
            "This ticket has no first response recorded yet, and escalation "
            "requires one. Record a first response on the ticket, then "
            "escalate."
        )
    # No re-escalation once a ticket has been escalated (super admin bypass).
    if sr.is_escalated and not user.is_super_admin:
        raise Forbidden("Ticket has already been escalated")

    # ── Phase A: executor escalates an ASSIGNED/IN_PROGRESS ticket ──
    # The target must be one of the category's primaries — and only those, since
    # the department-head fallback was removed.
    #
    # A primary may escalate too, including to another primary. This used to be
    # refused ("You are a primary executor — escalate via workflow
    # configuration") on the theory that a primary sits at the top of the
    # executor phase with nobody above them to hand to. That theory does not
    # survive a multi-primary roster: primaries are peers, not a ladder, and a
    # primary who is stuck — wrong specialism, on leave, over capacity — has the
    # same need to hand the ticket on as anyone else. The refusal also
    # contradicted `compute_capabilities`, where `can_escalate` grants the
    # button to a category primary via `can_manage`, so they were shown a
    # control that 403'd.
    in_executor_phase = sr.request_status in (
        RequestStatusEnum.ASSIGNED,
        RequestStatusEnum.IN_PROGRESS,
    )
    iam = get_iam_client()

    # Target resolution is the same rule in both phases: the category's
    # primaries and nobody else.
    #
    # Phase B used to check org membership and nothing more, so an executor
    # whose ticket was stuck in approval could install ANY employee in the org
    # as `escalation_override_approver_user_id` — and `require_current_approver`
    # grants approve and reject on that field alone, bypassing the workflow's
    # configured approvers entirely. The picker was never that loose: it calls
    # `_eligible_escalation_targets` regardless of phase, so it has always
    # offered primaries only. The gap was between what the UI offered and what
    # the API accepted, and it was reachable by posting the endpoint directly.
    #
    # Leadership is the more natural pool for handing over an approval decision,
    # and there is precedent for it — `trigger_l2` gates the L2 override on
    # `iam.list_leadership_users`. It is not usable: that helper filters on a
    # policy literally named `dev-leadership`, and no such policy exists in the
    # environment (the policy set is Administrator / Manager / Employee and the
    # per-function Executive/Manager pairs). It returns an empty list, so gating
    # on it would block Phase B outright. Primaries are the category's
    # accountable owners and are actually configured, so they are the pool.
    eligible = await _eligible_escalation_targets(sr, user)
    eligible_ids = {row["user_id"] for row in eligible}
    if not eligible_ids:
        # Not `EscalationTargetInvalid` — the caller has not named a bad
        # target, there is no target to name. The fix is a config change, so
        # say which one rather than leaving them to retry a choice that
        # cannot exist.
        raise NoEscalationPrimaryAvailable(_no_target_reason(_cat, sr, user))
    requested = str(body.escalate_to_user_id) if body.escalate_to_user_id else ""
    if not requested:
        # No choice sent. One candidate is unambiguous (and is the legacy
        # dept-head case); several means the caller has to pick.
        if len(eligible_ids) > 1:
            raise EscalationTargetInvalid()
        requested = next(iter(eligible_ids))
    elif requested not in eligible_ids:
        raise EscalationTargetInvalid()
    body.escalate_to_user_id = requested
    target = await iam.get_user(requested, access_token=user.access_token)
    if not target or target.get("organisation_id") != user.organisation_id:
        raise EscalationTargetInvalid()

    current_owner = (
        sr.executor_user_id
        if in_executor_phase
        else user.id  # approval phase: can't escalate to self
    )
    if str(body.escalate_to_user_id) == str(current_owner):
        raise EscalationTargetInvalid()
    # Never hand the ticket to the person who raised it. This covers BOTH
    # phases and is the only guard on the approval-phase branch above, which
    # validates the target for org membership and nothing else: without it the
    # requester could be installed as `escalation_override_approver_user_id`,
    # and `_is_current_approver` / `require_current_approver` grant approve and
    # reject on that field alone — they would approve their own request. In the
    # executor phase it stops the milder version, being escalated into
    # executing their own ticket and then resolving it.
    if is_requester(sr, body.escalate_to_user_id) and not user.is_super_admin:
        raise EscalationTargetInvalid()

    now = utcnow()
    previous_owner: str | None = None
    if sr.request_status == RequestStatusEnum.PENDING_APPROVAL:
        previous_owner = sr.escalation_override_approver_user_id
        sr.escalation_override_approver_user_id = body.escalate_to_user_id
    else:
        previous_owner = sr.executor_user_id
        # Snapshot the executor we're handing off from. Reassign uses this
        # to block ping-pong back to the original assignee.
        sr.previous_executor_user_id = previous_owner
        sr.executor_user_id = body.escalate_to_user_id
    sr.is_escalated = True
    sr.escalation_count += 1
    sr.escalated_at = now
    sr.escalation_reason = body.reason.strip()

    # Phase A (executor → dept head): snapshot the phase being closed, then
    # reset the ticket's active lifecycle so the dept head starts a fresh
    # timeline. The pre-escalation history lives on in `handoff_events` and
    # the activity log. Phase B (approval-phase escalation) keeps its approval
    # state intact and is not reset.
    if in_executor_phase:
        prior_handoffs = await HandoffEvent.find(
            {"service_request_id": sr.id, "deleted_on": None}
        ).count()
        await HandoffEvent(
            service_request_id=sr.id,
            organisation_id=sr.organisation_id,
            kind=HandoffKindEnum.ESCALATION,
            phase_index=prior_handoffs + 1,
            from_user_id=previous_owner,
            to_user_id=body.escalate_to_user_id,
            reason=body.reason.strip(),
            assigned_at=sr.assigned_at,
            first_response_at=sr.first_response_at,
            approval_triggered_at=sr.approval_triggered_at,
            happened_at=now,
            created_by=user.id,
            created_on=now,
        ).insert()
        # Hand off to the dept head WITHOUT touching the SLA: keep
        # first_response_at + assigned_at (and both SLA deadlines) so the
        # requester's clock and the already-met first-response milestone carry
        # over — escalation is urgency, not a do-over (unlike reassign). Only
        # clear the approval slate + resolution so the dept head resolves
        # cleanly. Status stays IN_PROGRESS (first response was already filed —
        # it's required before escalation).
        sr.approval_triggered_at = None
        sr.level_2_triggered_at = None
        sr.current_level_index = None
        sr.level_1_approver_user_id = None
        sr.level_2_approver_user_id = None
        sr.level_2_default_user_id = None
        sr.level_2_overridden = False
        sr.level_2_override_chosen_by = None
        sr.resolved_at = None
        sr.closed_at = None
        sr.resolution_notes = None
        sr.request_status = RequestStatusEnum.IN_PROGRESS

    sr.modified_by = user.id
    sr.modified_on = now
    await sr.save()

    await publish_event(
        "escalated",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "previous_owner_user_id": str(previous_owner) if previous_owner else None,
            "new_owner_user_id": str(body.escalate_to_user_id),
            "reason": body.reason,
            "actor_user_id": user.id,
        },
    )
    await notify_watcher_if_subscribed(
        sr.workflow_id,
        "escalation",
        {
            "service_request_id": str(sr.id),
            "ticket_no": sr.ticket_no,
            "new_owner_user_id": str(body.escalate_to_user_id),
            "reason": body.reason,
        },
    )
    try:
        await emit_activity(
            event=ActivityEventEnum.ESCALATED,
            service_request_id=str(sr.id),
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={
                "from": str(previous_owner) if previous_owner else None,
                "to": str(body.escalate_to_user_id),
                "reason": body.reason,
            },
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        from ..email_events import notify_request_escalated
        from ..common.email_resolver import resolve_user_info
        target_info = await resolve_user_info(body.escalate_to_user_id, access_token=user.access_token)
        req_info = await resolve_user_info(str(sr.requester_user_id), access_token=user.access_token)
        cat = await Category.get(sr.category_id)
        cat_name = cat.name if cat else ""
        if target_info["email"]:
            await notify_request_escalated(
                escalation_target_email=target_info["email"],
                escalation_target_name=target_info["name"],
                requester_email=req_info["email"],
                requester_name=req_info["name"],
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                reason=body.reason or "",
                category_name=cat_name,
                priority=sr.priority.value if sr.priority else "",
                tenant_id=sr.organisation_id,
            )
        # Roster + approvers hear about the escalation too — it changes who is
        # accountable for a ticket they are on. The requester's own copy comes
        # from the send above, so it is suppressed here.
        from .notify_helpers import ticket_recipients
        already = {
            str(user.id),
            str(sr.requester_user_id),
            str(body.escalate_to_user_id),
        }
        for r in await ticket_recipients(
            sr, exclude_user_ids=already, access_token=user.access_token
        ):
            await notify_request_escalated(
                escalation_target_email=r["email"],
                escalation_target_name=r["name"],
                requester_email="",
                requester_name="",
                ticket_no=sr.ticket_no,
                title=sr.title,
                sr_id=str(sr.id),
                description=sr.description or "",
                reason=body.reason or "",
                category_name=cat_name,
                priority=sr.priority.value if sr.priority else "",
                notify_requester=False,
                tenant_id=sr.organisation_id,
            )
    except Exception:
        pass

    return await get_request_detail(str(sr.id), user)
