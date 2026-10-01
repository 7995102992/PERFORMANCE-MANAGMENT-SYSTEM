"""Internal job endpoints — invoked by the Schedule Service (Foundation §14).

Auth: `X-Internal-Token` header only, validated by `require_internal_token`.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..audit import emit_audit
from ..requests.action_tokens import purge_expired_tokens
from ..requests.service_sla_tick import rebuild_sla_cursor, run_sla_tick
from .auth import require_internal_token

router = APIRouter(prefix="/_internal/jobs", tags=["internal-jobs"])


@router.post("/sla-tick")
async def sla_tick(_: Annotated[None, Depends(require_internal_token)]) -> dict:
    summary = await run_sla_tick()
    try:
        await emit_audit(
            event="sla.tick_run",
            actor_user_id=None,  # internal job → system actor
            organisation_id=None,
            details={"summary": summary},
        )
    except Exception:  # noqa: BLE001 — audit must never break the job
        pass
    return summary


@router.post("/rebuild-sla-cursor")
async def rebuild_sla_cursor_endpoint(
    _: Annotated[None, Depends(require_internal_token)],
) -> dict:
    summary = await rebuild_sla_cursor()
    try:
        await emit_audit(
            event="sla.cursor_rebuilt",
            actor_user_id=None,  # internal job → system actor
            organisation_id=None,
            details={"summary": summary},
        )
    except Exception:  # noqa: BLE001 — audit must never break the job
        pass
    return summary


@router.post("/purge-action-tokens")
async def purge_action_tokens_endpoint(
    _: Annotated[None, Depends(require_internal_token)],
    retention_days: int = 30,
) -> dict:
    """Sweep spent/expired act-from-email tokens.

    Low-frequency housekeeping — daily is ample. Idempotent, so a missed run
    costs nothing but a slightly larger collection.
    """
    summary = await purge_expired_tokens(retention_days)
    try:
        await emit_audit(
            event="action_token.purged",
            actor_user_id=None,  # internal job → system actor
            organisation_id=None,
            details={"summary": summary},
        )
    except Exception:  # noqa: BLE001 — audit must never break the job
        pass
    return summary
