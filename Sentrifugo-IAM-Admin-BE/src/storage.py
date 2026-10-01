"""DigitalOcean Spaces storage service (S3-compatible).

Usage:
    from src.storage import storage

    # Upload bytes
    url = storage.upload("org-logos/acme.png", file_bytes, "image/png")

    # Upload FastAPI UploadFile
    url = await storage.upload_file("org-logos/acme.png", upload_file)

    # Get public URL
    url = storage.get_url("org-logos/acme.png")

    # Delete
    storage.delete("org-logos/acme.png")
"""

import mimetypes
from uuid import uuid4

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from fastapi import UploadFile

from src.config import settings
from src.logger import logger


class StorageService:
    def __init__(self) -> None:
        self._client = None

    @property
    def client(self):
        if self._client is None:
            if not all([
                settings.DO_SPACES_ACCESS_KEY,
                settings.DO_SPACES_SECRET_KEY,
                settings.DO_SPACES_ENDPOINT,
                settings.DO_SPACES_BUCKET,
            ]):
                raise RuntimeError(
                    "DigitalOcean Spaces is not configured. "
                    "Set DO_SPACES_ACCESS_KEY, DO_SPACES_SECRET_KEY, "
                    "DO_SPACES_ENDPOINT, DO_SPACES_BUCKET in .env"
                )
            self._client = boto3.client(
                "s3",
                region_name=settings.DO_SPACES_REGION,
                endpoint_url=settings.DO_SPACES_ENDPOINT,
                aws_access_key_id=settings.DO_SPACES_ACCESS_KEY,
                aws_secret_access_key=settings.DO_SPACES_SECRET_KEY,
                config=BotoConfig(signature_version="s3v4"),
            )
        return self._client

    @property
    def bucket(self) -> str:
        return settings.DO_SPACES_BUCKET or ""

    @property
    def cdn_url(self) -> str:
        """Base public URL for the bucket.

        If your endpoint is https://sgp1.digitaloceanspaces.com and
        bucket is 'sentrifugo-assets', the public URL for a key is:
        https://sentrifugo-assets.sgp1.digitaloceanspaces.com/<key>

        If you have a CDN enabled, the URL looks like:
        https://sentrifugo-assets.sgp1.cdn.digitaloceanspaces.com/<key>
        """
        endpoint = settings.DO_SPACES_ENDPOINT or ""
        # https://sgp1.digitaloceanspaces.com → sgp1.digitaloceanspaces.com
        host = endpoint.replace("https://", "").replace("http://", "").rstrip("/")
        return f"https://{self.bucket}.{host}"

    def get_url(self, key: str) -> str:
        return f"{self.cdn_url}/{key}"

    def upload(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        """Upload raw bytes. Returns the public URL."""
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            ACL="public-read",
        )
        url = self.get_url(key)
        logger.info("Uploaded to DO Spaces", key=key, url=url)
        return url

    async def upload_file(self, key: str, file: UploadFile) -> str:
        """Upload a FastAPI UploadFile. Returns the public URL."""
        data = await file.read()
        content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
        return self.upload(key, data, content_type)

    def download(self, key: str) -> bytes:
        """Fetch a file's bytes from the bucket (for authenticated proxying)."""
        obj = self.client.get_object(Bucket=self.bucket, Key=key)
        return obj["Body"].read()

    def delete(self, key: str) -> bool:
        """Delete a file from the bucket. Returns True if deleted."""
        try:
            self.client.delete_object(Bucket=self.bucket, Key=key)
            logger.info("Deleted from DO Spaces", key=key)
            return True
        except ClientError as e:
            logger.error("Failed to delete from DO Spaces", key=key, error=str(e))
            return False

    def generate_key(self, folder: str, filename: str) -> str:
        """Generate a unique key like 'org-logos/abc123_logo.png'."""
        ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
        unique = uuid4().hex[:12]
        return f"{folder}/{unique}_{filename}" if not ext else f"{folder}/{unique}.{ext}"

    def check_connection(self) -> bool:
        """Test that credentials & bucket are valid."""
        try:
            self.client.head_bucket(Bucket=self.bucket)
            return True
        except ClientError:
            return False


storage = StorageService()
