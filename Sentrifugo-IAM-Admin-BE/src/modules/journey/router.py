"""Employee Journey read API.

The FE sends a list of employee user_ids → we return each one's timeline + the
per-FY metrics, read from IAM's own journey collections.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from src.auth.schemas import UserBase
from src.auth.utils.authorization import caller_has_permission
from src.auth.utils.dependencies import get_current_user
from src.modules.journey.service import enrich_with_user_details, get_journeys, get_team_user_ids

router = APIRouter(prefix="/journey", tags=["journey"])


class JourneyBatchRequest(BaseModel):
    user_ids: list[str] = Field(default_factory=list)


def _org_scope(caller: UserBase) -> str | None:
    # Super admins span orgs; everyone else is scoped to their own org.
    return None if caller.is_super_admin else caller.organisation_id


async def _caller_is_hr(caller: UserBase) -> bool:
    """HR/admins may read anyone's journey. Anyone holding a core_hr
    monitor/approve grant qualifies (super/org admins pass automatically)."""
    return (
        await caller_has_permission(caller, "core_hr", "monitor_exit_request")
        or await caller_has_permission(caller, "core_hr", "approve_exit_request")
    )


async def _authorize_targets(caller: UserBase, target_ids: list[str]) -> None:
    """IDOR guard (M5): a caller may only read their own journey, journeys of
    people in their reporting sub-tree, or — with an HR permission — anyone's.
    Raises 403 if any requested id falls outside that set."""
    caller_id = str(caller.id)
    targets = {str(t) for t in target_ids if t}
    if targets <= {caller_id}:
        return
    if await _caller_is_hr(caller):
        return
    team = set(await get_team_user_ids(caller_id, _org_scope(caller), include_self=True))
    allowed = team | {caller_id}
    if not targets <= allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to view these journeys",
        )


@router.get("/me")
async def my_journey(current_user: Annotated[UserBase, Depends(get_current_user)]):
    """The caller's own journey."""
    journeys = await get_journeys([str(current_user.id)], _org_scope(current_user))
    return journeys.get(str(current_user.id), {"timeline": [], "metrics": []})


@router.post("/batch")
async def batch_journeys(
    body: JourneyBatchRequest,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    """Journeys for a list of employee user_ids (the FE's main entry point)."""
    await _authorize_targets(current_user, body.user_ids)
    return await get_journeys(body.user_ids, _org_scope(current_user))


@router.get("/team")
async def team_journey(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    include_self: bool = False,
    active_only: bool = False,
):
    """Journeys for everyone in the caller's reporting sub-tree (direct +
    indirect reports). For managers / higher management. Pass include_self=true
    to also include the caller's own journey; active_only=true to exclude
    inactive/exited reports (their reports beneath them are still included)."""
    org = _org_scope(current_user)
    team_ids = await get_team_user_ids(
        str(current_user.id), org,
        include_self=include_self, active_only=active_only,
    )
    journeys = await get_journeys(team_ids, org)
    return await enrich_with_user_details(journeys)


@router.get("/{user_id}")
async def one_journey(
    user_id: str,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    """A single employee's journey."""
    await _authorize_targets(current_user, [user_id])
    journeys = await get_journeys([user_id], _org_scope(current_user))
    return journeys.get(user_id, {"timeline": [], "metrics": []})
