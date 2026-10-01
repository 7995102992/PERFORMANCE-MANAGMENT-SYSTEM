from datetime import date, datetime
from enum import Enum

from beanie import PydanticObjectId
from pydantic import Field

from src.models import CustomModel


class ExitRequestStatus(str, Enum):
    PENDING_APPROVAL = "pending_approval"
    UNDER_REVIEW = "under_review"
    AWAITING_CLEARANCES = "awaiting_clearances"
    AWAITING_EXIT_INTERVIEW = "awaiting_exit_interview"
    COMPLETED = "completed"
    APPROVED = "approved"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    ARCHIVED = "archived"
    DEACTIVATED = "deactivated"



class ExitRequestCreate(CustomModel):
    employee_id: PydanticObjectId = Field(..., alias="employeeId")
    last_working_day: date | None = Field(None, alias="lastWorkingDay")
    reason: str
    other_reason: str | None = Field(None, alias="otherReason")
    additional_details: str | None = Field(None, alias="additionalDetails")
    document_ids: list[PydanticObjectId] = Field(default_factory=list, alias="documentIds")
    exit_type: str | None = Field("resignation", alias="exitType")
    hr_initiated: bool | None = Field(False, alias="hrInitiated")
    immediate_exit: bool | None = Field(False, alias="immediateExit")

class ExitRequestUpdate(CustomModel):
    last_working_day: date | None = Field(None, alias="lastWorkingDay")
    reason: str | None = None
    other_reason: str | None = Field(None, alias="otherReason")
    additional_details: str | None = Field(None, alias="additionalDetails")
    document_ids: list[PydanticObjectId] | None = Field(None, alias="documentIds")

class ExitRequestApproval(CustomModel):
    status: ExitRequestStatus
    rejection_reason: str | None = Field(None, alias="rejectionReason")

class ExitRequestResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId = Field(..., alias="organisationId")
    employee_id: PydanticObjectId = Field(..., alias="employeeId")
    request_code: str = Field(..., alias="requestCode")
    last_working_day: date | None = Field(None, alias="lastWorkingDay")
    reason: str
    other_reason: str | None = Field(None, alias="otherReason")
    additional_details: str | None = Field(None, alias="additionalDetails")
    status: ExitRequestStatus
    exit_type: str = Field(..., alias="exitType")
    hr_initiated: bool = Field(..., alias="hrInitiated")
    immediate_exit: bool = Field(..., alias="immediateExit")
    deactivated_on: datetime | None = Field(None, alias="deactivatedOn")
    deactivated_by: PydanticObjectId | None = Field(None, alias="deactivatedBy")
    rejection_reason: str | None = Field(None, alias="rejectionReason")
    approved_by: PydanticObjectId | None = Field(None, alias="approvedBy")
    approved_on: datetime | None = Field(None, alias="approvedOn")
    requested_last_working_day: date | None = Field(None, alias="requestedLastWorkingDay")
    parent_request_id: PydanticObjectId | None = Field(None, alias="parentRequestId")
    document_ids: list[PydanticObjectId] = Field(default_factory=list, alias="documentIds")
    created_on: datetime | None = Field(None, alias="createdOn")
    employee_name: str | None = Field(None, alias="employeeName")
    employee_email: str | None = Field(None, alias="employeeEmail")
    emp_code: str | None = Field(None, alias="empCode")
    employee_status: str | None = Field(None, alias="employeeStatus")  # account status: active / notice_period / exit
    it_clearance_status: str | None = Field(None, alias="itClearanceStatus")
    admin_clearance_status: str | None = Field(None, alias="adminClearanceStatus")
    finance_clearance_status: str | None = Field(None, alias="financeClearanceStatus")
    manager_completed_checklist: list[str] = Field(default_factory=list, alias="managerCompletedChecklist")
    hr_completed_checklist: list[str] = Field(default_factory=list, alias="hrCompletedChecklist")

    model_config = {
        "json_schema_extra": {
            "example": {
                "id": "5eb7cf5a86d9755df3a6c593",
                "organisationId": "5eb7cf5a86d9755df3a6c593",
                "employeeId": "5eb7cf5a86d9755df3a6c593",
                "requestCode": "EXIT-001",
                "lastWorkingDay": "2026-06-01",
                "reason": "career_growth",
                "otherReason": None,
                "additionalDetails": None,
                "status": "pending_approval",
                "exitType": "resignation",
                "hrInitiated": False,
                "immediateExit": False,
                "deactivatedOn": None,
                "deactivatedBy": None,
                "rejectionReason": None,
                "approvedBy": None,
                "approvedOn": None,
                "parentRequestId": None,
                "documentIds": [],
                "createdOn": "2026-05-07T05:29:17.643Z",
                "employeeName": "John Doe",
                "employeeEmail": "john@example.com",
                "empCode": "EMP001",
            }
        }
    }

class ManagerApproveRequest(CustomModel):
    comments: str | None = None
    final_last_working_day: date = Field(..., alias="finalLastWorkingDay")
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")

class ManagerRejectRequest(CustomModel):
    action_type: str = Field(..., alias="actionType")  # "standard" or "retention"
    comments: str
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")

class TeamExitRequestResponse(ExitRequestResponse):
    employee_role: str | None = Field(None, alias="employeeRole")
    department: str | None = Field(None, alias="department")
    date_of_joining: date | None = Field(None, alias="dateOfJoining")
    current_location: str | None = Field(None, alias="currentLocation")
    reporting_manager_name: str | None = Field(None, alias="reportingManagerName")
    notice_period_days: int | None = Field(None, alias="noticePeriodDays")

class TeamExitSummaryResponse(CustomModel):
    total: int = 0
    pending_approval: int = Field(0, alias="pendingApproval")
    under_review: int = Field(0, alias="underReview")
    approved: int = 0
    rejected: int = 0
    withdrawn: int = 0

class HRExitRequestResponse(ExitRequestResponse):
    employee_role: str | None = Field(None, alias="employeeRole")
    department: str | None = Field(None, alias="department")
    sub_dept: str | None = Field(None, alias="subDept")
    date_of_joining: date | None = Field(None, alias="dateOfJoining")
    current_location: str | None = Field(None, alias="currentLocation")
    reporting_manager_name: str | None = Field(None, alias="reportingManagerName")
    notice_period_days: int | None = Field(None, alias="noticePeriodDays")
    emp_type: str | None = Field(None, alias="empType")
    grade: str | None = Field(None, alias="grade")
    phone: str | None = Field(None, alias="phone")

class HRExitSummaryResponse(CustomModel):
    total: int = 0
    in_progress: int = Field(0, alias="inProgress")
    pending_tasks: int = Field(0, alias="pendingTasks")
    awaiting_clearances: int = Field(0, alias="awaitingClearances")
    completed: int = 0


class DepartmentChecklistCreate(CustomModel):
    dept_id: str = Field(..., alias="deptId")
    dept_name: str = Field(..., alias="deptName")
    items: list[str] = Field(default_factory=list)

class DepartmentChecklistUpdate(CustomModel):
    items: list[str]

class DepartmentChecklistResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId = Field(..., alias="organisationId")
    dept_id: str = Field(..., alias="deptId")
    dept_name: str = Field(..., alias="deptName")
    items: list[str]


class HRChecklistSubmit(CustomModel):
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")


class ExitInterviewCreate(CustomModel):
    reason_for_leaving: str | None = Field(None, alias="reasonForLeaving")
    other_reason: str | None = Field(None, alias="otherReason")
    overall_rating: float | None = Field(None, alias="overallRating", ge=0.5, le=5)
    liked_most: str | None = Field(None, alias="likedMost")
    improvements: str | None = None
    manager_feedback: str | None = Field(None, alias="managerFeedback")

class ExitInterviewResponse(CustomModel):
    id: PydanticObjectId
    exit_request_id: PydanticObjectId = Field(..., alias="exitRequestId")
    employee_id: PydanticObjectId = Field(..., alias="employeeId")
    reason_for_leaving: str | None = Field(None, alias="reasonForLeaving")
    other_reason: str | None = Field(None, alias="otherReason")
    overall_rating: float | None = Field(None, alias="overallRating")
    liked_most: str | None = Field(None, alias="likedMost")
    improvements: str | None = None
    manager_feedback: str | None = Field(None, alias="managerFeedback")
    created_on: datetime | None = Field(None, alias="createdOn")


class ITAssetSummaryResponse(CustomModel):
    total: int = 0
    pending: int = 0
    returned: int = 0
    verified: int = 0
    not_cleared: int = Field(0, alias="notCleared")

class ITAssetReturnResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId = Field(..., alias="organisationId")
    exit_request_id: PydanticObjectId = Field(..., alias="exitRequestId")
    employee_id: PydanticObjectId = Field(..., alias="employeeId")
    asset_type: str = Field(..., alias="assetType")
    asset_id: str = Field(..., alias="assetId")
    serial_number: str = Field(..., alias="serialNumber")
    model: str
    issued_date: date | None = Field(None, alias="issuedDate")
    returned_date: date | None = Field(None, alias="returnedDate")
    status: str
    condition: str | None = None
    verification_notes: str | None = Field(None, alias="verificationNotes")
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")
    verified_by: PydanticObjectId | None = Field(None, alias="verifiedBy")
    verified_on: datetime | None = Field(None, alias="verifiedOn")
    
    # Enriched fields
    request_code: str | None = Field(None, alias="requestCode")
    employee_name: str | None = Field(None, alias="employeeName")
    emp_code: str | None = Field(None, alias="empCode")
    department: str | None = None
    last_working_day: date | None = Field(None, alias="lastWorkingDay")
    it_clearance_status: str | None = Field(None, alias="itClearanceStatus")
    admin_clearance_status: str | None = Field(None, alias="adminClearanceStatus")
    finance_clearance_status: str | None = Field(None, alias="financeClearanceStatus")
    exit_request_status: str | None = Field(None, alias="exitRequestStatus")


class ITAssetVerifyRequest(CustomModel):
    condition: str
    verification_notes: str = Field(..., alias="verificationNotes")
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")
    status: str | None = None


class AdminTaskSummaryResponse(CustomModel):
    total: int = 0
    pending: int = 0
    returned: int = 0
    completed: int = 0
    not_cleared: int = Field(0, alias="notCleared")

class AdminTaskResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId = Field(..., alias="organisationId")
    exit_request_id: PydanticObjectId = Field(..., alias="exitRequestId")
    employee_id: PydanticObjectId = Field(..., alias="employeeId")
    task_type: str = Field(..., alias="taskType")
    details: str
    desk_number: str | None = Field(None, alias="deskNumber")
    locker_number: str | None = Field(None, alias="lockerNumber")
    issued_date: date | None = Field(None, alias="issuedDate")
    submitted_date: date | None = Field(None, alias="submittedDate")
    status: str
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")
    notes: str | None = None
    completed_by: PydanticObjectId | None = Field(None, alias="completedBy")
    completed_on: datetime | None = Field(None, alias="completedOn")
    
    # Enriched fields
    request_code: str | None = Field(None, alias="requestCode")
    employee_name: str | None = Field(None, alias="employeeName")
    emp_code: str | None = Field(None, alias="empCode")
    department: str | None = None
    last_working_day: date | None = Field(None, alias="lastWorkingDay")
    it_clearance_status: str | None = Field(None, alias="itClearanceStatus")
    admin_clearance_status: str | None = Field(None, alias="adminClearanceStatus")
    finance_clearance_status: str | None = Field(None, alias="financeClearanceStatus")


class AdminTaskCompleteRequest(CustomModel):
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")
    notes: str
    status: str | None = None


class FinanceClearanceSummaryResponse(CustomModel):
    total: int = 0
    pending: int = 0
    under_review: int = Field(0, alias="underReview")
    approved: int = 0
    sent_to_payroll: int = Field(0, alias="sentToPayroll")
    paid: int = 0
    not_cleared: int = Field(0, alias="notCleared")

class FinanceClearanceResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: PydanticObjectId = Field(..., alias="organisationId")
    exit_request_id: PydanticObjectId = Field(..., alias="exitRequestId")
    employee_id: PydanticObjectId = Field(..., alias="employeeId")
    amount_due: float = Field(0.0, alias="amountDue")
    settlement_date: date | None = Field(None, alias="settlementDate")
    notice_period_days: int = Field(0, alias="noticePeriodDays")
    status: str
    clearance_reason: str | None = Field(None, alias="clearanceReason")
    remarks: str | None = None
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")
    cleared_by: PydanticObjectId | None = Field(None, alias="clearedBy")
    cleared_on: datetime | None = Field(None, alias="clearedOn")
    
    # Enriched fields
    request_code: str | None = Field(None, alias="requestCode")
    employee_name: str | None = Field(None, alias="employeeName")
    emp_code: str | None = Field(None, alias="empCode")
    department: str | None = None
    designation: str | None = None
    reporting_manager_name: str | None = Field(None, alias="reportingManagerName")
    last_working_day: date | None = Field(None, alias="lastWorkingDay")
    it_clearance_status: str | None = Field(None, alias="itClearanceStatus")
    admin_clearance_status: str | None = Field(None, alias="adminClearanceStatus")
    finance_clearance_status: str | None = Field(None, alias="financeClearanceStatus")


class FinanceClearanceStatusRequest(CustomModel):
    status: str
    clearance_reason: str | None = Field(None, alias="clearanceReason")
    remarks: str | None = None
    completed_checklist: list[str] = Field(default_factory=list, alias="completedChecklist")
