import asyncio
from functools import partial

import boto3
from botocore.config import Config
from bson import ObjectId
from fastapi import UploadFile, status
from motor.motor_asyncio import AsyncIOMotorDatabase

from src.audit import emit_audit
from src.config import settings
from src.dependencies import UserBase, user_is_hr
from src.exceptions import DomainException
from src.logger import logger
from src.models import audit_fields_create
from src.utils import to_oid

COLLECTION = "assets"
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.DO_SPACES_ENDPOINT,
        aws_access_key_id=settings.DO_SPACES_ACCESS_KEY,
        aws_secret_access_key=settings.DO_SPACES_SECRET_KEY,
        region_name=settings.DO_SPACES_REGION,
        config=Config(signature_version="s3v4"),
    )


async def upload_asset(
    db: AsyncIOMotorDatabase,
    file: UploadFile,
    uploaded_by: str,
    organisation_id: str | None = None,
) -> dict:
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise DomainException(
            message=f"Unsupported file type '{file.content_type}'. Allowed: PDF, DOC/DOCX, JPEG, PNG, GIF, WEBP",
            code="INVALID_FILE_TYPE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise DomainException(
            message="File size must not exceed 10 MB",
            code="FILE_TOO_LARGE",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    asset_oid = ObjectId()
    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "bin"
    storage_key = f"assets/{asset_oid}.{ext}"

    s3 = _s3_client()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        partial(
            s3.put_object,
            Bucket=settings.DO_SPACES_BUCKET,
            Key=storage_key,
            Body=data,
            ContentType=file.content_type,
            ACL="private",
        ),
    )

    doc = {
        "_id": asset_oid,
        "original_filename": file.filename,
        "content_type": file.content_type,
        "size": len(data),
        "storage_key": storage_key,
        "organisation_id": organisation_id,
        **audit_fields_create(uploaded_by),
    }
    await db[COLLECTION].insert_one(doc)
    logger.info("Asset uploaded", asset_id=str(asset_oid), filename=file.filename)
    await emit_audit(
        action="asset.created",
        resource=f"asset:{asset_oid}",
        actor_id=uploaded_by,
        organisation_id=organisation_id,
        details={"original_filename": file.filename, "content_type": file.content_type},
    )
    return doc


async def _caller_can_access_asset(
    db: AsyncIOMotorDatabase, asset_doc: dict, current_user: UserBase
) -> bool:
    """Authorize a caller for an attachment.

    Allowed when the caller uploaded it, OR the caller is HR / a manager on a
    leave request (in the caller's own organisation) that references the asset.
    """
    caller_id = str(current_user.user_id)

    # 1. Uploader (self-service).
    created_by = asset_doc.get("created_by")
    if created_by is not None and str(created_by) == caller_id:
        return True

    # Linked leave requests in the caller's organisation only (tenant scoping).
    asset_id_str = str(asset_doc["_id"])
    req_query: dict = {"asset_ids": asset_id_str, "deleted_on": None}
    if current_user.org_id:
        req_query["organisation_id"] = str(current_user.org_id)
    linked = await db["leave_requests"].find(
        req_query, {"user_id": 1}
    ).to_list(length=None)
    if not linked:
        return False

    # 2. HR approver — scoped above to the caller's org.
    if user_is_hr(current_user):
        return True

    # 3. Manager (L1/L2) of the requester on a linked leave request.
    requester_oids = [r["user_id"] for r in linked if r.get("user_id")]
    if not requester_oids:
        return False
    caller_oid = to_oid(caller_id)
    refs = [caller_oid]
    caller_emp = await db["employees"].find_one(
        {"user_id": caller_oid, "is_deleted": {"$ne": True}}, {"_id": 1}
    )
    if caller_emp and caller_emp["_id"] != caller_oid:
        refs.append(caller_emp["_id"])
    match = await db["employees"].find_one(
        {
            "user_id": {"$in": requester_oids},
            "$or": [{"l1_manager_id": {"$in": refs}}, {"l2_manager_id": {"$in": refs}}],
            "is_deleted": {"$ne": True},
        }
    )
    return match is not None


async def get_asset(
    db: AsyncIOMotorDatabase, asset_id: str, current_user: UserBase | None = None
) -> dict:
    doc = await db[COLLECTION].find_one({"_id": ObjectId(asset_id), "deleted_on": None})
    if not doc:
        raise DomainException(
            message="Asset not found",
            code="ASSET_NOT_FOUND",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    if current_user is not None and not await _caller_can_access_asset(db, doc, current_user):
        raise DomainException(
            message="You do not have permission to access this attachment",
            code="FORBIDDEN",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return doc


async def generate_presigned_url(asset_id: str, storage_key: str, expires_in: int = 3600) -> str:
    s3 = _s3_client()
    loop = asyncio.get_event_loop()
    url: str = await loop.run_in_executor(
        None,
        partial(
            s3.generate_presigned_url,
            "get_object",
            Params={"Bucket": settings.DO_SPACES_BUCKET, "Key": storage_key},
            ExpiresIn=expires_in,
        ),
    )
    return url
