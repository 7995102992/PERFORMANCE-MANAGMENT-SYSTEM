from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..auth.utils.authorization import require_permission
from ..auth.utils.dependencies import UserBase
from . import service
from .schemas import PastSubmissionOverrideCreate, PastSubmissionOverrideOut

router = APIRouter(tags=["past-submissions"])

_MOD = "timesheet_management"
# Gated by the Team Timesheets grant, not manage_projects: reopening is now a
# decision about one employee's late month, taken from the screen where their weeks
# are reviewed, by the manager who approves them.
_MANAGE = require_permission(_MOD, "manage_timesheet")


@router.get(
    "/approvals/employees/{user_id}/past-submission-overrides",
    response_model=list[PastSubmissionOverrideOut],
)
async def list_overrides(
    user_id: str,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> list[PastSubmissionOverrideOut]:
    """Months currently reopened for this employee, by any manager.

    Live grants only — one that has passed its week has closed and is not listed.
    """
    return await service.list_overrides(user_id, user)


@router.post(
    "/approvals/employees/{user_id}/past-submission-overrides",
    status_code=status.HTTP_201_CREATED,
    response_model=PastSubmissionOverrideOut,
)
async def open_month(
    user_id: str,
    body: PastSubmissionOverrideCreate,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> PastSubmissionOverrideOut:
    """Reopen a closed month so this employee can save and submit it again.

    Open for a week, then it closes itself — `expires_at` on the response says when.
    Calling again refreshes the window rather than adding a second grant.

    The exemption covers the caller's own projects only — an employee whose month is
    reopened can refile the time they booked to this manager's work, not anyone
    else's. `project_ids` on the response says exactly which.
    """
    return await service.open_month(user_id, body, user)


@router.delete(
    "/approvals/employees/{user_id}/past-submission-overrides/{year}/{month}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def close_month(
    user_id: str,
    year: int,
    month: int,
    user: Annotated[UserBase, Depends(_MANAGE)],
) -> Response:
    """Close the month again, removing only the caller's own reopen."""
    await service.close_month(user_id, year, month, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
