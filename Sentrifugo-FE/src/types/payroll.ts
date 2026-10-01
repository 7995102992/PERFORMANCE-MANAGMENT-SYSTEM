// ─── Payslip upload (POST/PUT/GET /payslips/uploads) ──────────────────────────

export type UploadedPayslipStatus = 'uploaded' | 'processed' | 'failed'

/** Response model returned by create/replace/get(single)/list. */
export interface UploadedPayslip {
  id: string
  organisation_id?: string
  business_unit_id?: string
  file_name: string
  /** Internal storage key — never use for downloads. */
  path?: string
  month: number // 1-12
  year: number
  /** Human-readable period, e.g. "May 2026". */
  period_label?: string
  /** Increments per PUT for the same month/year. */
  version: number
  /** Employee rows in the file (aggregate). */
  no_of_records?: number
  /** Sum of net pay across the file's payslips. */
  net_total?: number
  /** Average net pay across the file's payslips. */
  avg_net?: number
  status?: UploadedPayslipStatus
  reason: string | null
  uploaded_by: string
  /**
   * Uploader's display name, denormalised onto the record. Null on uploads
   * created before the BE started populating it — those still carry
   * `uploaded_by`, so fall back to the IAM directory lookup. See
   * `useEmployeeLookup().uploaderName`.
   */
  uploaded_by_name?: string | null
  uploaded_on: string // ISO-8601 UTC
  /** Presigned, short-lived (~5 min); null only if storage is misconfigured. */
  download_url: string | null
}

/** GET /payslips/uploads/summary — aggregates for the most recent payroll period. */
export interface PayrollSummary {
  month: number
  year: number
  period_label: string
  total_gross_pay: number
  /** null for old-template uploads. */
  total_gross_pay_ytd: number | null
  total_net_pay: number
  /** null for old-template uploads. */
  total_net_pay_ytd: number | null
  no_of_employees: number
  /** Caller's total payslip count across all periods (my-payroll summary only). */
  no_of_payslips?: number
}

export type PayrollChartRange = '1y' | '6m' | '3m'

export interface PayrollSummaryChartPoint {
  year: number
  month: number
  month_label: string
  period_label: string
  total_earnings: number // == net_amount + deductions
  deductions: number
  net_amount: number
  has_data: boolean
}

/** GET /payslips/uploads/summary-chart — trailing-window monthly aggregates. */
export interface PayrollSummaryChart {
  range: PayrollChartRange
  points: PayrollSummaryChartPoint[]
}

/** Paginated list response for GET /payslips/uploads. */
export interface UploadedPayslipListResponse {
  items: UploadedPayslip[]
  page: number
  page_size: number
  total: number
  total_pages: number
}

/** Arguments for an upload (sent as multipart/form-data alongside the file). */
export interface PayslipUploadArgs {
  file: File
  month: number
  year: number
  /** Optional for POST (v1); required for PUT (new version). */
  reason?: string
}

export interface PayslipListParams {
  year?: number
  month?: number
  status?: UploadedPayslipStatus
  /** Matches file name or pay period ("May 2026", "may", "2026"). */
  search?: string
  page?: number
  page_size?: number
}

/** Standard error body returned by every payroll endpoint. */
export interface PayrollApiError {
  detail: string
  code: PayrollErrorCode | string
  correlation_id?: string
}

export type PayrollErrorCode =
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UPLOAD'
  | 'REASON_REQUIRED'
  | 'MISSING_PERIOD'
  | 'INVALID_ID'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PAYSLIP_UPLOAD_CONFLICT'
  | 'VALIDATION_ERROR'
  | 'STORAGE_ERROR'
  // Unlock-gate codes (see PayrollPinGate)
  | 'PAYSLIP_LOCKED'
  | 'PIN_SERVICE_UNAVAILABLE'
  | 'PAYSLIP_UNLOCK_FAILED'
  | 'SESSION_INVALID'

// Client-side pre-validation rules (mirror the server's).
export const ALLOWED_PAYSLIP_EXTENSIONS = ['.csv', '.xls', '.xlsx'] as const
export const MAX_PAYSLIP_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

// ─── Dry-run validation (POST /payslips/uploads/validate) ─────────────────────

export interface PayslipRowValidation {
  row_num: number
  emp_code: string | null
  status: 'valid' | 'error' | string
  issues: string[]
}

export interface PayslipValidationResult {
  /** File is usable even if some rows error (only file_errors block the upload). */
  valid: boolean
  total_rows: number
  valid_rows: number
  error_rows: number
  /** Absent template columns — these default to 0 (amounts) / null on import. */
  missing_columns: string[]
  /** Blocking issues (e.g. no emp_code column / unreadable file). */
  file_errors: string[]
  /** false when the IAM employee check was skipped (directory unreachable/slow). */
  employees_checked: boolean
  rows: PayslipRowValidation[]
}

// ─── Per-employee payroll (Employee Payroll screen) ───────────────────────────
// Mirrors the 25-column upload template; totals/net are derived.

export interface PayslipEarnings {
  basic_salary: number
  hra: number
  uniform_allowance: number
  telephone_or_mobile: number
  magazines: number
  LTA: number
  retention_incentive: number
  arrears: number
  incentive_or_project_allowwance: number
  total: number
}

export interface PayslipDeductions {
  income_tax: number
  provident_fund: number
  professional_tax: number
  esi: number
  other_deductions: number
  salary_advance: number
  health_insurance_premium: number
  gmc_premium: number
  total: number
}

/** A single employee's payslip for a period — GET /payslips item. */
export interface Payslip {
  id: string
  user_id: string
  emp_code: string
  // IAM-owned bio — null until denormalised onto the payslip at import.
  full_name: string | null
  designation: string | null
  date_of_joining: string | null
  gender: string | null
  month: number
  year: number
  uploaded_by: string
  /**
   * Uploader's display name, denormalised at import. Only payslips imported
   * after that change carry it — older rows are null and fall back to resolving
   * `uploaded_by` through the IAM directory.
   */
  uploaded_by_name?: string | null
  uploaded_on: string // ISO-8601 UTC
  earnings: PayslipEarnings
  deductions: PayslipDeductions
  net_amount: number
  standard_days: number
  days_worked: number
  /**
   * Statutory identifiers. `pf_no` / `uan_number` / `account_no` come masked
   * (xxxxxx + last 4) unless the endpoint is called unmasked; `pan_no` is full.
   *
   * All four are opaque STRINGS — never coerce them to numbers or render them
   * through a numeric column. A 12-digit UAN through Number() or an Excel
   * general-format cell becomes 1.0207E+11 and loses digits. Anything exporting
   * these must force the column to Text.
   */
  pf_no: string
  uan_number: string
  pan_no: string
  bank_name: string
  account_no: string
}

export interface PayslipQueryParams {
  year?: number
  month?: number
  /** Matches employee id (emp_code). */
  search?: string
  page?: number // >= 1, default 1
  page_size?: number // 1-100, default 20
}

export interface PaginatedPayslips {
  items: Payslip[]
  page: number
  page_size: number
  total: number
  total_pages: number
}

// ─── My payslip history (GET /my-payroll/list) ─────────────────────────────────

export interface MyPayslip {
  id: string
  month: number
  year: number
  period_label: string
  file_name: string
  gross: number // == net_pay + deductions
  deductions: number
  net_pay: number
  status: UploadedPayslipStatus
}

export interface MyPayslipListParams {
  year?: number
  month?: number
  search?: string
  page?: number
  page_size?: number
}

export interface MyPayslipListResponse {
  items: MyPayslip[]
  page: number
  page_size: number
  total: number
  total_pages: number
}

// ─── Secure PIN lock (POST /my-payroll/unlock) ───────────────────────────────

export interface PayslipUnlockResponse {
  /** True when the supplied PIN was correct and a payroll unlock was minted. */
  unlocked: boolean
  /** False when the caller has no Secure PIN yet (prompt setup, don't say "wrong PIN"). */
  pin_set: boolean
  /** True when too many wrong attempts triggered a server-side cooldown. */
  locked: boolean
  /** Seconds left on the cooldown (when `locked`). */
  retry_after: number
  /** Seconds the unlock stays valid (fixed 300 s window). Present only when unlocked. */
  expires_in?: number
}

export const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const
