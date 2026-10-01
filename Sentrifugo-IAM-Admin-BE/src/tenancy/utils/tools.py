"""Repository layer for the 'organisations' collection.

Thin Beanie wrappers — service layer will compose these into the
super-admin flows (create org + admin user, list, view, edit).
"""

import re

from beanie import PydanticObjectId

from src.logger import logger
from src.modules.organisation.models import OrganisationDocument


def _serialize(doc: OrganisationDocument) -> dict:
    d = doc.model_dump()
    if d.get("id") is not None:
        d["id"] = str(d["id"])
    if d.get("address_id") is not None:
        d["address_id"] = str(d["address_id"])
    return d


async def create_organisation(data: dict) -> dict:
    """Insert a new organisation document."""
    org = OrganisationDocument(**data)
    await org.insert()
    logger.info("Organisation created", org_id=str(org.id))
    return _serialize(org)


async def get_organisation_by_id(org_id: str) -> dict | None:
    """Find an organisation by ObjectId (non-deleted)."""
    try:
        oid = PydanticObjectId(org_id)
    except Exception:
        return None
    org = await OrganisationDocument.find_one(
        OrganisationDocument.id == oid,
        OrganisationDocument.deleted_on == None,  # noqa: E711
    )
    return _serialize(org) if org else None


async def get_organisation_by_legal_name(legal_name: str) -> dict | None:
    """Find an organisation by legal name (non-deleted)."""
    org = await OrganisationDocument.find_one(
        OrganisationDocument.legal_name == legal_name,
        OrganisationDocument.deleted_on == None,  # noqa: E711
    )
    return _serialize(org) if org else None


async def list_organisations(
    skip: int = 0,
    limit: int = 20,
    search: str | None = None,
    setup_status: str | None = None,
    is_active: bool | None = None,
) -> list[dict]:
    """Paginated list of non-deleted organisations with optional filters."""
    filters = [OrganisationDocument.deleted_on == None]  # noqa: E711

    if search:
        filters.append({"legal_name": {"$regex": re.escape(search), "$options": "i"}})

    if setup_status is not None:
        filters.append(OrganisationDocument.setup_status == setup_status)

    if is_active is not None:
        filters.append(OrganisationDocument.is_active == is_active)

    orgs = await OrganisationDocument.find(*filters).skip(skip).limit(limit).to_list()
    return [_serialize(o) for o in orgs]


async def count_organisations(
    search: str | None = None,
    setup_status: str | None = None,
    is_active: bool | None = None,
) -> int:
    """Count non-deleted organisations matching filters."""
    filters = [OrganisationDocument.deleted_on == None]  # noqa: E711

    if search:
        filters.append({"legal_name": {"$regex": re.escape(search), "$options": "i"}})

    if setup_status is not None:
        filters.append(OrganisationDocument.setup_status == setup_status)

    if is_active is not None:
        filters.append(OrganisationDocument.is_active == is_active)

    return await OrganisationDocument.find(*filters).count()


async def update_organisation(org_id: str, update_data: dict) -> dict | None:
    """Partially update an organisation and return the updated document."""
    try:
        oid = PydanticObjectId(org_id)
    except Exception:
        return None
    org = await OrganisationDocument.find_one(
        OrganisationDocument.id == oid,
        OrganisationDocument.deleted_on == None,  # noqa: E711
    )
    if not org:
        return None
    await org.set(update_data)
    return _serialize(org)
