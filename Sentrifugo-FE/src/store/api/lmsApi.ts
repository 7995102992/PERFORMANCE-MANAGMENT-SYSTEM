import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'
import type {
  LeaveTypeCreate,
  LeaveTypeUpdate,
  LeaveTypeResponse,
  LeavePlanCreate,
  LeavePlanUpdate,
  LeavePlanResponse,
  LeavePlanLeaveTypeAdd,
  LeavePlanTypeMappingRow,
  MyPlanLeaveTypes,
  GrantPolicyCreate,
  GrantPolicyResponse,
  LeavePlanAssignmentCreate,
  LeavePlanAssignmentResponse,
  EmployeeLeavePlanResponse,
  LeavePlanOverview,
  ClassificationCreate,
  ClassificationUpdate,
  ClassificationResponse,
  HolidayPlanListItem,
  HolidayPlanCreate,
  HolidayPlanUpdate,
  HolidayPlanResponse,
  HolidayCreate,
  HolidayUpdate,
  BulkHolidayImport,
  BulkHolidayImportResponse,
  HolidayBulkValidateResult,
  HolidayResponse,
  HolidayListResponse,
  HolidayPlanEmployeeSync,
  HolidayPlanEmployeeEntry,
  WorkCalendarCreate,
  WorkCalendarUpdate,
  WorkCalendarResponse,
  WorkCalendarListItem,
  EmployeeWorkCalendarResponse,
  ShiftCreate,
  ShiftUpdate,
  ShiftResponse,
  ShiftAssignment,
  WorkCalendarMember,
  ScopedEmployeeList,
  ScopedEmployeeParams,
  CrossAssignmentList,
  ShiftAssignmentSyncPayload,
  ShiftAssignmentSyncResult,
  ShiftAssignValidateResult,
  LeaveRequestCreate,
  LeaveRequestResponse,
  LeaveRequestDetailResponse,
  PaginatedLeaveRequests,
  MyLeaveRequestsParams,
  LeaveRequestBalanceResponse,
  BalanceProjectionResponse,
  LeaveHistoryParams,
  LeaveHistoryResponse,
  TeamAvailabilityParams,
  TeamAvailabilityResponse,
  LeaveBalancesResponse,
  TeamLeaveSummaryParams,
  TeamLeaveSummaryResponse,
  TeamCalendarParams,
  TeamCalendarResponse,
  ManagerLeaveRequestDetail,
  AgentChatRequest,
  AgentChatResponse,
  LeaveBalanceEstimateParams,
  LeaveBalanceEstimateResponse,
  LeaveRequestEstimateParams,
  LeaveRequestEstimateResponse,
  LeaveTypeUsage,
  AssetUploadResponse,
  ApprovalActionPayload,
  ApprovalFlowCreate,
  ApprovalFlowResponse,
  ApprovalOverrideCreate,
  EntitlementPolicyCreate,
  EntitlementPolicyUpdate,
  EntitlementPolicyResponse,
  PlanEntitlementResponse,
  PlanEntitlementCreate,
  LeaveEntitlementCreate,
  LeaveEntitlementResponse,
  LedgerEntryCreate,
  LedgerEntryResponse,
  LeaveBalanceResponse,
  SandwichPolicyUpsert,
  SandwichPolicyResponse,
  ApprovalPolicyUpsert,
  ApprovalPolicyResponse,
  YearEndProcessingCreate,
  YearEndProcessingUpdate,
  YearEndProcessingResponse,
  ToggleConfigUpsert,
  ToggleConfigResponse,
  LeaveRequestFieldConfig,
} from '@/types/leave'

// ─── Bulk Upload Types ──────────────────────────────────────────
export interface BulkValidateRow {
  row_num: number
  email: string
  emp_code: string
  status: 'valid' | 'error' | 'duplicate' | 'change'
  user_id: string | null
  name: string | null
  department: string | null
  errors: string[]
}

export interface BulkValidateResult {
  total_rows: number
  valid_count: number
  error_count: number
  duplicate_count: number
  rows: BulkValidateRow[]
  file_errors: string[]
}

// ─── My Calendar Types ─────────────────────────────────────────
export interface MyCalendarLeave {
  id: string
  leave_type_id: string
  leave_type_name: string | null
  start_date: string
  end_date: string
  duration_mode: string | null
  half_day_period: string | null
  start_session: string | null
  end_session: string | null
  duration_hours: number
  duration_days: number
  status: string
  reason: string | null
}

export interface MyCalendarHoliday {
  id: string
  name: string
  date: string
  description: string | null
  classification_name: string | null
  classification_color: string | null
}

export interface MyCalendarResponse {
  leaves: MyCalendarLeave[]
  holidays: MyCalendarHoliday[]
}

/** The holiday plan the signed-in employee is assigned to, plus its holidays for
 *  one year. `plan_id` is null when the employee is on no plan. */
export interface MyHolidaysResponse {
  plan_id: string | null
  plan_name: string | null
  year: number
  holidays: MyCalendarHoliday[]
}

// ─── Employee Dashboard Types ───────────────────────────────────
export interface DashboardLeaveBalance {
  leave_type_id: string
  leave_type_name: string
  leave_type_code: string | null
  unit: string
  available_days: number
  available_hours: number
  entitled_days: number | null
}

export interface DashboardNextLeave {
  id: string
  leave_type_name: string | null
  start_date: string
  end_date: string
  duration_days: number
  status: string
}

export interface DashboardNextHoliday {
  id: string
  name: string | null
  date: string
  days_until: number
  classification_name: string | null
  classification_color: string | null
}

export interface DashboardLapsingLeave {
  leave_type_id: string
  leave_type_name: string
  unit: string
  units: number
  expires_on: string
}

export interface DashboardTeammateOut {
  user_id: string
  name: string | null
  leave_type_name: string | null
  start_date: string
  end_date: string
  duration_mode: string | null
  half_day_period: string | null
}

export interface DashboardWhosOut {
  team_size: number
  out_count: number
  items: DashboardTeammateOut[]
}

export interface EmployeeDashboardResponse {
  leave_balances: DashboardLeaveBalance[]
  next_leave: DashboardNextLeave | null
  upcoming_leaves: DashboardNextLeave[]
  next_holiday: DashboardNextHoliday | null
  lapsing_leaves: DashboardLapsingLeave[]
  whos_out_today: DashboardWhosOut
}

// ─── Org (admin) dashboard ──────────────────────────────────────
export interface OrgOnLeaveItem {
  user_id: string
  name: string | null
  department_id: string | null
  department_name: string | null
  leave_type_name: string | null
  duration_mode: string | null
}

export interface OrgOnLeaveByDept {
  department_id: string | null
  department_name: string | null
  count: number
}

export interface OrgOnLeaveResponse {
  total_out: number
  total_employees: number
  items: OrgOnLeaveItem[]
  by_department: OrgOnLeaveByDept[]
}

const LMS_BASE_URL = import.meta.env.VITE_LMS_BASE_URL as string

export interface LeaveAnalyticsBalanceBar {
  leave_type_id: string
  leave_type_name: string
  leave_type_code: string
  entitled_days: number
  used_days: number
  available_days: number
  usage_pct: number
}

// `/leave-analytics/employee-dashboard`. Distinct from EmployeeDashboardResponse
// (`/dashboard/employee`) above — both used to be declared under the same name,
// which merged the interfaces and let the later endpoint silently win.
export interface LeaveAnalyticsEmployeeDashboardResponse {
  kpis: {
    total_balance_days: number
    days_used_ytd: number
    total_entitled_days: number
    utilization_pct: number
    pending_count: number
    pending_days: number
    days_expiring: number
    carry_forward_limit: number | null
  }
  balance_bars: LeaveAnalyticsBalanceBar[]
  monthly_chart: Array<{ month: string; days: number }>
  type_distribution: Array<{ leave_type_id: string; name: string; days: number }>
  recent_requests: Array<{
    id: string
    leave_type_name: string
    start_date: string | null
    end_date: string | null
    duration_days: number
    status: string
    approval_latency_hours: number | null
  }>
}

export interface ManagerDashboardResponse {
  kpis: {
    headcount: number
    on_leave_today: number
    pending_count: number
    oldest_pending_age_hours: number | null
    avg_team_utilization_pct: number
    avg_approval_time_hours: number | null
    org_avg_approval_time_hours: number | null
  }
  pending_approvals: Array<{
    id: string
    employee_name: string
    leave_type_name: string
    start_date: string | null
    end_date: string | null
    duration_days: number
    reason: string
    waiting_hours: number | null
  }>
  team_utilization: Array<{
    user_id: string
    employee_name: string
    /** False for reportees whose employment status is exited/terminated. */
    is_active: boolean
    entitled_days: number
    used_days: number
    balance_days: number
    utilization_pct: number
    burnout_risk: string
    burnout_score: number
    last_leave: string | null
    days_since_last_leave: number
  }>
  monthly_chart: Array<{ month: string; days: number }>
  type_distribution: Array<{ leave_type_id: string; name: string; days: number }>
  /**
   * Resolved reporting window. Used days, the trend chart and the type
   * breakdown are scoped to it; Entitled / Balance / Utilization are lifetime
   * balance-tracker totals and ignore it.
   */
  window?: { from_date: string; to_date: string }
}

export interface CFODashboardResponse {
  kpis: {
    total_employees: number
    total_balance_days: number
    total_liability_amount: number
    ytd_accrued_days: number
    ytd_consumed_days: number
    utilization_pct: number
    expiring_days: number
    projected_payout_amount: number
    lop_days: number
    lop_count: number
    lop_amount: number
  }
  accrual_chart: Array<{ month: string; accrued: number; consumed: number }>
  liability_by_plan: Array<{ name: string; value: number }>
  year_end_history: Array<{
    plan_name: string
    employees: number
    opening_balance: number
    payout_amount: number
    carry_forward_amount: number
    expired_amount: number
  }>
  top_liability: Array<{
    employee_name: string
    department: string
    balance_days: number
    daily_rate: number | null
    liability_amount: number | null
    above_carry_limit: number
    risk: string
  }>
}

export interface MDDashboardResponse {
  kpis: {
    total_employees: number
    org_utilization_pct: number
    culture_score: number
    org_bri: number
    high_bri_count: number
    high_bri_pct: number
    compliance_pct: number
    non_compliant_count: number
    approval_sla_pct: number
    sick_leave_rate_pct: number
    avg_bradford_factor: number
    flight_risk_count: number
  }
  bu_health: Array<{
    bu_id: string
    bu_name: string
    employee_count: number
    utilization_pct: number
    detail: string
  }>
  bu_utilization_chart: Array<{ name: string; pct: number }>
  sick_rate_chart: Array<{ month: string; rate: number }>
  approval_dist: Array<{ name: string; value: number }>
  monthly_chart: Array<{ month: string; days: number }>
  culture_trend: Array<{
    quarter_label: string
    culture_score: number
    components: {
      org_utilization_pct: number
      avg_bradford_factor: number
      compliance_pct: number
      sick_leave_rate_pct: number
    }
  }>
}

export interface HRDashboardResponse {
  kpis: {
    total_employees: number
    org_utilization_pct: number
    high_burnout_count: number
    compliance_pct: number
    non_compliant_count: number
    avg_approval_latency_hours: number | null
  }
  dept_heatmap: Array<{
    department_id: string
    department_name: string
    employee_count: number
    utilization_pct: number
  }>
  dept_utilization_chart: Array<{ name: string; pct: number }>
  bradford_factor: {
    normal: number
    monitor: number
    review: number
    critical: number
  }
  manager_leaderboard: Array<{
    manager_name: string
    team_size: number
    avg_latency_hours: number | null
    rejection_rate_pct: number
    overdue_count: number
    performance: string
  }>
}

export const lmsApi = createApi({
  reducerPath: 'lmsApi',
  baseQuery: createBaseQuery(LMS_BASE_URL),
  tagTypes: [
    'LeaveType',
    'LeavePlan',
    'LeavePlanLeaveType',
    'GrantPolicy',
    'LeavePlanAssignment',
    'HolidayPlan',
    'HolidayClassification',
    'Holiday',
    'HolidayPlanEmployee',
    'WorkCalendar',
    'Shift',
    'ShiftAssignment',
    'LeaveRequest',
    'ApprovalFlow',
    'EntitlementPolicy',
    'Entitlement',
    'Ledger',
    'Balance',
    'SandwichPolicy',
    'ApprovalPolicy',
    'YearEndConfig',
    'Asset',
    'ManagerLeaveRequest',
    'BalanceProjection',
    'LeaveHistory',
    'LeaveBalances',
    'TeamLeaveSummary',
    'TeamCalendar',
    'MyCalendar',
    'ToggleConfig',
    'EmployeeDashboard',
  ],
  endpoints: (builder) => ({
    // ─── Leave Types ─────────────────────────────────────────────

    getLeaveTypes: builder.query<LeaveTypeResponse[], string>({
      query: (orgId) => ({ url: '/leave-types', params: { org_id: orgId } }),
      providesTags: ['LeaveType'],
    }),

    /**
     * Leave types the CALLER is eligible for — the BE drops the ones restricted
     * away from their gender / marital status (Maternity for a man, etc).
     * For employee-facing pickers; admin screens use `getLeaveTypes` so they
     * keep seeing every type. Both arrive in rank order.
     */
    getEligibleLeaveTypes: builder.query<LeaveTypeResponse[], string>({
      query: (orgId) => ({
        url: '/leave-types',
        params: { org_id: orgId, eligible_only: true },
      }),
      providesTags: ['LeaveType'],
    }),

    getLeaveType: builder.query<LeaveTypeResponse, string>({
      query: (id) => `/leave-types/${id}`,
      providesTags: ['LeaveType'],
    }),

    createLeaveType: builder.mutation<LeaveTypeResponse, LeaveTypeCreate>({
      query: (body) => ({ url: '/leave-types', method: 'POST', body }),
      invalidatesTags: ['LeaveType'],
    }),

    updateLeaveType: builder.mutation<LeaveTypeResponse, { id: string; body: LeaveTypeUpdate }>({
      query: ({ id, body }) => ({ url: `/leave-types/${id}`, method: 'PUT', body }),
      invalidatesTags: ['LeaveType'],
    }),

    deleteLeaveType: builder.mutation<void, string>({
      query: (id) => ({ url: `/leave-types/${id}`, method: 'DELETE' }),
      invalidatesTags: ['LeaveType'],
    }),

    // ─── Leave Plans ─────────────────────────────────────────────

    getLeavePlans: builder.query<LeavePlanResponse[], string>({
      query: (orgId) => ({ url: '/leave-plans', params: { org_id: orgId } }),
      providesTags: ['LeavePlan'],
    }),

    getLeavePlan: builder.query<LeavePlanResponse, string>({
      query: (id) => `/leave-plans/${id}`,
      providesTags: ['LeavePlan'],
    }),

    createLeavePlan: builder.mutation<LeavePlanResponse, LeavePlanCreate>({
      query: (body) => ({ url: '/leave-plans', method: 'POST', body }),
      invalidatesTags: ['LeavePlan'],
    }),

    updateLeavePlan: builder.mutation<LeavePlanResponse, { id: string; body: LeavePlanUpdate }>({
      query: ({ id, body }) => ({ url: `/leave-plans/${id}`, method: 'PUT', body }),
      invalidatesTags: ['LeavePlan'],
    }),

    deleteLeavePlan: builder.mutation<void, string>({
      query: (id) => ({ url: `/leave-plans/${id}`, method: 'DELETE' }),
      invalidatesTags: ['LeavePlan'],
    }),

    activateLeavePlan: builder.mutation<LeavePlanResponse, string>({
      query: (id) => ({ url: `/leave-plans/${id}/activate`, method: 'POST' }),
      invalidatesTags: ['LeavePlan'],
    }),

    deactivateLeavePlan: builder.mutation<LeavePlanResponse, string>({
      query: (id) => ({ url: `/leave-plans/${id}/deactivate`, method: 'POST' }),
      invalidatesTags: ['LeavePlan'],
    }),

    // ─── Policy Documents ─────────────────────────────────────────

    uploadPolicyDocument: builder.mutation<{ id: string; leave_plan_id: string; original_filename: string; content_type: string; size: number }, { planId: string; file: File }>({
      query: ({ planId, file }) => {
        const formData = new FormData()
        formData.append('file', file)
        return { url: `/leave-plans/${planId}/policy-document`, method: 'POST', body: formData }
      },
      invalidatesTags: ['LeavePlan'],
    }),

    getPolicyDocumentMeta: builder.query<{ id: string; leave_plan_id: string; original_filename: string; content_type: string; size: number } | null, string>({
      query: (planId) => `/leave-plans/${planId}/policy-document`,
      providesTags: ['LeavePlan'],
    }),

    deletePolicyDocument: builder.mutation<void, string>({
      query: (planId) => ({ url: `/leave-plans/${planId}/policy-document`, method: 'DELETE' }),
      invalidatesTags: ['LeavePlan'],
    }),

    // ─── Grant Policy ─────────────────────────────────────────────

    getGrantPolicy: builder.query<GrantPolicyResponse, string>({
      query: (planId) => `/leave-plans/${planId}/grant-policy`,
      providesTags: ['GrantPolicy'],
    }),

    createGrantPolicy: builder.mutation<GrantPolicyResponse, { planId: string } & GrantPolicyCreate>({
      query: ({ planId, ...body }) => ({
        url: `/leave-plans/${planId}/grant-policy`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['GrantPolicy'],
    }),

    // ─── Leave Plan ↔ Leave Type mapping ─────────────────────────

    getLeavePlanLeaveTypes: builder.query<LeavePlanTypeMappingRow[], string>({
      query: (planId) => `/leave-plans/${planId}/leave-types`,
      providesTags: ['LeavePlanLeaveType'],
    }),

    addLeavePlanLeaveType: builder.mutation<void, { planId: string } & LeavePlanLeaveTypeAdd>({
      query: ({ planId, leave_type_id }) => ({
        url: `/leave-plans/${planId}/leave-types`,
        method: 'POST',
        body: { leave_type_id },
      }),
      invalidatesTags: ['LeavePlanLeaveType'],
    }),

    setLeavePlanLeaveTypes: builder.mutation<LeavePlanResponse, { planId: string; leave_type_ids: string[] }>({
      query: ({ planId, leave_type_ids }) => ({
        url: `/leave-plans/${planId}/leave-types`,
        method: 'POST',
        body: { leave_type_ids },
      }),
      invalidatesTags: ['LeavePlan'],
    }),

    removeLeavePlanLeaveType: builder.mutation<void, { planId: string; typeId: string }>({
      query: ({ planId, typeId }) => ({
        url: `/leave-plans/${planId}/leave-types/${typeId}`,
        method: 'DELETE',
      }),
      invalidatesTags: ['LeavePlanLeaveType'],
    }),

    getLeavePlanAssignments: builder.query<LeavePlanAssignmentResponse[], string>({
      query: (planId) => `/leave-plans/${planId}/assignments`,
      providesTags: ['LeavePlanAssignment'],
    }),

    createLeavePlanAssignment: builder.mutation<LeavePlanAssignmentResponse, LeavePlanAssignmentCreate>({
      query: (body) => ({ url: '/leave-plan-assignments', method: 'POST', body }),
      invalidatesTags: ['LeavePlanAssignment'],
    }),

    resolveEmployeeLeavePlan: builder.query<
      EmployeeLeavePlanResponse | null,
      { user_id: string; org_id: string; department_id?: string; business_unit_id?: string }
    >({
      query: (params) => ({ url: '/employee-leave-plans/resolve', method: 'POST', params }),
    }),

    getLeavePlanOverview: builder.query<
      LeavePlanOverview,
      { planId: string; business_unit_ids?: string; department_ids?: string; employment_status_keys?: string }
    >({
      query: ({ planId, ...params }) => {
        const searchParams = new URLSearchParams()
        if (params.business_unit_ids) searchParams.set('business_unit_ids', params.business_unit_ids)
        if (params.department_ids) searchParams.set('department_ids', params.department_ids)
        if (params.employment_status_keys) searchParams.set('employment_status_keys', params.employment_status_keys)
        const qs = searchParams.toString()
        return `/leave-plans/${planId}/overview${qs ? `?${qs}` : ''}`
      },
      providesTags: ['LeavePlan'],
    }),

    downloadLeavePlanOverview: builder.query<
      Blob,
      { planId: string; business_unit_ids?: string; department_ids?: string; employment_status_keys?: string }
    >({
      query: ({ planId, ...params }) => {
        const searchParams = new URLSearchParams()
        if (params.business_unit_ids) searchParams.set('business_unit_ids', params.business_unit_ids)
        if (params.department_ids) searchParams.set('department_ids', params.department_ids)
        if (params.employment_status_keys) searchParams.set('employment_status_keys', params.employment_status_keys)
        const qs = searchParams.toString()
        return {
          url: `/leave-plans/${planId}/overview/export${qs ? `?${qs}` : ''}`,
          responseHandler: (response: Response) => response.blob(),
        }
      },
    }),

    // ─── Holiday Classifications ────────────────────────────────

    getClassifications: builder.query<ClassificationResponse[], void>({
      query: () => '/holiday-classifications',
      providesTags: ['HolidayClassification'],
    }),

    createClassification: builder.mutation<ClassificationResponse, ClassificationCreate>({
      query: (body) => ({ url: '/holiday-classifications', method: 'POST', body }),
      invalidatesTags: ['HolidayClassification'],
    }),

    updateClassification: builder.mutation<ClassificationResponse, { id: string; body: ClassificationUpdate }>({
      query: ({ id, body }) => ({ url: `/holiday-classifications/${id}`, method: 'PUT', body }),
      invalidatesTags: ['HolidayClassification'],
    }),

    // ─── Holiday Plans ───────────────────────────────────────────

    getHolidayPlans: builder.query<HolidayPlanListItem[], { year?: number } | void>({
      query: (params) => ({
        url: '/holiday-plans',
        params: params?.year !== undefined ? { year: params.year } : {},
      }),
      providesTags: ['HolidayPlan'],
    }),

    getHolidayPlan: builder.query<HolidayPlanResponse, string>({
      query: (id) => `/holiday-plans/${id}`,
      providesTags: ['HolidayPlan'],
    }),

    getHolidayPlanDependencies: builder.query<{ employees: number; holidays: number }, string>({
      query: (id) => `/holiday-plans/${id}/dependencies`,
    }),

    createHolidayPlan: builder.mutation<HolidayPlanResponse, HolidayPlanCreate>({
      query: (body) => ({ url: '/holiday-plans', method: 'POST', body }),
      invalidatesTags: ['HolidayPlan'],
    }),

    updateHolidayPlan: builder.mutation<HolidayPlanResponse, { id: string; body: HolidayPlanUpdate }>({
      query: ({ id, body }) => ({ url: `/holiday-plans/${id}`, method: 'PUT', body }),
      invalidatesTags: ['HolidayPlan'],
    }),

    deleteHolidayPlan: builder.mutation<void, string>({
      query: (id) => ({ url: `/holiday-plans/${id}`, method: 'DELETE' }),
      invalidatesTags: ['HolidayPlan'],
    }),

    // ─── Holidays ────────────────────────────────────────────────

    getHolidays: builder.query<HolidayListResponse, { planId: string; page_size?: number }>({
      query: ({ planId, page_size = 100 }) => ({
        url: `/holiday-plans/${planId}/holidays`,
        params: { page: 1, page_size },
      }),
      providesTags: ['Holiday'],
    }),

    getHolidaysCalendar: builder.query<HolidayResponse[], { planId: string; fromDate: string; toDate: string }>({
      query: ({ planId, fromDate, toDate }) => ({
        url: '/holidays/calendar',
        params: { plan_id: planId, from_date: fromDate, to_date: toDate },
      }),
      providesTags: ['Holiday'],
    }),

    createHoliday: builder.mutation<HolidayResponse, HolidayCreate>({
      query: (body) => ({ url: '/holidays', method: 'POST', body }),
      invalidatesTags: ['Holiday'],
    }),

    updateHoliday: builder.mutation<HolidayResponse, { id: string; body: HolidayUpdate }>({
      query: ({ id, body }) => ({ url: `/holidays/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Holiday'],
    }),

    deleteHoliday: builder.mutation<void, string>({
      query: (id) => ({ url: `/holidays/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Holiday'],
    }),

    bulkImportHolidays: builder.mutation<BulkHolidayImportResponse, BulkHolidayImport>({
      query: (body) => ({ url: '/holidays/bulk', method: 'POST', body }),
      invalidatesTags: ['Holiday'],
    }),

    downloadHolidayBulkTemplate: builder.query<Blob, string>({
      query: (planId) => ({
        url: `/holiday-plans/${planId}/holidays/bulk-template`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    bulkImportHolidaysFromFile: builder.mutation<BulkHolidayImportResponse, { planId: string; holidays: { name: string; date: string; classification_id: string; description: string }[] }>({
      query: ({ planId, holidays }) => ({
        url: `/holiday-plans/${planId}/holidays/bulk-import`,
        method: 'POST',
        body: { holidays },
      }),
      invalidatesTags: ['Holiday'],
    }),

    validateHolidayBulkUpload: builder.mutation<HolidayBulkValidateResult, { planId: string; file: File }>({
      query: ({ planId, file }) => {
        const formData = new FormData()
        formData.append('file', file)
        return {
          url: `/holiday-plans/${planId}/holidays/bulk-validate`,
          method: 'POST',
          body: formData,
        }
      },
    }),

    syncHolidaysScope: builder.mutation<
      {
        extended: number; trimmed: number; orphaned: number;
        bu_extended: number; bu_trimmed: number; bu_orphaned: number;
      },
      { planId: string; extend?: string[]; trim?: string[]; bu_extend?: string[]; bu_trim?: string[] }
    >({
      query: ({ planId, extend, trim, bu_extend, bu_trim }) => ({
        url: `/holiday-plans/${planId}/holidays/sync-scope`,
        method: 'POST',
        body: {
          ...(extend && extend.length > 0 ? { extend } : {}),
          ...(trim && trim.length > 0 ? { trim } : {}),
          ...(bu_extend && bu_extend.length > 0 ? { bu_extend } : {}),
          ...(bu_trim && bu_trim.length > 0 ? { bu_trim } : {}),
        },
      }),
      invalidatesTags: ['Holiday'],
    }),

    // Atomic BU/dept scope edit — the plan fields, the holiday re-scope (extend/
    // trim on both axes) and the final employee membership are applied in ONE
    // transaction server-side, so a mid-flight failure can never leave the plan,
    // its holidays and its assignments half-updated. The FE still computes the
    // cascade behind its confirmation dialog and posts the resolved result here.
    updateHolidayPlanScope: builder.mutation<
      {
        extended: number; trimmed: number; orphaned: number;
        bu_extended: number; bu_trimmed: number; bu_orphaned: number;
        employees_added: number; employees_removed: number; employees_skipped: number;
        transactional: boolean;
      },
      {
        planId: string
        business_unit_ids: string[]
        department_ids: string[]
        name?: string
        is_active?: boolean
        reminder_settings?: { enabled: boolean; days_before: number }
        notify_employees?: boolean
        reprocess_leaves?: boolean
        holiday_extend_dept_ids?: string[]
        holiday_trim_dept_ids?: string[]
        holiday_extend_bu_ids?: string[]
        holiday_trim_bu_ids?: string[]
        member_user_ids: string[]
      }
    >({
      query: ({ planId, ...body }) => ({
        url: `/holiday-plans/${planId}/scope`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: ['HolidayPlan', 'Holiday', 'HolidayPlanEmployee'],
    }),

    // ─── Holiday Plan Employees ─────────────────────────────────

    getHolidayPlanEmployees: builder.query<HolidayPlanEmployeeEntry[], string>({
      query: (planId) => `/holiday-plans/${planId}/employees`,
      providesTags: ['HolidayPlanEmployee'],
    }),

    // Members of OTHER active plans (same org+year) in one call — replaces the
    // FE's per-other-plan fan-out for the "already on plan X" warning.
    getHolidayPlanCrossAssignments: builder.query<CrossAssignmentList, string>({
      query: (planId) => `/holiday-plans/${planId}/employees/cross-assignments`,
      providesTags: ['HolidayPlanEmployee'],
    }),

    syncHolidayPlanEmployees: builder.mutation<
      { added: number; removed: number; total: number },
      { planId: string; body: HolidayPlanEmployeeSync }
    >({
      query: ({ planId, body }) => ({ url: `/holiday-plans/${planId}/employees`, method: 'PUT', body }),
      invalidatesTags: ['HolidayPlanEmployee'],
    }),

    downloadHolidayPlanBulkTemplate: builder.query<Blob, string>({
      query: (planId) => ({
        url: `/holiday-plans/${planId}/employees/bulk-template`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    validateHolidayPlanBulkUpload: builder.mutation<BulkValidateResult, { planId: string; file: File }>({
      query: ({ planId, file }) => {
        const formData = new FormData()
        formData.append('file', file)
        return {
          url: `/holiday-plans/${planId}/employees/bulk-validate`,
          method: 'POST',
          body: formData,
        }
      },
    }),

    bulkAssignHolidayPlanEmployees: builder.mutation<{ added: number; skipped: number; total: number }, { planId: string; user_ids: string[] }>({
      query: ({ planId, user_ids }) => ({
        url: `/holiday-plans/${planId}/employees/bulk-assign`,
        method: 'POST',
        body: { user_ids },
      }),
      invalidatesTags: ['HolidayPlanEmployee'],
    }),

    syncHolidayPlanEmployeesByDepartments: builder.mutation<
      { added: number; removed: number; total: number },
      { planId: string; department_ids: string[] }
    >({
      query: ({ planId, department_ids }) => ({
        url: `/holiday-plans/${planId}/employees/sync-by-departments`,
        method: 'POST',
        body: { department_ids },
      }),
      invalidatesTags: ['HolidayPlanEmployee'],
    }),

    assignHolidayPlanEmployeesByDepartments: builder.mutation<
      { added: number; skipped: number; total: number },
      { planId: string; department_ids: string[] }
    >({
      query: ({ planId, department_ids }) => ({
        url: `/holiday-plans/${planId}/employees/assign-by-departments`,
        method: 'POST',
        body: { department_ids },
      }),
      invalidatesTags: ['HolidayPlanEmployee'],
    }),

    // ─── Work Calendars ──────────────────────────────────────────

    getWorkCalendars: builder.query<WorkCalendarListItem[], void>({
      query: () => '/work-calendars',
      providesTags: ['WorkCalendar'],
    }),

    getWorkCalendar: builder.query<WorkCalendarResponse, string>({
      query: (id) => `/work-calendars/${id}`,
      providesTags: ['WorkCalendar'],
    }),

    getWorkCalendarDependencies: builder.query<{ employees: number; shifts: number }, string>({
      query: (id) => `/work-calendars/${id}/dependencies`,
    }),

    createWorkCalendar: builder.mutation<WorkCalendarResponse, WorkCalendarCreate>({
      query: (body) => ({ url: '/work-calendars', method: 'POST', body }),
      invalidatesTags: ['WorkCalendar'],
    }),

    updateWorkCalendar: builder.mutation<WorkCalendarResponse, { id: string; body: WorkCalendarUpdate }>({
      query: ({ id, body }) => ({ url: `/work-calendars/${id}`, method: 'PUT', body }),
      invalidatesTags: ['WorkCalendar'],
    }),

    deleteWorkCalendar: builder.mutation<void, string>({
      query: (id) => ({ url: `/work-calendars/${id}`, method: 'DELETE' }),
      invalidatesTags: ['WorkCalendar'],
    }),

    getWorkCalendarEmployees: builder.query<WorkCalendarMember[], string>({
      query: (calendarId) => `/work-calendars/${calendarId}/employees`,
      providesTags: ['WorkCalendar'],
    }),

    // Members of OTHER active calendars (same org) in one call — replaces the
    // FE's per-other-calendar fan-out for the "already on calendar X" warning.
    getWorkCalendarCrossAssignments: builder.query<CrossAssignmentList, string>({
      query: (calendarId) => `/work-calendars/${calendarId}/employees/cross-assignments`,
      providesTags: ['WorkCalendar'],
    }),

    // Assignable-employee pool for the assignment pickers, served from the LMS
    // mirror (name/dept/BU/designation resolved) — replaces the IAM /employees
    // fetch + client-side join.
    getScopedEmployees: builder.query<ScopedEmployeeList, ScopedEmployeeParams>({
      query: (p) => ({
        url: '/employees',
        params: {
          ...(p.search ? { search: p.search } : {}),
          ...(p.employment_type_id ? { employment_type_id: p.employment_type_id } : {}),
          business_unit_ids: p.business_unit_ids?.length ? p.business_unit_ids.join(',') : undefined,
          department_ids: p.department_ids?.length ? p.department_ids.join(',') : undefined,
          designation_ids: p.designation_ids?.length ? p.designation_ids.join(',') : undefined,
          skip: p.skip ?? 0,
          limit: p.limit ?? 100,
        },
      }),
    }),

    syncWorkCalendarEmployees: builder.mutation<
      { added: number; removed: number; total: number },
      { calendarId: string; body: { user_ids: string[] } }
    >({
      query: ({ calendarId, body }) => ({ url: `/work-calendars/${calendarId}/employees`, method: 'PUT', body }),
      invalidatesTags: ['WorkCalendar'],
    }),

    downloadWorkCalendarBulkTemplate: builder.query<Blob, string>({
      query: (calendarId) => ({
        url: `/work-calendars/${calendarId}/employees/bulk-template`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    validateWorkCalendarBulkUpload: builder.mutation<BulkValidateResult, { calendarId: string; file: File }>({
      query: ({ calendarId, file }) => {
        const formData = new FormData()
        formData.append('file', file)
        return {
          url: `/work-calendars/${calendarId}/employees/bulk-validate`,
          method: 'POST',
          body: formData,
        }
      },
    }),

    bulkAssignWorkCalendarEmployees: builder.mutation<{ added: number; skipped: number; total: number }, { calendarId: string; user_ids: string[] }>({
      query: ({ calendarId, user_ids }) => ({
        url: `/work-calendars/${calendarId}/employees/bulk-assign`,
        method: 'POST',
        body: { user_ids },
      }),
      invalidatesTags: ['WorkCalendar'],
    }),

    syncWorkCalendarEmployeesByDepartments: builder.mutation<
      { added: number; removed: number; total: number },
      { calendarId: string; department_ids: string[] }
    >({
      query: ({ calendarId, department_ids }) => ({
        url: `/work-calendars/${calendarId}/employees/sync-by-departments`,
        method: 'POST',
        body: { department_ids },
      }),
      invalidatesTags: ['WorkCalendar'],
    }),

    getEmployeeWorkCalendar: builder.query<EmployeeWorkCalendarResponse | null, string>({
      query: (employeeId) => `/work-calendars/employee/${employeeId}`,
      providesTags: ['WorkCalendar'],
    }),

    // ─── Shifts ──────────────────────────────────────────────────

    getShifts: builder.query<ShiftResponse[], string>({
      query: (calendarId) => `/work-calendars/${calendarId}/shifts`,
      providesTags: ['Shift'],
    }),

    createShift: builder.mutation<ShiftResponse, ShiftCreate>({
      query: (body) => ({ url: '/work-calendars/shifts', method: 'POST', body }),
      invalidatesTags: ['Shift'],
    }),

    updateShift: builder.mutation<ShiftResponse, { id: string; body: ShiftUpdate }>({
      query: ({ id, body }) => ({ url: `/work-calendars/shifts/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Shift', 'ShiftAssignment'],
    }),

    deleteShift: builder.mutation<void, string>({
      query: (id) => ({ url: `/work-calendars/shifts/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Shift', 'ShiftAssignment'],
    }),

    // ─── Shift Assignments ────────────────────────────────────────

    getShiftAssignments: builder.query<ShiftAssignment[], string>({
      query: (calendarId) => `/work-calendars/${calendarId}/shift-assignments`,
      providesTags: ['ShiftAssignment'],
    }),

    syncShiftAssignments: builder.mutation<ShiftAssignmentSyncResult, { calendarId: string; body: ShiftAssignmentSyncPayload }>({
      query: ({ calendarId, body }) => ({ url: `/work-calendars/${calendarId}/shift-assignments`, method: 'PUT', body }),
      invalidatesTags: ['ShiftAssignment'],
    }),

    downloadShiftAssignmentTemplate: builder.query<Blob, string>({
      query: (calendarId) => ({
        url: `/work-calendars/${calendarId}/shift-assignments/bulk-template`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    validateShiftAssignmentBulkUpload: builder.mutation<ShiftAssignValidateResult, { calendarId: string; file: File }>({
      query: ({ calendarId, file }) => {
        const formData = new FormData()
        formData.append('file', file)
        return { url: `/work-calendars/${calendarId}/shift-assignments/bulk-validate`, method: 'POST', body: formData }
      },
    }),

    bulkAssignShiftEmployees: builder.mutation<ShiftAssignmentSyncResult, { calendarId: string; assignments: ShiftAssignment[] }>({
      query: ({ calendarId, assignments }) => ({
        url: `/work-calendars/${calendarId}/shift-assignments/bulk-assign`,
        method: 'POST',
        body: { assignments },
      }),
      invalidatesTags: ['ShiftAssignment'],
    }),

    // ─── Leave Requests ──────────────────────────────────────────

    getLeaveRequests: builder.query<LeaveRequestResponse[], { employee_id?: string; status?: string } | undefined>({
      query: (params) => ({ url: '/leave-requests', params: params ?? {} }),
      providesTags: ['LeaveRequest'],
    }),

    getMyLeaveRequests: builder.query<PaginatedLeaveRequests, MyLeaveRequestsParams | void>({
      query: (params) => ({ url: '/leave-requests/me', params: params ?? {} }),
      providesTags: ['LeaveRequest'],
    }),

    getLeaveRequest: builder.query<LeaveRequestDetailResponse, string>({
      query: (id) => `/leave-requests/${id}`,
      providesTags: ['LeaveRequest'],
    }),

    getLeaveBalanceProjection: builder.query<BalanceProjectionResponse, { leave_type_id?: string } | void>({
      query: (params) => ({ url: '/leave-requests/balance-projection', params: params ?? {} }),
      providesTags: ['BalanceProjection'],
    }),

    getLeaveHistory: builder.query<LeaveHistoryResponse, LeaveHistoryParams | void>({
      query: (params) => ({ url: '/leave-requests/history', params: params ?? {} }),
      providesTags: ['LeaveHistory'],
    }),

    createLeaveRequest: builder.mutation<LeaveRequestResponse, LeaveRequestCreate>({
      query: (body) => ({ url: '/leave-requests', method: 'POST', body }),
      invalidatesTags: ['LeaveRequest', 'Balance'],
    }),

    updateLeaveRequest: builder.mutation<LeaveRequestResponse, { id: string; body: LeaveRequestCreate }>({
      query: ({ id, body }) => ({ url: `/leave-requests/${id}`, method: 'PUT', body }),
      invalidatesTags: ['LeaveRequest', 'Balance'],
    }),

    approveLeaveRequest: builder.mutation<LeaveRequestResponse, { id: string; body: ApprovalActionPayload }>({
      query: ({ id, body }) => ({ url: `/leave-requests/${id}/approve`, method: 'POST', body }),
      invalidatesTags: ['LeaveRequest'],
    }),

    rejectLeaveRequest: builder.mutation<LeaveRequestResponse, { id: string; body: ApprovalActionPayload }>({
      query: ({ id, body }) => ({ url: `/leave-requests/${id}/reject`, method: 'POST', body }),
      invalidatesTags: ['LeaveRequest'],
    }),

    cancelLeaveRequest: builder.mutation<LeaveRequestResponse, string>({
      query: (id) => ({ url: `/leave-requests/${id}/cancel`, method: 'POST' }),
      invalidatesTags: ['LeaveRequest', 'Balance'],
    }),

    getTeamAvailability: builder.query<TeamAvailabilityResponse, TeamAvailabilityParams>({
      query: (params) => ({ url: '/manager/team-availability', params }),
      providesTags: ['ManagerLeaveRequest'],
    }),

    getLeaveBalances: builder.query<LeaveBalancesResponse, void>({
      query: () => '/leave-requests/balances',
      providesTags: ['LeaveBalances'],
    }),

    getTeamLeaveSummary: builder.query<TeamLeaveSummaryResponse, TeamLeaveSummaryParams | void>({
      query: (params) => ({ url: '/manager/team-leave-summary', params: params ?? {} }),
      providesTags: ['TeamLeaveSummary'],
    }),

    getTeamCalendar: builder.query<TeamCalendarResponse, TeamCalendarParams>({
      query: ({ from_date, to_date, status }) => {
        const params = new URLSearchParams({ from_date, to_date });
        if (status) {
          const statuses = Array.isArray(status) ? status : [status];
          statuses.forEach(s => params.append('status', s));
        }
        return `/manager/team-calendar?${params.toString()}`;
      },
      providesTags: ['TeamCalendar'],
    }),

    getMyCalendar: builder.query<MyCalendarResponse, { from: string; to: string }>({
      query: ({ from, to }) => ({ url: '/calendar', params: { from, to } }),
      providesTags: ['MyCalendar'],
    }),

    getMyHolidays: builder.query<MyHolidaysResponse, { year: number }>({
      query: ({ year }) => ({ url: '/my-holidays', params: { year } }),
      providesTags: ['MyCalendar'],
    }),

    // ─── Employee Dashboard ──────────────────────────────────────

    getEmployeeDashboard: builder.query<EmployeeDashboardResponse, void>({
      query: () => '/dashboard/employee',
      providesTags: ['EmployeeDashboard'],
    }),

    getOrgOnLeaveToday: builder.query<OrgOnLeaveResponse, void>({
      query: () => '/dashboard/org/on-leave-today',
      providesTags: ['EmployeeDashboard'],
    }),

    // skip/limit page the result — ManagerLeaveManagement pages this via
    // infinite scroll instead of loading everything at once (some orgs have
    // thousands of rows). Omitting limit keeps the old unbounded behavior.
    getManagerLeaveRequests: builder.query<LeaveRequestResponse[], { status?: string; from_date?: string; to_date?: string; skip?: number; limit?: number } | void>({
      query: (params) => ({ url: '/manager/leave-requests', params: params ?? {} }),
      providesTags: ['ManagerLeaveRequest'],
    }),

    getManagerPendingApprovals: builder.query<LeaveRequestResponse[], void>({
      query: () => '/manager/leave-requests/pending-approvals',
      providesTags: ['ManagerLeaveRequest'],
    }),

    getManagerLeaveRequest: builder.query<ManagerLeaveRequestDetail, string>({
      query: (id) => `/manager/leave-requests/${id}`,
      providesTags: ['ManagerLeaveRequest'],
    }),

    approveManagerLeaveRequest: builder.mutation<LeaveRequestResponse, { id: string; body: ApprovalActionPayload }>({
      query: ({ id, body }) => ({ url: `/manager/leave-requests/${id}/approve`, method: 'POST', body }),
      invalidatesTags: ['ManagerLeaveRequest'],
    }),

    rejectManagerLeaveRequest: builder.mutation<LeaveRequestResponse, { id: string; body: ApprovalActionPayload }>({
      query: ({ id, body }) => ({ url: `/manager/leave-requests/${id}/reject`, method: 'POST', body }),
      invalidatesTags: ['ManagerLeaveRequest'],
    }),

    getLeaveRequestBalance: builder.query<LeaveRequestBalanceResponse, { leave_type_id: string }>({
      query: (params) => ({ url: '/leave-requests/balance', params }),
      providesTags: ['Balance'],
    }),

    getLeaveBalanceEstimate: builder.query<LeaveBalanceEstimateResponse, LeaveBalanceEstimateParams>({
      query: (params) => ({ url: '/leave-requests/balance-estimate', params }),
    }),

    getLeaveRequestEstimate: builder.query<LeaveRequestEstimateResponse, LeaveRequestEstimateParams>({
      query: (params) => ({ url: '/leave-requests/estimate', params }),
    }),

    /**
     * Days of one leave type used this leave year. Feeds the usage warning on
     * unrestricted leave, which keeps no balance for the apply form or the
     * approver to show instead. `user_id` is for approver surfaces; omit it and
     * the API reads the caller's own usage.
     */
    getLeaveTypeUsage: builder.query<LeaveTypeUsage, { leave_type_id: string; user_id?: string }>({
      query: (params) => ({ url: '/leave-requests/usage', params }),
      // Applying or approving changes what has been used.
      providesTags: ['LeaveRequest'],
    }),

    uploadAsset: builder.mutation<AssetUploadResponse, File>({
      query: (file) => {
        const formData = new FormData()
        formData.append('file', file)
        return { url: '/assets', method: 'POST', body: formData }
      },
      invalidatesTags: ['Asset'],
    }),

    getAsset: builder.query<AssetUploadResponse, string>({
      query: (assetId) => `/assets/${assetId}`,
      providesTags: ['Asset'],
    }),

    sendAgentMessage: builder.mutation<AgentChatResponse, AgentChatRequest>({
      query: (body) => ({ url: '/api/v1/agent/chat', method: 'POST', body }),
    }),

    getAssetDownloadUrl: builder.query<{ url: string; expires_in: number }, string>({
      query: (assetId) => `/assets/${assetId}/url`,
    }),

    // ─── Approval Flows ──────────────────────────────────────────

    getApprovalFlow: builder.query<ApprovalFlowResponse | null, string>({
      query: (leavePlanId) => ({ url: '/approval-flows', params: { leave_plan_id: leavePlanId } }),
      providesTags: ['ApprovalFlow'],
    }),

    getMyApprovalChain: builder.query<ApprovalPolicyResponse | null, void>({
      query: () => '/approval-flows/me',
      providesTags: ['ApprovalFlow'],
    }),

    createApprovalFlow: builder.mutation<ApprovalFlowResponse, ApprovalFlowCreate>({
      query: (body) => ({ url: '/approval-flows', method: 'POST', body }),
      invalidatesTags: ['ApprovalFlow'],
    }),

    createApprovalOverride: builder.mutation<Record<string, unknown>, ApprovalOverrideCreate>({
      query: (body) => ({ url: '/approval-overrides', method: 'POST', body }),
    }),

    // ─── Plan Entitlements ───────────────────────────────────────

    getPlanEntitlement: builder.query<PlanEntitlementResponse, string>({
      query: (planId) => `/leave-plans/${planId}/entitlements`,
      providesTags: ['EntitlementPolicy'],
    }),

    createPlanEntitlement: builder.mutation<PlanEntitlementResponse, PlanEntitlementCreate>({
      query: (body) => ({ url: '/leave-plans/entitlements', method: 'POST', body }),
      invalidatesTags: ['EntitlementPolicy'],
    }),

    updatePlanEntitlement: builder.mutation<PlanEntitlementResponse, { planId: string; entitlement: PlanEntitlementCreate['entitlement'] }>({
      query: ({ planId, entitlement }) => ({ url: `/leave-plans/${planId}/entitlements`, method: 'PUT', body: { entitlement } }),
      invalidatesTags: ['EntitlementPolicy'],
    }),

    // ─── Entitlement Policies ────────────────────────────────────

    getEntitlementPolicies: builder.query<EntitlementPolicyResponse[], string>({
      query: (leavePlanId) => ({ url: '/entitlements/policies', params: { leave_plan_id: leavePlanId } }),
      providesTags: ['EntitlementPolicy'],
    }),

    getEntitlementPolicy: builder.query<EntitlementPolicyResponse, string>({
      query: (id) => `/entitlements/policies/${id}`,
      providesTags: ['EntitlementPolicy'],
    }),

    createEntitlementPolicy: builder.mutation<EntitlementPolicyResponse, EntitlementPolicyCreate>({
      query: (body) => ({ url: '/entitlements/policies', method: 'POST', body }),
      invalidatesTags: ['EntitlementPolicy'],
    }),

    updateEntitlementPolicy: builder.mutation<EntitlementPolicyResponse, { id: string; body: EntitlementPolicyUpdate }>({
      query: ({ id, body }) => ({ url: `/entitlements/policies/${id}`, method: 'PUT', body }),
      invalidatesTags: ['EntitlementPolicy'],
    }),

    // ─── Entitlements & Ledger ───────────────────────────────────

    // Self-service: the endpoint reads the user from the auth token, so only an
    // optional leave_type_id filter is sent (no employee_id — it was ignored).
    getEntitlements: builder.query<LeaveEntitlementResponse[], { leave_type_id?: string } | void>({
      query: (params) => ({ url: '/entitlements', params: params ?? {} }),
      providesTags: ['Entitlement'],
    }),

    createEntitlement: builder.mutation<LeaveEntitlementResponse, LeaveEntitlementCreate>({
      query: (body) => ({ url: '/entitlements', method: 'POST', body }),
      invalidatesTags: ['Entitlement', 'Balance'],
    }),

    // Self-service: user comes from the auth token; only leave_type_id is sent.
    getLedger: builder.query<LedgerEntryResponse[], { leave_type_id?: string } | void>({
      query: (params) => ({ url: '/entitlements/ledger', params: params ?? {} }),
      providesTags: ['Ledger'],
    }),

    createLedgerEntry: builder.mutation<LedgerEntryResponse, LedgerEntryCreate>({
      query: (body) => ({ url: '/entitlements/ledger', method: 'POST', body }),
      invalidatesTags: ['Ledger', 'Balance'],
    }),

    // Self-service: user comes from the auth token; only leave_type_id is sent.
    getBalance: builder.query<LeaveBalanceResponse, { leave_type_id: string }>({
      query: (params) => ({ url: '/entitlements/balance', params }),
      providesTags: ['Balance'],
    }),

    // ─── Year-End Processing ─────────────────────────────────────

    getYearEndConfig: builder.query<YearEndProcessingResponse, string>({
      query: (planId) => `/leave-plans/${planId}/year-end-processing`,
      providesTags: ['YearEndConfig'],
    }),

    createYearEndConfig: builder.mutation<YearEndProcessingResponse, { planId: string; body: YearEndProcessingCreate }>({
      query: ({ planId, body }) => ({
        url: `/leave-plans/${planId}/year-end-processing`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['YearEndConfig'],
    }),

    updateYearEndConfig: builder.mutation<YearEndProcessingResponse, { planId: string; body: YearEndProcessingUpdate }>({
      query: ({ planId, body }) => ({
        url: `/leave-plans/${planId}/year-end-processing`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: ['YearEndConfig'],
    }),

    // ─── Leave Analytics ─────────────────────────────────────────

    getLeaveAnalyticsEmployeeDashboard: builder.query<LeaveAnalyticsEmployeeDashboardResponse, void>({
      query: () => '/leave-analytics/employee-dashboard',
    }),

    getManagerDashboard: builder.query<
      ManagerDashboardResponse,
      { from_date?: string; to_date?: string } | void
    >({
      query: (args) => ({
        url: '/leave-analytics/manager-dashboard',
        params: args ? { from_date: args.from_date, to_date: args.to_date } : undefined,
      }),
    }),

    getHRDashboard: builder.query<HRDashboardResponse, void>({
      query: () => '/leave-analytics/hr-dashboard',
    }),

    getMDDashboard: builder.query<MDDashboardResponse, void>({
      query: () => '/leave-analytics/md-dashboard',
    }),

    getCFODashboard: builder.query<CFODashboardResponse, void>({
      query: () => '/leave-analytics/cfo-dashboard',
    }),


    // ─── Sandwich Policy ─────────────────────────────────────────

    getSandwichPolicy: builder.query<SandwichPolicyResponse, string>({
      query: (planId) => `/leave-plans/${planId}/sandwich-policy`,
      providesTags: ['SandwichPolicy'],
    }),

    upsertSandwichPolicy: builder.mutation<SandwichPolicyResponse, { planId: string; body: SandwichPolicyUpsert }>({
      query: ({ planId, body }) => ({
        url: `/leave-plans/${planId}/sandwich-policy`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: ['SandwichPolicy'],
    }),

    // ─── Approval Policy ─────────────────────────────────────────

    getApprovalPolicy: builder.query<ApprovalPolicyResponse, string>({
      query: (planId) => `/leave-plans/${planId}/approval-policy`,
      providesTags: ['ApprovalPolicy'],
    }),

    upsertApprovalPolicy: builder.mutation<ApprovalPolicyResponse, { planId: string; body: ApprovalPolicyUpsert }>({
      query: ({ planId, body }) => ({
        url: `/leave-plans/${planId}/approval-policy`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: ['ApprovalPolicy'],
    }),

    getResolvedPlanEntitlement: builder.query<PlanEntitlementResponse | null, { userId: string; orgId: string }>({
      async queryFn({ userId, orgId }, _queryApi, _extraOptions, baseQuery) {
        let leavePlanId = '';
        // The GET /employee-leave-plans/{id} route is disabled server-side, so
        // resolve is the only path that can answer. See getMyPlanLeaveTypeIds.
        {
          const resolveResult = await baseQuery({
            url: '/employee-leave-plans/resolve',
            method: 'POST',
            params: { user_id: userId, org_id: orgId },
          });
          if (resolveResult.data) {
            const resolvedPlan = resolveResult.data as EmployeeLeavePlanResponse;
            leavePlanId = resolvedPlan.leave_plan_id;
          }
        }

        if (!leavePlanId) {
          return { data: null };
        }

        const entitlementResult = await baseQuery({
          url: `/leave-plans/${leavePlanId}/entitlements`,
          method: 'GET'
        });

        if (entitlementResult.error) {
          return { error: entitlementResult.error as any };
        }

        return { data: entitlementResult.data as PlanEntitlementResponse };
      },
      providesTags: ['EntitlementPolicy'],
    }),

    /**
     * The leave types mapped to the employee's assigned leave plan.
     *
     * `typeIds` is `null` whenever we can't produce a trustworthy allowlist (no
     * plan resolved, plan maps nothing, or the lookup failed). Callers treat
     * null as "don't filter", so an employee is never locked out of the picker
     * by a missing or misconfigured plan. `reason` says WHY it's null, so the UI
     * can warn about the two cases the backend will reject at submit time —
     * `error` is transient and deliberately not surfaced.
     *
     * This is an ALLOWLIST only. The leave-type data still comes from
     * `/leave-types`, because the plan endpoint returns a reduced projection
     * missing flags the request form depends on (`is_comp_off` etc).
     */
    getMyPlanLeaveTypeIds: builder.query<MyPlanLeaveTypes, { userId: string; orgId: string }>({
      async queryFn({ userId, orgId }, _queryApi, _extraOptions, baseQuery) {
        let leavePlanId = ''

        // GET /employee-leave-plans/{id} is disabled server-side (the route is
        // commented out), so it 404'd on every call and we always fell through
        // to resolve. Going straight to resolve drops a wasted round trip and a
        // red 404 per page load.
        const resolveResult = await baseQuery({
          url: '/employee-leave-plans/resolve',
          method: 'POST',
          params: { user_id: userId, org_id: orgId },
        })
        if (resolveResult.data) {
          leavePlanId = (resolveResult.data as EmployeeLeavePlanResponse).leave_plan_id
        }

        // Backend raises NO_LEAVE_PLAN on submit for this employee.
        if (!leavePlanId) {
          return { data: { planId: null, typeIds: null, reason: 'no_plan' } }
        }

        const typesResult = await baseQuery({
          url: `/leave-plans/${leavePlanId}/leave-types`,
          method: 'GET',
        })
        // A failed lookup must not hide every leave type — fall back to no filter.
        if (typesResult.error) {
          return { data: { planId: leavePlanId, typeIds: null, reason: 'error' } }
        }

        const rows = (typesResult.data as LeavePlanTypeMappingRow[]) ?? []
        const ids = rows.map((r) => r.leave_type?._id).filter(Boolean)
        return {
          data: ids.length > 0
            ? { planId: leavePlanId, typeIds: ids, reason: 'ok' }
            : { planId: leavePlanId, typeIds: null, reason: 'no_types' },
        }
      },
      providesTags: ['LeavePlanLeaveType'],
    }),

    getLeaveRequestFieldConfig: builder.query<LeaveRequestFieldConfig, { userId: string; orgId: string }>({
      async queryFn({ userId, orgId }, _queryApi, _extraOptions, baseQuery) {
        const defaults: LeaveRequestFieldConfig = {
          reason_mandatory: false,
          document_mandatory: false,
          document_required_after_days: null,
          max_consecutive_days: null,
          approval_required: false,
          approval_levels: [],
          levels_operator: null,
        };

        let leavePlanId = '';

        // The GET /employee-leave-plans/{id} route is disabled server-side, so
        // resolve is the only path that can answer. See getMyPlanLeaveTypeIds.
        {
          const resolveResult = await baseQuery({
            url: '/employee-leave-plans/resolve',
            method: 'POST',
            params: { user_id: userId, org_id: orgId },
          });
          if (resolveResult.data) {
            leavePlanId = (resolveResult.data as EmployeeLeavePlanResponse).leave_plan_id;
          }
        }

        if (!leavePlanId) {
          const plansResult = await baseQuery({
            url: '/leave-plans',
            params: { org_id: orgId },
          });
          if (plansResult.data) {
            const plans = plansResult.data as LeavePlanResponse[];
            const activePlan = plans.find(p => p.status === 'active' || p.is_active === true);
            if (activePlan) {
              leavePlanId = activePlan._id;
            }
          }
        }

        if (!leavePlanId) return { data: defaults };

        const entitlementResult = await baseQuery({
          url: `/leave-plans/${leavePlanId}/entitlements`,
          method: 'GET',
        });
        if (entitlementResult.error) return { data: defaults };

        const ent = entitlementResult.data as PlanEntitlementResponse;
        const rv = ent?.entitlement?.request_validation;
        const commentReq = rv?.comment_requirement ?? ent?.entitlement?.comment_requirement;
        const uploadReq = rv?.upload_requirement ?? ent?.entitlement?.upload_requirement;
        const continuousLimit = ent?.entitlement?.continuous_limit;

        let approvalRequired = false;
        let approvalLevels: ApprovalPolicyResponse['approval_levels'] = [];
        let levelsOperator: 'AND' | 'OR' | null = null;

        const approvalResult = await baseQuery({
          url: `/leave-plans/${leavePlanId}/approval-policy`,
          method: 'GET',
        });
        if (approvalResult.data) {
          const policy = approvalResult.data as ApprovalPolicyResponse;
          approvalRequired = policy.approval_required;
          approvalLevels = policy.approval_levels ?? [];
          levelsOperator = policy.levels_operator ?? null;
        }

        return {
          data: {
            reason_mandatory: commentReq?.mode === 'mandatory',
            document_mandatory: uploadReq?.mandatory === true,
            document_required_after_days: uploadReq?.required_after_days ?? null,
            max_consecutive_days: continuousLimit?.enabled ? (continuousLimit.max_consecutive_days ?? null) : null,
            approval_required: approvalRequired,
            approval_levels: approvalLevels,
            levels_operator: levelsOperator,
          },
        };
      },
      providesTags: ['EntitlementPolicy'],
    }),

    // ─── Toggle Config ──────────────────────────────────────────

    getToggleConfig: builder.query<ToggleConfigResponse, string>({
      query: (planId) => `/leave-plans/${planId}/toggle-config`,
      providesTags: ['ToggleConfig'],
    }),

    upsertToggleConfig: builder.mutation<ToggleConfigResponse, { planId: string; body: ToggleConfigUpsert }>({
      query: ({ planId, body }) => ({
        url: `/leave-plans/${planId}/toggle-config`,
        method: 'PUT',
        body,
      }),
      invalidatesTags: ['ToggleConfig'],
    }),

  }),
})

export const {
  useGetLeaveTypesQuery,
  useGetEligibleLeaveTypesQuery,
  useGetLeaveTypeQuery,
  useCreateLeaveTypeMutation,
  useUpdateLeaveTypeMutation,
  useDeleteLeaveTypeMutation,
  useGetLeavePlansQuery,
  useGetLeavePlanQuery,
  useCreateLeavePlanMutation,
  useUpdateLeavePlanMutation,
  useDeleteLeavePlanMutation,
  useActivateLeavePlanMutation,
  useDeactivateLeavePlanMutation,
  useLazyGetAssetDownloadUrlQuery,
  useGetGrantPolicyQuery,
  useCreateGrantPolicyMutation,
  useGetLeavePlanLeaveTypesQuery,
  useAddLeavePlanLeaveTypeMutation,
  useRemoveLeavePlanLeaveTypeMutation,
  useSetLeavePlanLeaveTypesMutation,
  useGetLeavePlanAssignmentsQuery,
  useCreateLeavePlanAssignmentMutation,
  useResolveEmployeeLeavePlanQuery,
  useGetClassificationsQuery,
  useCreateClassificationMutation,
  useUpdateClassificationMutation,
  useGetHolidayPlansQuery,
  useGetHolidayPlanQuery,
  useLazyGetHolidayPlanDependenciesQuery,
  useCreateHolidayPlanMutation,
  useUpdateHolidayPlanMutation,
  useDeleteHolidayPlanMutation,
  useGetHolidaysQuery,
  useGetHolidaysCalendarQuery,
  useCreateHolidayMutation,
  useUpdateHolidayMutation,
  useDeleteHolidayMutation,
  useBulkImportHolidaysMutation,
  useBulkImportHolidaysFromFileMutation,
  useLazyDownloadHolidayBulkTemplateQuery,
  useValidateHolidayBulkUploadMutation,
  useSyncHolidaysScopeMutation,
  useUpdateHolidayPlanScopeMutation,
  useGetHolidayPlanEmployeesQuery,
  useLazyGetHolidayPlanEmployeesQuery,
  useSyncHolidayPlanEmployeesMutation,
  useLazyDownloadHolidayPlanBulkTemplateQuery,
  useValidateHolidayPlanBulkUploadMutation,
  useBulkAssignHolidayPlanEmployeesMutation,
  useSyncHolidayPlanEmployeesByDepartmentsMutation,
  useAssignHolidayPlanEmployeesByDepartmentsMutation,
  useGetWorkCalendarsQuery,
  useGetWorkCalendarQuery,
  useLazyGetWorkCalendarDependenciesQuery,
  useCreateWorkCalendarMutation,
  useUpdateWorkCalendarMutation,
  useDeleteWorkCalendarMutation,
  useGetWorkCalendarEmployeesQuery,
  useGetScopedEmployeesQuery,
  useLazyGetScopedEmployeesQuery,
  useGetHolidayPlanCrossAssignmentsQuery,
  useGetWorkCalendarCrossAssignmentsQuery,
  useSyncWorkCalendarEmployeesMutation,
  useLazyDownloadWorkCalendarBulkTemplateQuery,
  useValidateWorkCalendarBulkUploadMutation,
  useBulkAssignWorkCalendarEmployeesMutation,
  useSyncWorkCalendarEmployeesByDepartmentsMutation,
  useGetEmployeeWorkCalendarQuery,
  useGetShiftsQuery,
  useCreateShiftMutation,
  useUpdateShiftMutation,
  useDeleteShiftMutation,
  useGetShiftAssignmentsQuery,
  useSyncShiftAssignmentsMutation,
  useLazyDownloadShiftAssignmentTemplateQuery,
  useValidateShiftAssignmentBulkUploadMutation,
  useBulkAssignShiftEmployeesMutation,
  useGetLeaveRequestsQuery,
  useGetMyLeaveRequestsQuery,
  useGetLeaveRequestQuery,
  useGetLeaveBalanceProjectionQuery,
  useGetLeaveHistoryQuery,
  useCreateLeaveRequestMutation,
  useUpdateLeaveRequestMutation,
  useApproveLeaveRequestMutation,
  useRejectLeaveRequestMutation,
  useCancelLeaveRequestMutation,
  useGetLeaveBalancesQuery,
  useGetTeamLeaveSummaryQuery,
  useGetTeamCalendarQuery,
  useGetMyCalendarQuery,
  useGetMyHolidaysQuery,
  useGetOrgOnLeaveTodayQuery,
  useGetTeamAvailabilityQuery,
  useGetManagerLeaveRequestsQuery,
  useLazyGetManagerLeaveRequestsQuery,
  useGetManagerPendingApprovalsQuery,
  useGetManagerLeaveRequestQuery,
  useApproveManagerLeaveRequestMutation,
  useRejectManagerLeaveRequestMutation,
  useGetLeaveRequestBalanceQuery,
  useLazyGetLeaveBalanceEstimateQuery,
  useLazyGetLeaveRequestEstimateQuery,
  useGetLeaveTypeUsageQuery,
  useUploadPolicyDocumentMutation,
  useGetPolicyDocumentMetaQuery,
  useDeletePolicyDocumentMutation,
  useUploadAssetMutation,
  useSendAgentMessageMutation,
  useGetAssetQuery,
  useGetAssetDownloadUrlQuery,
  useGetApprovalFlowQuery,
  useGetMyApprovalChainQuery,
  useCreateApprovalFlowMutation,
  useCreateApprovalOverrideMutation,
  useGetPlanEntitlementQuery,
  useCreatePlanEntitlementMutation,
  useUpdatePlanEntitlementMutation,
  useGetEntitlementPoliciesQuery,
  useGetEntitlementPolicyQuery,
  useCreateEntitlementPolicyMutation,
  useUpdateEntitlementPolicyMutation,
  useGetEntitlementsQuery,
  useCreateEntitlementMutation,
  useGetLedgerQuery,
  useCreateLedgerEntryMutation,
  useGetBalanceQuery,
  useGetYearEndConfigQuery,
  useCreateYearEndConfigMutation,
  useUpdateYearEndConfigMutation,
  useGetEmployeeDashboardQuery,
  useGetLeaveAnalyticsEmployeeDashboardQuery,
  useGetManagerDashboardQuery,
  useGetHRDashboardQuery,
  useGetMDDashboardQuery,
  useGetCFODashboardQuery,
  useGetSandwichPolicyQuery,
  useUpsertSandwichPolicyMutation,
  useGetApprovalPolicyQuery,
  useUpsertApprovalPolicyMutation,
  useGetLeavePlanOverviewQuery,
  useLazyDownloadLeavePlanOverviewQuery,
  useGetToggleConfigQuery,
  useUpsertToggleConfigMutation,
  useGetResolvedPlanEntitlementQuery,
  useGetMyPlanLeaveTypeIdsQuery,
  useGetLeaveRequestFieldConfigQuery,
} = lmsApi
