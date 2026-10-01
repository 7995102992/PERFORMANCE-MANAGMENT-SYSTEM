"""Request detail + capabilities + attachment download — Chapter 6."""
from __future__ import annotations

import logging
from typing import Any

from ..auth.utils.dependencies import UserBase
from ..common.iam_helpers import user_name
from ..common.timestamps import utcnow
from ..exceptions import Forbidden
from ..integrations.iam_client import get_iam_client
from ..integrations.storage_client import signed_download_url
from ..models import (
    ApprovalDecision,
    ApprovalLevel,
    Approver,
    Attachment,
    Category,
    Comment,
    DecisionEnum,
    ExecutorRoleEnum,
    HandoffEvent,
    HandoffKindEnum,
    OrgSrConfig,
    RequestStatusEnum,
    RequestType,
    SLARule,
    ServiceRequest,
    TERMINAL_STATUSES,
)

logger = logging.getLogger(__name__)


def _is_manager_role(user: UserBase) -> bool:
    """Raw manager ACL check — org-wide, so never an authorization decision on
    its own. Use `_is_manager_of_ticket`, which intersects it with the
    department that owns the ticket."""
    from ..common.iam_helpers import is_manager
    return is_manager(user.permissions) or user.is_super_admin


async def _manager_scope_department_ids(user: UserBase) -> set[str]:
    """Departments a manager-policy holder actually has authority over.

    In practice: their own department, the one IAM writes onto the session.

    The "plus any department they head" half below is currently dead — the IAM
    endpoint `get_managed_category_ids` calls does not exist and 404s, which
    `iam_client` swallows into an empty list. Kept because the intent is right
    and the call becomes live the day IAM grows the endpoint.
    """
    dept_ids: set[str] = set()
    if user.department_id:
        dept_ids.add(str(user.department_id))
    try:
        iam = get_iam_client()
        for dept_id in await iam.get_managed_category_ids(user.id) or []:
            dept_ids.add(str(dept_id))
    except Exception:  # noqa: BLE001
        logger.warning("manager_scope.managed_departments_failed user=%s", user.id)
    return dept_ids


async def _load_ticket_category(
    sr: ServiceRequest, cat: Category | None = None
) -> Category | None:
    """The ticket's category — pass one in to avoid re-fetching it.

    Every helper below takes the same optional `cat`, so a single assign call
    resolves the category once instead of three or four times.
    """
    if cat is not None:
        return cat
    return await Category.get(sr.category_id)


async def _ticket_department_ids(
    sr: ServiceRequest, cat: Category | None = None
) -> list[str]:
    """The departments that staff this ticket's category, as strings.

    Goes through `category_department_ids` so an un-migrated document still
    answers off its deprecated scalar `department_id`.
    """
    from ..categories.service import category_department_ids

    c = await _load_ticket_category(sr, cat)
    if c is None:
        return []
    return [str(d) for d in category_department_ids(c)]


async def _is_manager_of_ticket(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """Manager authority for THIS ticket.

    The editor/admin ACL on `service_request` is granted org-wide, so on its own
    it hands every manager read/close/reassign/escalate/notes on every ticket in
    the organisation. Intersect it with the departments that own the ticket's
    category: a manager only manages tickets routed to a department they belong
    to. Fails closed — an unresolvable category, department or manager scope
    denies. Super admin bypasses.

    Note this is *not* the last word once a category has a roster: see
    `_can_act_as_executor` / `_can_manage_ticket`, where the roster overrides it.
    """
    if user.is_super_admin:
        return True
    if not _is_manager_role(user):
        return False
    ticket_depts = set(await _ticket_department_ids(sr, cat))
    if not ticket_depts:
        return False
    # Fast path — session department is one of them, no IAM round-trip needed.
    if user.department_id and str(user.department_id) in ticket_depts:
        return True
    return bool(ticket_depts & await _manager_scope_department_ids(user))


def _is_executor_of(sr: ServiceRequest, user: UserBase) -> bool:
    return sr.executor_user_id == user.oid


def _is_primary_assignee_of(sr: ServiceRequest, user: UserBase) -> bool:
    return sr.primary_assignee_user_id == user.oid or user.is_super_admin


def _snapshot_approver_for_level(
    sr: ServiceRequest, level_index: int | None
) -> str | None:
    if level_index == 1:
        return sr.level_1_approver_user_id
    if level_index == 2:
        return sr.level_2_approver_user_id
    return None


async def _is_current_approver(sr: ServiceRequest, user: UserBase) -> bool:
    if user.is_super_admin:
        return True
    if sr.current_level_index is None:
        return False
    if sr.escalation_override_approver_user_id == user.oid:
        return True
    # New approval model: per-ticket snapshots on the SR doc.
    snapshot = _snapshot_approver_for_level(sr, sr.current_level_index)
    if snapshot:
        return snapshot == user.oid
    # Legacy fallback: tickets created before the IAM-driven model still
    # carry workflow_id / ApprovalLevel rows. Honor them so in-flight tickets
    # don't stall.
    lvl = await ApprovalLevel.find_one(
        {
            "workflow_id": sr.workflow_id,
            "level_index": sr.current_level_index,
            "deleted_on": None,
        }
    )
    if lvl is None:
        return False
    ap = await Approver.find_one(
        {
            "approval_level_id": lvl.id,
            "approver_user_id": user.oid,
            "deleted_on": None,
        }
    )
    return ap is not None


async def _is_dept_head_of_ticket(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """True when the caller heads *any* of the ticket category's departments.

    A category now spans a list of departments, and every one of their heads is
    an implicit primary (D3) — so heading one of several is enough.
    """
    try:
        from ..categories.service import _department_meta

        dept_ids = await _ticket_department_ids(sr, cat)
        if not dept_ids:
            return False
        meta = await _department_meta(dept_ids, user)
        return any(m.get("head_user_id") == user.id for m in meta.values())
    except Exception:
        return False


async def _is_dept_member_of_ticket(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """True when the caller belongs to any of the category's departments.

    Uses the paging helper rather than a single capped IAM page: employee 101
    of a department is still a member, and reading them as "not in the
    department" would deny them a ticket they are entitled to work.
    """
    try:
        from ..categories.service import _department_employees

        dept_ids = await _ticket_department_ids(sr, cat)
        if not dept_ids:
            return False
        return user.id in await _department_employees(dept_ids, user)
    except Exception:
        return False


async def _is_category_primary(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """True when the caller is a primary executor of the ticket's category.

    Primaries inherit what the department head does today (assign, reassign,
    being an escalation target). A configured roster is the whole answer: a head
    who should hold these powers is picked as a primary like anyone else, so a
    head left off the roster holds nothing here. With no roster configured this
    delegates straight to the department-head check, so every pre-existing
    category keeps its current behaviour (D4).

    Same try/except-returns-False contract as `_is_dept_head_of_ticket`: an IAM
    blip must not grant powers, and must not 500. Note a roster hit needs no
    IAM call at all — it is answered from Mongo, so a configured primary keeps
    their powers through an IAM outage where the department head would lose
    theirs.
    """
    try:
        c = await _load_ticket_category(sr, cat)
        if not c:
            return False
        if any(
            str(e.user_id) == user.id and e.role == ExecutorRoleEnum.PRIMARY
            for e in (c.executors or [])
        ):
            return True
        # A roster naming at least one primary is the whole rule — the heads add
        # nothing on top of it. Falling back to the head check only when no
        # primary is configured keeps the pre-roster shape working (D4), and
        # keeps the pre-validation documents whose roster is all-secondary from
        # ending up with nobody able to assign or reassign.
        if any(
            e.role == ExecutorRoleEnum.PRIMARY for e in (c.executors or [])
        ):
            return False
        return await _is_dept_head_of_ticket(sr, user, c)
    except Exception:
        return False


async def _is_category_workforce(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """True when the caller may execute this ticket (primary or secondary).

    Roster membership is the whole answer where a roster exists. `roster_is_
    exclusive` (D8) used to decide whether the departments counted too, and
    defaulted to off — so a new joiner could pick up a ticket without waiting
    for a roster edit. That flag is gone: the people an admin picked are the
    people who work the category.

    A department head qualifies only by being rostered. Heading a department is
    not a grant in itself, so a head who sits outside the department they head —
    which IAM permits, and which is true of several of them — qualifies exactly
    as any other outsider would, i.e. not at all. Where no roster exists the
    members and heads still come in unconditionally (D4).
    """
    try:
        c = await _load_ticket_category(sr, cat)
        if not c:
            return False
        if any(str(e.user_id) == user.id for e in (c.executors or [])):
            return True
        if c.executors:
            # A roster exists and the caller is not on it. Nothing else grants
            # execution rights now.
            return False
        if await _is_dept_head_of_ticket(sr, user, c):
            return True
        return await _is_dept_member_of_ticket(sr, user, c)
    except Exception:
        return False


async def _can_act_as_executor(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """May this caller pick up / be assigned this ticket?

    The roster wins when one is configured (D7): the manager ACL adds nothing on
    top of it. That is the whole point of the override — `service_request` grants
    `editor` to essentially every employee, so leaving the ACL in the `or` would
    keep all of them eligible and make the roster decorative.

    With no roster this falls back to department membership plus the
    department-scoped manager check, i.e. exactly today's behaviour, which is
    what keeps every category that exists right now working untouched.
    """
    if user.is_super_admin:
        return True
    c = await _load_ticket_category(sr, cat)
    if await _is_category_workforce(sr, user, c):
        return True
    if c is not None and c.executors:
        return False
    return await _is_manager_of_ticket(sr, user, c)


async def _can_manage_ticket(
    sr: ServiceRequest, user: UserBase, cat: Category | None = None
) -> bool:
    """Assign / reassign / escalation authority — the dept-head-tier powers.

    Same precedence as `_can_act_as_executor`, one tier up: a configured roster
    means the primaries (and the department heads, who are primaries implicitly)
    hold these powers and nobody else. `roster_is_exclusive` does not enter into
    it — that switch only widens the *executor* pool, never the management one.
    """
    if user.is_super_admin:
        return True
    c = await _load_ticket_category(sr, cat)
    if await _is_category_primary(sr, user, c):
        return True
    if c is not None and c.executors:
        return False
    return await _is_manager_of_ticket(sr, user, c)


async def _has_ticket_access(sr: ServiceRequest, user: UserBase) -> bool:
    if user.is_super_admin:
        return True
    if sr.requester_user_id == user.oid:
        return True
    if sr.executor_user_id == user.oid:
        return True
    # The executor who escalated this away. They worked the ticket and have
    # already seen everything on it, so this grants nothing new — but the To
    # Execute queue now lists these rows under its Escalated card, and without
    # this branch opening one is a 403 for anyone who does not also pass a
    # check below. In a standard org they do, because every employee holds the
    # manager ACL; a roster executor staffed outside the ticket's department
    # does not, and that is the case the roster work exists to support.
    if sr.previous_executor_user_id == user.oid:
        return True
    if sr.primary_assignee_user_id == user.oid:
        return True
    if await _is_current_approver(sr, user):
        return True
    if await _has_decided_on_ticket(sr, user):
        return True
    if await _is_dept_member_of_ticket(sr, user):
        return True
    # Manager policy (editor/admin on service_request) and the dept head can
    # open any open ticket in their org so they can self-assign / reassign.
    if _is_manager_role(user):
        return True
    # Category primaries can open any open ticket in their org so they can
    # assign / reassign it.
    #
    # Read access deliberately stays wider than the queues. Those are
    # roster-scoped now while plain department membership above is not, and that
    # asymmetry is the safe direction: a list narrower than access means nobody
    # is shown a ticket they cannot open, whereas the reverse 403s people on
    # rows they were just offered.
    if await _is_category_primary(sr, user):
        return True
    # The department head needs its own branch: `_is_category_primary` used to
    # fall through to it, and stopped once a roster naming a primary became the
    # whole answer there. Without this a head who is off the roster, outside the
    # department they head (which IAM permits) and holding no manager ACL gets a
    # hard 403 on a ticket routed to their own department. Opening a ticket is
    # not one of the powers the roster took from the heads.
    if await _is_dept_head_of_ticket(sr, user):
        return True
    # Read-only: the requester's own L1/L2 manager. Keeps the detail view
    # openable for every row the approvals queue lists under the caller's
    # reporting tree — without it the team card links to a 403.
    if await _is_reporting_manager_of_requester(sr, user):
        return True
    return False


async def _is_reporting_manager_of_requester(
    sr: ServiceRequest, user: UserBase
) -> bool:
    """Is the caller the requester's L1 or L2 manager?

    The read-only counterpart to the reporting-tree rows in the approvals
    queue: a manager who can see a report's ticket in "My team's requests"
    must be able to open it, even before it reaches their approval level and
    even when the ticket belongs to another department. Resolved from the
    requester's employee record (replica-backed), so it costs one lookup.
    """
    if not user.id or not sr.requester_user_id:
        return False
    try:
        managers = await get_iam_client().get_reporting_managers(
            str(sr.requester_user_id), access_token=user.access_token
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "ticket_access.reporting_manager_lookup_failed sr=%s", str(sr.id)
        )
        return False
    return str(user.id) in {
        str(managers.get("l1_user_id") or ""),
        str(managers.get("l2_user_id") or ""),
    }


async def _has_decided_on_ticket(sr: ServiceRequest, user: UserBase) -> bool:
    """Check if user has made an approval decision on this ticket at any level."""
    decision = await ApprovalDecision.find_one(
        {"service_request_id": sr.id, "approver_user_id": user.oid, "deleted_on": None}
    )
    return decision is not None


async def require_ticket_access(sr: ServiceRequest, user: UserBase) -> None:
    if not await _has_ticket_access(sr, user):
        raise Forbidden("Caller cannot access this ticket")


async def compute_capabilities(
    sr: ServiceRequest, user: UserBase
) -> dict[str, bool]:
    """Server-side capability computation — Q-115."""
    status = sr.request_status
    terminal = status in TERMINAL_STATUSES
    access = await _has_ticket_access(sr, user)
    is_current_approver = await _is_current_approver(sr, user) if not terminal else False
    # Broader check: is the caller configured as an approver at ANY level of
    # this ticket's workflow? Used to exclude approvers from Escalate even
    # when they also hold the manager policy. Super admin is excluded from
    # the lookup so it can still escalate.
    is_workflow_approver = False
    if not user.is_super_admin:
        # New ticket: snapshotted L1/L2 on the SR.
        if user.oid in {
            sr.level_1_approver_user_id,
            sr.level_2_approver_user_id,
        }:
            is_workflow_approver = True
        else:
            # Legacy ticket fallback — still uses workflow-configured approvers.
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
                is_workflow_approver = _ap_row is not None
    # Has this user already decided at the current level?
    already_decided = False
    if is_current_approver and sr.current_level_index is not None:
        existing = await ApprovalDecision.find_one(
            {
                "service_request_id": sr.id,
                "level_index": sr.current_level_index,
                "approver_user_id": user.oid,
                "deleted_on": None,
            }
        )
        already_decided = existing is not None

    is_executor = _is_executor_of(sr, user)
    is_primary = _is_primary_assignee_of(sr, user)
    # Raw ACL. Only the close / internal-note / handler flags still read it —
    # the assign, self-assign, reassign and escalate flags go through the
    # precedence helpers instead, where the roster overrides it (D7).
    is_manager = _is_manager_role(user)
    # Loaded once and threaded into every roster helper below — otherwise a
    # single detail load re-fetches the category four times.
    cat = await Category.get(sr.category_id)

    cfg = await OrgSrConfig.find_one({"organisation_id": sr.organisation_id})
    executor_can_close = bool(cfg and cfg.executor_can_close)

    can_approve = (
        status == RequestStatusEnum.PENDING_APPROVAL
        and is_current_approver
        and not already_decided
    )
    can_reject = can_approve

    # `is_category_primary` is roster-driven and falls back to the department
    # heads when a category has no roster. Careful: `is_primary` above is the
    # ticket's snapshotted `primary_assignee_user_id`, a different thing.
    is_requester = sr.requester_user_id == user.oid
    # Nobody routes their own ticket — the actor rule the assign / reassign
    # endpoints enforce via `deny_requester_actor`, which super admin bypasses.
    # Kept as one name so the caps and the endpoints can't drift on the bypass.
    blocked_self_routing = is_requester and not user.is_super_admin
    is_category_primary = (
        await _is_category_primary(sr, user, cat) if not terminal else False
    )
    # The two precedence helpers (D7). These must stay in lockstep with the
    # endpoints in service_assign.py — a capability the API then refuses shows
    # an enabled button that 403s.
    can_act_as_executor = (
        await _can_act_as_executor(sr, user, cat) if not terminal else False
    )
    can_manage = await _can_manage_ticket(sr, user, cat) if not terminal else False
    # Raw department relationship, kept alongside the roster helpers because the
    # reporting-only check and the internal-note rules below ask about it
    # directly rather than through a capability. `cat` is threaded in so these
    # reuse the category already loaded above.
    is_dept_head = (
        await _is_dept_head_of_ticket(sr, user, cat) if not terminal else False
    )
    is_dept_member = (
        await _is_dept_member_of_ticket(sr, user, cat) if not terminal else False
    )
    # A *pure* reporting-tree viewer: the requester's L1/L2 manager with no
    # other relationship to this ticket. They can open it (the team card links
    # here) but hold no action capability, and internal notes stay closed —
    # those are for the people handling the ticket, which this caller is not.
    # Only resolved when no other relationship already explains the access, so
    # the common paths cost nothing extra.
    is_reporting_only = False
    if not user.is_super_admin and not (
        is_executor
        or is_primary
        or is_manager
        or is_dept_head
        or is_dept_member
        or is_requester
        or is_current_approver
    ):
        is_reporting_only = await _is_reporting_manager_of_requester(sr, user)
    # Self-Assign is for anyone who can act as executor on the ticket, plus the
    # ticket's own primary assignee.
    #
    # `_can_act_as_executor` already answers what the explicit dept-member /
    # dept-head test here used to: `_is_category_workforce` falls through to
    # both when no roster is configured. What it adds is the roster (D7), and
    # the same exclusion of the bare org-wide manager ACL — that ACL offered
    # Self-Assign on every unassigned ticket in the organisation regardless of
    # department, and a manager now gets view-only without a real relationship
    # to the ticket. The requester is always excluded (conflict of interest —
    # they'd approve their own resolution).
    can_self_assign = (
        status == RequestStatusEnum.PENDING_ASSIGNMENT
        and (can_act_as_executor or is_primary)
        and not is_requester
    )
    # `not is_requester` for the same reason it is on can_self_assign: raising a
    # ticket does not come with the right to route it, even for a primary who
    # raised one in their own category. Enforced at the endpoint too — see
    # `deny_requester_actor` in utils/self_dealing.
    can_assign = (
        status == RequestStatusEnum.PENDING_ASSIGNMENT
        and (is_primary or is_category_primary)
        and not blocked_self_routing
    )
    # Escalate is gated on first response for every role (see can_escalate
    # below). This executor-specific flag is still used by the post-reassign
    # branch, where only the current executor may escalate.
    executor_can_escalate = is_executor and sr.first_response_at is not None
    # Once a ticket has been escalated, no further escalation is allowed for
    # anyone — only super admin retains the button for support cases.
    already_escalated_lock = sr.is_escalated and not user.is_super_admin
    if sr.reassigned_at and not user.is_super_admin:
        # Post-reassign lockdown:
        # - Reassign: a category primary always keeps it (regardless of whether
        #   they are the current executor). Everyone else is locked out.
        # - Escalate: the current executor can still escalate (after first
        #   response); everyone else (primary/manager/current approver)
        #   loses the button.
        can_reassign = (
            status in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS)
            and is_category_primary
            and not is_workflow_approver
            and not blocked_self_routing
        )
        can_escalate = (
            (not already_escalated_lock)
            and status
            in (
                RequestStatusEnum.PENDING_APPROVAL,
                RequestStatusEnum.ASSIGNED,
                RequestStatusEnum.IN_PROGRESS,
            )
            and executor_can_escalate
        )
    else:
        can_reassign = (
            status in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS)
            # Reassign belongs to the category's primaries (super admin retained
            # for support). Primary assignee / manager-policy holders can assign
            # the first executor but can't hand a ticket off afterwards.
            and (is_category_primary or user.is_super_admin)
            and not is_workflow_approver
            and not blocked_self_routing
        )
        # L1 / L2 approvers do NOT get to escalate — escalation is for the
        # executor / primary / manager only. Approvers approve or reject.
        # `is_workflow_approver` blocks them even when they also hold the
        # manager policy.
        can_escalate = (
            (not already_escalated_lock)
            and status
            in (
                RequestStatusEnum.PENDING_APPROVAL,
                RequestStatusEnum.ASSIGNED,
                RequestStatusEnum.IN_PROGRESS,
            )
            # Escalate shows only after first response has been filed — for
            # the executor and the primary assignee, not just the executor.
            # The bare manager ACL is NOT accepted: it is org-wide, so it put
            # Escalate on every ticket in the organisation. Super admin retains
            # it for support (via is_primary).
            and (sr.first_response_at is not None or user.is_super_admin)
            # `can_manage` replaces the raw manager ACL here: with a roster
            # configured only the category's primaries hold the dept-head-tier
            # powers, escalation included (D7). Matches the `_mgr` rung in
            # service_assign.escalate.
            and (is_executor or is_primary or can_manage)
            and not is_workflow_approver
        )
    # Resolve is only available once the executor has filed first response —
    # status flips to IN_PROGRESS at that moment and first_response_at is set.
    # Additionally, if approval was triggered, the approval flow must have
    # completed (no longer in PENDING_APPROVAL, no current level pending).
    # Super admin bypasses the first-response and approval-pending gates.
    approval_pending = (
        sr.approval_triggered_at is not None
        and (
            status == RequestStatusEnum.PENDING_APPROVAL
            or sr.current_level_index is not None
        )
    )
    # The requester may not act as the handler on their own ticket. Mirrors
    # `deny_requester_actor` (utils/self_dealing.py), which every one of the
    # matching endpoints calls — these flags decide whether the button is even
    # drawn, so the two have to move together or the user gets a 403 from a
    # control the page told them they could use.
    #
    # Only the handler actions carry it. Assign / reassign / escalate
    # deliberately do not: a department head raising a request is usually its
    # `primary_assignee_user_id` too, and taking routing away from them would
    # leave their own tickets unassignable.
    requester_blocked = is_requester and not user.is_super_admin
    can_resolve = (
        status in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS)
        and not requester_blocked
        and (
            (
                is_executor
                and sr.first_response_at is not None
                and not approval_pending
            )
            or user.is_super_admin
        )
    )
    can_first_response = (
        status == RequestStatusEnum.ASSIGNED
        and not requester_blocked
        and (is_executor or user.is_super_admin)
    )
    # L1/L2 trigger gates. Each level can be triggered independently in any
    # order — executor decides whether to send L1, L2, both, or neither. Both
    # buttons stay visible until that level has been decided. Only blocked
    # while a different approval is currently PENDING_APPROVAL on the ticket
    # (one approval at a time).
    l1_decision = await ApprovalDecision.find_one(
        {
            "service_request_id": sr.id,
            "level_index": 1,
            "deleted_on": None,
        }
    )
    l2_decision = await ApprovalDecision.find_one(
        {
            "service_request_id": sr.id,
            "level_index": 2,
            "deleted_on": None,
        }
    )
    can_submit_for_approval = (
        status in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS)
        and not requester_blocked
        and (is_executor or user.is_super_admin)
        and (sr.first_response_at is not None or user.is_super_admin)
        and l1_decision is None
    )
    can_trigger_l2_approval = (
        status in (RequestStatusEnum.ASSIGNED, RequestStatusEnum.IN_PROGRESS)
        and not requester_blocked
        and (is_executor or user.is_super_admin)
        and (sr.first_response_at is not None or user.is_super_admin)
        and l2_decision is None
    )
    # `close` (service_actions.py) gates on `_can_manage_ticket`, not the raw
    # ACL — which is org-wide and would light this button up for a manager of an
    # unrelated department who then gets a 403. `can_manage` above is that same
    # helper, and it already subsumes `is_category_primary` (its second rung),
    # so naming both here would only restate the endpoint's ladder twice.
    can_close = (
        status == RequestStatusEnum.RESOLVED
        # Without this a department head — an implicit primary of their own
        # department's categories (D3) — saw an enabled Close button on the
        # request they raised themselves, which the endpoint now rejects.
        and not requester_blocked
        and (
            can_manage
            or (is_executor and executor_can_close)
            or user.is_super_admin
        )
    )
    # Once the executor raises the ticket for approval, its named L1/L2
    # approvers need to discuss it — that is the one route by which a caller
    # holding nothing but the org-wide manager ACL gains write access here.
    approver_engaged = is_workflow_approver and (
        sr.approval_triggered_at is not None or sr.current_level_index is not None
    )
    # Actual involvement with THIS ticket, as opposed to an org-wide policy.
    # A bare manager ACL is not involvement: they read the ticket and nothing
    # more until they are the approver on a raised approval.
    is_involved = (
        is_requester
        or is_executor
        or is_primary
        or is_dept_head
        or is_dept_member
        or is_current_approver
        or approver_engaged
    )
    can_add_comment = (
        not terminal and access and (is_involved or user.is_super_admin)
    )
    can_add_internal_note = (
        not terminal
        and access
        and not is_reporting_only
        # Org-wide manager ACL excluded; a named approver on a raised approval
        # is the exception (they need the handling thread to decide).
        and (is_executor or is_dept_head or approver_engaged or user.is_super_admin)
        # Internal notes are for the people HANDLING the ticket — never the
        # requester, even if they happen to hold a manager policy.
        and (not is_requester or user.is_super_admin)
    )
    can_download = access
    # Mirrors service_actions.withdraw exactly (requester-or-super-admin +
    # WITHDRAW_FROM), so the FE can drop its client-side copy of the rule and
    # the two can no longer drift.
    from .utils.state_machine import WITHDRAW_FROM
    can_withdraw = (
        (user.is_super_admin or is_requester)
        and sr.request_status in WITHDRAW_FROM
    )

    # Session role tags that, on their own, grant note visibility. This is the
    # single source of truth for the Internal Notes tab: service_notes.py reads
    # can_see_internal_notes / can_add_internal_note back from these caps, so a
    # requester or dept-colleague viewer (ticket access but no note role) won't
    # see the tab.
    # "manager" is deliberately NOT a note role: the ACL is org-wide, so it
    # exposed every ticket's internal thread to every manager. A manager reaches
    # the notes only as the named approver on a raised approval (approver_engaged).
    note_roles = {"executor", "it_support", "super_admin"}
    has_note_role = user.is_super_admin or bool(
        note_roles.intersection({r.lower() for r in (user.roles or [])})
    )
    # Practical fallback: in this dev environment, role tags aren't reliably
    # set on every session, so anyone who's already actively involved in the
    # ticket as a handler counts too.
    # Union of both relationships, minus the raw `is_manager` this used to
    # carry — that is the org-wide ACL the comment above rules out, and leaving
    # it here reopened every ticket's internal thread to every manager.
    is_handler = (
        is_executor
        or is_primary
        or is_category_primary
        or is_dept_head
        or is_dept_member
    )
    if terminal and not is_handler:
        # The three relationship flags are nulled on terminal tickets because
        # they gate *actions*, and a closed ticket has none. Note visibility is
        # not an action: the people who handled a ticket keep reading its
        # internal thread afterwards. Without this, `is_handler` on a closed
        # ticket collapses to executor-or-primary-assignee and a department head
        # opening their own department's closed ticket gets InternalNoteForbidden
        # on its history — `is_manager`, dropped above, was the only ungated
        # input holding that open.
        #
        # Resolved here rather than by ungating the flags themselves, so the
        # ordinary non-terminal path pays nothing and the lookup only runs for a
        # caller who has no cheaper relationship to the ticket.
        # Three calls, not two. `_is_category_primary` used to fall through to
        # the department head, so it covered `is_dept_head` for free — it does
        # not any more, because a roster naming a primary is now the whole answer
        # there. The live path above still lists `is_dept_head` as its own term,
        # so without its own call here a head off the roster would read the
        # internal thread of an open ticket and lose it the moment the ticket
        # closed. Note visibility is not one of the powers the roster took from
        # the heads; it tracks who handled the ticket.
        #
        # Ordered cheapest first: the roster hit is answered from Mongo, the two
        # department questions go to IAM, and `or` short-circuits.
        is_handler = (
            await _is_category_primary(sr, user, cat)
            or await _is_dept_head_of_ticket(sr, user, cat)
            or await _is_dept_member_of_ticket(sr, user, cat)
        )
    can_see_internal_notes = (
        access
        and not is_reporting_only
        and (has_note_role or is_handler or approver_engaged)
        # The requester never sees internal notes on their own ticket.
        and (not is_requester or user.is_super_admin)
    )

    return {
        "can_approve": can_approve,
        "can_reject": can_reject,
        "can_first_response": can_first_response,
        "can_submit_for_approval": can_submit_for_approval,
        "can_trigger_l2_approval": can_trigger_l2_approval,
        "can_assign_executor": can_assign,
        "can_self_assign": can_self_assign,
        "can_reassign_executor": can_reassign,
        "can_escalate": can_escalate,
        "can_resolve": can_resolve,
        "can_close": can_close,
        "can_withdraw": can_withdraw,
        "can_add_comment": can_add_comment,
        "can_add_internal_note": can_add_internal_note,
        "can_see_internal_notes": can_see_internal_notes,
        "can_download_attachments": can_download,
    }


async def _compute_sla(sr: ServiceRequest) -> dict[str, Any]:
    """The detail page's SLA panel.

    ``enabled`` gates the whole panel. An SLA that is not in force must not be
    reported as breached: the tick discards those deadlines without raising a
    breach, emailing anyone or running violation actions, so a "breached" badge
    on the same ticket describes an event that never happened and that nobody
    was told about. `utils.sla.rule_in_force` is the single answer both sides
    read — see its docstring.
    """
    from .utils.sla import rule_in_force

    if not sr.resolution_due_by:
        return {"enabled": False, "disabled_reason": "no_sla_deadline"}

    rule, gone_reason = await rule_in_force(sr)
    if rule is None:
        return {"enabled": False, "disabled_reason": gone_reason}
    from datetime import timezone
    now = utcnow()
    submitted = sr.submitted_on or sr.created_on or now
    if submitted.tzinfo is None:
        submitted = submitted.replace(tzinfo=timezone.utc)
    res_due = sr.resolution_due_by
    if res_due and res_due.tzinfo is None:
        res_due = res_due.replace(tzinfo=timezone.utc)
    total_seconds = (res_due - submitted).total_seconds()
    elapsed = max(0.0, (now - submitted).total_seconds())
    percent = int(min(100, (elapsed / total_seconds * 100) if total_seconds else 0))
    def _aware(dt):
        if dt and dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt

    fr_status = "pending"
    if sr.first_response_at is not None:
        fr_at = _aware(sr.first_response_at)
        fr_due = _aware(sr.first_response_due_by) or now
        fr_status = "met" if fr_at <= fr_due else "breached"
    elif sr.first_response_due_by and now > _aware(sr.first_response_due_by):
        fr_status = "breached"
    res_status = "on_track"
    if sr.request_status in (RequestStatusEnum.RESOLVED, RequestStatusEnum.CLOSED):
        res_status = "resolved"
    elif percent >= 100:
        res_status = "breached"
    elif percent >= 80:
        res_status = "warning"
    return {
        "enabled": True,
        "first_response_due_by": sr.first_response_due_by,
        "first_response_at": sr.first_response_at,
        "resolution_due_by": sr.resolution_due_by,
        "percent_used": percent,
        "first_response_status": fr_status,
        "resolution_status": res_status,
    }


async def _build_approvals_block(sr: ServiceRequest, user: UserBase) -> dict[str, Any]:
    # Branch on whether this ticket uses the new snapshot model (L1/L2 fields
    # on the SR) or the legacy ApprovalLevel/Approver rows.
    if sr.level_1_approver_user_id or sr.level_2_approver_user_id:
        return await _build_approvals_block_snapshot(sr, user)
    return await _build_approvals_block_legacy(sr, user)


async def _build_approvals_block_snapshot(
    sr: ServiceRequest, user: UserBase
) -> dict[str, Any]:
    """New model: L1/L2 are stored directly on the SR. Always two levels."""
    decisions = await ApprovalDecision.find(
        {"service_request_id": sr.id, "deleted_on": None}
    ).to_list()
    decisions_by_level: dict[int, ApprovalDecision] = {}
    for d in decisions:
        # Latest decision per level wins (legacy multi-approver tickets may
        # have multiple; new tickets have exactly one).
        if d.level_index not in decisions_by_level or (
            d.decided_at
            and decisions_by_level[d.level_index].decided_at
            and d.decided_at > decisions_by_level[d.level_index].decided_at
        ):
            decisions_by_level[d.level_index] = d

    iam = get_iam_client()
    user_ids = [
        str(uid)
        for uid in (sr.level_1_approver_user_id, sr.level_2_approver_user_id)
        if uid
    ]
    users = await iam.get_users(user_ids, access_token=user.access_token) if user_ids else {}

    def _level(idx: int, approver_id) -> dict[str, Any]:
        d = decisions_by_level.get(idx)
        approver_rows = []
        if approver_id:
            approver_rows.append(
                {
                    "user_id": str(approver_id),
                    "name": user_name(users.get(str(approver_id))),
                    "decision": d.decision.value if d else None,
                    "decided_at": d.decided_at if d else None,
                    "remarks": d.remarks if d else None,
                }
            )
        if d and d.decision == DecisionEnum.REJECTED:
            level_status = "rejected"
        elif d and d.decision == DecisionEnum.APPROVED:
            level_status = "approved"
        elif (
            sr.current_level_index == idx
            and sr.request_status == RequestStatusEnum.PENDING_APPROVAL
        ):
            level_status = "pending"
        elif sr.current_level_index is not None and idx > sr.current_level_index:
            level_status = "pending"
        else:
            level_status = "pending"
        return {
            "level_index": idx,
            # AND/OR logic is not meaningful with a single approver per level
            # but FE expects the field — leave as "and" for compat.
            "logic": "and",
            "status": level_status,
            "approvers": approver_rows,
        }

    # Only emit a level row when the executor has triggered it (snapshot
    # field is set). Skipping means the timeline / approvals panel won't show
    # rows for levels the executor never invoked.
    levels_out: list[dict[str, Any]] = []
    if sr.level_1_approver_user_id:
        levels_out.append(_level(1, sr.level_1_approver_user_id))
    if sr.level_2_approver_user_id:
        levels_out.append(_level(2, sr.level_2_approver_user_id))
    return {
        "required": True,
        "total_levels": len(levels_out),
        "current_level_index": sr.current_level_index,
        "levels": levels_out,
        "triggered_at": sr.approval_triggered_at,
        "l2_overridden": bool(sr.level_2_overridden),
        "l2_default_user_id": str(sr.level_2_default_user_id) if sr.level_2_default_user_id else None,
        "l2_override_chosen_by": str(sr.level_2_override_chosen_by) if sr.level_2_override_chosen_by else None,
    }


async def _build_approvals_block_legacy(
    sr: ServiceRequest, user: UserBase
) -> dict[str, Any]:
    """Legacy model: workflow-configured ApprovalLevel + Approver rows.

    Retained so pre-cutover tickets still render. Approval routing for new
    tickets always lands in _build_approvals_block_snapshot.
    """
    levels = await ApprovalLevel.find(
        {"workflow_id": sr.workflow_id, "deleted_on": None}
    ).sort("level_index").to_list()
    if not levels:
        return {
            "required": False,
            "total_levels": 0,
            "current_level_index": None,
            "levels": [],
            "triggered_at": None,
        }
    level_ids = [l.id for l in levels]
    approvers = (
        await Approver.find(
            {"approval_level_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        if level_ids
        else []
    )
    approvers_by_level: dict[Any, list[Approver]] = {}
    for a in approvers:
        approvers_by_level.setdefault(a.approval_level_id, []).append(a)
    decisions = await ApprovalDecision.find(
        {"service_request_id": sr.id, "deleted_on": None}
    ).to_list()
    decisions_by_key: dict[tuple[int, Any], ApprovalDecision] = {
        (d.level_index, d.approver_user_id): d for d in decisions
    }

    user_ids = {str(a.approver_user_id) for a in approvers}
    iam = get_iam_client()
    users = await iam.get_users(list(user_ids), access_token=user.access_token)

    levels_out = []
    for l in levels:
        apps = sorted(
            approvers_by_level.get(l.id, []), key=lambda x: x.sort_order
        )
        approver_rows = []
        n_approved = 0
        n_rejected = 0
        for a in apps:
            d = decisions_by_key.get((l.level_index, a.approver_user_id))
            approver_rows.append(
                {
                    "user_id": str(a.approver_user_id),
                    "name": user_name(users.get(str(a.approver_user_id))),
                    "decision": d.decision.value if d else None,
                    "decided_at": d.decided_at if d else None,
                    "remarks": d.remarks if d else None,
                }
            )
            if d and d.decision == DecisionEnum.APPROVED:
                n_approved += 1
            if d and d.decision == DecisionEnum.REJECTED:
                n_rejected += 1
        if n_rejected:
            level_status = "rejected"
        elif sr.current_level_index is not None and l.level_index < sr.current_level_index:
            level_status = "approved"
        elif sr.current_level_index == l.level_index and sr.request_status == RequestStatusEnum.PENDING_APPROVAL:
            level_status = "pending"
        elif sr.current_level_index is not None and l.level_index > sr.current_level_index:
            level_status = "pending"
        else:
            level_status = "approved" if n_approved else "pending"
        levels_out.append(
            {
                "level_index": l.level_index,
                "logic": l.logic.value,
                "status": level_status,
                "approvers": approver_rows,
            }
        )
    return {
        "required": True,
        "total_levels": len(levels),
        "current_level_index": sr.current_level_index,
        "levels": levels_out,
        "triggered_at": sr.approval_triggered_at,
    }


def _build_timeline(
    sr: ServiceRequest,
    approvals: dict,
    dept: dict | None = None,
    *,
    is_viewer_current_executor: bool = False,
    handoffs: list[Any] | None = None,
    names: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Build the request detail timeline.

    Order reflects the post-redesign flow: ticket is assigned (or open) →
    first response → in progress → optional approval (only if the workflow
    has levels configured) → optional escalation → resolved → closed (or
    rejected as a terminal branch).
    """
    stages: list[dict[str, Any]] = []
    status = sr.request_status

    _names = names or {}
    _handoffs = handoffs or []

    def who(uid: Any) -> str:
        """Display name for a user id, falling back to nothing rather than an id.

        A raw ObjectId in a timeline note is worse than an unnamed one — it
        reads as a bug to anyone looking at the ticket, and the sentence still
        makes sense without it.
        """
        return _names.get(str(uid), "") if uid else ""

    def phrase(*parts: str) -> str | None:
        """Join the parts that resolved, or None so the row keeps its blank note."""
        joined = " ".join(p for p in parts if p).strip()
        return joined or None

    _escalations = [h for h in _handoffs if h.kind == HandoffKindEnum.ESCALATION]
    _reassignments = [h for h in _handoffs if h.kind == HandoffKindEnum.REASSIGNMENT]

    # 1. Request Initiated
    stages.append({
        "stage": "Request Initiated",
        "status": "completed" if sr.submitted_on else "pending",
        "at": sr.submitted_on,
        "note": None,
    })

    # 2. Assigned — current while open (PENDING_ASSIGNMENT), completed once
    # the ticket has an executor and has moved past assignment.
    past_assignment = status in (
        RequestStatusEnum.ASSIGNED,
        RequestStatusEnum.IN_PROGRESS,
        RequestStatusEnum.PENDING_APPROVAL,
        RequestStatusEnum.RESOLVED,
        RequestStatusEnum.CLOSED,
    )
    # Who this was FIRST assigned to. `executor_user_id` has moved on if the
    # ticket was ever handed over, so the earliest handoff's `from_user_id` is
    # the original assignee; with no handoffs the current executor is still the
    # original one.
    _first_assignee = (
        _handoffs[0].from_user_id if _handoffs else sr.executor_user_id
    )
    stages.append({
        "stage": "assigned",
        "status":
            "current" if status == RequestStatusEnum.PENDING_ASSIGNMENT
            else "completed" if (sr.executor_user_id and past_assignment)
            else "pending",
        "at": sr.assigned_at,
        # No `assigned_by` is stored on the ticket, so the note names the
        # assignee only. The actor lives in the activity log.
        "note": phrase("Assigned to", who(_first_assignee)),
    })

    # 2b. Reassigned — only rendered when a handoff actually happened.
    # Names the latest reassignment; `count` carries the rest so several
    # handovers don't silently read as one.
    _last_reassign = _reassignments[-1] if _reassignments else None
    if _last_reassign is not None:
        _reassign_note = phrase(
            "Reassigned",
            f"from {who(_last_reassign.from_user_id)}"
            if who(_last_reassign.from_user_id) else "",
            f"to {who(_last_reassign.to_user_id)}"
            if who(_last_reassign.to_user_id) else "",
            f"by {who(_last_reassign.created_by)}"
            if who(_last_reassign.created_by) else "",
            f"(count={len(_reassignments)})" if len(_reassignments) > 1 else "",
        )
    else:
        _reassign_note = None
    stages.append({
        "stage": "reassigned",
        "status": "completed" if sr.reassigned_at else "hidden",
        "at": sr.reassigned_at,
        "note": _reassign_note,
    })

    # 3. First Response — current while ASSIGNED awaiting first response.
    stages.append({
        "stage": "first_response",
        "status":
            "completed" if sr.first_response_at
            else "current" if status == RequestStatusEnum.ASSIGNED
            else "pending",
        "at": sr.first_response_at,
        "note": None,
    })

    # 4. In Progress — `at` reflects the milestone date: when approval was
    # triggered (the executor's work was handed off to approvers) or, if no
    # approval was triggered, when the ticket entered IN_PROGRESS via first
    # response. Counts as "completed" once the ticket moves past in-progress
    # work — either submit-for-approval (PENDING_APPROVAL) or terminal.
    in_progress_at = sr.approval_triggered_at or sr.first_response_at
    in_progress_completed = (
        status in (
            RequestStatusEnum.PENDING_APPROVAL,
            RequestStatusEnum.RESOLVED,
            RequestStatusEnum.CLOSED,
        )
        or sr.approval_triggered_at is not None
    )
    stages.append({
        "stage": "in_progress",
        "status":
            "completed" if in_progress_completed
            else "current" if status == RequestStatusEnum.IN_PROGRESS
            else "pending",
        "at": in_progress_at,
        "note": None,
    })

    # 5. Approval levels — only surfaced when the executor has triggered
    # Send-for-Approval. Each level then renders with its real status
    # (pending / current / approved). If the ticket reached a terminal
    # state without ever being triggered, the rows render as "skipped"
    # so the historical record shows approval was an option but unused.
    # Otherwise (workflow has levels, never triggered, still active) the
    # rows stay hidden.
    terminal_no_approval = status in (
        RequestStatusEnum.RESOLVED,
        RequestStatusEnum.CLOSED,
        RequestStatusEnum.REJECTED,
    )
    approval_rows: list[dict[str, Any]] = []
    for lvl in approvals.get("levels", []):
        if sr.approval_triggered_at is not None:
            if lvl["status"] == "approved":
                lvl_status = "completed"
                note = None
            elif lvl["status"] == "rejected":
                lvl_status = "rejected"
                note = "Rejected"
            elif (
                lvl["status"] == "pending"
                and sr.current_level_index == lvl["level_index"]
            ):
                lvl_status = "current"
                note = None
            else:
                lvl_status = "pending"
                note = None
        elif terminal_no_approval:
            lvl_status = "skipped"
            note = "Skipped — approval not triggered"
        else:
            lvl_status = "hidden"
            note = None
        # Surface the decision timestamp once the level has been decided, so
        # the timeline row shows WHEN L1/L2 approved (or rejected) instead of
        # a blank date. Pending/current levels have no decision yet → None.
        decided_at = next(
            (a.get("decided_at") for a in lvl.get("approvers", []) if a.get("decided_at")),
            None,
        )
        approval_rows.append({
            "stage": f"approval_level_{lvl['level_index']}",
            "status": lvl_status,
            "at": decided_at,
            "note": note,
        })

    # 6. Escalated — shown whenever the ticket was ever escalated (escalated_at
    # is the historical marker and survives a later reassign; is_escalated is the
    # current-phase flag and is cleared on reassign so re-escalation is allowed).
    if sr.escalated_at is not None or sr.is_escalated:
        # Named from the handoff record, not from the department head. The head
        # used to be the only possible target, so reading the name off the
        # department was correct then — it is not now: escalation goes to one of
        # the category's primaries, who may be neither the head nor in the
        # department at all, and the row was confidently naming the wrong person.
        _last_esc = _escalations[-1] if _escalations else None
        if _last_esc is not None:
            _esc_from, _esc_to = _last_esc.from_user_id, _last_esc.to_user_id
            _esc_by = _last_esc.created_by
        else:
            # Approval-phase (Phase B) escalation writes no handoff row — it
            # redirects the approval rather than the executor.
            _esc_from, _esc_to = None, sr.escalation_override_approver_user_id
            _esc_by = None
        # Name the actor only when they are not the person being escalated
        # away from. An executor escalating their own ticket makes from == by,
        # and "Escalated from Alice to Bob by Alice" reads like a mistake. It
        # differs when a category primary escalates a ticket somebody else is
        # executing — which is exactly the case worth surfacing, so the "by"
        # clause now carries information instead of repeating itself.
        _show_by = bool(_esc_by) and str(_esc_by) != str(_esc_from)
        note = phrase(
            "Escalated",
            f"from {who(_esc_from)}" if who(_esc_from) else "",
            f"to {who(_esc_to)}" if who(_esc_to) else "",
            f"by {who(_esc_by)}" if (_show_by and who(_esc_by)) else "",
            f"(count={sr.escalation_count})" if sr.escalation_count else "",
        )
        escalated_row = {
            "stage": "escalated",
            "status": "completed",
            "at": sr.escalated_at,
            "note": note,
        }
    else:
        escalated_row = {
            "stage": "escalated",
            "status": "hidden",
            "at": None,
            "note": None,
        }

    # Order escalation vs approval by the lifecycle STEP, not by timestamps. A
    # Phase-A escalation (executor → dept head) resets the ticket and clears the
    # approval snapshot, so any approval present was triggered by the dept head
    # AFTER the handoff → the Escalated step comes first. A Phase-B (approval-
    # phase) escalation instead sets an override approver and keeps the in-flight
    # approval, so approval stays before Escalated.
    escalated_before_approval = (
        sr.is_escalated and sr.escalation_override_approver_user_id is None
    )
    if escalated_before_approval:
        stages.append(escalated_row)
        stages.extend(approval_rows)
    else:
        stages.extend(approval_rows)
        stages.append(escalated_row)

    # 7/8. Terminal — Rejected replaces Resolved+Closed if the ticket was
    # rejected; otherwise both are shown.
    if status == RequestStatusEnum.REJECTED:
        stages.append({
            "stage": "rejected",
            "status": "completed",
            "at": None,
            "note": sr.rejection_reason or None,
        })
    else:
        stages.append({
            "stage": "resolved",
            "status":
                "completed" if sr.resolved_at
                else "current" if status == RequestStatusEnum.RESOLVED
                else "pending",
            "at": sr.resolved_at,
            "note": None,
        })
        stages.append({
            "stage": "closed",
            "status": "completed" if sr.closed_at else "pending",
            "at": sr.closed_at,
            "note": None,
        })

    # Escalation happens BEFORE reassignment chronologically (the executor
    # escalates to the dept head, who then reassigns). Both are early handoff
    # markers, so when a ticket was escalated AND reassigned, lift the Escalated
    # row to sit immediately before the Reassigned row instead of leaving it at
    # its default position lower down. Only the escalated-then-reassigned case
    # is touched — every other flow keeps its existing order. Only a HISTORICAL
    # escalation (one closed by the reassign → is_escalated already cleared) is
    # lifted; a current-phase escalation that happened AFTER a reassign stays at
    # its later position.
    if sr.escalated_at is not None and not sr.is_escalated and sr.reassigned_at:
        esc = next((s for s in stages if s["stage"] == "escalated"), None)
        if esc is not None and esc["status"] != "hidden":
            stages.remove(esc)
            r_idx = next(
                (i for i, s in enumerate(stages) if s["stage"] == "reassigned"),
                None,
            )
            if r_idx is not None:
                stages.insert(r_idx, esc)

    # Post-reassign cut-off: hide pending/current stages after the Reassigned
    # row so historical viewers (the prior executor, primary, manager, dept
    # head) see the timeline trail off at the handoff. The CURRENT executor
    # — the one who received the reassigned ticket — sees the full timeline
    # so they know what's still ahead of them.
    if sr.reassigned_at and not is_viewer_current_executor:
        past_reassigned = False
        for s in stages:
            if past_reassigned and s["status"] in ("pending", "current"):
                s["status"] = "hidden"
            if s["stage"] == "reassigned":
                past_reassigned = True

    # Escalation no longer truncates the timeline. A Phase-A escalation resets
    # the ticket's lifecycle (see escalate() in service_assign.py) so the
    # department head gets a fresh timeline; the prior phase is preserved in the
    # handoff_events collection and the activity log. The Escalated row stays
    # as a handoff marker.

    # Withdrawn flow: requester pulled the ticket before anyone began work.
    # Timeline reads Initiated → Assigned (skip) → First Response (skip) →
    # In Progress (skip) → Resolved (skip) → Closed (closed_at). The Closed
    # row was already built with sr.closed_at (set by withdraw()), so we just
    # demote the unreached intermediate rows.
    if sr.request_status == RequestStatusEnum.WITHDRAWN:
        skipped_stages = {"assigned", "first_response", "in_progress", "resolved"}
        for s in stages:
            if s["stage"] in skipped_stages or s["stage"].startswith("approval_level_"):
                s["status"] = "skipped"
                s["at"] = None

    return stages


async def get_request_detail(sr_id: str, user: UserBase) -> dict[str, Any]:
    sr = await ServiceRequest.get(sr_id)
    if sr is None or sr.deleted_on is not None or str(sr.organisation_id) != user.organisation_id:
        from ..exceptions import DomainException
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    await require_ticket_access(sr, user)

    iam = get_iam_client()
    cat = await Category.get(sr.category_id)
    rt = await RequestType.get(sr.request_type_id)
    dept = None
    if cat:
        # The detail card shows one department. A category can span several
        # now, so show the primary one — department_ids[0] (D10) — which for
        # every category that exists today is the only one there is.
        _dept_ids = await _ticket_department_ids(sr, cat)
        if _dept_ids:
            dept = await iam.get_department(_dept_ids[0], access_token=user.access_token)
    requester = await iam.get_user(str(sr.requester_user_id), access_token=user.access_token)
    # For the assignment card, surface the *current handler*. After a Phase B
    # escalation (approval-phase) the override approver — the dept head — is
    # the active handler even though sr.executor_user_id still points to the
    # original executor. In every other case the executor is the handler.
    handler_user_id = sr.executor_user_id
    if (
        sr.is_escalated
        and sr.escalation_override_approver_user_id
        and sr.request_status == RequestStatusEnum.PENDING_APPROVAL
    ):
        handler_user_id = sr.escalation_override_approver_user_id
    executor = (
        await iam.get_user(str(handler_user_id), access_token=user.access_token)
        if handler_user_id
        else None
    )

    attachments = await Attachment.find(
        {"service_request_id": sr.id, "deleted_on": None}
    ).to_list()
    att_rows = [
        {"id": str(a.id), "filename": a.filename, "size_bytes": a.size_bytes, "mime_type": a.mime_type}
        for a in attachments
    ]

    approvals = await _build_approvals_block(sr, user)
    sla = await _compute_sla(sr)
    caps = await compute_capabilities(sr, user)

    # Handoffs are the record of who passed the ticket to whom, for both
    # escalation and reassignment — the ticket itself only keeps the current
    # and immediately-previous executor, so the timeline cannot name the
    # participants without them. One IAM batch covers every id involved.
    handoffs = (
        await HandoffEvent.find({"service_request_id": sr.id, "deleted_on": None})
        .sort("+created_on")
        .to_list()
    )
    _party_ids = {
        str(uid)
        for h in handoffs
        for uid in (h.from_user_id, h.to_user_id, h.created_by)
        if uid
    }
    for uid in (
        sr.executor_user_id,
        sr.previous_executor_user_id,
        sr.escalation_override_approver_user_id,
    ):
        if uid:
            _party_ids.add(str(uid))
    # `executor` and `requester` are already resolved above — reuse rather than
    # asking IAM for them a second time.
    _party_ids.discard(str(handler_user_id) if handler_user_id else "")
    party_docs = (
        await iam.get_users(sorted(_party_ids), access_token=user.access_token)
        if _party_ids
        else {}
    )
    names: dict[str, str] = {
        uid: user_name(doc) for uid, doc in party_docs.items() if user_name(doc)
    }
    if handler_user_id and user_name(executor):
        names[str(handler_user_id)] = user_name(executor)

    timeline = _build_timeline(
        sr,
        approvals,
        dept=dept,
        is_viewer_current_executor=(sr.executor_user_id == user.oid),
        handoffs=handoffs,
        names=names,
    )

    # If the ticket was escalated, surface the dept head (current handler)
    # in the assignment card with the handoff date — regardless of whether
    # the executor field itself was updated (Phase A) or only the override
    # approver (Phase B).
    assignment_block = {
        "executor_user_id": str(handler_user_id) if handler_user_id else None,
        "executor_name": user_name(executor),
        # Was `"Department Head" if sr.is_escalated`, a D3 leftover: escalation
        # targeted the head back then, so the label was true by construction.
        # It targets a category primary now — who may be neither the head nor
        # even in the ticket's department — so the old label confidently gave
        # the handler a title they do not hold. Same defect as the timeline's
        # Escalated row, which read the name off the department record.
        "executor_role": "Escalated to" if sr.is_escalated else None,
        "executor_department": (dept or {}).get("department_name") or (dept or {}).get("departmentName"),
        "executor_contact": (executor or {}).get("email"),
        "assigned_on": sr.escalated_at if sr.is_escalated else sr.assigned_at,
    }

    return {
        "id": str(sr.id),
        "ticket_no": sr.ticket_no,
        "title": sr.title,
        "description": sr.description,
        "status": sr.request_status.value,
        "is_escalated": sr.is_escalated,
        "escalation_count": sr.escalation_count,
        "priority": sr.priority.value,
        "submitted_on": sr.submitted_on,
        "requester_user_id": str(sr.requester_user_id),
        "requester_name": user_name(requester),
        "rejection_reason": sr.rejection_reason,
        "resolution_notes": sr.resolution_notes,
        "closing_remarks": sr.closing_remarks,
        "escalation_reason": sr.escalation_reason,
        "metadata": {
            "category_id": str(sr.category_id),
            "category_name": (cat.name if cat else None),
            "request_type_id": str(sr.request_type_id),
            "request_type_name": (rt.name if rt else None),
            "department_id": (dept or {}).get("id"),
            "department_name": (dept or {}).get("department_name") or (dept or {}).get("departmentName"),
        },
        "attachments": att_rows,
        "assignment": assignment_block,
        "sla": sla,
        "approvals": approvals,
        "timeline": timeline,
        "capabilities": caps,
    }


async def get_attachment_signed_url(
    sr_id: str, att_id: str, user: UserBase
) -> dict[str, Any]:
    sr = await ServiceRequest.get(sr_id)
    if sr is None or str(sr.organisation_id) != user.organisation_id:
        from ..exceptions import DomainException
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    await require_ticket_access(sr, user)
    att = await Attachment.get(att_id)
    if att is None or str(att.service_request_id) != str(sr.id):
        from ..exceptions import DomainException
        raise DomainException("Attachment not found", "ATTACHMENT_NOT_FOUND", 404)
    # For S3 backend the storage_client returns a real presigned URL the
    # browser can hit directly. For local backend we return a relative URL
    # pointing at our own authenticated streaming endpoint (because the
    # browser tab can't carry the user's JWT — the FE must fetch with auth
    # and create a blob URL).
    from ..config import settings
    if (settings.STORAGE_BACKEND or "").lower() == "s3":
        url = await signed_download_url(att.storage_key)
    else:
        url = (
            f"/api/v1/service-requests/requests/{sr.id}/attachments/"
            f"{att.id}/file"
        )
    return {
        "id": str(att.id),
        "filename": att.filename,
        "mime_type": att.mime_type,
        "size_bytes": att.size_bytes,
        "download_url": url,
        "expires_in_seconds": 300,
    }


async def stream_attachment_file(sr_id: str, att_id: str, user: UserBase):
    """Authenticated streaming endpoint for local-backend downloads.

    Re-runs ticket-access auth, looks up the attachment, and returns a
    FileResponse with Content-Disposition: attachment so the browser
    saves the file with its original name.
    """
    from fastapi.responses import FileResponse
    from ..exceptions import DomainException
    from ..integrations.storage_client import local_path_for_key

    sr = await ServiceRequest.get(sr_id)
    if sr is None or str(sr.organisation_id) != user.organisation_id:
        raise DomainException("Request not found", "REQUEST_NOT_FOUND", 404)
    await require_ticket_access(sr, user)
    att = await Attachment.get(att_id)
    if att is None or str(att.service_request_id) != str(sr.id):
        raise DomainException("Attachment not found", "ATTACHMENT_NOT_FOUND", 404)

    path = local_path_for_key(att.storage_key)
    if not path.exists():
        raise DomainException(
            "Attachment file is missing on disk",
            "ATTACHMENT_FILE_MISSING",
            404,
        )
    return FileResponse(
        path=str(path),
        media_type=att.mime_type or "application/octet-stream",
        filename=att.filename or "attachment",
    )
