import re
from datetime import date, datetime, timezone
from typing import List, Optional
from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.models import UserDocument
from src.logger import logger
from src.models import ACCESS_STATUSES, StatusEnum, is_activation_pending
from src.modules.organisation.models import (
    EmployeeDocument,
    AddressDocument,
    OrganisationDocument,
    BusinessUnitDocument,
    DepartmentDocument,
    DesignationDocument,
    CtcRecord,
    FieldHistoryEntry,
    PendingFieldChange,
    IdentityField,
    WorkExperienceRow,
    DependentRow,
    EducationRow,
    EmergencyContact,
    BankDetails,
)
from src.correlation import get_correlation_id, audit_create, stamp_modified
from src.modules.organisation.employees.schema import EmployeeCreate, EmployeeUpdate
from src.modules.organisation.employees.utils import bulk as _bulk
from src.modules.custom_fields.models import EntityType
from src.modules.custom_fields.utils.tools import attach_custom_fields, ValueTools
from src.rabbitmq import DebugLevel, outbox
from src.security.crypto import build_ctc, revise_ctc, decrypt_ctc
from src.location.utils import tools as location_tools


# Fields that carry effective-dated history/pending-change tracking (see
# FieldHistoryEntry / PendingFieldChange in models.py). CTC is NOT one of
# these — it keeps its own always-immediate version map (employee.ctc).
_HISTORY_ATTR = {
    "designation_id": "designation_history",
    "department_id": "department_history",
    "employment_status": "employment_status_history",
    "project_status": "project_status_history",
    "l1_manager_id": "l1_manager_history",
    "l2_manager_id": "l2_manager_history",
}


async def _resolve_display(field: str, value) -> Optional[str]:
    """Human-readable snapshot of an effective-dated field's value, captured at
    the moment it changes so history/pending entries still read correctly even
    if the designation is renamed, the department renamed, or the manager
    leaves later."""
    if value is None:
        return "Not Applicable" if field in ("l1_manager_id", "l2_manager_id") else None
    if field == "designation_id":
        desg = await DesignationDocument.get(value)
        return desg.designation_name if desg else None
    if field == "department_id":
        dept = await DepartmentDocument.get(value)
        return dept.department_name if dept else None
    if field in ("employment_status", "project_status"):
        from src.master_data.models import MasterDataDocument
        md = await MasterDataDocument.get(value)
        return md.value if md else None
    if field in ("l1_manager_id", "l2_manager_id"):
        user = await UserDocument.get(value)
        return f"{user.first_name} {user.last_name}".strip() if user else None
    return None


async def _validate_currency(code: Optional[str]) -> None:
    if not code:
        return
    rows = await location_tools.list_currencies()
    valid = {(r.get("currency") or "").upper() for r in rows if r.get("currency")}
    if code.strip().upper() not in valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid currency '{code}'.",
        )

NOT_DELETED = {"deleted_on": None}
ACTIVE_NOT_DELETED = {"is_active": True, "deleted_on": None}


def __md_lookup(field: str) -> list[dict]:
    return [
        {"$lookup": {"from": "master_data", "localField": field, "foreignField": "_id", "as": field}},
        {"$unwind": {"path": f"${field}", "preserveNullAndEmptyArrays": True}},
    ]


def _lookup_stages() -> list[dict]:
    """Join addresses, BU, Dept, Designation for enriched response."""
    return [
        # Permanent address
        {"$lookup": {"from": "addresses", "localField": "permanent_address_id", "foreignField": "_id", "as": "permanent_address"}},
        {"$unwind": {"path": "$permanent_address", "preserveNullAndEmptyArrays": True}},
        # Present address
        {"$lookup": {"from": "addresses", "localField": "present_address_id", "foreignField": "_id", "as": "present_address"}},
        {"$unwind": {"path": "$present_address", "preserveNullAndEmptyArrays": True}},
        # BU
        {"$lookup": {"from": "business_units", "localField": "business_unit_id", "foreignField": "_id", "as": "_bu"}},
        {"$unwind": {"path": "$_bu", "preserveNullAndEmptyArrays": True}},
        # Department
        {"$lookup": {"from": "departments", "localField": "department_id", "foreignField": "_id", "as": "_dept"}},
        {"$unwind": {"path": "$_dept", "preserveNullAndEmptyArrays": True}},
        # Designation
        {"$lookup": {"from": "designations", "localField": "designation_id", "foreignField": "_id", "as": "_desg"}},
        {"$unwind": {"path": "$_desg", "preserveNullAndEmptyArrays": True}},
        # L1 Manager → lookup user + employee for name, email, emp_code.
        # The employees lookup joins on user_id, which is NOT unique (data can
        # hold duplicate employee docs for one user). $unwind after a multi-hit
        # lookup would then DUPLICATE the listed employee row — and because
        # these stages run after $skip/$limit, a page could return more rows
        # than `limit`, breaking pagination. Cap the join to one live doc.
        {"$lookup": {"from": "users", "localField": "l1_manager_id", "foreignField": "_id", "as": "_l1_user"}},
        {"$unwind": {"path": "$_l1_user", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "employees",
            "let": {"mid": "$l1_manager_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": ["$user_id", "$$mid"]}, "deleted_on": None}},
                {"$limit": 1},
            ],
            "as": "_l1_emp",
        }},
        {"$unwind": {"path": "$_l1_emp", "preserveNullAndEmptyArrays": True}},
        # L2 Manager → lookup user + employee for name, email, emp_code
        {"$lookup": {"from": "users", "localField": "l2_manager_id", "foreignField": "_id", "as": "_l2_user"}},
        {"$unwind": {"path": "$_l2_user", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "employees",
            "let": {"mid": "$l2_manager_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": ["$user_id", "$$mid"]}, "deleted_on": None}},
                {"$limit": 1},
            ],
            "as": "_l2_emp",
        }},
        {"$unwind": {"path": "$_l2_emp", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
            "business_unit_name": "$_bu.business_unit_name",
            "department_name": "$_dept.department_name",
            "designation_name": "$_desg.designation_name",
            "l1_manager_name": {"$concat": [{"$ifNull": ["$_l1_user.first_name", ""]}, " ", {"$ifNull": ["$_l1_user.last_name", ""]}]},
            "l1_manager_email": "$_l1_user.email",
            "l1_manager_emp_code": "$_l1_emp.emp_code",
            "l2_manager_name": {"$concat": [{"$ifNull": ["$_l2_user.first_name", ""]}, " ", {"$ifNull": ["$_l2_user.last_name", ""]}]},
            "l2_manager_email": "$_l2_user.email",
            "l2_manager_emp_code": "$_l2_emp.emp_code",
        }},
        {"$project": {"_bu": 0, "_dept": 0, "_desg": 0, "_l1_user": 0, "_l1_emp": 0, "_l2_user": 0, "_l2_emp": 0}},
        *__md_lookup("employment_type"),
        *__md_lookup("employment_status"),
        *__md_lookup("project_status"),
        *__md_lookup("source_of_hire"),
        # Personal fields + policies from user doc
        {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "_id", "as": "_user"}},
        {"$unwind": {"path": "$_user", "preserveNullAndEmptyArrays": True}},
        {"$addFields": {
            "first_name": "$_user.first_name",
            "middle_name": "$_user.middle_name",
            "last_name": "$_user.last_name",
            "dob": "$_user.dob",
            "gender": "$_user.gender",
            "marital_status": "$_user.marital_status",
            "work_email": "$_user.email",
            "work_phone": "$_user.work_phone",
            "work_phone_extension": "$_user.work_phone_extension",
            # Account-activation signals (from the linked user) — used to derive
            # activation_pending in _normalize. Temp fields, popped there.
            "_acct_status": "$_user.status",
            "_acct_activated_at": "$_user.activated_at",
            "_acct_deleted_on": "$_user.deleted_on",
        }},
        # Resolve gender & marital_status from master_data
        *__md_lookup("gender"),
        *__md_lookup("marital_status"),
        # Policies
        {"$lookup": {"from": "policies", "localField": "_user.policy_ids", "foreignField": "_id", "as": "_policies"}},
        {"$addFields": {"policies": {"$map": {"input": "$_policies", "as": "p", "in": {"id": "$$p._id", "name": "$$p.name"}}}}},
        {"$project": {"_user": 0, "_policies": 0}},
    ]


def _normalize(doc: dict) -> dict:
    doc["id"] = doc.pop("_id")
    for addr_key in ("permanent_address", "present_address"):
        addr = doc.get(addr_key)
        if addr and "_id" in addr:
            addr["id"] = addr.pop("_id")
    if "ctc" in doc:
        _ctc = decrypt_ctc(doc.get("ctc"))
        doc["ctc"] = _ctc["amount"] if _ctc else None
        doc["ctc_history"] = _ctc["history"] if _ctc else []
    # Derive activation_pending from the linked account (single source of truth).
    doc["activation_pending"] = is_activation_pending({
        "status": doc.pop("_acct_status", None),
        "activated_at": doc.pop("_acct_activated_at", None),
        "deleted_on": doc.pop("_acct_deleted_on", None),
    })
    return doc


class EmployeeTools:
    async def _validate_fks(self, org_id, bu_id, dept_id, desg_id):
        if not await OrganisationDocument.find_one(OrganisationDocument.id == org_id, ACTIVE_NOT_DELETED):
            raise HTTPException(status_code=400, detail="Organisation not found or inactive.")
        if not await BusinessUnitDocument.find_one(BusinessUnitDocument.id == bu_id, ACTIVE_NOT_DELETED):
            raise HTTPException(status_code=400, detail="Business unit not found or inactive.")
        if not await DepartmentDocument.find_one(DepartmentDocument.id == dept_id, ACTIVE_NOT_DELETED):
            raise HTTPException(status_code=400, detail="Department not found or inactive.")
        if not await DesignationDocument.find_one(DesignationDocument.id == desg_id, ACTIVE_NOT_DELETED):
            raise HTTPException(status_code=400, detail="Designation not found or inactive.")

    async def _validate_optional_fks(self, org_id, bu_id, dept_id, desg_id):
        """Validate only the FKs that are actually provided. Org is always required."""
        if not await OrganisationDocument.find_one(OrganisationDocument.id == org_id, ACTIVE_NOT_DELETED):
            raise HTTPException(status_code=400, detail="Organisation not found or inactive.")
        if bu_id and not await BusinessUnitDocument.find_one(
            BusinessUnitDocument.id == bu_id, BusinessUnitDocument.organisation_id == org_id, ACTIVE_NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Business unit not found or inactive.")
        if dept_id and not await DepartmentDocument.find_one(
            DepartmentDocument.id == dept_id, DepartmentDocument.organisation_id == org_id, ACTIVE_NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Department not found or inactive.")
        if desg_id and not await DesignationDocument.find_one(
            DesignationDocument.id == desg_id, DesignationDocument.organisation_id == org_id, ACTIVE_NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Designation not found or inactive.")

    async def _validate_managers(self, org_id, l1_id, l2_id, exclude_id=None):
        """Validate that any provided L1/L2 manager exists in the org and isn't the
        employee themselves. L1/L2 are optional (no hierarchy-based requirement)."""
        if l1_id:
            mgr = await EmployeeDocument.find_one(
                EmployeeDocument.user_id == l1_id,
                EmployeeDocument.organisation_id == org_id,
                NOT_DELETED,
            )
            if not mgr:
                raise HTTPException(status_code=400, detail="L1 Manager not found in this organisation.")
            if exclude_id and str(l1_id) == str(exclude_id):
                raise HTTPException(status_code=400, detail="An employee cannot be their own L1 Manager.")

        if l2_id:
            mgr = await EmployeeDocument.find_one(
                EmployeeDocument.user_id == l2_id,
                EmployeeDocument.organisation_id == org_id,
                NOT_DELETED,
            )
            if not mgr:
                raise HTTPException(status_code=400, detail="L2 Manager not found in this organisation.")
            if exclude_id and str(l2_id) == str(exclude_id):
                raise HTTPException(status_code=400, detail="An employee cannot be their own L2 Manager.")

    async def _check_unique_email(self, work_email, exclude_user_id=None):
        normalized = (work_email or "").strip().lower()
        existing = await UserDocument.find({"email": normalized, "deleted_on": None}).to_list()
        for u in existing:
            if exclude_user_id is None or str(u.id) != str(exclude_user_id):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A user with this work email already exists.",
                )

    _EMP_TYPE_LETTERS = {"full-time": "F", "contract": "C", "internship": "I"}

    async def _resolve_emp_type_key(self, employment_type_id: Optional[PydanticObjectId]) -> str:
        """Map an employment_type ObjectId to its master-data key (e.g. 'full-time')."""
        if not employment_type_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Employment type is required for employee code generation.",
            )
        from src.master_data.models import MasterDataDocument
        md = await MasterDataDocument.get(employment_type_id)
        if not md:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Employment type with id {employment_type_id} not found.",
            )
        return md.key

    async def _generate_emp_code(self, bu: BusinessUnitDocument, employment_type_id: Optional[PydanticObjectId] = None) -> tuple[str, PydanticObjectId, str]:
        """Atomically increment the per-type counter. Returns (code, bu_id, letter)."""
        if not bu.emp_code_prefix:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Business unit is missing an employee code prefix. Set it on the BU before creating employees.",
            )
        type_key = await self._resolve_emp_type_key(employment_type_id)
        letter = self._EMP_TYPE_LETTERS.get(type_key)
        if not letter:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported employment type '{type_key}'. Allowed: full-time, contract, internship.",
            )
        counter_field = f"emp_code_last_numbers.{letter}"
        from src.database import get_mongo
        db = get_mongo()
        result = await db["business_units"].find_one_and_update(
            {"_id": bu.id},
            {"$inc": {counter_field: 1}},
            projection={counter_field: 1, "emp_code_start_from": 1, "emp_code_padding": 1},
            return_document=True,
        )
        counter = result.get("emp_code_last_numbers", {}).get(letter, 1)
        start_from = (result.get("emp_code_start_from") or {}).get(letter, 0)
        # start_from is the first code: start_from=5000 → first employee is 5000 (counter starts at 1).
        number = start_from + counter - 1
        padding = (result.get("emp_code_padding") or {}).get(letter, 0)
        number_str = f"{number:0{padding}d}" if padding > 0 else str(number)
        # Full-time codes omit the type letter: PREFIX-NUMBER (e.g. SIL-0001).
        # Contract / internship keep it: PREFIX-C-NUMBER / PREFIX-I-NUMBER.
        code = (
            f"{bu.emp_code_prefix}-{number_str}"
            if letter == "F"
            else f"{bu.emp_code_prefix}-{letter}-{number_str}"
        )
        return code, bu.id, letter

    async def _rollback_emp_code(self, bu_id: PydanticObjectId, letter: str) -> None:
        """Decrement the counter back by 1 on failure — reclaims the code."""
        from src.database import get_mongo
        db = get_mongo()
        await db["business_units"].update_one(
            {"_id": bu_id},
            {"$inc": {f"emp_code_last_numbers.{letter}": -1}},
        )

    async def create(self, data: EmployeeCreate, from_bulk: bool = False) -> dict:
        # Only validate FKs that were actually provided
        await self._validate_optional_fks(
            data.organisation_id,
            data.business_unit_id,
            data.department_id,
            data.designation_id,
        )
        if not data.business_unit_id:
            raise HTTPException(status_code=400, detail="Business unit is required.")
        if not data.department_id:
            raise HTTPException(status_code=400, detail="Department is required.")
        if not data.employment_type:
            raise HTTPException(status_code=400, detail="Employment type is required.")

        await self._check_unique_email(data.work_email)
        await _validate_currency(data.currency)
        if not from_bulk:
            await self._validate_managers(data.organisation_id, data.l1_manager_id, data.l2_manager_id)

        bu = await BusinessUnitDocument.find_one(
            BusinessUnitDocument.id == data.business_unit_id,
            BusinessUnitDocument.organisation_id == data.organisation_id,
            NOT_DELETED,
        )
        if not bu:
            raise HTTPException(status_code=400, detail="Business unit not found.")
        emp_code, _code_bu_id, _code_letter = await self._generate_emp_code(bu, data.employment_type)

        async def _rollback_code():
            if _code_bu_id and _code_letter:
                await self._rollback_emp_code(_code_bu_id, _code_letter)

        perm_addr_id: Optional[PydanticObjectId] = None
        pres_addr_id: Optional[PydanticObjectId] = None
        perm_addr = None
        pres_addr = None

        async def _rollback_addresses():
            if perm_addr is not None:
                await perm_addr.delete()
            if pres_addr is not None:
                await pres_addr.delete()

        try:
            if data.permanent_address:
                perm_addr = AddressDocument(**data.permanent_address.model_dump())
                await perm_addr.insert()
                perm_addr_id = perm_addr.id
            if data.present_address:
                pres_addr = AddressDocument(**data.present_address.model_dump())
                await pres_addr.insert()
                pres_addr_id = pres_addr.id
        except Exception:
            await _rollback_addresses()
            await _rollback_code()
            raise

        # Resolve active state from employment status master data
        emp_status_active = True
        if data.employment_status:
            from src.master_data.models import MasterDataDocument
            md = await MasterDataDocument.get(data.employment_status)
            if md:
                emp_status_active = md.is_active

        # Roles (policies) are assigned directly to the employee now.
        resolved_policy_ids = list(data.policy_ids or [])

        # Create user account (personal fields + contact + policies live here)
        user = UserDocument(
            email=data.work_email,
            password_hash=None,
            auth_method="local",
            first_name=data.first_name,
            middle_name=data.middle_name,
            last_name=data.last_name,
            dob=data.dob,
            gender=data.gender,
            marital_status=data.marital_status,
            work_phone=data.work_phone,
            work_phone_extension=data.work_phone_extension,
            organisation_id=data.organisation_id,
            status=StatusEnum.INACTIVE,
            policy_ids=resolved_policy_ids,
            **audit_create(),
            correlation_id=get_correlation_id(),
        )
        try:
            await user.insert()
        except Exception:
            await _rollback_addresses()
            await _rollback_code()
            raise

        # Create employee
        try:
            employee = EmployeeDocument(
                organisation_id=data.organisation_id,
                user_id=user.id,
                emp_code=emp_code,
                business_unit_id=data.business_unit_id,
                department_id=data.department_id,
                designation_id=data.designation_id,
                source_of_hire=data.source_of_hire,
                l1_manager_id=data.l1_manager_id,
                l2_manager_id=data.l2_manager_id,
                current_exp=data.current_exp,
                total_exp=data.total_exp,
                employment_type=data.employment_type,
                employment_status=data.employment_status,
                project_status=data.project_status,
                date_of_joining=data.date_of_joining,
                date_of_exit=data.date_of_exit,
                ctc=build_ctc(data.ctc, data.currency),
                currency=data.currency,
                about_me=data.about_me,
                bank_details=BankDetails(**data.bank_details.model_dump()) if data.bank_details else None,
                identity_fields=[IdentityField(**f.model_dump()) for f in data.identity_fields],
                personal_phone=data.personal_phone,
                personal_email=data.personal_email,
                seat_location=data.seat_location,
                permanent_address_id=perm_addr_id,
                present_address_id=pres_addr_id,
                same_as_permanent=data.same_as_permanent,
                emergency_contacts=[EmergencyContact(**c.model_dump()) for c in data.emergency_contacts],
                work_experience=[WorkExperienceRow(**r.model_dump()) for r in data.work_experience],
                dependents=[DependentRow(**r.model_dump()) for r in data.dependents],
                education=[EducationRow(**r.model_dump()) for r in data.education],
                **audit_create(),
                correlation_id=get_correlation_id(),
            )
            await employee.insert()
        except Exception:
            await _rollback_addresses()
            await user.delete()
            await _rollback_code()
            raise

        if emp_status_active:
            from src.auth.service import send_activation_email
            full_name = f"{data.first_name} {data.last_name}".strip()
            try:
                await send_activation_email(
                    str(user.id),
                    data.work_email,
                    full_name,
                    tenant_id=str(data.organisation_id),
                )
            except Exception as exc:
                logger.error("Activation email failed for new employee", user_id=str(user.id), error=str(exc))

        await outbox.publish(
            "employee.created",
            {
                "correlation_id": get_correlation_id(),
                "user_id": str(user.id),
                "employee_id": str(employee.id),
                "organisation_id": str(data.organisation_id),
                "emp_code": emp_code,
                "work_email": data.work_email,
                "name": f"{data.first_name} {data.last_name}".strip(),
                "first_name": data.first_name,
                "last_name": data.last_name,
                "l1_manager_id": str(data.l1_manager_id) if data.l1_manager_id else None,
                "l2_manager_id": str(data.l2_manager_id) if data.l2_manager_id else None,
                "designation_id": str(data.designation_id) if data.designation_id else None,
                "department_id": str(data.department_id) if data.department_id else None,
                "business_unit_id": str(data.business_unit_id) if data.business_unit_id else None,
                "employment_status": str(data.employment_status) if data.employment_status else None,
                "project_status": str(data.project_status) if data.project_status else None,
                "date_of_joining": str(data.date_of_joining) if data.date_of_joining else None,
            },
            idempotency_key=f"employee.created:{user.id}",
        )
        await outbox.publish_audit_log(
            module="employees",
            actor_id="system",
            action="created",
            resource=f"employee:{employee.id}",
            debug_level=DebugLevel.HR,
            organisation_id=str(data.organisation_id) if data.organisation_id else None,
        )
        return await self.get(user.id)

    async def _apply_due_pending_changes(self, employee: EmployeeDocument) -> bool:
        """Materialize any pending field change whose effective_date has
        arrived. There's no scheduler for this — every read path below calls
        it first, so a record only flips the first time anyone reads it on or
        after its effective date. Returns True if anything was applied."""
        if not employee.pending_changes:
            return False
        today = date.today()
        due = [c for c in employee.pending_changes if c.effective_date <= today]
        if not due:
            return False
        employee.pending_changes = [c for c in employee.pending_changes if c.effective_date > today]
        applied_fields: set[str] = set()
        applied_effective_dates: dict[str, str] = {}
        for change in due:
            history_attr = _HISTORY_ATTR.get(change.field)
            if not history_attr:
                continue
            current_value = getattr(employee, change.field)
            getattr(employee, history_attr).append(FieldHistoryEntry(
                value=str(current_value) if current_value else None,
                display=await _resolve_display(change.field, current_value),
                updated_on=datetime.now(timezone.utc),
                effective_date=change.effective_date,
            ))
            applied_effective_dates[change.field] = str(change.effective_date)
            setattr(employee, change.field, PydanticObjectId(change.value) if change.value else None)
            applied_fields.add(change.field)
        if not applied_fields:
            return False

        employee.correlation_id = get_correlation_id()
        stamp_modified(employee)
        await employee.save()

        # Mirror update()'s employment_status side effect: a status that just
        # took effect via a queued change must sync the linked account too,
        # not only one applied directly through update().
        if "employment_status" in applied_fields:
            from src.master_data.models import MasterDataDocument
            md = await MasterDataDocument.get(employee.employment_status) if employee.employment_status else None
            should_be_active = md.is_active if md else True
            user = await UserDocument.find_one(UserDocument.id == employee.user_id) if employee.user_id else None
            if user:
                user.status = StatusEnum.ACTIVE if should_be_active else StatusEnum.INACTIVE
                await user.save()

        # Downstream consumers (e.g. Leave Management's local employee copy,
        # which its own leave-plan resolution and probation/exit logic read
        # from) only ever learn about a change via this event — update()
        # already publishes it for an immediate change, so a deferred one
        # applying here must publish it too, or it silently never arrives.
        user = await UserDocument.find_one(UserDocument.id == employee.user_id) if employee.user_id else None
        await outbox.publish(
            "employee.updated",
            {
                "correlation_id": employee.correlation_id,
                "employee_id": str(employee.id),
                "user_id": str(employee.user_id) if employee.user_id else None,
                "organisation_id": str(employee.organisation_id),
                "emp_code": employee.emp_code,
                "work_email": user.email if user else None,
                "name": f"{user.first_name} {user.last_name}".strip() if user else None,
                "l1_manager_id": str(employee.l1_manager_id) if employee.l1_manager_id else None,
                "l2_manager_id": str(employee.l2_manager_id) if employee.l2_manager_id else None,
                "designation_id": str(employee.designation_id) if employee.designation_id else None,
                "department_id": str(employee.department_id) if employee.department_id else None,
                "business_unit_id": str(employee.business_unit_id) if employee.business_unit_id else None,
                "employment_status": str(employee.employment_status) if employee.employment_status else None,
                "project_status": str(employee.project_status) if employee.project_status else None,
                "date_of_joining": str(employee.date_of_joining) if employee.date_of_joining else None,
                "changed_fields": sorted(applied_fields),
                # Deferred changes taking effect now — same consumer contract
                # as update(): field → the effective date it applied on.
                "applied_fields": sorted(applied_fields),
                "queued_fields": [],
                "effective_dates": applied_effective_dates,
            },
            idempotency_key=f"employee.updated:{employee.user_id}:{employee.correlation_id}",
        )
        await outbox.publish_audit_log(
            module="employees",
            actor_id="system",
            action="updated",
            resource=f"employee:{employee.user_id}",
            debug_level=DebugLevel.HR,
            organisation_id=str(employee.organisation_id) if employee.organisation_id else None,
            metadata={"changed_fields": sorted(applied_fields), "effective_dates": applied_effective_dates, "source": "pending_change_applied"},
        )
        return True

    async def get(self, user_id: PydanticObjectId) -> Optional[dict]:
        live = await EmployeeDocument.find_one(EmployeeDocument.user_id == user_id, NOT_DELETED)
        if live:
            await self._apply_due_pending_changes(live)
        pipeline = [{"$match": {"user_id": user_id, **NOT_DELETED}}, *_lookup_stages()]
        results = await EmployeeDocument.aggregate(pipeline).to_list()
        if not results:
            return None
        doc = _normalize(results[0])
        await attach_custom_fields(doc["organisation_id"], EntityType.EMPLOYEE, [doc])
        return doc

    async def get_all(
        self,
        organisation_id: Optional[PydanticObjectId] = None,
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
    ) -> List[dict]:
        match: dict = {**NOT_DELETED}
        if organisation_id: match["organisation_id"] = organisation_id
        if l1_manager_id: match["l1_manager_id"] = l1_manager_id
        if business_unit_ids: match["business_unit_id"] = {"$in": business_unit_ids}
        if department_ids: match["department_id"] = {"$in": department_ids}
        if designation_ids: match["designation_id"] = {"$in": designation_ids}
        if employment_status:
            if employment_status in ("active", "inactive"):
                from src.master_data.models import MasterDataDocument
                is_active_flag = employment_status == "active"
                status_docs = await MasterDataDocument.find(
                    {"category": "EMPLOYMENT_STATUSES", "is_active": is_active_flag}
                ).to_list()
                match["employment_status"] = {"$in": [d.id for d in status_docs]}
            else:
                match["employment_status"] = PydanticObjectId(employment_status)
        if project_status: match["project_status"] = PydanticObjectId(project_status)
        if employment_type_id: match["employment_type"] = PydanticObjectId(employment_type_id)

        # Materialize any due pending changes for employees this query would
        # return, so the list view and the detail view (get(), above) never
        # disagree about a field that's just crossed its effective date.
        due_filter = {**match, "pending_changes.effective_date": {"$lte": date.today()}}
        for due_emp in await EmployeeDocument.find(due_filter).to_list():
            await self._apply_due_pending_changes(due_emp)

        pipeline: list[dict] = [{"$match": match}]
        if search:
            rx = {"$regex": re.escape(search), "$options": "i"}
            pipeline.extend([
                {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "_id", "as": "_search_user"}},
                {"$unwind": {"path": "$_search_user", "preserveNullAndEmptyArrays": True}},
                {"$match": {"$or": [
                    {"emp_code": rx},
                    {"_search_user.email": rx},
                    {"_search_user.first_name": rx},
                    {"_search_user.last_name": rx},
                ]}},
                {"$project": {"_search_user": 0}},
            ])
        if has_policies is not None:
            pipeline.extend([
                {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "_id", "as": "_u"}},
                {"$unwind": {"path": "$_u", "preserveNullAndEmptyArrays": True}},
                {"$match": {"_u.policy_ids": {"$exists": True, "$ne": []} if has_policies else {"$in": [None, []]}}},
                {"$project": {"_u": 0}},
            ])
        if role_ids:
            # Roles (policies) live on the user, not the employee doc.
            pipeline.extend([
                {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "_id", "as": "_role_user"}},
                {"$unwind": {"path": "$_role_user", "preserveNullAndEmptyArrays": True}},
                {"$match": {"_role_user.policy_ids": {"$in": role_ids}}},
                {"$project": {"_role_user": 0}},
            ])
        if employment_status == "active":
            # Employment status can drift out of sync with the account (e.g. an
            # exited user whose employee doc still carries an active status) —
            # gate the convenience filter on the user's login status too.
            pipeline.extend([
                {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "_id", "as": "_status_user"}},
                {"$unwind": {"path": "$_status_user", "preserveNullAndEmptyArrays": True}},
                {"$match": {"_status_user.status": {"$in": [s.value for s in ACCESS_STATUSES]}}},
                {"$project": {"_status_user": 0}},
            ])
        # Deterministic order — without a sort, pagination is natural-order and
        # "first N" is effectively random.
        pipeline.extend([{"$sort": {"emp_code": 1}}, {"$skip": skip}, {"$limit": limit}, *_lookup_stages()])
        results = await EmployeeDocument.aggregate(pipeline).to_list()
        docs = [_normalize(d) for d in results]
        if docs:
            if organisation_id:
                await attach_custom_fields(organisation_id, EntityType.EMPLOYEE, docs)
            else:
                groups: dict = {}
                for doc in docs:
                    groups.setdefault(doc["organisation_id"], []).append(doc)
                for gorg_id, gdocs in groups.items():
                    await attach_custom_fields(gorg_id, EntityType.EMPLOYEE, gdocs)
        return docs

    async def update(self, user_id: PydanticObjectId, data: EmployeeUpdate, actor_id: Optional[PydanticObjectId] = None) -> Optional[dict]:
        employee = await EmployeeDocument.find_one(EmployeeDocument.user_id == user_id, NOT_DELETED)
        if not employee:
            return None

        update_data = data.model_dump(exclude_unset=True)

        # Uniqueness check if changing work_email
        new_work_email = update_data.get("work_email")
        if new_work_email and employee.user_id:
            await self._check_unique_email(new_work_email, exclude_user_id=employee.user_id)

        # Fields that live on the user, not the employee — route them there.
        # policy_ids is intentionally excluded: an employee's roles are derived
        # from their designation, never set manually (synced below).
        USER_FIELDS = ("first_name", "middle_name", "last_name", "dob", "gender", "marital_status", "work_phone", "work_phone_extension")
        user_updates = {}
        for k in list(USER_FIELDS):
            if k in update_data:
                user_updates[k] = update_data.pop(k)
        if "work_email" in update_data:
            user_updates["email"] = (update_data.pop("work_email") or "").strip().lower()
        if user_updates and employee.user_id:
            user = await UserDocument.find_one(UserDocument.id == employee.user_id)
            if user:
                for k, v in user_updates.items():
                    setattr(user, k, v)
                await user.save()

        # Handle addresses separately
        perm_payload = update_data.pop("permanent_address", None)
        pres_payload = update_data.pop("present_address", None)

        # Validate FK changes — scoped to employee's org
        org_id = employee.organisation_id
        new_bu = update_data.get("business_unit_id")
        new_dept = update_data.get("department_id")
        new_desg = update_data.get("designation_id")
        # The employee code (PREFIX-TYPE-NUMBER) is generated from the BU and the
        # employment type at creation and never regenerated, so neither may change
        # after creation (it would desync emp_code). Reject an actual change; an
        # unchanged value is a no-op.
        if new_bu and employee.business_unit_id and new_bu != employee.business_unit_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Business unit cannot be changed after the employee is created (the employee code is derived from it).",
            )
        new_emp_type = update_data.get("employment_type")
        if new_emp_type and employee.employment_type and new_emp_type != employee.employment_type:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Employment type cannot be changed after the employee is created (the employee code is derived from it).",
            )
        if new_bu and not await BusinessUnitDocument.find_one(
            BusinessUnitDocument.id == new_bu, BusinessUnitDocument.organisation_id == org_id, ACTIVE_NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Business unit not found or inactive.")
        if new_dept and not await DepartmentDocument.find_one(
            DepartmentDocument.id == new_dept, DepartmentDocument.organisation_id == org_id, ACTIVE_NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Department not found or inactive.")
        if new_desg and not await DesignationDocument.find_one(
            DesignationDocument.id == new_desg, DesignationDocument.organisation_id == org_id, ACTIVE_NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Designation not found or inactive.")

        # Role (policy) assigned directly → update the user's policy_ids when provided.
        # policy_ids lives on the user, not the employee — drop it from update_data
        # so the employee-field loop below doesn't try to set a non-existent field.
        update_data.pop("policy_ids", None)
        if data.policy_ids is not None and employee.user_id:
            user = await UserDocument.find_one(UserDocument.id == employee.user_id)
            if user:
                user.policy_ids = list(data.policy_ids)
                await user.save()

        # Validate L1/L2 managers if either changed.
        effective_l1 = update_data.get("l1_manager_id", employee.l1_manager_id)
        effective_l2 = update_data.get("l2_manager_id", employee.l2_manager_id)
        if "l1_manager_id" in update_data or "l2_manager_id" in update_data:
            await self._validate_managers(
                employee.organisation_id, effective_l1, effective_l2, exclude_id=employee.user_id
            )

        # ─── Effective-dated fields: designation, department, employment ──────
        # status, project status, L1/L2 manager. A real change to any of these
        # either applies now — pushing the current value into that field's
        # history — or, when effective_date is a future date, is parked in
        # pending_changes untouched until _apply_due_pending_changes flips it
        # on/after that date (called from every read path in this file;
        # there's no scheduler). CTC is NOT part of this — see below, it keeps
        # its original always-immediate behavior.
        effective_date: Optional[date] = update_data.pop("effective_date", None)
        # Schema already enforces this; re-checked here so internal callers
        # can't slip an undated tracked-field change past history tracking.
        if effective_date is None and any(f in update_data for f in _HISTORY_ATTR):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="effectiveDate is required when changing department, designation, "
                       "employment status, project status, or L1/L2 manager.",
            )
        apply_now = effective_date is None or effective_date <= date.today()
        change_stamp = datetime.now(timezone.utc)
        applied_now_fields: set[str] = set()
        queued_fields: set[str] = set()

        for field, history_attr in _HISTORY_ATTR.items():
            if field not in update_data:
                continue
            new_value = update_data.pop(field)
            current_value = getattr(employee, field)
            if new_value == current_value:
                continue
            if apply_now:
                getattr(employee, history_attr).append(FieldHistoryEntry(
                    value=str(current_value) if current_value else None,
                    display=await _resolve_display(field, current_value),
                    updated_on=change_stamp,
                    effective_date=effective_date or date.today(),
                ))
                setattr(employee, field, new_value)
                applied_now_fields.add(field)
            else:
                queued_fields.add(field)
                employee.pending_changes.append(PendingFieldChange(
                    field=field,
                    value=str(new_value) if new_value else None,
                    display=await _resolve_display(field, new_value),
                    effective_date=effective_date,
                    created_by=actor_id,
                    created_on=change_stamp,
                ))

        # Emergency contacts are optional — no minimum enforced.

        # Currency validation + CTC revision (appends a new version when the amount
        # changes, preserving the prior versions with their timestamps) — always
        # immediate, not one of the effective-dated fields above.
        if "currency" in update_data and update_data["currency"]:
            await _validate_currency(update_data["currency"])
        if "ctc" in update_data:
            ctc_currency = update_data.get("currency", employee.currency)
            update_data["ctc"] = revise_ctc(employee.ctc, update_data["ctc"], ctc_currency)

        # Update addresses in place (don't create new docs)
        if perm_payload is not None:
            perm = await AddressDocument.get(employee.permanent_address_id)
            if perm:
                for k, v in perm_payload.items():
                    setattr(perm, k, v)
                await perm.save()
        if pres_payload is not None:
            pres = await AddressDocument.get(employee.present_address_id)
            if pres:
                for k, v in pres_payload.items():
                    setattr(pres, k, v)
                await pres.save()

        # Update employee fields
        for key, value in update_data.items():
            # Handle sub-models (embedded rows)
            if key == "bank_details" and value is not None:
                value = BankDetails(**value)
            elif key == "identity_fields" and value is not None:
                value = [IdentityField(**f) for f in value]
            elif key == "emergency_contacts" and value is not None:
                value = [EmergencyContact(**c) for c in value]
            elif key == "work_experience" and value is not None:
                value = [WorkExperienceRow(**r) for r in value]
            elif key == "dependents" and value is not None:
                value = [DependentRow(**r) for r in value]
            elif key == "education" and value is not None:
                value = [EducationRow(**r) for r in value]
            setattr(employee, key, value)

        employee.correlation_id = get_correlation_id()
        stamp_modified(employee)
        await employee.save()

        # employment_status may have been applied above (immediate) rather than
        # left in update_data for the generic loop — check applied_now_fields,
        # not update_data, so this fires exactly when the live field actually
        # changed just now (a queued/pending change syncs this on apply instead).
        if "employment_status" in applied_now_fields:
            from src.master_data.models import MasterDataDocument
            md = await MasterDataDocument.get(employee.employment_status) if employee.employment_status else None
            should_be_active = md.is_active if md else True
            user = await UserDocument.find_one(UserDocument.id == employee.user_id) if employee.user_id else None
            if user:
                user.status = StatusEnum.ACTIVE if should_be_active else StatusEnum.INACTIVE
                await user.save()

        changed_fields = list(data.model_dump(exclude_unset=True).keys())
        user = await UserDocument.find_one(UserDocument.id == employee.user_id) if employee.user_id else None
        await outbox.publish(
            "employee.updated",
            {
                "correlation_id": get_correlation_id(),
                "employee_id": str(employee.id),
                "user_id": str(user_id),
                "organisation_id": str(employee.organisation_id),
                "emp_code": employee.emp_code,
                "work_email": user.email if user else None,
                "name": f"{user.first_name} {user.last_name}".strip() if user else None,
                "l1_manager_id": str(employee.l1_manager_id) if employee.l1_manager_id else None,
                "l2_manager_id": str(employee.l2_manager_id) if employee.l2_manager_id else None,
                "designation_id": str(employee.designation_id) if employee.designation_id else None,
                "department_id": str(employee.department_id) if employee.department_id else None,
                "business_unit_id": str(employee.business_unit_id) if employee.business_unit_id else None,
                "employment_status": str(employee.employment_status) if employee.employment_status else None,
                "project_status": str(employee.project_status) if employee.project_status else None,
                "date_of_joining": str(employee.date_of_joining) if employee.date_of_joining else None,
                "changed_fields": changed_fields,
                # Effective-dated detail for downstream consumers (Leave
                # Management: leave plans / holiday plans / leave allocation;
                # Timesheet: projects / project status; everyone: L1/L2
                # manager copies). applied_fields took effect now on
                # effective_date; queued_fields will fire in a later
                # employee.updated when their effective_date arrives.
                "effective_date": str(effective_date) if effective_date else None,
                "applied_fields": sorted(applied_now_fields),
                "queued_fields": sorted(queued_fields),
            },
            idempotency_key=f"employee.updated:{user_id}:{employee.correlation_id}",
        )
        await outbox.publish_audit_log(
            module="employees",
            actor_id="system",
            action="updated",
            resource=f"employee:{user_id}",
            debug_level=DebugLevel.HR,
            organisation_id=str(employee.organisation_id) if employee.organisation_id else None,
            metadata={
                "changed_fields": changed_fields,
                "effective_date": str(effective_date) if effective_date else None,
            },
        )
        return await self.get(user_id)

    async def delete(self, user_id: PydanticObjectId, actor_id: str) -> bool:
        employee = await EmployeeDocument.find_one(EmployeeDocument.user_id == user_id, NOT_DELETED)
        if not employee:
            return False
        now = datetime.now(timezone.utc)
        cid = get_correlation_id()
        employee.deleted_on = now
        employee.deleted_by = actor_id
        employee.correlation_id = cid
        await employee.save()

        # Soft-delete linked user
        user = await UserDocument.find_one(UserDocument.id == user_id)
        if user and user.deleted_on is None:
            user.deleted_on = now
            user.deleted_by = actor_id
            user.status = StatusEnum.INACTIVE
            user.correlation_id = cid
            await user.save()

        # Soft-delete linked addresses
        for addr_id in (employee.permanent_address_id, employee.present_address_id):
            if addr_id:
                addr = await AddressDocument.get(addr_id)
                if addr and addr.deleted_on is None:
                    addr.deleted_on = now
                    addr.deleted_by = actor_id
                    await addr.save()

        await ValueTools().delete_entity_values(
            employee.id,
            actor_id,
            organisation_id=employee.organisation_id,
            entity_type=EntityType.EMPLOYEE,
        )

        await outbox.publish(
            "employee.deleted",
            {"correlation_id": cid, "user_id": str(user_id), "organisation_id": str(employee.organisation_id)},
            idempotency_key=f"employee.deleted:{user_id}",
        )
        await outbox.publish_audit_log(
            module="employees",
            actor_id=actor_id,
            action="deleted",
            resource=f"employee:{user_id}",
            debug_level=DebugLevel.HR,
            organisation_id=str(employee.organisation_id) if employee.organisation_id else None,
        )
        return True

    # ─── Bulk upload helpers ────────────────────────────────────────────────

    BULK_FILE_SIZE_LIMIT = 5 * 1024 * 1024  # 5 MB

    async def _load_country_names_lower(self) -> set[str]:
        """Load all country names from the location master data → lowercased set."""
        from src.location.utils import tools as location_tools
        docs = await location_tools.search_countries({}, skip=0, limit=300)
        return {(d.get("name") or "").strip().lower() for d in docs if d.get("name")}

    async def _load_lookup_maps(self, org_id: PydanticObjectId) -> dict:
        """Fetch active BU/Dept/Designation/MasterData/Employees → build lookup maps."""
        from src.master_data.models import MasterDataDocument

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
        all_emps = await EmployeeDocument.find(
            EmployeeDocument.organisation_id == org_id, NOT_DELETED
        ).to_list()
        # Filter to employees with active linked users
        active_user_ids = set()
        user_ids_to_check = [e.user_id for e in all_emps if e.user_id]
        if user_ids_to_check:
            active_users = await UserDocument.find(
                {"_id": {"$in": user_ids_to_check},
                 "status": {"$in": [s.value for s in ACCESS_STATUSES]},
                 "deleted_on": None}
            ).to_list()
            active_user_ids = {u.id for u in active_users}
        emps = [e for e in all_emps if not e.user_id or e.user_id in active_user_ids]

        bu_name_to_id   = {bu.business_unit_name.strip().lower(): str(bu.id) for bu in bus}
        dept_name_to_id = {d.department_name.strip().lower(): str(d.id) for d in depts}
        dept_name_to_bu_ids = {
            d.department_name.strip().lower(): [str(b) for b in (d.business_units or [])]
            for d in depts
        }
        desg_name_to_id = {d.designation_name.strip().lower(): str(d.id) for d in desgs}

        # Role (policy) name → id, for the mandatory Role column.
        from src.policies.models import PolicyDocument
        role_docs = await PolicyDocument.find(
            {"organisation_id": org_id, "is_role": True, "is_active": True, "deleted_on": None}
        ).to_list()
        role_name_to_id = {p.name.strip().lower(): str(p.id) for p in role_docs}

        # Manager lookup — accept name, email, or "Name <email>" (all lowercased keys)
        # Names now live on the user doc, so build a user_id→name map
        emp_user_ids = [e.user_id for e in emps if e.user_id]
        user_name_map: dict[PydanticObjectId, tuple[str, str]] = {}
        if emp_user_ids:
            users_for_names = await UserDocument.find({"_id": {"$in": emp_user_ids}}).to_list()
            user_name_map = {u.id: (u.first_name or "", u.last_name or "", u.email or "") for u in users_for_names}

        manager_lookup: dict[str, str] = {}
        for e in emps:
            if not e.user_id:
                continue
            _fn, _ln, email_raw = user_name_map.get(e.user_id, ("", "", ""))
            email = email_raw.strip().lower()
            uid = str(e.user_id)
            # Managers are matched by work email ONLY — names are ambiguous
            # (multiple employees can share a name).
            if email:
                manager_lookup[email] = uid

        md_maps: dict[str, dict[str, str]] = {}
        for category in _bulk.MASTER_DATA_FIELDS.values():
            docs = await MasterDataDocument.find(
                {"category": category, "is_active": True,
                 "$or": [{"organisation_id": None}, {"organisation_id": org_id}]}
            ).to_list()
            md_maps[category] = {_bulk.normalize_md_value(d.value): str(d.id) for d in docs}

        return dict(
            bu_name_to_id=bu_name_to_id,
            dept_name_to_id=dept_name_to_id,
            dept_name_to_bu_ids=dept_name_to_bu_ids,
            desg_name_to_id=desg_name_to_id,
            role_name_to_id=role_name_to_id,
            manager_lookup=manager_lookup,
            md_maps=md_maps,
            bus=bus,
            emps=emps,
        )

    async def bulk_validate(
        self, organisation_id: PydanticObjectId, file_bytes: bytes, filename: str
    ) -> dict:
        """Parse + validate file. Returns per-row results (no insert)."""
        if not await OrganisationDocument.find_one(
            OrganisationDocument.id == organisation_id, NOT_DELETED
        ):
            raise HTTPException(status_code=400, detail="Organisation not found.")

        if len(file_bytes) > self.BULK_FILE_SIZE_LIMIT:
            mb = self.BULK_FILE_SIZE_LIMIT // (1024 * 1024)
            return {
                "total_rows": 0, "valid_count": 0, "error_count": 0, "duplicate_count": 0,
                "file_errors": [f"File exceeds {mb} MB size limit."], "rows": [],
            }

        try:
            rows = _bulk.read_file_to_rows(file_bytes, filename)
        except Exception as e:
            return {
                "total_rows": 0, "valid_count": 0, "error_count": 0, "duplicate_count": 0,
                "file_errors": [f"Could not read file: {e}"], "rows": [],
            }

        if not rows:
            return {
                "total_rows": 0, "valid_count": 0, "error_count": 0, "duplicate_count": 0,
                "file_errors": ["File is empty."], "rows": [],
            }

        headers = rows[0]
        data_rows = rows[1:]
        column_map = _bulk.build_column_map(headers)
        missing = _bulk.missing_required_columns(column_map)
        file_errors = []
        if missing:
            file_errors.append(f"Missing required columns: {', '.join(missing)}")
            return {
                "total_rows": len(data_rows), "valid_count": 0, "error_count": 0,
                "duplicate_count": 0, "file_errors": file_errors, "rows": [],
            }

        maps = await self._load_lookup_maps(organisation_id)
        country_names_lower = await self._load_country_names_lower()

        # Existing users in this org (for duplicate email checks)
        existing_emails: set[str] = set()
        for u in await UserDocument.find(
            {"organisation_id": organisation_id, "deleted_on": None}
        ).to_list():
            existing_emails.add(u.email.strip().lower())

        # Seen within file (for intra-file duplicate detection)
        seen_emails: set[str] = set()

        results: list[dict] = []
        valid_count = 0
        error_count = 0
        duplicate_count = 0

        for i, raw_row in enumerate(data_rows):
            row_num = i + 2  # 1 = header, data starts at 2
            parsed = _bulk.parse_row(raw_row, column_map)

            if _bulk.row_is_empty(parsed):
                results.append({"row_num": row_num, "status": "empty", "parsed": None, "errors": []})
                continue

            errors, enriched = _bulk.validate_row(
                parsed,
                bu_name_to_id=maps["bu_name_to_id"],
                dept_name_to_bu_ids=maps["dept_name_to_bu_ids"],
                dept_name_to_id=maps["dept_name_to_id"],
                desg_name_to_id=maps["desg_name_to_id"],
                role_name_to_id=maps["role_name_to_id"],
                md_maps=maps["md_maps"],
                manager_lookup=maps["manager_lookup"],
                country_names_lower=country_names_lower,
            )

            # Duplicate checks (work_email only — emp_code is auto-generated server-side)
            email_lc = (parsed.get("work_email") or "").lower()

            is_duplicate = False
            if email_lc:
                if email_lc in existing_emails:
                    errors.append({"field": "work_email", "message": f"Email '{parsed['work_email']}' already exists in database"})
                    is_duplicate = True
                elif email_lc in seen_emails:
                    errors.append({"field": "work_email", "message": f"Duplicate email '{parsed['work_email']}' within this file"})
                    is_duplicate = True
                else:
                    seen_emails.add(email_lc)

            if errors:
                status_str = "duplicate" if is_duplicate and all(e["field"] == "work_email" for e in errors) else "error"
                if status_str == "duplicate":
                    duplicate_count += 1
                else:
                    error_count += 1
                display_parsed = _serialize_parsed(enriched)
                results.append({"row_num": row_num, "status": status_str, "parsed": display_parsed, "errors": errors})
            else:
                valid_count += 1
                display_parsed = _serialize_parsed(enriched)
                results.append({"row_num": row_num, "status": "valid", "parsed": display_parsed, "errors": []})

        # ── Intra-batch manager resolution ─────────────────────────────────
        # Build a lookup of employees within this batch so rows referencing
        # each other as managers don't fail validation.
        batch_lookup: dict[str, str] = {}  # work_email → work_email (email-only)
        for row_result in results:
            if row_result["status"] == "empty" or not row_result.get("parsed"):
                continue
            p = row_result["parsed"]
            email = (p.get("work_email") or "").strip().lower()
            if email:
                batch_lookup[email] = email

        for row_result in results:
            if row_result["status"] not in ("error",) or not row_result.get("parsed"):
                continue
            mgr_errors = [e for e in row_result["errors"] if e["field"] == "reporting_manager"]
            if not mgr_errors:
                continue
            mgr_raw = (row_result["parsed"].get("reporting_manager") or "").strip()
            mgr_email = _bulk.extract_manager_email(mgr_raw)
            if not mgr_email:
                continue
            batch_mgr_email = batch_lookup.get(mgr_email)
            if batch_mgr_email:
                row_result["errors"] = [e for e in row_result["errors"] if e["field"] != "reporting_manager"]
                row_result["parsed"]["_batch_manager_email"] = batch_mgr_email
                if not row_result["errors"]:
                    row_result["status"] = "valid"
                    valid_count += 1
                    error_count -= 1

        return {
            "total_rows": len(data_rows),
            "valid_count": valid_count,
            "error_count": error_count,
            "duplicate_count": duplicate_count,
            "file_errors": file_errors,
            "rows": results,
        }

    async def bulk_upload(
        self,
        organisation_id: PydanticObjectId,
        file_bytes: bytes,
        filename: str,
        selected_row_nums: Optional[list[int]] = None,
    ) -> dict:
        """Parse + validate + insert rows. If selected_row_nums given, only insert those."""
        validation = await self.bulk_validate(organisation_id, file_bytes, filename)
        if validation["file_errors"]:
            return {"total": 0, "successful": 0, "failed": 0,
                    "errors": [{"row_num": 0, "message": e} for e in validation["file_errors"]],
                    "created_ids": []}

        row_filter = set(selected_row_nums) if selected_row_nums is not None else None

        created_ids: list[str] = []
        errors: list[dict] = []
        successful = 0
        failed = 0
        considered = 0
        batch_mgr_pending: list[tuple[str, str]] = []

        for row_result in validation["rows"]:
            if row_result["status"] == "empty":
                continue
            if row_filter is not None and row_result["row_num"] not in row_filter:
                continue
            if row_result["status"] != "valid":
                errors.append({
                    "row_num": row_result["row_num"],
                    "message": "; ".join(e["message"] for e in row_result["errors"]) or "Invalid row",
                })
                failed += 1
                considered += 1
                continue

            considered += 1
            parsed = row_result["parsed"]
            batch_mgr_email = parsed.pop("_batch_manager_email", None)
            try:
                payload = _build_employee_create_from_parsed(organisation_id, parsed)
                created = await self.create(payload, from_bulk=True)
                if created and created.get("user_id"):
                    created_ids.append(str(created["user_id"]))
                    successful += 1
                    if batch_mgr_email:
                        batch_mgr_pending.append((str(created["id"]), batch_mgr_email))
                else:
                    failed += 1
                    errors.append({"row_num": row_result["row_num"], "message": "Insert failed"})
            except HTTPException as e:
                failed += 1
                errors.append({"row_num": row_result["row_num"], "message": str(e.detail)})
            except Exception as e:
                failed += 1
                errors.append({"row_num": row_result["row_num"], "message": f"Unexpected error: {e}"})

        # Second pass: resolve intra-batch manager references (store user_id)
        for created_emp_id, mgr_email in batch_mgr_pending:
            try:
                mgr_user = await UserDocument.find_one(
                    {"email": (mgr_email or "").strip().lower(), "deleted_on": None, "organisation_id": organisation_id}
                )
                if mgr_user:
                    emp = await EmployeeDocument.get(PydanticObjectId(created_emp_id))
                    if emp:
                        emp.l1_manager_id = mgr_user.id
                        await emp.save()
            except Exception:
                pass

        await outbox.publish_audit_log(
            module="employees",
            actor_id="system",
            action="bulk_uploaded",
            resource=f"organisation:{organisation_id}",
            debug_level=DebugLevel.HR,
            organisation_id=str(organisation_id) if organisation_id else None,
            metadata={
                "filename": filename,
                "considered": considered,
                "successful": successful,
                "failed": failed,
                "selected_only": bool(selected_row_nums),
            },
        )

        return {
            "total": considered,
            "successful": successful,
            "failed": failed,
            "errors": errors,
            "created_ids": created_ids,
        }


# ─── Helpers for bulk upload ────────────────────────────────────────────────

def _serialize_parsed(parsed: dict) -> dict:
    """Convert date objects to ISO strings for JSON serialization."""
    out = dict(parsed)
    for key in ("date_of_joining", "dob", "date_of_exit"):
        if out.get(key):
            out[key] = out[key].isoformat() if hasattr(out[key], "isoformat") else str(out[key])
    return out


def _build_employee_create_from_parsed(org_id: PydanticObjectId, parsed: dict) -> "EmployeeCreate":
    """Build an EmployeeCreate payload from a validated parsed row.

    Bulk only requires first_name, last_name, work_email — every other field is
    optional. Addresses are constructed only if at least the address line is filled.
    """
    from src.modules.organisation.addresses.schema import AddressCreate
    from src.modules.organisation.employees.schema import IdentityFieldDTO

    def to_date(v):
        if v is None or v == "":
            return None
        if hasattr(v, "year") and hasattr(v, "month"):
            return v
        from datetime import date as _date_cls
        try:
            return _date_cls.fromisoformat(str(v))
        except Exception:
            return None

    def _build_address(prefix: str) -> Optional[AddressCreate]:
        """Build an AddressCreate only if all four required parts are filled.

        AddressBase enforces non-empty country/state/city/address_line_1, so a
        partial address (e.g. line1 only) silently becomes no address — the
        admin can fill it in later via the form.
        """
        line1 = parsed.get(f"{prefix}_addr_line1")
        country = parsed.get(f"{prefix}_country")
        state   = parsed.get(f"{prefix}_state")
        city    = parsed.get(f"{prefix}_city")
        if not (line1 and country and state and city):
            return None
        return AddressCreate(
            country=country,
            state=state,
            city=city,
            zip_code=parsed.get(f"{prefix}_zip") or None,
            address_line_1=line1,
            address_line_2=parsed.get(f"{prefix}_addr_line2") or None,
        )

    perm_addr = _build_address("perm")
    # If only one address provided, mirror it to the other so users have a complete record
    pres_addr = _build_address("pres") or perm_addr
    if perm_addr is None and pres_addr is not None:
        perm_addr = pres_addr

    # PAN / Aadhaar → identity_fields
    identity_fields = []
    if parsed.get("pan"):
        identity_fields.append(IdentityFieldDTO(label="PAN", value=parsed["pan"]))
    if parsed.get("aadhaar"):
        identity_fields.append(IdentityFieldDTO(label="Aadhaar", value=parsed["aadhaar"]))

    def _opt_oid(v):
        return PydanticObjectId(v) if v else None

    from src.modules.organisation.employees.schema import BankDetailsDTO
    has_bank = any(parsed.get(k) for k in ("bank_account_holder", "bank_account_number", "bank_ifsc_code", "bank_name"))
    bank_details = BankDetailsDTO(
        account_holder_name=parsed.get("bank_account_holder"),
        account_number=parsed.get("bank_account_number"),
        ifsc_code=parsed.get("bank_ifsc_code"),
        bank_name=parsed.get("bank_name"),
    ) if has_bank else None

    return EmployeeCreate(
        organisation_id=org_id,
        work_email=parsed["work_email"],
        first_name=parsed["first_name"],
        middle_name=None,
        last_name=parsed["last_name"],
        business_unit_id=_opt_oid(parsed.get("business_unit_id")),
        department_id=_opt_oid(parsed.get("department_id")),
        designation_id=_opt_oid(parsed.get("designation_id")),
        policy_ids=[_opt_oid(parsed.get("role_id"))] if parsed.get("role_id") else [],
        source_of_hire=_opt_oid(parsed.get("source_of_hire_id")),
        current_exp=None,
        total_exp=None,
        employment_type=_opt_oid(parsed.get("employment_type_id")),
        employment_status=_opt_oid(parsed.get("employment_status_id")),
        project_status=_opt_oid(parsed.get("project_status_id")),
        date_of_joining=to_date(parsed.get("date_of_joining")),
        date_of_exit=to_date(parsed.get("date_of_exit")),
        dob=to_date(parsed.get("dob")),
        gender=_opt_oid(parsed.get("gender_id")),
        marital_status=_opt_oid(parsed.get("marital_status_id")),
        about_me=parsed.get("about_me"),
        bank_details=bank_details,
        l1_manager_id=_opt_oid(parsed.get("l1_manager_id")),
        l2_manager_id=None,
        identity_fields=identity_fields,
        emergency_contacts=[],
        work_phone_extension=parsed.get("work_phone_extension"),
        work_phone=parsed.get("work_phone"),
        personal_phone=parsed.get("personal_phone"),
        personal_email=parsed.get("personal_email"),
        seat_location=None,
        permanent_address=perm_addr,
        present_address=pres_addr,
        same_as_permanent=False,
        work_experience=[],
        dependents=[],
        education=[],
    )
