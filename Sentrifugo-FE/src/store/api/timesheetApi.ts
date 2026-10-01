import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'
import type {
  PaginatedResponse,
  ClientCreate,
  ClientUpdate,
  ClientResponse,
  ProjectCreate,
  ProjectUpdate,
  ProjectResponse,
  TaskCreate,
  TaskUpdate,
  TaskResponse,
  ProjectTaskCreate,
  ProjectTaskUpdate,
  ProjectTaskResponse,
  ResourceAssignmentCreate,
  ResourceAssignmentUpdate,
  ResourceAssignmentResponse,
  WeeklyTimesheetCreate,
  WeeklyTimesheetResponse,
  TimesheetEntriesBulk,
  ManagerDashboardResponse,
  ApprovalActionPayload,
  BulkApprovalPayload,
  BulkRejectPayload,
  TimesheetSettingsResponse,
  SettingsEmploymentType,
  HourSettingsUpdate,
  SubmissionSettingsUpdate,
  ApprovalSettingsUpdate,
  ProjectSummaryItem,
  EmployeeSummaryItem,
  TimelineEntry,
  TimesheetStatus,
  TimesheetSummaryResponse,
  EntityStatus,
  EmployeeDetailResponse,
  TimesheetDetailResponse,
  TimesheetLeave,
  TimesheetHoliday,
  ClientDashboardResponse,
  ClientTimesheetItem,
  ClientTimesheetDetailResponse,
  ActivityHistoryResponse,
  ProjectHeadCreate,
  ProjectHeadUpdate,
  ProjectHeadResponse,
  AvailableProjectHeadsResponse,
  ProjectHeadBulkAssign,
  ProjectHeadBulkAssignResponse,
  PastSubmissionOverride,
} from '@/types/timesheet'

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string

// ─── Monthly bucket types (returned by GET /approvals/timesheets) ──────────

export interface WeekSummaryItem {
  id: string
  week_start_date: string
  week_end_date: string
  total_hours: number
  submitted_at: string | null
  timesheet_status: TimesheetStatus
}

export interface MonthlyTimesheetBucket {
  user_id: string
  user_name: string | null
  emp_code: string | null
  year: number
  month: number
  month_label: string
  period_start: string
  period_end: string
  total_hours: number
  week_count: number
  timesheet_status: TimesheetStatus
  status_counts: Partial<Record<string, number>>
  weeks: WeekSummaryItem[]
}

export interface MonthlyTimesheetDetailResponse extends Omit<MonthlyTimesheetBucket, 'weeks'> {
  weeks: TimesheetDetailResponse[]
  /**
   * Same meaning as on the weekly detail — resolved approver-scope-first, so a
   * shared project stays actionable. Nothing renders this today (the month row
   * uses it only for the Excel / PDF export, which works either way), but it's
   * here so anything that later shows this payload gates on the field rather
   * than inventing a second rule.
   */
  read_only?: boolean
  /**
   * Whether this caller may reopen this employee-month. THE authoritative one
   * for the reopen button: the month is explicit in the request, so nothing is
   * inferred from whichever week happens to be open.
   *
   * Entitlement, not state — true even for a month already reopened.
   */
  can_reopen?: boolean
  /** The month the flag is about, echoed back. */
  reopen_period?: { year: number; month: number } | null
}

/**
 * GET /approvals/timesheets, which carries one field beyond a plain page.
 *
 * `read_only` is present on every response including empty ones, so the screen
 * can decide about action affordances before it has any rows. Read it rather
 * than inferring from the selected scope: the two always agree, and one source
 * of truth cannot drift from itself.
 *
 * It's a UI hint, not the enforcement. Approve and reject resolve the caller's
 * own approver scope server-side and never consult the reporting line, so a
 * hand-made POST against a view-only row comes back TSM-010 either way.
 */
export interface TeamTimesheetsResponse
  extends PaginatedResponse<MonthlyTimesheetBucket> {
  read_only: boolean
}

// ─── Client portal monthly buckets (GET /client-portal/timesheets) ─────────

export interface ClientWeekSummaryItem extends WeekSummaryItem {
  client_approval_required: boolean
  project_name?: string | null
}

export interface ClientMonthlyBucket extends Omit<MonthlyTimesheetBucket, 'weeks'> {
  project_name?: string | null
  weeks: ClientWeekSummaryItem[]
}

export interface ValidateRow {
  row: number
  status: 'new' | 'existing' | 'error'
  reason: string | null
  data: Record<string, string>
}

export interface ValidateResponse {
  total: number
  rows: ValidateRow[]
}

export interface ProjectsValidateResponse extends ValidateResponse {
  task_total?: number
  task_rows?: ValidateRow[]
}

// Same payloads the approval detail carries — one definition, in types/timesheet
export type TeamResourceLeave = TimesheetLeave
export type TeamResourceHoliday = TimesheetHoliday

export interface TeamResourceEntry {
  user_id: string
  name: string
  emp_code: string
  leaves: TeamResourceLeave[]
  holidays: TeamResourceHoliday[]
}

// ─── Employee Dashboard (today + this week) ────────────────────

export interface TimesheetDashboardDay {
  date: string
  label: string
  weekday: number
  hours: number
  status: 'filled' | 'partial' | 'missing' | 'today' | 'future' | 'weekend'
}

export interface TimesheetDashboardResponse {
  today: {
    date: string
    logged_hours: number
    target_hours: number
    last_entry_at: string | null
  }
  week: {
    week_start_date: string
    days: TimesheetDashboardDay[]
    filled_days: number
    expected_days: number
    total_hours: number
    timesheet_id: string | null
    status: TimesheetStatus | null
  }
  streak_weeks: number
}

// ─── Org (admin) timesheet compliance ──────────────────────────

export interface OrgTimesheetCompliance {
  week_start_date: string
  submitted_users: number
  total_timesheets: number
  by_status: Record<string, number>
}

export const timesheetApi = createApi({
  reducerPath: 'timesheetApi',
  baseQuery: createBaseQuery(TIMESHEET_BASE_URL),
  tagTypes: [
    'Client',
    'Project',
    'Task',
    'ProjectTask',
    'Resource',
    'Timesheet',
    'TimesheetEntry',
    'ApprovalDashboard',
    'TimesheetSettings',
    'Report',
    'ProjectHead',
    'PastSubmissionOverride',
  ],
  endpoints: (builder) => ({
    // ─── Clients ──────────────────────────────────────────────

    getClients: builder.query<
      PaginatedResponse<ClientResponse>,
      { page?: number; page_size?: number; q?: string; status?: string }
    >({
      query: (params) => ({ url: '/clients', params }),
      providesTags: ['Client'],
    }),

    getClient: builder.query<ClientResponse, string>({
      query: (id) => `/clients/${id}`,
      providesTags: ['Client'],
    }),

    createClient: builder.mutation<ClientResponse, ClientCreate>({
      query: (body) => ({ url: '/clients', method: 'POST', body }),
      invalidatesTags: ['Client'],
    }),

    updateClient: builder.mutation<ClientResponse, { id: string; body: ClientUpdate }>({
      query: ({ id, body }) => ({ url: `/clients/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Client'],
    }),

    deleteClient: builder.mutation<void, string>({
      query: (id) => ({ url: `/clients/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Client'],
    }),

    importClients: builder.mutation<
      { total: number; created: number; errors: { row: number; error: string }[] },
      FormData
    >({
      query: (formData) => ({ url: '/clients/import', method: 'POST', body: formData }),
      invalidatesTags: ['Client'],
    }),

    validateClients: builder.mutation<ValidateResponse, FormData>({
      query: (formData) => ({ url: '/clients/validate', method: 'POST', body: formData }),
    }),

    // ─── Projects ─────────────────────────────────────────────

    getProjects: builder.query<
      PaginatedResponse<ProjectResponse>,
      {
        page?: number
        page_size?: number
        q?: string
        status?: string
        client_id?: string
        project_type?: string
      }
    >({
      query: (params) => ({ url: '/projects', params }),
      providesTags: ['Project'],
    }),

    getProject: builder.query<ProjectResponse, string>({
      query: (id) => `/projects/${id}`,
      providesTags: ['Project'],
    }),

    // Backend-generated, org-unique project code derived from the name
    generateProjectCode: builder.query<{ code: string }, string>({
      query: (name) => ({ url: '/projects/generate-code', params: { name } }),
    }),

    createProject: builder.mutation<ProjectResponse, ProjectCreate>({
      query: (body) => ({ url: '/projects', method: 'POST', body }),
      invalidatesTags: ['Project'],
    }),

    updateProject: builder.mutation<ProjectResponse, { id: string; body: ProjectUpdate }>({
      query: ({ id, body }) => ({ url: `/projects/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Project'],
    }),

    deleteProject: builder.mutation<void, string>({
      query: (id) => ({ url: `/projects/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Project'],
    }),

    importProjects: builder.mutation<
      { total: number; created: number; errors: { row: number; error: string }[] },
      FormData
    >({
      query: (formData) => ({ url: '/projects/import', method: 'POST', body: formData }),
      invalidatesTags: ['Project'],
    }),

    validateProjects: builder.mutation<ProjectsValidateResponse, FormData>({
      query: (formData) => ({ url: '/projects/validate', method: 'POST', body: formData }),
    }),

    // ─── Tasks ────────────────────────────────────────────────

    // Shared (organisation-level) tasks only. Pass project_id to also get the
    // tasks that project owns; other projects' own tasks are never returned.
    getTasks: builder.query<
      PaginatedResponse<TaskResponse>,
      { page?: number; page_size?: number; q?: string; status?: string; is_global?: boolean; is_frequent?: boolean; project_id?: string }
    >({
      query: (params) => ({ url: '/tasks', params }),
      providesTags: ['Task'],
    }),

    getTask: builder.query<TaskResponse, string>({
      query: (id) => `/tasks/${id}`,
      providesTags: ['Task'],
    }),

    createTask: builder.mutation<TaskResponse, TaskCreate>({
      query: (body) => ({ url: '/tasks', method: 'POST', body }),
      invalidatesTags: ['Task'],
    }),

    updateTask: builder.mutation<TaskResponse, { id: string; body: TaskUpdate }>({
      query: ({ id, body }) => ({ url: `/tasks/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Task'],
    }),

    deleteTask: builder.mutation<void, string>({
      query: (id) => ({ url: `/tasks/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Task'],
    }),

    importTasks: builder.mutation<
      { total: number; created: number; errors: { row: number; error: string }[] },
      { formData: FormData; projectId?: string }
    >({
      query: ({ formData, projectId }) => ({
        url: '/tasks/import',
        method: 'POST',
        body: formData,
        params: projectId ? { project_id: projectId } : undefined,
      }),
      invalidatesTags: ['Task', 'ProjectTask'],
    }),

    validateTasks: builder.mutation<ValidateResponse, { formData: FormData; projectId?: string }>({
      query: ({ formData, projectId }) => ({
        url: projectId ? `/tasks/validate/${projectId}` : '/tasks/validate',
        method: 'POST',
        body: formData,
      }),
    }),

    // ─── Project Tasks ────────────────────────────────────────

    getProjectTasks: builder.query<ProjectTaskResponse[], { projectId: string; q?: string }>({
      query: ({ projectId, q }) => ({
        url: `/projects/${projectId}/tasks`,
        params: q ? { q } : undefined,
      }),
      providesTags: ['ProjectTask'],
    }),

    // Creates a project-owned task (send `name`) or links a shared one (send
    // `task_id`) — exactly one, never both. Creating with is_global/is_frequent
    // produces a shared task, so the Task list can change either way.
    assignProjectTask: builder.mutation<ProjectTaskResponse, { projectId: string; body: ProjectTaskCreate }>({
      query: ({ projectId, body }) => ({ url: `/projects/${projectId}/tasks`, method: 'POST', body }),
      invalidatesTags: ['ProjectTask', 'Task'],
    }),

    updateProjectTask: builder.mutation<ProjectTaskResponse, { projectId: string; taskId: string; body: ProjectTaskUpdate }>({
      query: ({ projectId, taskId, body }) => ({ url: `/projects/${projectId}/tasks/${taskId}`, method: 'PUT', body }),
      // Name/flags live on the shared task record, so the task master list is stale too
      invalidatesTags: ['ProjectTask', 'Task'],
    }),

    removeProjectTask: builder.mutation<void, { projectId: string; taskId: string }>({
      query: ({ projectId, taskId }) => ({ url: `/projects/${projectId}/tasks/${taskId}`, method: 'DELETE' }),
      invalidatesTags: ['ProjectTask'],
    }),

    // ─── Resources ────────────────────────────────────────────

    getProjectResources: builder.query<
      PaginatedResponse<ResourceAssignmentResponse>,
      // active_on=YYYY-MM-DD narrows to allocations live that day; omitted
      // returns everything including removed rows
      { projectId: string; page?: number; page_size?: number; active_on?: string }
    >({
      query: ({ projectId, ...params }) => ({ url: `/projects/${projectId}/resources`, params }),
      providesTags: ['Resource'],
    }),

    // Returns one entry per task (a single entry with task_id: null when the
    // assignment is project level) — always an array, never a single object.
    createResource: builder.mutation<ResourceAssignmentResponse[], { projectId: string; taskId?: string; body: ResourceAssignmentCreate }>({
      query: ({ projectId, taskId, body }) => ({
        url: taskId ? `/projects/${projectId}/tasks/${taskId}/resources` : `/projects/${projectId}/resources`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Resource'],
    }),

    // Returns the employee's full live assignment set for the project after the
    // edit. Refetched rather than patched in — the server decides row order.
    updateResource: builder.mutation<ResourceAssignmentResponse[], { projectId: string; resourceId: string; body: ResourceAssignmentUpdate }>({
      query: ({ projectId, resourceId, body }) => ({ url: `/projects/${projectId}/resources/${resourceId}`, method: 'PUT', body }),
      invalidatesTags: ['Resource'],
    }),

    // Closes the allocation on end_date rather than deleting it — the row stays
    // in the list, marked removed. Both fields are mandatory; omitting end_date
    // is a 422. Removal covers the employee's whole allocation on the project,
    // not just the task row the id points at.
    deleteResource: builder.mutation<void, { projectId: string; resourceId: string; comment: string; end_date: string }>({
      query: ({ projectId, resourceId, comment, end_date }) => ({
        url: `/projects/${projectId}/resources/${resourceId}`,
        method: 'DELETE',
        body: { comment, end_date },
      }),
      invalidatesTags: ['Resource'],
    }),

    // ─── My Timesheets (Employee) ─────────────────────────────

    getMyTimesheetSummary: builder.query<TimesheetSummaryResponse, void>({
      query: () => '/my-timesheets/summary',
      providesTags: ['Timesheet'],
    }),

    getMyTimesheetDashboard: builder.query<TimesheetDashboardResponse, void>({
      query: () => '/my-timesheets/dashboard',
      providesTags: ['Timesheet'],
    }),

    getOrgTimesheetCompliance: builder.query<OrgTimesheetCompliance, void>({
      query: () => '/org/timesheet-compliance',
      providesTags: ['Timesheet'],
    }),

    getMyTimesheets: builder.query<
      PaginatedResponse<WeeklyTimesheetResponse>,
      { page?: number; page_size?: number; timesheet_status?: TimesheetStatus }
    >({
      query: (params) => ({ url: '/my-timesheets', params }),
      providesTags: ['Timesheet'],
    }),

    getMyAssignedProjects: builder.query<{ id: string; name: string; code: string | null; client_id: string | null; client_name: string | null; project_status?: string; status?: string; tasks: { task_id: string; task_name: string; is_frequent?: boolean }[] }[], void>({
      query: () => '/my-timesheets/assigned-projects',
      providesTags: ['Project'],
    }),

    getMyAssignedProjectTasks: builder.query<{ task_id: string; task_name: string; is_frequent?: boolean }[], string>({
      query: (projectId) => `/my-timesheets/assigned-projects/${projectId}/tasks`,
      providesTags: ['ProjectTask'],
    }),

    getMyTimesheet: builder.query<WeeklyTimesheetResponse, string>({
      query: (id) => `/my-timesheets/${id}`,
      providesTags: ['Timesheet'],
    }),

    createTimesheet: builder.mutation<WeeklyTimesheetResponse, WeeklyTimesheetCreate>({
      query: (body) => ({ url: '/my-timesheets', method: 'POST', body }),
      invalidatesTags: ['Timesheet'],
    }),

    saveTimesheetEntries: builder.mutation<WeeklyTimesheetResponse, { id: string; body: TimesheetEntriesBulk }>({
      query: ({ id, body }) => ({ url: `/my-timesheets/${id}/entries`, method: 'POST', body }),
      invalidatesTags: ['Timesheet', 'TimesheetEntry'],
    }),

    deleteTimesheetEntry: builder.mutation<void, { timesheetId: string; entryId: string }>({
      query: ({ timesheetId, entryId }) => ({ url: `/my-timesheets/${timesheetId}/entries/${entryId}`, method: 'DELETE' }),
      invalidatesTags: ['Timesheet', 'TimesheetEntry'],
    }),

    submitTimesheet: builder.mutation<WeeklyTimesheetResponse, string>({
      query: (id) => ({ url: `/my-timesheets/${id}/submit`, method: 'POST' }),
      invalidatesTags: ['Timesheet'],
    }),

    resubmitTimesheet: builder.mutation<WeeklyTimesheetResponse, string>({
      query: (id) => ({ url: `/my-timesheets/${id}/resubmit`, method: 'POST' }),
      invalidatesTags: ['Timesheet'],
    }),

    // ─── Manager Approvals ────────────────────────────────────

    getApprovalDashboard: builder.query<
      ManagerDashboardResponse,
      { month?: number; year?: number } | void
    >({
      query: (params) => ({ url: '/approvals/dashboard', params: params ?? {} }),
      providesTags: ['ApprovalDashboard'],
    }),

    getTeamTimesheets: builder.query<
      TeamTimesheetsResponse,
      {
        /**
         * `own` (default) — employees this user approves, via a manager-role
         * assignment or by heading the project. Actionable.
         *
         * `reporting` — employees on projects headed by this user's direct L1
         * and L2 reports. One hop only, view-only, and it never overrides
         * business-unit scoping. The two can overlap; a row in both is
         * actionable under `own` and read-only here.
         */
        scope?: 'own' | 'reporting'
        page?: number
        page_size?: number
        /** Exact stored status. Unrelated to `status_filter` below. */
        timesheet_status?: TimesheetStatus
        /**
         * Grouped status, applied BEFORE pagination — which is the point of it.
         * The dashboard chips used to filter the current page client-side, so
         * `total` described the unfiltered set and pages came back short.
         *
         * `not_submitted` is its own bucket, never folded into `pending`: it's
         * a week with no timesheet at all, derived at read time rather than
         * stored. Anything outside these five is a 422.
         */
        status_filter?: 'all' | 'pending' | 'approved' | 'rejected' | 'not_submitted'
        user_id?: string
        month?: number
        year?: number
        search?: string
      }
    >({
      query: (params) => ({ url: '/approvals/timesheets', params }),
      providesTags: ['Timesheet'],
    }),

    getMonthlyTimesheetDetail: builder.query<
      MonthlyTimesheetDetailResponse,
      { user_id: string; month: number; year: number }
    >({
      query: (params) => ({ url: '/approvals/timesheets/monthly', params }),
      providesTags: ['Timesheet'],
    }),

    getTeamTimesheet: builder.query<TimesheetDetailResponse, string>({
      query: (id) => `/approvals/timesheets/${id}`,
      providesTags: ['Timesheet'],
    }),

    exportTimesheetExcel: builder.query<Blob, string>({
      query: (id) => ({
        url: `/approvals/timesheets/${id}/export/excel`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    exportTimesheetPdf: builder.query<Blob, string>({
      query: (id) => ({
        url: `/approvals/timesheets/${id}/export/pdf`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    getEmployeeDetail: builder.query<EmployeeDetailResponse, string>({
      query: (userId) => `/approvals/employees/${userId}`,
      providesTags: ['Timesheet'],
    }),

    getEmployeeTimesheets: builder.query<
      PaginatedResponse<WeeklyTimesheetResponse>,
      { userId: string; page?: number; page_size?: number }
    >({
      query: ({ userId, ...params }) => ({ url: `/approvals/employees/${userId}/timesheets`, params }),
      providesTags: ['Timesheet'],
    }),

    approveTimesheet: builder.mutation<WeeklyTimesheetResponse, { id: string; body: ApprovalActionPayload }>({
      query: ({ id, body }) => ({ url: `/approvals/timesheets/${id}/approve`, method: 'POST', body }),
      invalidatesTags: ['Timesheet', 'ApprovalDashboard'],
    }),

    rejectTimesheet: builder.mutation<WeeklyTimesheetResponse, { id: string; body: { comments: string } }>({
      query: ({ id, body }) => ({ url: `/approvals/timesheets/${id}/reject`, method: 'POST', body }),
      invalidatesTags: ['Timesheet', 'ApprovalDashboard'],
    }),

    bulkApproveTimesheets: builder.mutation<WeeklyTimesheetResponse[], BulkApprovalPayload>({
      query: (body) => ({ url: '/approvals/bulk-approve', method: 'POST', body }),
      invalidatesTags: ['Timesheet', 'ApprovalDashboard'],
    }),

    bulkRejectTimesheets: builder.mutation<WeeklyTimesheetResponse[], BulkRejectPayload>({
      query: (body) => ({ url: '/approvals/bulk-reject', method: 'POST', body }),
      invalidatesTags: ['Timesheet', 'ApprovalDashboard'],
    }),

    // ─── Client Portal ────────────────────────────────────────

    getClientDashboard: builder.query<ClientDashboardResponse, void>({
      query: () => '/client-portal/dashboard',
      providesTags: ['Timesheet'],
    }),

    getClientTimesheets: builder.query<
      PaginatedResponse<ClientMonthlyBucket>,
      { page?: number; page_size?: number; timesheet_status?: string; project_id?: string; month?: number; year?: number; search?: string; week_start?: string; week_end?: string }
    >({
      query: (params) => ({ url: '/client-portal/timesheets', params }),
      providesTags: ['Timesheet'],
    }),

    getClientMonthlyDetail: builder.query<
      MonthlyTimesheetDetailResponse,
      { user_id: string; month: number; year: number }
    >({
      query: (params) => ({ url: '/client-portal/timesheets/monthly', params }),
      providesTags: ['Timesheet'],
    }),

    getClientTimesheet: builder.query<ClientTimesheetDetailResponse, string>({
      query: (id) => `/client-portal/timesheets/${id}`,
      providesTags: ['Timesheet'],
    }),

    exportClientReviewExcel: builder.query<Blob, {
      timesheet_status?: string; search?: string; week_start?: string; week_end?: string
    }>({
      query: (params) => ({
        url: '/client-portal/timesheets/export/excel',
        params,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    exportClientTimesheetExcel: builder.query<Blob, string>({
      query: (id) => ({
        url: `/client-portal/timesheets/${id}/export/excel`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    exportClientTimesheetPdf: builder.query<Blob, string>({
      query: (id) => ({
        url: `/client-portal/timesheets/${id}/export/pdf`,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    getClientActivityHistory: builder.query<
      ActivityHistoryResponse,
      { page?: number; page_size?: number; search?: string; start_date?: string; end_date?: string; actor?: string }
    >({
      query: (params) => ({ url: '/client-portal/activity-history', params }),
      providesTags: ['Timesheet'],
    }),

    exportActivityHistoryExcel: builder.query<Blob, {
      search?: string; start_date?: string; end_date?: string; actor?: string
    }>({
      query: (params) => ({
        url: '/client-portal/activity-history/export/excel',
        params,
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    exportActivityFullReport: builder.query<Blob, void>({
      query: () => ({
        url: '/client-portal/activity-history/full-report',
        responseHandler: (response: Response) => response.blob(),
      }),
    }),

    clientApproveTimesheet: builder.mutation<WeeklyTimesheetResponse, { id: string; body: ApprovalActionPayload }>({
      query: ({ id, body }) => ({ url: `/client-portal/timesheets/${id}/approve`, method: 'POST', body }),
      invalidatesTags: ['Timesheet'],
    }),

    clientRejectTimesheet: builder.mutation<WeeklyTimesheetResponse, { id: string; body: { comments: string } }>({
      query: ({ id, body }) => ({ url: `/client-portal/timesheets/${id}/reject`, method: 'POST', body }),
      invalidatesTags: ['Timesheet'],
    }),

    clientBulkApprove: builder.mutation<WeeklyTimesheetResponse[], BulkApprovalPayload>({
      query: (body) => ({ url: '/client-portal/bulk-approve', method: 'POST', body }),
      invalidatesTags: ['Timesheet'],
    }),

    clientBulkReject: builder.mutation<WeeklyTimesheetResponse[], BulkRejectPayload>({
      query: (body) => ({ url: '/client-portal/bulk-reject', method: 'POST', body }),
      invalidatesTags: ['Timesheet'],
    }),

    // ─── Settings ─────────────────────────────────────────────

    getTimesheetSettings: builder.query<TimesheetSettingsResponse, void>({
      query: () => '/settings',
      providesTags: ['TimesheetSettings'],
    }),

    /**
     * The past-submission cutoff, for screens that need to know whether a month
     * is closed without being entitled to read settings.
     *
     * Lives under /approvals, not /settings: the settings router is gated on
     * `manage_settings` at the router level, and Team Timesheets is gated on
     * `manage_timesheet`. Reading the whole settings document from there 403'd
     * for exactly the managers the reopen affordance is meant for.
     *
     * `cutoff_day` is never null — an org that has never configured settings
     * reads back `{ enabled: false, cutoff_day: 25 }` — and it stays populated
     * when `enabled` is false, since it's the day the rule WOULD apply. Branch
     * on `enabled`, never on the day being present.
     *
     * Unlike GET /settings this does not create a settings document on first
     * read, so opening the screen writes nothing.
     */
    getPastSubmissionCutoff: builder.query<
      { enabled: boolean; cutoff_day: number },
      void
    >({
      query: () => '/approvals/past-submission-cutoff',
      // Same underlying record as GET /settings, so a settings save refreshes
      // this too.
      providesTags: ['TimesheetSettings'],
    }),

    updateHourSettings: builder.mutation<TimesheetSettingsResponse, HourSettingsUpdate>({
      query: (body) => ({ url: '/settings/hours', method: 'PUT', body }),
      invalidatesTags: ['TimesheetSettings'],
    }),

    updateSubmissionSettings: builder.mutation<TimesheetSettingsResponse, SubmissionSettingsUpdate>({
      query: (body) => ({ url: '/settings/submission', method: 'PUT', body }),
      invalidatesTags: ['TimesheetSettings'],
    }),

    updateApprovalSettings: builder.mutation<TimesheetSettingsResponse, ApprovalSettingsUpdate>({
      query: (body) => ({ url: '/settings/approval', method: 'PUT', body }),
      invalidatesTags: ['TimesheetSettings'],
    }),

    // Employment types for the notification-exclusion picker: built-ins plus
    // the org's active custom types. The same rows are in IAM's master data,
    // but this one arrives already filtered to is_active and to the org, behind
    // the same manage_settings permission as the rest of the screen.
    getSettingsEmploymentTypes: builder.query<SettingsEmploymentType[], void>({
      query: () => '/settings/employment-types',
      providesTags: ['TimesheetSettings'],
    }),

    // ─── Reports ──────────────────────────────────────────────

    getProjectSummaryReport: builder.query<ProjectSummaryItem[], { client_id?: string }>({
      query: (params) => ({ url: '/reports/project-summary', params }),
      providesTags: ['Report'],
    }),

    getEmployeeSummaryReport: builder.query<EmployeeSummaryItem[], { project_id?: string }>({
      query: (params) => ({ url: '/reports/employee-summary', params }),
      providesTags: ['Report'],
    }),

    // ─── Client Project Heads ─────────────────────────────────

    getProjectHeads: builder.query<
      PaginatedResponse<ProjectHeadResponse>,
      { client_id?: string; page?: number; page_size?: number; search?: string }
    >({
      query: (params) => ({ url: '/client-project-heads', params }),
      providesTags: ['ProjectHead'],
    }),

    getProjectHead: builder.query<ProjectHeadResponse, string>({
      query: (id) => `/client-project-heads/${id}`,
      providesTags: ['ProjectHead'],
    }),

    // Assignable for `client_id`, in two groups (employees scoped by the client's
    // BU AND department; deduped external heads). Anyone already heading that
    // client is excluded from both, so a pick can never collide.
    getAvailableProjectHeads: builder.query<
      AvailableProjectHeadsResponse,
      { client_id: string }
    >({
      query: (params) => ({ url: '/client-project-heads/available', params }),
      providesTags: ['ProjectHead'],
    }),

    // Multi-select save. Already-assigned people are skipped, not rejected.
    bulkAssignProjectHeads: builder.mutation<
      ProjectHeadBulkAssignResponse,
      ProjectHeadBulkAssign
    >({
      query: (body) => ({
        url: '/client-project-heads/bulk-assign',
        method: 'POST',
        body,
      }),
      invalidatesTags: ['ProjectHead'],
    }),

    createProjectHead: builder.mutation<ProjectHeadResponse, ProjectHeadCreate>({
      query: (body) => ({ url: '/client-project-heads', method: 'POST', body }),
      invalidatesTags: ['ProjectHead'],
    }),

    updateProjectHead: builder.mutation<ProjectHeadResponse, { id: string; body: ProjectHeadUpdate }>({
      query: ({ id, body }) => ({ url: `/client-project-heads/${id}`, method: 'PUT', body }),
      invalidatesTags: ['ProjectHead'],
    }),

    deleteProjectHead: builder.mutation<void, string>({
      query: (id) => ({ url: `/client-project-heads/${id}`, method: 'DELETE' }),
      invalidatesTags: ['ProjectHead'],
    }),

    // ─── Analytics ─────────────────────────────────────────────

    getEmployeeAnalytics: builder.query<
      Record<string, unknown>,
      { cal_month?: number; cal_year?: number } | void
    >({
      query: (params) => ({ url: '/analytics/employee/descriptive', params: params ?? {} }),
    }),

    getManagerAnalytics: builder.query<Record<string, unknown>, void>({
      query: () => '/analytics/manager/descriptive',
    }),

    getHRAnalytics: builder.query<Record<string, unknown>, { bu?: string } | void>({
      query: (params) => ({ url: '/analytics/hr/descriptive', params: params ?? {} }),
    }),

    getCFOAnalytics: builder.query<Record<string, unknown>, { bu?: string } | void>({
      query: (params) => ({ url: '/analytics/cfo/descriptive', params: params ?? {} }),
    }),

    getMDAnalytics: builder.query<Record<string, unknown>, void>({
      query: () => '/analytics/md/descriptive',
    }),

    // ─── Timeline ────────────────────────────────────────────

    getProjectTimeline: builder.query<TimelineEntry[], { projectId: string; limit?: number }>({
      query: ({ projectId, limit }) => ({
        url: `/projects/${projectId}/timeline`,
        params: { ...(limit ? { limit } : {}) },
      }),
    }),

    getTeamResources: builder.query<TeamResourceEntry[], { from_date: string; to_date: string }>({
      query: ({ from_date, to_date }) => ({ url: '/approvals/team-resources', params: { from_date, to_date } }),
    }),

    // ─── Past-submission overrides (reopen a closed month) ────
    // Require manage_projects AND admin / project head / owner — anyone else
    // gets 403, so gate the UI on the same conditions.

    /**
     * Every live grant reopening this employee's months — from ANY manager, not
     * just the caller. That matters: two managers can each reopen the same
     * month for their own projects, and the employee refiles against the union.
     * Render them as separate rows, never as one on/off state.
     *
     * Gated on `manage_timesheet`, the grant that opens Team Timesheets — not
     * `manage_projects`. Reopening is a decision about a person's late month.
     */
    getEmployeePastSubmissionOverrides: builder.query<
      PastSubmissionOverride[],
      string
    >({
      query: (userId) => `/approvals/employees/${userId}/past-submission-overrides`,
      providesTags: ['PastSubmissionOverride'],
    }),

    /**
     * Reopens one month for one employee, on the CALLER's projects only.
     *
     * Safe to call twice — a repeat refreshes the caller's project snapshot,
     * which is what you want if they have since picked up another project.
     */
    createEmployeePastSubmissionOverride: builder.mutation<
      PastSubmissionOverride,
      { userId: string; year: number; month: number; reason?: string | null }
    >({
      query: ({ userId, ...body }) => ({
        url: `/approvals/employees/${userId}/past-submission-overrides`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['PastSubmissionOverride', 'Timesheet'],
    }),

    /** Removes only the CALLER's grant; other managers' grants survive. */
    deleteEmployeePastSubmissionOverride: builder.mutation<
      void,
      { userId: string; year: number; month: number }
    >({
      query: ({ userId, year, month }) => ({
        url: `/approvals/employees/${userId}/past-submission-overrides/${year}/${month}`,
        method: 'DELETE',
      }),
      invalidatesTags: ['PastSubmissionOverride', 'Timesheet'],
    }),
  }),
})

export const {
  // Clients
  useGetClientsQuery,
  useGetClientQuery,
  useCreateClientMutation,
  useUpdateClientMutation,
  useDeleteClientMutation,
  useImportClientsMutation,
  useValidateClientsMutation,
  // Projects
  useGetProjectsQuery,
  useGetProjectQuery,
  useLazyGenerateProjectCodeQuery,
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useDeleteProjectMutation,
  useImportProjectsMutation,
  useValidateProjectsMutation,
  // Tasks
  useGetTasksQuery,
  useGetTaskQuery,
  useCreateTaskMutation,
  useUpdateTaskMutation,
  useDeleteTaskMutation,
  useImportTasksMutation,
  useValidateTasksMutation,
  // Project Tasks
  useGetProjectTasksQuery,
  useAssignProjectTaskMutation,
  useUpdateProjectTaskMutation,
  useRemoveProjectTaskMutation,
  // Resources
  useGetProjectResourcesQuery,
  useCreateResourceMutation,
  useUpdateResourceMutation,
  useDeleteResourceMutation,
  // My Timesheets
  useGetMyTimesheetSummaryQuery,
  useGetMyTimesheetDashboardQuery,
  useGetOrgTimesheetComplianceQuery,
  useGetMyTimesheetsQuery,
  useGetMyAssignedProjectsQuery,
  useGetMyAssignedProjectTasksQuery,
  useGetMyTimesheetQuery,
  useCreateTimesheetMutation,
  useSaveTimesheetEntriesMutation,
  useDeleteTimesheetEntryMutation,
  useSubmitTimesheetMutation,
  useResubmitTimesheetMutation,
  // Manager Approvals
  useGetApprovalDashboardQuery,
  useGetTeamTimesheetsQuery,
  useGetTeamTimesheetQuery,
  useGetEmployeeDetailQuery,
  useGetEmployeeTimesheetsQuery,
  useLazyExportTimesheetExcelQuery,
  useLazyExportTimesheetPdfQuery,
  useApproveTimesheetMutation,
  useRejectTimesheetMutation,
  useBulkApproveTimesheetsMutation,
  useBulkRejectTimesheetsMutation,
  // Client Portal
  useGetClientDashboardQuery,
  useGetClientTimesheetsQuery,
  useGetClientMonthlyDetailQuery,
  useGetClientTimesheetQuery,
  useLazyExportClientReviewExcelQuery,
  useLazyExportClientTimesheetExcelQuery,
  useLazyExportClientTimesheetPdfQuery,
  useGetClientActivityHistoryQuery,
  useLazyExportActivityHistoryExcelQuery,
  useLazyExportActivityFullReportQuery,
  useClientApproveTimesheetMutation,
  useClientRejectTimesheetMutation,
  useClientBulkApproveMutation,
  useClientBulkRejectMutation,
  // Settings
  useGetTimesheetSettingsQuery,
  useGetPastSubmissionCutoffQuery,
  useUpdateHourSettingsMutation,
  useUpdateSubmissionSettingsMutation,
  useUpdateApprovalSettingsMutation,
  useGetSettingsEmploymentTypesQuery,
  // Reports
  useGetProjectSummaryReportQuery,
  useGetEmployeeSummaryReportQuery,
  // Timeline
  useGetProjectTimelineQuery,
  // Client Project Heads
  useGetProjectHeadsQuery,
  useGetProjectHeadQuery,
  useGetAvailableProjectHeadsQuery,
  useBulkAssignProjectHeadsMutation,
  useCreateProjectHeadMutation,
  useUpdateProjectHeadMutation,
  useDeleteProjectHeadMutation,
  // Team Resources (leaves & holidays for manager calendar)
  useGetTeamResourcesQuery,
  // Past-submission overrides
  useGetEmployeePastSubmissionOverridesQuery,
  useCreateEmployeePastSubmissionOverrideMutation,
  useDeleteEmployeePastSubmissionOverrideMutation,
  // Monthly detail
  useGetMonthlyTimesheetDetailQuery,
  // Analytics
  useGetEmployeeAnalyticsQuery,
  useGetManagerAnalyticsQuery,
  useGetHRAnalyticsQuery,
  useGetCFOAnalyticsQuery,
  useGetMDAnalyticsQuery,
} = timesheetApi
