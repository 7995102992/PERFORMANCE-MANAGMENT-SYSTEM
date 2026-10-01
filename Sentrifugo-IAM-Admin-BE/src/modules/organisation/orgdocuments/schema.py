from datetime import datetime
from typing import Annotated, Optional

import nh3
from beanie import PydanticObjectId
from pydantic import BeforeValidator, Field
from src.models import CustomModel
from src.modules.organisation.models import FolderAccess


def _strip_html(value):
    """Remove ALL HTML tags/attributes from a plain-text field (F-15).

    Folder/document names, titles and descriptions are plain text — never rich
    HTML — so we strip every tag rather than allow-list. This neutralises stored
    XSS payloads (``<img onerror=...>``, ``<script>``, ``<svg>``) at the input
    boundary. Applied as a BeforeValidator so length constraints run on the
    cleaned value; also runs on response schemas, sanitising any pre-existing
    raw data already in the database on read.
    """
    if not isinstance(value, str):
        return value
    return nh3.clean(value, tags=set(), attributes={})


SanitizedStr = Annotated[str, BeforeValidator(_strip_html)]
SanitizedOptStr = Annotated[Optional[str], BeforeValidator(_strip_html)]


# ---------------------------------------------------------------------------
# Folder Schemas
# ---------------------------------------------------------------------------

class FolderCreate(CustomModel):
    organisation_id: Optional[PydanticObjectId] = None
    # None → a main (root) folder. Set → a sub-folder of that main folder.
    # Nesting is capped at one level; access is inherited from the parent.
    parent_id: Optional[PydanticObjectId] = None
    name: SanitizedStr = Field(min_length=1, max_length=100)
    description: SanitizedOptStr = None
    custom_access: bool = False
    access: Optional[FolderAccess] = None


class FolderUpdate(CustomModel):
    name: SanitizedOptStr = Field(None, min_length=1, max_length=100)
    description: SanitizedOptStr = None
    custom_access: Optional[bool] = None
    access: Optional[FolderAccess] = None
    is_active: Optional[bool] = None


class FolderResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId
    parent_id: Optional[PydanticObjectId] = None
    name: str
    description: Optional[str] = None
    custom_access: bool
    access: FolderAccess
    is_active: bool
    # Populated on list responses so the UI can show "3 sub-folders" without
    # a second round-trip. None when not computed.
    subfolder_count: Optional[int] = None


# ---------------------------------------------------------------------------
# Document Schemas
# ---------------------------------------------------------------------------

class BulkFolderCreate(CustomModel):
    """Create multiple folders in one request."""
    organisation_id: Optional[PydanticObjectId] = None
    folders: list['FolderCreateItem'] = Field(min_length=1)


class FolderCreateItem(CustomModel):
    parent_id: Optional[PydanticObjectId] = None
    name: SanitizedStr = Field(min_length=1, max_length=100)
    description: SanitizedOptStr = None
    custom_access: bool = False
    access: Optional[FolderAccess] = None


class DocumentCreate(CustomModel):
    organisation_id: Optional[PydanticObjectId] = None
    # May be a main folder or a sub-folder — files live directly in whichever
    # folder the admin drops them into.
    folder_id: PydanticObjectId
    title: SanitizedStr = Field(min_length=1, max_length=150)
    description: SanitizedOptStr = None
    # Download is opt-in — off unless the admin explicitly enables it
    allow_download: bool = False
    require_acknowledgement: bool = False
    asset_id: PydanticObjectId


class BulkDocumentCreate(CustomModel):
    """Create multiple documents in one request (assets must already be uploaded)."""
    documents: list[DocumentCreate] = Field(min_length=1)


class DocumentUpdate(CustomModel):
    title: SanitizedOptStr = Field(None, min_length=1, max_length=150)
    description: SanitizedOptStr = None
    allow_download: Optional[bool] = None
    require_acknowledgement: Optional[bool] = None
    # Supplying a new asset_id publishes a NEW VERSION — it does not overwrite
    # the current file. The previous version stays viewable in the history and
    # any acknowledgements of it no longer count for the new version.
    asset_id: Optional[PydanticObjectId] = None
    change_note: SanitizedOptStr = Field(None, max_length=500)
    is_active: Optional[bool] = None


class DocumentResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId
    folder_id: PydanticObjectId
    title: str
    description: Optional[str] = None
    allow_download: bool
    require_acknowledgement: bool
    asset_id: PydanticObjectId
    current_version_no: int = 1
    is_active: bool
    # Populated from $lookup
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    file_url: Optional[str] = None
    # When the current revision was published, and why — a version number on
    # its own doesn't tell a reader how recent the file they're seeing is.
    version_updated_at: Optional[datetime] = None
    version_change_note: Optional[str] = None


# ---------------------------------------------------------------------------
# Version Schemas
# ---------------------------------------------------------------------------

class NewVersionRequest(CustomModel):
    """Publish a new revision of an existing document's file."""
    asset_id: PydanticObjectId
    change_note: SanitizedOptStr = Field(None, max_length=500)


class DocumentVersionResponse(CustomModel):
    id: PydanticObjectId
    document_id: PydanticObjectId
    version_no: int
    asset_id: PydanticObjectId
    change_note: Optional[str] = None
    uploaded_by: Optional[str] = None
    uploaded_at: datetime
    is_current: bool = False
    # Populated from $lookup
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    file_url: Optional[str] = None


# ---------------------------------------------------------------------------
# Employee-facing (user portal) Schemas
# ---------------------------------------------------------------------------

class MyDocumentResponse(DocumentResponse):
    """Document as seen by an employee — includes their acknowledgement state.

    `acknowledged` reflects the CURRENT version only. When a new version is
    published, an employee who acknowledged v1 sees acknowledged=False again
    with acknowledged_version_no=1, so the UI can say "re-acknowledgement
    required" rather than "never acknowledged"."""
    acknowledged: bool = False
    acknowledged_at: Optional[datetime] = None
    acknowledged_version_no: Optional[int] = None


class AcknowledgeRequest(CustomModel):
    """The FE sends the browser's current time at the moment of the click;
    the server falls back to its own clock when absent."""
    acknowledged_at: Optional[datetime] = None


class AcknowledgeResponse(CustomModel):
    document_id: PydanticObjectId
    version_no: int
    acknowledged: bool
    acknowledged_at: datetime
