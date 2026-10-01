from datetime import date, datetime

from beanie import Document, PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from src.models import AuditMixin


class DepartmentChecklistDocument(AuditMixin, Document):
    organisation_id: PydanticObjectId
    dept_id: str  # e.g., "ADMIN", "IT", "FINANCE"
    dept_name: str
    items: list[str] = Field(default_factory=list)

    class Settings:
        name = "department_checklists"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("dept_id", ASCENDING)], unique=True)
        ]


class ExitRequestDocument(AuditMixin, Document):
    organisation_id: PydanticObjectId
    employee_id: PydanticObjectId
    request_code: str
    last_working_day: date | None = None
    reason: str
    other_reason: str | None = None
    additional_details: str | None = None
    status: str = "pending_approval"
    exit_type: str = "resignation"
    hr_initiated: bool = False
    immediate_exit: bool = False
    rejection_reason: str | None = None
    approved_by: PydanticObjectId | None = None
    approved_on: datetime | None = None
    deactivated_on: datetime | None = None
    deactivated_by: PydanticObjectId | None = None
    requested_last_working_day: date | None = None
    # Notice-period leave extension (driven by the leave-management service via
    # the domain_events bus). base_last_working_day is the manager-approved LWD
    # before any leave extensions; notice_extension_days accumulates the approved
    # working days of leave taken during notice. last_working_day is recomputed as
    # base + floor(notice_extension_days) business days, so it stays reversible.
    base_last_working_day: date | None = None
    notice_extension_days: float = 0.0
    parent_request_id: PydanticObjectId | None = None
    document_ids: list[PydanticObjectId] = Field(default_factory=list)
    manager_completed_checklist: list[str] = Field(default_factory=list)
    hr_completed_checklist: list[str] = Field(default_factory=list)

    class Settings:
        name = "exit_requests"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("employee_id", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("request_code", ASCENDING), ("organisation_id", ASCENDING)],
                       unique=True, partialFilterExpression={"deleted_on": None}),
            IndexModel([("created_on", DESCENDING)]),
        ]


class ExitInterviewDocument(AuditMixin, Document):
    organisation_id: PydanticObjectId
    exit_request_id: PydanticObjectId
    employee_id: PydanticObjectId
    reason_for_leaving: str | None = None
    other_reason: str | None = None
    overall_rating: float | None = None
    liked_most: str | None = None
    improvements: str | None = None
    manager_feedback: str | None = None

    class Settings:
        name = "exit_interviews"
        indexes = [
            IndexModel([("exit_request_id", ASCENDING)], unique=True,
                       partialFilterExpression={"deleted_on": None}),
        ]


class ITAssetReturnDocument(AuditMixin, Document):
    organisation_id: PydanticObjectId
    exit_request_id: PydanticObjectId
    employee_id: PydanticObjectId
    asset_type: str
    asset_id: str
    serial_number: str
    model: str
    issued_date: date | None = None
    returned_date: date | None = None
    status: str = "pending"  # "pending", "returned", "verified"
    condition: str | None = None
    verification_notes: str | None = None
    completed_checklist: list[str] = Field(default_factory=list)
    verified_by: PydanticObjectId | None = None
    verified_on: datetime | None = None

    class Settings:
        name = "it_asset_returns"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING), ("employee_id", ASCENDING)]),
            IndexModel([("exit_request_id", ASCENDING), ("asset_id", ASCENDING)], unique=True)
        ]


class AdminTaskDocument(AuditMixin, Document): 
    organisation_id: PydanticObjectId
    exit_request_id: PydanticObjectId
    employee_id: PydanticObjectId
    task_type: str
    details: str
    desk_number: str | None = None
    locker_number: str | None = None
    issued_date: date | None = None
    submitted_date: date | None = None
    status: str = "pending"  # "pending", "returned", "completed"
    completed_checklist: list[str] = Field(default_factory=list)
    notes: str | None = None
    completed_by: PydanticObjectId | None = None
    completed_on: datetime | None = None

    class Settings:
        name = "admin_tasks"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING), ("employee_id", ASCENDING)]),
            IndexModel([("task_type", ASCENDING)])
        ]


class FinanceClearanceDocument(AuditMixin, Document):
    organisation_id: PydanticObjectId
    exit_request_id: PydanticObjectId
    employee_id: PydanticObjectId
    amount_due: float = 0.0
    settlement_date: date | None = None
    notice_period_days: int = 0
    status: str = "pending"  # "pending", "under_review", "approved", "sent_to_payroll", "paid", "not_cleared"
    clearance_reason: str | None = None
    remarks: str | None = None
    completed_checklist: list[str] = Field(default_factory=list)
    cleared_by: PydanticObjectId | None = None
    cleared_on: datetime | None = None

    class Settings:
        name = "finance_clearances"
        indexes = [
            IndexModel([("organisation_id", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("settlement_date", DESCENDING)]),
            IndexModel([("exit_request_id", ASCENDING)], unique=True)
        ]
