"""Dependency checks for inactivating org-setup entities.

Before setting is_active=False on any entity, we check if active dependents
exist. If they do, we raise a 409 with details of what's still linked.
"""
from beanie import PydanticObjectId
from fastapi import HTTPException, status

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

NOT_DELETED = {"deleted_on": None}
ACTIVE_AND_NOT_DELETED = {"is_active": True, "deleted_on": None}


def _raise_dependency_error(entity_type: str, dependencies: list[dict]) -> None:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "message": f"Cannot inactivate {entity_type}. Active dependencies exist.",
            "dependencies": dependencies,
        },
    )


async def check_organisation_dependencies(org_id: PydanticObjectId) -> None:
    dependencies: list[dict] = []

    bu_count = await BusinessUnitDocument.find(
        {"organisation_id": org_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if bu_count:
        dependencies.append({"type": "business_units", "count": bu_count})

    dept_count = await DepartmentDocument.find(
        {"organisation_id": org_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if dept_count:
        dependencies.append({"type": "departments", "count": dept_count})

    emp_count = await EmployeeDocument.find(
        {"organisation_id": org_id, **NOT_DELETED}
    ).count()
    if emp_count:
        dependencies.append({"type": "employees", "count": emp_count})

    folder_count = await DocumentFolderDocument.find(
        {"organisation_id": org_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if folder_count:
        dependencies.append({"type": "document_folders", "count": folder_count})

    desg_count = await DesignationDocument.find(
        {"organisation_id": org_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if desg_count:
        dependencies.append({"type": "designations", "count": desg_count})

    band_count = await BandDocument.find(
        {"organisation_id": org_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if band_count:
        dependencies.append({"type": "bands", "count": band_count})

    pg_count = await PayGradeDocument.find(
        {"organisation_id": org_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if pg_count:
        dependencies.append({"type": "pay_grades", "count": pg_count})

    if dependencies:
        _raise_dependency_error("organisation", dependencies)


async def check_business_unit_dependencies(bu_id: PydanticObjectId) -> None:
    dependencies: list[dict] = []

    dept_count = await DepartmentDocument.find(
        {"business_units": bu_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if dept_count:
        dependencies.append({"type": "departments", "count": dept_count})

    emp_count = await EmployeeDocument.find(
        {"business_unit_id": bu_id, **NOT_DELETED}
    ).count()
    if emp_count:
        dependencies.append({"type": "employees", "count": emp_count})

    folder_count = await DocumentFolderDocument.find(
        {"access.business_units": str(bu_id), **ACTIVE_AND_NOT_DELETED}
    ).count()
    if folder_count:
        dependencies.append({"type": "document_folders", "count": folder_count})

    if dependencies:
        _raise_dependency_error("business unit", dependencies)


async def check_department_dependencies(dept_id: PydanticObjectId) -> None:
    dependencies: list[dict] = []

    # Designations are org-level now (no department link) → not a dependency.
    emp_count = await EmployeeDocument.find(
        {"department_id": dept_id, **NOT_DELETED}
    ).count()
    if emp_count:
        dependencies.append({"type": "employees", "count": emp_count})

    folder_count = await DocumentFolderDocument.find(
        {"access.departments": str(dept_id), **ACTIVE_AND_NOT_DELETED}
    ).count()
    if folder_count:
        dependencies.append({"type": "document_folders", "count": folder_count})

    if dependencies:
        _raise_dependency_error("department", dependencies)


async def check_designation_dependencies(desg_id: PydanticObjectId) -> None:
    dependencies: list[dict] = []

    emp_count = await EmployeeDocument.find(
        {"designation_id": desg_id, **NOT_DELETED}
    ).count()
    if emp_count:
        dependencies.append({"type": "employees", "count": emp_count})

    if dependencies:
        _raise_dependency_error("designation", dependencies)


async def check_pay_grade_dependencies(pg_id: PydanticObjectId) -> None:
    """Block inactivating/deleting a pay grade still assigned to a designation."""
    dependencies: list[dict] = []

    desg_count = await DesignationDocument.find(
        {"pay_grade_ids": pg_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if desg_count:
        dependencies.append({"type": "designations", "count": desg_count})

    if dependencies:
        _raise_dependency_error("pay grade", dependencies)


async def check_document_folder_dependencies(folder_id: PydanticObjectId) -> None:
    dependencies: list[dict] = []

    # Documents in this folder AND in its sub-folders — deactivating a main
    # folder cascades to its children, so their documents are just as much a
    # blocker as the ones sitting directly inside it.
    from src.modules.organisation.models import DocumentFolderDocument

    sub_ids = [
        f.id
        for f in await DocumentFolderDocument.find(
            {"parent_id": folder_id, "deleted_on": None}
        ).to_list()
    ]
    doc_count = await OrgDocumentDocument.find(
        {"folder_id": {"$in": [folder_id, *sub_ids]}, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if doc_count:
        dependencies.append({"type": "org_documents", "count": doc_count})

    # Sub-folders themselves are NOT a blocker — they are deactivated alongside
    # the parent, not destroyed, and the caller is warned about that in the UI.

    if dependencies:
        _raise_dependency_error("document folder", dependencies)


async def check_band_dependencies(band_id: PydanticObjectId) -> None:
    dependencies: list[dict] = []

    pg_count = await PayGradeDocument.find(
        {"band_ids": band_id, **ACTIVE_AND_NOT_DELETED}
    ).count()
    if pg_count:
        dependencies.append({"type": "pay_grades", "count": pg_count})

    if dependencies:
        _raise_dependency_error("band", dependencies)
