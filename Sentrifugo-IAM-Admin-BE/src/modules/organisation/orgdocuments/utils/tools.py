import re
from datetime import datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from fastapi import HTTPException, status
from pymongo.errors import DuplicateKeyError
from src.assets import asset_service
from src.models import AssetDocument
from src.modules.organisation.models import (
    DocumentAcknowledgementDocument,
    DocumentFolderDocument,
    FolderAccess,
    OrgDocumentDocument,
    OrgDocumentVersionDocument,
    OrganisationDocument,
)
from src.correlation import audit_create, get_correlation_id, stamp_modified
from src.rabbitmq import outbox
from src.modules.organisation.dependency_check import check_document_folder_dependencies
from src.modules.organisation.orgdocuments.schema import (
    BulkDocumentCreate,
    BulkFolderCreate,
    DocumentCreate,
    DocumentUpdate,
    FolderCreate,
    FolderUpdate,
    NewVersionRequest,
)

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}


# Domain events → consumed by the graph projector (DocumentFolder / OrgDocument
# nodes and their BELONGS_TO / IN_FOLDER edges). Emitted from the tools layer so
# the full typed Document state is available.
async def _emit_folder(event: str, folder: "DocumentFolderDocument") -> None:
    await outbox.publish(
        event,
        {
            "correlation_id": get_correlation_id(),
            "folder_id": str(folder.id),
            "organisation_id": str(folder.organisation_id),
            "parent_id": str(folder.parent_id) if folder.parent_id else None,
            "name": folder.name,
        },
        idempotency_key=f"{event}:{folder.id}:{get_correlation_id()}",
    )


async def _emit_doc(event: str, doc: "OrgDocumentDocument") -> None:
    await outbox.publish(
        event,
        {
            "correlation_id": get_correlation_id(),
            "document_id": str(doc.id),
            "organisation_id": str(doc.organisation_id),
            "folder_id": str(doc.folder_id),
            "title": doc.title,
            "asset_id": str(doc.asset_id),
        },
        idempotency_key=f"{event}:{doc.id}:{get_correlation_id()}",
    )

ALLOWED_ORG_DOC_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
}


async def _soft_delete_doc_assets(doc: "OrgDocumentDocument") -> None:
    """Soft-delete a document's current asset and every historical version's.

    Deleting a document retires its whole history — otherwise superseded
    version files linger in storage forever with nothing referencing them."""
    await asset_service.soft_delete(doc.asset_id)
    versions = await OrgDocumentVersionDocument.find(
        {"document_id": doc.id, **NOT_DELETED}
    ).to_list()
    now = datetime.now(timezone.utc)
    for v in versions:
        if v.asset_id != doc.asset_id:
            await asset_service.soft_delete(v.asset_id)
        v.deleted_on = now
        await v.save()


def employee_access_filter(scope: Optional[dict]) -> dict:
    """Mongo filter granting a folder when custom_access is off, or when the
    employee's BU, department AND worker type all appear in the folder's
    access lists. `scope=None` means unrestricted (org admins)."""
    if scope is None:
        return {}
    return {
        "$or": [
            {"custom_access": False},
            {
                "$and": [
                    {"access.business_units": scope["business_unit"]},
                    {"access.departments": scope["department"]},
                    {"access.worker_types": scope["worker_type"]},
                ]
            },
        ]
    }


def folder_accessible(folder: "DocumentFolderDocument", scope: Optional[dict]) -> bool:
    """Single-folder equivalent of employee_access_filter.

    Only meaningful for main folders — call `resolve_access_root` first so a
    sub-folder is judged by the access rules of the folder it lives under."""
    if scope is None or not folder.custom_access:
        return True
    return (
        scope["business_unit"] in folder.access.business_units
        and scope["department"] in folder.access.departments
        and scope["worker_type"] in folder.access.worker_types
    )


async def resolve_access_root(
    folder: "DocumentFolderDocument",
) -> "DocumentFolderDocument":
    """Return the folder whose access rules govern `folder`.

    Sub-folders inherit access from their parent, so this is the parent for a
    sub-folder and the folder itself for a main folder. Nesting is capped at
    one level, so a single hop is always enough. Falls back to the folder
    itself if the parent has vanished (orphan) — the caller's active/org
    checks then reject it."""
    if folder.parent_id is None:
        return folder
    parent = await DocumentFolderDocument.find_one(
        DocumentFolderDocument.id == folder.parent_id, NOT_DELETED
    )
    return parent or folder


# ---------------------------------------------------------------------------
# Folder Tools
# ---------------------------------------------------------------------------

class FolderTools:
    async def _resolve_parent(
        self, parent_id: Optional[PydanticObjectId], organisation_id: PydanticObjectId
    ) -> Optional[DocumentFolderDocument]:
        """Validate a requested parent folder and return it (None for a root).

        Rejects a parent that is missing, inactive, belongs to another org, or
        is itself a sub-folder — nesting is capped at one level."""
        if parent_id is None:
            return None
        parent = await DocumentFolderDocument.find_one({
            "_id": parent_id,
            "organisation_id": organisation_id,
            **ACTIVE_NOT_DELETED,
        })
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Parent folder not found or inactive.",
            )
        if parent.parent_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Sub-folders cannot be nested further — only one level is supported.",
            )
        return parent

    async def _assert_name_free(
        self,
        organisation_id: PydanticObjectId,
        parent_id: Optional[PydanticObjectId],
        name: str,
        exclude_id: Optional[PydanticObjectId] = None,
    ) -> None:
        """Names are unique within a parent, not across the whole org."""
        filters: dict = {
            "organisation_id": organisation_id,
            "parent_id": parent_id,
            "name": {"$regex": f"^{re.escape(name.strip())}$", "$options": "i"},
            **ACTIVE_NOT_DELETED,
        }
        if exclude_id:
            filters["_id"] = {"$ne": exclude_id}
        if await DocumentFolderDocument.find_one(filters):
            where = "in this folder" if parent_id else "at the top level"
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A folder named '{name.strip()}' already exists {where}.",
            )

    async def _assert_not_clashing_with_relatives(
        self,
        folder_id: Optional[PydanticObjectId],
        parent: Optional[DocumentFolderDocument],
        name: str,
    ) -> None:
        """Reject a name that duplicates the folder's parent or one of its children.

        Uniqueness is per-parent, so "Policies / Policies" is technically legal
        — but a sub-folder sharing its parent's name reads as a mistake and
        makes breadcrumbs ("Policies / Policies") ambiguous. Blocked in both
        directions: a sub-folder taking its parent's name, and a main folder
        being renamed onto one of its own sub-folders' names."""
        clean = name.strip()

        if parent and parent.name.strip().lower() == clean.lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A sub-folder cannot have the same name as its parent folder "
                       f"('{parent.name}'). Choose a different name.",
            )

        # Renaming a main folder onto one of its children is the mirror case.
        if folder_id and parent is None:
            child = await DocumentFolderDocument.find_one({
                "parent_id": folder_id,
                "name": {"$regex": f"^{re.escape(clean)}$", "$options": "i"},
                **ACTIVE_NOT_DELETED,
            })
            if child:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"This folder contains a sub-folder named '{child.name}' — "
                           f"a folder cannot share its name with its own sub-folder.",
                )

    async def create(self, data: FolderCreate) -> DocumentFolderDocument:
        if not await OrganisationDocument.find_one(OrganisationDocument.id == data.organisation_id, ACTIVE_NOT_DELETED):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Organisation not found or inactive.",
            )
        parent = await self._resolve_parent(data.parent_id, data.organisation_id)
        await self._assert_name_free(data.organisation_id, data.parent_id, data.name)
        await self._assert_not_clashing_with_relatives(None, parent, data.name)

        # A sub-folder mirrors its parent's access — the fields are stored so
        # queries stay single-collection, but the parent is the source of truth.
        custom_access = parent.custom_access if parent else data.custom_access
        access = parent.access if parent else (data.access or FolderAccess())

        folder = DocumentFolderDocument(
            organisation_id=data.organisation_id,
            parent_id=data.parent_id,
            name=data.name.strip(),
            description=data.description,
            custom_access=custom_access,
            access=access,
            **audit_create(),
        )
        try:
            await folder.insert()
        except DuplicateKeyError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A folder named '{data.name.strip()}' already exists.",
            )
        await _emit_folder("document_folder.created", folder)
        return folder

    async def get(self, folder_id: PydanticObjectId) -> Optional[DocumentFolderDocument]:
        return await DocumentFolderDocument.find_one(DocumentFolderDocument.id == folder_id, NOT_DELETED)

    async def _with_subfolder_counts(self, folders: List[DocumentFolderDocument]) -> List[dict]:
        """Attach `subfolder_count` to each folder in one grouped query.

        Sub-folders always report 0 — they can't have children."""
        root_ids = [f.id for f in folders if f.parent_id is None]
        counts: dict = {}
        if root_ids:
            rows = await DocumentFolderDocument.aggregate([
                {"$match": {"parent_id": {"$in": root_ids}, **ACTIVE_NOT_DELETED}},
                {"$group": {"_id": "$parent_id", "n": {"$sum": 1}}},
            ]).to_list()
            counts = {r["_id"]: r["n"] for r in rows}
        result = []
        for f in folders:
            data = f.model_dump()
            data["id"] = f.id
            data["subfolder_count"] = counts.get(f.id, 0)
            result.append(data)
        return result

    async def get_all(
        self,
        organisation_id: Optional[PydanticObjectId] = None,
        parent_id: Optional[PydanticObjectId] = None,
        all_levels: bool = False,
        skip: int = 0,
        limit: int = 20,
        search: str = "",
    ) -> List[dict]:
        """Folders for the admin UI.

        By default returns one level: the root folders, or the children of
        `parent_id`. `all_levels=True` ignores the hierarchy and returns a flat
        list — used for search-across-everything."""
        filters: dict = {**NOT_DELETED}
        if organisation_id:
            filters["organisation_id"] = organisation_id
        if not all_levels:
            filters["parent_id"] = parent_id
        if search:
            filters["name"] = {"$regex": re.escape(search), "$options": "i"}
        folders = await DocumentFolderDocument.find(filters).skip(skip).limit(limit).to_list()
        return await self._with_subfolder_counts(folders)

    async def get_all_accessible(
        self,
        organisation_id: PydanticObjectId,
        scope: Optional[dict],
        parent_id: Optional[PydanticObjectId] = None,
        skip: int = 0,
        limit: int = 100,
        search: str = "",
    ) -> List[dict]:
        """Active folders visible to an employee. `scope` is None for
        unrestricted callers (org admins); otherwise a dict with the caller's
        `business_unit` / `department` / `worker_type` identity strings.

        The access filter is only applied when listing root folders. For
        sub-folders the caller has already been checked against the parent
        (see `_get_accessible_folder`), and sub-folders inherit that access —
        re-filtering here would drop children whose mirrored access fields are
        stale relative to the parent."""
        filters: dict = {
            "organisation_id": organisation_id,
            "parent_id": parent_id,
            **ACTIVE_NOT_DELETED,
        }
        if search:
            filters["name"] = {"$regex": re.escape(search), "$options": "i"}
        if parent_id is None:
            access = employee_access_filter(scope)
            if access:
                filters.update(access)
        folders = await DocumentFolderDocument.find(filters).skip(skip).limit(limit).to_list()
        return await self._with_subfolder_counts(folders)

    async def update(
        self, folder_id: PydanticObjectId, data: FolderUpdate
    ) -> Optional[DocumentFolderDocument]:
        folder = await self.get(folder_id)
        if not folder:
            return None
        update_data = data.model_dump(exclude_unset=True)
        is_subfolder = folder.parent_id is not None

        # Access lives on the main folder only; a sub-folder mirrors it.
        if is_subfolder and ("custom_access" in update_data or "access" in update_data):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Sub-folders inherit access from their parent folder — "
                       "edit the parent folder instead.",
            )

        if "is_active" in update_data and update_data["is_active"] is False and folder.is_active is True:
            await check_document_folder_dependencies(folder_id)

        if "name" in update_data and update_data["name"].strip().lower() != folder.name.lower():
            await self._assert_name_free(
                folder.organisation_id, folder.parent_id, update_data["name"], exclude_id=folder_id,
            )
            parent = (
                await DocumentFolderDocument.find_one(
                    DocumentFolderDocument.id == folder.parent_id, NOT_DELETED
                )
                if folder.parent_id
                else None
            )
            await self._assert_not_clashing_with_relatives(
                folder_id, parent, update_data["name"],
            )
        if update_data:
            for key, value in update_data.items():
                setattr(folder, key, value)
            stamp_modified(folder)
            try:
                await folder.save()
            except DuplicateKeyError:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"A folder named '{folder.name}' already exists.",
                )

        if not is_subfolder:
            await self._cascade_to_subfolders(folder, update_data)

        await _emit_folder("document_folder.updated", folder)
        return folder

    async def _cascade_to_subfolders(
        self, parent: DocumentFolderDocument, update_data: dict
    ) -> None:
        """Push a main folder's access / active state down to its sub-folders.

        Access is inherited, so a change at the parent must be mirrored or the
        children's stored copies go stale. Deactivating a parent also hides its
        children — leaving them active would strand them with no reachable
        route in the UI."""
        changes: dict = {}
        if "custom_access" in update_data:
            changes["custom_access"] = parent.custom_access
        if "access" in update_data:
            changes["access"] = parent.access.model_dump()
        if update_data.get("is_active") is False:
            changes["is_active"] = False
        if not changes:
            return
        subs = await DocumentFolderDocument.find(
            {"parent_id": parent.id, **NOT_DELETED}
        ).to_list()
        for sub in subs:
            for key, value in changes.items():
                setattr(sub, key, parent.access if key == "access" else value)
            stamp_modified(sub)
            await sub.save()
            await _emit_folder("document_folder.updated", sub)

    async def create_bulk(self, data: BulkFolderCreate) -> List[DocumentFolderDocument]:
        if not await OrganisationDocument.find_one(OrganisationDocument.id == data.organisation_id, ACTIVE_NOT_DELETED):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Organisation not found or inactive.",
            )
        created = []
        for item in data.folders:
            # A bulk item may target a sub-folder (drag-dropping a nested tree);
            # validate its parent the same way a single create does.
            parent = await self._resolve_parent(item.parent_id, data.organisation_id)
            await self._assert_not_clashing_with_relatives(None, parent, item.name)
            dup_filter = {
                "organisation_id": data.organisation_id,
                "parent_id": item.parent_id,
                "name": {"$regex": f"^{re.escape(item.name.strip())}$", "$options": "i"},
                **ACTIVE_NOT_DELETED,
            }
            existing = await DocumentFolderDocument.find_one(dup_filter)
            if existing:
                created.append(existing)
                continue
            folder = DocumentFolderDocument(
                organisation_id=data.organisation_id,
                parent_id=item.parent_id,
                name=item.name,
                description=item.description,
                custom_access=parent.custom_access if parent else item.custom_access,
                access=parent.access if parent else (item.access or FolderAccess()),
                **audit_create(),
            )
            try:
                await folder.insert()
            except DuplicateKeyError:
                existing = await DocumentFolderDocument.find_one(dup_filter)
                if existing:
                    created.append(existing)
                continue
            await _emit_folder("document_folder.created", folder)
            created.append(folder)
        return created

    async def _folder_and_descendant_ids(self, folder_id: PydanticObjectId) -> List[PydanticObjectId]:
        """The folder plus its sub-folders. One hop covers the whole subtree
        since nesting is capped at a single level."""
        subs = await DocumentFolderDocument.find(
            {"parent_id": folder_id, **NOT_DELETED}
        ).to_list()
        return [folder_id, *[s.id for s in subs]]

    async def deactivate_all_documents(self, folder_id: PydanticObjectId, actor_id: str) -> int:
        """Soft-delete every document in this folder AND its sub-folders."""
        folder_ids = await self._folder_and_descendant_ids(folder_id)
        docs = await OrgDocumentDocument.find(
            {"folder_id": {"$in": folder_ids}, **NOT_DELETED}
        ).to_list()
        now = datetime.now(timezone.utc)
        for doc in docs:
            await _soft_delete_doc_assets(doc)
            doc.is_active = False
            doc.deleted_on = now
            doc.deleted_by = actor_id
            await doc.save()
        return len(docs)

    async def delete(self, folder_id: PydanticObjectId, actor_id: str) -> bool:
        folder = await self.get(folder_id)
        if not folder:
            return False

        # Cascade: soft-delete every doc in this folder and its sub-folders
        # (plus their version assets), then the sub-folders themselves.
        folder_ids = await self._folder_and_descendant_ids(folder_id)
        docs = await OrgDocumentDocument.find(
            {"folder_id": {"$in": folder_ids}, **NOT_DELETED}
        ).to_list()
        now = datetime.now(timezone.utc)
        for doc in docs:
            await _soft_delete_doc_assets(doc)
            doc.deleted_on = now
            doc.deleted_by = actor_id
            doc.is_active = False
            await doc.save()
            await _emit_doc("org_document.deleted", doc)

        for sub_id in folder_ids[1:]:
            sub = await self.get(sub_id)
            if not sub:
                continue
            sub.deleted_on = now
            sub.deleted_by = actor_id
            sub.is_active = False
            await sub.save()
            await _emit_folder("document_folder.deleted", sub)

        folder.deleted_on = now
        folder.deleted_by = actor_id
        folder.is_active = False
        await folder.save()
        await _emit_folder("document_folder.deleted", folder)
        return True


# ---------------------------------------------------------------------------
# Document Tools
# ---------------------------------------------------------------------------

def _asset_lookup_stages() -> list[dict]:
    return [
        {
            "$lookup": {
                "from": "assets",
                "localField": "asset_id",
                "foreignField": "_id",
                "as": "asset",
            }
        },
        {"$unwind": {"path": "$asset", "preserveNullAndEmptyArrays": True}},
        {
            "$addFields": {
                "file_name": "$asset.file_name",
                "file_size": "$asset.file_size",
                "mime_type": "$asset.mime_type",
                "file_url": "$asset.file_url",
            }
        },
        {"$project": {"asset": 0}},
    ]


def _current_version_lookup_stages() -> list[dict]:
    """Join the current revision's publish date + change note onto a document.

    Both the admin and the employee view need to say *when* the file they are
    looking at was published — "v3 · updated 12 Mar 2026" — and a version
    number on its own doesn't tell them that."""
    return [
        {
            "$lookup": {
                "from": "org_document_versions",
                "let": {
                    "doc_id": "$_id",
                    "ver": {"$ifNull": ["$current_version_no", 1]},
                },
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$document_id", "$$doc_id"]},
                                    {"$eq": ["$version_no", "$$ver"]},
                                ]
                            }
                        }
                    },
                    {"$limit": 1},
                ],
                "as": "_ver",
            }
        },
        {"$unwind": {"path": "$_ver", "preserveNullAndEmptyArrays": True}},
        {
            "$addFields": {
                # Falls back to the document's own creation time for rows that
                # pre-date versioning and have no v1 history entry.
                "version_updated_at": {"$ifNull": ["$_ver.uploaded_at", "$created_on"]},
                "version_change_note": "$_ver.change_note",
            }
        },
        {"$project": {"_ver": 0}},
    ]


def _ack_lookup_stages(user_id: PydanticObjectId) -> list[dict]:
    """Join the caller's most recent acknowledgement (if any) onto each document.

    Acks are per-version, so `acknowledged` is true only when the caller's
    latest ack matches the document's current version. Acking v1 and then
    having v2 published flips it back to false — with
    `acknowledged_version_no` still set to 1 so the UI can say "a newer
    version needs your acknowledgement" rather than "not yet acknowledged"."""
    return [
        {
            "$lookup": {
                "from": "org_document_acknowledgements",
                "let": {"doc_id": "$_id"},
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$document_id", "$$doc_id"]},
                                    {"$eq": ["$user_id", user_id]},
                                ]
                            }
                        }
                    },
                    {"$sort": {"version_no": -1}},
                    {"$limit": 1},
                ],
                "as": "_ack",
            }
        },
        {"$unwind": {"path": "$_ack", "preserveNullAndEmptyArrays": True}},
        {
            "$addFields": {
                "acknowledged_version_no": "$_ack.version_no",
                "acknowledged": {
                    "$and": [
                        {"$ifNull": ["$_ack.acknowledged", False]},
                        {
                            "$eq": [
                                {"$ifNull": ["$_ack.version_no", 0]},
                                {"$ifNull": ["$current_version_no", 1]},
                            ]
                        },
                    ]
                },
            }
        },
        # Only surface a timestamp when the ack covers the version on show —
        # a stale v1 timestamp next to v2 would read as "already signed".
        {
            "$addFields": {
                "acknowledged_at": {
                    "$cond": ["$acknowledged", "$_ack.acknowledged_at", None]
                }
            }
        },
        {"$project": {"_ack": 0}},
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    return doc


class DocTools:
    async def _validate_asset_mime(self, asset: AssetDocument) -> None:
        if asset.mime_type not in ALLOWED_ORG_DOC_MIME_TYPES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"File type '{asset.mime_type}' is not allowed for org documents. "
                       f"Accepted: PDF, Word, Excel, CSV.",
            )

    async def _check_duplicate_file(
        self, organisation_id: PydanticObjectId, folder_id: PydanticObjectId,
        asset: AssetDocument, exclude_doc_id: Optional[PydanticObjectId] = None,
    ) -> None:
        doc_filter: dict = {"organisation_id": organisation_id, "folder_id": folder_id, **NOT_DELETED}
        if exclude_doc_id:
            doc_filter["_id"] = {"$ne": exclude_doc_id}
        existing_docs = await OrgDocumentDocument.find(doc_filter).to_list()
        if not existing_docs:
            return
        existing_asset_ids = [d.asset_id for d in existing_docs]
        existing_assets = await AssetDocument.find(
            {"_id": {"$in": existing_asset_ids}, **NOT_DELETED}
        ).to_list()
        for ea in existing_assets:
            if ea.file_name and asset.file_name and ea.file_name.lower() == asset.file_name.lower():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"A file named '{asset.file_name}' already exists in this folder.",
                )

    async def create(self, data: DocumentCreate) -> dict:
        if not await DocumentFolderDocument.find_one(
            DocumentFolderDocument.id == data.folder_id,
            DocumentFolderDocument.organisation_id == data.organisation_id,
            ACTIVE_NOT_DELETED,
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder not found or inactive.",
            )
        asset = await AssetDocument.find_one(AssetDocument.id == data.asset_id, NOT_DELETED)
        if not asset:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Asset not found. Upload the file first via POST /assets/upload.",
            )
        await self._validate_asset_mime(asset)
        await self._check_duplicate_file(data.organisation_id, data.folder_id, asset)

        existing = await OrgDocumentDocument.find_one({
            "organisation_id": data.organisation_id,
            "folder_id": data.folder_id,
            "title": data.title,
            **NOT_DELETED,
        })
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A document titled '{data.title}' already exists in this folder.",
            )

        doc = OrgDocumentDocument(**data.model_dump(), **audit_create())
        await doc.insert()
        await self._record_version(doc, version_no=1, asset_id=doc.asset_id, change_note="Initial version")
        await _emit_doc("org_document.created", doc)
        return await self.get(doc.id)

    async def _record_version(
        self,
        doc: OrgDocumentDocument,
        version_no: int,
        asset_id: PydanticObjectId,
        change_note: Optional[str] = None,
    ) -> OrgDocumentVersionDocument:
        """Append an immutable history row for a document revision."""
        audit = audit_create()
        version = OrgDocumentVersionDocument(
            organisation_id=doc.organisation_id,
            document_id=doc.id,
            version_no=version_no,
            asset_id=asset_id,
            change_note=change_note,
            uploaded_by=audit.get("created_by"),
            uploaded_at=datetime.now(timezone.utc),
            **audit,
        )
        await version.insert()
        return version

    async def add_version(
        self, doc_id: PydanticObjectId, data: NewVersionRequest
    ) -> Optional[dict]:
        """Publish a new revision of a document's file.

        The superseded asset is deliberately NOT soft-deleted — old versions
        stay viewable. Employees who acknowledged the previous version are
        prompted again, since acks are pinned to a version number."""
        doc = await OrgDocumentDocument.find_one(OrgDocumentDocument.id == doc_id, NOT_DELETED)
        if not doc:
            return None
        if data.asset_id == doc.asset_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This file is already the current version.",
            )
        asset = await AssetDocument.find_one(AssetDocument.id == data.asset_id, NOT_DELETED)
        if not asset:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Asset not found. Upload the file first via POST /assets/upload.",
            )
        await self._validate_asset_mime(asset)
        # Another document in the same folder must not already own this filename;
        # the document's own earlier versions are exempt (exclude_doc_id).
        await self._check_duplicate_file(
            doc.organisation_id, doc.folder_id, asset, exclude_doc_id=doc.id,
        )

        next_no = (doc.current_version_no or 1) + 1
        doc.asset_id = data.asset_id
        doc.current_version_no = next_no
        stamp_modified(doc)
        await doc.save()
        await self._record_version(doc, next_no, data.asset_id, data.change_note)
        await _emit_doc("org_document.updated", doc)
        return await self.get(doc_id)

    async def list_versions(self, doc_id: PydanticObjectId) -> List[dict]:
        """Full revision history, newest first, with file metadata joined."""
        doc = await OrgDocumentDocument.find_one(OrgDocumentDocument.id == doc_id, NOT_DELETED)
        current_no = (doc.current_version_no or 1) if doc else None
        pipeline = [
            {"$match": {"document_id": doc_id, **NOT_DELETED}},
            {"$sort": {"version_no": -1}},
            *_asset_lookup_stages(),
        ]
        rows = await OrgDocumentVersionDocument.aggregate(pipeline).to_list()
        results = []
        for row in rows:
            row = _normalize(row)
            row["is_current"] = row["version_no"] == current_no
            results.append(row)
        return results

    async def get_version(
        self, doc_id: PydanticObjectId, version_no: int
    ) -> Optional[OrgDocumentVersionDocument]:
        return await OrgDocumentVersionDocument.find_one(
            {"document_id": doc_id, "version_no": version_no, **NOT_DELETED}
        )

    async def create_bulk(self, data: BulkDocumentCreate) -> List[dict]:
        asset_ids = {d.asset_id for d in data.documents}
        checked_folders: set = set()

        for item in data.documents:
            key = (item.folder_id, item.organisation_id)
            if key not in checked_folders:
                if not await DocumentFolderDocument.find_one(
                    DocumentFolderDocument.id == item.folder_id,
                    DocumentFolderDocument.organisation_id == item.organisation_id,
                    ACTIVE_NOT_DELETED,
                ):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Folder {item.folder_id} not found or inactive.",
                    )
                checked_folders.add(key)

        assets_map: dict[PydanticObjectId, AssetDocument] = {}
        for aid in asset_ids:
            asset = await AssetDocument.find_one(AssetDocument.id == aid, NOT_DELETED)
            if not asset:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Asset {aid} not found. Upload the file first via POST /assets/upload.",
                )
            await self._validate_asset_mime(asset)
            assets_map[aid] = asset

        for item in data.documents:
            asset = assets_map[item.asset_id]
            await self._check_duplicate_file(item.organisation_id, item.folder_id, asset)

        created_ids = []
        for item in data.documents:
            doc = OrgDocumentDocument(**item.model_dump(), **audit_create())
            await doc.insert()
            await self._record_version(doc, version_no=1, asset_id=doc.asset_id, change_note="Initial version")
            await _emit_doc("org_document.created", doc)
            created_ids.append(doc.id)

        pipeline = [
            {"$match": {"_id": {"$in": created_ids}, **NOT_DELETED}},
            *_asset_lookup_stages(),
            *_current_version_lookup_stages(),
        ]
        results = await OrgDocumentDocument.aggregate(pipeline).to_list()
        return [_normalize(d) for d in results]

    async def get(self, doc_id: PydanticObjectId) -> Optional[dict]:
        pipeline = [
            {"$match": {"_id": doc_id, **NOT_DELETED}},
            *_asset_lookup_stages(),
            *_current_version_lookup_stages(),
        ]
        results = await OrgDocumentDocument.aggregate(pipeline).to_list()
        return _normalize(results[0]) if results else None

    async def get_all(
        self,
        organisation_id: Optional[PydanticObjectId] = None,
        folder_id: Optional[PydanticObjectId] = None,
        skip: int = 0,
        limit: int = 20,
        search: str = "",
    ) -> List[dict]:
        match_filter: dict = {**NOT_DELETED}
        if organisation_id:
            match_filter["organisation_id"] = organisation_id
        if folder_id:
            match_filter["folder_id"] = folder_id
        if search:
            match_filter["title"] = {"$regex": re.escape(search), "$options": "i"}
        pipeline: list[dict] = [
            {"$match": match_filter},
            {"$skip": skip},
            {"$limit": limit},
            *_asset_lookup_stages(),
            *_current_version_lookup_stages(),
        ]
        results = await OrgDocumentDocument.aggregate(pipeline).to_list()
        return [_normalize(doc) for doc in results]

    async def get_all_with_ack(
        self,
        organisation_id: PydanticObjectId,
        folder_id: PydanticObjectId,
        user_id: PydanticObjectId,
        skip: int = 0,
        limit: int = 100,
        search: str = "",
    ) -> List[dict]:
        """Active documents in a folder, each carrying the caller's
        acknowledged / acknowledged_at state."""
        match_filter: dict = {
            "organisation_id": organisation_id,
            "folder_id": folder_id,
            **ACTIVE_NOT_DELETED,
        }
        if search:
            match_filter["title"] = {"$regex": re.escape(search), "$options": "i"}
        pipeline: list[dict] = [
            {"$match": match_filter},
            {"$skip": skip},
            {"$limit": limit},
            *_asset_lookup_stages(),
            *_current_version_lookup_stages(),
            *_ack_lookup_stages(user_id),
        ]
        results = await OrgDocumentDocument.aggregate(pipeline).to_list()
        return [_normalize(doc) for doc in results]

    async def acknowledge(
        self,
        doc_id: PydanticObjectId,
        user_id: PydanticObjectId,
        organisation_id: PydanticObjectId,
        version_no: int,
        acknowledged_at: Optional[datetime] = None,
    ) -> DocumentAcknowledgementDocument:
        """Record the caller's acknowledgement of a specific version.

        Idempotent per (document, user, version) — a repeat click returns the
        original record so the first timestamp wins. A *new* version produces a
        new row rather than updating the old one, keeping an audit trail of
        which revision each employee actually accepted.

        `acknowledged_at` is the browser's clock at the moment of the click
        (sent by the FE); server time is the fallback."""
        key = {"document_id": doc_id, "user_id": user_id, "version_no": version_no}
        existing = await DocumentAcknowledgementDocument.find_one(key)
        if existing:
            return existing
        ack = DocumentAcknowledgementDocument(
            organisation_id=organisation_id,
            document_id=doc_id,
            user_id=user_id,
            version_no=version_no,
            acknowledged=True,
            acknowledged_at=acknowledged_at or datetime.now(timezone.utc),
            **audit_create(),
        )
        try:
            await ack.insert()
        except DuplicateKeyError:
            # Concurrent double-click — return the record that won the race.
            existing = await DocumentAcknowledgementDocument.find_one(key)
            if existing:
                return existing
            raise
        return ack

    async def update(
        self, doc_id: PydanticObjectId, data: DocumentUpdate
    ) -> Optional[dict]:
        doc = await OrgDocumentDocument.find_one(OrgDocumentDocument.id == doc_id, NOT_DELETED)
        if not doc:
            return None

        update_data = data.model_dump(exclude_unset=True)

        if "title" in update_data and update_data["title"].lower() != doc.title.lower():
            existing = await OrgDocumentDocument.find_one({
                "organisation_id": doc.organisation_id,
                "folder_id": doc.folder_id,
                "title": update_data["title"],
                "_id": {"$ne": doc_id},
                **NOT_DELETED,
            })
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"A document titled '{update_data['title']}' already exists in this folder.",
                )

        new_asset_id = update_data.pop("asset_id", None)
        change_note = update_data.pop("change_note", None)

        if update_data:
            for key, value in update_data.items():
                setattr(doc, key, value)
            stamp_modified(doc)
            await doc.save()

        # Replacing the file is a version bump, never an in-place overwrite —
        # the old asset stays so history remains viewable, and acknowledgements
        # of the previous version stop counting.
        if new_asset_id and new_asset_id != doc.asset_id:
            return await self.add_version(
                doc_id, NewVersionRequest(asset_id=new_asset_id, change_note=change_note)
            )

        await _emit_doc("org_document.updated", doc)
        return await self.get(doc_id)

    async def delete(self, doc_id: PydanticObjectId, actor_id: str) -> bool:
        doc = await OrgDocumentDocument.find_one(OrgDocumentDocument.id == doc_id, NOT_DELETED)
        if not doc:
            return False
        await _soft_delete_doc_assets(doc)
        doc.deleted_on = datetime.now(timezone.utc)
        doc.deleted_by = actor_id
        doc.is_active = False
        await doc.save()
        await _emit_doc("org_document.deleted", doc)
        return True
