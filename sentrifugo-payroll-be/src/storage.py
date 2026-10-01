"""DigitalOcean Spaces (S3-compatible) object storage.

A lazily-created boto3 S3 client pointed at the configured Spaces endpoint.
boto3 is synchronous, so real network calls (uploads) are offloaded to a
threadpool; presigned-URL generation is pure local signing and stays sync.

Storage is only needed when payslip/document features are used — a missing
configuration raises a clear :class:`DomainException` at call time rather than
hard-failing boot (consistent with the best-effort startup invariant).
"""

from __future__ import annotations

from functools import lru_cache

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import status
from fastapi.concurrency import run_in_threadpool

from src.config import settings
from src.exceptions import DomainException
from src.logger import logger

__all__ = ["upload_bytes", "download_bytes", "presigned_get_url", "delete_object"]


def _storage_error(message: str) -> DomainException:
    return DomainException(message, "STORAGE_ERROR", status.HTTP_502_BAD_GATEWAY)


@lru_cache(maxsize=1)
def _client():
    """Build (once) the S3 client for Spaces. Raises if storage is unconfigured.

    ``lru_cache`` only memoises successful returns, so a misconfiguration raises
    on every call until the settings are fixed — it is never cached.
    """
    missing = [
        name
        for name in ("DO_SPACES_ENDPOINT", "DO_SPACES_BUCKET", "DO_SPACES_ACCESS_KEY", "DO_SPACES_SECRET_KEY")
        if not getattr(settings, name)
    ]
    if missing:
        raise _storage_error(f"Object storage is not configured (missing: {', '.join(missing)})")
    return boto3.client(
        "s3",
        endpoint_url=settings.DO_SPACES_ENDPOINT,
        region_name=settings.DO_SPACES_REGION,
        aws_access_key_id=settings.DO_SPACES_ACCESS_KEY,
        aws_secret_access_key=settings.DO_SPACES_SECRET_KEY,
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def _put_object(key: str, body: bytes, content_type: str) -> None:
    try:
        _client().put_object(
            Bucket=settings.DO_SPACES_BUCKET,
            Key=key,
            Body=body,
            ContentType=content_type,
            ACL="private",
        )
    except (BotoCoreError, ClientError) as exc:
        logger.error("spaces.upload.failed", key=key, error=str(exc))
        raise _storage_error("Failed to upload file to object storage") from exc


async def upload_bytes(key: str, body: bytes, content_type: str) -> str:
    """Upload ``body`` to Spaces under ``key`` (private ACL). Returns the key."""
    await run_in_threadpool(_put_object, key, body, content_type)
    logger.info("spaces.upload.ok", key=key, bytes=len(body))
    return key


def _get_object(key: str) -> bytes:
    try:
        response = _client().get_object(Bucket=settings.DO_SPACES_BUCKET, Key=key)
        return response["Body"].read()
    except (BotoCoreError, ClientError) as exc:
        logger.error("spaces.download.failed", key=key, error=str(exc))
        raise _storage_error("Failed to download file from object storage") from exc


async def download_bytes(key: str) -> bytes:
    """Fetch the raw object bytes for ``key`` from Spaces (still encrypted at rest)."""
    body = await run_in_threadpool(_get_object, key)
    logger.info("spaces.download.ok", key=key, bytes=len(body))
    return body


def presigned_get_url(key: str, expires: int | None = None) -> str:
    """Return a time-limited GET URL for ``key`` (local signing, no network)."""
    try:
        return _client().generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.DO_SPACES_BUCKET, "Key": key},
            ExpiresIn=expires or settings.DO_SPACES_PRESIGN_TTL,
        )
    except (BotoCoreError, ClientError) as exc:
        logger.error("spaces.presign.failed", key=key, error=str(exc))
        raise _storage_error("Failed to generate download URL") from exc


async def delete_object(key: str) -> None:
    """Best-effort delete of an object (used to roll back a failed upload)."""

    def _delete() -> None:
        try:
            _client().delete_object(Bucket=settings.DO_SPACES_BUCKET, Key=key)
        except (BotoCoreError, ClientError) as exc:
            logger.warning("spaces.delete.failed", key=key, error=str(exc))

    await run_in_threadpool(_delete)
