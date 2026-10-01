"""Employees proxy router — forwards to IAM's /employees/ endpoints."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..auth.utils.authorization import require_any_permission
from ..auth.utils.dependencies import UserBase
from ..common.iam_helpers import try_oid
from ..integrations.iam_client import get_iam_client
from ..models import Category

router = APIRouter(tags=["employees"])

# Grants that legitimately browse other departments' directories: catalog and
# workflow configuration (approver / primary-assignee pickers) and the
# reassignment / all-requests views. A caller holding none of these is pinned
# to the departments they can actually be filing against.
_CROSS_DEPARTMENT_ACTIONS = (
    "manage_request",
    "manage_catalog",
    "manage_workflows",
    "view_all_requests",
)

# Employee lookups feed approver/executor pickers (catalog + workflow config),
# the reassignment UI (manage_request), AND the optional "assign to" picker on
# Raise New Request — which is why raise_request is included. department_id is
# mandatory and validated per caller (see _resolve_department_scope), so a
# requester only sees the department tied to the category they're filing
# against — never the whole organisation.
_READ = require_any_permission(
    "service_request",
    [
        "raise_request",
        "manage_request",
        "manage_catalog",
        "manage_workflows",
        "view_all_requests",
    ],
)


async def _may_read_department(user: UserBase, department_id: str) -> bool:
    """Whether this caller may page one department's directory."""
    if user.is_super_admin or user.is_org_admin:
        return True
    if any(
        user.has_permission("service_request", action)
        for action in _CROSS_DEPARTMENT_ACTIONS
    ):
        return True
    if user.department_id and department_id == str(user.department_id):
        return True
    # A requester still needs the executor picker for the department that
    # handles the category they're filing against, so allow departments owning a
    # category this caller can actually see (same visibility clause the catalog
    # list uses) — nothing else.
    if user.org_oid is not None:
        from ..categories.service import _visibility_clause

        _dept = try_oid(department_id)
        serving = await Category.find_one(
            {
                "organisation_id": user.org_oid,
                # A category is staffed by a list of departments; the scalar is
                # the deprecated mirror still present on un-migrated documents.
                "$or": [{"department_ids": _dept}, {"department_id": _dept}],
                "deleted_on": None,
                **_visibility_clause(user),
            }
        )
        if serving is not None:
            return True
    return False


async def _resolve_department_scope(
    user: UserBase, department_id: str | None, department_ids: str | None = None
) -> str:
    """Return the comma-separated department ids this caller may read, or raise.

    At least one department is mandatory — an omitted value used to page the
    entire organisation directory (plus the manager chain) for anyone holding
    raise_request. Admins and holders of a cross-department grant may name any
    department; everyone else is limited to their own department or a department
    that owns a catalog category (the executor / "assign to" pickers).

    Every id is checked with the rule that applied to the single one, and **one
    failure fails the whole request**: silently dropping a department the caller
    may not read would return a short list that looks like a complete one.
    """
    from ..exceptions import DomainException, Forbidden

    raw = department_ids or department_id or ""
    ids: list[str] = []
    for part in raw.split(","):
        part = part.strip()
        if part and part not in ids:
            ids.append(part)
    if not ids:
        raise DomainException(
            "department_id or department_ids query parameter is required",
            "MISSING_DEPARTMENT_ID",
            400,
        )
    for did in ids:
        if not await _may_read_department(user, did):
            raise Forbidden("Caller cannot read this department's employees")
    return ",".join(ids)


@router.get("/employees")
async def list_employees(
    user: Annotated[UserBase, Depends(_READ)],
    organisation_id: str | None = Query(None),
    department_id: str | None = Query(None),
    # Comma-separated. IAM's own endpoint already speaks the plural form, so
    # this is a pass-through once every id has been scope-checked.
    department_ids: str | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: str = Query(""),
    has_policies: bool | None = Query(None),
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
    scoped_department_id = await _resolve_department_scope(
        user, department_id, department_ids
    )
    return await iam.list_employees(
        access_token=user.access_token,
        organisation_id=org_id,
        department_id=scoped_department_id,
        skip=skip,
        limit=limit,
        search=search,
        has_policies=has_policies,
    )


@router.get("/employees/{id}")
async def get_employee(
    id: str,
    user: Annotated[UserBase, Depends(_READ)],
) -> dict:
    iam = get_iam_client()
    emp = await iam.get_employee(id, access_token=user.access_token)
    if emp is None:
        from ..exceptions import DomainException
        raise DomainException("Employee not found", "EMPLOYEE_NOT_FOUND", 404)
    return emp
