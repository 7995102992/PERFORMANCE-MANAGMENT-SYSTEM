"""Setup progress tracking — stored on OrganisationDocument.setup_progress.

Each step is one of: "locked" | "pending" | "completed"
  - locked    = prerequisite step not completed (no data exists for prerequisite)
  - pending   = prerequisites met, but step not finished yet
  - completed = step data is complete

Organisation step is "completed" when required fields are filled:
  address_id, date_of_incorporation, currency, timezone, is_multiple_business_units.

Other steps are "completed" when at least one active record exists.

Call `refresh_setup_progress(org_id)` after any create/update/delete on a
participating entity.
"""
import asyncio

from beanie import Document, PydanticObjectId

from src.logger import logger
from src.modules.organisation.models import (
    BandDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    DocumentFolderDocument,
    EmployeeDocument,
    OrganisationDocument,
    PayGradeDocument,
)

NOT_DELETED = {"deleted_on": None}

STEP_ORDER = [
    "organisation",
    "business_units",
    "departments",
    "org_documents",
    "policies",
    "designations",
    "bands",
    "pay_grades",
    "employees",
    "assign_head",
]

STEP_MODEL: dict[str, type[Document] | None] = {
    "organisation": None,
    "business_units": BusinessUnitDocument,
    "departments": DepartmentDocument,
    "org_documents": DocumentFolderDocument,
    "policies": None,
    "designations": DesignationDocument,
    "bands": BandDocument,
    "pay_grades": PayGradeDocument,
    "employees": EmployeeDocument,
    "assign_head": None,
}

STEP_PREREQUISITES: dict[str, list[str]] = {
    "organisation": [],
    "business_units": ["organisation"],
    "departments": ["business_units"],
    "org_documents": ["departments"],
    "policies": ["departments"],
    "designations": ["departments"],
    "bands": ["organisation"],
    "pay_grades": ["bands", "designations"],
    "employees": ["departments", "designations", "policies"],
    "assign_head": ["employees"],
}

ORG_REQUIRED_FIELDS = ["address_id", "date_of_incorporation", "currency", "timezone"]


def _is_org_complete(org: OrganisationDocument) -> bool:
    for field in ORG_REQUIRED_FIELDS:
        val = getattr(org, field, None)
        if val is None or val == "":
            return False
    return True


async def _has_data(model: type[Document], org_id: PydanticObjectId) -> bool:
    try:
        doc = await model.find_one({"organisation_id": org_id, **NOT_DELETED})
        return doc is not None
    except Exception as exc:
        logger.warning("setup_progress.check_failed", model=model.__name__, error=str(exc))
        return False
