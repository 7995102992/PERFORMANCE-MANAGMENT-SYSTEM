"""Employees service — thin orchestration layer between router and tools."""
import json
from typing import Optional

from beanie import PydanticObjectId
from fastapi import HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse

from src.auth.schemas import UserBase
from src.auth.utils.org_context import check_org_access
from src.modules.organisation.employees.schema import EmployeeCreate, EmployeeUpdate
from src.modules.organisation.employees.utils.tools import EmployeeTools
from src.modules.organisation.employees.utils import bulk as _bulk
from src.modules.organisation.models import (
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    EmployeeDocument,
    OrganisationDocument,
)
from src.master_data.models import MasterDataDocument
from src.models import ACCESS_STATUSES

_tools = EmployeeTools()

NOT_DELETED = {"deleted_on": None}


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


# ---------------------------------------------------------------------------
# Bulk endpoints
# ---------------------------------------------------------------------------

async def download_bulk_template(caller: UserBase) -> StreamingResponse:
    org_id = _resolve_org(caller)
    if not await OrganisationDocument.find_one(OrganisationDocument.id == org_id, NOT_DELETED):
        raise HTTPException(status_code=400, detail="Organisation not found.")

    from src.location.utils import tools as location_tools

    active_filter = {"is_active": True, **NOT_DELETED}

    bus = await BusinessUnitDocument.find(
        BusinessUnitDocument.organisation_id == org_id, active_filter
    ).to_list()
    depts = await DepartmentDocument.find(
        DepartmentDocument.organisation_id == org_id, active_filter
    ).to_list()
    desgs = await DesignationDocument.find(
        DesignationDocument.organisation_id == org_id, active_filter
    ).to_list()
    from src.auth.models import UserDocument as _UD
    all_emps = await EmployeeDocument.find(
        EmployeeDocument.organisation_id == org_id, NOT_DELETED
    ).to_list()
    user_ids = [e.user_id for e in all_emps if e.user_id]
    active_users = await _UD.find(
        {"_id": {"$in": user_ids},
         "status": {"$in": [s.value for s in ACCESS_STATUSES]},
         "deleted_on": None}
    ).to_list() if user_ids else []
    active_user_ids = {u.id for u in active_users}
    emps = [e for e in all_emps if not e.user_id or e.user_id in active_user_ids]

    bu_names = sorted({b.business_unit_name for b in bus})
    dept_names = sorted({d.department_name for d in depts})
    desg_names = sorted({d.designation_name for d in desgs})

    # Roles (policies with is_role=true) — the Role column dropdown + resolution.
    from src.policies.models import PolicyDocument
    role_docs = await PolicyDocument.find(
        {"organisation_id": org_id, "is_role": True, "is_active": True, "deleted_on": None}
    ).to_list()
    role_names = sorted({r.name for r in role_docs})

    # BU → Departments mapping (a dept can belong to multiple BUs)
    bu_id_to_name = {str(b.id): b.business_unit_name for b in bus}
    bu_to_depts: dict[str, list[str]] = {}
    for d in depts:
        for bu_oid in (d.business_units or []):
            bu_name = bu_id_to_name.get(str(bu_oid))
            if bu_name:
                bu_to_depts.setdefault(bu_name, []).append(d.department_name)
    for k in bu_to_depts:
        bu_to_depts[k] = sorted(set(bu_to_depts[k]))

    # Designations are org-level now (flat list) — no department→designation map.
    # Names + email live on user doc — resolve them
    from src.auth.models import UserDocument as _UD2
    emp_user_ids = [e.user_id for e in emps if e.user_id]
    user_info_map: dict = {}
    if emp_user_ids:
        _users = await _UD2.find({"_id": {"$in": emp_user_ids}}).to_list()
        user_info_map = {u.id: (u.first_name or "", u.last_name or "", u.email or "") for u in _users}
    # Manager dropdown shows "Name - email - empCode" for readability, but matching
    # is by the EMAIL portion only (names are ambiguous). validate_row extracts the email.
    emp_labels = sorted({
        f"{info[0]} {info[1]} - {info[2]} - {e.emp_code}".strip()
        for e in emps
        if e.user_id and (info := user_info_map.get(e.user_id)) and info[2]
    })

    country_docs = await location_tools.search_countries({}, skip=0, limit=300)
    country_names = sorted({(c.get("name") or "").strip() for c in country_docs if c.get("name")})

    state_docs = await location_tools.search_states({}, skip=0, limit=5000)
    state_names = sorted({(s.get("name") or "").strip() for s in state_docs if s.get("name")})

    city_docs = await location_tools.search_cities({}, skip=0, limit=50000)
    city_names = sorted({(c.get("name") or "").strip() for c in city_docs if c.get("name")})

    md_options: dict[str, list[str]] = {}
    for category in _bulk.MASTER_DATA_FIELDS.values():
        docs = await MasterDataDocument.find(
            {"category": category, "is_active": True,
             "$or": [{"organisation_id": None}, {"organisation_id": org_id}]}
        ).sort("value").to_list()
        md_options[category] = [d.value for d in docs]

    xlsx_bytes = _bulk.build_template_xlsx(
        bu_names, dept_names, desg_names, role_names, country_names, emp_labels, md_options,
        bu_to_depts=bu_to_depts,
        state_names=state_names, city_names=city_names,
    )
    import io
    return StreamingResponse(
        io.BytesIO(xlsx_bytes),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="employee-bulk-template.xlsx"'},
    )


async def bulk_validate(file: UploadFile, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    file_bytes = await file.read()
    return await _tools.bulk_validate(org_id, file_bytes, file.filename or "")


async def bulk_upload(
    file: UploadFile,
    caller: UserBase,
    selected_row_nums: str = "",
) -> dict:
    org_id = _resolve_org(caller)
    file_bytes = await file.read()
    selected: Optional[list[int]] = None
    if selected_row_nums.strip():
        try:
            parsed = json.loads(selected_row_nums)
            if isinstance(parsed, list):
                selected = [int(x) for x in parsed]
        except (json.JSONDecodeError, ValueError, TypeError):
            raise HTTPException(status_code=400, detail="selected_row_nums must be a JSON array of integers")
    return await _tools.bulk_upload(org_id, file_bytes, file.filename or "", selected_row_nums=selected)


# ---------------------------------------------------------------------------
# Single-employee CRUD
# ---------------------------------------------------------------------------

async def create_employee(data: EmployeeCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    return await _tools.create(data.model_copy(update={"organisation_id": org_id}))


async def list_employees(
    caller: UserBase,
    business_unit_ids: Optional[list[PydanticObjectId]] = None,
    department_ids: Optional[list[PydanticObjectId]] = None,
    designation_ids: Optional[list[PydanticObjectId]] = None,
    employment_status: Optional[str] = None,
    project_status: Optional[str] = None,
    employment_type_id: Optional[str] = None,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    has_policies: Optional[bool] = None,
    role_ids: Optional[list[PydanticObjectId]] = None,
    l1_manager_id: Optional[PydanticObjectId] = None,
) -> list[dict]:
    org_id = _resolve_org(caller)
    return await _tools.get_all(
        organisation_id=org_id,
        business_unit_ids=business_unit_ids,
        department_ids=department_ids,
        designation_ids=designation_ids,
        employment_status=employment_status,
        project_status=project_status,
        employment_type_id=employment_type_id,
        skip=skip,
        limit=limit,
        search=search,
        has_policies=has_policies,
        role_ids=role_ids,
        l1_manager_id=l1_manager_id,
    )


async def get_employee(user_id: PydanticObjectId, caller: UserBase) -> dict:
    emp = await _tools.get(user_id)
    if not emp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found")
    check_org_access(emp.get("organisation_id") or emp.organisation_id, caller)
    return emp


async def update_employee(user_id: PydanticObjectId, data: EmployeeUpdate, caller: UserBase) -> dict:
    await get_employee(user_id, caller)
    updated = await _tools.update(user_id, data, actor_id=PydanticObjectId(caller.id))
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found")
    return updated


async def delete_employee(user_id: PydanticObjectId, caller: UserBase) -> None:
    await get_employee(user_id, caller)
    await _tools.delete(user_id, actor_id=str(caller.id))
