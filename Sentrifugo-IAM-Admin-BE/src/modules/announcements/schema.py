from datetime import datetime
from typing import Annotated, Optional

import nh3
from beanie import PydanticObjectId
from pydantic import BeforeValidator, Field

from src.models import CustomModel
from src.modules.announcements.models import AnnouncementStatusEnum


def _strip_html(value):
    """Titles and file names are rendered as plain text by the client, so
    strip every tag rather than allow-list — this neutralises stored XSS at the
    input boundary and also sanitises pre-existing rows on read."""
    if not isinstance(value, str):
        return value
    return nh3.clean(value, tags=set(), attributes={})


SanitizedStr = Annotated[str, BeforeValidator(_strip_html)]
SanitizedOptStr = Annotated[Optional[str], BeforeValidator(_strip_html)]

# Exactly the markup the FE's RichTextEditor can produce (and its RichText
# renderer allows): inline marks, links, paragraphs and lists. Anything else —
# scripts, images, event handlers, styles — is stripped, so stored XSS is
# still neutralised at the input boundary.
_RICH_TEXT_TAGS = {
    "b", "strong", "i", "em", "u", "s", "strike",
    "a", "br", "span", "p", "ul", "ol", "li",
}
# `rel` is deliberately absent — nh3 owns it (link_rel) and stamps
# "noopener noreferrer" on every link itself.
_RICH_TEXT_ATTRIBUTES = {"a": {"href", "target"}}

# The client counts the 5000-character limit on the visible text, not the
# markup, so the server does the same — plus a hard cap on the markup itself
# so formatting overhead can't balloon a stored row.
DESCRIPTION_TEXT_MAX = 5000
DESCRIPTION_HTML_MAX = 20000


def _sanitize_rich_text(value):
    """Descriptions are rich text: keep the allow-listed markup, strip the
    rest, and enforce the length rules on the text a reader actually sees."""
    if not isinstance(value, str):
        return value
    cleaned = nh3.clean(value, tags=_RICH_TEXT_TAGS, attributes=_RICH_TEXT_ATTRIBUTES)
    if len(cleaned) > DESCRIPTION_HTML_MAX:
        raise ValueError(
            f"Description markup must be {DESCRIPTION_HTML_MAX} characters or fewer"
        )
    plain = nh3.clean(cleaned, tags=set(), attributes={}).strip()
    if not plain:
        raise ValueError("Description is required")
    if len(plain) > DESCRIPTION_TEXT_MAX:
        raise ValueError(
            f"Description must be {DESCRIPTION_TEXT_MAX} characters or fewer"
        )
    return cleaned


RichTextStr = Annotated[str, BeforeValidator(_sanitize_rich_text)]
RichTextOptStr = Annotated[Optional[str], BeforeValidator(_sanitize_rich_text)]


class AttachmentPayload(CustomModel):
    asset_id: PydanticObjectId
    file_name: SanitizedStr = Field(min_length=1, max_length=255)
    mime_type: str = Field(max_length=255)
    size: int = Field(ge=0)


class AnnouncementCreate(CustomModel):
    title: SanitizedStr = Field(min_length=1, max_length=200)
    # Length rules live in the validator — measured on the visible text.
    description: RichTextStr
    # Empty list = every business unit / the whole organisation.
    business_unit_ids: list[PydanticObjectId] = Field(default_factory=list)
    department_ids: list[PydanticObjectId] = Field(default_factory=list)
    attachments: list[AttachmentPayload] = Field(default_factory=list)


class AnnouncementUpdate(CustomModel):
    title: SanitizedOptStr = Field(None, min_length=1, max_length=200)
    description: RichTextOptStr = None
    business_unit_ids: Optional[list[PydanticObjectId]] = None
    department_ids: Optional[list[PydanticObjectId]] = None
    attachments: Optional[list[AttachmentPayload]] = None


class AnnouncementResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId
    business_unit_ids: list[PydanticObjectId] = Field(default_factory=list)
    # Resolved server-side so the list never needs a second round-trip.
    business_unit_names: list[str] = Field(default_factory=list)
    department_ids: list[PydanticObjectId] = Field(default_factory=list)
    department_names: list[str] = Field(default_factory=list)
    title: str
    description: str
    attachments: list[AttachmentPayload] = Field(default_factory=list)
    status: AnnouncementStatusEnum
    posted_date: Optional[datetime] = None
    published_by: Optional[str] = None
    created_by: str = ""
    created_on: Optional[datetime] = None
    updated_on: Optional[datetime] = None
    is_active: bool = True


class AnnouncementListResponse(CustomModel):
    items: list[AnnouncementResponse]
    total: int
