import { apiClient } from '@/lib/axios';

export interface LeaveTypeInfo {
  id: string;
  name: string;
}

export interface LeaveTypeDetail {
  leave_type_id: string;
  leave_type_name: string;
  opening_balance: number;
  payout_amount: number;
  encashed_amount: number;
  carry_forward_amount: number;
  expired_amount: number;
  closing_balance: number;
}

export interface YearEndEmployee {
  employee_id: string;
  emp_code: string;
  name: string;
  department: string;
  business_unit: string;
  year: number;
  opening_balance: number;
  payout_amount: number;
  encashed_amount: number;
  carry_forward_amount: number;
  expired_amount: number;
  closing_balance: number;
  status: string;
  leave_type_details: LeaveTypeDetail[];
}

export interface YearEndReportResponse {
  leave_plan_name: string;
  year: number;
  leave_types: LeaveTypeInfo[];
  employees: YearEndEmployee[];
  total_count: number;
}

export interface BalanceLeaveTypeDetail {
  leave_type_id: string;
  leave_type_name: string;
  opening: number;
  used_ytd: number;
  balance: number;
}

export interface BalanceEmployee {
  employee_id: string;
  emp_code: string;
  name: string;
  department: string;
  business_unit: string;
  opening: number;
  used_ytd: number;
  total_balance: number;
  leave_type_details: BalanceLeaveTypeDetail[];
}

export interface CurrentBalanceResponse {
  leave_plan_name: string;
  leave_types: LeaveTypeInfo[];
  employees: BalanceEmployee[];
  total_count: number;
}

export const fetchYearEndReport = async (params: {
  leave_plan_id: string;
  year: number;
  search?: string;
  page?: number;
  page_size?: number;
}): Promise<YearEndReportResponse> => {
  const { data } = await apiClient.get<YearEndReportResponse>('/reports/year-end-processing', { params });
  return data;
};

export const fetchYearEndYears = async (leave_plan_id: string): Promise<number[]> => {
  const { data } = await apiClient.get<number[]>('/reports/year-end-processing/years', {
    params: { leave_plan_id },
  });
  return data;
};

export const exportYearEndReport = async (params: {
  leave_plan_id: string;
  year: number;
  search?: string;
}): Promise<Blob> => {
  const { data } = await apiClient.get('/reports/year-end-processing/export', {
    params,
    responseType: 'blob',
  });
  return data;
};

export const fetchCurrentBalanceReport = async (params: {
  leave_plan_id: string;
  search?: string;
  page?: number;
  page_size?: number;
}): Promise<CurrentBalanceResponse> => {
  const { data } = await apiClient.get<CurrentBalanceResponse>('/reports/current-leave-balance', { params });
  return data;
};

export const exportCurrentBalanceReport = async (params: {
  leave_plan_id: string;
  search?: string;
}): Promise<Blob> => {
  const { data } = await apiClient.get('/reports/current-leave-balance/export', {
    params,
    responseType: 'blob',
  });
  return data;
};

// ─── Employee Leave Report (HR) ────────────────────────────────────────────
// Date-range extract of leave requests and their approval trail. The list, the
// statistics and the export all take the same filter shape, so the three views
// on screen can never describe different populations.

export type LeaveRequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

export interface ApprovalTrailEntry {
  action: string;
  level: number | null;
  actor_id: string | null;
  actor_name: string;
  comment: string | null;
  acted_on: string | null;
}

export interface EmployeeLeaveRow {
  request_id: string;
  employee_id: string;
  user_id: string;
  emp_code: string;
  employee_name: string;
  email: string;
  business_unit: string;
  department: string;
  designation: string;
  leave_type_id: string | null;
  leave_type: string;
  from_date: string | null;
  to_date: string | null;
  days: number;
  hours: number;
  duration_mode: string | null;
  half_day_period: string | null;
  status: LeaveRequestStatus | string;
  loss_of_pay: boolean;
  reason: string;
  applied_on: string | null;
  approval_trail: ApprovalTrailEntry[];
  current_approver: string | null;
  l1_manager: string;
  l2_manager: string;
  action_by: string | null;
  action_on: string | null;
  action_comment: string | null;
  approval_turnaround_days: number | null;
}

export interface EmployeeLeaveReportResponse {
  from_date: string;
  to_date: string;
  items: EmployeeLeaveRow[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface LeaveBreakdownEntry {
  name: string;
  requests: number;
  days: number;
}

export interface EmployeeLeaveStatistics {
  from_date: string;
  to_date: string;
  total_requests: number;
  total_days: number;
  approved_requests: number;
  approved_days: number;
  pending_requests: number;
  pending_days: number;
  rejected_requests: number;
  rejected_days: number;
  cancelled_requests: number;
  cancelled_days: number;
  loss_of_pay_days: number;
  employees_on_leave: number;
  employees_in_scope: number;
  avg_days_per_request: number;
  avg_approval_turnaround_days: number | null;
  by_status: { status: string; requests: number; days: number }[];
  by_leave_type: LeaveBreakdownEntry[];
  by_business_unit: LeaveBreakdownEntry[];
  by_department: LeaveBreakdownEntry[];
}

export interface LeaveReportFilterOptions {
  business_units: { id: string; name: string }[];
  departments: { id: string; name: string; business_unit_ids: string[] }[];
  leave_types: { id: string; name: string }[];
  statuses: LeaveRequestStatus[];
}

export interface EmployeeLeaveReportParams {
  from_date: string;
  to_date: string;
  business_unit_id?: string[];
  department_id?: string[];
  leave_type_id?: string[];
  status?: string[];
  /** Specific employees, by user id or employee id — the server matches either. */
  employee_id?: string[];
  /** Free-text fallback; applied on top of `employee_id` when both are sent. */
  search?: string;
}

/**
 * The multi-value filters go over the wire as REPEATED params
 * (`?department_id=a&department_id=b`), which is what FastAPI's `list[str]`
 * query binding reads. Axios' default would emit `department_id[]=a`, and the
 * bracketed name silently binds to nothing — so every list call must pass this.
 */
const repeatArrays = { indexes: null } as const;

const cleanParams = <T extends object>(params: T): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as Partial<T>;
};

export const fetchLeaveReportFilters = async (): Promise<LeaveReportFilterOptions> => {
  const { data } = await apiClient.get<LeaveReportFilterOptions>(
    '/reports/employee-leave/filters',
  );
  return data;
};

export const fetchEmployeeLeaveReport = async (
  params: EmployeeLeaveReportParams & { page?: number; page_size?: number },
): Promise<EmployeeLeaveReportResponse> => {
  const { data } = await apiClient.get<EmployeeLeaveReportResponse>(
    '/reports/employee-leave',
    { params: cleanParams(params), paramsSerializer: repeatArrays },
  );
  return data;
};

export const fetchEmployeeLeaveStatistics = async (
  params: EmployeeLeaveReportParams,
): Promise<EmployeeLeaveStatistics> => {
  const { data } = await apiClient.get<EmployeeLeaveStatistics>(
    '/reports/employee-leave/statistics',
    { params: cleanParams(params), paramsSerializer: repeatArrays },
  );
  return data;
};

export const exportEmployeeLeaveReport = async (
  params: EmployeeLeaveReportParams,
): Promise<Blob> => {
  // The workbook is built row-by-row server side, so it can outrun the client's
  // default 10s timeout on a wide date range — this one request gets its own budget.
  const { data } = await apiClient.get('/reports/employee-leave/export', {
    params: cleanParams(params),
    paramsSerializer: repeatArrays,
    responseType: 'blob',
    timeout: 120000,
  });
  return data;
};
