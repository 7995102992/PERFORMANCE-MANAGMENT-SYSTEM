"""Org Documents service — thin orchestration layer between router and tools."""
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.models import EmployeeDocument
from src.modules.organisation.orgdocuments.schema import (
    AcknowledgeResponse,
    BulkDocumentCreate,
    BulkFolderCreate,
    DocumentCreate,
    DocumentUpdate,
    FolderCreate,
    FolderUpdate,
    NewVersionRequest,
)
from src.modules.organisation.orgdocuments.utils.tools import (
    DocTools,
    FolderTools,
    folder_accessible,
    resolve_access_root,
)
from src.rabbitmq import DebugLevel, outbox

_folder_tools = FolderTools()
_doc_tools = DocTools()


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------

async def create_folder(data: FolderCreate, caller: UserBase):
    org_id = _resolve_org(caller)
    created = await _folder_tools.create(data.model_copy(update={"organisation_id": org_id}))
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="folder_created",
        resource=f"document_folder:{created.id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(org_id),
    )
    return created


async def create_folders_bulk(data: BulkFolderCreate, caller: UserBase):
    org_id = _resolve_org(caller)
    created = await _folder_tools.create_bulk(data.model_copy(update={"organisation_id": org_id}))
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="folders_bulk_created",
        resource=f"organisation:{org_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(org_id),
        metadata={"count": len(created), "folder_ids": [str(f.id) for f in created]},
    )
    return created


async def list_folders(
    caller: UserBase,
    parent_id: Optional[PydanticObjectId] = None,
    all_levels: bool = False,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
):
    org_id = _resolve_org(caller)
    if parent_id is not None:
        # 404/403 early rather than silently returning an empty child list
        await get_folder(parent_id, caller)
    return await _folder_tools.get_all(
        organisation_id=org_id,
        parent_id=parent_id,
        all_levels=all_levels,
        skip=skip,
        limit=limit,
        search=search,
    )


async def get_folder(folder_id: PydanticObjectId, caller: UserBase):
    folder = await _folder_tools.get(folder_id)
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    check_org_access(folder.organisation_id, caller)
    return folder


async def update_folder(folder_id: PydanticObjectId, data: FolderUpdate, caller: UserBase):
    await get_folder(folder_id, caller)
    updated = await _folder_tools.update(folder_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="folder_updated",
        resource=f"document_folder:{folder_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def deactivate_all_documents_in_folder(folder_id: PydanticObjectId, caller: UserBase) -> int:
    await get_folder(folder_id, caller)
    count = await _folder_tools.deactivate_all_documents(folder_id, actor_id=str(caller.id))
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="folder_documents_deactivated",
        resource=f"document_folder:{folder_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={"count": count},
    )
    return count


async def delete_folder(folder_id: PydanticObjectId, caller: UserBase) -> None:
    await get_folder(folder_id, caller)
    await _folder_tools.delete(folder_id, actor_id=str(caller.id))
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="folder_deleted",
        resource=f"document_folder:{folder_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------

async def create_document(data: DocumentCreate, caller: UserBase):
    org_id = _resolve_org(caller)
    created = await _doc_tools.create(data.model_copy(update={"organisation_id": org_id}))
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="document_created",
        resource=f"document:{created.get('id')}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(org_id),
    )
    return created


async def create_documents_bulk(data: BulkDocumentCreate, caller: UserBase):
    org_id = _resolve_org(caller)
    patched = data.model_copy(
        update={"documents": [d.model_copy(update={"organisation_id": org_id}) for d in data.documents]}
    )
    created = await _doc_tools.create_bulk(patched)
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="documents_bulk_created",
        resource=f"organisation:{org_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(org_id),
        metadata={"count": len(created), "document_ids": [d.get("id") for d in created]},
    )
    return created


async def list_documents(
    caller: UserBase,
    folder_id: Optional[PydanticObjectId] = None,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
):
    org_id = _resolve_org(caller)
    return await _doc_tools.get_all(organisation_id=org_id, folder_id=folder_id, skip=skip, limit=limit, search=search)


async def get_document(doc_id: PydanticObjectId, caller: UserBase):
    doc = await _doc_tools.get(doc_id)
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    check_org_access(doc.get("organisation_id") or doc.organisation_id, caller)
    return doc


async def update_document(doc_id: PydanticObjectId, data: DocumentUpdate, caller: UserBase):
    await get_document(doc_id, caller)
    updated = await _doc_tools.update(doc_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="document_updated",
        resource=f"document:{doc_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={"changed_fields": list(data.model_dump(exclude_unset=True).keys())},
    )
    return updated


async def add_document_version(
    doc_id: PydanticObjectId, data: NewVersionRequest, caller: UserBase
):
    """Publish a new revision of a document's file."""
    await get_document(doc_id, caller)
    updated = await _doc_tools.add_version(doc_id, data)
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="document_version_published",
        resource=f"document:{doc_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
        metadata={
            "version_no": updated.get("current_version_no"),
            "change_note": data.change_note,
        },
    )
    return updated


async def list_document_versions(doc_id: PydanticObjectId, caller: UserBase):
    await get_document(doc_id, caller)
    return await _doc_tools.list_versions(doc_id)


async def get_document_version_content(
    doc_id: PydanticObjectId, version_no: int, caller: UserBase
) -> tuple[bytes, str, str]:
    """Admin in-app viewer for a specific (possibly superseded) revision."""
    await get_document(doc_id, caller)
    version = await _doc_tools.get_version(doc_id, version_no)
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")
    return await _asset_bytes(version.asset_id)


async def delete_document(doc_id: PydanticObjectId, caller: UserBase) -> None:
    await get_document(doc_id, caller)
    await _doc_tools.delete(doc_id, actor_id=str(caller.id))
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="document_deleted",
        resource=f"document:{doc_id}",
        debug_level=DebugLevel.ADMIN,
        organisation_id=str(caller.organisation_id) if caller.organisation_id else None,
    )


# ---------------------------------------------------------------------------
# Employee-facing (user portal) — read-only + acknowledgement
# ---------------------------------------------------------------------------

async def _employee_scope(caller: UserBase, org_id: PydanticObjectId) -> Optional[dict]:
    """Access identity used against folder custom-access lists.

    Returns None for org/super admins (unrestricted). For everyone else,
    resolves their employee record's BU / department / worker-type key;
    missing pieces become '' sentinels that match no access list."""
    if caller.is_super_admin or caller.is_org_admin:
        return None
    emp = await EmployeeDocument.find_one({
        "user_id": PydanticObjectId(caller.id),
        "organisation_id": org_id,
        "deleted_on": None,
    })
    worker_type_key = ""
    if emp and emp.employment_type:
        from src.master_data.models import MasterDataDocument
        md = await MasterDataDocument.get(emp.employment_type)
        if md:
            worker_type_key = md.key
    return {
        "business_unit": str(emp.business_unit_id) if emp and emp.business_unit_id else "",
        "department": str(emp.department_id) if emp and emp.department_id else "",
        "worker_type": worker_type_key,
    }


async def list_my_folders(
    caller: UserBase,
    parent_id: Optional[PydanticObjectId] = None,
    skip: int = 0,
    limit: int = 100,
    search: str = "",
):
    """Root folders the employee may see, or the sub-folders of one of them."""
    org_id = _resolve_org(caller)
    if parent_id is not None:
        await _get_accessible_folder(parent_id, caller, org_id)
    scope = await _employee_scope(caller, org_id)
    return await _folder_tools.get_all_accessible(
        organisation_id=org_id,
        scope=scope,
        parent_id=parent_id,
        skip=skip,
        limit=limit,
        search=search,
    )


async def _get_accessible_folder(folder_id: PydanticObjectId, caller: UserBase, org_id: PydanticObjectId):
    folder = await _folder_tools.get(folder_id)
    if not folder or not folder.is_active or folder.organisation_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    scope = await _employee_scope(caller, org_id)
    # Sub-folders inherit access, so the rules of the main folder above them
    # decide — never the sub-folder's own mirrored copy.
    access_root = await resolve_access_root(folder)
    if not access_root.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    if not folder_accessible(access_root, scope):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this folder",
        )
    return folder


async def list_my_documents(
    caller: UserBase,
    folder_id: PydanticObjectId,
    skip: int = 0,
    limit: int = 100,
    search: str = "",
):
    org_id = _resolve_org(caller)
    await _get_accessible_folder(folder_id, caller, org_id)
    return await _doc_tools.get_all_with_ack(
        organisation_id=org_id,
        folder_id=folder_id,
        user_id=PydanticObjectId(caller.id),
        skip=skip,
        limit=limit,
        search=search,
    )


async def _asset_bytes(asset_id) -> tuple[bytes, str, str]:
    """Load an asset's bytes from storage → (data, mime_type, file_name)."""
    from src.models import AssetDocument
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


async def get_document_content(doc_id: PydanticObjectId, caller: UserBase) -> tuple[bytes, str, str]:
    """Admin in-app viewer: stream a document's file through the API.

    JS fetches (pdf.js / csv preview) need CORS — the public bucket URL
    doesn't send CORS headers, this endpoint does."""
    doc = await get_document(doc_id, caller)
    return await _asset_bytes(doc["asset_id"])


async def get_my_document_content(
    doc_id: PydanticObjectId, caller: UserBase
) -> tuple[bytes, str, str]:
    """Employee in-app viewer: same as get_document_content but with the
    employee access rules (active doc, folder BU/dept/worker-type scope)."""
    org_id = _resolve_org(caller)
    doc = await _doc_tools.get(doc_id)
    if not doc or not doc.get("is_active") or doc.get("organisation_id") != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await _get_accessible_folder(doc["folder_id"], caller, org_id)
    return await _asset_bytes(doc["asset_id"])


async def acknowledge_document(
    doc_id: PydanticObjectId,
    caller: UserBase,
    acknowledged_at=None,
) -> AcknowledgeResponse:
    org_id = _resolve_org(caller)
    doc = await _doc_tools.get(doc_id)
    if not doc or not doc.get("is_active") or doc.get("organisation_id") != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await _get_accessible_folder(doc["folder_id"], caller, org_id)
    if not doc.get("require_acknowledgement"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This document does not require acknowledgement",
        )
    # Always ack the version the server currently serves, not one the client
    # names — otherwise a stale tab could sign off a revision it never saw.
    version_no = doc.get("current_version_no") or 1
    ack = await _doc_tools.acknowledge(
        doc_id=doc_id,
        user_id=PydanticObjectId(caller.id),
        organisation_id=org_id,
        version_no=version_no,
        acknowledged_at=acknowledged_at,
    )
    await outbox.publish_audit_log(
        module="orgdocuments",
        actor_id=str(caller.id),
        action="document_acknowledged",
        resource=f"document:{doc_id}",
        debug_level=DebugLevel.EMPLOYEE,
        organisation_id=str(org_id),
        metadata={
            "version_no": ack.version_no,
            "acknowledged_at": ack.acknowledged_at.isoformat(),
        },
    )
    return AcknowledgeResponse(
        document_id=doc_id,
        version_no=ack.version_no,
        acknowledged=ack.acknowledged,
        acknowledged_at=ack.acknowledged_at,
    )
