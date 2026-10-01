"""Departments proxy router — forwards to IAM's /departments/ endpoints."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..auth.utils.authorization import require_any_permission
from ..auth.utils.dependencies import UserBase
from ..integrations.iam_client import get_iam_client

router = APIRouter(tags=["departments"])

# Departments are referenced when raising a request, when configuring catalog,
# and when assigning. Any SR-bearing user needs to read them.
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


@router.get("/departments")
async def list_departments(
    user: Annotated[UserBase, Depends(_READ)],
    organisation_id: str | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(""),
) -> list:
    iam = get_iam_client()
    org_id: str | None = None
    if user.is_super_admin:
        org_id = organisation_id or user.organisation_id or None
        if not org_id:
            from ..exceptions import DomainException
            raise DomainException(
                "Super admin must specify organisation_id query parameter",
                "MISSING_ORG_ID",
                400,
            )
    return await iam.list_departments(
        access_token=user.access_token,
        organisation_id=org_id,
        skip=skip,
        limit=limit,
        search=search,
    )


@router.get("/departments/{id}")
async def get_department(
    id: str,
    user: Annotated[UserBase, Depends(_READ)],
) -> dict:
    iam = get_iam_client()
    dept = await iam.get_department(id, access_token=user.access_token)
    if dept is None:
        from ..exceptions import DomainException
        raise DomainException("Department not found", "DEPARTMENT_NOT_FOUND", 404)
    return dept
