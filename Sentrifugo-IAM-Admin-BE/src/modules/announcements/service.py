"""Announcements service.

Two surfaces:
  - admin      → full CRUD + publish/unpublish over the caller's organisation.
  - employee   → read-only feed, scoped server-side from the caller's own
                 employee record (business unit / department). The client never
                 sends its own targeting.
"""

import re
from datetime import datetime, timezone
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.correlation import audit_create, get_correlation_id, stamp_modified
from src.models import AssetDocument
from src.modules.announcements.models import (
    AnnouncementAttachment,
    AnnouncementDocument,
    AnnouncementStatusEnum,
)
from src.modules.announcements.schema import (
    AnnouncementCreate,
    AnnouncementListResponse,
    AnnouncementResponse,
    AnnouncementUpdate,
)
from src.modules.organisation.models import (
    BusinessUnitDocument,
    DepartmentDocument,
    EmployeeDocument,
)
from src.rabbitmq import DebugLevel, outbox

NOT_DELETED = {"deleted_on": None}


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


def _search_filter(search: str) -> dict:
    pattern = re.escape(search.strip())
    return {
        "$or": [
            {"title": {"$regex": pattern, "$options": "i"}},
            {"description": {"$regex": pattern, "$options": "i"}},
        ]
    }


async def _validate_targets(
    org_id: PydanticObjectId,
    business_unit_ids: list[PydanticObjectId],
    department_ids: list[PydanticObjectId],
) -> None:
    """Reject an audience that is not addressable.

    Two checks:

    1. Every id belongs to the caller's organisation — otherwise a tampered
       payload could address another tenant's audience.
    2. When BOTH lists are given, each department must sit under at least one of
       the selected business units. Targeting is an AND of the two lists against
       the employee's own BU and department, so "North + a department that only
       exists in South" matches nobody: it publishes successfully and reaches
       zero people, with nothing on screen to say so. That pairing is a mistake,
       not a choice, so it is refused at the boundary.

    A department carrying no ``business_units`` is treated as unscoped and
    allowed under any unit — consistent with the empty-means-everything rule the
    rest of the module follows, and it keeps older rows addressable.
    """
    unique_bus = set(business_unit_ids)
    unique_depts = set(department_ids)

    if unique_bus:
        found = await BusinessUnitDocument.find(
            {"_id": {"$in": list(unique_bus)}, "organisation_id": org_id, **NOT_DELETED}
        ).count()
        if found != len(unique_bus):
            raise HTTPException(status_code=400, detail="One or more business units are invalid")

    if unique_depts:
        departments = await DepartmentDocument.find(
            {"_id": {"$in": list(unique_depts)}, "organisation_id": org_id, **NOT_DELETED}
        ).to_list()
        if len(departments) != len(unique_depts):
            raise HTTPException(status_code=400, detail="One or more departments are invalid")

        if unique_bus:
            unreachable = [
                dept.department_name
                for dept in departments
                if (set(dept.business_units) | {dept.primary_business_unit}) - {None}
                and not (
                    set(dept.business_units) & unique_bus
                    or dept.primary_business_unit in unique_bus
                )
            ]
            if unreachable:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "These departments are not in the selected business units: "
                        + ", ".join(sorted(unreachable))
                    ),
                )


async def _validate_attachments(attachments: list) -> list[AnnouncementAttachment]:
    if not attachments:
        return []
    asset_ids = [a.asset_id for a in attachments]
    found = await AssetDocument.find({"_id": {"$in": asset_ids}, **NOT_DELETED}).count()
    if found != len(set(asset_ids)):
        raise HTTPException(status_code=400, detail="One or more attachments are invalid")
    return [AnnouncementAttachment(**a.model_dump()) for a in attachments]


async def _to_response(docs: list[AnnouncementDocument]) -> list[AnnouncementResponse]:
    """Batch-resolve business unit / department names for a page of rows.

    The name lookups are constrained to the organisation(s) the announcements
    themselves belong to. `_validate_targets` rejects foreign ids on write, but
    it is a write-side check only: a row stored before it existed — or by any
    path that bypasses it — would otherwise have that BU / department's name
    read back out of another tenant, a cross-tenant read outside the boundary
    the rest of the module enforces. Ids that resolve to nothing simply
    contribute no name, so `*_names` may be shorter than the matching `*_ids`.
    """
    bu_ids = {bu for d in docs for bu in d.business_unit_ids}
    dept_ids = {dp for d in docs for dp in d.department_ids}
    org_ids = {d.organisation_id for d in docs}
    org_clause = {"organisation_id": {"$in": list(org_ids)}}

    bu_names: dict[PydanticObjectId, str] = {}
    dept_names: dict[PydanticObjectId, str] = {}
    if bu_ids:
        async for bu in BusinessUnitDocument.find({"_id": {"$in": list(bu_ids)}, **org_clause}):
            bu_names[bu.id] = bu.business_unit_name
    if dept_ids:
        async for dp in DepartmentDocument.find({"_id": {"$in": list(dept_ids)}, **org_clause}):
            dept_names[dp.id] = dp.department_name

    return [
        AnnouncementResponse(
            id=d.id,
            organisation_id=d.organisation_id,
            business_unit_ids=d.business_unit_ids,
            business_unit_names=[bu_names[b] for b in d.business_unit_ids if b in bu_names],
            department_ids=d.department_ids,
            department_names=[dept_names[p] for p in d.department_ids if p in dept_names],
            title=d.title,
            description=d.description,
            attachments=[a.model_dump() for a in d.attachments],
            status=d.status,
            posted_date=d.posted_date,
            published_by=d.published_by,
            created_by=d.created_by or "",
            created_on=d.created_on,
            updated_on=d.modified_on,
            is_active=d.is_active,
        )
        for d in docs
    ]


async def _attachment_bytes(
    doc: AnnouncementDocument, asset_id: PydanticObjectId
) -> tuple[bytes, str, str]:
    """Stream an attachment through the API rather than the public bucket URL —
    the bucket sends no CORS headers and the file must stay access-checked."""
    if not any(a.asset_id == asset_id for a in doc.attachments):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    asset = await AssetDocument.get(asset_id)
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    from src.storage import storage
    try:
        data = storage.download(asset.storage_key)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not fetch the file from storage",
        )
    return data, asset.mime_type, asset.file_name


async def _get_doc(announcement_id: PydanticObjectId, caller: UserBase) -> AnnouncementDocument:
    """Load a live announcement belonging to the caller's organisation.

    The organisation is part of the *query*, not a check applied to a row that
    has already been loaded. Two things follow, both deliberate:

      * A cross-tenant id is indistinguishable from an unknown one — 404, never
        403. A 403 confirms the row exists, which is the disclosure the tenancy
        contract exists to prevent (see tests/test_tenancy.py).
      * Super admins get no implicit cross-org read here. They carry no
        `organisation_id`, so `_resolve_org` rejects them the same way it does
        on create and list, rather than silently granting every tenant's
        announcements.

    Raises:
        HTTPException: 404 when the id is unknown, soft-deleted, or owned by
            another organisation.
    """
    org_id = _resolve_org(caller)
    doc = await AnnouncementDocument.find_one(
        {"_id": announcement_id, "organisation_id": org_id, **NOT_DELETED}
    )
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Announcement not found")
    return doc


async def _audit(action: str, announcement_id, caller: UserBase, **metadata) -> None:
    await outbox.publish_audit_log(
        module="announcements",
        actor_id=str(caller.id),
        action=action,
        resource=f"announcement:{announcement_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata=metadata or None,
    )


# ---------------------------------------------------------------------------
# Admin surface
# ---------------------------------------------------------------------------

async def create_announcement(data: AnnouncementCreate, caller: UserBase) -> AnnouncementResponse:
    org_id = _resolve_org(caller)
    await _validate_targets(org_id, data.business_unit_ids, data.department_ids)
    attachments = await _validate_attachments(data.attachments)

    doc = AnnouncementDocument(
        organisation_id=org_id,
        business_unit_ids=data.business_unit_ids,
        department_ids=data.department_ids,
        title=data.title,
        description=data.description,
        attachments=attachments,
        status=AnnouncementStatusEnum.DRAFT,
        correlation_id=get_correlation_id(),
        **audit_create(),
    )
    await doc.insert()
    await _audit("announcement_created", doc.id, caller)
    return (await _to_response([doc]))[0]


async def list_announcements(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    status_filter: Optional[AnnouncementStatusEnum] = None,
    department_id: Optional[PydanticObjectId] = None,
    business_unit_id: Optional[PydanticObjectId] = None,
) -> AnnouncementListResponse:
    org_id = _resolve_org(caller)
    query: dict = {"organisation_id": org_id, **NOT_DELETED}
    if search.strip():
        query.update(_search_filter(search))
    if status_filter:
        query["status"] = status_filter.value
    # Explicit targeting only — an org-wide announcement (empty list) is not a
    # match for "announcements for department X".
    if department_id:
        query["department_ids"] = department_id
    if business_unit_id:
        query["business_unit_ids"] = business_unit_id

    total = await AnnouncementDocument.find(query).count()
    docs = (
        await AnnouncementDocument.find(query)
        .sort("-created_on", "-_id")
        .skip(skip)
        .limit(limit)
        .to_list()
    )
    return AnnouncementListResponse(items=await _to_response(docs), total=total)


async def get_announcement(announcement_id: PydanticObjectId, caller: UserBase) -> AnnouncementResponse:
    doc = await _get_doc(announcement_id, caller)
    return (await _to_response([doc]))[0]


async def update_announcement(
    announcement_id: PydanticObjectId, data: AnnouncementUpdate, caller: UserBase
) -> AnnouncementResponse:
    doc = await _get_doc(announcement_id, caller)
    if doc.status == AnnouncementStatusEnum.PUBLISHED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A published announcement cannot be edited. Unpublish it first.",
        )

    changes = data.model_dump(exclude_unset=True)
    if not changes:
        return (await _to_response([doc]))[0]

    if "business_unit_ids" in changes or "department_ids" in changes:
        await _validate_targets(
            doc.organisation_id,
            changes.get("business_unit_ids", doc.business_unit_ids) or [],
            changes.get("department_ids", doc.department_ids) or [],
        )
    if "attachments" in changes:
        doc.attachments = await _validate_attachments(data.attachments or [])

    for field in ("title", "description", "business_unit_ids", "department_ids"):
        if field in changes and changes[field] is not None:
            setattr(doc, field, changes[field])

    stamp_modified(doc)
    await doc.save()
    await _audit("announcement_updated", doc.id, caller, changed_fields=list(changes.keys()))
    return (await _to_response([doc]))[0]


async def publish_announcement(announcement_id: PydanticObjectId, caller: UserBase) -> AnnouncementResponse:
    doc = await _get_doc(announcement_id, caller)
    if doc.status != AnnouncementStatusEnum.PUBLISHED:
        doc.status = AnnouncementStatusEnum.PUBLISHED
        doc.posted_date = datetime.now(timezone.utc)
        doc.published_by = str(caller.id)
        stamp_modified(doc)
        await doc.save()
        await _audit("announcement_published", doc.id, caller)
    return (await _to_response([doc]))[0]


async def unpublish_announcement(announcement_id: PydanticObjectId, caller: UserBase) -> AnnouncementResponse:
    doc = await _get_doc(announcement_id, caller)
    if doc.status != AnnouncementStatusEnum.DRAFT:
        doc.status = AnnouncementStatusEnum.DRAFT
        doc.posted_date = None
        doc.published_by = None
        stamp_modified(doc)
        await doc.save()
        await _audit("announcement_unpublished", doc.id, caller)
    return (await _to_response([doc]))[0]


async def get_attachment_content(
    announcement_id: PydanticObjectId, asset_id: PydanticObjectId, caller: UserBase
) -> tuple[bytes, str, str]:
    doc = await _get_doc(announcement_id, caller)
    return await _attachment_bytes(doc, asset_id)


async def delete_announcement(announcement_id: PydanticObjectId, caller: UserBase) -> None:
    doc = await _get_doc(announcement_id, caller)
    doc.deleted_by = str(caller.id)
    doc.deleted_on = datetime.now(timezone.utc)
    doc.is_active = False
    await doc.save()
    await _audit("announcement_deleted", doc.id, caller)


# ---------------------------------------------------------------------------
# Employee surface — visibility resolved from the caller's own employee record
# ---------------------------------------------------------------------------

async def _audience_query(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    emp = await EmployeeDocument.find_one(
        EmployeeDocument.organisation_id == org_id,
        EmployeeDocument.user_id == PydanticObjectId(caller.id),
        NOT_DELETED,
    )
    bu_id = emp.business_unit_id if emp else None
    dept_id = emp.department_id if emp else None

    # An empty allow-list means "everyone" for that dimension; a non-empty one
    # must contain the caller's own unit. A user with no employee record only
    # ever sees organisation-wide announcements.
    return {
        "organisation_id": org_id,
        "status": AnnouncementStatusEnum.PUBLISHED.value,
        "is_active": True,
        **NOT_DELETED,
        "$and": [
            {"$or": [{"business_unit_ids": {"$size": 0}}] + ([{"business_unit_ids": bu_id}] if bu_id else [])},
            {"$or": [{"department_ids": {"$size": 0}}] + ([{"department_ids": dept_id}] if dept_id else [])},
        ],
    }


async def list_my_announcements(caller: UserBase, limit: int = 5) -> list[AnnouncementResponse]:
    query = await _audience_query(caller)
    docs = (
        await AnnouncementDocument.find(query)
        .sort("-posted_date", "-_id")
        .limit(limit)
        .to_list()
    )
    return await _to_response(docs)


async def list_my_announcements_page(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    scope: Optional[str] = None,
) -> AnnouncementListResponse:
    query = await _audience_query(caller)
    if search.strip():
        query.update(_search_filter(search))
    if scope == "org_wide":
        query["business_unit_ids"] = {"$size": 0}
        query["department_ids"] = {"$size": 0}
    elif scope == "targeted":
        query["$and"] = query["$and"] + [
            {"$or": [
                {"business_unit_ids": {"$not": {"$size": 0}}},
                {"department_ids": {"$not": {"$size": 0}}},
            ]}
        ]

    total = await AnnouncementDocument.find(query).count()
    docs = (
        await AnnouncementDocument.find(query)
        .sort("-posted_date", "-_id")
        .skip(skip)
        .limit(limit)
        .to_list()
    )
    return AnnouncementListResponse(items=await _to_response(docs), total=total)


async def _get_my_doc(announcement_id: PydanticObjectId, caller: UserBase) -> AnnouncementDocument:
    query = await _audience_query(caller)
    query["_id"] = announcement_id
    doc = await AnnouncementDocument.find_one(query)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Announcement not found")
    return doc


async def get_my_announcement(announcement_id: PydanticObjectId, caller: UserBase) -> AnnouncementResponse:
    return (await _to_response([await _get_my_doc(announcement_id, caller)]))[0]


async def get_my_attachment_content(
    announcement_id: PydanticObjectId, asset_id: PydanticObjectId, caller: UserBase
) -> tuple[bytes, str, str]:
    doc = await _get_my_doc(announcement_id, caller)
    return await _attachment_bytes(doc, asset_id)
