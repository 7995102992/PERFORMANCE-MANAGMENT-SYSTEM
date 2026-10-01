"""Read-only endpoints that let the frontend check dependencies before inactivating."""
from typing import Annotated, Literal

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends

from src.auth.models import UserDocument
from src.auth.schemas import UserBase
from src.auth.utils.authorization import require_permission
from src.modules.organisation.models import (
    BandDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    DocumentFolderDocument,
    EmployeeDocument,
    OrgDocumentDocument,
    PayGradeDocument,
)

router = APIRouter(prefix="/dependency-check", tags=["dependency-check"])

NOT_DELETED = {"deleted_on": None}
ACTIVE_AND_NOT_DELETED = {"is_active": True, "deleted_on": None}


@router.get("/{entity_type}/{entity_id}")
async def check_dependencies(
    entity_type: Literal["organisation", "business_unit", "department", "designation", "pay_grade", "band", "document_folder", "policy"],
    entity_id: PydanticObjectId,
    current_user: Annotated[UserBase, Depends(require_permission("core_hr", "create_resource"))],
):
    dependencies: list[dict] = []

    if entity_type == "organisation":
        bu_count = await BusinessUnitDocument.find({"organisation_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if bu_count:
            dependencies.append({"type": "business_units", "count": bu_count})
        dept_count = await DepartmentDocument.find({"organisation_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if dept_count:
            dependencies.append({"type": "departments", "count": dept_count})
        emp_count = await EmployeeDocument.find({"organisation_id": entity_id, **NOT_DELETED}).count()
        if emp_count:
            dependencies.append({"type": "employees", "count": emp_count})
        folder_count = await DocumentFolderDocument.find({"organisation_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if folder_count:
            dependencies.append({"type": "document_folders", "count": folder_count})
        desg_count = await DesignationDocument.find({"organisation_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if desg_count:
            dependencies.append({"type": "designations", "count": desg_count})
        band_count = await BandDocument.find({"organisation_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if band_count:
            dependencies.append({"type": "bands", "count": band_count})
        pg_count = await PayGradeDocument.find({"organisation_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if pg_count:
            dependencies.append({"type": "pay_grades", "count": pg_count})

    elif entity_type == "business_unit":
        dept_count = await DepartmentDocument.find({"business_units": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if dept_count:
            dependencies.append({"type": "departments", "count": dept_count})
        emp_count = await EmployeeDocument.find({"business_unit_id": entity_id, **NOT_DELETED}).count()
        if emp_count:
            dependencies.append({"type": "employees", "count": emp_count})
        folder_count = await DocumentFolderDocument.find({"access.business_units": str(entity_id), **ACTIVE_AND_NOT_DELETED}).count()
        if folder_count:
            dependencies.append({"type": "document_folders", "count": folder_count})

    elif entity_type == "department":
        # Designations are org-level now (no department link) → not a dependency.
        emp_count = await EmployeeDocument.find({"department_id": entity_id, **NOT_DELETED}).count()
        if emp_count:
            dependencies.append({"type": "employees", "count": emp_count})
        folder_count = await DocumentFolderDocument.find({"access.departments": str(entity_id), **ACTIVE_AND_NOT_DELETED}).count()
        if folder_count:
            dependencies.append({"type": "document_folders", "count": folder_count})

    elif entity_type == "designation":
        emp_count = await EmployeeDocument.find({"designation_id": entity_id, **NOT_DELETED}).count()
        if emp_count:
            dependencies.append({"type": "employees", "count": emp_count})

    elif entity_type == "pay_grade":
        desg_count = await DesignationDocument.find({"pay_grade_ids": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if desg_count:
            dependencies.append({"type": "designations", "count": desg_count})

    elif entity_type == "band":
        pg_count = await PayGradeDocument.find({"band_ids": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if pg_count:
            dependencies.append({"type": "pay_grades", "count": pg_count})

    elif entity_type == "document_folder":
        doc_count = await OrgDocumentDocument.find({"folder_id": entity_id, **ACTIVE_AND_NOT_DELETED}).count()
        if doc_count:
            dependencies.append({"type": "org_documents", "count": doc_count})

    elif entity_type == "policy":
        user_count = await UserDocument.find({"policy_ids": entity_id, "deleted_on": None}).count()
        if user_count:
            dependencies.append({"type": "users", "count": user_count})

    return {
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "can_inactivate": len(dependencies) == 0,
        "dependencies": dependencies,
    }
