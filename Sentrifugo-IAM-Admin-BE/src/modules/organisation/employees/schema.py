from datetime import date, datetime
from typing import Any, Optional
from beanie import PydanticObjectId
from pydantic import Field, EmailStr, model_validator
from src.models import CustomModel, MasterDataCompact
from src.modules.organisation.addresses.schema import AddressCreate, AddressResponse
from src.modules.custom_fields.schema import FieldWithValue


class PolicyCompact(CustomModel):
    id: PydanticObjectId
    name: str


class CtcHistoryEntry(CustomModel):
    """A past CTC revision, decrypted. Returned read-only alongside the current ctc."""
    amount: Optional[float] = None
    currency: Optional[str] = None
    updated_on: Optional[datetime] = Field(None, alias="updatedOn")


class FieldHistoryEntryDTO(CustomModel):
    """A past value of an effective-dated field (designation, L1/L2 manager)."""
    value: Optional[str] = None
    display: Optional[str] = None
    updated_on: Optional[datetime] = Field(None, alias="updatedOn")
    effective_date: Optional[date] = Field(None, alias="effectiveDate")


class PendingFieldChangeDTO(CustomModel):
    """A designation/department/employment-status/project-status/manager
    change queued for a future effective date."""
    field: str
    value: Optional[str] = None
    display: Optional[str] = None
    effective_date: Optional[date] = Field(None, alias="effectiveDate")
    created_on: Optional[datetime] = Field(None, alias="createdOn")


def _empty_to_none(v):
    return None if v == "" else v


# Fields whose changes are effective-dated and history-tracked (mirrors
# _HISTORY_ATTR in utils/tools.py); an update payload touching any of these
# must carry effectiveDate.
EFFECTIVE_DATED_FIELDS = (
    "department_id",
    "designation_id",
    "employment_status",
    "project_status",
    "l1_manager_id",
    "l2_manager_id",
)


def _normalize_blank_data(data: Any) -> Any:
    """Make 'left blank' safe for optional employee fields (create + update).

    - Empty strings → None, so optional ObjectId/date/number fields (e.g.
      employmentStatus, dateOfJoining, dob) don't fail trying to parse "".
    - A fully-empty address object → None, so AddressCreate's min_length checks
      never run on an untouched address.
    """
    if not isinstance(data, dict):
        return data
    for k, v in list(data.items()):
        if isinstance(v, str) and not v.strip():
            data[k] = None
    for addr_key in ("permanentAddress", "permanent_address", "presentAddress", "present_address"):
        a = data.get(addr_key)
        if isinstance(a, dict):
            core = (
                a.get("country"),
                a.get("state"),
                a.get("city"),
                a.get("address_line_1") or a.get("addressLine1"),
            )
            if not any(c and str(c).strip() for c in core):
                data[addr_key] = None
    return data


# ─── Sub-schemas ────────────────────────────────────────────────────────────

class BankDetailsDTO(CustomModel):
    account_holder_name: Optional[str] = Field(None, alias="accountHolderName")
    account_number: Optional[str] = Field(None, alias="accountNumber")
    ifsc_code: Optional[str] = Field(None, alias="ifscCode")
    bank_name: Optional[str] = Field(None, alias="bankName")


class IdentityFieldDTO(CustomModel):
    label: str
    value: str


class WorkExperienceRowDTO(CustomModel):
    company_name: str = Field(..., alias="companyName")
    job_title: str = Field(..., alias="jobTitle")
    from_date: Optional[date] = Field(None, alias="fromDate")
    to_date: Optional[date] = Field(None, alias="toDate")
    job_description: Optional[str] = Field(None, alias="jobDescription")
    relevant: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _empty_dates_to_none(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for k in ("fromDate", "from_date", "toDate", "to_date"):
                if data.get(k) == "":
                    data[k] = None
        return data


class DependentRowDTO(CustomModel):
    name: str
    relationship: str
    date_of_birth: Optional[date] = Field(None, alias="dateOfBirth")

    @model_validator(mode="before")
    @classmethod
    def _empty_dates_to_none(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for k in ("dateOfBirth", "date_of_birth"):
                if data.get(k) == "":
                    data[k] = None
        return data


class EducationRowDTO(CustomModel):
    institute_name: str = Field(..., alias="instituteName")
    degree: str
    specialization: Optional[str] = None
    date_of_completion: Optional[date] = Field(None, alias="dateOfCompletion")

    @model_validator(mode="before")
    @classmethod
    def _empty_dates_to_none(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for k in ("dateOfCompletion", "date_of_completion"):
                if data.get(k) == "":
                    data[k] = None
        return data


class EmergencyContactDTO(CustomModel):
    contact_name: str = Field(..., alias="contactName")
    contact_number: str = Field(..., alias="contactNumber")
    relationship: str


# ─── Employee Schemas ───────────────────────────────────────────────────────

class EmployeeBase(CustomModel):
    """Permissive base — only first_name, last_name, work_email are truly required.

    The form enforces stricter rules client-side; bulk imports + draft creation
    use the relaxed contract so partial records can be saved and completed later.
    """

    @model_validator(mode="before")
    @classmethod
    def _normalize_blanks(cls, data: Any) -> Any:
        return _normalize_blank_data(data)

    organisation_id: Optional[PydanticObjectId] = Field(None, alias="organisationId")

    # Basic — required across both paths (emp_code is server-generated)
    work_email: EmailStr = Field(..., alias="workEmail")
    first_name: str = Field(..., alias="firstName", min_length=1, max_length=50)
    middle_name: Optional[str] = Field(None, alias="middleName", max_length=50)
    last_name: str = Field(..., alias="lastName", min_length=1, max_length=50)

    # Work — all optional at the API/contract layer
    business_unit_id: Optional[PydanticObjectId] = Field(None, alias="businessUnitId")
    department_id: Optional[PydanticObjectId] = Field(None, alias="departmentId")
    designation_id: Optional[PydanticObjectId] = Field(None, alias="designationId")
    source_of_hire: Optional[PydanticObjectId] = Field(None, alias="sourceOfHire")
    l1_manager_id: Optional[PydanticObjectId] = Field(None, alias="l1ManagerId")
    l2_manager_id: Optional[PydanticObjectId] = Field(None, alias="l2ManagerId")
    current_exp: Optional[float] = Field(None, alias="currentExp", ge=0)
    total_exp: Optional[float] = Field(None, alias="totalExp", ge=0)
    employment_type: Optional[PydanticObjectId] = Field(None, alias="employmentType")
    employment_status: Optional[PydanticObjectId] = Field(None, alias="employmentStatus")
    project_status: Optional[PydanticObjectId] = Field(None, alias="projectStatus")
    # Roles (policies) assigned directly to the employee — FE calls them "roles".
    policy_ids: Optional[list[PydanticObjectId]] = Field(None, alias="roleIds")
    date_of_joining: Optional[date] = Field(None, alias="dateOfJoining")
    date_of_exit: Optional[date] = Field(None, alias="dateOfExit")

    # Compensation
    ctc: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, min_length=1)

    # Personal
    dob: Optional[date] = None
    gender: Optional[PydanticObjectId] = None
    marital_status: Optional[PydanticObjectId] = Field(None, alias="maritalStatus")
    about_me: Optional[str] = Field(None, alias="aboutMe", max_length=2000)

    # Bank Details
    bank_details: Optional[BankDetailsDTO] = Field(None, alias="bankDetails")

    # Identity
    identity_fields: list[IdentityFieldDTO] = Field(default_factory=list, alias="identityFields")

    # Contact
    work_phone_extension: Optional[str] = Field(None, alias="workPhoneExtension", max_length=10)
    work_phone: Optional[str] = Field(None, alias="workPhone")
    personal_phone: Optional[str] = Field(None, alias="personalPhone")
    personal_email: Optional[EmailStr] = Field(None, alias="personalEmail")
    seat_location: Optional[str] = Field(None, alias="seatLocation")

    # Emergency Contacts
    emergency_contacts: list[EmergencyContactDTO] = Field(default_factory=list, alias="emergencyContacts")

    # Repeatable
    work_experience: list[WorkExperienceRowDTO] = Field(default_factory=list, alias="workExperience")
    dependents: list[DependentRowDTO] = Field(default_factory=list)
    education: list[EducationRowDTO] = Field(default_factory=list)


class EmployeeCreate(EmployeeBase):
    # Business unit and department are mandatory for a real employee record —
    # every employee must belong to a BU + dept (downstream services like the
    # leave plan overview key their org tree off these). The relaxed Optional
    # contract stays on EmployeeBase/EmployeeUpdate for partial draft edits.
    business_unit_id: PydanticObjectId = Field(..., alias="businessUnitId")
    department_id: PydanticObjectId = Field(..., alias="departmentId")

    # Roles are derived from the designation, not assigned per employee.
    permanent_address: Optional[AddressCreate] = Field(None, alias="permanentAddress")
    present_address: Optional[AddressCreate] = Field(None, alias="presentAddress")
    same_as_permanent: bool = Field(False, alias="sameAsPermanent")


class EmployeeUpdate(CustomModel):
    @model_validator(mode="before")
    @classmethod
    def _normalize_blanks(cls, data: Any) -> Any:
        return _normalize_blank_data(data)

    # Basic (emp_code not editable — server-generated)
    work_email: Optional[EmailStr] = Field(None, alias="workEmail")
    first_name: Optional[str] = Field(None, alias="firstName", min_length=1, max_length=50)
    middle_name: Optional[str] = Field(None, alias="middleName", max_length=50)
    last_name: Optional[str] = Field(None, alias="lastName", min_length=1, max_length=50)

    # Work
    business_unit_id: Optional[PydanticObjectId] = Field(None, alias="businessUnitId")
    department_id: Optional[PydanticObjectId] = Field(None, alias="departmentId")
    designation_id: Optional[PydanticObjectId] = Field(None, alias="designationId")
    source_of_hire: Optional[PydanticObjectId] = Field(None, alias="sourceOfHire")
    l1_manager_id: Optional[PydanticObjectId] = Field(None, alias="l1ManagerId")
    l2_manager_id: Optional[PydanticObjectId] = Field(None, alias="l2ManagerId")
    current_exp: Optional[float] = Field(None, alias="currentExp", ge=0)
    total_exp: Optional[float] = Field(None, alias="totalExp", ge=0)
    employment_type: Optional[PydanticObjectId] = Field(None, alias="employmentType")
    employment_status: Optional[PydanticObjectId] = Field(None, alias="employmentStatus")
    project_status: Optional[PydanticObjectId] = Field(None, alias="projectStatus")
    # Roles (policies) assigned directly to the employee — FE calls them "roles".
    policy_ids: Optional[list[PydanticObjectId]] = Field(None, alias="roleIds")
    date_of_joining: Optional[date] = Field(None, alias="dateOfJoining")
    date_of_exit: Optional[date] = Field(None, alias="dateOfExit")

    # Shared effective date for whichever of the tracked fields (department/
    # designation/employmentStatus/projectStatus/l1Manager/l2Manager) are
    # present in this same payload. MANDATORY when any of them is sent —
    # today/past → applies immediately; a future date parks the change in
    # pending_changes instead (see EmployeeTools.update /
    # _apply_due_pending_changes). Ignored for non-tracked fields.
    effective_date: Optional[date] = Field(None, alias="effectiveDate")

    @model_validator(mode="after")
    def _require_effective_date_for_tracked_fields(self) -> "EmployeeUpdate":
        touched = [f for f in EFFECTIVE_DATED_FIELDS if f in self.model_fields_set]
        if touched and self.effective_date is None:
            raise ValueError(
                "effectiveDate is required when changing: "
                + ", ".join(sorted(touched))
            )
        return self

    # Compensation
    ctc: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, min_length=1)

    # Personal
    dob: Optional[date] = None
    gender: Optional[PydanticObjectId] = None
    marital_status: Optional[PydanticObjectId] = Field(None, alias="maritalStatus")
    about_me: Optional[str] = Field(None, alias="aboutMe", max_length=2000)

    bank_details: Optional[BankDetailsDTO] = Field(None, alias="bankDetails")
    identity_fields: Optional[list[IdentityFieldDTO]] = Field(None, alias="identityFields")

    # Contact
    work_phone_extension: Optional[str] = Field(None, alias="workPhoneExtension", max_length=10)
    work_phone: Optional[str] = Field(None, alias="workPhone")
    personal_phone: Optional[str] = Field(None, alias="personalPhone")
    personal_email: Optional[str] = Field(None, alias="personalEmail")
    seat_location: Optional[str] = Field(None, alias="seatLocation")

    # Emergency Contacts
    emergency_contacts: Optional[list[EmergencyContactDTO]] = Field(None, alias="emergencyContacts")

    # Addresses (full replace)
    permanent_address: Optional[AddressCreate] = Field(None, alias="permanentAddress")
    present_address: Optional[AddressCreate] = Field(None, alias="presentAddress")
    same_as_permanent: Optional[bool] = Field(None, alias="sameAsPermanent")

    # Repeatable
    work_experience: Optional[list[WorkExperienceRowDTO]] = Field(None, alias="workExperience")
    dependents: Optional[list[DependentRowDTO]] = None
    education: Optional[list[EducationRowDTO]] = None


# ─── Bulk Upload Schemas ────────────────────────────────────────────────────

class BulkRowError(CustomModel):
    field: str
    message: str


class BulkRowResult(CustomModel):
    row_num: int                           # 1-based, matches user's sheet row (header = 1, first data row = 2)
    status: str                            # "valid" | "error" | "duplicate" | "empty"
    parsed: Optional[dict] = None          # normalized row data (includes resolved IDs when valid)
    errors: list[BulkRowError] = Field(default_factory=list)


class BulkValidateResult(CustomModel):
    total_rows: int
    valid_count: int
    error_count: int
    duplicate_count: int
    file_errors: list[str] = Field(default_factory=list)   # file-level errors (e.g. missing required columns)
    rows: list[BulkRowResult] = Field(default_factory=list)


class BulkUploadResult(CustomModel):
    total: int
    successful: int
    failed: int
    errors: list[dict] = Field(default_factory=list)       # [{ row_num, message }]
    created_ids: list[str] = Field(default_factory=list)


class CtcHistoryEntry(CustomModel):
    value: Optional[float] = None
    updated_on: Optional[datetime] = Field(None, alias="updatedOn")


class EmployeeResponse(CustomModel):
    id: PydanticObjectId
    organisation_id: Optional[PydanticObjectId] = Field(None, alias="organisationId")
    emp_code: Optional[str] = Field(None, alias="empCode")
    # Optional secondary emp code — present only on the few employees that carry one.
    alias: Optional[str] = Field(None, alias="alias")
    user_id: Optional[PydanticObjectId] = Field(None, alias="userId")

    # From user $lookup — may be absent if user doc is missing
    work_email: Optional[str] = Field(None, alias="workEmail")
    first_name: Optional[str] = Field(None, alias="firstName")
    middle_name: Optional[str] = Field(None, alias="middleName")
    last_name: Optional[str] = Field(None, alias="lastName")
    dob: Optional[date] = None

    # Work
    business_unit_id: Optional[PydanticObjectId] = Field(None, alias="businessUnitId")
    department_id: Optional[PydanticObjectId] = Field(None, alias="departmentId")
    designation_id: Optional[PydanticObjectId] = Field(None, alias="designationId")
    source_of_hire: Optional[MasterDataCompact] = Field(None, alias="sourceOfHire")
    l1_manager_id: Optional[PydanticObjectId] = Field(None, alias="l1ManagerId")
    l2_manager_id: Optional[PydanticObjectId] = Field(None, alias="l2ManagerId")
    current_exp: Optional[float] = Field(None, alias="currentExp")
    total_exp: Optional[float] = Field(None, alias="totalExp")
    employment_type: Optional[MasterDataCompact] = Field(None, alias="employmentType")
    employment_status: Optional[MasterDataCompact] = Field(None, alias="employmentStatus")
    project_status: Optional[MasterDataCompact] = Field(None, alias="projectStatus")
    date_of_joining: Optional[date] = Field(None, alias="dateOfJoining")
    date_of_exit: Optional[date] = Field(None, alias="dateOfExit")

    # Effective-dated history — designation, department, employment status,
    # project status, L1/L2 manager. Newest-last. CTC is NOT included here; it
    # keeps its own always-immediate ctc_history below. pending_changes holds
    # anything queued for a future date.
    designation_history: list[FieldHistoryEntryDTO] = Field(default_factory=list, alias="designationHistory")
    department_history: list[FieldHistoryEntryDTO] = Field(default_factory=list, alias="departmentHistory")
    employment_status_history: list[FieldHistoryEntryDTO] = Field(default_factory=list, alias="employmentStatusHistory")
    project_status_history: list[FieldHistoryEntryDTO] = Field(default_factory=list, alias="projectStatusHistory")
    l1_manager_history: list[FieldHistoryEntryDTO] = Field(default_factory=list, alias="l1ManagerHistory")
    l2_manager_history: list[FieldHistoryEntryDTO] = Field(default_factory=list, alias="l2ManagerHistory")
    pending_changes: list[PendingFieldChangeDTO] = Field(default_factory=list, alias="pendingChanges")

    # Compensation — ctc is the current amount (decrypted); ctc_history holds prior
    # revisions newest-last. Both derive from the stored {current, history} dict.
    ctc: Optional[float] = None
    ctc_history: dict[str, CtcHistoryEntry] = Field(default_factory=dict, alias="ctcHistory")
    currency: Optional[str] = None
    ctc_history: list[CtcHistoryEntry] = Field(default_factory=list, alias="ctcHistory")

    # Personal
    gender: Optional[MasterDataCompact] = None
    marital_status: Optional[MasterDataCompact] = Field(None, alias="maritalStatus")
    about_me: Optional[str] = Field(None, alias="aboutMe")

    # Bank Details
    bank_details: Optional[BankDetailsDTO] = Field(None, alias="bankDetails")

    # Identity & Contact
    identity_fields: list[IdentityFieldDTO] = Field(default_factory=list, alias="identityFields")
    work_phone_extension: Optional[str] = Field(None, alias="workPhoneExtension")
    work_phone: Optional[str] = Field(None, alias="workPhone")
    personal_phone: Optional[str] = Field(None, alias="personalPhone")
    personal_email: Optional[str] = Field(None, alias="personalEmail")
    seat_location: Optional[str] = Field(None, alias="seatLocation")

    # Emergency Contacts
    emergency_contacts: list[EmergencyContactDTO] = Field(default_factory=list, alias="emergencyContacts")

    # Repeatable
    work_experience: list[WorkExperienceRowDTO] = Field(default_factory=list, alias="workExperience")
    dependents: list[DependentRowDTO] = Field(default_factory=list)
    education: list[EducationRowDTO] = Field(default_factory=list)

    # Addresses
    permanent_address_id: Optional[PydanticObjectId] = Field(None, alias="permanentAddressId")
    present_address_id: Optional[PydanticObjectId] = Field(None, alias="presentAddressId")
    same_as_permanent: bool = Field(False, alias="sameAsPermanent")
    permanent_address: Optional[AddressResponse] = Field(None, alias="permanentAddress")
    present_address: Optional[AddressResponse] = Field(None, alias="presentAddress")

    # Populated via $lookup
    business_unit_name: Optional[str] = Field(None, alias="businessUnitName")
    department_name: Optional[str] = Field(None, alias="departmentName")
    designation_name: Optional[str] = Field(None, alias="designationName")
    l1_manager_name: Optional[str] = Field(None, alias="l1ManagerName")
    l1_manager_email: Optional[str] = Field(None, alias="l1ManagerEmail")
    l1_manager_emp_code: Optional[str] = Field(None, alias="l1ManagerEmpCode")
    l2_manager_name: Optional[str] = Field(None, alias="l2ManagerName")
    l2_manager_email: Optional[str] = Field(None, alias="l2ManagerEmail")
    l2_manager_emp_code: Optional[str] = Field(None, alias="l2ManagerEmpCode")
    policies: list[PolicyCompact] = Field(default_factory=list)
    custom_fields: list[FieldWithValue] = Field(default_factory=list)
    # True when the linked account has never been activated → eligible for resend.
    activation_pending: bool = Field(default=False, alias="activationPending")


class EmployeePermissionResponse(CustomModel):
    """What the caller may do on the /employees routes.

    Saves the FE from re-deriving the answer out of the /me grid and getting
    the thresholds subtly wrong. The three flags map onto the exact levels
    router.py binds its guards at — viewer reads, editor writes, admin deletes
    — so `can_edit: true` means PUT will genuinely succeed, not "probably".

    Everything defaults to denied, so an ungranted caller and an unresolvable
    one read the same.
    """
    module: str = "core_hr"
    code: str = "resource_management"
    granted: bool = False
    level: str | None = None          # viewer | editor | admin, None when ungranted
    can_view: bool = False
    can_edit: bool = False
    can_delete: bool = False
