from typing import Annotated, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, File, Query, UploadFile, status

from src.auth.schemas import UserBase
from src.auth.utils.authorization import _grid_level, require_permission_level
from src.auth.utils.dependencies import _extract_token, get_current_user
from src.auth.utils.user_session import (
    _get_role_ranks,
    get_user_session,
    resolve_user_permissions,
)
from src.models import AclRoleEnum
from src.modules.organisation.employees import service
from src.modules.organisation.employees.schema import (
    BulkUploadResult,
    BulkValidateResult,
    EmployeeCreate,
    EmployeePermissionResponse,
    EmployeeResponse,
    EmployeeUpdate,
)

# Every route here is gated on the levelled core_hr:resource_management grant
# (was the blanket create_resource, which still covers the rest of Core HR's
# master data). Reads need viewer, writes need editor, the destructive delete
# needs admin — so a policy can hand HR a read-only employee directory without
# also handing them the edit form.
_VIEW = require_permission_level("core_hr", "resource_management", AclRoleEnum.VIEWER)
_EDIT = require_permission_level("core_hr", "resource_management", AclRoleEnum.EDITOR)
_ADMIN = require_permission_level("core_hr", "resource_management", AclRoleEnum.ADMIN)

# The viewer floor is declared once, on the router, so it cannot be forgotten on
# a route added later — the old per-signature `Depends(_VIEW)` had to be
# remembered every time, and omitting it silently published an employee
# endpoint to anyone logged in. Handlers now take plain `get_current_user`
# purely to know who is calling; they no longer carry the gate themselves.
#
# Writes raise the floor with a `dependencies=[Depends(_EDIT)]` (or `_ADMIN`) on
# the decorator. Both run — viewer then editor — which is redundant but cheap,
# and keeps the stricter level next to the route it protects.
router = APIRouter(
    prefix="/employees",
    tags=["employees"],
    # dependencies=[Depends(_VIEW)],
)


# ---------------------------------------------------------------------------
# Bulk upload endpoints (must come before /{user_id} routes)
# ---------------------------------------------------------------------------

@router.get("/bulk-template", dependencies=[Depends(_EDIT)])
async def download_bulk_template(
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    """Download XLSX template with dropdowns populated from org's data + master data."""
    return await service.download_bulk_template(caller=current_user)


@router.post("/bulk-validate", response_model=BulkValidateResult, dependencies=[Depends(_EDIT)])
async def bulk_validate_employees(
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
):
    """Parse + validate file -> return per-row results (no insert)."""
    return await service.bulk_validate(file, caller=current_user)


@router.post("/bulk-upload", response_model=BulkUploadResult, dependencies=[Depends(_EDIT)])
async def bulk_upload_employees(
    selected_row_nums: str = Query(default="", description="JSON array of row numbers to insert, e.g. [2,3,5]. Empty = all valid rows."),
    file: UploadFile = File(...),
    current_user: Annotated[UserBase, Depends(get_current_user)] = None,
):
    """Insert selected rows from the file."""
    return await service.bulk_upload(file, caller=current_user, selected_row_nums=selected_row_nums)


# ---------------------------------------------------------------------------
# Caller's own access (must come before /{user_id} routes)
# ---------------------------------------------------------------------------

@router.get("/resources", response_model=EmployeePermissionResponse)
async def my_employee_permission(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    access_token: Annotated[str, Depends(_extract_token)],
):
    """What the caller may do on these routes: view, edit, delete.

    Resolves the level the way the guards above it do — admin bypass, then the
    cached session grid, then a Mongo rebuild only on cache miss — rather than
    going straight to Mongo. That ordering is the point: the guards deny off
    the cached session, so a live Mongo read here would advertise a just-granted
    level whose writes still 403 until the token refreshes. Sharing the cache
    means this report and the enforcement flip over at the same moment.

    Inherits the router's _VIEW guard, so reaching it at all already implies
    viewer: `can_view` is true in every 200 response, and an ungranted caller
    gets 403 rather than an all-false body. Right shape for an employees route
    — the FE calls it once already on an HR screen, to decide which controls
    to render.
    """
    if current_user.is_super_admin or current_user.is_org_admin:
        level = AclRoleEnum.ADMIN.value
    else:
        session = await get_user_session(access_token)
        grid = (
            (session.get("permissions") or {})
            if session is not None
            else await resolve_user_permissions(str(current_user.id))
        )
        level = await _grid_level(grid, "core_hr", "resource_management")

    if level is None:
        return EmployeePermissionResponse()

    ranks = await _get_role_ranks()
    held = ranks.get(level, 0)
    return EmployeePermissionResponse(
        granted=True,
        level=level,
        can_view=held >= ranks.get(AclRoleEnum.VIEWER.value, 0),
        can_edit=held >= ranks.get(AclRoleEnum.EDITOR.value, 0),
        can_delete=held >= ranks.get(AclRoleEnum.ADMIN.value, 0),
    )


# ---------------------------------------------------------------------------
# Single-employee CRUD
# ---------------------------------------------------------------------------

@router.post(
    "/",
    response_model=EmployeeResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_EDIT)],
)
async def create_employee(
    data: EmployeeCreate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    return await service.create_employee(data, caller=current_user)


@router.get("/", response_model=list[EmployeeResponse])
async def list_employees(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    business_unit_ids: str | None = Query(default=None, description="Comma-separated BU IDs"),
    department_ids: str | None = Query(default=None, description="Comma-separated Department IDs"),
    designation_ids: str | None = Query(default=None, description="Comma-separated Designation IDs"),
    role_ids: str | None = Query(default=None, description="Comma-separated Role (policy) IDs"),
    employment_status: str | None = None,
    project_status: str | None = None,
    employment_type_id: str | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=1000),
    search: str = Query(default=""),
    has_policies: Optional[bool] = Query(default=None),
):
    bu_ids = [PydanticObjectId(bid.strip()) for bid in business_unit_ids.split(",") if bid.strip()] if business_unit_ids else None
    dept_ids = [PydanticObjectId(did.strip()) for did in department_ids.split(",") if did.strip()] if department_ids else None
    desg_ids = [PydanticObjectId(did.strip()) for did in designation_ids.split(",") if did.strip()] if designation_ids else None
    rl_ids = [PydanticObjectId(rid.strip()) for rid in role_ids.split(",") if rid.strip()] if role_ids else None
    return await service.list_employees(
        caller=current_user,
        business_unit_ids=bu_ids,
        department_ids=dept_ids,
        designation_ids=desg_ids,
        employment_status=employment_status,
        project_status=project_status,
        employment_type_id=employment_type_id,
        skip=skip,
        limit=limit,
        search=search,
        has_policies=has_policies,
        role_ids=rl_ids,
    )


@router.get("/{user_id}", response_model=EmployeeResponse, dependencies=[Depends(_EDIT)])
async def get_employee(
    user_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    return await service.get_employee(user_id, caller=current_user)


@router.put("/{user_id}", response_model=EmployeeResponse, dependencies=[Depends(_EDIT)])
async def update_employee(
    user_id: PydanticObjectId,
    data: EmployeeUpdate,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    return await service.update_employee(user_id, data, caller=current_user)


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(_ADMIN)],
)
async def delete_employee(
    user_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(get_current_user)],
):
    await service.delete_employee(user_id, caller=current_user)
