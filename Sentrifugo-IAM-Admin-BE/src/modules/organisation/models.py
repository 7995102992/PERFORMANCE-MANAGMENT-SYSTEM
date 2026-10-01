from datetime import date, datetime
from enum import Enum
from typing import Literal, Optional
from beanie import Document, PydanticObjectId
from pydantic import BaseModel, Field, field_validator
from pymongo import ASCENDING, DESCENDING, IndexModel
from src.models import AuditMixin, ModuleEnum, OrgModule


class BandFrequency(str, Enum):
    MONTHLY = "monthly"
    ANNUAL = "annual"
    HOURLY = "hourly"

# ---------------------------------------------------------------------------
# Organization Setup Core Documents
# ---------------------------------------------------------------------------

class AddressDocument(Document, AuditMixin):
    organisation_id: Optional[PydanticObjectId] = None
    country: str
    state: str
    city: str
    zip_code: Optional[str] = None
    address_line_1: str
    address_line_2: Optional[str] = None

    class Settings:
        name = "addresses"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
        ]

class OrganisationDocument(Document, AuditMixin):
    legal_name: str
    address_id: Optional[PydanticObjectId] = None
    head_user_id: Optional[PydanticObjectId] = None
    date_of_incorporation: Optional[date] = None
    financial_year: Optional[str] = None
    currency: Optional[str] = None
    timezone: Optional[str] = None
    logo_asset_id: Optional[PydanticObjectId] = None
    is_multiple_business_units: bool
    is_active: bool = True
    enabled_modules: list[OrgModule] = Field(default_factory=list)
    setup_status: Literal["draft", "pending", "active"] = "active"

    @field_validator("enabled_modules", mode="before")
    @classmethod
    def _coerce_modules(cls, v):
        """Handle legacy format (plain strings) and new format (OrgModule dicts)."""
        if v is None:
            return []
        result = []
        for item in v:
            if isinstance(item, str):
                result.append({"code": item, "is_active": True})
            elif isinstance(item, (dict, OrgModule)):
                result.append(item)
            else:
                result.append({"code": str(item), "is_active": True})
        return result
    setup_progress: dict[str, str] = Field(default_factory=lambda: {
        "organisation": "pending",
        "business_units": "locked",
        "departments": "locked",
        "org_documents": "locked",
        "policies": "locked",
        "designations": "locked",
        "bands": "locked",
        "pay_grades": "locked",
        "employees": "locked",
        "assign_head": "locked",
    })

    class Settings:
        name = "organisations"
        indexes = [
            IndexModel(
                [("legal_name", ASCENDING)],
                unique=True,
                partialFilterExpression={"is_active": True},
            ),
            IndexModel([("address_id", ASCENDING)]),
        ]

class BusinessUnitDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    head_user_id: Optional[PydanticObjectId] = None
    address_id: PydanticObjectId
    business_unit_name: str
    emp_code_prefix: Optional[str] = None    # e.g. "SIL" — set at create/update, backfilled for legacy rows
    emp_code_last_number: int = 0             # legacy single counter (kept for backward compat)
    emp_code_last_numbers: dict[str, int] = Field(default_factory=dict)    # per-type counters: {"F": 3, "C": 1, "I": 2}
    emp_code_start_from: dict[str, int] = Field(default_factory=dict)  # per-type start offset: {"F": 0, "C": 100, "I": 200}
    emp_code_padding: dict[str, int] = Field(default_factory=dict)    # per-type zero-pad width: {"F": 3} → "006"; 0/unset → no padding
    ein: Optional[str] = None
    sector: Optional[PydanticObjectId] = None
    type_of_business: Optional[PydanticObjectId] = None
    nature_of_business: Optional[PydanticObjectId] = None
    date_of_incorporation: date
    financial_year: Optional[str] = None
    currency: Optional[str] = None
    time_zone: Optional[str] = None
    time_format: Optional[str] = None
    is_subsidiary: bool = False    # False = normal BU, True = subsidiary (behaves like a normal BU; FE-only distinction)
    is_active: bool = True

    class Settings:
        name = "business_units"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("address_id", ASCENDING)]),
            IndexModel([("emp_code_prefix", ASCENDING), ("organisation_id", ASCENDING)]),
        ]

class DepartmentDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    business_units: list[PydanticObjectId] = Field(default_factory=list)
    primary_business_unit: Optional[PydanticObjectId] = None
    department_name: str
    department_code: Optional[str] = None
    description: Optional[str] = None
    department_head: Optional[PydanticObjectId] = None
    is_active: bool = True

    class Settings:
        name = "departments"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("business_units", ASCENDING)]),
        ]

class DesignationDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    # Designations are org-level now — department & hierarchy role were removed
    # from the form; kept optional for backward compatibility with old data.
    department_id: Optional[PydanticObjectId] = None
    designation_name: str
    description: str = ""
    hierarchy_role: Optional[PydanticObjectId] = None
    pay_grade_ids: list[PydanticObjectId] = Field(default_factory=list)  # pay grades assigned to this designation
    is_active: bool = True

    class Settings:
        name = "designations"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("department_id", ASCENDING)]),
            IndexModel([("pay_grade_ids", ASCENDING)]),
        ]


# ---------------------------------------------------------------------------
# Org Documents
# ---------------------------------------------------------------------------

class FolderAccess(BaseModel):
    business_units: list[str] = Field(default_factory=list)
    departments: list[str] = Field(default_factory=list)
    worker_types: list[str] = Field(default_factory=list)


class DocumentFolderDocument(Document, AuditMixin):
    """A document folder. Nesting is exactly one level deep: `parent_id` is
    None for a main folder and set to a main folder's id for a sub-folder.
    A sub-folder may never itself be a parent (enforced in FolderTools).

    Access (`custom_access` / `access`) is only meaningful on a main folder —
    sub-folders always inherit their parent's, so employee-side scoping stays
    a single check against the root."""
    organisation_id: PydanticObjectId
    parent_id: Optional[PydanticObjectId] = None
    name: str
    description: Optional[str] = None
    custom_access: bool = False
    access: FolderAccess = Field(default_factory=FolderAccess)
    is_active: bool = True

    class Settings:
        name = "document_folders"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("parent_id", ASCENDING)]),
            # Names are unique per-parent, so "Policies/2024" and "Handbook/2024"
            # can coexist. Replaces the old (name, organisation_id) index —
            # see scripts/migrate_org_document_subfolders_versions.py.
            IndexModel(
                [("name", ASCENDING), ("parent_id", ASCENDING), ("organisation_id", ASCENDING)],
                name="name_parent_org_unique",
                unique=True,
                partialFilterExpression={"is_active": True},
            ),
        ]


class OrgDocumentDocument(Document, AuditMixin):
    """A document. `asset_id` always points at the *current* version's file;
    the full history lives in `org_document_versions`."""
    organisation_id: PydanticObjectId
    folder_id: PydanticObjectId
    title: str
    description: Optional[str] = None
    # Download is opt-in — off unless the admin explicitly enables it
    allow_download: bool = False
    require_acknowledgement: bool = False
    asset_id: PydanticObjectId
    current_version_no: int = 1
    is_active: bool = True

    class Settings:
        name = "org_documents"
        indexes = [
            IndexModel([("folder_id", ASCENDING)]),
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("asset_id", ASCENDING)]),
        ]


class OrgDocumentVersionDocument(Document, AuditMixin):
    """One immutable revision of a document's file.

    Version rows are never mutated or hard-deleted — replacing a document's
    file appends a new row and bumps `OrgDocumentDocument.current_version_no`.
    The superseded asset is kept (not soft-deleted) so old versions stay
    viewable and downloadable."""
    organisation_id: PydanticObjectId
    document_id: PydanticObjectId
    version_no: int
    asset_id: PydanticObjectId
    change_note: Optional[str] = None
    uploaded_by: Optional[str] = None
    uploaded_at: datetime

    class Settings:
        name = "org_document_versions"
        indexes = [
            IndexModel(
                [("document_id", ASCENDING), ("version_no", DESCENDING)],
                unique=True,
            ),
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("asset_id", ASCENDING)]),
        ]


class DocumentAcknowledgementDocument(Document, AuditMixin):
    """One employee's acknowledgement of one *version* of an org document.

    Acks are pinned to `version_no`: publishing a new version means the
    employee has not acknowledged the document they are now being shown, so
    they are prompted again. History of prior acks is preserved."""
    organisation_id: PydanticObjectId
    document_id: PydanticObjectId
    user_id: PydanticObjectId
    version_no: int = 1
    acknowledged: bool = True
    acknowledged_at: datetime

    class Settings:
        name = "org_document_acknowledgements"
        indexes = [
            # Replaces the old (document_id, user_id) unique index —
            # see scripts/migrate_org_document_subfolders_versions.py.
            IndexModel(
                [("document_id", ASCENDING), ("user_id", ASCENDING), ("version_no", ASCENDING)],
                name="document_user_version_unique",
                unique=True,
            ),
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("user_id", ASCENDING)]),
        ]


# ---------------------------------------------------------------------------
# Employee
# ---------------------------------------------------------------------------

from datetime import date as _date


class IdentityField(BaseModel):
    label: str
    value: str


class WorkExperienceRow(BaseModel):
    company_name: str
    job_title: str
    from_date: Optional[_date] = None
    to_date: Optional[_date] = None
    job_description: Optional[str] = None
    relevant: Optional[str] = None  # 'yes' | 'no'


class DependentRow(BaseModel):
    name: str
    relationship: str
    date_of_birth: Optional[_date] = None


class EducationRow(BaseModel):
    institute_name: str
    degree: str
    specialization: Optional[str] = None
    date_of_completion: Optional[_date] = None


class EmergencyContact(BaseModel):
    contact_name: str
    contact_number: str
    relationship: str


class BankDetails(BaseModel):
    account_holder_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    bank_name: Optional[str] = None


class CtcRecord(BaseModel):
    value: Optional[str] = None
    updated_on: datetime


class FieldHistoryEntry(BaseModel):
    """A past value of an effective-dated employee field (designation,
    department, employment status, project status, L1/L2 manager). Mirrors
    the {value, snapshot, when} shape CtcRecord uses for CTC — CTC itself is
    NOT one of these fields; it keeps its own always-immediate version map."""
    value: Optional[str] = None       # prior id, stringified (None = unset)
    display: Optional[str] = None     # human-readable snapshot at the time
    updated_on: datetime
    effective_date: Optional[_date] = None  # date the change took effect (None on legacy entries)


class PendingFieldChange(BaseModel):
    """A designation/department/employment-status/project-status/manager
    change submitted with a future effective_date. Held here — untouched on
    the live field — until _apply_due_pending_changes (called from every
    employee read path; there's no scheduler) applies it on or after that
    date."""
    field: str                            # "designation_id" | "department_id" | "employment_status" | "project_status" | "l1_manager_id" | "l2_manager_id"
    value: Optional[str] = None           # new id, stringified
    display: Optional[str] = None         # human-readable snapshot of the new value
    effective_date: _date
    created_by: Optional[PydanticObjectId] = None
    created_on: datetime


class EmployeeDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    user_id: Optional[PydanticObjectId] = None

    # Basic — email lives on UserDocument; name/personal fields also on UserDocument
    emp_code: Optional[str] = None  # generated once BU is assigned
    # Optional secondary emp code. Set only where an employee's code differs from
    # the house format and must still resolve during payslip emp-lookup; used
    # alongside emp_code for lookups. Not present on most documents (never backfilled).
    alias: Optional[str] = None

    # Work
    business_unit_id: Optional[PydanticObjectId] = None
    department_id: Optional[PydanticObjectId] = None
    designation_id: Optional[PydanticObjectId] = None
    source_of_hire: Optional[PydanticObjectId] = None
    l1_manager_id: Optional[PydanticObjectId] = None
    l2_manager_id: Optional[PydanticObjectId] = None
    current_exp: Optional[float] = None
    total_exp: Optional[float] = None
    employment_type: Optional[PydanticObjectId] = None
    employment_status: Optional[PydanticObjectId] = None
    # Allocation / resourcing state (Allocated to Project / Bench / Long Leave).
    # Independent of employment_status (lifecycle) — an employee has both.
    project_status: Optional[PydanticObjectId] = None
    date_of_joining: Optional[_date] = None

    # Compensation — ctc is a number-keyed version map {"1": {value, currency,
    # updated_on}, ...} (highest key = current); amounts are Fernet-encrypted
    # (see src.security.crypto). currency also kept top-level as the current code.
    ctc: Optional[dict] = None
    currency: Optional[str] = None

    @field_validator("ctc", mode="before")
    @classmethod
    def _coerce_ctc(cls, v):
        if v is None:
            return {}
        if isinstance(v, str):
            return {"1": {"value": v, "updated_on": datetime.min}}
        if isinstance(v, list):
            return {str(i + 1): item for i, item in enumerate(v)}
        return v

    # Personal (dob, gender, marital_status moved to UserDocument)
    about_me: Optional[str] = None

    # Identity
    identity_fields: list[IdentityField] = Field(default_factory=list)

    # Contact (work_phone/work_phone_extension moved to UserDocument)
    personal_phone: Optional[str] = None
    personal_email: Optional[str] = None
    seat_location: Optional[str] = None

    # Exit
    date_of_exit: Optional[_date] = None

    # Effective-dated change tracking for designation, department, employment
    # status, project status, and L1/L2 manager — each mirrors the same
    # "previous value + when" pattern. pending_changes holds anything
    # submitted with a future effective_date until it's applied on read (see
    # EmployeeTools._apply_due_pending_changes). CTC is NOT part of this — it
    # keeps its own always-immediate version map (the ctc dict above).
    designation_history: list[FieldHistoryEntry] = Field(default_factory=list)
    department_history: list[FieldHistoryEntry] = Field(default_factory=list)
    employment_status_history: list[FieldHistoryEntry] = Field(default_factory=list)
    project_status_history: list[FieldHistoryEntry] = Field(default_factory=list)
    l1_manager_history: list[FieldHistoryEntry] = Field(default_factory=list)
    l2_manager_history: list[FieldHistoryEntry] = Field(default_factory=list)
    pending_changes: list[PendingFieldChange] = Field(default_factory=list)

    # Addresses — created lazily; may be missing on partial records
    permanent_address_id: Optional[PydanticObjectId] = None
    present_address_id: Optional[PydanticObjectId] = None
    same_as_permanent: bool = False

    # Bank Details
    bank_details: Optional[BankDetails] = None

    # Emergency Contacts
    emergency_contacts: list[EmergencyContact] = Field(default_factory=list)

    # Repeatable
    work_experience: list[WorkExperienceRow] = Field(default_factory=list)
    dependents: list[DependentRow] = Field(default_factory=list)
    education: list[EducationRow] = Field(default_factory=list)

    class Settings:
        name = "employees"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel([("business_unit_id", ASCENDING)]),
            IndexModel([("department_id", ASCENDING)]),
            IndexModel([("designation_id", ASCENDING)]),
            IndexModel([("emp_code", ASCENDING), ("organisation_id", ASCENDING)]),
            IndexModel([("user_id", ASCENDING)]),
        ]


class BandDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    name: str
    class_label: Optional[PydanticObjectId] = None
    frequency: Optional[PydanticObjectId] = None
    currency: Optional[str] = None
    # Stored as Fernet-encrypted strings for new writes. Legacy rows may hold
    # raw floats — coerce to a numeric string on load so Beanie can parse them.
    # Optional now — the user may save a band without amounts.
    min_amount: Optional[str] = None
    max_amount: Optional[str] = None

    @field_validator("min_amount", "max_amount", mode="before")
    @classmethod
    def _coerce_legacy_numeric(cls, v):
        if isinstance(v, (int, float)):
            return str(v)
        return v
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    notes: str = ""
    is_active: bool = True

    class Settings:
        name = "bands"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel(
                [("name", ASCENDING), ("organisation_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"is_active": True},
            ),
            IndexModel([("frequency", ASCENDING)]),
        ]


class PayGradeDocument(Document, AuditMixin):
    organisation_id: PydanticObjectId
    name: str
    description: str = ""
    band_ids: list[PydanticObjectId] = Field(default_factory=list)
    is_active: bool = True

    class Settings:
        name = "paygrades"
        indexes = [
            IndexModel([("organisation_id", ASCENDING)]),
            IndexModel(
                [("name", ASCENDING), ("organisation_id", ASCENDING)],
                unique=True,
                partialFilterExpression={"is_active": True},
            ),
            IndexModel([("band_ids", ASCENDING)]),
        ]
