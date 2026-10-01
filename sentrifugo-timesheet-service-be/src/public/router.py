from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..approvals.schemas import ApprovalAction, RejectionAction
from ..approvals.service import approve_timesheet, reject_timesheet
from ..audit import emit_activity
from ..auth.utils.dependencies import UserBase
from ..common.timestamps import utcnow
from ..models import ClientApprovalToken

router = APIRouter(tags=["public"])


class TokenApproveBody(BaseModel):
    token: str
    comments: str | None = None


class TokenRejectBody(BaseModel):
    token: str
    comments: str


class TokenBulkApproveBody(BaseModel):
    token: str
    comments: str | None = None


class TokenBulkRejectBody(BaseModel):
    token: str
    comments: str


async def _validate_token(token_str: str, timesheet_id: str) -> ClientApprovalToken:
    from beanie import PydanticObjectId
    from bson import ObjectId
    now = utcnow().replace(tzinfo=None)
    ts_oid = PydanticObjectId(timesheet_id) if ObjectId.is_valid(timesheet_id) else timesheet_id
    tok = await ClientApprovalToken.find_one({
        "token": token_str,
        "timesheet_id": ts_oid,
        "is_bulk": False,
        "used_at": None,
    })
    if not tok:
        raise HTTPException(400, detail={"code": "INVALID_TOKEN", "detail": "Invalid or already used approval link"})
    if tok.expires_at.replace(tzinfo=None) < now:
        raise HTTPException(400, detail={"code": "TOKEN_EXPIRED", "detail": "This approval link has expired"})
    return tok


async def _validate_bulk_token(token_str: str) -> ClientApprovalToken:
    now = utcnow().replace(tzinfo=None)
    tok = await ClientApprovalToken.find_one({
        "token": token_str,
        "is_bulk": True,
        "used_at": None,
    })
    if not tok:
        raise HTTPException(400, detail={"code": "INVALID_TOKEN", "detail": "Invalid or already used approval link"})
    if tok.expires_at.replace(tzinfo=None) < now:
        raise HTTPException(400, detail={"code": "TOKEN_EXPIRED", "detail": "This approval link has expired"})
    return tok


@router.post("/public/timesheets/{timesheet_id}/client-approve")
async def public_client_approve(timesheet_id: str, body: TokenApproveBody) -> dict:
    tok = await _validate_token(body.token, timesheet_id)
    user = UserBase(id=tok.approver_id, organisation_id=tok.organisation_id)
    result = await approve_timesheet(timesheet_id, ApprovalAction(comments=body.comments), user, role="client")
    tok.used_at = utcnow()
    tok.used_action = "approved"
    await tok.save()
    await emit_activity(
        action="timesheet.client_approved",
        resource=f"timesheet:{timesheet_id}",
        actor_id=tok.approver_email or "client",
        organisation_id=str(tok.organisation_id) if tok.organisation_id else None,
        details={"comments": body.comments, "approver_id": str(tok.approver_id)},
    )
    return {"status": "approved", **result}


@router.post("/public/timesheets/{timesheet_id}/client-reject")
async def public_client_reject(timesheet_id: str, body: TokenRejectBody) -> dict:
    tok = await _validate_token(body.token, timesheet_id)
    user = UserBase(id=tok.approver_id, organisation_id=tok.organisation_id)
    result = await reject_timesheet(timesheet_id, RejectionAction(comments=body.comments), user, role="client")
    tok.used_at = utcnow()
    tok.used_action = "rejected"
    await tok.save()
    await emit_activity(
        action="timesheet.client_rejected",
        resource=f"timesheet:{timesheet_id}",
        actor_id=tok.approver_email or "client",
        organisation_id=str(tok.organisation_id) if tok.organisation_id else None,
        details={"comments": body.comments, "approver_id": str(tok.approver_id)},
    )
    return {"status": "rejected", **result}


@router.post("/public/client-bulk-approve")
async def public_client_bulk_approve(body: TokenBulkApproveBody) -> dict:
    tok = await _validate_bulk_token(body.token)
    user = UserBase(id=tok.approver_id, organisation_id=tok.organisation_id)
    results = []
    for ts_id in tok.timesheet_ids:
        ts_id_str = str(ts_id)
        try:
            await approve_timesheet(ts_id_str, ApprovalAction(comments=body.comments), user, role="client")
            await emit_activity(
                action="timesheet.client_approved",
                resource=f"timesheet:{ts_id_str}",
                actor_id=tok.approver_email or "client",
                organisation_id=str(tok.organisation_id) if tok.organisation_id else None,
                details={"comments": body.comments, "approver_id": str(tok.approver_id), "bulk": True},
            )
            results.append({"timesheet_id": ts_id_str, "status": "approved"})
        except Exception as exc:
            results.append({"timesheet_id": ts_id_str, "status": "skipped", "reason": str(exc)})
    tok.used_at = utcnow()
    tok.used_action = "approved"
    await tok.save()
    return {"status": "completed", "results": results}


@router.post("/public/client-bulk-reject")
async def public_client_bulk_reject(body: TokenBulkRejectBody) -> dict:
    tok = await _validate_bulk_token(body.token)
    user = UserBase(id=tok.approver_id, organisation_id=tok.organisation_id)
    results = []
    for ts_id in tok.timesheet_ids:
        ts_id_str = str(ts_id)
        try:
            await reject_timesheet(ts_id_str, RejectionAction(comments=body.comments), user, role="client")
            await emit_activity(
                action="timesheet.client_rejected",
                resource=f"timesheet:{ts_id_str}",
                actor_id=tok.approver_email or "client",
                organisation_id=str(tok.organisation_id) if tok.organisation_id else None,
                details={"comments": body.comments, "approver_id": str(tok.approver_id), "bulk": True},
            )
            results.append({"timesheet_id": ts_id_str, "status": "rejected"})
        except Exception as exc:
            results.append({"timesheet_id": ts_id_str, "status": "skipped", "reason": str(exc)})
    tok.used_at = utcnow()
    tok.used_action = "rejected"
    await tok.save()
    return {"status": "completed", "results": results}
