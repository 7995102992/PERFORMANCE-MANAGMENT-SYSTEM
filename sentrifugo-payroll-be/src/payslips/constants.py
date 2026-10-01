"""Constants for the payslips domain."""

# Accepted formats for a payslip-batch upload (xlsx/xlsm workbooks or a CSV).
ALLOWED_EXTENSIONS = {".xlsx", ".xlsm", ".csv"}

# Upload size ceiling. Guards against abuse and unbounded in-memory reads.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

# ── Upload processing status ─────────────────────────────────────────────────
# Lifecycle of a stored upload file. Populate runs synchronously right after the
# file is stored, so the status is known by the time the request returns.
UPLOAD_STATUS_UPLOADED = "uploaded"  # file stored; no payslip rows populated (yet / IAM deferred)
UPLOAD_STATUS_PROCESSED = "processed"  # rows populated into the payslips collection
UPLOAD_STATUS_FAILED = "failed"  # file unreadable / wrong columns — nothing stored
UPLOAD_STATUSES = (UPLOAD_STATUS_UPLOADED, UPLOAD_STATUS_PROCESSED, UPLOAD_STATUS_FAILED)

# ── Upload template (xlsx) ───────────────────────────────────────────────────
# Raw column headers of the salary workbook, in display order — one row per
# employee. Columns may be reshuffled: the parser matches by header *name*, not
# position. ``month``/``year`` are chosen at upload time (not columns here). The
# `* YTD`, CTC, etc. are all stored; only S.NO and the trailing PF Employer
# Share / Gratuity / Variable Pay columns are ignored.
TEMPLATE_HEADERS = [
    "SIL ID",
    "NAME OF THE EMPLOYEE",
    "DESIGNATION",
    "CTC",
    "Per Month",
    "Fixed Basic Salary",
    "BASIC",
    "BASIC YTD",
    "Variable Pay / Performance Incentive",
    "Days in Month",
    "No of Days Worked",
    "LOP",
    "SALARY EARNED",
    "HRA",
    "HRA YTD",
    "ARREARS",
    "ARREARS YTD",
    "LTA",
    "LTA YTD",
    "Incentive /Projects Allowance",
    "Incentive /Projects Allowance YTD",
    "TOTALEARNINGS",
    "INCOME TAX",
    "INCOME TAX YTD",
    "PT",
    "PT YTD",
    "PF",
    "PF YTD",
    "Health Insurance Premium 25%",
    "Health Insurance Premium 25% YTD",
    "GMC Premium Parental",
    "GMC Premium Parental YTD",
    "OTHERSDEDUCTIONS",
    "ADVANCE TO STAFF",
    "ADVANCE TO STAFF YTD",
    "TOTALDEDUCTIONS",
    "NET SALARY",
    "PF NO",
    "PAN NO",
    "BANK NAME",
    "ACCOUNT NO",
    "DATE OF JOINING",
    "UAN NO",
    "Gender",
]

TEMPLATE_FILENAME = "payslip_upload_template.xlsx"
TEMPLATE_SHEET_NAME = "Payslips"

# ── Legacy template (periods up to & including May 2026) ──────────────────────
# Before June 2026 the salary workbook used a different column set: it carried
# Uniform / Telephone / Professional-Pursuit (Magazines) / Retention Incentive /
# ESI columns and had no `* YTD` columns at all. Periods at or before this cutoff
# download this template and render the legacy payslip PDF layout.
OLD_TEMPLATE_LAST_YEAR = 2026
OLD_TEMPLATE_LAST_MONTH = 5  # May 2026 is the last legacy period; June 2026 is new

TEMPLATE_HEADERS_OLD = [
    "S.NO",
    "SIL ID",
    "NAME OF THE EMPLOYEE",
    "DESIGNATION",
    "CTC",
    "Per Month",
    "Fixed Basic Salary",
    "BASIC",
    "Retention Incentive",
    "Days in Month",
    "No of Days Worked",
    "LOP",
    "SALARY EARNED",
    "HRA",
    "ARREARS",
    "Uniform allowance",
    "Telephone & Internet Allowance.",
    "Professional Pursuit Allowance",
    "LTA",
    "Incentive /Projects Allowance",
    "TOTALEARNINGS",
    "INCOME TAX",
    "PT",
    "PF",
    "ESI",
    "Health Insurance Premium 25%",
    "GMC Premium Parental",
    "OTHERSDEDUCTIONS",
    "ADVANCE TO STAFF",
    "TOTALDEDUCTIONS",
    "NET SALARY",
    "PF NO",
    "PAN NO",
    "BANK NAME",
    "ACCOUNT NO",
    "DATE OF JOINING",
    "UAN NO",
    "Gender",
    "PF Employer Share",
    "Gratuty",
    "Varibale Salary",
]
TEMPLATE_FILENAME_OLD = "payslip_upload_template_old.xlsx"


def uses_old_template(year: int, month: int) -> bool:
    """True for periods at or before the legacy cutoff (May 2026)."""
    return (year, month) <= (OLD_TEMPLATE_LAST_YEAR, OLD_TEMPLATE_LAST_MONTH)


# Normalised header labels (lowercase, single-spaced) that identify the salary
# data sheet in a multi-sheet workbook — used to auto-pick the right sheet.
SHEET_SIGNATURE = ("sil id", "net salary")

# ── Export ───────────────────────────────────────────────────────────────────
# Flat column order for the payslip-list CSV export. Mirrors the list response
# (sensitive ids masked, amounts/PAN in full). Order must match service._export_row.
EXPORT_COLUMNS = [
    "emp_code",
    "full_name",
    "designation",
    "date_of_joining",
    "gender",
    "month",
    "year",
    "uploaded_by",
    "uploaded_on",
    "basic_salary",
    "hra",
    "uniform_allowance",
    "telephone_or_mobile",
    "magazines",
    "lta",
    "retention_incentive",
    "arrears",
    "incentive_or_project_allowance",
    "total_earnings",
    "income_tax",
    "provident_fund",
    "professional_tax",
    "esi",
    "other_deductions",
    "salary_advance",
    "health_insurance_premium",
    "gmc_premium",
    "total_deductions",
    "net_amount",
    "standard_days",
    "days_worked",
    "pan_no",
    "pf_no",
    "uan_number",
    "bank_name",
    "account_no",
]

# Safety cap so an unfiltered export can't load unbounded rows into memory.
EXPORT_MAX_ROWS = 50000

# ── Employee PIN ─────────────────────────────────────────────────────────────
# The PIN (generation, storage, email) is owned by IAM; this service fetches it
# over RPC and decrypts it (see ``src.payslips.pin_service``). It remains the
# open-password for payslip PDFs.
