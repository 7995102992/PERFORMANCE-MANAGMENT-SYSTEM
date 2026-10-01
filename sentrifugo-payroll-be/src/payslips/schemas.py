"""Payslip schemas and the structured salary value objects.

``Earnings`` and ``Deductions`` are the decrypted, in-application shape of the
sensitive payslip components. At rest they live as a single Fernet-encrypted
blob on :class:`src.payslips.models.PayslipDocument`; the model encrypts on
write and decrypts back into these models on read.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "Earnings",
    "Deductions",
    "PayslipCreate",
    "PayslipRead",
    "UploadedPayslipRead",
    "PayslipRowError",
    "PayslipImportResult",
    "PayslipUploadResponse",
    "UploadedPayslipListItem",
    "UploadedPayslipListResponse",
    "PayrollSummary",
    "PayslipSummaryPoint",
    "PayslipSummaryChart",
    "MyPayslipListItem",
    "MyPayslipListResponse",
    "PayslipPeriod",
    "BulkPayslipExportRequest",
    "PinVerifyRequest",
    "PinVerifyResponse",
    "PayslipListItem",
    "PayslipListResponse",
    "PayslipRowValidation",
    "PayslipValidationResult",
]


class PayslipSchema(BaseModel):
    """Base for payslip schemas.

    Mirrors ``src.models.CustomModel`` (``populate_by_name`` + ``extra='ignore'``)
    but is defined locally so this module has no import dependency on
    ``src.models`` — that module imports the payslip *documents*, which import
    these schemas, so importing back would form a circular import.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class Earnings(PayslipSchema):
    """Salary earning components (display subset). Stored as floats, exact values."""

    basic_salary: float = 0.0
    hra: float = 0.0
    uniform_allowance: float = 0.0
    telephone_or_mobile: float = 0.0
    magazines: float = 0.0
    LTA: float = 0.0
    retention_incentive: float = 0.0
    arrears: float = 0.0
    incentive_or_project_allowwance: float = 0.0  # spelling kept to match schemaScript.js
    total: float = 0.0


class Deductions(PayslipSchema):
    """Salary deduction components (display subset). Stored as floats, exact values."""

    income_tax: float = 0.0
    provident_fund: float = 0.0
    professional_tax: float = 0.0
    esi: float = 0.0
    other_deductions: float = 0.0
    salary_advance: float = 0.0
    health_insurance_premium: float = 0.0
    gmc_premium: float = 0.0
    total: float = 0.0


class PayslipCreate(PayslipSchema):
    """Inbound payslip data in plaintext, before encryption at rest.

    This is the shape a producer (e.g. an upstream service over RabbitMQ) sends.
    :meth:`src.payslips.models.PayslipDocument.from_create` encrypts the
    sensitive fields (``earnings``, ``deductions``, ``uan_number``, ``pf_no``,
    ``pan_no``, ``bank_name``, ``account_no``) before persisting.
    """

    payslip_file_id: str
    user_id: str
    emp_code: str
    month: int
    year: int
    full_name: str | None = None
    designation: str | None = None
    date_of_joining: str | None = None
    gender: str | None = None
    earnings: Earnings
    deductions: Deductions
    # Full row of every other amount column (CTC, Per Month, all *_YTD, net_salary,
    # LOP, ...) keyed by canonical name. Encrypted whole at rest.
    extra: dict = Field(default_factory=dict)
    standard_days: int | None = None
    days_worked: int | None = None
    uan_number: str | None = None
    pf_no: str | None = None
    pan_no: str | None = None
    bank_name: str | None = None
    account_no: str | None = None


class UploadedPayslipRead(PayslipSchema):
    """Metadata for an uploaded payslip file (``payslips_uploaded``).

    ``download_url`` is a short-lived presigned link to the object in Spaces.
    """

    id: str
    organisation_id: str
    business_unit_id: str
    file_name: str
    path: str
    month: int
    year: int
    version: int
    reason: str | None = None
    uploaded_by: str | None = None
    uploaded_on: datetime | None = None
    download_url: str | None = None


class PayslipRowError(PayslipSchema):
    """A single CSV row that could not be turned into a payslip."""

    row_num: int  # 1-based sheet row (header = 1, first data row = 2)
    emp_code: str | None = None
    message: str


class PayslipImportResult(PayslipSchema):
    """Outcome of populating the payslips collection from an uploaded file."""

    # completed: rows processed. deferred: IAM/broker unavailable, retry later.
    # skipped: file unreadable / wrong columns (nothing processed).
    status: str
    total_rows: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[PayslipRowError] = Field(default_factory=list)
    message: str | None = None


class PayslipUploadResponse(PayslipSchema):
    """Returned by POST/PUT: the stored file record + the population outcome."""

    upload: UploadedPayslipRead
    import_result: PayslipImportResult


class UploadedPayslipListItem(PayslipSchema):
    """One row of the payslip-uploads management screen.

    Combines the stored upload record with live aggregates over the payslips it
    populated (``no_of_records`` / ``net_total`` / ``avg_net``). ``uploaded_by``
    is the uploader's user-id (the frontend resolves the display name).
    """

    id: str
    file_name: str
    month: int
    year: int
    period_label: str  # e.g. "May 2026"
    version: int
    no_of_records: int = 0
    net_total: float = 0.0
    avg_net: float = 0.0
    status: str
    reason: str | None = None
    uploaded_by: str | None = None
    uploaded_on: datetime | None = None
    download_url: str | None = None


class UploadedPayslipListResponse(PayslipSchema):
    """Paginated payslip-uploads list for the management screen."""

    items: list[UploadedPayslipListItem]
    page: int
    page_size: int
    total: int
    total_pages: int


class PayrollSummary(PayslipSchema):
    """Org-wide payroll summary card for the most recent payroll period.

    Totals are summed over every payslip in the latest period for the caller's
    organisation. ``*_ytd`` are the year-to-date figures from the uploaded sheet's
    YTD columns; they are ``null`` for legacy (<= May 2026) periods that carried
    no YTD columns. All fields default to empty/0 when the org has no payslips.
    """

    month: int | None = None
    year: int | None = None
    period_label: str | None = None  # e.g. "May 2026"
    total_gross_pay: float = 0.0
    total_gross_pay_ytd: float | None = None
    total_net_pay: float = 0.0
    total_net_pay_ytd: float | None = None
    no_of_employees: int = 0
    # Self-service only: total payslips the logged-in user has (all periods). 0 for
    # the org card, where ``no_of_employees`` is the relevant count.
    no_of_payslips: int = 0


class PayslipSummaryPoint(PayslipSchema):
    """One month bucket of the payslip-summary chart (org-wide totals).

    ``total_earnings`` == ``net_amount`` + ``deductions``. ``has_data`` is False for
    months in the window with no payslips (render greyed/empty).
    """

    year: int
    month: int
    month_label: str  # full month name, e.g. "April"
    period_label: str  # e.g. "Apr 2026"
    total_earnings: float = 0.0
    deductions: float = 0.0
    net_amount: float = 0.0
    has_data: bool = False


class PayslipSummaryChart(PayslipSchema):
    """Org-wide payslip-summary chart over a rolling window ending this month."""

    range: str  # "1y" | "6m" | "3m"
    points: list[PayslipSummaryPoint]


class MyPayslipListItem(PayslipSchema):
    """One row of the logged-in employee's own payslip history.

    ``gross`` == ``net_pay`` + ``deductions``. ``file_name``/``status`` come from
    the upload that populated the payslip.
    """

    id: str
    month: int
    year: int
    period_label: str  # e.g. "May 2026"
    file_name: str | None = None
    gross: float = 0.0
    deductions: float = 0.0
    net_pay: float = 0.0
    status: str


class MyPayslipListResponse(PayslipSchema):
    """Paginated payslip history for the logged-in employee."""

    items: list[MyPayslipListItem]
    page: int
    page_size: int
    total: int
    total_pages: int


class PayslipPeriod(PayslipSchema):
    """A single payroll period (year + month)."""

    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class BulkPayslipExportRequest(PayslipSchema):
    """Request body for the bulk payslip export — one or more periods to download."""

    periods: list[PayslipPeriod] = Field(min_length=1)


class PinVerifyRequest(PayslipSchema):
    """Submitted PIN to check against the caller's stored PIN (screen-lock unlock)."""

    pin: str = Field(min_length=1, max_length=20)


class PinVerifyResponse(PayslipSchema):
    """Result of a PIN check. ``pin_set`` is False when the caller has no PIN yet."""

    valid: bool
    pin_set: bool


class PayslipRowValidation(PayslipSchema):
    """Validation outcome for one CSV data row."""

    row_num: int  # 1-based sheet row (header = 1, first data row = 2)
    emp_code: str | None = None
    status: str  # "valid" | "error"
    issues: list[str] = Field(default_factory=list)


class PayslipValidationResult(PayslipSchema):
    """Dry-run validation of a payslip CSV before upload (nothing is stored)."""

    valid: bool  # the file itself is parseable/usable (rows may still have issues)
    total_rows: int = 0
    valid_rows: int = 0
    error_rows: int = 0
    # Template columns absent from the file — informational only; those fields
    # default to 0 (amounts) or null. A missing column never invalidates the file.
    missing_columns: list[str] = Field(default_factory=list)
    file_errors: list[str] = Field(default_factory=list)
    # False when employee existence couldn't be checked (IAM unreachable/slow).
    employees_checked: bool = True
    rows: list[PayslipRowValidation] = Field(default_factory=list)


class PayslipListItem(PayslipSchema):
    """One payslip row for the employee list, with all owned data decrypted.

    Sensitive identifiers are masked (last 4 shown) except ``pan_no``. The
    employee display fields (``full_name`` / ``designation`` / ``date_of_joining``
    / ``gender``) are IAM-owned and ``null`` until enriched.
    """

    id: str
    user_id: str
    emp_code: str
    # IAM-owned display fields (null until enriched/denormalised)
    full_name: str | None = None
    designation: str | None = None
    date_of_joining: str | None = None
    gender: str | None = None
    # Period + who/when it was uploaded
    month: int
    year: int
    uploaded_by: str | None = None
    uploaded_on: datetime | None = None
    # Financials (decrypted)
    earnings: Earnings
    deductions: Deductions
    extra: dict = Field(default_factory=dict)  # CTC, Per Month, all *_YTD, net_salary, LOP, ...
    net_amount: float | None = None
    standard_days: int | None = None
    days_worked: int | None = None
    # Statutory / bank — masked, except PAN which is shown in full
    pf_no: str | None = None
    uan_number: str | None = None
    pan_no: str | None = None
    bank_name: str | None = None
    account_no: str | None = None


class PayslipListResponse(PayslipSchema):
    """Paginated employee payslip list."""

    items: list[PayslipListItem]
    page: int
    page_size: int
    total: int
    total_pages: int


class PayslipRead(PayslipSchema):
    """API representation of a payslip with all sensitive fields decrypted."""

    id: str
    payslip_file_id: str
    user_id: str
    emp_code: str
    month: int
    year: int
    full_name: str | None = None
    designation: str | None = None
    date_of_joining: str | None = None
    gender: str | None = None
    earnings: Earnings
    deductions: Deductions
    extra: dict = Field(default_factory=dict)
    total: float | None = None  # net salary
    standard_days: int | None = None
    days_worked: int | None = None
    uan_number: str | None = None
    pf_no: str | None = None
    pan_no: str | None = None
    bank_name: str | None = None
    account_no: str | None = None
