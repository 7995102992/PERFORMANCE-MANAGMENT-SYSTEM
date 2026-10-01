"""Centralized asset service — wraps DO Spaces upload + Mongo metadata.

Every file in the system goes through this service. Modules store
the returned ``asset_id`` instead of embedding file details.
"""

from datetime import datetime, timezone
from beanie import PydanticObjectId
from fastapi import HTTPException, UploadFile, status

from src.models import AssetDocument
from src.storage import storage

NOT_DELETED = {"deleted_on": None}

MAX_FILE_SIZE = 2 * 1024 * 1024  # 2 MB

# Logical destinations a caller may upload into (H2/NEW-4). An arbitrary folder
# value is rejected so the storage-key prefix can't be steered off into an
# unexpected path. Keep in sync with the modules that consume /assets.
ALLOWED_FOLDERS = {
    "general",
    "announcements",
    "org-documents",
    "org-logos",
    "employee-photos",
    "profile-photos",
    "announcements",
}

# Filename-extension allow-list (NEW-4): the declared MIME must also match one of
# these on the original filename. Bytes still get the final say in _resolve_type.
ALLOWED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv",
    ".ppt", ".pptx", ".jpg", ".jpeg", ".png", ".txt",
}

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/jpeg",
    "image/png",
    "text/plain",
}

# Magic-byte signatures for the binary allowed types. The client-supplied
# Content-Type is NOT trusted (F-12): a script-bearing SVG sent as image/png
# previously passed. We sniff the real bytes and derive the stored type from
# them. Office (zip/OLE) containers all share a signature — we accept the
# container and trust the client's specific office subtype only within it.
_SIGNATURES: list[tuple[bytes, str]] = [
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
]
_ZIP_MAGIC = b"PK\x03\x04"           # docx / xlsx / pptx
_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # legacy doc / xls / ppt
_OFFICE_TYPES = {
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}
_TEXT_TYPES = {"text/csv", "text/plain"}
# Markup that must never be stored as a servable asset (stored-XSS vector).
_MARKUP_MARKERS = (b"<?xml", b"<svg", b"<html", b"<!doctype html", b"<script")

_EXT_BY_TYPE = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
}


class AssetService:
    def _reject(self, detail: str) -> None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    def _validate_folder(self, folder: str) -> None:
        if folder not in ALLOWED_FOLDERS:
            self._reject(f"Folder '{folder}' is not allowed.")

    def _validate_extension(self, filename: str | None) -> None:
        base = (filename or "").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        ext = ("." + base.rsplit(".", 1)[-1].lower()) if "." in base else ""
        if ext not in ALLOWED_EXTENSIONS:
            self._reject(f"File extension '{ext or '(none)'}' is not allowed.")

    def _contains_markup(self, file_bytes: bytes) -> bool:
        """True if the file contains any markup/script marker ANYWHERE (not just
        in the leading 512 bytes). Used to reject HTML/SVG/script polyglots
        smuggled through the text path."""
        lowered = file_bytes.lower()
        return any(marker in lowered for marker in _MARKUP_MARKERS)

    def _resolve_type(self, file_bytes: bytes, claimed: str) -> str:
        """Validate content by its bytes and return the server-derived MIME type.

        Never trusts the client Content-Type for anything servable. The real type
        is derived from magic bytes over the whole file; markup/script is rejected
        by scanning the entire file (not just the lstripped head). Returns the type
        to store/serve with; raises 400 if the bytes don't match an allowed, safe
        type.
        """
        if len(file_bytes) > MAX_FILE_SIZE:
            self._reject(f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit.")
        if claimed not in ALLOWED_MIME_TYPES:
            self._reject(f"File type '{claimed}' is not allowed.")

        # Binary signatures: the bytes decide the type, not the client. A genuine
        # PDF/PNG/JPEG/office container is served with its true content-type, so
        # incidental markup bytes inside it are inert.
        for magic, mime in _SIGNATURES:
            if file_bytes.startswith(magic):
                return mime
        if file_bytes.startswith((_ZIP_MAGIC, _OLE_MAGIC)):
            if claimed in _OFFICE_TYPES:
                return claimed
            self._reject("Container type does not match the declared file type.")

        # Non-binary path — no trusted signature matched. Any markup/script marker
        # anywhere in the file is a stored-XSS vector; reject outright.
        if self._contains_markup(file_bytes):
            self._reject("File content looks like markup/script and is not allowed.")

        # Text types: must be decodable UTF-8 text (and, above, not markup).
        if claimed in _TEXT_TYPES:
            try:
                file_bytes.decode("utf-8")
            except UnicodeDecodeError:
                self._reject("Declared a text file but content is not valid UTF-8.")
            return claimed

        # Claimed an image/pdf/office type but no matching signature was found.
        self._reject("File content does not match its declared type.")

    async def upload(
        self,
        file: UploadFile,
        folder: str,
        *,
        organisation_id: str | None = None,
        actor_id: str | None = None,
    ) -> AssetDocument:
        # Allow-list the destination folder and the filename extension before we
        # touch storage (H2/NEW-4).
        self._validate_folder(folder)
        self._validate_extension(file.filename)

        file_bytes = await file.read()
        claimed = file.content_type or "application/octet-stream"
        # Server-derived type from the actual bytes — this is what defeats the
        # MIME-spoof bypass. We store/serve with this, never the client value.
        content_type = self._resolve_type(file_bytes, claimed)

        # Normalise the stored name's extension to the resolved type so an
        # attacker can't smuggle a .svg/.html extension onto trusted storage.
        base = (file.filename or "upload").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        stem = base.rsplit(".", 1)[0] if "." in base else base
        safe_name = stem + _EXT_BY_TYPE.get(content_type, "")

        key = storage.generate_key(folder, safe_name)
        file_url = storage.upload(key, file_bytes, content_type)

        asset = AssetDocument(
            file_name=safe_name,
            file_size=len(file_bytes),
            mime_type=content_type,
            storage_key=key,
            file_url=file_url,
            folder=folder,
            organisation_id=organisation_id,
            created_by=actor_id,
            created_on=datetime.now(timezone.utc),
        )
        await asset.insert()
        return asset

    async def get(
        self, asset_id: PydanticObjectId, *, organisation_id: str | None = None
    ) -> AssetDocument | None:
        asset = await AssetDocument.find_one(
            AssetDocument.id == asset_id,
            NOT_DELETED,
        )
        if not asset:
            return None
        # Org scoping (H2): a scoped caller only sees their tenant's assets. A
        # null organisation_id (super admin) skips the check and spans orgs.
        if organisation_id is not None and asset.organisation_id != organisation_id:
            return None
        return asset

    async def soft_delete(self, asset_id: PydanticObjectId) -> bool:
        """Soft delete — marks deleted_on/deleted_by + is_active=False. File stays in DO Spaces."""
        asset = await AssetDocument.find_one(
            AssetDocument.id == asset_id,
            NOT_DELETED,
        )
        if not asset:
            return False
        asset.deleted_on = datetime.now(timezone.utc)
        asset.deleted_by = "system"
        asset.is_active = False
        await asset.save()
        return True

    async def delete(
        self, asset_id: PydanticObjectId, *, organisation_id: str | None = None
    ) -> bool:
        """Hard delete — removes file from DO Spaces + deletes record."""
        asset = await AssetDocument.find_one(
            AssetDocument.id == asset_id,
            NOT_DELETED,
        )
        if not asset:
            return False
        # Org scoping (H2): a scoped caller can only delete their tenant's assets.
        if organisation_id is not None and asset.organisation_id != organisation_id:
            return False
        storage.delete(asset.storage_key)
        await asset.delete()
        return True


asset_service = AssetService()
