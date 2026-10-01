"""Announcement endpoints.

  - `/announcements`                  admin CRUD + publish/unpublish.
  - `/announcements/my-announcements` employee feed, audience-scoped server-side.

Literal `/my-announcements` routes are declared before `/{announcement_id}` so
they are not swallowed by the parameterized path.

Two permission codes gate the two surfaces, both under `core_hr`:

  * `manage_announcements` — the admin surface. Announcement authoring is its
    own capability, not a side effect of the blanket `create_resource` grant
    that covers the rest of Core HR master data; adding a department should not
    also let someone publish to the whole organisation.
  * `view_announcements`   — the employee feed. Read-only, and back-filled onto
    every role policy by `scripts.migrate_announcement_permissions`, so it is
    baseline employee content rather than an opt-in.

Org and super admins bypass both checks in `require_permission` itself.
"""

from typing import Annotated, List, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import Response

from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.announcements import service
from src.modules.announcements.models import AnnouncementStatusEnum
from src.modules.announcements.schema import (
    AnnouncementCreate,
    AnnouncementListResponse,
    AnnouncementResponse,
    AnnouncementUpdate,
)

router = APIRouter(prefix="/announcements", tags=["announcements"])


def _file_response(data: bytes, mime: str, file_name: str) -> Response:
    """`inline` so the client can preview in-tab; the FE turns it into a blob
    for both the viewer and the download button."""
    safe_name = file_name.replace('"', "")
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=300",
        },
    )


# ---------------------------------------------------------------------------
# Admin surface
# ---------------------------------------------------------------------------

@router.post("/", response_model=AnnouncementResponse, status_code=status.HTTP_201_CREATED)
async def create_announcement(
    data: AnnouncementCreate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    return await service.create_announcement(data, caller=current_user)


@router.get("/", response_model=AnnouncementListResponse)
async def list_announcements(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    status_filter: Optional[AnnouncementStatusEnum] = Query(default=None, alias="status"),
    department_id: Optional[PydanticObjectId] = Query(default=None),
    business_unit_id: Optional[PydanticObjectId] = Query(default=None),
):
    return await service.list_announcements(
        caller=current_user,
        skip=skip,
        limit=limit,
        search=search,
        status_filter=status_filter,
        department_id=department_id,
        business_unit_id=business_unit_id,
    )


# ---------------------------------------------------------------------------
# Employee surface (core_hr:view_announcements)
# ---------------------------------------------------------------------------

@router.get("/my-announcements/all", response_model=AnnouncementListResponse)
async def list_my_announcements_page(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "view_announcements"))],
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    scope: Optional[str] = Query(default=None, pattern="^(org_wide|targeted)$"),
):
    return await service.list_my_announcements_page(
        caller=current_user, skip=skip, limit=limit, search=search, scope=scope,
    )


@router.get("/my-announcements", response_model=List[AnnouncementResponse])
async def list_my_announcements(
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "view_announcements"))],
    limit: int = Query(default=5, ge=1, le=100),
):
    return await service.list_my_announcements(caller=current_user, limit=limit)


@router.get("/my-announcements/{announcement_id}/attachments/{asset_id}/download")
async def download_my_attachment(
    announcement_id: PydanticObjectId,
    asset_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "view_announcements"))],
):
    """Attachment bytes for the employee viewer (CORS-safe, access-checked)."""
    data, mime, file_name = await service.get_my_attachment_content(
        announcement_id, asset_id, caller=current_user
    )
    return _file_response(data, mime, file_name)


@router.get("/my-announcements/{announcement_id}", response_model=AnnouncementResponse)
async def get_my_announcement(
    announcement_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "view_announcements"))],
):
    return await service.get_my_announcement(announcement_id, caller=current_user)


# ---------------------------------------------------------------------------
# Admin single-item routes (parameterized — declared last)
# ---------------------------------------------------------------------------

@router.get("/{announcement_id}", response_model=AnnouncementResponse)
async def get_announcement(
    announcement_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    return await service.get_announcement(announcement_id, caller=current_user)


@router.get("/{announcement_id}/attachments/{asset_id}/download")
async def download_attachment(
    announcement_id: PydanticObjectId,
    asset_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    """Attachment bytes for the admin viewer (CORS-safe)."""
    data, mime, file_name = await service.get_attachment_content(
        announcement_id, asset_id, caller=current_user
    )
    return _file_response(data, mime, file_name)


@router.patch("/{announcement_id}", response_model=AnnouncementResponse)
async def update_announcement(
    announcement_id: PydanticObjectId,
    data: AnnouncementUpdate,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    return await service.update_announcement(announcement_id, data, caller=current_user)


@router.patch("/{announcement_id}/publish", response_model=AnnouncementResponse)
async def publish_announcement(
    announcement_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    return await service.publish_announcement(announcement_id, caller=current_user)


@router.patch("/{announcement_id}/unpublish", response_model=AnnouncementResponse)
async def unpublish_announcement(
    announcement_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    return await service.unpublish_announcement(announcement_id, caller=current_user)


@router.delete("/{announcement_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_announcement(
    announcement_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "manage_announcements"))],
):
    await service.delete_announcement(announcement_id, caller=current_user)
