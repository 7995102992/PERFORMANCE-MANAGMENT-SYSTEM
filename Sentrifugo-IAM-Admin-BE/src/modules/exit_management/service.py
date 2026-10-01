import re
from datetime import datetime, timezone

from beanie import PydanticObjectId
from fastapi import HTTPException, status

from src.auth.models import UserDocument
from src.auth.schemas import UserBase
from src.auth.utils.authorization import caller_has_permission
from src.correlation import get_correlation_id
from src.logger import logger
from src.models import ModuleEnum, PermissionCodeEnum, StatusEnum
from src.rabbitmq import DebugLevel, outbox
from src.modules.exit_management.models import (
    ExitInterviewDocument,
    ExitRequestDocument,
    ITAssetReturnDocument,
    AdminTaskDocument,
    FinanceClearanceDocument,
    DepartmentChecklistDocument,
)
from src.modules.exit_management.schema import (
    ExitInterviewCreate,
    ExitRequestApproval,
    ExitRequestCreate,
    ExitRequestStatus,
    ExitRequestUpdate,
    ManagerApproveRequest,
    ManagerRejectRequest,
    ITAssetVerifyRequest,
    AdminTaskCompleteRequest,
    FinanceClearanceStatusRequest,
    DepartmentChecklistCreate,
    DepartmentChecklistUpdate,
)
from src.modules.organisation.models import DepartmentDocument, DesignationDocument, EmployeeDocument
from src.modules.exit_management import email_events
from src.master_data.models import MasterDataDocument

NOT_DELETED = {"deleted_on": None}

# Employment-lifecycle vocabulary. This is NOT account status (StatusEnum, which
# is only active/inactive) — it lives in the EMPLOYMENT_STATUSES master data and,
# on the wire, in the cross-service `employee.*` event contracts other teams
# already consume. Keep the wire values stable.
NOTICE_PERIOD_KEY = "notice-period"      # master-data key (see employment_statuses.json)
EXIT_KEY = "exit"                        # master-data key
NOTICE_PERIOD_EVENT_STATUS = "notice_period"   # employee.updated payload
EXIT_EVENT_STATUS = "exit"                     # employee.deleted payload


def _resolve_org(caller: UserBase) -> PydanticObjectId:
    if not caller.organisation_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No organisation context")
    return PydanticObjectId(caller.organisation_id)


async def _caller_is_hr(caller: UserBase) -> bool:
    """True when the caller holds the HR/approver grant (core_hr:approve_exit_request)
    — or is an org/super admin. HR/approvers may act on any employee's request;
    everyone else is limited to their own (IDOR guard, H9)."""
    return await caller_has_permission(
        caller, ModuleEnum.CORE_HR.value, PermissionCodeEnum.APPROVE_EXIT_REQUEST.value
    )


async def _require_owner_or_hr(doc: ExitRequestDocument, caller: UserBase) -> EmployeeDocument | None:
    """Enforce that the caller either owns the exit request (it belongs to their
    own employee record) or holds the HR/approver permission. Returns the loaded
    employee so callers can reuse it. Raises 403 otherwise (H9)."""
    emp = await EmployeeDocument.get(doc.employee_id)
    is_owner = emp is not None and emp.user_id is not None and str(emp.user_id) == str(caller.id)
    if not is_owner and not await _caller_is_hr(caller):
        raise HTTPException(status_code=403, detail="Access denied")
    return emp


async def _get_employee_for_user(org_id: PydanticObjectId, user_id: PydanticObjectId) -> EmployeeDocument:
    emp = await EmployeeDocument.find_one(
        EmployeeDocument.organisation_id == org_id,
        EmployeeDocument.user_id == user_id,
        NOT_DELETED,
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Employee record not found for current user")
    return emp


async def _generate_request_code(org_id: PydanticObjectId) -> str:
    now = datetime.now(timezone.utc)
    year = now.year
    count = await ExitRequestDocument.find(
        ExitRequestDocument.organisation_id == org_id,
        {"request_code": {"$regex": f"^EXR-{year}-"}},
    ).count()
    return f"EXR-{year}-{count + 1:04d}"


async def _enrich_response(doc: ExitRequestDocument, user: UserDocument | None = None, emp: EmployeeDocument | None = None) -> dict:
    data = doc.model_dump()
    data["id"] = doc.id
    if user:
        data["employee_name"] = f"{user.first_name or ''} {user.last_name or ''}".strip()
        data["employee_email"] = user.email
        # The employee's account status (active / notice_period / exit) — distinct
        # from the exit-request `status`. Lets the FE show the person's lifecycle
        # state alongside the request status.
        data["employee_status"] = user.status
    if emp:
        data["emp_code"] = emp.emp_code

    it_doc = await ITAssetReturnDocument.find_one(ITAssetReturnDocument.exit_request_id == doc.id, NOT_DELETED)
    data["it_clearance_status"] = it_doc.status if it_doc else None

    admin_doc = await AdminTaskDocument.find_one(AdminTaskDocument.exit_request_id == doc.id, NOT_DELETED)
    data["admin_clearance_status"] = admin_doc.status if admin_doc else None

    finance_doc = await FinanceClearanceDocument.find_one(FinanceClearanceDocument.exit_request_id == doc.id, NOT_DELETED)
    data["finance_clearance_status"] = finance_doc.status if finance_doc else None

    return data

async def create_exit_request(data: ExitRequestCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)

    # IDOR guard (H9): an employee may only file their OWN resignation. Filing on
    # behalf of another employee requires the HR/approver permission.
    if str(data.employee_id) != str(caller.id) and not await _caller_is_hr(caller):
        raise HTTPException(status_code=403, detail="You can only file your own exit request")

    user = await UserDocument.get(data.employee_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    emp = await EmployeeDocument.find_one(
        EmployeeDocument.user_id == data.employee_id,
        EmployeeDocument.organisation_id == org_id,
        NOT_DELETED,
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    if data.reason == "others" and not data.other_reason:
        raise HTTPException(status_code=400, detail="Other reason is required when reason is 'others'")

    request_code = await _generate_request_code(org_id)
    now = datetime.now(timezone.utc)
    
    status = ExitRequestStatus.PENDING_APPROVAL.value
        
    doc = ExitRequestDocument(
        organisation_id=org_id,
        employee_id=emp.id,
        request_code=request_code,
        last_working_day=data.last_working_day,
        reason=data.reason,
        other_reason=data.other_reason,
        additional_details=data.additional_details,
        document_ids=data.document_ids,
        exit_type=data.exit_type,
        hr_initiated=data.hr_initiated,
        immediate_exit=data.immediate_exit,
        status=status,
        created_by=str(caller.id),
        created_on=now,
        correlation_id=get_correlation_id(),
    )
    await doc.insert()
    employee_name = f"{user.first_name or ''} {user.last_name or ''}".strip()
    await email_events.publish_exit_request_raised(
        request_code=request_code,
        request_id=str(doc.id),
        employee_name=employee_name,
        last_working_day=str(data.last_working_day) if data.last_working_day else "",
        reason=data.reason,
        org_id=org_id,
        emp=emp,
        tenant_id=str(org_id),
    )
    await outbox.publish(
        "exit.applied",
        {
            "org_id": str(org_id),
            "user_id": str(emp.user_id),
            "employee_id": str(emp.id),
            "bu_id": str(emp.business_unit_id),
            "dept_id": str(emp.department_id),
            "exit_id": str(doc.id),
            "reason_for_exit": doc.reason,
            "last_working_day": str(doc.last_working_day) if doc.last_working_day else "" if doc.last_working_day else "",
            "event": "applied",
            "correlation_id": get_correlation_id(),
        },
        idempotency_key=f"exit.applied:{doc.id}",
    )
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_request_created",
        resource=f"exit_request:{doc.id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"request_code": request_code, "employee_id": str(emp.id), "reason": data.reason},
    )
    return await _enrich_response(doc, user, emp)


async def list_exit_requests(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    status_filter: str | None = None,
) -> list[dict]:
    org_id = _resolve_org(caller)

    query = {
        "organisation_id": org_id,
        **NOT_DELETED,
    }
    if status_filter:
        query["status"] = status_filter
    if search:
        query["$or"] = [
            {"reason": {"$regex": re.escape(search), "$options": "i"}},
            {"request_code": {"$regex": re.escape(search), "$options": "i"}},
        ]

    docs = await ExitRequestDocument.find(query).sort("-created_on").skip(skip).limit(limit).to_list()
    results = []
    for d in docs:
        emp = await EmployeeDocument.get(d.employee_id)
        user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
        results.append(await _enrich_response(d, user, emp))
    return results


async def get_exit_request(request_id: PydanticObjectId, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")

    # IDOR guard (H9): only the owning employee or an HR/approver may read it.
    emp = await _require_owner_or_hr(doc, caller)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    return await _enrich_response(doc, user, emp)


async def update_exit_request(request_id: PydanticObjectId, data: ExitRequestUpdate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    # IDOR guard (H9): only the owning employee or an HR/approver may update it.
    await _require_owner_or_hr(doc, caller)
    if doc.status != ExitRequestStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="Only pending requests can be updated")

    update_data = data.model_dump(exclude_none=True)
    now = datetime.now(timezone.utc)
    update_data["modified_by"] = str(caller.id)
    update_data["modified_on"] = now
    update_data["correlation_id"] = get_correlation_id()
    await doc.set(update_data)
    await doc.sync()

    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_request_updated",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"changed_fields": list(data.model_dump(exclude_none=True).keys())},
    )

    emp = await EmployeeDocument.get(doc.employee_id)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    return await _enrich_response(doc, user, emp)


async def withdraw_exit_request(request_id: PydanticObjectId, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    # IDOR guard (H9): only the owning employee or an HR/approver may withdraw it.
    await _require_owner_or_hr(doc, caller)
    if doc.status not in (ExitRequestStatus.PENDING_APPROVAL, ExitRequestStatus.APPROVED, ExitRequestStatus.AWAITING_CLEARANCES):
        raise HTTPException(status_code=400, detail="Only pending, approved, or awaiting clearance requests can be withdrawn")

    now = datetime.now(timezone.utc)
    await doc.set({
        "status": ExitRequestStatus.WITHDRAWN.value,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    })
    await doc.sync()

    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_request_withdrawn",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
    )

    emp = await EmployeeDocument.get(doc.employee_id)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    return await _enrich_response(doc, user, emp)


async def revoke_exit_request(request_id: PydanticObjectId, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc.status not in (ExitRequestStatus.APPROVED, ExitRequestStatus.AWAITING_CLEARANCES):
        raise HTTPException(status_code=400, detail="Only approved or awaiting clearance requests can be revoked")

    now = datetime.now(timezone.utc)
    await doc.set({
        "status": ExitRequestStatus.WITHDRAWN.value,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    })
    await doc.sync()

    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_request_revoked",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
    )

    emp = await EmployeeDocument.get(doc.employee_id)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    return await _enrich_response(doc, user, emp)


async def approve_exit_request(request_id: PydanticObjectId, data: ExitRequestApproval, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc.status != ExitRequestStatus.PENDING_APPROVAL:
        raise HTTPException(status_code=400, detail="Only pending requests can be approved/rejected")
    if data.status not in (ExitRequestStatus.APPROVED, ExitRequestStatus.REJECTED):
        raise HTTPException(status_code=400, detail="Status must be 'approved' or 'rejected'")
    if data.status == ExitRequestStatus.REJECTED and not data.rejection_reason:
        raise HTTPException(status_code=400, detail="Rejection reason is required")

    now = datetime.now(timezone.utc)
    update = {
        "status": data.status,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    }
    if data.status == ExitRequestStatus.APPROVED:
        update["approved_by"] = PydanticObjectId(caller.id)
        update["approved_on"] = now
    else:
        update["rejection_reason"] = data.rejection_reason

    await doc.set(update)
    await doc.sync()

    _decided = "exit_request_approved" if data.status == ExitRequestStatus.APPROVED else "exit_request_rejected"
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action=_decided,
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata=(
            {"rejection_reason": data.rejection_reason}
            if data.status == ExitRequestStatus.REJECTED else None
        ),
    )

    emp = await EmployeeDocument.get(doc.employee_id)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    return await _enrich_response(doc, user, emp)


async def reapply_exit_request(request_id: PydanticObjectId, data: ExitRequestCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    original = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not original:
        raise HTTPException(status_code=404, detail="Original exit request not found")
    if original.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if original.status != ExitRequestStatus.REJECTED:
        raise HTTPException(status_code=400, detail="Can only reapply for rejected requests")

    emp = await EmployeeDocument.find_one(
        EmployeeDocument.id == data.employee_id,
        EmployeeDocument.organisation_id == org_id,
        NOT_DELETED,
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    request_code = await _generate_request_code(org_id)
    now = datetime.now(timezone.utc)

    doc = ExitRequestDocument(
        organisation_id=org_id,
        employee_id=emp.id,
        request_code=request_code,
        last_working_day=data.last_working_day,
        reason=data.reason,
        other_reason=data.other_reason,
        additional_details=data.additional_details,
        document_ids=data.document_ids,
        parent_request_id=request_id,
        created_by=str(caller.id),
        created_on=now,
        correlation_id=get_correlation_id(),
    )
    await doc.insert()
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_request_reapplied",
        resource=f"exit_request:{doc.id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"parent_request_id": str(request_id), "request_code": request_code},
    )
    user = await UserDocument.get(caller.id)
    return await _enrich_response(doc, user, emp)

async def submit_exit_interview(request_id: PydanticObjectId, data: ExitInterviewCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    exit_req = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not exit_req:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if exit_req.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if exit_req.status not in (ExitRequestStatus.APPROVED, ExitRequestStatus.PENDING_APPROVAL, ExitRequestStatus.AWAITING_CLEARANCES, ExitRequestStatus.AWAITING_EXIT_INTERVIEW, ExitRequestStatus.COMPLETED, ExitRequestStatus.DEACTIVATED):
        raise HTTPException(status_code=400, detail="Exit interview can only be submitted for approved/pending requests")

    existing = await ExitInterviewDocument.find_one(
        ExitInterviewDocument.exit_request_id == request_id, NOT_DELETED,
    )
    if existing:
        raise HTTPException(status_code=400, detail="Exit interview already submitted")

    now = datetime.now(timezone.utc)

    doc = ExitInterviewDocument(
        organisation_id=org_id,
        exit_request_id=request_id,
        employee_id=exit_req.employee_id,
        reason_for_leaving=data.reason_for_leaving,
        other_reason=data.other_reason,
        overall_rating=data.overall_rating,
        liked_most=data.liked_most,
        improvements=data.improvements,
        manager_feedback=data.manager_feedback,
        created_by=str(caller.id),
        created_on=now,
        correlation_id=get_correlation_id(),
    )
    await doc.insert()
    await _check_and_complete_clearances(request_id)
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_interview_submitted",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"interview_id": str(doc.id)},
    )
    result = doc.model_dump()
    result["id"] = doc.id
    return result


async def get_exit_interview(request_id: PydanticObjectId, caller: UserBase) -> dict | None:
    org_id = _resolve_org(caller)
    doc = await ExitInterviewDocument.find_one(
        ExitInterviewDocument.exit_request_id == request_id, NOT_DELETED,
    )
    if not doc:
        return None
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    result = doc.model_dump()
    result["id"] = doc.id
    return result


async def _enrich_team_response(doc: ExitRequestDocument) -> dict:
    emp = await EmployeeDocument.get(doc.employee_id)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    data = await _enrich_response(doc, user, emp)

    data["employee_role"] = None
    data["department"] = None
    data["date_of_joining"] = None
    data["current_location"] = emp.seat_location if emp else None
    data["reporting_manager_name"] = None
    data["notice_period_days"] = 30

    if emp:
        data["date_of_joining"] = emp.date_of_joining

        if emp.designation_id:
            desig = await DesignationDocument.get(emp.designation_id)
            if desig:
                data["employee_role"] = desig.designation_name

        if emp.department_id:
            dept = await DepartmentDocument.get(emp.department_id)
            if dept:
                data["department"] = dept.department_name

        if emp.l1_manager_id:
            mgr_emp = await EmployeeDocument.get(emp.l1_manager_id)
            if mgr_emp and mgr_emp.user_id:
                mgr_user = await UserDocument.get(mgr_emp.user_id)
                if mgr_user:
                    data["reporting_manager_name"] = f"{mgr_user.first_name or ''} {mgr_user.last_name or ''}".strip()

    return data


async def list_team_exit_requests(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    status_filter: str | None = None,
    department: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> list[dict]:
    org_id = _resolve_org(caller)

    # TODO: restore l1_manager_id filtering after testing
    query: dict = {
        "organisation_id": org_id,
        **NOT_DELETED,
    }
    if status_filter:
        query["status"] = status_filter
    if search:
        name_match_user_ids = await UserDocument.find(
            {
                "$or": [
                    {"first_name": {"$regex": re.escape(search), "$options": "i"}},
                    {"last_name": {"$regex": re.escape(search), "$options": "i"}},
                ],
                **NOT_DELETED,
            }
        ).to_list()
        name_match_emp_ids = []
        if name_match_user_ids:
            user_id_set = {u.id for u in name_match_user_ids}
            emps = await EmployeeDocument.find({"user_id": {"$in": list(user_id_set)}, "organisation_id": org_id}).to_list()
            name_match_emp_ids = [e.id for e in emps]

        query["$or"] = [
            {"reason": {"$regex": re.escape(search), "$options": "i"}},
            {"request_code": {"$regex": re.escape(search), "$options": "i"}},
        ]
        if name_match_emp_ids:
            query["$or"].append({"employee_id": {"$in": name_match_emp_ids}})
    if from_date:
        query.setdefault("created_on", {})["$gte"] = datetime.fromisoformat(from_date)
    if to_date:
        query.setdefault("created_on", {})["$lte"] = datetime.fromisoformat(to_date + "T23:59:59")

    if department:
        dept_doc = await DepartmentDocument.find_one(
            {
                "organisation_id": org_id,
                "department_name": {"$regex": re.escape(department), "$options": "i"},
                **NOT_DELETED,
            }
        )
        if dept_doc:
            dept_emps = await EmployeeDocument.find({"department_id": dept_doc.id, "organisation_id": org_id}).to_list()
            dept_emp_ids = [e.id for e in dept_emps]
            query["employee_id"] = {"$in": dept_emp_ids}
        else:
            return []

    docs = await ExitRequestDocument.find(query).sort("-created_on").skip(skip).limit(limit).to_list()
    results = []
    for d in docs:
        results.append(await _enrich_team_response(d))
    return results


async def get_team_exit_summary(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)

    # TODO: restore l1_manager_id filtering after testing
    base_query = {
        "organisation_id": org_id,
        **NOT_DELETED,
    }

    total = await ExitRequestDocument.find(base_query).count()

    counts = {}
    for s in ["pending_approval", "under_review", "approved", "rejected", "withdrawn"]:
        counts[s] = await ExitRequestDocument.find({**base_query, "status": s}).count()

    return {
        "total": total,
        "pending_approval": counts["pending_approval"],
        "under_review": counts["under_review"],
        "approved": counts["approved"],
        "rejected": counts["rejected"],
        "withdrawn": counts["withdrawn"],
    }


async def manager_approve_request(
    request_id: PydanticObjectId, data: ManagerApproveRequest, caller: UserBase
) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc.status not in (ExitRequestStatus.PENDING_APPROVAL, ExitRequestStatus.UNDER_REVIEW):
        raise HTTPException(status_code=400, detail="Only pending or under-review requests can be approved")

    # TODO: restore l1_manager_id check after testing
    now = datetime.now(timezone.utc)
    update = {
        "status": ExitRequestStatus.APPROVED.value,
        "approved_by": PydanticObjectId(caller.id),
        "approved_on": now,
        "requested_last_working_day": doc.last_working_day,
        "last_working_day": data.final_last_working_day if data.final_last_working_day else doc.last_working_day,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    }
    if data.comments:
        update["additional_details"] = (doc.additional_details or "") + f"\n[Manager Comment]: {data.comments}"
    if data.completed_checklist:
        update["manager_completed_checklist"] = data.completed_checklist

    await doc.set(update)
    await doc.sync()

    emp = await EmployeeDocument.get(doc.employee_id)
    emp_user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    if emp_user:
        manager_name = f"{caller.first_name or ''} {caller.last_name or ''}".strip()
        await email_events.publish_exit_manager_approved(
            request_code=doc.request_code,
            request_id=str(doc.id),
            employee_name=f"{emp_user.first_name or ''} {emp_user.last_name or ''}".strip(),
            employee_email=emp_user.email,
            last_working_day=str(doc.last_working_day) if doc.last_working_day else "",
            manager_name=manager_name,
            org_id=org_id,
            tenant_id=str(org_id),
        )

        # NOTICE PERIOD — manager approval starts the employee's notice period.
        # This is an EMPLOYMENT-lifecycle change, not an account one: the employee
        # is still working and keeps full access, so user.status stays ACTIVE and
        # the notice state is recorded on employee.employment_status (the
        # EMPLOYMENT_STATUSES master data owns this vocabulary).
        notice_status_doc = await MasterDataDocument.find_one(
            {"category": "EMPLOYMENT_STATUSES", "key": NOTICE_PERIOD_KEY}
        )
        if notice_status_doc:
            emp.employment_status = notice_status_doc.id
            await emp.save()
        else:
            logger.warning(
                "EMPLOYMENT_STATUSES master row missing — notice status not recorded",
                key=NOTICE_PERIOD_KEY, employee_id=str(emp.id),
            )

        # Notify other services that this employee is now serving notice. This REUSES
        # the existing `employee.updated` routing key on the `domain_events` topic
        # exchange and carries the new `status` so the consumer needs no extra IAM
        # lookup. (last_working_day is included so notice-window rules can be applied.)
        #
        # `status` is the EMPLOYMENT status, not the account status — the wire value
        # stays "notice_period" (a cross-service contract other teams consume); only
        # IAM's local account column dropped the state.
        #
        # LEAVE-MANAGEMENT CONSUMER — to honour the `allow_during_notice`
        # entitlement-policy flag (today config-only / unenforced) you must:
        #   1. start consuming `employee.updated` (not consumed today), and
        #   2. persist `status` on the employee replica (no status field today), then
        #   3. block/allow leave requests when status == "notice_period" per the flag.
        await outbox.publish(
            "employee.updated",
            {
                "user_id": str(emp_user.id),
                "employee_id": str(emp.id),
                "organisation_id": str(org_id),
                "status": NOTICE_PERIOD_EVENT_STATUS,
                "last_working_day": str(doc.last_working_day) if doc.last_working_day else "",
                "correlation_id": get_correlation_id(),
            },
            idempotency_key=f"employee.notice_period:{emp_user.id}:{doc.id}",
        )
        await outbox.publish(
            "exit.approved",
            {
                "org_id": str(org_id),
                "user_id": str(emp_user.id),
                "employee_id": str(emp.id),
                "bu_id": str(emp.business_unit_id),
                "dept_id": str(emp.department_id),
                "exit_id": str(doc.id),
                "reason_for_exit": doc.reason,
                "last_working_day": str(doc.last_working_day) if doc.last_working_day else "",
                "event": "approved",
                "correlation_id": get_correlation_id(),
            },
            idempotency_key=f"exit.approved:{doc.id}",
        )
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_manager_approved",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"last_working_day": str(doc.last_working_day) if doc.last_working_day else None},
    )
    return await _enrich_team_response(doc)


async def manager_reject_request(
    request_id: PydanticObjectId, data: ManagerRejectRequest, caller: UserBase
) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc.status not in (ExitRequestStatus.PENDING_APPROVAL, ExitRequestStatus.UNDER_REVIEW):
        raise HTTPException(status_code=400, detail="Only pending or under-review requests can be rejected")

    if data.action_type not in ("standard", "retention"):
        raise HTTPException(status_code=400, detail="Action type must be 'standard' or 'retention'")

    # TODO: restore l1_manager_id check after testing
    now = datetime.now(timezone.utc)
    rejection_reason = f"[{data.action_type.title()}] {data.comments}"

    update = {
        "status": ExitRequestStatus.REJECTED.value,
        "rejection_reason": rejection_reason,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    }
    if data.completed_checklist:
        update["manager_completed_checklist"] = data.completed_checklist

    await doc.set(update)
    await doc.sync()

    emp = await EmployeeDocument.get(doc.employee_id)
    emp_user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    if emp_user:
        manager_name = f"{caller.first_name or ''} {caller.last_name or ''}".strip()
        await email_events.publish_exit_manager_rejected(
            request_code=doc.request_code,
            request_id=str(doc.id),
            employee_name=f"{emp_user.first_name or ''} {emp_user.last_name or ''}".strip(),
            employee_email=emp_user.email,
            rejection_reason=rejection_reason,
            manager_name=manager_name,
            org_id=org_id,
            tenant_id=str(org_id),
        )
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="exit_manager_rejected",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"rejection_reason": rejection_reason},
    )
    return await _enrich_team_response(doc)


async def deactivate_employee(request_id: PydanticObjectId, caller: UserBase, hr_checklist=None) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")

    now = datetime.now(timezone.utc)
    update = {
        "status": ExitRequestStatus.DEACTIVATED.value,
        "deactivated_by": PydanticObjectId(caller.id),
        "deactivated_on": now,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": get_correlation_id(),
    }
    if hr_checklist and hr_checklist.completed_checklist:
        update["hr_completed_checklist"] = hr_checklist.completed_checklist

    await doc.set(update)
    await doc.sync()

    emp = await EmployeeDocument.get(doc.employee_id)
    user_id = emp.user_id if emp else None
    user = None
    if user_id:
        # EXIT — HR deactivation is the single point where an employee fully exits.
        # Covers BOTH immediate exits and those who finished their notice period.
        # The status change is local (same microservice as employee/org-setup), so
        # no event is needed for the flip itself.
        status_key = doc.reason if doc.hr_initiated else EXIT_KEY
        query: dict = {"category": 'EMPLOYMENT_STATUSES', "key": status_key}
        employment_status_doc = await MasterDataDocument.find_one(query)
        if not employment_status_doc:
            query = {"category": 'EMPLOYMENT_STATUSES', "key": EXIT_KEY}
            employment_status_doc = await MasterDataDocument.find_one(query)
        emp.employment_status = employment_status_doc.id
        await emp.save()
        # The ACCOUNT is simply switched off. It previously stored the employment
        # status KEY here ("exit", but also "absconded"/"terminated"/... on an
        # HR-initiated exit) — values that aren't account statuses at all and would
        # fail StatusEnum validation on the next read of that user.
        await UserDocument.find_one({"_id": user_id}).update(
            {"$set": {"status": StatusEnum.INACTIVE.value}}
        )
        user = await UserDocument.get(user_id)

        # Propagate the user-account status flip — downstream replicas gate on
        # it and would otherwise keep the creation-time status forever.
        await outbox.publish(
            "user.updated",
            {
                "correlation_id": get_correlation_id(),
                "user_id": str(user_id),
                "status": StatusEnum.INACTIVE.value,
            },
            idempotency_key=f"user.exit_status:{user_id}:{doc.id}",
        )

        # Notify other services that the employee has exited. We REUSE the existing
        # `employee.deleted` routing key on the `domain_events` topic exchange, but
        # note this is a status transition to EXIT — NOT a hard/soft delete of the
        # employee record. The `status: "exit"` field lets the consumer branch on it.
        # Both ids are included so the consumer needs no extra IAM lookup.
        #
        # LEAVE-MANAGEMENT CONSUMER (_handle_employee_deleted) — on status == "exit",
        # in ADDITION to the existing active/inactive handling (cancel pending leave),
        # you must:
        #   1. disable the employee's assigned WORK + HOLIDAY calendar mapping
        #      (the per-employee EMP_MAP calendar override), and
        #   2. invalidate the Valkey calendar cache for this employee via
        #      invalidate_calendar() (keys: emp:{id}:calendar, work_calendar:{id}).
        # Interim mitigation until that consumer lands: keep the calendar cache TTL
        # at ~2 minutes so a disabled calendar is not served stale for long.
        await outbox.publish(
            "employee.deleted",
            {
                "user_id": str(user.id),
                "employee_id": str(emp.id),
                "organisation_id": str(org_id),
                # Employment lifecycle on the wire — unchanged cross-service contract.
                "status": EXIT_EVENT_STATUS,
                "correlation_id": get_correlation_id(),
            },
            idempotency_key=f"employee.exit:{user.id}:{doc.id}",
        )
        await outbox.publish(
            "exit.deactivated",
            {
                "org_id": str(org_id),
                "user_id": str(user.id),
                "employee_id": str(emp.id),
                "bu_id": str(emp.business_unit_id),
                "dept_id": str(emp.department_id),
                "exit_id": str(doc.id),
                "reason_for_exit": doc.reason,
                "last_working_day": str(doc.last_working_day) if doc.last_working_day else "",
                "event": "deactivated",
                "correlation_id": get_correlation_id(),
            },
            idempotency_key=f"exit.deactivated:{doc.id}",
        )
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="employee_deactivated",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"employee_id": str(emp.id) if emp else None},
    )
    return await _enrich_response(doc, user, emp)

async def send_clearance_reminder(request_id: PydanticObjectId, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")

    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"Clearance reminder sent for exit request {request_id} by {caller.id}")

    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="clearance_reminder_sent",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
    )
    return {"status": "success", "message": "Reminder sent successfully"}


async def initiate_clearances(request_id: PydanticObjectId, caller: UserBase, hr_checklist=None) -> dict:
    import traceback as tb
    org_id = _resolve_org(caller)
    doc = await ExitRequestDocument.find_one(
        ExitRequestDocument.id == request_id, NOT_DELETED,
    )
    if not doc:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if doc.organisation_id != org_id:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc.status != ExitRequestStatus.APPROVED.value:
        raise HTTPException(status_code=400, detail=f"Only approved requests can have clearances initiated. Current status: {doc.status}")

    now = datetime.now(timezone.utc)
    correlation_id = get_correlation_id()
    audit = {
        "created_by": str(caller.id),
        "created_on": now,
        "modified_by": str(caller.id),
        "modified_on": now,
        "correlation_id": correlation_id,
    }

    try:
        existing_it = await ITAssetReturnDocument.find_one(
            ITAssetReturnDocument.exit_request_id == doc.id,
        )
        existing_admin = await AdminTaskDocument.find_one(
            AdminTaskDocument.exit_request_id == doc.id,
        )
        existing_finance = await FinanceClearanceDocument.find_one(
            FinanceClearanceDocument.exit_request_id == doc.id,
        )

        if not existing_it:
            await ITAssetReturnDocument(
                organisation_id=org_id,
                exit_request_id=doc.id,
                employee_id=doc.employee_id,
                asset_type="laptop",
                asset_id="pending_audit",
                serial_number="pending_audit",
                model="pending_audit",
                status="pending",
                **audit,
            ).insert()

        if not existing_admin:
            await AdminTaskDocument(
                organisation_id=org_id,
                exit_request_id=doc.id,
                employee_id=doc.employee_id,
                task_type="id_card_return",
                details="Return ID card, access cards, and any company property",
                status="pending",
                **audit,
            ).insert()

        if not existing_finance:
            emp = await EmployeeDocument.get(doc.employee_id)
            notice_days = 0
            if emp and hasattr(emp, "notice_period_days") and emp.notice_period_days:
                notice_days = emp.notice_period_days
            await FinanceClearanceDocument(
                organisation_id=org_id,
                exit_request_id=doc.id,
                employee_id=doc.employee_id,
                notice_period_days=notice_days,
                status="pending",
                **audit,
            ).insert()

        clearance_update = {
            "status": ExitRequestStatus.AWAITING_CLEARANCES.value,
            "modified_by": str(caller.id),
            "modified_on": now,
            "correlation_id": correlation_id,
        }
        if hr_checklist and hr_checklist.completed_checklist:
            clearance_update["hr_completed_checklist"] = hr_checklist.completed_checklist
        await doc.set(clearance_update)
    except Exception as e:
        logger.error(f"Failed to initiate clearances: {e}\n{tb.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to initiate clearances: {str(e)}")
    await doc.sync()

    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="clearances_initiated",
        resource=f"exit_request:{request_id}",
        debug_level=DebugLevel.ADMIN,
    )

    emp_for_email = await EmployeeDocument.get(doc.employee_id)
    emp_user_for_email = await UserDocument.get(emp_for_email.user_id) if emp_for_email and emp_for_email.user_id else None
    if emp_user_for_email:
        employee_name = f"{emp_user_for_email.first_name or ''} {emp_user_for_email.last_name or ''}".strip()
        await email_events.publish_exit_clearances_initiated(
            request_code=doc.request_code,
            request_id=str(doc.id),
            employee_name=employee_name,
            employee_email=emp_user_for_email.email,
            last_working_day=str(doc.last_working_day) if doc.last_working_day else "",
            org_id=org_id,
            emp=emp_for_email,
            tenant_id=str(org_id),
        )
        await email_events.publish_exit_clearances_assigned(
            request_code=doc.request_code,
            request_id=str(doc.id),
            employee_name=employee_name,
            last_working_day=str(doc.last_working_day) if doc.last_working_day else "",
            org_id=org_id,
            tenant_id=str(org_id),
        )

    return {"status": "success", "message": "Clearances initiated successfully"}


async def _enrich_hr_response(doc: ExitRequestDocument) -> dict:
    emp = await EmployeeDocument.get(doc.employee_id)
    user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
    data = await _enrich_response(doc, user, emp)

    data["employee_role"] = None
    data["department"] = None
    data["sub_dept"] = None
    data["date_of_joining"] = None
    data["current_location"] = emp.seat_location if emp else None
    data["reporting_manager_name"] = None
    data["notice_period_days"] = 30
    data["emp_type"] = str(emp.employment_type) if emp and getattr(emp, "employment_type", None) else "Permanent"
    data["grade"] = None
    data["phone"] = user.phone if user else None

    if emp:
        data["date_of_joining"] = emp.date_of_joining

        if getattr(emp, "designation_id", None):
            desig = await DesignationDocument.get(emp.designation_id)
            if desig:
                data["employee_role"] = desig.designation_name

        if getattr(emp, "department_id", None):
            dept = await DepartmentDocument.get(emp.department_id)
            if dept:
                data["department"] = dept.department_name

        if getattr(emp, "l1_manager_id", None):
            mgr_emp = await EmployeeDocument.get(emp.l1_manager_id)
            if mgr_emp and mgr_emp.user_id:
                mgr_user = await UserDocument.get(mgr_emp.user_id)
                if mgr_user:
                    data["reporting_manager_name"] = f"{mgr_user.first_name or ''} {mgr_user.last_name or ''}".strip()
                    
    return data

async def list_hr_exit_requests(
    caller: UserBase,
    skip: int = 0,
    limit: int = 20,
    search: str = "",
    status_filter: str | None = None,
    department: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> list[dict]:
    org_id = _resolve_org(caller)

    query: dict = {
        "organisation_id": org_id,
        **NOT_DELETED,
    }
    
    if status_filter:
        query["status"] = status_filter
        
    if search:
        name_match_user_ids = await UserDocument.find(
            {
                "$or": [
                    {"first_name": {"$regex": re.escape(search), "$options": "i"}},
                    {"last_name": {"$regex": re.escape(search), "$options": "i"}},
                ],
                **NOT_DELETED,
            }
        ).to_list()
        
        name_match_emp_ids = []
        if name_match_user_ids:
            user_id_set = {u.id for u in name_match_user_ids}
            emps = await EmployeeDocument.find({"user_id": {"$in": list(user_id_set)}, "organisation_id": org_id}).to_list()
            name_match_emp_ids = [e.id for e in emps]

        query["$or"] = [
            {"reason": {"$regex": re.escape(search), "$options": "i"}},
            {"request_code": {"$regex": re.escape(search), "$options": "i"}},
        ]
        if name_match_emp_ids:
            query["$or"].append({"employee_id": {"$in": name_match_emp_ids}})

    if from_date:
        query.setdefault("created_on", {})["$gte"] = datetime.fromisoformat(from_date)
    if to_date:
        query.setdefault("created_on", {})["$lte"] = datetime.fromisoformat(to_date + "T23:59:59")

    if department:
        dept_doc = await DepartmentDocument.find_one(
            {
                "organisation_id": org_id,
                "department_name": {"$regex": re.escape(department), "$options": "i"},
                **NOT_DELETED,
            }
        )
        if dept_doc:
            dept_emps = await EmployeeDocument.find({"department_id": dept_doc.id, "organisation_id": org_id}).to_list()
            dept_emp_ids = [e.id for e in dept_emps]
            if "employee_id" in query:
                if isinstance(query["employee_id"], dict) and "$in" in query["employee_id"]:
                    query["employee_id"]["$in"] = list(set(query["employee_id"]["$in"]) & set(dept_emp_ids))
            else:
                query["employee_id"] = {"$in": dept_emp_ids}
        else:
            return []

    docs = await ExitRequestDocument.find(query).sort("-created_on").skip(skip).limit(limit).to_list()
    results = []
    for d in docs:
        try:
            results.append(await _enrich_hr_response(d))
        except Exception as e:
            logger.error(f"Failed to enrich HR exit request {d.id}: {e}")
    return results

async def get_hr_exit_summary(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)

    base_query = {
        "organisation_id": org_id,
        **NOT_DELETED,
    }

    total = await ExitRequestDocument.find(base_query).count()

    counts = {}
    for s in ["pending_approval", "under_review", "awaiting_clearances", "completed"]:
        counts[s] = await ExitRequestDocument.find({**base_query, "status": s}).count()

    return {
        "total": total,
        "in_progress": counts["pending_approval"] + counts["under_review"],
        "pending_tasks": 0,
        "awaiting_clearances": counts["awaiting_clearances"],
        "completed": counts["completed"],
    }


# --- IT Asset Flow ---

async def list_it_assets(
    caller: UserBase, skip: int = 0, limit: int = 20, search: str = "", status_filter: str | None = None, asset_type: str | None = None
) -> list[dict]:
    org_id = _resolve_org(caller)
    query = {"organisation_id": org_id, **NOT_DELETED}
    if status_filter and status_filter != "all":
        query["status"] = status_filter
    if asset_type and asset_type != "all":
        query["asset_type"] = asset_type
    
    docs = await ITAssetReturnDocument.find(query).skip(skip).limit(limit).to_list()
    res = []
    for d in docs:
        emp = await EmployeeDocument.find_one(EmployeeDocument.id == d.employee_id)
        user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
        d_dict = d.model_dump()
        d_dict["employee_name"] = (
            f"{user.first_name or ''} {user.last_name or ''}".strip()
            if user else "Unknown"
        )
        d_dict["emp_code"] = emp.emp_code if emp else "Unknown" 
        
        exit_req = await ExitRequestDocument.find_one(ExitRequestDocument.id == d.exit_request_id)
        d_dict["last_working_day"] = exit_req.last_working_day if exit_req else None
        d_dict["request_code"] = exit_req.request_code if exit_req else None
        
        d_dict["it_clearance_status"] = d.status
        if exit_req:
            admin_doc = await AdminTaskDocument.find_one(AdminTaskDocument.exit_request_id == exit_req.id, NOT_DELETED)
            d_dict["admin_clearance_status"] = admin_doc.status if admin_doc else None
            finance_doc = await FinanceClearanceDocument.find_one(FinanceClearanceDocument.exit_request_id == exit_req.id, NOT_DELETED)
            d_dict["finance_clearance_status"] = finance_doc.status if finance_doc else None

        if emp and emp.department_id:
            dept = await DepartmentDocument.find_one(DepartmentDocument.id == emp.department_id)
            d_dict["department"] = dept.department_name if dept else "Unknown"

        res.append(d_dict)
    return res

async def get_it_assets_summary(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    base_query = {"organisation_id": org_id, **NOT_DELETED}
    total = await ITAssetReturnDocument.find(base_query).count()
    pending = await ITAssetReturnDocument.find({**base_query, "status": "pending"}).count()
    returned = await ITAssetReturnDocument.find({**base_query, "status": "returned"}).count()
    verified = await ITAssetReturnDocument.find({**base_query, "status": "verified"}).count()
    not_cleared = await ITAssetReturnDocument.find({**base_query, "status": "not_cleared"}).count()
    return {"total": total, "pending": pending, "returned": returned, "verified": verified, "not_cleared": not_cleared}

async def _check_and_complete_clearances(exit_request_id: PydanticObjectId) -> None:
    it_doc = await ITAssetReturnDocument.find_one(
        ITAssetReturnDocument.exit_request_id == exit_request_id, NOT_DELETED
    )
    admin_doc = await AdminTaskDocument.find_one(
        AdminTaskDocument.exit_request_id == exit_request_id, NOT_DELETED
    )
    finance_doc = await FinanceClearanceDocument.find_one(
        FinanceClearanceDocument.exit_request_id == exit_request_id, NOT_DELETED
    )

    it_done = it_doc and it_doc.status == "verified"
    admin_done = admin_doc and admin_doc.status == "completed"
    finance_done = finance_doc and finance_doc.status in ("approved", "paid", "sent_to_payroll")

    if it_done and admin_done and finance_done:
        exit_doc = await ExitRequestDocument.find_one(
            ExitRequestDocument.id == exit_request_id, NOT_DELETED
        )
        if exit_doc and exit_doc.status in (ExitRequestStatus.AWAITING_CLEARANCES.value, ExitRequestStatus.AWAITING_EXIT_INTERVIEW.value):
            interview = await ExitInterviewDocument.find_one(
                ExitInterviewDocument.exit_request_id == exit_request_id, NOT_DELETED
            )
            if interview:
                now = datetime.now(timezone.utc)
                await exit_doc.set({
                    "status": ExitRequestStatus.COMPLETED.value,
                    "modified_on": now,
                })
            else:
                now = datetime.now(timezone.utc)
                await exit_doc.set({
                    "status": ExitRequestStatus.AWAITING_EXIT_INTERVIEW.value,
                    "modified_on": now,
                })
                
            if interview and exit_doc.status != ExitRequestStatus.COMPLETED.value:
                emp_doc = await EmployeeDocument.get(exit_doc.employee_id)
                emp_user_doc = await UserDocument.get(emp_doc.user_id) if emp_doc and emp_doc.user_id else None
                if emp_user_doc and emp_doc:
                    await email_events.publish_exit_completed(
                        request_code=exit_doc.request_code,
                        request_id=str(exit_doc.id),
                        employee_name=f"{emp_user_doc.first_name or ''} {emp_user_doc.last_name or ''}".strip(),
                        employee_email=emp_user_doc.email,
                        last_working_day=str(exit_doc.last_working_day) if exit_doc.last_working_day else "",
                        org_id=exit_doc.organisation_id,
                        emp=emp_doc,
                        tenant_id=str(exit_doc.organisation_id),
                    )


async def verify_it_asset(asset_id: PydanticObjectId, payload: ITAssetVerifyRequest, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await ITAssetReturnDocument.find_one(ITAssetReturnDocument.id == asset_id, ITAssetReturnDocument.organisation_id == org_id, NOT_DELETED)
    if not doc:
        raise HTTPException(status_code=404, detail="Asset return not found")
    
    if hasattr(payload, "status") and payload.status:
        doc.status = payload.status
    else:
        doc.status = "verified"
    doc.condition = payload.condition
    doc.verification_notes = payload.verification_notes
    doc.completed_checklist = payload.completed_checklist
    doc.verified_by = PydanticObjectId(caller.id)
    doc.verified_on = datetime.now(timezone.utc)
    await doc.save()
    await _check_and_complete_clearances(doc.exit_request_id)
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="it_asset_verified",
        resource=f"exit_request:{doc.exit_request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"asset_id": str(asset_id), "status": doc.status},
    )
    return {"status": "success", "message": "Asset verified"}


# --- Admin Flow ---

async def list_admin_tasks(
    caller: UserBase, skip: int = 0, limit: int = 20, search: str = "", status_filter: str | None = None, task_type: str | None = None
) -> list[dict]:
    org_id = _resolve_org(caller)
    query = {"organisation_id": org_id, **NOT_DELETED}
    if status_filter and status_filter != "all":
        query["status"] = status_filter
    if task_type and task_type != "all":
        query["task_type"] = task_type
        
    docs = await AdminTaskDocument.find(query).skip(skip).limit(limit).to_list()
    res = []
    for d in docs:
        emp = await EmployeeDocument.find_one(EmployeeDocument.id == d.employee_id)
        user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
        d_dict = d.model_dump()
        d_dict["employee_name"] = (
            f"{user.first_name or ''} {user.last_name or ''}".strip()
            if user else "Unknown"
        )
        d_dict["emp_code"] = emp.emp_code if emp else "Unknown" 
        
        exit_req = await ExitRequestDocument.find_one(ExitRequestDocument.id == d.exit_request_id)
        d_dict["last_working_day"] = exit_req.last_working_day if exit_req else None
        d_dict["request_code"] = exit_req.request_code if exit_req else None
        
        d_dict["admin_clearance_status"] = d.status
        if exit_req:
            it_doc = await ITAssetReturnDocument.find_one(ITAssetReturnDocument.exit_request_id == exit_req.id, NOT_DELETED)
            d_dict["it_clearance_status"] = it_doc.status if it_doc else None
            finance_doc = await FinanceClearanceDocument.find_one(FinanceClearanceDocument.exit_request_id == exit_req.id, NOT_DELETED)
            d_dict["finance_clearance_status"] = finance_doc.status if finance_doc else None

        if emp and emp.department_id:
            dept = await DepartmentDocument.find_one(DepartmentDocument.id == emp.department_id)
            d_dict["department"] = dept.department_name if dept else "Unknown"

        res.append(d_dict)
    return res

async def get_admin_tasks_summary(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    base_query = {"organisation_id": org_id, **NOT_DELETED}
    total = await AdminTaskDocument.find(base_query).count()
    pending = await AdminTaskDocument.find({**base_query, "status": "pending"}).count()
    returned = await AdminTaskDocument.find({**base_query, "status": "returned"}).count()
    completed = await AdminTaskDocument.find({**base_query, "status": "completed"}).count()
    not_cleared = await AdminTaskDocument.find({**base_query, "status": "not_cleared"}).count()
    return {"total": total, "pending": pending, "returned": returned, "completed": completed, "not_cleared": not_cleared}

async def complete_admin_task(task_id: PydanticObjectId, payload: AdminTaskCompleteRequest, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await AdminTaskDocument.find_one(AdminTaskDocument.id == task_id, AdminTaskDocument.organisation_id == org_id, NOT_DELETED)
    if not doc:
        raise HTTPException(status_code=404, detail="Task not found")
        
    if hasattr(payload, "status") and payload.status:
        doc.status = payload.status
    else:
        doc.status = "completed"
    doc.completed_checklist = payload.completed_checklist
    doc.notes = payload.notes
    doc.completed_by = PydanticObjectId(caller.id)
    doc.completed_on = datetime.now(timezone.utc)
    await doc.save()
    await _check_and_complete_clearances(doc.exit_request_id)
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="admin_task_completed",
        resource=f"exit_request:{doc.exit_request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"task_id": str(task_id), "status": doc.status},
    )
    return {"status": "success", "message": "Task completed"}


# --- Finance Flow ---

async def list_finance_requests(
    caller: UserBase, skip: int = 0, limit: int = 20, search: str = "", status_filter: str | None = None, department: str | None = None, from_date: str | None = None, to_date: str | None = None
) -> list[dict]:
    org_id = _resolve_org(caller)
    query = {"organisation_id": org_id, **NOT_DELETED}
    if status_filter and status_filter != "all":
        query["status"] = status_filter
        
    if department and department != "all":
        dept_doc = await DepartmentDocument.find_one(DepartmentDocument.name == department, DepartmentDocument.organisation_id == org_id, NOT_DELETED)
        if dept_doc:
            managed_employees = await EmployeeDocument.find(EmployeeDocument.organisation_id == org_id, EmployeeDocument.department_id == dept_doc.id, NOT_DELETED).to_list()
            dept_emp_ids = [e.id for e in managed_employees]
            query["employee_id"] = {"$in": dept_emp_ids}
        else:
            return []
            
    docs = await FinanceClearanceDocument.find(query).sort("-created_on").skip(skip).limit(limit).to_list()
    res = []
    for d in docs:
        emp = await EmployeeDocument.find_one(EmployeeDocument.id == d.employee_id)
        user = await UserDocument.get(emp.user_id) if emp and emp.user_id else None
        d_dict = d.model_dump()
        d_dict["employee_name"] = (
            f"{user.first_name or ''} {user.last_name or ''}".strip()
            if user else "Unknown"
        )
        d_dict["emp_code"] = emp.emp_code if emp else "Unknown"
        
        exit_req = await ExitRequestDocument.find_one(ExitRequestDocument.id == d.exit_request_id)
        d_dict["last_working_day"] = exit_req.last_working_day if exit_req else None
        d_dict["request_code"] = exit_req.request_code if exit_req else None
        
        d_dict["finance_clearance_status"] = d.status
        if exit_req:
            it_doc = await ITAssetReturnDocument.find_one(ITAssetReturnDocument.exit_request_id == exit_req.id, NOT_DELETED)
            d_dict["it_clearance_status"] = it_doc.status if it_doc else None
            admin_doc = await AdminTaskDocument.find_one(AdminTaskDocument.exit_request_id == exit_req.id, NOT_DELETED)
            d_dict["admin_clearance_status"] = admin_doc.status if admin_doc else None

        if emp:
            if emp.department_id:
                dept = await DepartmentDocument.find_one(DepartmentDocument.id == emp.department_id)
                d_dict["department"] = dept.department_name if dept else "Unknown"
            if emp.designation_id:
                desig = await DesignationDocument.find_one(DesignationDocument.id == emp.designation_id)
                d_dict["designation"] = desig.designation_name if desig else "Unknown"
            if emp.l1_manager_id:
                mgr_emp = await EmployeeDocument.find_one(EmployeeDocument.id == emp.l1_manager_id)
                mgr_user = await UserDocument.get(mgr_emp.user_id) if mgr_emp and mgr_emp.user_id else None
                d_dict["reporting_manager_name"] = (
                    f"{mgr_user.first_name or ''} {mgr_user.last_name or ''}".strip()
                    if mgr_user else "Unknown"
                )   
                
        res.append(d_dict)
    return res

async def get_finance_summary(caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    base_query = {"organisation_id": org_id, **NOT_DELETED}
    total = await FinanceClearanceDocument.find(base_query).count()
    pending = await FinanceClearanceDocument.find({**base_query, "status": "pending"}).count()
    under_review = await FinanceClearanceDocument.find({**base_query, "status": "under_review"}).count()
    approved = await FinanceClearanceDocument.find({**base_query, "status": "approved"}).count()
    sent_to_payroll = await FinanceClearanceDocument.find({**base_query, "status": "sent_to_payroll"}).count()
    paid = await FinanceClearanceDocument.find({**base_query, "status": "paid"}).count()
    not_cleared = await FinanceClearanceDocument.find({**base_query, "status": "not_cleared"}).count()
    
    return {
        "total": total, 
        "pending": pending,
        "under_review": under_review,
        "approved": approved,
        "sent_to_payroll": sent_to_payroll,
        "paid": paid,
        "not_cleared": not_cleared
    }

async def update_finance_status(request_id: PydanticObjectId, payload: FinanceClearanceStatusRequest, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    doc = await FinanceClearanceDocument.find_one(FinanceClearanceDocument.id == request_id, FinanceClearanceDocument.organisation_id == org_id, NOT_DELETED)
    if not doc:
        raise HTTPException(status_code=404, detail="Clearance request not found")
        
    doc.status = payload.status
    if payload.status == "not_cleared":
        if not payload.clearance_reason or not payload.remarks:
            raise HTTPException(status_code=400, detail="Reason and remarks required when not cleared")
        doc.clearance_reason = payload.clearance_reason
        doc.remarks = payload.remarks
    else:
        doc.clearance_reason = None
        doc.remarks = payload.remarks
        doc.completed_checklist = payload.completed_checklist
        doc.cleared_by = PydanticObjectId(caller.id)
        doc.cleared_on = datetime.now(timezone.utc)
        
    await doc.save()
    await _check_and_complete_clearances(doc.exit_request_id)
    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="finance_status_updated",
        resource=f"exit_request:{doc.exit_request_id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"finance_clearance_id": str(request_id), "status": payload.status},
    )
    return {"status": "success", "message": "Clearance status updated"}

async def get_checklists(caller: UserBase, dept_id: str | None = None) -> list[dict]:
    org_id = _resolve_org(caller)
    query = {"organisation_id": org_id, **NOT_DELETED}
    if dept_id:
        query["dept_id"] = dept_id
    
    docs = await DepartmentChecklistDocument.find(query).to_list()
    # Seed default data if none exists
    if not docs:
        await seed_department_checklists(org_id)
        docs = await DepartmentChecklistDocument.find(query).to_list()
        
    return [doc.model_dump() | {"id": doc.id} for doc in docs]

async def create_or_update_checklist(payload: DepartmentChecklistCreate, caller: UserBase) -> dict:
    org_id = _resolve_org(caller)
    
    doc = await DepartmentChecklistDocument.find_one(
        DepartmentChecklistDocument.organisation_id == org_id,
        DepartmentChecklistDocument.dept_id == payload.dept_id,
        NOT_DELETED
    )
    
    if doc:
        doc.items = payload.items
        doc.dept_name = payload.dept_name
        doc.modified_by = str(caller.id)
        doc.modified_on = datetime.now(timezone.utc)
        await doc.save()
    else:
        doc = DepartmentChecklistDocument(
            organisation_id=org_id,
            dept_id=payload.dept_id,
            dept_name=payload.dept_name,
            items=payload.items,
            created_by=str(caller.id),
            created_on=datetime.now(timezone.utc)
        )
        await doc.insert()

    await outbox.publish_audit_log(
        module="exit_management",
        actor_id=str(caller.id),
        organisation_id=str(org_id),
        action="department_checklist_saved",
        resource=f"department_checklist:{doc.id}",
        debug_level=DebugLevel.ADMIN,
        metadata={"dept_id": payload.dept_id},
    )
    return doc.model_dump() | {"id": doc.id}

async def seed_department_checklists(org_id: PydanticObjectId):
    defaults = [
        {
            "dept_id": "IT",
            "dept_name": "Information Technology",
            "items": ["Revoke Email Access", "Revoke VPN Access", "Format Laptop", "Collect ID Card"]
        },
        {
            "dept_id": "ADMIN",
            "dept_name": "Administration",
            "items": ["Return Office Keys", "Clear Desk / Locker", "Return Access Card", "Settle Petty Cash"]
        },
        {
            "dept_id": "FINANCE",
            "dept_name": "Finance",
            "items": ["Clear Pending Dues", "Calculate Notice Period Recovery", "Process Full & Final Settlement", "Generate FnF Statement"]
        }
    ]
    
    for d in defaults:
        exists = await DepartmentChecklistDocument.find_one(
            DepartmentChecklistDocument.organisation_id == org_id,
            DepartmentChecklistDocument.dept_id == d["dept_id"],
            NOT_DELETED
        )
        if not exists:
            doc = DepartmentChecklistDocument(
                organisation_id=org_id,
                dept_id=d["dept_id"],
                dept_name=d["dept_name"],
                items=d["items"],
                created_on=datetime.now(timezone.utc)
            )
            await doc.insert()
