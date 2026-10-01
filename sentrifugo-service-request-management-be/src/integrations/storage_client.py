"""Object-storage adapter for service-request attachments.

Two backends switched via ``settings.STORAGE_BACKEND``:

- ``local``  — writes to the path configured by ``STORAGE_LOCAL_DIR``.
               Default; useful for dev without external infra.
- ``s3``     — DigitalOcean Spaces (S3-compatible via boto3). Requires
               ``DO_SPACES_*`` settings. Returns presigned URLs on read
               so the access model matches IAM Admin's asset service.

Public API is intentionally narrow:
    put_upload_file(key_prefix, file) -> (storage_key, size_bytes)
    delete(storage_key) -> None
    signed_download_url(storage_key, *, expires_seconds=300) -> str

Callers stay backend-agnostic.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import UploadFile

from ..config import settings

if TYPE_CHECKING:  # pragma: no cover
    pass

logger = logging.getLogger(__name__)


# ─── Backend selection ────────────────────────────────────────────────────────

def _is_s3_backend() -> bool:
    return (settings.STORAGE_BACKEND or "").lower() == "s3"


# ─── S3 / DO Spaces helpers ───────────────────────────────────────────────────

_s3_client = None


def _get_s3_client():
    """Lazy-initialised boto3 S3 client. Reused across requests."""
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "boto3 is required when STORAGE_BACKEND=s3. "
            "Install it: pip install boto3"
        ) from exc

    required = [
        settings.DO_SPACES_ACCESS_KEY,
        settings.DO_SPACES_SECRET_KEY,
        settings.DO_SPACES_ENDPOINT,
        settings.DO_SPACES_BUCKET,
    ]
    if not all(required):
        raise RuntimeError(
            "DigitalOcean Spaces is not configured. Set DO_SPACES_ACCESS_KEY, "
            "DO_SPACES_SECRET_KEY, DO_SPACES_ENDPOINT, DO_SPACES_BUCKET in .env."
        )

    _s3_client = boto3.client(
        "s3",
        region_name=settings.DO_SPACES_REGION,
        endpoint_url=settings.DO_SPACES_ENDPOINT,
        aws_access_key_id=settings.DO_SPACES_ACCESS_KEY,
        aws_secret_access_key=settings.DO_SPACES_SECRET_KEY,
        config=BotoConfig(signature_version="s3v4"),
    )
    return _s3_client


def _s3_object_key(storage_key: str) -> str:
    """Prefix every key with the configured SRM folder so SRM uploads
    live under a single namespace inside the shared bucket."""
    prefix = (settings.DO_SPACES_FOLDER or "").strip("/")
    cleaned = storage_key.lstrip("/")
    return f"{prefix}/{cleaned}" if prefix else cleaned


# ─── Local-disk helpers ───────────────────────────────────────────────────────

_STORAGE_DIR = Path(settings.STORAGE_LOCAL_DIR).resolve()
_STORAGE_DIR.mkdir(parents=True, exist_ok=True)


def _key_to_path(storage_key: str) -> Path:
    return _STORAGE_DIR / storage_key.lstrip("/")


def local_path_for_key(storage_key: str) -> Path:
    """Public helper — returns the on-disk path for a storage key.

    Only useful in local-backend mode. The download endpoint uses this to
    serve the bytes via FileResponse after re-authorising the caller.
    """
    return _key_to_path(storage_key)


class _AIOFile:
    def __init__(self, path: Path, mode: str) -> None:
        self._path = path
        self._mode = mode
        self._fh = None

    async def __aenter__(self):
        loop = asyncio.get_running_loop()
        self._fh = await loop.run_in_executor(
            None, lambda: open(self._path, self._mode)
        )
        return self._fh

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._fh is not None:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._fh.close)


def _aio_open(path: Path) -> _AIOFile:
    return _AIOFile(path, "wb")


# ─── Public API ───────────────────────────────────────────────────────────────

async def put_upload_file(key_prefix: str, file: UploadFile) -> tuple[str, int]:
    """Persist an UploadFile and return (storage_key, size_bytes).

    The returned ``storage_key`` is backend-agnostic — callers don't need to
    know whether it lives on disk or in Spaces. For Spaces uploads the
    object's bucket-key is ``DO_SPACES_FOLDER/<storage_key>``; that prefix
    is added internally so multiple services can share a bucket.
    """
    suffix = Path(file.filename or "upload").suffix
    token = secrets.token_urlsafe(16)
    storage_key = f"{key_prefix}/{token}{suffix}"

    await file.seek(0)
    file_bytes = await file.read()
    size = len(file_bytes)

    if _is_s3_backend():
        client = _get_s3_client()
        content_type = file.content_type or "application/octet-stream"
        # Service-request attachments are sensitive — keep them private and
        # use presigned URLs for downloads (unlike IAM Admin's public-read).
        try:
            client.put_object(
                Bucket=settings.DO_SPACES_BUCKET,
                Key=_s3_object_key(storage_key),
                Body=file_bytes,
                ContentType=content_type,
                ACL="private",
            )
            logger.info(
                "storage.put.s3 key=%s size=%d", storage_key, size,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("storage.put.s3.failed key=%s err=%s", storage_key, e)
            raise
        return storage_key, size

    # Local backend.
    target = _key_to_path(storage_key)
    target.parent.mkdir(parents=True, exist_ok=True)
    async with _aio_open(target) as sink:
        sink.write(file_bytes)
    return storage_key, size


async def delete(storage_key: str) -> None:
    if _is_s3_backend():
        try:
            client = _get_s3_client()
            client.delete_object(
                Bucket=settings.DO_SPACES_BUCKET,
                Key=_s3_object_key(storage_key),
            )
            logger.info("storage.delete.s3 key=%s", storage_key)
        except Exception as e:  # noqa: BLE001
            logger.warning("storage.delete.s3.failed key=%s err=%s", storage_key, e)
        return

    target = _key_to_path(storage_key)
    if target.exists():
        try:
            target.unlink()
        except OSError as e:
            logger.warning("storage.delete.local.failed key=%s err=%s", storage_key, e)


async def signed_download_url(
    storage_key: str, *, expires_seconds: int | None = None,
) -> str:
    """Return a short-lived URL the FE can hit to download the file.

    - S3 backend: real boto3 presigned URL (no extra round-trip needed).
    - Local backend: relative path to SRM's own ``/_internal/download``
      endpoint — that endpoint re-authorises via ``require_ticket_access``
      and streams the bytes.
    """
    ttl = expires_seconds or settings.DO_SPACES_PRESIGN_TTL
    if _is_s3_backend():
        client = _get_s3_client()
        try:
            return client.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": settings.DO_SPACES_BUCKET,
                    "Key": _s3_object_key(storage_key),
                },
                ExpiresIn=ttl,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("storage.presign.failed key=%s err=%s", storage_key, e)
            raise

    # Local backend stub — same shape as before so existing callers keep working.
    token = secrets.token_urlsafe(24)
    return (
        f"/api/v1/service-requests/_internal/download"
        f"?key={storage_key}&t={token}&ttl={ttl}"
    )


# ─── Validation constants kept for service_create.py compatibility ────────────

ALLOWED_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
}

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_ATTACHMENTS_PER_TICKET = 10
