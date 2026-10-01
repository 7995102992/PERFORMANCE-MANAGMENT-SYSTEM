"""Requests router — grows through Chapters 4–8."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile, status
from fastapi.responses import StreamingResponse

from ..auth.utils.authorization import require_any_permission, require_permission
from ..auth.utils.dependencies import UserBase
from ..common.pagination import PageParams, page_params
from ..models import PriorityEnum
from .schemas import (
    ApproveBody,
    AssignExecutorBody,
    CloseBody,
    CommentBody,
    EscalateBody,
    InternalNoteBody,
    RaiseRequestBody,
    RejectBody,
    ResolveBody,
    SubmitForApprovalBody,
    WithdrawBody,
)
from .service_notes import (
    add_internal_note,
    get_activity,
    list_internal_notes,
)
from .service_assign import (
    assign_executor,
    escalate,
    list_eligible_escalation_targets,
    list_eligible_executors,
    reassign_executor,
)
from .service_actions import (
    add_comment,
    approve,
    close,
    first_response,
    list_comments,
    list_eligible_l2_approvers,
    reject,
    resolve,
    submit_for_approval,
    trigger_l2_approval,
    withdraw,
)
from .service_create import raise_request
from .service_detail import (
    get_attachment_signed_url,
    get_request_detail,
    stream_attachment_file,
)
from .service_export import stream_export
from .service_list import (
    count_pending_approvals,
    export_approvals_xlsx,
    export_department_requests_xlsx,
    export_my_requests_xlsx,
    list_pending_approvals,
    list_requests,
)

router = APIRouter(tags=["requests"])

# Per-route permission gates. The service layer enforces per-ticket ownership
# (requester / executor / primary_assignee / current_approver) on top of these.
_RAISE = require_permission("service_request", "raise_request")
_EXECUTE = require_permission("service_request", "execute_request")
_APPROVE = require_permission("service_request", "approve_request")
_MANAGE = require_permission("service_request", "manage_request")
_VIEW_ALL = require_permission("service_request", "view_all_requests")

# Any user with a meaningful SR permission can attempt to read a ticket;
# the service layer narrows results to those they have access to.
_READ_ANY = require_any_permission(
    "service_request",
    [
        "raise_request",
        "execute_request",
        "approve_request",
        "manage_request",
        "view_all_requests",
        "manage_catalog",
        "manage_workflows",
    ],
)

# Escalation can be triggered by either an executor or the primary assignee.
_ESCALATE = require_any_permission(
    "service_request",
    ["execute_request", "manage_request"],
)

# Self-assign: dept employees (execute_request) AND managers (manage_request).
# Inner service layer narrows further: dept member OR dept head OR manager ACL.
_SELF_ASSIGN = require_any_permission(
    "service_request",
    ["execute_request", "manage_request"],
)


@router.post("/requests", status_code=status.HTTP_201_CREATED)
async def raise_request_endpoint(
    user: Annotated[UserBase, Depends(_RAISE)],
    # The FE may send either a JSON body OR multipart/form-data with files.
    # We support both: JSON is parsed from the `body` form field if present,
    # otherwise from the request body.
    body_json: Annotated[str | None, Form(alias="body")] = None,
    category_id: Annotated[str | None, Form()] = None,
    request_type_id: Annotated[str | None, Form()] = None,
    title: Annotated[str | None, Form()] = None,
    description: Annotated[str | None, Form()] = None,
    priority: Annotated[PriorityEnum | None, Form()] = None,
    files: Annotated[list[UploadFile] | None, File()] = None,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict:
    if body_json:
        # Multipart clients hand us the JSON as a form field, so a malformed
        # value is client input — 422, not a 500 from an unhandled ValueError.
        from ..exceptions import DomainException
        try:
            payload = json.loads(body_json)
        except ValueError:
            raise DomainException(
                "Malformed JSON in the `body` form field",
                "VALIDATION_ERROR",
                422,
            )
        if not isinstance(payload, dict):
            raise DomainException(
                "The `body` form field must be a JSON object",
                "VALIDATION_ERROR",
                422,
            )
        body = RaiseRequestBody(**payload)
    elif category_id and request_type_id and title and description and priority:
        body = RaiseRequestBody(
            category_id=category_id,
            request_type_id=request_type_id,
            title=title,
            description=description,
            priority=priority,
        )
    else:
        # Last resort — let Pydantic surface a validation error.
        body = RaiseRequestBody(
            category_id=category_id or "",
            request_type_id=request_type_id or "",
            title=title or "",
            description=description or "",
            priority=priority or PriorityEnum.LOW,
        )
    return await raise_request(
        body, files or [], user, idempotency_header=idempotency_key
    )


@router.post("/requests/json", status_code=status.HTTP_201_CREATED)
async def raise_request_json(
    body: RaiseRequestBody,
    user: Annotated[UserBase, Depends(_RAISE)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> dict:
    """JSON-only alternative for clients that don't multipart.
    Attachments must then use the presign flow (not implemented in v1)."""
    return await raise_request(body, [], user, idempotency_header=idempotency_key)


@router.get("/requests/pending-approvals")
async def pending_approvals(
    user: Annotated[UserBase, Depends(_APPROVE)],
    p: Annotated[PageParams, Depends(page_params)],
    scope: str = Query("all", pattern="^(all|awaiting_me|my_team)$"),
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    request_type_id: str | None = Query(None),
    priority: str | None = Query(None),
    status_: str | None = Query(None, alias="status"),
    is_escalated: bool | None = Query(None),
    my_decision: str | None = Query(None, pattern="^(pending|approved|rejected)$"),
    created_from: datetime | None = Query(None),
) -> dict:
    """The caller's approvals queue.

    `scope=awaiting_me` returns only rows actionable right now, paginated on
    its own — without it a manager with a large reporting tree can have
    actionable tickets fall outside the page window, since rows are ordered by
    submitted_on rather than by actionability.
    """
    return await list_pending_approvals(
        user, p,
        scope=scope,
        q=q,
        category_id=category_id,
        request_type_id=request_type_id,
        priority=priority,
        status=status_,
        is_escalated=is_escalated,
        my_decision=my_decision,
        created_from=created_from,
    )


@router.get("/requests/pending-approvals/counts")
async def pending_approvals_counts(
    user: Annotated[UserBase, Depends(_APPROVE)],
) -> dict:
    """Badge totals for the Team Tickets screen — six counts in one call.

    Each value equals the `total` the matching list query would return, so a
    badge never disagrees with the table it opens. Takes no pagination and no
    filter params: the counts describe the queues themselves and stay stable
    while the user narrows the table.
    """
    return await count_pending_approvals(user)


@router.get("/requests/export")
async def export_requests(
    user: Annotated[UserBase, Depends(_VIEW_ALL)],
    format: str = Query("csv", pattern="^(csv|excel)$"),
    date_range: str = Query("current_month"),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
) -> StreamingResponse:
    if format == "excel":
        from fastapi import HTTPException
        raise HTTPException(status_code=501, detail="Excel export not implemented in v1; use format=csv")
    from .service_list import _role_of
    from ..exceptions import ExportForbidden
    if _role_of(user) == "employee":
        raise ExportForbidden()
    filename = f"service_requests_{datetime.utcnow().date().isoformat()}.csv"
    return StreamingResponse(
        stream_export(
            user,
            format_=format,
            date_range=date_range,
            start_date=start_date,
            end_date=end_date,
        ),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/requests/department-export")
async def export_department_requests(
    user: Annotated[UserBase, Depends(_RAISE)],
    q: str | None = Query(None),
    request_type_id: str | None = Query(None),
    priority: str | None = Query(None),
    status_: str | None = Query(None, alias="status"),
    roster_wide: bool = Query(False),
    escalated_away: bool = Query(False),
) -> StreamingResponse:
    """Download the caller's roster tickets as an .xlsx file.

    Same scope rule as GET /requests?for_my_department=true — tickets on the
    categories the caller is rostered on — plus everything they are the
    executor of wherever it lives.

    ``roster_wide=true`` lists every ticket on those categories, whoever holds
    it; this is what both To Execute and Employee Requests display. Omitted,
    the category half stays pinned to the unclaimed pool, so an older caller's
    sheet is unchanged.

    ``escalated_away=true`` adds the tickets the caller escalated to someone
    else — the rows To Execute shows under its Escalated card, which no other
    clause can reach once the executor has been reassigned.
    """
    import io

    xlsx_bytes = await export_department_requests_xlsx(
        user,
        q=q,
        request_type_id=request_type_id,
        priority=priority,
        status=status_,
        roster_wide=roster_wide,
        escalated_away=escalated_away,
    )
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"employee-requests_{stamp}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/requests/approvals-export")
async def export_approvals(
    user: Annotated[UserBase, Depends(_APPROVE)],
    scope: str = Query("all", pattern="^(all|awaiting_me|my_team)$"),
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    request_type_id: str | None = Query(None),
    priority: str | None = Query(None),
    status_: str | None = Query(None, alias="status"),
    is_escalated: bool | None = Query(None),
    my_decision: str | None = Query(None),
    created_from: datetime | None = Query(None),
) -> StreamingResponse:
    """Download the caller's pending-approvals queue as an .xlsx file.

    Same scope as GET /requests/pending-approvals. Honours the Approvals
    page filters; ignores pagination. By default excludes rejected +
    withdrawn tickets to match the page's default view.
    """
    import io

    xlsx_bytes = await export_approvals_xlsx(
        user,
        scope=scope,
        q=q,
        category_id=category_id,
        request_type_id=request_type_id,
        priority=priority,
        status=status_,
        is_escalated=is_escalated,
        my_decision=my_decision,
        created_from=created_from,
    )
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"approvals_{stamp}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/requests/my-export")
async def export_my_requests(
    user: Annotated[UserBase, Depends(_RAISE)],
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    request_type_id: str | None = Query(None),
    priority: str | None = Query(None),
    status_: str | None = Query(None, alias="status"),
) -> StreamingResponse:
    """Download the caller's own service requests as an .xlsx file.

    Same auth surface as raising tickets (anyone with raise_request).
    Honours the My Requests page filters.
    """
    import io

    xlsx_bytes = await export_my_requests_xlsx(
        user,
        q=q,
        category_id=category_id,
        request_type_id=request_type_id,
        priority=priority,
        status=status_,
    )
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"my-service-requests_{stamp}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/requests/{id}")
async def request_detail(id: str, user: Annotated[UserBase, Depends(_READ_ANY)]) -> dict:
    return await get_request_detail(id, user)


@router.get("/requests/{id}/attachments/{aid}")
async def request_attachment_signed(
    id: str, aid: str, user: Annotated[UserBase, Depends(_READ_ANY)]
) -> dict:
    return await get_attachment_signed_url(id, aid, user)


@router.get("/requests/{id}/attachments/{aid}/file")
async def request_attachment_file(
    id: str, aid: str, user: Annotated[UserBase, Depends(_READ_ANY)]
):
    """Stream the attachment bytes for local-backend deployments.

    The S3 backend returns a presigned URL pointing directly at DO Spaces,
    so this route is only hit in local-disk mode. Auth re-checks ticket
    access on every request.
    """
    return await stream_attachment_file(id, aid, user)


@router.post("/requests/{id}/approve")
async def request_approve(
    id: str, body: ApproveBody, user: Annotated[UserBase, Depends(_APPROVE)]
) -> dict:
    return await approve(id, body, user)


@router.post("/requests/{id}/reject")
async def request_reject(
    id: str, body: RejectBody, user: Annotated[UserBase, Depends(_APPROVE)]
) -> dict:
    return await reject(id, body, user)


@router.post("/requests/{id}/first-response")
async def request_first_response(
    id: str, user: Annotated[UserBase, Depends(_EXECUTE)]
) -> dict:
    return await first_response(id, user)


@router.post("/requests/{id}/submit-for-approval")
async def request_submit_for_approval(
    id: str,
    user: Annotated[UserBase, Depends(_EXECUTE)],
    body: SubmitForApprovalBody | None = None,
) -> dict:
    """Executor pushes the assigned ticket into the approval flow.

    State: ASSIGNED|IN_PROGRESS → PENDING_APPROVAL (current_level_index=1).
    Executor only. L1 = requester's L1 manager (required); L2 defaults to the
    requester's L2 manager. Body may carry `level_2_approver_user_id` to
    override L2 with any user holding the leadership policy.
    """
    return await submit_for_approval(id, body, user)


@router.get("/requests/{id}/eligible-l2-approvers")
async def request_eligible_l2_approvers(
    id: str, user: Annotated[UserBase, Depends(_EXECUTE)]
) -> dict:
    """List leadership users the executor can pick as L2 (with the requester's
    default L2 manager prefilled)."""
    return await list_eligible_l2_approvers(id, user)


@router.post("/requests/{id}/trigger-l2-approval")
async def request_trigger_l2_approval(
    id: str,
    user: Annotated[UserBase, Depends(_EXECUTE)],
    body: SubmitForApprovalBody | None = None,
) -> dict:
    """Executor triggers L2 approval after L1 has been approved.

    Body may carry `level_2_approver_user_id` to override the default (the
    requester's L2 manager) with any user holding the leadership policy.
    """
    return await trigger_l2_approval(id, body, user)


@router.post("/requests/{id}/resolve")
async def request_resolve(
    id: str, body: ResolveBody, user: Annotated[UserBase, Depends(_EXECUTE)]
) -> dict:
    return await resolve(id, body, user)


@router.post("/requests/{id}/close")
async def request_close(id: str, body: CloseBody, user: Annotated[UserBase, Depends(_MANAGE)]) -> dict:
    return await close(id, user, closing_remarks=body.closing_remarks)


@router.post("/requests/{id}/withdraw")
async def request_withdraw(
    id: str, body: WithdrawBody, user: Annotated[UserBase, Depends(_RAISE)]
) -> dict:
    """Requester pulls their own ticket back before anyone starts on it.

    Allowed only in SUBMITTED / PENDING_APPROVAL / PENDING_ASSIGNMENT.
    Service layer enforces requester-only (super admin also allowed).
    """
    return await withdraw(id, body, user)


@router.get("/requests/{id}/comments")
async def request_comments(
    id: str, user: Annotated[UserBase, Depends(_READ_ANY)]
) -> dict:
    return await list_comments(id, user)


@router.post("/requests/{id}/comments", status_code=status.HTTP_201_CREATED)
async def request_comment_add(
    id: str, body: CommentBody, user: Annotated[UserBase, Depends(_READ_ANY)]
) -> dict:
    return await add_comment(id, body, user)


# ---------- Chapter 7 ----------

@router.get("/requests/{id}/eligible-executors")
async def eligible_executors(
    id: str, user: Annotated[UserBase, Depends(_SELF_ASSIGN)]
) -> dict:
    # _SELF_ASSIGN = execute_request OR manage_request, so dept heads /
    # managers can fetch the candidate list. Fine-grained primary/manager/
    # dept-head check happens inside list_eligible_executors.
    return await list_eligible_executors(id, user)


@router.get("/requests/{id}/eligible-escalation-targets")
async def eligible_escalation_targets(
    id: str, user: Annotated[UserBase, Depends(_ESCALATE)]
) -> dict:
    return await list_eligible_escalation_targets(id, user)


@router.post("/requests/{id}/assign-executor")
async def request_assign(
    id: str, body: AssignExecutorBody, user: Annotated[UserBase, Depends(_MANAGE)]
) -> dict:
    return await assign_executor(id, body, user)


@router.post("/requests/{id}/self-assign")
async def request_self_assign(
    id: str, user: Annotated[UserBase, Depends(_SELF_ASSIGN)]
) -> dict:
    body = AssignExecutorBody(executor_user_id=user.id)
    return await assign_executor(id, body, user)


@router.post("/requests/{id}/reassign-executor")
async def request_reassign(
    id: str, body: AssignExecutorBody, user: Annotated[UserBase, Depends(_MANAGE)]
) -> dict:
    return await reassign_executor(id, body, user)


@router.post("/requests/{id}/escalate")
async def request_escalate(
    id: str, body: EscalateBody, user: Annotated[UserBase, Depends(_ESCALATE)]
) -> dict:
    return await escalate(id, body, user)


# ---------- Chapter 8 ----------

# Internal notes use _READ_ANY at the door; the service layer authorises by
# ticket relationship (executor / handler) via compute_capabilities, so a
# self-assigned executor without manage_request can still post — and the
# requester is denied even if they hold a manager policy.
@router.get("/requests/{id}/internal-notes")
async def request_internal_notes_list(
    id: str, user: Annotated[UserBase, Depends(_READ_ANY)]
) -> dict:
    return await list_internal_notes(id, user)


@router.post("/requests/{id}/internal-notes", status_code=status.HTTP_201_CREATED)
async def request_internal_note_add(
    id: str,
    body: InternalNoteBody,
    user: Annotated[UserBase, Depends(_READ_ANY)],
) -> dict:
    return await add_internal_note(id, body, user)


@router.get("/requests/{id}/activity")
async def request_activity(
    id: str, user: Annotated[UserBase, Depends(_READ_ANY)]
) -> dict:
    return await get_activity(id, user)


@router.get("/requests")
async def list_requests_endpoint(
    user: Annotated[UserBase, Depends(_READ_ANY)],
    p: Annotated[PageParams, Depends(page_params)],
    q: str | None = Query(None),
    category_id: str | None = Query(None),
    status: str | None = Query(None),
    priority: str | None = Query(None),
    requester_user_id: str | None = Query(None),
    executor_user_id: str | None = Query(None),
    previous_executor_user_id: str | None = Query(None),
    created_from: datetime | None = Query(None),
    created_to: datetime | None = Query(None),
    status_group: str | None = Query(None, pattern="^(open|closed|all)$"),
    resolved_on: str | None = Query(None, pattern="^(today|this_week|this_month)$"),
    request_type_id: str | None = Query(None),
    sort: str | None = Query(
        None, pattern="^(submitted_on_desc|submitted_on_asc|priority_desc|open_first)$"
    ),
    my_requests: bool = Query(False),
    for_my_department: bool = Query(False),
) -> dict:
    """List tickets.

    `sort=open_first` orders open tickets ahead of closed ones, then by
    priority (urgent → low), then newest first — the My Requests / Employee
    Requests ordering. Ranking happens in Mongo before the page slice, so the
    order is global rather than per-page. Default remains `submitted_on_desc`.
    """
    return await list_requests(
        user,
        p,
        q=q,
        category_id=category_id,
        request_type_id=request_type_id,
        sort=sort,
        status=status,
        priority=priority,
        requester_user_id=requester_user_id,
        executor_user_id=executor_user_id,
        previous_executor_user_id=previous_executor_user_id,
        created_from=created_from,
        created_to=created_to,
        status_group=status_group,
        resolved_on=resolved_on,
        my_requests=my_requests,
        for_my_department=for_my_department,
    )
