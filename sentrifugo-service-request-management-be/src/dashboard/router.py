"""Dashboard router — Chapter 4."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..auth.utils.authorization import require_any_permission
from ..auth.utils.dependencies import UserBase
from ..requests.service_list import dashboard_summary

router = APIRouter(tags=["dashboard"])

# Dashboard supports both the personal view (?my_requests=true) and org-wide.
# Anyone with any SR permission can see their personal slice; view_all_requests
# enables the org-wide view.
_READ = require_any_permission(
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


@router.get("/dashboard/summary")
async def summary(
    user: Annotated[UserBase, Depends(_READ)],
    my_requests: bool = Query(False),
) -> dict:
    return await dashboard_summary(user, my_requests=my_requests)
