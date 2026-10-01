"""Requests list + dashboard — Chapter 4."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

from ..common.iam_helpers import is_manager, try_oid, user_name
from ..auth.utils.dependencies import UserBase
from ..common.names import search_regex
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow
from ..exceptions import InvalidDateRange
from ..integrations.iam_client import get_iam_client
from ..models import (
    Category,
    PriorityEnum,
    RequestStatusEnum,
    RequestType,
    ServiceRequest,
    TERMINAL_STATUSES,
)
from ..valkey import get_valkey

OPEN_STATUSES: list[str] = [
    RequestStatusEnum.PENDING_APPROVAL.value,
    RequestStatusEnum.PENDING_ASSIGNMENT.value,
    RequestStatusEnum.ASSIGNED.value,
    RequestStatusEnum.IN_PROGRESS.value,
]


def _role_of(user: UserBase) -> str:
    # Org admins see their whole organisation (same org-scoped filter as a
    # super admin — see _scoped_filter, which always pins organisation_id).
    if user.is_super_admin or user.is_org_admin:
        return "super_admin"
    if is_manager(user.permissions):
        return "manager"
    return "employee"


async def _managed_category_ids(user: UserBase) -> list[str]:
    iam = get_iam_client()
    dept_ids = await iam.get_managed_category_ids(user.id)
    if not dept_ids:
        return []
    _oids = [try_oid(d) for d in dept_ids]
    cats = await Category.find(
        {
            "organisation_id": user.org_oid,
            # department_ids is an array — $in matches when any element is in
            # the list. The scalar is the deprecated mirror on un-migrated docs.
            "$or": [
                {"department_ids": {"$in": _oids}},
                {"department_id": {"$in": _oids}},
            ],
            "deleted_on": None,
        }
    ).to_list()
    return [c.id for c in cats]


async def _caller_department_id(user: UserBase) -> str:
    """The caller's department id — session first, IAM only as a fallback.

    Prefers the IAM-written session ``department_id`` (reliable, no round-trip).
    Only when the session didn't carry it do we fall back to an IAM API lookup —
    otherwise callers silently collapse to ``[]`` whenever IAM is unreachable,
    which drops the dept-category clause from the scoped filter and makes a
    department member's queue look empty.

    Returns ``""`` when nothing resolves; what that means is the caller's call.
    """
    dept_id = str(user.department_id or "")
    if dept_id:
        return dept_id
    try:
        iam = get_iam_client()
        # Look up the employee by user_id to find their department.
        emp_data = await iam.get_user(user.id, access_token=user.access_token)
        emp = (emp_data or {}).get("_employee") or emp_data or {}
        dept_id = str(emp.get("departmentId") or emp.get("department_id") or "")
        if not dept_id and user.email:
            # Fallback: search employees list by email.
            employees = await iam.list_employees(
                access_token=user.access_token, limit=1, search=user.email,
            )
            if employees:
                dept_id = str(
                    employees[0].get("departmentId")
                    or employees[0].get("department_id")
                    or ""
                )
    except Exception:  # noqa: BLE001
        return ""
    return dept_id


# The department-wide sweep that used to live here is gone. Every caller —
# `_scoped_filter` (and through it the unflagged ticket list, the CSV export and
# the dashboard cards), the department queue, the queue export and analytics
# `department_queue_scope` — now goes through `_roster_visible_category_ids`.
# Keeping a department-wide variant alongside it is what made the roster
# narrowing cosmetic the first time: the tickets the queue hid came straight
# back through whichever caller still used the wider sweep. Reintroduce it only
# with a caller that genuinely wants a department rather than a roster.


async def _roster_visible_category_ids(user: UserBase) -> list[Any]:
    """Categories whose tickets the caller may see in the department queue.

    Roster-scoped rather than department-scoped. A configured roster names
    exactly who works the category, so only its primaries and secondaries see
    its tickets in "Employee Tickets" and the To Execute open pool — the rest of
    the department no longer does. Membership is what qualifies, not location:
    a roster executor staffed out of another department sees the queue too,
    which is the gap menu-config.ts calls out as unreachable today.

    An empty roster stays legacy (D4): the category has named nobody, so its
    departments remain the pool. Without that fallback every category still
    running on department membership would show its tickets to no one at all.

    Deliberately stricter than `_is_category_workforce`, which honours
    `roster_is_exclusive` and so keeps department members *eligible to act* on
    all but the categories that set it. This narrows who the queue lists, not
    who may act; the two are allowed to differ, and a department member handed
    a deep link can still self-assign exactly as before.
    """
    # `user.oid` is None when the session carried no usable user id. Mongo reads
    # `{"executors.user_id": None}` as "path missing", which matches every
    # rosterless category in the org and ignores the department entirely — the
    # roster branch would fail *open*. Nothing legitimate is visible to a caller
    # we cannot identify, so stop here.
    if user.oid is None:
        return []
    try:
        clauses: list[dict[str, Any]] = [{"executors.user_id": user.oid}]
        dept_id = await _caller_department_id(user)
        if dept_id:
            _dept = try_oid(dept_id)
            clauses.append(
                {
                    # "No roster" has two storage shapes: an explicit [] and the
                    # field missing entirely on documents written before it
                    # existed. `executors.0` covers both; `$size: 0` would miss
                    # the second, which is most of them.
                    "executors.0": {"$exists": False},
                    # A category is staffed by a list of departments now. Mongo
                    # matches array membership on plain equality, so this one
                    # clause covers both — plus the deprecated scalar that
                    # un-migrated documents still carry.
                    "$or": [{"department_ids": _dept}, {"department_id": _dept}],
                }
            )
        cats = await Category.find(
            {
                "organisation_id": user.org_oid,
                "deleted_on": None,
                "$or": clauses,
            }
        ).to_list()
        return [c.id for c in cats]
    except Exception:
        return []


async def _rostered_category_ids(org_oid: Any, target_oid: Any) -> list[Any]:
    """Categories that name ``target_oid`` on their roster, primary or secondary.

    The roster branch of `_roster_visible_category_ids` on its own — no
    department fallback. Two callers want exactly that: the employee ceiling for
    someone who holds no `manage_request` (being named on a roster is the grant,
    but department membership alone is not), and an executor filter aimed at
    another user, whose department this service cannot resolve without IAM.
    """
    if target_oid is None:
        return []
    try:
        cats = await Category.find(
            {
                "organisation_id": org_oid,
                "deleted_on": None,
                "executors.user_id": target_oid,
            }
        ).to_list()
        return [c.id for c in cats]
    except Exception:
        return []


async def _executor_queue_category_ids(user: UserBase, target_oid: Any) -> list[Any]:
    """Categories whose tickets belong in ``target_oid``'s executor queue.

    For the caller's own queue this is the full roster sweep: the categories
    they are primary or secondary on, plus the rosterless ones their department
    staffs (D4). For another user's queue — managers and admins may inspect one
    — only the roster is consulted; the department fallback needs that user's
    department, which lives in IAM.
    """
    if target_oid == user.oid:
        return await _roster_visible_category_ids(user)
    return await _rostered_category_ids(user.org_oid, target_oid)


async def _scoped_filter(user: UserBase) -> dict[str, Any]:
    """Role-scoped filter for ticket queries (Chapter 4 §19.4.4)."""
    role = _role_of(user)
    # `deleted_on: None` belongs here rather than at the call sites: this
    # function feeds list_requests, dashboard_summary and the CSV export, and
    # only the my_requests branch of list_requests was pinning it. Setting it in
    # the three places separately is how they drifted apart in the first place.
    # Nothing soft-deletes a ServiceRequest today, so this closes the hole
    # before a delete endpoint or an out-of-band migration opens it.
    filt: dict[str, Any] = {"organisation_id": user.org_oid, "deleted_on": None}
    if role == "super_admin":
        return filt
    if role == "manager":
        managed = await _managed_category_ids(user)
        clauses: list[dict[str, Any]] = [
            {"primary_assignee_user_id": user.oid},
            {"executor_user_id": user.oid},
            {"requester_user_id": user.oid},
            # Tickets the caller escalated away. `escalate` moves
            # `executor_user_id` to the target and parks the old owner here
            # (service_assign.py), so without this clause a ticket vanishes from
            # its previous executor the instant they hand it off — and
            # `?previous_executor_user_id=me` below could never match, because
            # this filter ANDs over it. Not a widening: they executed the
            # ticket, so they have already seen everything on it.
            {"previous_executor_user_id": user.oid},
        ]
        dept_cats = await _roster_visible_category_ids(user)
        all_cats = list(set((managed or []) + (dept_cats or [])))
        if all_cats:
            clauses.append({"category_id": {"$in": all_cats}})
        filt["$or"] = clauses
        return filt
    # Employee — own tickets + tickets where they are primary assignee or
    # executor. Category-wide visibility is added on top only for holders of
    # service_request:manage_request (dept leads), the same gate the
    # ?for_my_department=true view applies: without it an ordinary raise_request
    # holder would read every ticket routed to their department (and, through
    # the detail view, its attachments) just by omitting the flag.
    #
    # Roster-scoped, and identical to the flagged view's scope. Leaving it
    # department-wide made the roster narrowing cosmetic: the same tickets came
    # straight back through an unflagged GET /requests, the CSV export and the
    # dashboard cards, and the ids they carried opened the detail view and its
    # attachments. This is also what keeps `_scoped_filter` the ceiling on what
    # `list_requests` can return, rather than something the flagged view escapes.
    clauses: list[dict[str, Any]] = [
        {"requester_user_id": user.oid},
        {"primary_assignee_user_id": user.oid},
        {"executor_user_id": user.oid},
        # See the manager branch above — a ticket the caller escalated away.
        {"previous_executor_user_id": user.oid},
    ]
    #
    # Roster membership is its own grant. A category that names the caller as
    # primary or secondary has made them its workforce, so its tickets are in
    # their queue whether or not the ACL also hands them `manage_request` —
    # without this, `?executor_user_id=me` could list a rostered executor's
    # categories only to have the ceiling AND them straight back out. The
    # permission still gates the *department* fallback, which is the branch
    # that would otherwise show a raise_request holder their whole department.
    if user.has_permission("service_request", "manage_request"):
        dept_cats = await _roster_visible_category_ids(user)
    else:
        dept_cats = await _rostered_category_ids(user.org_oid, user.oid)
    if dept_cats:
        clauses.append({"category_id": {"$in": dept_cats}})
    filt["$or"] = clauses
    return filt


REQUEST_SORTS = ("submitted_on_desc", "submitted_on_asc", "priority_desc", "open_first")

# urgent -> low. A plain field sort can't express this: the stored values sort
# lexically as high < low < medium < urgent, which is meaningless.
_PRIORITY_RANK = {
    PriorityEnum.URGENT.value: 0,
    PriorityEnum.HIGH.value: 1,
    PriorityEnum.MEDIUM.value: 2,
    PriorityEnum.LOW.value: 3,
}


async def _paged_requests(
    filt: dict[str, Any], p: PageParams, sort: str | None
) -> list[ServiceRequest]:
    """Fetch one page of tickets under `sort`.

    `submitted_on_*` are plain index-backed sorts. `priority_desc` and
    `open_first` need a computed rank, so they run a small aggregation that
    orders and slices server-side and returns ids only; the documents are then
    loaded and put back into that order. Ranking in Mongo (rather than sorting
    a fetched page in Python) is what keeps the ordering global instead of
    per-page.
    """
    # Every ordering ends on _id. Without a unique final key, rows that tie on
    # the sort fields have no defined order between two queries, so page 2 can
    # repeat or skip rows that page 1 already returned.
    skip = compute_skip(p)
    if sort in (None, "submitted_on_desc"):
        return await ServiceRequest.find(filt).sort("-submitted_on", "-_id").skip(skip).limit(p.page_size).to_list()
    if sort == "submitted_on_asc":
        return await ServiceRequest.find(filt).sort("+submitted_on", "+_id").skip(skip).limit(p.page_size).to_list()

    prio_branches = [
        {"case": {"$eq": ["$priority", value]}, "then": rank}
        for value, rank in _PRIORITY_RANK.items()
    ]
    add_fields: dict[str, Any] = {
        "_prio_rank": {"$switch": {"branches": prio_branches, "default": 9}}
    }
    sort_stage: dict[str, Any] = {}
    if sort == "open_first":
        add_fields["_open_rank"] = {
            "$cond": [{"$in": ["$request_status", OPEN_STATUSES]}, 0, 1]
        }
        sort_stage["_open_rank"] = 1
    sort_stage["_prio_rank"] = 1
    sort_stage["submitted_on"] = -1
    sort_stage["_id"] = -1

    pipeline: list[dict[str, Any]] = [
        {"$match": filt},
        {"$addFields": add_fields},
        {"$sort": sort_stage},
        {"$skip": skip},
        {"$limit": p.page_size},
        {"$project": {"_id": 1}},
    ]
    ordered_ids = [
        d["_id"] for d in await ServiceRequest.aggregate(pipeline).to_list()
    ]
    if not ordered_ids:
        return []
    docs = await ServiceRequest.find({"_id": {"$in": ordered_ids}}).to_list()
    by_id = {d.id: d for d in docs}
    return [by_id[i] for i in ordered_ids if i in by_id]


async def list_requests(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    category_id: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    requester_user_id: str | None = None,
    executor_user_id: str | None = None,
    previous_executor_user_id: str | None = None,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
    status_group: str | None = None,
    resolved_on: str | None = None,
    request_type_id: str | None = None,
    sort: str | None = None,
    my_requests: bool = False,
    for_my_department: bool = False,
) -> dict[str, Any]:
    if created_from and created_to and created_from > created_to:
        raise InvalidDateRange()
    if my_requests:
        filt: dict[str, Any] = {
            "organisation_id": user.org_oid,
            "requester_user_id": user.oid,
            "deleted_on": None,
        }
    else:
        filt = await _scoped_filter(user)
    if category_id:
        filt["category_id"] = try_oid(category_id)
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if status:
        values = [s.strip() for s in status.split(",") if s.strip()]
        filt["request_status"] = {"$in": values} if len(values) > 1 else values[0]
    if priority:
        values = [p.strip() for p in priority.split(",") if p.strip()]
        filt["priority"] = {"$in": values} if len(values) > 1 else values[0]

    role = _role_of(user)
    if not my_requests and requester_user_id:
        if role == "employee":
            pass
        else:
            filt["requester_user_id"] = try_oid(requester_user_id)

    # Executor-side queue filter — "show this executor's queue". Employees can
    # always filter to their own id; managers/admins can pass any user id (e.g.
    # to inspect another exec's queue).
    #
    # A queue is more than "tickets assigned to me". A roster names who works a
    # category, so every ticket on a category the executor is primary or
    # secondary on is theirs to see — unclaimed, held by a colleague, or already
    # resolved — alongside whatever they are executing outside those categories
    # (a reassignment or an escalation can hand them one anywhere). Pinning
    # `executor_user_id` alone was why To Execute showed an executor only their
    # own assignments and never their category's other tickets.
    #
    # Self-raised tickets are left out of the category half, as the
    # `for_my_department` view does below: they belong to My Tickets, and a
    # ticket the caller raised *and* executes still arrives through the first
    # clause. ANDed in rather than written to the top level so `_scoped_filter`'s
    # own `$or` stays the ceiling.
    if executor_user_id:
        if role == "employee" and executor_user_id != user.id:
            executor_user_id = user.id  # silently scope back to self
        target_oid = try_oid(executor_user_id)
        queue_clauses: list[dict[str, Any]] = [{"executor_user_id": target_oid}]
        queue_cats = await _executor_queue_category_ids(user, target_oid)
        if queue_cats:
            queue_clauses.append(
                {
                    "category_id": {"$in": queue_cats},
                    "requester_user_id": {"$ne": target_oid},
                }
            )
        filt["$and"] = filt.get("$and", []) + [{"$or": queue_clauses}]

    # "Show what I escalated away." `escalate` reassigns `executor_user_id` to
    # the target, so a handed-off ticket disappears from the escalator's queue
    # entirely — the executor filter above cannot express it, and nothing else
    # in the app reads this field. Same self-scoping as the executor filter.
    #
    # Only meaningful together with `is_escalated`: a later reassign clears that
    # flag but leaves this one set (service_assign.py), so on its own this also
    # matches tickets that were merely passed on, not escalated.
    if previous_executor_user_id:
        if role == "employee" and previous_executor_user_id != user.id:
            previous_executor_user_id = user.id  # silently scope back to self
        filt["previous_executor_user_id"] = try_oid(previous_executor_user_id)

    # "Employee Requests" view — the caller's working queue. Resolved by
    # finding the category_ids in this org they are rostered on (plus the
    # rosterless ones their department staffs), then filtering tickets by
    # category_id in that set.
    if for_my_department:
        # Still gated on service_request:manage_request, but the gate is no
        # longer what does the scoping — in a standard org it grants `editor`
        # to essentially every employee, which is why the roster and not this
        # permission decides who the queue lists. Org/super admins carry a full
        # grid so they pass; everyone else gets an empty set rather than a leak.
        if not user.has_permission("service_request", "manage_request"):
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        # Roster-scoped, not department-scoped: where a category has named its
        # primaries and secondaries, they are the queue's audience and the rest
        # of the department is not. Categories with no roster still resolve by
        # department (D4). The session department_id is preferred inside the
        # helper with an IAM lookup as fallback — otherwise employees whose
        # session payload omitted it see an empty queue despite belonging to a
        # department with open tickets.
        dept_cat_ids = await _roster_visible_category_ids(user)
        if not dept_cat_ids:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        # If category_id was already filtered, narrow further (intersection).
        if "category_id" in filt:
            existing = filt["category_id"]
            if not isinstance(existing, dict):
                filt["category_id"] = existing if existing in dept_cat_ids else "__none__"
            elif isinstance(existing, dict) and "$in" in existing:
                inter = [c for c in existing["$in"] if c in dept_cat_ids]
                filt["category_id"] = {"$in": inter or ["__none__"]}
        else:
            filt["category_id"] = {"$in": dept_cat_ids}
        # Self-raised tickets are surfaced separately under "My Requests" —
        # exclude them here so they don't appear in both lists.
        filt["requester_user_id"] = {"$ne": user.oid}
        # The category pin above IS the scope. Everyone named on a roster works
        # the same categories, so they all see the same tickets — including one
        # a colleague has already taken up, and one they have since resolved or
        # closed.
        #
        # This deliberately no longer narrows to "pending assignment, or mine".
        # That narrowing is what made a ticket disappear from every other
        # secondary's list the moment one of them picked it up: the ticket was
        # no longer PENDING_ASSIGNMENT and its executor was somebody else, so
        # neither clause matched and it stayed invisible through resolution and
        # closure. A roster is a shared queue; hiding a colleague's work from it
        # also emptied the Pending / Resolved / Closed cards the screen draws.
        #
        # To Execute no longer sends this flag: `?executor_user_id=me` above
        # resolves the same roster-wide category set on its own, plus the
        # tickets the caller executes elsewhere. The sidebar badge still pairs
        # this flag with `status=pending_assignment`, because it counts the
        # unclaimed subset rather than the queue.
        #
        # `_scoped_filter`'s own `$or` is left standing rather than overwritten,
        # so this view stays bounded by the same ceiling as every other caller.
        # It cannot narrow the result: reaching here requires
        # `service_request:manage_request` (checked above), which is exactly the
        # gate that gives `_scoped_filter` its roster-category clause, resolved
        # through this same helper — so every ticket the category pin admits
        # satisfies that clause too.

    if created_from or created_to:
        range_filter: dict[str, Any] = {}
        if created_from:
            range_filter["$gte"] = created_from
        if created_to:
            range_filter["$lte"] = created_to
        filt["submitted_on"] = range_filter

    if status_group == "open":
        filt["request_status"] = {"$in": OPEN_STATUSES}
    elif status_group == "closed":
        filt["request_status"] = {
            "$in": [RequestStatusEnum.CLOSED.value, RequestStatusEnum.RESOLVED.value]
        }

    if resolved_on == "today":
        start = datetime.combine(
            utcnow().date(), datetime.min.time(), tzinfo=timezone.utc
        )
        filt["resolved_at"] = {"$gte": start}
        filt["request_status"] = RequestStatusEnum.RESOLVED.value

    needle = search_regex(q)
    if needle:
        filt["$and"] = filt.get("$and", []) + [
            {
                "$or": [
                    {"ticket_no": {"$regex": needle, "$options": "i"}},
                    {"title": {"$regex": needle, "$options": "i"}},
                ]
            }
        ]

    total = await ServiceRequest.find(filt).count()
    items = await _paged_requests(filt, p, sort)
    if not items:
        return {"items": [], "total": total, "page": p.page, "page_size": p.page_size}

    # Batch enrich.
    cat_ids = list({i.category_id for i in items})
    rt_ids = list({i.request_type_id for i in items})
    cats = {str(c.id): c.name for c in await Category.find({"_id": {"$in": [try_oid(c) for c in cat_ids]}}).to_list()}
    rts = {str(r.id): r.name for r in await RequestType.find({"_id": {"$in": [try_oid(r) for r in rt_ids]}}).to_list()}
    iam = get_iam_client()
    requesters = await iam.get_users(list({str(i.requester_user_id) for i in items}), access_token=user.access_token)

    # For rejected tickets, find the level at which rejection happened —
    # batched lookup against ApprovalDecision (single query per page).
    from ..models import ApprovalDecision, DecisionEnum
    rejection_levels: dict[str, int] = {}
    rejected_ids = [
        i.id for i in items
        if i.request_status == RequestStatusEnum.REJECTED.value
    ]
    if rejected_ids:
        rej_decisions = await ApprovalDecision.find({
            "service_request_id": {"$in": rejected_ids},
            "decision": DecisionEnum.REJECTED.value,
            "deleted_on": None,
        }).to_list()
        for d in rej_decisions:
            rejection_levels[str(d.service_request_id)] = d.level_index

    rows = [
        {
            "id": str(i.id),
            "ticket_no": i.ticket_no,
            "title": i.title,
            "request_type_id": str(i.request_type_id),
            "request_type_name": rts.get(str(i.request_type_id)),
            "requester_user_id": str(i.requester_user_id),
            "requester_name": user_name(requesters.get(str(i.requester_user_id))),
            "category_id": str(i.category_id),
            "category_name": cats.get(str(i.category_id)),
            "priority": i.priority,
            "created_on": i.submitted_on,
            "status": i.request_status,
            "current_level_index": i.current_level_index,
            "is_escalated": i.is_escalated,
            # Which handoff `is_escalated` refers to. The flag alone conflates
            # two unrelated events: an executor handing work to the dept head
            # (Phase A), and one approver handing a decision to another while
            # the ticket sits in approval (Phase B). Phase B leaves
            # `executor_user_id` untouched, so without this the executor queue
            # counts an escalation that never involved the executor at all.
            # Same rule the timeline uses (service_detail.py:1213).
            "escalation_phase": (
                None
                if not i.is_escalated
                else (
                    "approval"
                    if i.escalation_override_approver_user_id is not None
                    else "executor"
                )
            ),
            "executor_user_id": str(i.executor_user_id) if i.executor_user_id else None,
            # Who held the ticket before the current executor. Lets a caller
            # tell a ticket escalated TO them from one they escalated AWAY,
            # which are the same `is_escalated: true` on the wire.
            "previous_executor_user_id": (
                str(i.previous_executor_user_id)
                if i.previous_executor_user_id
                else None
            ),
            "first_response_due_by": i.first_response_due_by,
            "resolution_due_by": i.resolution_due_by,
            "rejected_at_level": rejection_levels.get(str(i.id)),
        }
        for i in items
    ]
    return {"items": rows, "total": total, "page": p.page, "page_size": p.page_size}


async def export_department_requests_xlsx(
    user: UserBase,
    *,
    q: str | None = None,
    request_type_id: str | None = None,
    priority: str | None = None,
    status: str | None = None,
    roster_wide: bool = False,
    escalated_away: bool = False,
) -> bytes:
    """Build an xlsx of the caller's executor queue.

    Scope: everything they are the executor of, wherever it lives, plus the
    tickets on the categories they are rostered on and the rosterless ones
    their department staffs.

    That is the union the To Execute screen displays through
    ``?executor_user_id=me`` (RequestQueue.tsx), which `list_requests` resolves
    to the same two clauses. Matching it here is the point: the executor half is deliberately *not*
    category-scoped, so an exported sheet built from the department half alone
    would silently drop tickets the caller is actively working in another
    department — which is exactly the case a roster executor staffed outside
    the department is in.

    ``roster_wide`` widens the category half from the unclaimed pool to every
    ticket on those categories, whoever holds it and whatever its status. Both
    To Execute and Employee Requests list that set now, and each names it when
    exporting; the default stays the narrower pool so an older caller's sheet
    is unchanged.

    ``escalated_away`` adds the tickets the caller escalated to someone else.
    Escalating moves ``executor_user_id`` to the target, so nothing above can
    reach these rows — yet To Execute lists them under its Escalated card, and
    without this the sheet exported from that card was missing half of it.
    Only executor-phase escalations count: an approval-phase handoff sets
    ``is_escalated`` too but never touched the executor, and is excluded the
    same way the list serialiser derives ``escalation_phase``.

    The endpoint keeps its ``/requests/department-export`` path for
    compatibility, though the scope is now the queue rather than the department.
    """
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    def _empty() -> bytes:
        wb = Workbook()
        ws = wb.active
        ws.title = "Employee Requests"
        ws.append([
            "Request ID", "Title", "Request Type", "Requester",
            "Category", "Priority", "Status",
            "Created Date", "Resolved Date", "Closed Date",
        ])
        buf = BytesIO()
        wb.save(buf)
        return buf.getvalue()

    # Same reason as `_roster_visible_category_ids`: with `user.oid` None the
    # executor clause below becomes `{"executor_user_id": None}`, which Mongo
    # matches against every *unassigned* ticket. That clause sits at the top
    # level of the `$or` with no category bound, so it would dump the whole
    # org's open queue into a spreadsheet. The old filter ANDed a category pin
    # over everything and could not reach this state.
    if user.oid is None:
        return _empty()

    # Shares the queue's own scope resolution so the spreadsheet can never
    # describe a different set of tickets than the screen it was exported from.
    # The `not user.department_id` early return goes with it: a roster executor
    # staffed out of another department has rows to export even when the session
    # carries no department at all — and, below, even when the department half
    # resolves to nothing.
    dept_cat_ids = await _roster_visible_category_ids(user)

    # The screen's two halves, as two clauses. The executor half carries no
    # category scope on purpose (see the docstring); the category half keeps
    # the self-raised exclusion, because a ticket you raised belongs to My
    # Tickets rather than to the pool you might pick up.
    clauses: list[dict[str, Any]] = [{"executor_user_id": user.oid}]
    if dept_cat_ids:
        dept_clause: dict[str, Any] = {
            "category_id": {"$in": dept_cat_ids},
            "requester_user_id": {"$ne": user.oid},
        }
        # To Execute exports the pool it can act on, so it stays pinned to the
        # unclaimed tickets. Employee Requests lists the whole roster, including
        # the rows a colleague holds, and its sheet has to say the same.
        if not roster_wide:
            dept_clause["request_status"] = (
                RequestStatusEnum.PENDING_ASSIGNMENT.value
            )
        clauses.append(dept_clause)
    if escalated_away:
        clauses.append(
            {
                "previous_executor_user_id": user.oid,
                # A later reassign clears `is_escalated` but leaves the previous
                # executor set (service_assign.py), so the id alone would also
                # match tickets that were merely passed on.
                "is_escalated": True,
                # `None` here is what the serialiser reads as the executor
                # phase; a set override approver means the approval phase.
                "escalation_override_approver_user_id": None,
            }
        )

    filt: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "deleted_on": None,
        "$or": clauses,
    }
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if priority:
        values = [p.strip() for p in priority.split(",") if p.strip()]
        filt["priority"] = {"$in": values} if len(values) > 1 else values[0]
    if status:
        values = [s.strip() for s in status.split(",") if s.strip()]
        filt["request_status"] = {"$in": values} if len(values) > 1 else values[0]
    needle = search_regex(q)
    if needle:
        filt["$and"] = filt.get("$and", []) + [
            {
                "$or": [
                    {"ticket_no": {"$regex": needle, "$options": "i"}},
                    {"title": {"$regex": needle, "$options": "i"}},
                ]
            }
        ]

    items = await ServiceRequest.find(filt).sort("-submitted_on").to_list()

    rt_ids = list({i.request_type_id for i in items})
    rts = {
        str(r.id): r.name
        for r in await RequestType.find({"_id": {"$in": [try_oid(r) for r in rt_ids]}}).to_list()
    }
    # Keyed off the result set, not the department scope. The executor half of
    # the filter above carries no category scope, so a ticket being worked in
    # another department is in `items` while its category is not in
    # `dept_cat_ids` — looking the names up from the scope would leave exactly
    # those rows with a blank Category.
    cat_ids = list({i.category_id for i in items})
    cats_by_id = {
        str(c.id): c.name
        for c in await Category.find(
            {"_id": {"$in": [try_oid(c) for c in cat_ids]}}
        ).to_list()
    }
    iam = get_iam_client()
    requesters = await iam.get_users(
        list({str(i.requester_user_id) for i in items}),
        access_token=user.access_token,
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Employee Requests"
    headers = [
        "Request ID",
        "Title",
        "Request Type",
        "Requester",
        "Category",
        "Priority",
        "Status",
        "Created Date",
        "Resolved Date",
        "Closed Date",
    ]
    ws.append(headers)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="334155")
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    def _fmt(dt) -> str:
        return dt.strftime("%d %b %Y") if dt else ""

    for i in items:
        ws.append([
            i.ticket_no,
            i.title or "",
            rts.get(str(i.request_type_id), ""),
            user_name(requesters.get(str(i.requester_user_id))) or "",
            cats_by_id.get(str(i.category_id), ""),
            i.priority.value if hasattr(i.priority, "value") else str(i.priority),
            (
                i.request_status.value
                if hasattr(i.request_status, "value")
                else str(i.request_status)
            ).replace("_", " "),
            _fmt(i.submitted_on),
            _fmt(i.resolved_at),
            _fmt(i.closed_at),
        ])

    widths = [18, 40, 24, 22, 20, 10, 18, 14, 14, 14]
    for col_idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = w
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def export_my_requests_xlsx(
    user: UserBase,
    *,
    q: str | None = None,
    category_id: str | None = None,
    request_type_id: str | None = None,
    priority: str | None = None,
    status: str | None = None,
) -> bytes:
    """Build an xlsx of the caller's own service requests.

    Honours the same filters as the My Requests list view; ignores pagination.
    """
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    filt: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "requester_user_id": user.oid,
        "deleted_on": None,
    }
    if category_id:
        filt["category_id"] = try_oid(category_id)
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if priority:
        values = [p.strip() for p in priority.split(",") if p.strip()]
        filt["priority"] = {"$in": values} if len(values) > 1 else values[0]
    if status:
        values = [s.strip() for s in status.split(",") if s.strip()]
        filt["request_status"] = {"$in": values} if len(values) > 1 else values[0]
    needle = search_regex(q)
    if needle:
        filt["$and"] = filt.get("$and", []) + [
            {
                "$or": [
                    {"ticket_no": {"$regex": needle, "$options": "i"}},
                    {"title": {"$regex": needle, "$options": "i"}},
                ]
            }
        ]

    items = await ServiceRequest.find(filt).sort("-submitted_on").to_list()

    # Resolve category + request-type names once.
    cat_ids = list({i.category_id for i in items})
    rt_ids = list({i.request_type_id for i in items})
    cats = {
        str(c.id): c.name
        for c in await Category.find({"_id": {"$in": [try_oid(c) for c in cat_ids]}}).to_list()
    }
    rts = {
        str(r.id): r.name
        for r in await RequestType.find({"_id": {"$in": [try_oid(r) for r in rt_ids]}}).to_list()
    }

    wb = Workbook()
    ws = wb.active
    ws.title = "My Requests"
    headers = [
        "Request ID",
        "Title",
        "Request Type",
        "Category",
        "Priority",
        "Status",
        "Created Date",
        "Resolved Date",
        "Closed Date",
    ]
    ws.append(headers)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="334155")
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    def _fmt(dt) -> str:
        return dt.strftime("%d %b %Y") if dt else ""

    for i in items:
        ws.append([
            i.ticket_no,
            i.title or "",
            rts.get(str(i.request_type_id), ""),
            cats.get(str(i.category_id), ""),
            i.priority.value if hasattr(i.priority, "value") else str(i.priority),
            (
                i.request_status.value
                if hasattr(i.request_status, "value")
                else str(i.request_status)
            ).replace("_", " "),
            _fmt(i.submitted_on),
            _fmt(i.resolved_at),
            _fmt(i.closed_at),
        ])

    widths = [18, 40, 24, 20, 10, 18, 14, 14, 14]
    for col_idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = w
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


_APPROVALS_HEADERS = [
    "Request ID",
    "Title",
    "Request Type",
    "Requester",
    "Category",
    "Priority",
    "Status",
    "My Decision",
    "Created Date",
]


def _empty_approvals_xlsx() -> bytes:
    """Header-only Approvals workbook — an empty scope still returns a file."""
    from io import BytesIO
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Approvals"
    ws.append(_APPROVALS_HEADERS)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def export_approvals_xlsx(
    user: UserBase,
    *,
    scope: str = "all",
    q: str | None = None,
    category_id: str | None = None,
    request_type_id: str | None = None,
    priority: str | None = None,
    status: str | None = None,
    is_escalated: bool | None = None,
    my_decision: str | None = None,
    created_from: datetime | None = None,
) -> bytes:
    """Build an xlsx of the caller's approvals queue.

    Mirrors the Approvals page exactly — same scope resolution as
    list_pending_approvals (shared via _approvals_universe, so the
    reporting-tree rows behind "My team's requests" export too), same
    hidden-status default (rejected + withdrawn excluded), same card + date
    filters. Ignores pagination; pass the page's `scope` to export the card
    the user is looking at.
    """
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    # Identical scope resolution to list_pending_approvals — shared so the
    # spreadsheet always describes the same universe as the screen, including
    # the reporting-tree rows behind the "My team's requests" card.
    or_clauses, decided_map, pin_pending, _legacy, _tree = await _approvals_universe(
        user, scope=scope
    )
    if not or_clauses:
        return _empty_approvals_xlsx()

    # organisation_id is mandatory: the legacy clause matches on workflow_id +
    # level alone, which would surface another tenant's tickets. A caller whose
    # session carries no usable org id resolves to None and matches nothing.
    filt: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "$or": or_clauses,
        "deleted_on": None,
    }
    # Default exclusions — Approvals page hides rejected + withdrawn tickets.
    # If the caller explicitly passed a status filter, that wins.
    if pin_pending:
        filt["request_status"] = RequestStatusEnum.PENDING_APPROVAL.value
    elif status:
        values = [s.strip() for s in status.split(",") if s.strip()]
        filt["request_status"] = {"$in": values} if len(values) > 1 else values[0]
    else:
        filt["request_status"] = {
            "$nin": [
                RequestStatusEnum.REJECTED.value,
                RequestStatusEnum.WITHDRAWN.value,
            ]
        }
    if category_id:
        filt["category_id"] = try_oid(category_id)
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if priority:
        values = [p.strip() for p in priority.split(",") if p.strip()]
        filt["priority"] = {"$in": values} if len(values) > 1 else values[0]
    if is_escalated is not None:
        filt["is_escalated"] = is_escalated
    if created_from:
        filt["submitted_on"] = {"$gte": created_from}
    needle = search_regex(q)
    if needle:
        filt["$and"] = filt.get("$and", []) + [
            {
                "$or": [
                    {"ticket_no": {"$regex": needle, "$options": "i"}},
                    {"title": {"$regex": needle, "$options": "i"}},
                ]
            }
        ]

    items = await ServiceRequest.find(filt).sort("-submitted_on").to_list()

    # `my_decision` filter happens post-fetch since it lives in ApprovalDecision,
    # not on the ticket. Maps card filters: awaiting=pending, approved=approved.
    if my_decision:
        wanted = my_decision.lower()
        items = [
            i for i in items
            if decided_map.get(str(i.id), "pending") == wanted
        ]

    # Resolve display names.
    cat_ids = list({i.category_id for i in items})
    rt_ids = list({i.request_type_id for i in items})
    cats = {
        str(c.id): c.name
        for c in await Category.find({"_id": {"$in": [try_oid(c) for c in cat_ids]}}).to_list()
    }
    rts = {
        str(r.id): r.name
        for r in await RequestType.find({"_id": {"$in": [try_oid(r) for r in rt_ids]}}).to_list()
    }
    iam = get_iam_client()
    requesters = await iam.get_users(
        list({str(i.requester_user_id) for i in items}),
        access_token=user.access_token,
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "Approvals"
    headers = [
        "Request ID",
        "Title",
        "Request Type",
        "Requester",
        "Category",
        "Priority",
        "Status",
        "My Decision",
        "Created Date",
    ]
    ws.append(headers)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="334155")
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    def _fmt(dt) -> str:
        return dt.strftime("%d %b %Y") if dt else ""

    for i in items:
        ws.append([
            i.ticket_no,
            i.title or "",
            rts.get(str(i.request_type_id), ""),
            user_name(requesters.get(str(i.requester_user_id))) or "",
            cats.get(str(i.category_id), ""),
            i.priority.value if hasattr(i.priority, "value") else str(i.priority),
            (
                i.request_status.value
                if hasattr(i.request_status, "value")
                else str(i.request_status)
            ).replace("_", " "),
            decided_map.get(str(i.id), "pending"),
            _fmt(i.submitted_on),
        ])

    widths = [18, 40, 24, 24, 20, 10, 18, 14, 14]
    for col_idx, w in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = w
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def _reporting_tree_levels(user: UserBase) -> dict[str, int]:
    """Map of report user id -> 1 or 2 for everyone reporting to `user`.

    Replica-first: the local employees collection answers in one Mongo query.
    It fills lazily, though, so an empty result is ambiguous — it means either
    "no reports" or "never synced". Rather than silently show a manager a short
    queue, an empty replica answer falls back to a live IAM sweep, which also
    writes the org through to the replica so the next call is cheap.
    """
    from ..integrations import employee_replica

    try:
        levels = await employee_replica.list_report_levels_by_manager(
            user.id, organisation_id=user.organisation_id
        )
    except Exception:  # noqa: BLE001
        logger.warning("pending_approvals.replica_reports_failed", exc_info=True)
        levels = {}
    if levels:
        return levels
    try:
        return await get_iam_client().list_report_levels(
            user.id, user.organisation_id, access_token=user.access_token
        )
    except Exception:  # noqa: BLE001
        # A manager with no resolvable tree still gets their own approver rows.
        logger.warning("pending_approvals.iam_reports_failed", exc_info=True)
        return {}


APPROVAL_SCOPES = ("all", "awaiting_me", "my_team")


async def _approvals_universe(
    user: UserBase, *, scope: str = "all"
) -> tuple[list[dict], dict[str, str], bool, dict[str, set[int]], dict[str, int]]:
    """Build the `$or` clauses defining the caller's approvals universe.

    Returns ``(or_clauses, decided_map, pin_pending_approval,
    legacy_levels_by_workflow, reporting_tree_levels)``. An empty ``or_clauses`` means "nothing
    matches" — callers must short-circuit rather than hand Mongo an empty
    ``$or``, which is a query error. The last element maps workflow id → the
    levels the caller approves at, and is only needed for legacy tickets that
    predate the L1/L2 snapshot (see `_my_approval_level`).

    Scopes:
      ``awaiting_me`` — only rows the caller can act on **now**: they are the
        approver at the ticket's current level, the ticket is sitting in
        PENDING_APPROVAL, and they have not already decided *at that level*.
        Level-aware exclusion matters: someone who approved at L1 and is also
        the L2 approver must still see the ticket when it reaches L2.
      ``my_team`` — tickets raised by anyone whose L1/L2 manager is the caller.
      ``all`` — the union, plus the caller's decision history.
    """
    from ..models import ApprovalLevel, Approver, ApprovalDecision

    decisions = await ApprovalDecision.find(
        {"approver_user_id": user.oid, "deleted_on": None}
    ).to_list()
    decided_map: dict[str, str] = {}
    decided_at_level: dict[int, list[Any]] = {}
    for d in decisions:
        decided_map[str(d.service_request_id)] = d.decision.value
        oid = try_oid(str(d.service_request_id))
        if oid is not None:
            decided_at_level.setdefault(d.level_index, []).append(oid)

    approver_rows = await Approver.find(
        {"approver_user_id": user.oid, "deleted_on": None}
    ).to_list()
    # Legacy model: resolve approver_rows → (workflow_id, level_index) pairs.
    level_ids = [a.approval_level_id for a in approver_rows]
    levels = await ApprovalLevel.find(
        {"_id": {"$in": [try_oid(lid) for lid in level_ids]}, "deleted_on": None}
    ).to_list() if level_ids else []
    level_by_id = {str(l.id): l for l in levels}
    my_level_pairs = list({
        (lvl.workflow_id, lvl.level_index)
        for a in approver_rows
        if (lvl := level_by_id.get(a.approval_level_id)) is not None
    })
    legacy_levels: dict[str, set[int]] = {}
    for wf_id, lvl_idx in my_level_pairs:
        legacy_levels.setdefault(str(wf_id), set()).add(lvl_idx)

    def _approver_clauses(*, exclude_decided: bool) -> list[dict]:
        out: list[dict] = []
        pairs: list[tuple[int, dict]] = [
            (1, {"current_level_index": 1, "level_1_approver_user_id": user.oid}),
            (2, {"current_level_index": 2, "level_2_approver_user_id": user.oid}),
        ]
        pairs.extend(
            (lvl_idx, {"workflow_id": wf_id, "current_level_index": lvl_idx})
            for wf_id, lvl_idx in my_level_pairs
        )
        for lvl_idx, clause in pairs:
            if exclude_decided and decided_at_level.get(lvl_idx):
                clause = {**clause, "_id": {"$nin": decided_at_level[lvl_idx]}}
            out.append(clause)
        # Phase-B escalation (utils/escalation.py) REPLACES the current level's
        # approver with a single user and deliberately leaves current_level_index
        # and the status alone. That user is therefore neither snapshot approver
        # above nor an Approver row, so without this clause they match nothing —
        # while authorization.py:152 lets them approve or reject. They held a
        # decision they could not find in any list.
        #
        # Paired with current_level_index rather than matched on its own: the two
        # fields are always cleared together (service_actions.py:112, :205, :695,
        # :820 and service_assign.py:512), so requiring an approval to be in
        # flight keeps a stale override from resurrecting a finished ticket.
        #
        # Not level-scoped, so `exclude_decided` cannot apply: the override
        # replaces whichever level is in flight, and there is no level index on
        # the clause to look the caller's decisions up by.
        out.append({
            "current_level_index": {"$ne": None},
            "escalation_override_approver_user_id": user.oid,
        })
        return out

    # `awaiting_me` needs no reporting tree, so skip the walk entirely for it —
    # that is the expensive part of this function.
    if scope == "awaiting_me":
        return _approver_clauses(exclude_decided=True), decided_map, True, legacy_levels, {}

    # Everything raised by the caller's reporting tree (L1 or L2), at any
    # status. Self-raised tickets are dropped: they belong to "My Requests",
    # and a manager listed as their own manager would otherwise see them twice.
    tree_levels = await _reporting_tree_levels(user)
    report_oids = [
        oid
        for oid in (
            try_oid(rid) for rid in tree_levels if str(rid) != str(user.id)
        )
        if oid
    ]
    team_clauses = (
        [{"requester_user_id": {"$in": report_oids}}] if report_oids else []
    )
    if scope == "my_team":
        return team_clauses, decided_map, False, legacy_levels, tree_levels

    clauses = _approver_clauses(exclude_decided=False)
    decided_ids = [oid for oid in (try_oid(s) for s in decided_map) if oid]
    if decided_ids:
        clauses.append({"_id": {"$in": decided_ids}})
    clauses.extend(team_clauses)
    return clauses, decided_map, False, legacy_levels, tree_levels


async def count_pending_approvals(user: UserBase) -> dict[str, int]:
    """The six Team Tickets badge totals in one call.

    Each key is exactly what the equivalent `list_pending_approvals` query
    returns for its `total`, so a badge can never disagree with the table it
    opens:

        all         -> no params           my_team    -> ?scope=my_team
        awaiting_me -> ?scope=awaiting_me  approved   -> ?my_decision=approved
        escalated   -> ?is_escalated=true  urgent     -> ?priority=urgent

    Deliberately ignores the toolbar filters — these read as "what is in each
    queue" and stay stable while the user narrows the table.

    The reporting tree is walked **once** here (via the `all` scope) and the
    `my_team` clauses are reused from it, rather than resolved a second time.
    That single walk is the reason this endpoint exists.
    """
    all_clauses, decided_map, _pin, _legacy, _tree = await _approvals_universe(
        user, scope="all"
    )
    # No second tree walk: `awaiting_me` never needed one, and the team clauses
    # are recoverable from the union built above.
    awaiting_clauses, _, _, _, _ = await _approvals_universe(user, scope="awaiting_me")
    team_clauses = [c for c in all_clauses if "requester_user_id" in c]

    base: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "deleted_on": None,
    }

    async def _count(clauses: list[dict], extra: dict[str, Any] | None = None) -> int:
        if not clauses:
            return 0
        filt = {**base, "$or": clauses}
        if extra:
            filt.update(extra)
        return await ServiceRequest.find(filt).count()

    approved_ids = [
        oid
        for oid in (
            try_oid(sid) for sid, dec in decided_map.items() if dec == "approved"
        )
        if oid
    ]

    return {
        "all": await _count(all_clauses),
        "awaiting_me": await _count(
            awaiting_clauses,
            {"request_status": RequestStatusEnum.PENDING_APPROVAL.value},
        ),
        "my_team": await _count(team_clauses),
        "approved": (
            await _count(all_clauses, {"_id": {"$in": approved_ids}})
            if approved_ids
            else 0
        ),
        "escalated": await _count(all_clauses, {"is_escalated": True}),
        "urgent": await _count(
            all_clauses, {"priority": PriorityEnum.URGENT.value}
        ),
    }


async def list_pending_approvals(
    user: UserBase,
    p: PageParams,
    *,
    scope: str = "all",
    q: str | None = None,
    category_id: str | None = None,
    request_type_id: str | None = None,
    priority: str | None = None,
    status: str | None = None,
    is_escalated: bool | None = None,
    my_decision: str | None = None,
    created_from: datetime | None = None,
) -> dict[str, Any]:
    """Return the caller's approvals queue, scoped by `scope`.

    `all` (default) is approver rows + decision history + the caller's whole
    reporting tree. `awaiting_me` narrows to rows actionable right now, so a
    manager with a large team can page the actionable set on its own instead of
    hunting for it inside a submitted_on-ordered union. `my_team` is the
    complement used by the team card.

    Every filter is applied in Mongo before skip/limit, so `total` and paging
    describe the same set the caller asked for.
    """
    from ..models import ApprovalDecision, DecisionEnum

    or_clauses, decided_map, pin_pending, legacy_levels, tree_levels = await _approvals_universe(
        user, scope=scope
    )

    def _my_approval_level(sr: ServiceRequest) -> int | None:
        """The caller's level on this ticket — 1, 2 or None.

        Resolved in three steps, so the answer does not depend on whether an
        approval has been raised yet:

        1. The ticket's L1/L2 snapshots, written at submit-for-approval.
        2. Legacy workflow-config approvers, for tickets predating snapshots.
        3. The requester's manager chain — the caller is this employee's L1 or
           L2 manager. This is what fills the field on team rows where no
           approval was ever raised, and it agrees with (1) once one is,
           because the snapshot is taken from that same chain.

        When the caller holds both levels the ticket's current level wins, so
        the FE shows the one that is actually live.
        """
        named: set[int] = set()
        if sr.level_1_approver_user_id == user.oid:
            named.add(1)
        if sr.level_2_approver_user_id == user.oid:
            named.add(2)
        if not named:
            # Legacy ticket — approver lives in workflow config, not on the SR.
            named = set(legacy_levels.get(str(sr.workflow_id), ()))
        if not named:
            # No approval raised: fall back to the reporting chain.
            chain_level = tree_levels.get(str(sr.requester_user_id))
            if chain_level:
                return chain_level
            return None
        if sr.current_level_index in named:
            return sr.current_level_index
        return min(named)
    if not or_clauses:
        return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}

    # Same org pin as export_approvals_xlsx — the legacy workflow_id clause is
    # not tenant-scoped on its own.
    filt: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "$or": or_clauses,
        "deleted_on": None,
    }
    if pin_pending:
        filt["request_status"] = RequestStatusEnum.PENDING_APPROVAL.value
    elif status:
        values = [s.strip() for s in status.split(",") if s.strip()]
        filt["request_status"] = {"$in": values} if len(values) > 1 else values[0]
    if category_id:
        filt["category_id"] = try_oid(category_id)
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if priority:
        values = [x.strip() for x in priority.split(",") if x.strip()]
        filt["priority"] = {"$in": values} if len(values) > 1 else values[0]
    if is_escalated is not None:
        filt["is_escalated"] = is_escalated
    if created_from:
        filt["submitted_on"] = {"$gte": created_from}
    needle = search_regex(q)
    if needle:
        filt["$and"] = filt.get("$and", []) + [
            {
                "$or": [
                    {"ticket_no": {"$regex": needle, "$options": "i"}},
                    {"title": {"$regex": needle, "$options": "i"}},
                ]
            }
        ]
    # `my_decision` lives in ApprovalDecision, not on the ticket. Resolve it to
    # an _id set so it filters in Mongo — a post-fetch filter would leave
    # `total` and the page slice describing different sets.
    if my_decision:
        wanted = my_decision.strip().lower()
        matching = [
            oid
            for oid in (
                try_oid(sid)
                for sid, dec in decided_map.items()
                if dec == wanted
            )
            if oid
        ]
        if wanted == "pending":
            excluded = [oid for oid in (try_oid(s) for s in decided_map) if oid]
            if excluded:
                filt["_id"] = {"$nin": excluded}
        elif matching:
            filt["_id"] = {"$in": matching}
        else:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}

    total = await ServiceRequest.find(filt).count()
    items = (
        await ServiceRequest.find(filt)
        .sort("-submitted_on")
        .skip(compute_skip(p))
        .limit(p.page_size)
        .to_list()
    )
    if not items:
        return {"items": [], "total": total, "page": p.page, "page_size": p.page_size}

    # Enrich with names.
    cat_ids = list({i.category_id for i in items})
    rt_ids = list({i.request_type_id for i in items})
    cats = {str(c.id): c.name for c in await Category.find({"_id": {"$in": [try_oid(c) for c in cat_ids]}}).to_list()}
    rts = {str(r.id): r.name for r in await RequestType.find({"_id": {"$in": [try_oid(r) for r in rt_ids]}}).to_list()}
    iam = get_iam_client()
    requesters = await iam.get_users(list({str(i.requester_user_id) for i in items}), access_token=user.access_token)

    # For rejected tickets, find the level at which rejection happened.
    rejection_levels: dict[str, int] = {}
    rejected_ids = [
        i.id for i in items
        if i.request_status == RequestStatusEnum.REJECTED.value
    ]
    if rejected_ids:
        rej_decisions = await ApprovalDecision.find({
            "service_request_id": {"$in": rejected_ids},
            "decision": DecisionEnum.REJECTED.value,
            "deleted_on": None,
        }).to_list()
        for d in rej_decisions:
            rejection_levels[str(d.service_request_id)] = d.level_index

    rows = [
        {
            "id": str(i.id),
            "ticket_no": i.ticket_no,
            "title": i.title,
            "request_type_id": str(i.request_type_id),
            "request_type_name": rts.get(str(i.request_type_id)),
            "requester_user_id": str(i.requester_user_id),
            "requester_name": user_name(requesters.get(str(i.requester_user_id))),
            "category_id": str(i.category_id),
            "category_name": cats.get(str(i.category_id)),
            "priority": i.priority,
            "created_on": i.submitted_on,
            "status": i.request_status,
            "is_escalated": i.is_escalated,
            "current_level_index": i.current_level_index,
            "rejected_at_level": rejection_levels.get(str(i.id)),
            "my_decision": decided_map.get(str(i.id), "pending"),
            # 1 / 2 when the caller is this ticket's L1 / L2 approver, null on
            # reporting-tree rows where they are not an approver at all.
            "my_approval_level": _my_approval_level(i),
        }
        for i in items
    ]
    return {"items": rows, "total": total, "page": p.page, "page_size": p.page_size}


# ---------- Dashboard ----------

def _dashboard_cache_key(user: UserBase, role: str) -> str:
    return f"srm:dashboard:{user.organisation_id}:{user.id}:{role}"


async def dashboard_summary(user: UserBase, *, my_requests: bool = False) -> dict[str, Any]:
    role = _role_of(user)
    cache_suffix = "my" if my_requests else role
    key = _dashboard_cache_key(user, cache_suffix)
    try:
        cache = get_valkey()
        cached = await cache.get(key)
        if cached:
            return json.loads(cached)
    except Exception:  # noqa: BLE001
        cache = None  # type: ignore[assignment]

    if my_requests:
        filt: dict[str, Any] = {
            "organisation_id": user.org_oid,
            "requester_user_id": user.oid,
            "deleted_on": None,
        }
    else:
        filt = await _scoped_filter(user)

    now = utcnow()
    today_start = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)

    total_count = await ServiceRequest.find(filt).count()
    open_count = await ServiceRequest.find(
        {**filt, "request_status": {"$in": OPEN_STATUSES}}
    ).count()
    resolved_today = await ServiceRequest.find(
        {
            **filt,
            "request_status": RequestStatusEnum.RESOLVED.value,
            "resolved_at": {"$gte": today_start},
        }
    ).count()

    if my_requests:
        from ..models import ApprovalDecision, DecisionEnum
        approved_count = 0
        rejected_count = 0
        all_srs = await ServiceRequest.find(filt).to_list()
        for sr in all_srs:
            decisions = await ApprovalDecision.find(
                {"service_request_id": sr.id, "deleted_on": None}
            ).to_list()
            if not decisions:
                continue
            has_reject = any(d.decision == DecisionEnum.REJECTED for d in decisions)
            all_approved = all(d.decision == DecisionEnum.APPROVED for d in decisions)
            if has_reject:
                rejected_count += 1
            elif all_approved and len(decisions) > 0:
                approved_count += 1

        payload = {
            "cards": [
                {"id": "total", "label": "Total Tickets", "value": total_count, "filter": {}},
                {"id": "open", "label": "Open Tickets", "value": open_count, "filter": {"status_group": "open"}},
                {"id": "approved", "label": "Approved", "value": approved_count, "filter": {}},
                {"id": "rejected", "label": "Rejected", "value": rejected_count, "filter": {"status": "rejected"}},
            ]
        }
    elif role == "employee":
        payload = {
            "cards": [
                {"id": "total", "label": "Total Tickets", "value": total_count, "filter": {}},
                {"id": "open", "label": "Open Tickets", "value": open_count, "filter": {"status_group": "open"}},
                {
                    "id": "role_card",
                    "label": "Rejected",
                    "value": await ServiceRequest.find(
                        {**filt, "request_status": RequestStatusEnum.REJECTED.value}
                    ).count(),
                    "filter": {"status": "rejected"},
                },
                {"id": "resolved_today", "label": "Resolved Today", "value": resolved_today, "filter": {"status": "resolved", "resolved_on": "today"}},
            ]
        }
    else:
        payload = {
            "cards": [
                {"id": "total", "label": "Total Tickets", "value": total_count, "filter": {}},
                {"id": "open", "label": "Open Tickets", "value": open_count, "filter": {"status_group": "open"}},
                {
                    "id": "role_card",
                    "label": "SLA Breached",
                    "value": await ServiceRequest.find(
                        {
                            **filt,
                            "resolution_due_by": {"$lt": now},
                            "request_status": {
                                "$nin": [s.value for s in TERMINAL_STATUSES] + [
                                    RequestStatusEnum.RESOLVED.value
                                ]
                            },
                        }
                    ).count(),
                    "filter": {"status_group": "sla_breached"},
                },
                {"id": "resolved_today", "label": "Resolved Today", "value": resolved_today, "filter": {"status": "resolved", "resolved_on": "today"}},
            ]
        }

    try:
        if cache is not None:
            await cache.setex(key, 60, json.dumps(payload, default=str))
    except Exception:  # noqa: BLE001
        pass
    return payload
