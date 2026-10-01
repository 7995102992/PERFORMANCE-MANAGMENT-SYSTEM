"""Announcement Beanie ODM documents."""

from datetime import datetime
from enum import StrEnum
from typing import Optional

from beanie import Document, PydanticObjectId
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from src.models import AuditMixin


class AnnouncementStatusEnum(StrEnum):
    DRAFT = "draft"
    PUBLISHED = "published"


class AnnouncementAttachment(BaseModel):
    """A file already uploaded through /assets/upload, pinned to this
    announcement. Denormalised so listing never needs an assets lookup."""
    asset_id: PydanticObjectId
    file_name: str
    mime_type: str
    size: int


class AnnouncementDocument(Document, AuditMixin):
    """An organisation announcement.

    Audience is the intersection of two allow-lists: an EMPTY list means
    "everyone" for that dimension, so both empty = organisation-wide.

    Only a `published` announcement is visible on the employee surface;
    `posted_date` is stamped at publish time and cleared on unpublish.
    """
    organisation_id: PydanticObjectId
    business_unit_ids: list[PydanticObjectId] = Field(default_factory=list)
    department_ids: list[PydanticObjectId] = Field(default_factory=list)
    title: str
    description: str
    attachments: list[AnnouncementAttachment] = Field(default_factory=list)
    status: AnnouncementStatusEnum = AnnouncementStatusEnum.DRAFT
    posted_date: Optional[datetime] = None
    published_by: Optional[str] = None
    is_active: bool = True

    class Settings:
        name = "announcements"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("status", ASCENDING)]),
            IndexModel([("department_ids", ASCENDING)]),
            IndexModel([("business_unit_ids", ASCENDING)]),
            IndexModel([("posted_date", DESCENDING)]),
        ]
