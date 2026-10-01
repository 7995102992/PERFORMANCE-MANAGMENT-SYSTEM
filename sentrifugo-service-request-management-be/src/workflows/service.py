"""Workflow service — Chapters 3 + 4."""
from __future__ import annotations

import logging
from typing import Any

from ..audit import emit_audit

logger = logging.getLogger(__name__)
from ..auth.utils.dependencies import UserBase
from ..common.iam_helpers import try_oid, user_name
from ..common.names import search_regex
from ..common.pagination import PageParams, compute_skip
from ..common.timestamps import utcnow

from ..exceptions import (
    CategoryNotFound,
    DeptHeadMissing,
    RequestTypeNotFound,
    WorkflowActiveCannotDelete,
    WorkflowApproverDuplicateAcrossLevels,
    WorkflowApproverInvalidUser,
    WorkflowEscalationTargetNotPrimary,
    WorkflowInUse,
    WorkflowNotFound,
)
from ..integrations.iam_client import IAMError, get_iam_client
from ..models import (
    ApprovalLevel,
    Approver,
    Category,
    EscalationConfig,
    ExecutorRoleEnum,
    RequestStatusEnum,
    RequestType,
    ServiceRequest,
    StatusEnum,
    TERMINAL_STATUSES,
    Workflow,
)
from ..valkey import get_valkey, workflow_active_cache_key
from .schemas import (
    ApprovalLevelIn,
    EscalationConfigIn,
    WorkflowCreate,
    WorkflowUpdate,
)


async def _load_category(category_id: str, organisation_id: str) -> Category:
    cat = await Category.get(category_id)
    if (
        cat is None
        or cat.deleted_on is not None
        or str(cat.organisation_id) != organisation_id
    ):
        raise CategoryNotFound()
    return cat


async def _load_rt(request_type_id: str, organisation_id: str) -> RequestType:
    rt = await RequestType.get(request_type_id)
    if (
        rt is None
        or rt.deleted_on is not None
        or str(rt.organisation_id) != organisation_id
    ):
        raise RequestTypeNotFound()
    return rt


async def resolve_primary_assignee(category: Category, *, access_token: str | None = None) -> tuple[str, dict, dict]:
    """Returns (user_id, dept_data, head_user_data).

    A category can be staffed by several departments; the snapshot is a single
    user, so the department context is the *primary* department —
    `department_ids[0]` (D10).

    THE ROSTER WINS, THE HEAD IS THE FALLBACK. This used to be the other way
    round: the head of `department_ids[0]` was taken first and the roster was
    consulted only when IAM had no head on record. That was correct under D3,
    when heads held category powers implicitly and the docstring could say
    "real authority is `_is_category_primary`, which covers every head and every
    configured primary". D3 is gone — `_is_category_primary` answers from the
    roster alone, and a head who is not on it holds nothing.

    Leaving the old order in place produced a ticket whose
    `primary_assignee_user_id` was a department head off the roster, which is
    the one identity that passes `require_primary_assignee` (a bare snapshot
    comparison) while failing `_is_category_primary`. The configured primary —
    the person the admin actually picked — was not snapshotted at all.

    The head fallback is kept for categories that predate the roster: they have
    no primary to snapshot, and `raise_request` now refuses to create tickets in
    them anyway, so this only serves workflows created against legacy data.
    """
    from ..categories.service import category_department_ids

    iam = get_iam_client()
    dept_ids = category_department_ids(category)
    dept = (
        await iam.get_department(str(dept_ids[0]), access_token=access_token)
        if dept_ids
        else None
    )

    # 1. The roster's first primary — whoever the admin configured.
    first_primary = next(
        (
            e
            for e in (category.executors or [])
            if e.role == ExecutorRoleEnum.PRIMARY
        ),
        None,
    )
    head = str(first_primary.user_id) if first_primary else None

    # 2. Legacy fallback only: no roster primary, so use the department head.
    if not head and dept:
        head = (
            dept.get("head_user_id")
            or dept.get("department_head")
            or dept.get("departmentHead")
        )
    if not head:
        raise DeptHeadMissing()
    dept = dept or {}
    head_user_id = str(head)
    # Head-user enrichment is display-only (create_workflow discards it; preview
    # uses it for a name). Don't let an IAM blip undo the department fallback —
    # the head *id* came from the replica, so degrade the name gracefully.
    try:
        head_data = await iam.get_user(head_user_id, access_token=access_token) or {}
    except IAMError:
        logger.warning("resolve_primary_assignee.head_enrichment_skipped head=%s (IAM unreachable)", head_user_id)
        head_data = {}
    return head_user_id, dept, head_data


async def preview_primary_assignee(
    request_type_id: str, user: UserBase
) -> dict[str, Any]:
    rt = await _load_rt(request_type_id, user.organisation_id)
    cat = await _load_category(rt.category_id, user.organisation_id)
    head_user_id, dept, head_data = await resolve_primary_assignee(cat, access_token=user.access_token)
    return {
        "department_id": dept.get("id"),
        "department_name": dept.get("department_name") or dept.get("departmentName") or dept.get("name"),
        "primary_assignee_user_id": head_user_id,
        "primary_assignee_name": user_name(head_data),
    }


async def _validate_approvers(body: WorkflowCreate, user: UserBase) -> None:
    if not body.approval_required:
        return
    # Reject overlap between L1 and L2 approver sets — the same user must not
    # be configured to approve at both levels of the same workflow.
    by_level: dict[int, set[str]] = {}
    for level in body.approval_levels:
        by_level[level.level_index] = {
            a.approver_user_id for a in level.approvers
        }
    l1 = by_level.get(1) or set()
    l2 = by_level.get(2) or set()
    if l1 and l2 and (l1 & l2):
        raise WorkflowApproverDuplicateAcrossLevels()

    all_uids: list[str] = []
    for level in body.approval_levels:
        for a in level.approvers:
            all_uids.append(a.approver_user_id)
    if body.escalation_config and body.escalation_config.escalate_to_user_id:
        all_uids.append(body.escalation_config.escalate_to_user_id)

    iam = get_iam_client()
    users = await iam.get_users([str(u) for u in all_uids], access_token=user.access_token)
    for uid in all_uids:
        u = users.get(str(uid))
        if u is None:
            raise WorkflowApproverInvalidUser()
        if not user.is_super_admin and u.get("organisation_id") != user.organisation_id:
            raise WorkflowApproverInvalidUser()


def _validate_escalation_target(body: WorkflowCreate, cat: Category) -> None:
    """Auto-escalation may only target a primary on the workflow's category.

    Deliberately separate from `_validate_approvers`, which returns early when
    `approval_required` is False — that left the escalation target unchecked
    entirely on non-approval workflows, and it is exactly those workflows where
    auto-escalation is the only routing there is.

    Mirrors `_eligible_escalation_targets` in service_assign: escalated tickets
    go to the roster's primaries and nobody else, so a target off the roster is
    someone the manual path would refuse and who holds no rights over the
    ticket the SLA tick would hand them.
    """
    ec = body.escalation_config
    if ec is None or not ec.escalate_to_user_id:
        return
    primaries = {
        str(e.user_id)
        for e in (cat.executors or [])
        if e.role == ExecutorRoleEnum.PRIMARY
    }
    if str(ec.escalate_to_user_id) not in primaries:
        raise WorkflowEscalationTargetNotPrimary(cat.name or "")


async def create_workflow(body: WorkflowCreate, user: UserBase) -> dict[str, Any]:
    rt = await _load_rt(body.request_type_id, user.organisation_id)
    cat = await _load_category(body.category_id, user.organisation_id)
    if str(rt.category_id) != str(cat.id):
        raise RequestTypeNotFound()

    head_user_id, _dept, _head_data = await resolve_primary_assignee(cat, access_token=user.access_token)
    await _validate_approvers(body, user)
    _validate_escalation_target(body, cat)

    now = utcnow()

    async def _do_insert(session=None) -> tuple[Workflow, list[ApprovalLevel], list[Approver], EscalationConfig | None]:
        wf = Workflow(
            organisation_id=user.organisation_id,
            category_id=str(cat.id),
            request_type_id=str(rt.id),
            primary_assignee_user_id=head_user_id,
            approval_required=body.approval_required,
            status=StatusEnum.ACTIVE,
            created_by=user.id,
            created_on=now,
        )
        await wf.insert(session=session) if session else await wf.insert()
        levels: list[ApprovalLevel] = []
        approvers: list[Approver] = []
        for lvl in body.approval_levels:
            row = ApprovalLevel(
                workflow_id=str(wf.id),
                level_index=lvl.level_index,
                logic=lvl.logic,
                created_by=user.id,
                created_on=now,
            )
            await row.insert(session=session) if session else await row.insert()
            levels.append(row)
            for a in lvl.approvers:
                ar = Approver(
                    approval_level_id=str(row.id),
                    approver_type=a.approver_type,
                    approver_user_id=a.approver_user_id,
                    sort_order=a.sort_order,
                    created_by=user.id,
                    created_on=now,
                )
                await ar.insert(session=session) if session else await ar.insert()
                approvers.append(ar)
        ec: EscalationConfig | None = None
        if body.escalation_config is not None:
            ec = EscalationConfig(
                workflow_id=str(wf.id),
                auto_escalate_enabled=body.escalation_config.auto_escalate_enabled,
                escalate_after_minutes=body.escalation_config.escalate_after_minutes or 0,
                escalate_to_user_id=body.escalation_config.escalate_to_user_id,
                pre_notify_enabled=body.escalation_config.pre_notify_enabled,
                pre_notify_minutes_before=body.escalation_config.pre_notify_minutes_before or 0,
                notification_methods=body.escalation_config.notification_methods,
                notify_on=body.escalation_config.notify_on,
                created_by=user.id,
                created_on=now,
            )
            await ec.insert(session=session) if session else await ec.insert()
        return wf, levels, approvers, ec

    wf, levels, approvers, ec = await _do_insert(session=None)

    try:
        await emit_audit(
            event="workflow.created",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={
                "id": str(wf.id),
                "category_id": str(cat.id),
                "request_type_id": str(rt.id),
                "approval_levels": len(levels),
            },
        )
    except Exception:  # noqa: BLE001
        pass

    return await _workflow_to_out(wf, levels, approvers, ec, access_token=user.access_token)


async def _workflow_to_out(
    wf: Workflow,
    levels: list[ApprovalLevel],
    approvers: list[Approver],
    ec: EscalationConfig | None,
    *,
    access_token: str | None = None,
) -> dict[str, Any]:
    iam = get_iam_client()
    uids = {str(wf.primary_assignee_user_id)}
    for a in approvers:
        uids.add(str(a.approver_user_id))
    if ec and ec.escalate_to_user_id:
        uids.add(str(ec.escalate_to_user_id))
    users = await iam.get_users(list(uids), access_token=access_token)
    by_level: dict[Any, list[Approver]] = {}
    for a in approvers:
        by_level.setdefault(a.approval_level_id, []).append(a)
    levels_out = []
    for l in sorted(levels, key=lambda x: x.level_index):
        level_approvers = sorted(
            by_level.get(l.id, []), key=lambda x: x.sort_order
        )
        levels_out.append(
            {
                "level_index": l.level_index,
                "logic": l.logic,
                "approvers": [
                    {
                        "user_id": str(a.approver_user_id),
                        "name": user_name(users.get(str(a.approver_user_id))),
                        "role": None,
                        "sort_order": a.sort_order,
                    }
                    for a in level_approvers
                ],
            }
        )
    ec_out = None
    if ec is not None:
        ec_out = {
            "auto_escalate_enabled": ec.auto_escalate_enabled,
            "escalate_after_minutes": ec.escalate_after_minutes,
            "escalate_to_user_id": str(ec.escalate_to_user_id) if ec.escalate_to_user_id else None,
            "escalate_to_name": user_name(users.get(str(ec.escalate_to_user_id) if ec.escalate_to_user_id else "")),
            "pre_notify_enabled": ec.pre_notify_enabled,
            "pre_notify_minutes_before": ec.pre_notify_minutes_before,
            "notification_methods": ec.notification_methods,
            "notify_on": ec.notify_on,
        }
    primary = users.get(str(wf.primary_assignee_user_id)) or {}
    return {
        "id": str(wf.id),
        "organisation_id": str(wf.organisation_id),
        "category_id": str(wf.category_id),
        "request_type_id": str(wf.request_type_id),
        "primary_assignee_user_id": str(wf.primary_assignee_user_id),
        "primary_assignee_name": user_name(primary),
        "approval_required": wf.approval_required,
        "status": wf.status,
        "approval_levels": levels_out,
        "escalation_config": ec_out,
        "created_on": wf.created_on,
        "modified_on": wf.modified_on,
    }


# ---------- Chapter 4: list / detail / update / delete / activate ----------

async def _load_wf(wf_id: str, organisation_id: str) -> Workflow:
    wf = await Workflow.get(wf_id)
    if (
        wf is None
        or wf.deleted_on is not None
        or str(wf.organisation_id) != organisation_id
    ):
        raise WorkflowNotFound()
    return wf


async def _fetch_workflow_full(wf: Workflow, *, access_token: str | None = None) -> dict[str, Any]:
    levels = await ApprovalLevel.find(
        {"workflow_id": wf.id, "deleted_on": None}
    ).sort("level_index").to_list()
    level_ids = [l.id for l in levels]
    approvers = (
        await Approver.find(
            {"approval_level_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        if level_ids
        else []
    )
    ec = await EscalationConfig.find_one(
        {"workflow_id": wf.id, "deleted_on": None}
    )
    return await _workflow_to_out(wf, levels, approvers, ec, access_token=access_token)


async def get_workflow(wf_id: str, user: UserBase) -> dict[str, Any]:
    wf = await _load_wf(wf_id, user.organisation_id)
    return await _fetch_workflow_full(wf, access_token=user.access_token)


async def _apply_q_filter(
    filt: dict[str, Any], q: str | None, org_oid: Any
) -> bool:
    """Narrow `filt` in place by a free-text needle. Returns False if nothing can match.

    A workflow row carries no text of its own — it is a join between a category
    and a request type, and those two names are exactly what the list screen
    shows. So resolve the needle against both name columns first and filter the
    workflows by the ids that came back.

    The two id sets are OR-ed, and that `$or` sits alongside any explicit
    `category_id` / `request_type_id` key already in `filt` — Mongo ANDs
    top-level keys, so a search combines with the dropdowns rather than
    replacing them.
    """
    q_lc = search_regex((q or "").lower())
    if not q_lc:
        return True
    needle = {"$regex": q_lc, "$options": "i"}
    cat_ids = [
        c.id
        for c in await Category.find(
            {"organisation_id": org_oid, "deleted_on": None, "name_lc": needle}
        ).to_list()
    ]
    rt_ids = [
        r.id
        for r in await RequestType.find(
            {"organisation_id": org_oid, "deleted_on": None, "name_lc": needle}
        ).to_list()
    ]
    if not cat_ids and not rt_ids:
        return False
    clauses: list[dict[str, Any]] = []
    if cat_ids:
        clauses.append({"category_id": {"$in": cat_ids}})
    if rt_ids:
        clauses.append({"request_type_id": {"$in": rt_ids}})
    filt["$or"] = clauses
    return True


async def list_workflows(
    user: UserBase,
    p: PageParams,
    *,
    q: str | None = None,
    category_id: str | None = None,
    request_type_id: str | None = None,
    primary_assignee_user_id: str | None = None,
    approver_user_id: str | None = None,
    status: str = "all",
) -> dict[str, Any]:
    filt: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "deleted_on": None,
    }
    if category_id:
        filt["category_id"] = try_oid(category_id)
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if primary_assignee_user_id:
        filt["primary_assignee_user_id"] = try_oid(primary_assignee_user_id)
    if status == "active":
        filt["status"] = StatusEnum.ACTIVE
    elif status == "inactive":
        filt["status"] = StatusEnum.INACTIVE

    if not await _apply_q_filter(filt, q, user.org_oid):
        return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}

    if approver_user_id:
        # Walk approvers → levels → workflow ids.
        matching_approvers = await Approver.find(
            {"approver_user_id": try_oid(approver_user_id), "deleted_on": None}
        ).to_list()
        level_ids = list({a.approval_level_id for a in matching_approvers})
        if not level_ids:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        levels = await ApprovalLevel.find(
            {"_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        wf_ids = list({l.workflow_id for l in levels})
        if not wf_ids:
            return {"items": [], "total": 0, "page": p.page, "page_size": p.page_size}
        filt["_id"] = {"$in": wf_ids}

    total = await Workflow.find(filt).count()
    # Active workflows first, then inactive ones; newest first within each
    # group. StatusEnum only holds "active"/"inactive", so an ascending sort on
    # status already puts active ahead of inactive.
    wfs = (
        await Workflow.find(filt)
        .sort("+status", "-created_on")
        .skip(compute_skip(p))
        .limit(p.page_size)
        .to_list()
    )
    if not wfs:
        return {"items": [], "total": total, "page": p.page, "page_size": p.page_size}

    # Batch-fetch related rows.
    wf_ids = [w.id for w in wfs]
    cat_ids = list({w.category_id for w in wfs})
    rt_ids = list({w.request_type_id for w in wfs})
    cat_oids = [try_oid(cid) for cid in cat_ids]
    rt_oids = [try_oid(rid) for rid in rt_ids]
    cats = {str(c.id): c for c in await Category.find({"_id": {"$in": cat_oids}}).to_list()}
    rts = {str(r.id): r for r in await RequestType.find({"_id": {"$in": rt_oids}}).to_list()}
    levels = await ApprovalLevel.find(
        {"workflow_id": {"$in": wf_ids}, "deleted_on": None}
    ).to_list()
    levels_by_wf: dict[str, list[ApprovalLevel]] = {}
    for l in levels:
        levels_by_wf.setdefault(l.workflow_id, []).append(l)
    level_ids = [l.id for l in levels]
    approvers = (
        await Approver.find(
            {"approval_level_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        if level_ids
        else []
    )
    approvers_by_wf: dict[str, list[Approver]] = {}
    for a in approvers:
        # Find the wf for this approver via level.
        lvl = next((l for l in levels if str(l.id) == str(a.approval_level_id)), None)
        if lvl:
            approvers_by_wf.setdefault(lvl.workflow_id, []).append(a)
    ec_rows = await EscalationConfig.find(
        {"workflow_id": {"$in": wf_ids}, "deleted_on": None}
    ).to_list()
    ec_by_wf = {ec.workflow_id: ec for ec in ec_rows}

    iam = get_iam_client()
    need_user_ids = {str(w.primary_assignee_user_id) for w in wfs}
    for a in approvers:
        need_user_ids.add(str(a.approver_user_id))
    for ec in ec_rows:
        if ec.escalate_to_user_id:
            need_user_ids.add(str(ec.escalate_to_user_id))
    users = await iam.get_users(list(need_user_ids), access_token=user.access_token)

    rows: list[dict[str, Any]] = []
    for w in wfs:
        rt = rts.get(str(w.request_type_id))
        cat = cats.get(str(w.category_id))
        wf_approvers = approvers_by_wf.get(w.id, [])
        first_name = None
        if wf_approvers:
            first = sorted(wf_approvers, key=lambda a: a.sort_order)[0]
            first_name = user_name(users.get(str(first.approver_user_id)))
        ec = ec_by_wf.get(w.id)
        esc_summary = None
        if ec:
            target_name = user_name(users.get(str(ec.escalate_to_user_id) if ec.escalate_to_user_id else "")) or ec.escalate_to_user_id
            esc_summary = (
                f"After {ec.escalate_after_minutes} min to {target_name}"
                if ec.auto_escalate_enabled
                else "Manual only"
            )
        primary_name = user_name(users.get(str(w.primary_assignee_user_id)))
        # The category's CURRENT primaries, not the workflow's snapshot.
        #
        # `primary_assignee_user_id` is frozen when the workflow is created and
        # names exactly one person — the default assignee for new tickets. It
        # answers a different question from "who are this category's primaries",
        # and it drifts: edit the roster afterwards and the list keeps naming
        # whoever was first at creation time, possibly someone no longer a
        # primary at all. Showing it under a "Primary Assignee" heading made the
        # list contradict the category screen, which lists them all.
        #
        # Read live off the roster instead. `cat` is already loaded for
        # `category_name` and each executor row carries its own `name` snapshot,
        # so this needs no extra query and no extra IAM lookup.
        primary_executor_names = [
            e.name or e.email or str(e.user_id)
            for e in ((cat.executors if cat else None) or [])
            if e.role == ExecutorRoleEnum.PRIMARY
        ]
        rows.append(
            {
                "id": str(w.id),
                "category_id": str(w.category_id),
                "category_name": cat.name if cat else None,
                "request_type_id": str(w.request_type_id),
                "request_type_name": rt.name if rt else None,
                "primary_assignee_user_id": str(w.primary_assignee_user_id),
                "primary_assignee_name": primary_name,
                "primary_executor_names": primary_executor_names,
                # Exposed so the category screen can warn before removing a
                # primary who is a workflow's auto-escalation target. That one
                # is an explicit admin choice naming a specific person, unlike
                # the default assignee which is now derived live — so it cannot
                # be silently repointed and the admin has to be told.
                "escalate_to_user_id": (
                    str(ec.escalate_to_user_id)
                    if ec and ec.escalate_to_user_id
                    else None
                ),
                "total_approval_levels": len(levels_by_wf.get(w.id, [])),
                "approvers_summary": first_name,
                "approvers_count": len(wf_approvers),
                "escalation_summary": esc_summary,
                "status": w.status,
            }
        )
    return {"items": rows, "total": total, "page": p.page, "page_size": p.page_size}


async def update_workflow(
    wf_id: str, body: WorkflowUpdate, user: UserBase
) -> dict[str, Any]:
    wf = await _load_wf(wf_id, user.organisation_id)
    # Replace the tree: soft-delete levels/approvers/escalation, re-insert.
    now = utcnow()
    await _validate_approvers(body, user)
    # Same roster check as create — otherwise an edit is a way back in for a
    # target create refuses. The category comes off the workflow rather than the
    # body: update does not move a workflow between categories.
    _validate_escalation_target(
        body, await _load_category(str(wf.category_id), user.organisation_id)
    )

    wf.approval_required = body.approval_required
    wf.modified_by = user.id
    wf.modified_on = now
    await wf.save()

    # Soft-delete existing levels + approvers + ec.
    existing_levels = await ApprovalLevel.find(
        {"workflow_id": wf.id, "deleted_on": None}
    ).to_list()
    for l in existing_levels:
        l.deleted_on = now
        l.deleted_by = user.id
        await l.save()
    existing_level_ids = [l.id for l in existing_levels]
    if existing_level_ids:
        existing_approvers = await Approver.find(
            {"approval_level_id": {"$in": existing_level_ids}, "deleted_on": None}
        ).to_list()
        for a in existing_approvers:
            a.deleted_on = now
            a.deleted_by = user.id
            await a.save()
    existing_ec = await EscalationConfig.find_one(
        {"workflow_id": wf.id, "deleted_on": None}
    )
    if existing_ec is not None:
        existing_ec.deleted_on = now
        existing_ec.deleted_by = user.id
        await existing_ec.save()

    levels: list[ApprovalLevel] = []
    approvers: list[Approver] = []
    for lvl in body.approval_levels:
        l = ApprovalLevel(
            workflow_id=str(wf.id),
            level_index=lvl.level_index,
            logic=lvl.logic,
            created_by=user.id,
            created_on=now,
        )
        await l.insert()
        levels.append(l)
        for a in lvl.approvers:
            ar = Approver(
                approval_level_id=str(l.id),
                approver_type=a.approver_type,
                approver_user_id=a.approver_user_id,
                sort_order=a.sort_order,
                created_by=user.id,
                created_on=now,
            )
            await ar.insert()
            approvers.append(ar)
    ec: EscalationConfig | None = None
    if body.escalation_config is not None:
        ec = EscalationConfig(
            workflow_id=str(wf.id),
            auto_escalate_enabled=body.escalation_config.auto_escalate_enabled,
            escalate_after_minutes=body.escalation_config.escalate_after_minutes or 0,
            escalate_to_user_id=body.escalation_config.escalate_to_user_id,
            pre_notify_enabled=body.escalation_config.pre_notify_enabled,
            pre_notify_minutes_before=body.escalation_config.pre_notify_minutes_before or 0,
            notification_methods=body.escalation_config.notification_methods,
            notify_on=body.escalation_config.notify_on,
            created_by=user.id,
            created_on=now,
        )
        await ec.insert()
    # Re-enrol the SLA-tick timers for in-flight tickets so a changed
    # escalate_after_minutes / pre_notify takes effect immediately instead
    # of firing at the OLD enrolment time. Best-effort — never blocks the
    # workflow update.
    try:
        from ..requests.utils.timer_enrolment import reenrol_workflow_timers
        await reenrol_workflow_timers(wf.id, ec)
    except Exception:  # noqa: BLE001
        logger.warning("timer_reenrol.invoke_failed workflow=%s", wf.id)

    if body.status == StatusEnum.ACTIVE:
        await activate_workflow(wf_id, user)
    elif body.status == StatusEnum.INACTIVE:
        await deactivate_workflow(wf_id, user)
    await wf.sync()

    try:
        await emit_audit(
            event="workflow.updated",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(wf.id)},
        )
    except Exception:  # noqa: BLE001
        pass
    return await _workflow_to_out(wf, levels, approvers, ec, access_token=user.access_token)


async def export_workflows(
    user: UserBase,
    *,
    q: str | None = None,
    category_id: str | None = None,
    request_type_id: str | None = None,
    primary_assignee_user_id: str | None = None,
    approver_user_id: str | None = None,
    status: str = "all",
) -> bytes:
    """Build an xlsx of the current workflow table and return its bytes.

    Honours the same filters as list_workflows, ignoring pagination.
    """
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    filt: dict[str, Any] = {
        "organisation_id": user.org_oid,
        "deleted_on": None,
    }
    if category_id:
        filt["category_id"] = try_oid(category_id)
    if request_type_id:
        filt["request_type_id"] = try_oid(request_type_id)
    if primary_assignee_user_id:
        filt["primary_assignee_user_id"] = try_oid(primary_assignee_user_id)
    if status == "active":
        filt["status"] = StatusEnum.ACTIVE
    elif status == "inactive":
        filt["status"] = StatusEnum.INACTIVE

    if not await _apply_q_filter(filt, q, user.org_oid):
        return _empty_workflow_xlsx()

    if approver_user_id:
        matching_approvers = await Approver.find(
            {"approver_user_id": try_oid(approver_user_id), "deleted_on": None}
        ).to_list()
        level_ids = list({a.approval_level_id for a in matching_approvers})
        if not level_ids:
            return _empty_workflow_xlsx()
        levels = await ApprovalLevel.find(
            {"_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        wf_ids = list({l.workflow_id for l in levels})
        if not wf_ids:
            return _empty_workflow_xlsx()
        filt["_id"] = {"$in": wf_ids}

    # Same ordering as the list endpoint: active rows first, then inactive,
    # newest first within each group.
    wfs = await Workflow.find(filt).sort("+status", "-created_on").to_list()
    if not wfs:
        return _empty_workflow_xlsx()

    wf_ids = [w.id for w in wfs]
    cat_ids = list({w.category_id for w in wfs})
    rt_ids = list({w.request_type_id for w in wfs})
    cat_oids = [try_oid(cid) for cid in cat_ids]
    rt_oids = [try_oid(rid) for rid in rt_ids]
    cats = {str(c.id): c for c in await Category.find({"_id": {"$in": cat_oids}}).to_list()}
    rts = {str(r.id): r for r in await RequestType.find({"_id": {"$in": rt_oids}}).to_list()}
    levels = await ApprovalLevel.find(
        {"workflow_id": {"$in": wf_ids}, "deleted_on": None}
    ).to_list()
    levels_by_wf: dict[str, list[ApprovalLevel]] = {}
    for l in levels:
        levels_by_wf.setdefault(l.workflow_id, []).append(l)
    level_ids = [l.id for l in levels]
    approvers = (
        await Approver.find(
            {"approval_level_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        if level_ids
        else []
    )
    approvers_by_wf: dict[str, list[Approver]] = {}
    for a in approvers:
        lvl = next((l for l in levels if str(l.id) == str(a.approval_level_id)), None)
        if lvl:
            approvers_by_wf.setdefault(lvl.workflow_id, []).append(a)
    ec_rows = await EscalationConfig.find(
        {"workflow_id": {"$in": wf_ids}, "deleted_on": None}
    ).to_list()
    ec_by_wf = {ec.workflow_id: ec for ec in ec_rows}

    iam = get_iam_client()
    need_user_ids = {str(w.primary_assignee_user_id) for w in wfs}
    for a in approvers:
        need_user_ids.add(str(a.approver_user_id))
    for ec in ec_rows:
        if ec.escalate_to_user_id:
            need_user_ids.add(str(ec.escalate_to_user_id))
    users = await iam.get_users(list(need_user_ids), access_token=user.access_token)

    if q:
        q_lc = q.lower().strip()

        def _matches(w: Workflow) -> bool:
            cat = cats.get(str(w.category_id))
            rt = rts.get(str(w.request_type_id))
            assignee = user_name(users.get(str(w.primary_assignee_user_id)))
            for needle in (
                cat.name if cat else "",
                rt.name if rt else "",
                assignee or "",
            ):
                if needle and q_lc in needle.lower():
                    return True
            return False

        wfs = [w for w in wfs if _matches(w)]

    wb = Workbook()
    ws = wb.active
    ws.title = "Workflows"
    headers = [
        "Category",
        "Request Type",
        "Primary Assignee",
        "Approval Levels",
        "Approvers Count",
        "First Approver",
        "Escalation",
        "Active for Type",
        "Status",
    ]
    ws.append(headers)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="334155")
    for col_idx, _ in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    for w in wfs:
        cat = cats.get(str(w.category_id))
        rt = rts.get(str(w.request_type_id))
        wf_approvers = approvers_by_wf.get(w.id, [])
        first_name = ""
        if wf_approvers:
            first = sorted(wf_approvers, key=lambda a: a.sort_order)[0]
            first_name = user_name(users.get(str(first.approver_user_id))) or ""
        ec = ec_by_wf.get(w.id)
        esc_summary = ""
        if ec:
            target_name = (
                user_name(users.get(str(ec.escalate_to_user_id) if ec.escalate_to_user_id else ""))
                or ec.escalate_to_user_id
                or ""
            )
            esc_summary = (
                f"After {ec.escalate_after_minutes} min to {target_name}"
                if ec.auto_escalate_enabled
                else "Manual only"
            )
        primary_name = user_name(users.get(str(w.primary_assignee_user_id))) or ""
        ws.append([
            cat.name if cat else "",
            rt.name if rt else "",
            primary_name,
            len(levels_by_wf.get(w.id, [])),
            len(wf_approvers),
            first_name,
            esc_summary,
            "Yes" if w.status == StatusEnum.ACTIVE else "No",
            w.status.value if hasattr(w.status, "value") else str(w.status),
        ])

    widths = [22, 28, 22, 14, 14, 22, 36, 14, 12]
    for col_idx, width in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = width
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _empty_workflow_xlsx() -> bytes:
    from io import BytesIO
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Workflows"
    ws.append([
        "Category",
        "Request Type",
        "Primary Assignee",
        "Approval Levels",
        "Approvers Count",
        "First Approver",
        "Escalation",
        "Active for Type",
        "Status",
    ])
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def delete_workflow(wf_id: str, user: UserBase) -> None:
    wf = await _load_wf(wf_id, user.organisation_id)
    if wf.status == StatusEnum.ACTIVE:
        raise WorkflowActiveCannotDelete()
    # Block when any non-terminal ticket references this workflow.
    in_use = await ServiceRequest.find(
        {
            "workflow_id": wf.id,
            "request_status": {"$nin": [s.value for s in TERMINAL_STATUSES]},
        }
    ).count()
    if in_use > 0:
        raise WorkflowInUse()

    now = utcnow()
    wf.deleted_on = now
    wf.deleted_by = user.id
    wf.status = StatusEnum.INACTIVE
    await wf.save()

    levels = await ApprovalLevel.find(
        {"workflow_id": wf.id, "deleted_on": None}
    ).to_list()
    level_ids = [l.id for l in levels]
    for l in levels:
        l.deleted_on = now
        l.deleted_by = user.id
        await l.save()
    if level_ids:
        approvers = await Approver.find(
            {"approval_level_id": {"$in": level_ids}, "deleted_on": None}
        ).to_list()
        for a in approvers:
            a.deleted_on = now
            a.deleted_by = user.id
            await a.save()
    ec = await EscalationConfig.find_one(
        {"workflow_id": wf.id, "deleted_on": None}
    )
    if ec is not None:
        ec.deleted_on = now
        ec.deleted_by = user.id
        await ec.save()

    try:
        await emit_audit(
            event="workflow.deleted",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(wf.id)},
        )
    except Exception:  # noqa: BLE001
        pass


async def activate_workflow(wf_id: str, user: UserBase) -> dict[str, Any]:
    wf = await _load_wf(wf_id, user.organisation_id)
    now = utcnow()
    # Find the current active workflow (if any) for the same request_type.
    current_active = await Workflow.find_one(
        {
            "request_type_id": wf.request_type_id,
            "status": StatusEnum.ACTIVE,
            "deleted_on": None,
        }
    )

    async def _do() -> Workflow | None:
        deact_id: Workflow | None = None
        if current_active is not None and str(current_active.id) != str(wf.id):
            await current_active.update({"$set": {"status": StatusEnum.INACTIVE, "modified_by": user.id, "modified_on": now}})
            current_active.status = StatusEnum.INACTIVE
            deact_id = current_active
        await wf.update({"$set": {"status": StatusEnum.ACTIVE, "modified_by": user.id, "modified_on": now}})
        wf.status = StatusEnum.ACTIVE
        return deact_id

    deactivated = await _do()

    # Cache active workflow id for the request type.
    try:
        cache = get_valkey()
        await cache.setex(
            workflow_active_cache_key(wf.request_type_id), 300, str(wf.id)
        )
    except Exception:  # noqa: BLE001
        pass

    try:
        await emit_audit(
            event="workflow.activated",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={
                "id": str(wf.id),
                "deactivated_workflow_id": str(deactivated.id) if deactivated else None,
            },
        )
    except Exception:  # noqa: BLE001
        pass
    return {
        "id": str(wf.id),
        "status": StatusEnum.ACTIVE,
        "deactivated_workflow_id": str(deactivated.id) if deactivated else None,
    }


async def deactivate_workflow(wf_id: str, user: UserBase) -> dict[str, Any]:
    wf = await _load_wf(wf_id, user.organisation_id)
    now = utcnow()
    await wf.update({"$set": {"status": StatusEnum.INACTIVE, "modified_by": user.id, "modified_on": now}})
    wf.status = StatusEnum.INACTIVE
    try:
        cache = get_valkey()
        await cache.delete(workflow_active_cache_key(wf.request_type_id))
    except Exception:  # noqa: BLE001
        pass
    try:
        await emit_audit(
            event="workflow.deactivated",
            actor_user_id=user.id,
            organisation_id=user.organisation_id,
            details={"id": str(wf.id)},
        )
    except Exception:  # noqa: BLE001
        pass
    return {"id": str(wf.id), "status": StatusEnum.INACTIVE}


# ---------- Chapter 5: find the active workflow for a request type ----------

async def find_active_workflow(request_type_id: str) -> Workflow | None:
    # Try Valkey first.
    try:
        cache = get_valkey()
        cached = await cache.get(workflow_active_cache_key(request_type_id))
        if cached:
            wf = await Workflow.get(cached)
            if wf and wf.deleted_on is None and wf.status == StatusEnum.ACTIVE:
                return wf
    except Exception:  # noqa: BLE001
        pass
    wf = await Workflow.find_one(
        {
            "request_type_id": try_oid(request_type_id),
            "status": StatusEnum.ACTIVE,
            "deleted_on": None,
        }
    )
    if wf:
        try:
            await get_valkey().setex(
                workflow_active_cache_key(request_type_id), 300, str(wf.id)
            )
        except Exception:  # noqa: BLE001
            pass
    return wf
