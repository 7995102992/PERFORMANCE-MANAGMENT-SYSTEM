// Shared audit fields present on all response objects
export interface AuditFields {
  created_on: string;
  created_by: string;
  updated_on: string;
  updated_by: string;
  deleted_on: string | null;
  deleted_by: string | null;
  correlation_id: string | null;
}

// ─── Leave Types ───────────────────────────────────────────────

export type LeaveTypeGender = "MALE" | "FEMALE" | "OTHER";
export type LeaveTypeMaritalStatus = "SINGLE" | "MARRIED" | "DIVORCED" | "WIDOWED";

export interface LeaveTypeRestrictions {
  gender?: LeaveTypeGender | null;
  marital_status?: LeaveTypeMaritalStatus | null;
}

export type LeaveAccrualFrequency = "monthly" | "quarterly" | "half_yearly" | "yearly";

// The leave type now carries its own accrual + carry/encash configuration.
export interface LeaveTypeAccrual {
  annual_count?: number | null;
  accrual_frequency?: LeaveAccrualFrequency | null;
  carry_forward?: boolean;
  carry_forward_count?: number | null;
  encashable?: boolean;
  encash_percentage?: number | null;
}

// Non-accrual policies relocated onto the leave type (probation, negative
// balance, request limits, clubbing, etc.). Section shapes are validated by the
// leave-type form's zod schema; kept loose at the API-type level.
export type LeaveTypePolicies = Record<string, unknown>;

export interface LeaveTypeCreate {
  org_id: string;
  name: string;
  code: string;
  color?: string;
  unit?: "DAYS" | "HOURS";
  description?: string;
  is_paid?: boolean;
  is_paid_leave?: boolean;
  is_sick_leave?: boolean;
  is_statutory_leave?: boolean;
  max_statutory_days?: number | null;
  count_calendar_days?: boolean;
  is_comp_off?: boolean;
  expiry_days?: number | null;
  /** Waives balance / entitlement / employment-status gates on apply. */
  is_unrestricted?: boolean;
  /** ADVISORY yearly cap. Enforces nothing — going past it only triggers the
   *  "allocation exceeded" email to the employee and their approvers. */
  annual_limit?: number | null;
  /** Only meaningful with `is_unrestricted` — shows "used N days" to both
   *  the employee and the approver, since there is no balance to show. */
  show_usage_warning?: boolean;
  show_description?: boolean;
  deduct_from_balance?: boolean;
  deduct_from_leave_balance?: boolean;
  /**
   * Surface this type in analytics reports/dashboards. Opt-in: omit → BE
   * defaults false (hidden).
   */
  show_in_analytics?: boolean;
  /**
   * Surface this type in the employee's leave-balance list
   * (GET /leave-requests/balances). Opt-in like `show_in_analytics`: omit → BE
   * defaults false (hidden).
   */
  show_in_leave_balance?: boolean;
  restrictions?: LeaveTypeRestrictions | null;
  accrual?: LeaveTypeAccrual;
  policies?: LeaveTypePolicies;
}

export interface LeaveTypeUpdate {
  name?: string | null;
  code?: string | null;
  color?: string | null;
  unit?: "DAYS" | "HOURS" | null;
  description?: string | null;
  is_paid?: boolean | null;
  is_paid_leave?: boolean | null;
  is_sick_leave?: boolean | null;
  is_statutory_leave?: boolean | null;
  max_statutory_days?: number | null;
  count_calendar_days?: boolean | null;
  is_comp_off?: boolean | null;
  expiry_days?: number | null;
  is_unrestricted?: boolean | null;
  show_usage_warning?: boolean | null;
  annual_limit?: number | null;
  show_description?: boolean | null;
  deduct_from_balance?: boolean | null;
  deduct_from_leave_balance?: boolean | null;
  /** Sent with the rest of the form body; the BE persists the value as given. */
  show_in_analytics?: boolean | null;
  /** Sent with the rest of the form body; the BE persists the value as given. */
  show_in_leave_balance?: boolean | null;
  is_active?: boolean | null;
  restrictions?: LeaveTypeRestrictions | null;
  accrual?: LeaveTypeAccrual;
  policies?: LeaveTypePolicies;
}

export interface LeaveTypeResponse extends AuditFields {
  accrual_type: string;
  _id: string;
  org_id: string;
  name: string;
  code: string;
  /**
   * Backend-owned display position, 1-based. Read-only here: lists already
   * arrive sorted by it, so the client never sorts on it and never sends it.
   * Null for types created before ranking existed and not yet backfilled.
   */
  rank?: number | null;
  color?: string;
  unit: string;
  description?: string;
  is_custom?: boolean;
  is_paid?: boolean;
  is_paid_leave?: boolean;
  is_sick_leave?: boolean;
  is_statutory_leave?: boolean;
  max_statutory_days?: number | null;
  count_calendar_days?: boolean;
  is_comp_off?: boolean;
  expiry_days?: number | null;
  /** Waives balance / entitlement / employment-status gates on apply. */
  is_unrestricted?: boolean;
  /** ADVISORY yearly cap. Enforces nothing — going past it only triggers the
   *  "allocation exceeded" email to the employee and their approvers. */
  annual_limit?: number | null;
  /** Only meaningful with `is_unrestricted` — shows "used N days" to both
   *  the employee and the approver, since there is no balance to show. */
  show_usage_warning?: boolean;
  show_description?: boolean;
  deduct_from_balance?: boolean;
  deduct_from_leave_balance?: boolean;
  /**
   * Whether analytics surfaces this type. Optional because leave types created
   * before this field existed have no stored value — read it as `?? false`,
   * matching the BE's opt-in default.
   */
  show_in_analytics?: boolean;
  /**
   * Whether the employee's leave-balance list shows this type. Optional for the
   * same legacy reason — read it as `?? false`, matching `show_in_analytics`.
   */
  show_in_leave_balance?: boolean;
  is_active?: boolean;
  restrictions?: LeaveTypeRestrictions | null;
  gender_restriction?: string | null;
  marital_status_restriction?: string | null;
  accrual?: LeaveTypeAccrual;
  policies?: LeaveTypePolicies;
}

// ─── Holiday Plans ─────────────────────────────────────────────

export interface HolidayPlanListItem {
  _id: string;
  name: string;
  is_active: boolean;
}

export interface ReminderSettings {
  enabled: boolean;
  days_before?: number;
  template_id?: string;
}

export interface HolidayPlanCreate {
  name: string;
  year: number;
  business_unit_ids?: string[];
  department_ids?: string[];
  reminder_settings?: ReminderSettings;
  notify_employees?: boolean | null;
  reprocess_leaves?: boolean | null;
}

export interface HolidayPlanUpdate {
  name?: string | null;
  year?: number | null;
  business_unit_ids?: string[] | null;
  department_ids?: string[] | null;
  reminder_settings?: ReminderSettings | null;
  is_active?: boolean | null;
  notify_employees?: boolean | null;
  reprocess_leaves?: boolean | null;
}

export interface HolidayPlanResponse extends AuditFields {
  _id: string;
  org_id: string;
  name: string;
  year: number;
  business_units?: Array<Record<string, unknown>>;
  departments?: Array<Record<string, unknown>>;
  reminder_settings?: ReminderSettings;
  is_active: boolean;
  notify_employees?: boolean | null;
  reprocess_leaves?: boolean | null;
}

// ─── Holiday Classifications ──────────────────────────────────

export interface ClassificationCreate {
  name: string;
  color: string;
}

export interface ClassificationUpdate {
  name?: string | null;
  color?: string | null;
}

export interface ClassificationResponse extends AuditFields {
  _id: string;
  id?: string;
  org_id: string;
  name: string;
  color: string;
}

// ─── Holidays ──────────────────────────────────────────────────

export interface ClassificationRef {
  id: string;
  name: string;
  color: string;
}

export interface HolidayCreate {
  plan_id: string;
  name: string;
  date: string;
  classification_id: string;
  applicable_department_ids?: string[];
  business_unit_ids: string[];
  reminder?: ReminderSettings;
  description?: string | null;
  notify_employees?: boolean | null;
  reprocess_leaves?: boolean | null;
}

export interface BulkHolidayItem {
  name: string;
  date: string;
  classification_id: string;
  applicable_department_ids?: string[];
  business_unit_ids: string[];
}

export interface BulkHolidayImport {
  plan_id: string;
  holidays: BulkHolidayItem[];
}

export interface BulkHolidayImportResponse {
  imported: number;
  skipped: number;
  skipped_dates: string[];
}

export interface HolidayBulkValidateRow {
  row_num: number
  name: string
  year: string | null
  date: string
  classification: string
  classification_id: string
  description: string
  status: 'valid' | 'error' | 'duplicate' | 'year_mismatch'
  errors: string[]
  /** Set when status === 'year_mismatch' — date shifted to the plan year. */
  suggested_date?: string | null
}

export interface HolidayBulkValidateResult {
  rows: HolidayBulkValidateRow[]
  summary: {
    total: number
    valid: number
    errors: number
    duplicates: number
    year_mismatches?: number
  }
}

export interface HolidayUpdate {
  name?: string | null;
  date?: string | null;
  classification_id?: string | null;
  applicable_department_ids?: string[] | null;
  business_unit_ids?: string[] | null;
  reminder?: ReminderSettings | null;
  description?: string | null;
  notify_employees?: boolean | null;
  reprocess_leaves?: boolean | null;
}

export interface HolidayResponse extends AuditFields {
  _id: string;
  plan_id: string;
  org_id: string;
  name: string;
  date: string;
  classification?: ClassificationRef | null;
  applicable_department_ids?: string[];
  business_unit_ids: string[];
  reminder?: ReminderSettings;
  description?: string | null;
  notify_employees?: boolean | null;
  reprocess_leaves?: boolean | null;
}

export interface HolidayListResponse {
  items: HolidayResponse[];
  total: number;
  page: number;
  page_size: number;
}

// ─── Holiday Plan Employees ───────────────────────────────────

export interface HolidayPlanEmployeeSync {
  user_ids: string[];
}

/** Employee display fields the LMS resolves from its mirror and attaches to
 *  membership responses, so the FE need not fetch employees from IAM and join. */
export interface EnrichedEmployeeFields {
  name?: string | null;
  emp_code?: string | null;
  work_email?: string | null;
  department_name?: string | null;
  business_unit_name?: string | null;
  designation_name?: string | null;
}

/** A row from the LMS employee-pool endpoint (assignment pickers). Everything
 *  the pickers render is resolved server-side from the LMS mirror. */
export interface ScopedEmployee extends EnrichedEmployeeFields {
  user_id: string;
  first_name?: string | null;
  last_name?: string | null;
  department_id?: string | null;
  business_unit_id?: string | null;
  designation_id?: string | null;
  employment_type_id?: string | null;
  employment_type?: string | null;
  employment_status_id?: string | null;
  employment_status?: string | null;
}

export interface ScopedEmployeeList {
  items: ScopedEmployee[];
  total: number;
  skip: number;
  limit: number;
}

export interface ScopedEmployeeParams {
  business_unit_ids?: string[];
  department_ids?: string[];
  designation_ids?: string[];
  employment_type_id?: string;
  search?: string;
  skip?: number;
  limit?: number;
}

/** One (user, other-scope-name) pairing from a cross-assignments batch call —
 *  the FE groups these into the "also assigned to: X, Y" warning. */
export interface CrossAssignmentEntry {
  user_id: string;
  scope_name?: string | null;
}

export interface CrossAssignmentList {
  items: CrossAssignmentEntry[];
}

export interface HolidayPlanEmployeeEntry extends EnrichedEmployeeFields {
  _id: string;
  plan_id: string;
  user_id: string;
  created_on?: string;
  created_by?: string;
}

export interface WorkCalendarMember extends EnrichedEmployeeFields {
  _id: string;
  work_calendar_id: string;
  user_id: string;
  created_on?: string;
  created_by?: string;
}

// ─── Work Calendar ─────────────────────────────────────────────

export interface WorkCalendarListItem {
  _id: string;
  name: string;
  period: {
    start: string;
    end: string;
  };
  work_week: {
    start: string;
    end: string;
  };
  status: "ACTIVE" | "INACTIVE";
  employee_count: number;
}

export interface WeekConfig {
  week_start_day: string;
  work_week_start: string;
  work_week_end: string;
  allow_half_day?: boolean;
}

export interface StatutoryConfig {
  enabled: boolean;
  rule_type: string;
  statutory_days: string[];
}

export interface WorkCalendarCreate {
  name: string;
  year_type: "CALENDAR" | "FISCAL";
  start_date: string;
  end_date: string;
  is_active?: boolean;
  is_default?: boolean;
  business_unit_ids: string[];
  department_ids: string[];
  week_config: WeekConfig;
  weekend_matrix: Record<string, number[]>;
  statutory_config?: StatutoryConfig | null;
}

export interface WorkCalendarUpdate {
  name?: string | null;
  year_type?: "CALENDAR" | "FISCAL" | null;
  start_date?: string | null;
  end_date?: string | null;
  is_active?: boolean | null;
  is_default?: boolean | null;
  business_unit_ids?: string[] | null;
  department_ids?: string[] | null;
  week_config?: WeekConfig | null;
  weekend_matrix?: Record<string, number[]> | null;
  statutory_config?: StatutoryConfig | null;
}

export interface WorkCalendarResponse extends AuditFields {
  _id: string;
  name: string;
  year_type: "CALENDAR" | "FISCAL";
  start_date: string;
  end_date: string;
  is_active: boolean;
  is_default: boolean;
  business_units?: Array<{ id: string; name: string }>;
  departments?: Array<{ id: string; name: string }>;
  week_config: WeekConfig;
  weekend_matrix: Record<string, number[]>;
  statutory_config?: StatutoryConfig;
  employee_count?: number;
}

// ─── Shifts ────────────────────────────────────────────────────

export interface ShiftCreate {
  calendar_id: string;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes?: number;
}

export interface ShiftUpdate {
  name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  break_minutes?: number | null;
}

export interface ShiftResponse extends AuditFields {
  _id: string;
  calendar_id: string;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes?: number;
}

// ─── Shift Assignments ─────────────────────────────────────────

export interface ShiftAssignment extends EnrichedEmployeeFields {
  user_id: string;
  shift_id: string;
}

export interface ShiftAssignmentSyncPayload {
  assignments: ShiftAssignment[];
}

export interface ShiftAssignmentSyncResult {
  updated: number;
}

export interface ShiftAssignValidateRow {
  row_num: number;
  status: 'valid' | 'error' | 'duplicate' | 'change';
  user_id?: string;
  shift_id?: string;
  email?: string;
  emp_code?: string;
  name?: string;
  shift_name?: string;
  current_shift_name?: string;
  errors: string[];
}

export interface ShiftAssignValidateResult {
  total_rows: number;
  valid_count: number;
  change_count?: number;
  error_count: number;
  duplicate_count: number;
  file_errors: string[];
  rows: ShiftAssignValidateRow[];
}

// ─── Work Calendar Assignments ─────────────────────────────────

export interface AssignmentScope {
  calendar_id: string;
  scope: "BUSINESS_UNIT" | "DEPARTMENT";
  scope_ids: string[];
}

export interface EmployeeOverridePayload {
  calendar_id: string;
  employee_ids: string[];
  effective_from: string;
  effective_to?: string | null;
}

export interface AssignmentResponse {
  calendar_id: string;
  scope: string;
  count: number;
}

export interface WorkingDayResponse {
  user_id: string;
  date: string;
  is_working_day: boolean;
  is_holiday?: boolean;
  is_weekend?: boolean;
  calendar_id?: string | null;
  reason?: string | null;
}

export interface EmployeeWorkCalendarResponse {
  calendar_id: string;
  calendar_name: string;
  weekend_matrix: Record<string, number[]>;
  week_config: WeekConfig;
  start_date: string;
  end_date: string;
}

// ─── Leave Plans ───────────────────────────────────────────────

export interface LeavePlanCreate {
  org_id: string;
  name: string;
  calendar_start_month?: number;
  asset_ids?: string[];
  business_unit_ids?: string[];
  department_ids?: string[];
}

export interface LeavePlanUpdate {
  name?: string | null;
  calendar_start_month?: number | null;
  asset_ids?: string[];
  progress?: number | null;
  business_unit_ids?: string[];
  department_ids?: string[];
}

export interface LeavePlanResponse extends AuditFields {
  _id: string;
  org_id: string;
  name: string;
  calendar_start_month?: number;
  asset_ids?: string[];
  progress?: number;
  business_unit_ids: string[];
  department_ids: string[];
  business_units?: { id: string; name: string }[];
  departments?: { id: string; name: string }[];
  leave_type_ids?: string[];
  status?: "pending_configuration" | "active";
  is_active?: boolean;
}

// ─── Grant Policy ──────────────────────────────────────────────

export interface GrantPolicyAllocation {
  amount: number;
  unit: "DAYS" | "HOURS";
  frequency: "YEARLY";
}

export interface GrantPolicyFirstMonthRestriction {
  enabled: boolean;
  cutoff_day: number;
  rule?: string;
}

export interface GrantPolicyJoiningRule {
  enabled: boolean;
  first_month_restriction: GrantPolicyFirstMonthRestriction;
}

export interface GrantPolicyExtraLeave {
  status: "ALLOWED" | "NOT_ALLOWED";
  max_days: number;
}

export interface GrantPolicyCreate {
  org_id: string;
  allocation?: GrantPolicyAllocation;
  joining_rule: GrantPolicyJoiningRule;
  extra_leave: GrantPolicyExtraLeave;
}

export interface GrantPolicyResponse extends GrantPolicyCreate, AuditFields {
  _id: string;
  leave_plan_id: string;
  version?: number;
  is_active?: boolean;
}

// ─── Leave Plan ↔ Leave Type mapping ──────────────────────────

export interface LeavePlanLeaveTypeAdd {
  leave_type_id: string;
}

/**
 * Resolved allowlist of leave types for the signed-in employee's plan.
 * `typeIds === null` means "no trustworthy allowlist" — see `reason`.
 */
export interface MyPlanLeaveTypes {
  planId: string | null;
  typeIds: string[] | null;
  reason: 'ok' | 'no_plan' | 'no_types' | 'error';
}

/**
 * Row shape returned by `GET /leave-plans/{planId}/leave-types`. Note this is a
 * mapping row — the leave type itself is nested under `leave_type`, and it is a
 * REDUCED projection (no `is_comp_off`, `count_calendar_days`, etc). Use it for
 * "which types belong to this plan", never as the leave-type data source.
 */
export interface LeavePlanTypeMappingRow extends AuditFields {
  _id: string;
  leave_plan_id: string;
  org_id: string;
  leave_type: {
    _id: string;
    name: string;
    code: string;
    unit: string;
    is_active?: boolean;
    color?: string | null;
    description?: string | null;
    // Pass-through config blocks used by the plan wizard.
    accrual?: Record<string, unknown> | null;
    policies?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
}

// ─── Leave Plan Assignments ────────────────────────────────────

export interface LeavePlanAssignmentCreate {
  leave_plan_id: string;
  scope_type: 'ORG' | 'BU' | 'DEPARTMENT';
  business_unit_id?: string;
  department_ids?: string[];
  apply_to_whole_bu: boolean;
  priority: number;
}

export interface LeavePlanAssignmentResponse extends AuditFields {
  _id: string;
  leave_plan_id: string;
  scope_type: 'ORG' | 'BU' | 'DEPARTMENT';
  business_unit_id?: string;
  apply_to_whole_bu: boolean;
  priority: number;
}

export interface EmployeeLeavePlanResponse {
  _id: string;
  employee_id: string;
  leave_plan_id: string;
  assignment_id: string;
  resolved_at: string;
}

// ─── Leave Plan Overview ──────────────────────────────────────

export interface LeavePlanOverviewEmployeeCounts {
  total: number
  by_status: Record<string, number>
}

export interface LeavePlanOverviewDepartment {
  id: string
  name: string
  employee_counts: LeavePlanOverviewEmployeeCounts
  total_leaves_allocated?: number
  leaves_allocated_by_employee_type?: Record<string, number>
}

export interface LeavePlanOverviewBU {
  id: string
  name: string
  departments: LeavePlanOverviewDepartment[]
  employee_counts: LeavePlanOverviewEmployeeCounts
  total_leaves_allocated?: number
  leaves_allocated_by_employee_type?: Record<string, number>
}

export interface LeavePlanOverviewLeaveType {
  id: string
  name: string
  unit?: string
  is_statutory?: boolean
  annual_allocated?: number | null
}

export interface LeavePlanOverviewEmployee {
  emp_code: string
  name: string
  email: string
  date_of_joining: string | null
  business_unit_name: string
  department_name: string
  status_key: string
  total_days_allocated: number
  allocation_by_leave_type: Record<string, number>
}

export interface LeavePlanOverview {
  plan_id: string
  plan_name: string
  calendar_start_month: number
  grant_policy: {
    allocation_amount: number
    allocation_unit: string
  } | null
  distribution: {
    mode: string
    accrual_frequency: string | null
  } | null
  probation_config: {
    enabled: boolean
    credit_mode: string | null
    probation_duration_months: number | null
    band_rules: Array<{
      from_month: number
      to_month: number
      credit_amount: number
      unit: string
    }>
  } | null
  notice_period_config: {
    mode: string | null
  } | null
  leave_types: LeavePlanOverviewLeaveType[]
  business_units: LeavePlanOverviewBU[]
  employment_status_counts?: Array<{ key: string; label: string; count: number }>
  employees?: LeavePlanOverviewEmployee[]
  totals: {
    total_employees: number
    total_departments: number
    total_business_units: number
    total_leaves_allocated?: number
    leaves_allocated_by_employee_type?: Record<string, number>
  }
}

// ─── Entitlement Policies ──────────────────────────────────────

export interface ProbationPolicy {
  allow_during_probation: boolean;
  probation_credit_type?: "NONE" | "PRORATED" | "FULL";
}

export interface ExpiryPolicy {
  type: "NONE" | "DATE" | "DAYS_AFTER_CREDIT";
  expiry_date?: string | null;
  days_after_credit?: number | null;
  carry_forward_enabled: boolean;
  carry_forward_limit?: number | null;
}

export interface EntitlementPolicyCreate {
  leave_plan_id: string;
  leave_type_id: string;
  credit_strategy?: "UPFRONT" | "PERIODIC";
  accrual_frequency?: "MONTHLY" | "YEARLY" | "NONE";
  total_days: number;
  joining_policy?: "PRORATED" | "FULL";
  probation_policy?: ProbationPolicy;
  allow_future_request?: boolean;
  allow_negative_balance?: boolean;
  rounding_strategy?: "EXACT" | "NEAREST_HALF" | "NEAREST_DAY" | "FLOOR" | "CEIL";
  expiry_policy?: ExpiryPolicy;
  min_leave_per_request?: number;
  max_leave_per_request?: number | null;
  max_consecutive_days?: number | null;
  max_requests_per_period?: number | null;
  gap_between_requests_days?: number | null;
  allow_clubbing?: boolean;
  clubbable_leave_type_ids?: string[];
  monthly_limit?: number | null;
  max_continuous_days?: number | null;
  allow_during_notice?: boolean;
}

export interface EntitlementPolicyUpdate {
  credit_strategy?: "UPFRONT" | "PERIODIC" | null;
  accrual_frequency?: "MONTHLY" | "YEARLY" | "NONE" | null;
  total_days?: number | null;
  joining_policy?: "PRORATED" | "FULL" | null;
  probation_policy?: ProbationPolicy | null;
  allow_future_request?: boolean | null;
  allow_negative_balance?: boolean | null;
  rounding_strategy?: "EXACT" | "NEAREST_HALF" | "NEAREST_DAY" | "FLOOR" | "CEIL" | null;
  expiry_policy?: ExpiryPolicy | null;
  min_leave_per_request?: number | null;
  max_leave_per_request?: number | null;
  max_consecutive_days?: number | null;
  max_requests_per_period?: number | null;
  gap_between_requests_days?: number | null;
  allow_clubbing?: boolean | null;
  clubbable_leave_type_ids?: string[] | null;
  monthly_limit?: number | null;
  max_continuous_days?: number | null;
  allow_during_notice?: boolean | null;
}

export interface EntitlementPolicyResponse extends AuditFields {
  _id: string;
  leave_plan_id: string;
  leave_type_id: string;
  credit_strategy: string;
  accrual_frequency: string;
  total_days: number;
  joining_policy: string;
  probation_policy?: ProbationPolicy;
  allow_future_request: boolean;
  allow_negative_balance: boolean;
  rounding_strategy: string;
  expiry_policy?: ExpiryPolicy;
  min_leave_per_request: number;
  max_leave_per_request?: number | null;
  max_consecutive_days?: number | null;
  max_requests_per_period?: number | null;
  gap_between_requests_days?: number | null;
  allow_clubbing: boolean;
  clubbable_leave_type_ids?: string[];
  monthly_limit?: number | null;
  max_continuous_days?: number | null;
  allow_during_notice: boolean;
}

// ─── Plan Entitlement (leave-entitlements/{plan_id}) ───────────

export interface PlanEntitlementResponse extends AuditFields {
  _id: string;
  org_id: string;
  leave_plan_id: string;
  entitlement: {
    distribution?: {
      enabled: boolean;
      mode: string;
      accrual_frequency?: string | null;
      policy_cycle_start_day?: number | null;
      posting_cycles?: Array<{
        leave_type_id: string;
        value: number;
        unit: string;
        accrual_frequency?: "monthly" | "quarterly" | "half_yearly" | "yearly" | null;
        carry_forward?: boolean;
      }>;
      step_rules?: Array<{ from_day: number; to_day: number; allocation: number; unit: string }>;
    };
    mid_year_joining?: {
      enabled: boolean;
      mode?: string | null;
      slab_rules?: Array<{ from_date: string; to_date: string; allocation: number; unit: string }>;
    };
    probation?: {
      enabled: boolean;
      credit_mode?: string | null;
      credit_start?: string | null;
      probation_duration_months?: number | null;
      band_rules?: Array<{ from_month: number; to_month: number; credit_amount: number; unit: string }>;
    };
    future_request?: { allow_future_requests: boolean; allow_based_on_projected_balance: boolean };
    negative_balance?: {
      allow_negative_balance: boolean;
      max_negative_balance?: number | null;
      approval_required: boolean;
      approval_mode?: string | null;
    };
    fractional_balance?: { mode: string };
    credit_expiry?: {
      expiry_enabled: boolean;
      expiry_period_value?: number | null;
      expiry_period_unit?: string | null;
      expiry_at_cycle_end: boolean;
    };
    credit_timing?: {
      mode?: string | null;
      date_rules?: Array<{ from_day: number; to_day: number; credit_day: number; allocation_days: number }>;
    };
    upload_requirement?: { mandatory: boolean; required_after_days?: number | null };
    comment_requirement?: { mode: string };
    request_limits?: {
      max_requests_allowed?: number | null;
      period?: string | null;
      enforce_gap: boolean;
      gap_days?: number | null;
    };
    clubbing?: { enabled: boolean; restricted_leave_type_ids?: string[] };
    continuous_limit?: {
      enabled: boolean;
      max_consecutive_days?: number | null;
      include_weekends: boolean;
      include_holidays: boolean;
    };
    monthly_limit?: { enabled: boolean; max_days_per_month?: number | null };
    notice_period_leave?: { mode?: string | null; extend_notice_by_leave_days: boolean };
    request_validation?: {
      upload_requirement: { mandatory: boolean; required_after_days?: number | null };
      comment_requirement: { mode: string };
      request_limits: {
        max_requests_allowed?: number | null;
        period?: string | null;
        enforce_gap: boolean;
        gap_days?: number | null;
      };
    };
  };
  is_active: boolean;
}

export interface PlanEntitlementCreate {
  leave_plan_id: string;
  entitlement: PlanEntitlementResponse['entitlement'];
}

// ─── Entitlements & Ledger ─────────────────────────────────────

export interface LeaveEntitlementCreate {
  employee_id: string;
  leave_type_id: string;
  policy_id: string;
  period_start: string;
  period_end: string;
  credited_days: number;
}

export interface LeaveEntitlementResponse extends AuditFields {
  _id: string;
  employee_id: string;
  leave_type_id: string;
  policy_id: string;
  period_start: string;
  period_end: string;
  credited_days: number;
  balance: number;
}

export interface LedgerEntryCreate {
  employee_id: string;
  leave_type_id: string;
  entry_type: "CREDIT" | "DEBIT";
  days: number;
  reason?: string;
  reference_id?: string;
}

export interface LedgerEntryResponse extends AuditFields {
  _id: string;
  employee_id: string;
  leave_type_id: string;
  entry_type: string;
  days: number;
  reason?: string;
  reference_id?: string;
}

export interface LeaveBalanceResponse {
  employee_id: string;
  leave_type_id: string;
  total_credited: number;
  total_debited: number;
  balance: number;
}

// ─── Leave Requests ────────────────────────────────────────────

export type DurationMode = 'FULL_DAYS' | 'HALF_DAY' | 'CUSTOM';
export type SessionHalf = 'FIRST_HALF' | 'SECOND_HALF';

export interface LeaveRequestCreate {
  leave_type_id: string;
  start_date: string;
  end_date: string;
  duration_mode: DurationMode;
  half_day_period?: SessionHalf | null;
  start_session?: SessionHalf | null;
  end_session?: SessionHalf | null;
  reason: string;
  asset_ids?: string[];
  notify_cc?: string[];
  /** Expiring / comp-off leave only: the worked (compensated) days (YYYY-MM-DD). */
  worked_dates?: string[];
}

export interface ApprovalState {
  current_level: number;
}

export interface LeaveRequestAsset {
  id: string;
  original_filename: string;
  content_type: string;
  size: number;
  url: string;
}

export interface LeaveRequestResponse extends AuditFields {
  _id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  start_datetime?: string;
  end_datetime?: string;
  duration_mode: DurationMode;
  half_day_period?: SessionHalf | null;
  start_session?: SessionHalf | null;
  end_session?: SessionHalf | null;
  duration_hours?: number;
  duration_days?: number;
  /** True when the request is unpaid (Loss of Pay) — weekends are charged. */
  loss_of_pay?: boolean;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  approval_state?: ApprovalState;
  asset_ids?: string[];
  assets?: LeaveRequestAsset[];
  notify_cc?: string[];
  /** Expiring / comp-off leave only: the worked (compensated) days pointed to. */
  worked_dates?: string[];
  employee_name?: string | null;
  employee_email?: string | null;
  employee_first_name?: string | null;
  employee_last_name?: string | null;
  /** Resolved leave type name (manager listing surfaces). */
  leave_type_name?: string | null;
  /** Days the request has been awaiting action (approver/HR listing surfaces). */
  days_pending?: number | null;
  /** True when days_pending meets/exceeds the plan's skip_if_no_action_days (breached). */
  is_overdue?: boolean;
  /** Three-state aging: "due_soon" warns 1 day before breach, "overdue" at/after breach. */
  aging_status?: "on_track" | "due_soon" | "overdue" | null;
}

export interface LeaveRequestCounts {
  all: number;
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
}

export interface PaginatedLeaveRequests {
  items: LeaveRequestResponse[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  counts: LeaveRequestCounts;
}

export interface MyLeaveRequestsParams {
  status?: string;
  from_date?: string;
  to_date?: string;
  search?: string;
  page?: number;
  page_size?: number;
  sort?: string;
}

export interface ManagerInfo {
  id: string;
  name: string;
  email: string;
}

export interface ApprovalTimelineEntry {
  action: string;
  level: number | null;
  actor_id: string;
  actor_name: string;
  comment: string | null;
  timestamp: string;
}

export interface LeaveRequestBalanceProjection {
  leave_type_id: string;
  leave_type_name: string;
  available_today_days: number;
  available_today_hours: number;
  projected_by_leave_date_days: number;
  projected_by_leave_date_hours: number;
  after_approval_days: number;
  after_approval_hours: number;
}

export interface LeaveRequestDetailResponse extends LeaveRequestResponse {
  l1_manager: ManagerInfo | null;
  l2_manager: ManagerInfo | null;
  approval_timeline: ApprovalTimelineEntry[];
  balance_projection: LeaveRequestBalanceProjection | null;
}

export interface ManagerLeaveDetailEmployee {
  id: string;
  name: string;
  email: string;
  department_id: string;
  department_name: string;
}

export interface ManagerLeaveDetailTimelineEntry {
  action: string;
  level?: number;
  actor_name: string;
  timestamp: string;
}

export interface NoticePeriodInfo {
  in_notice_period: boolean;
  policy: 'block' | 'allow_with_extension';
  will_extend_notice: boolean;
  current_lwd?: string | null;
}

export interface ManagerLeaveRequestDetail {
  worked_dates?: string[];
  _id: string;
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  start_date: string;
  end_date: string;
  duration_days?: number;
  duration_mode?: string;
  leave_type_id?: string;
  leave_type_name?: string;
  reason?: string;
  created_on?: string;
  employee: ManagerLeaveDetailEmployee;
  l1_manager: ManagerInfo | null;
  l2_manager: ManagerInfo | null;
  approval_timeline: ManagerLeaveDetailTimelineEntry[];
  balance_projection: LeaveRequestBalanceProjection | null;
  notice_period_info?: NoticePeriodInfo | null;
}

export interface BalanceProjectionItem {
  leave_type_id: string;
  leave_type_name: string;
  current_balance_hours: number;
  current_balance_days: number;
  pending_hours: number;
  pending_days: number;
  approved_future_hours: number;
  approved_future_days: number;
  max_balance_hours: number;
  max_balance_days: number;
}

export interface BalanceProjectionResponse {
  projections: BalanceProjectionItem[];
}

export interface LeaveHistoryParams {
  year?: number;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface LeaveHistoryResponse {
  total: number;
  offset: number;
  limit: number;
  items: LeaveRequestResponse[];
}

// ─── Team Availability ─────────────────────────────────────────

export interface TeamAvailabilityOnLeaveEntry {
  user_id: string;
  employee_name: string;
  leave_type_name: string;
  request_id: string;
  duration_mode: string;
  status: 'APPROVED' | 'PENDING';
}

export interface TeamAvailabilityDay {
  date: string;
  available_count: number;
  on_leave_count: number;
  on_leave: TeamAvailabilityOnLeaveEntry[];
}

export interface TeamMemberLeave {
  request_id: string;
  leave_type_id: string;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  duration_mode: string;
  duration_days: number;
  status: 'APPROVED' | 'PENDING';
}

export interface TeamMember {
  user_id: string;
  name: string;
  leaves_in_range: TeamMemberLeave[];
}

export interface TeamAvailabilityResponse {
  start_date: string;
  end_date: string;
  total_team_size: number;
  daily_availability: TeamAvailabilityDay[];
  team_members: TeamMember[];
}

export interface TeamAvailabilityParams {
  start_date: string;
  end_date: string;
}

export interface AgentChatRequest {
  message: string;
  thread_id: string;
}

export interface AgentChatResponse {
  message: string;
  thread_id: string;
}

export interface LeaveRequestBalanceResponse {
  employee_id: string;
  leave_type_id: string;
  available_days: number;
  available_hours: number;
}

export interface LeaveBalanceEstimateParams {
  leave_type_id: string;
  start_date: string;
  end_date: string;
  duration_mode?: DurationMode;
  half_day_period?: SessionHalf;
  start_session?: SessionHalf;
  end_session?: SessionHalf;
}

export interface LeaveBalanceEstimateResponse {
  /** True when the leave is unpaid (Loss of Pay) — weekends are charged. */
  is_lop?: boolean;
  /** True when weekends were included in the estimated duration (LOP). */
  includes_weekends?: boolean;
  estimated_hours: number;
  estimated_days: number;
  available_today_hours: number;
  available_today_days: number;
  projected_by_leave_date_hours: number;
  projected_by_leave_date_days: number;
  after_approval_hours: number;
  after_approval_days: number;
  entitlement_constraints?: LeaveEntitlementConstraints | null;
}

export interface LeaveRequestEstimateParams {
  leave_type_id: string;
  start_date: string;
  end_date: string;
  duration_mode: DurationMode;
  half_day_period?: SessionHalf;
  start_session?: SessionHalf;
  end_session?: SessionHalf;
}

export interface LeaveRequestEstimateResponse {
  estimated_days: number;
  estimated_hours: number;
  is_lop?: boolean;
  includes_weekends?: boolean;
}

/**
 * How much of an unrestricted leave type the employee has already taken this
 * leave year. `days_used` INCLUDES `pending_days` — the split is exposed so the
 * UI can say "8 days used (2 awaiting approval)" rather than implying all 8 are
 * settled.
 */
export interface LeaveTypeUsage {
  days_used: number;
  pending_days: number;
  period_start?: string | null;
  period_label?: string | null;
}

export interface AssetUploadResponse {
  _id: string;
  id?: string;
  original_filename: string;
  content_type: string;
  size: number;
  storage_key: string;
  created_on: string;
  created_by: string | null;
}

export interface AssetUrlResponse {
  url: string;
  expires_in: number;
}

// ─── Approval Flows ────────────────────────────────────────────

export interface ApprovalLevelConfig {
  level: number;
  type: "ROLE" | "USER";
  value: string;
}

export interface ApprovalFlowCreate {
  leave_plan_id: string;
  levels: ApprovalLevelConfig[];
  skip_if_no_action_days?: number | null;
}

export interface ApprovalFlowResponse extends AuditFields {
  _id: string;
  leave_plan_id: string;
  levels: ApprovalLevelConfig[];
  skip_if_no_action_days?: number | null;
}

export interface ApprovalActionPayload {
  comment?: string | null;
}

export interface ApprovalOverrideLevelConfig {
  level: number;
  approver_id: string;
}

export interface ApprovalOverrideCreate {
  leave_request_id: string;
  levels: ApprovalOverrideLevelConfig[];
}

// ─── Year-End Processing ──────────────────────────────────────────────────────

export type ProcessingType =
  | 'EXPIRE_RESET'
  | 'PAYOUT_ALL'
  | 'CARRY_FORWARD_ALL'
  | 'CARRY_FORWARD_EXPIRE'
  | 'PAYOUT_THEN_CARRY'
  | 'CARRY_THEN_PAYOUT'

export type NegativeBalanceRule =
  | 'DEDUCT_FROM_PAYROLL'
  | 'RESET_TO_ZERO'
  | 'CARRY_FORWARD_DEFICIT'

export type CalculationMode = 'FIXED_DAYS' | 'PERCENTAGE'

export type RoundingType = 'NEAREST' | 'UP' | 'DOWN'

export type RoundingUnit = 'HALF_DAY' | 'FULL_DAY'

export interface SlabRule {
  min_balance: number
  payout_value: number
  carry_forward_value: number
}

export interface PercentageConfig {
  payout_percentage: number
  carry_percentage: number
}

export interface RoundingConfig {
  enabled: boolean
  rounding_type?: RoundingType | null
  rounding_unit?: RoundingUnit | null
}

export interface PayoutCarryConfig {
  calculation_mode: CalculationMode | null
  minimum_eligible_balance?: number | null
  slab_rules?: SlabRule[]
  percentage_config?: PercentageConfig | null
  max_payout_limit?: number | null
  max_carry_limit?: number | null
  rounding?: RoundingConfig | null
}

export interface YearEndProcessingCreate {
  processing_type: ProcessingType
  payout_carry_config?: PayoutCarryConfig | null
  negative_balance_rule?: NegativeBalanceRule
}

export interface YearEndProcessingUpdate {
  processing_type?: ProcessingType | null
  payout_carry_config?: PayoutCarryConfig | null
  negative_balance_rule?: NegativeBalanceRule | null
}

export interface YearEndProcessingResponse extends AuditFields {
  _id: string
  leave_plan_id: string
  processing_type: ProcessingType
  payout_carry_config?: PayoutCarryConfig | null
  negative_balance_rule: NegativeBalanceRule
}

// ─── Sandwich Policy ──────────────────────────────────────────────────────────

export type SandwichRuleType =
  | 'between_two_leave_days'
  | 'before_a_leave_day'
  | 'after_a_leave_day'
  | 'before_or_after_leave_day'
  | 'between_two_holidays'

export type DurationUnit = 'days' | 'hours'

export interface SandwichPolicyUpsert {
  enabled?: boolean
  apply_rule_when: SandwichRuleType
  minimum_consecutive_value: number
  minimum_consecutive_unit: DurationUnit
  ignore_half_day_leaves?: boolean
}

export interface SandwichPolicyResponse extends AuditFields {
  _id: string
  leave_plan_id: string
  enabled: boolean
  apply_rule_when: SandwichRuleType
  minimum_consecutive_value: number
  minimum_consecutive_unit: DurationUnit
  ignore_half_day_leaves: boolean
}

// ─── Approval Policy ──────────────────────────────────────────────────────────

export interface ApprovalLevelRequest {
  level: number
}

export interface ApprovalLevelResponse {
  selection_type: string;
  level: number
}

export interface ApprovalPolicyUpsert {
  approval_required?: boolean
  levels_operator?: 'AND' | 'OR' | null
  approval_levels?: ApprovalLevelRequest[]
  allow_hr_to_act?: boolean
  allow_hr_to_view?: boolean
}

export interface ApprovalPolicyResponse extends AuditFields {
  _id: string
  leave_plan_id: string
  approval_required: boolean
  levels_operator?: 'AND' | 'OR' | null
  approval_levels: ApprovalLevelResponse[]
  allow_hr_to_act?: boolean
  allow_hr_to_view?: boolean
}

// ─── Team Calendar ─────────────────────────────────────────────

export interface TeamCalendarEvent {
  request_id: string;
  leave_type_id: string;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  duration_mode: string;
  half_day_period: string | null;
  status: 'APPROVED' | 'PENDING';
  reason: string;
}

export interface TeamCalendarMember {
  user_id: string;
  employee_name: string;
  events: TeamCalendarEvent[];
}

export interface TeamCalendarHoliday {
  name: string;
  date: string;
  /** Classification name, e.g. "National Holiday". */
  type: string;
  /** Classification swatch, e.g. "#DC2626". */
  color?: string;
}

export interface TeamCalendarParams {
  from_date: string;
  to_date: string;
  status?: string | string[];
}

export interface TeamCalendarResponse {
  from_date: string;
  to_date: string;
  team_members: TeamCalendarMember[];
  holidays: TeamCalendarHoliday[];
}

// ─── Leave Balances ────────────────────────────────────────────

export interface LeaveEntitlementConstraints {
  allow_past_dates?: boolean;
  max_backdated_days?: number | null;
  backdated_leave?: {
    enabled: boolean;
    max_days?: number | null;
  };
}

export interface LeaveBalanceItem {
  leave_type_id: string;
  leave_type_name: string;
  leave_type_code: string;
  /** Backend-owned display position — the list already arrives in this order. */
  rank?: number | null;
  unit: 'DAYS' | 'HOURS';
  /** Credited minus approved debits (before holds). */
  balance_hours?: number;
  balance_days?: number;
  /** Reserved by pending requests awaiting approval. */
  on_hold_hours?: number;
  on_hold_days?: number;
  /** Spendable now = balance - on_hold (what the apply form validates against). */
  available_hours: number;
  available_days: number;
  deduct_from_balance: boolean;
}

export interface LeaveBalancesResponse {
  user_id: string;
  balances: LeaveBalanceItem[];
}

// ─── Team Leave Summary ────────────────────────────────────────

export interface TeamLeaveSummaryParams {
  status?: string;
  from_date?: string;
  to_date?: string;
}

export interface TeamLeaveSummaryByType {
  leave_type_id: string;
  leave_type_name: string;
  employee_count: number;
  total_requests: number;
  total_days: number;
  total_hours: number;
}

export interface TeamLeaveSummaryByEmployeeLeave {
  leave_type_id: string;
  leave_type_name: string;
  days: number;
  status: string;
}

export interface TeamLeaveSummaryByEmployee {
  employee_id: string;
  employee_name: string;
  leaves: TeamLeaveSummaryByEmployeeLeave[];
}

export interface TeamLeaveSummaryResponse {
  total_employees: number;
  employees_with_leaves: number;
  summary_by_type: TeamLeaveSummaryByType[];
  by_employee: TeamLeaveSummaryByEmployee[];
}

// ─── Toggle Config ────────────────────────────────────────────

export interface ToggleConfigUpsert {
  grant_joining_rule: boolean
  grant_first_month_restriction: boolean
  grant_extra_leave: boolean
  distribution: boolean
  mid_year_joining: boolean
  probation: boolean
  backdated_leave: boolean
  clubbing: boolean
  continuous_limit: boolean
  monthly_limit: boolean
  credit_expiry: boolean
  negative_balance: boolean
  upload_requirement: boolean
  request_limits_gap: boolean
  future_requests: boolean
  future_projected_balance: boolean
  sandwich: boolean
  approval_required: boolean
  year_end_rounding: boolean
}

export interface ToggleConfigResponse extends ToggleConfigUpsert, AuditFields {
  _id: string
  leave_plan_id: string
}

// ─── Leave Request Field Config ──────────────────────────────

export interface LeaveRequestFieldConfig {
  reason_mandatory: boolean
  document_mandatory: boolean
  document_required_after_days: number | null
  max_consecutive_days: number | null
  approval_required: boolean
  approval_levels: ApprovalLevelResponse[]
  levels_operator: 'AND' | 'OR' | null
}

// ─── Error Types ───────────────────────────────────────────────

export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export interface HTTPValidationError {
  detail: ValidationError[];
}
