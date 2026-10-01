import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'
import type { RootState } from '@/store'
import type {
  Category,
  CategoryFormData,
  PaginatedResponse,
  RequestType,
  RequestTypeListItem,
  RequestTypeFormData,
  WorkflowListItem,
  WorkflowDetail,
  WorkflowCreatePayload,
  ApprovalCounts,
  RequestListItem,
  RequestListParams,
  RaiseRequestPayload,
  DashboardSummary,
  CommentItem,
  RequestDetail,
  Department,
  Employee,
  MeResponse,
} from '@/types/service-request'

const SRM_BASE_URL = import.meta.env.VITE_SRM_API_BASE_URL as string

// ─── Analytics (role dashboards) — generic envelope from /analytics/* ────────
export interface AnalyticsCard {
  id: string
  label: string
  value: number | string
  sub_label?: string | null
  intent: 'neutral' | 'good' | 'warning' | 'critical'
  filter?: Record<string, unknown>
}
export interface AnalyticsChartSeries {
  name: string
  data: number[]
}
export interface AnalyticsChart {
  id: string
  title: string
  type: 'doughnut' | 'bar' | 'line'
  labels: string[]
  series: AnalyticsChartSeries[]
  stacked?: boolean
}
export interface AnalyticsTable {
  id: string
  title: string
  columns: { key: string; label: string; type: string }[]
  rows: Record<string, unknown>[]
}
export interface AnalyticsAlert {
  id: string
  severity: 'info' | 'warning' | 'success' | 'critical'
  title: string
  message: string
}
export interface AnalyticsSection {
  id: string
  title?: string | null
  cards: AnalyticsCard[]
  alerts: AnalyticsAlert[]
  charts: AnalyticsChart[]
  tables: AnalyticsTable[]
}
export interface AnalyticsTab {
  key: 'descriptive' | 'prescriptive' | 'predictive'
  label: string
  sections: AnalyticsSection[]
}
export interface AnalyticsDashboard {
  role: string
  role_label: string
  generated_at: string
  tabs: AnalyticsTab[]
}
export interface AnalyticsRoleInfo {
  role: string
  label: string
}
export interface AnalyticsAvailableRoles {
  roles: AnalyticsRoleInfo[]
  default: string | null
}
export interface BusinessUnitInfo {
  id: string
  name: string
}
export interface BusinessUnitsResponse {
  business_units: BusinessUnitInfo[]
}
export interface BuComparisonResponse {
  charts: AnalyticsChart[]
}

export const srmApi = createApi({
  reducerPath: 'srmApi',
  baseQuery: createBaseQuery(SRM_BASE_URL),
  tagTypes: [
    'Category',
    'RequestType',
    'Workflow',
    'Request',
    'Comment',
    'Note',
    'Dashboard',
    'Executor',
    'EscalationTarget',
    'Department',
    'Employee',
    'Me',
    'PendingApprovals',
  ],
  endpoints: (builder) => ({
    // ─── Categories ───────────────────────────────────────────
    getCategories: builder.query<
      PaginatedResponse<Category>,
      { q?: string; status?: string; department_id?: string; business_unit_id?: string; has_active_workflow?: boolean; page?: number; page_size?: number } | void
    >({
      query: (params) => ({ url: '/categories', params: params ?? {} }),
      providesTags: ['Category'],
    }),

    getCategoryById: builder.query<Category, string>({
      query: (id) => `/categories/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Category', id }],
    }),

    createCategory: builder.mutation<Category, CategoryFormData>({
      query: (body) => ({ url: '/categories', method: 'POST', body }),
      invalidatesTags: ['Category'],
    }),

    updateCategory: builder.mutation<Category, { id: string; body: CategoryFormData }>({
      query: ({ id, body }) => ({ url: `/categories/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { id }) => ['Category', { type: 'Category', id }],
    }),

    deleteCategory: builder.mutation<void, string>({
      query: (id) => ({ url: `/categories/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Category'],
    }),

    toggleCategoryStatus: builder.mutation<Category, { id: string; status: 'active' | 'inactive' }>({
      query: ({ id, status }) => ({
        url: `/categories/${id}/status`,
        method: 'PATCH',
        body: { status },
      }),
      invalidatesTags: ['Category'],
    }),

    // ─── Request Types ─────────────────────────────────────────
    getRequestTypes: builder.query<
      PaginatedResponse<RequestTypeListItem>,
      { q?: string; status?: string; category_id?: string; priority?: string; has_active_workflow?: boolean; page?: number; page_size?: number } | void
    >({
      query: (params) => ({ url: '/request-types', params: params ?? {} }),
      providesTags: ['RequestType'],
    }),

    getRequestTypeById: builder.query<RequestType, string>({
      query: (id) => `/request-types/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'RequestType', id }],
    }),

    createRequestType: builder.mutation<RequestType, RequestTypeFormData>({
      query: (body) => ({ url: '/request-types', method: 'POST', body }),
      invalidatesTags: ['RequestType'],
    }),

    updateRequestType: builder.mutation<RequestType, { id: string; body: RequestTypeFormData }>({
      query: ({ id, body }) => ({ url: `/request-types/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { id }) => ['RequestType', { type: 'RequestType', id }],
    }),

    deleteRequestType: builder.mutation<void, string>({
      query: (id) => ({ url: `/request-types/${id}`, method: 'DELETE' }),
      invalidatesTags: ['RequestType'],
    }),

    // ─── Workflows ─────────────────────────────────────────────
    getWorkflows: builder.query<
      PaginatedResponse<WorkflowListItem>,
      { q?: string; status?: string; category_id?: string; request_type_id?: string; page?: number; page_size?: number } | void
    >({
      query: (params) => ({ url: '/workflows', params: params ?? {} }),
      providesTags: ['Workflow'],
    }),

    getWorkflowById: builder.query<WorkflowDetail, string>({
      query: (id) => `/workflows/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Workflow', id }],
    }),

    createWorkflow: builder.mutation<WorkflowDetail, WorkflowCreatePayload>({
      query: (body) => ({ url: '/workflows', method: 'POST', body }),
      invalidatesTags: ['Workflow'],
    }),

    updateWorkflow: builder.mutation<WorkflowDetail, { id: string; body: WorkflowCreatePayload }>({
      query: ({ id, body }) => ({ url: `/workflows/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, { id }) => ['Workflow', { type: 'Workflow', id }],
    }),

    deleteWorkflow: builder.mutation<void, string>({
      query: (id) => ({ url: `/workflows/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Workflow'],
    }),

    activateWorkflow: builder.mutation<WorkflowDetail, string>({
      query: (id) => ({ url: `/workflows/${id}/activate`, method: 'POST' }),
      invalidatesTags: ['Workflow'],
    }),

    deactivateWorkflow: builder.mutation<WorkflowDetail, string>({
      query: (id) => ({ url: `/workflows/${id}/deactivate`, method: 'POST' }),
      invalidatesTags: ['Workflow'],
    }),

    // ─── Requests ──────────────────────────────────────────────
    getRequests: builder.query<PaginatedResponse<RequestListItem>, RequestListParams | void>({
      query: (params) => ({ url: '/requests', params: params ?? {} }),
      providesTags: ['Request'],
    }),

    getRequestById: builder.query<RequestDetail, string>({
      query: (id) => `/requests/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Request', id }],
    }),

    getRequestActivity: builder.query<
      { items: Array<{ event: string; actor_user_id: string | null; actor_name: string | null; created_on: string; details?: Record<string, unknown> | null }>; total: number },
      string
    >({
      query: (id) => `/requests/${id}/activity`,
      providesTags: (_result, _error, id) => [{ type: 'Request', id }],
    }),

    // One-shot fetch of a fresh signed URL for downloading an attachment.
    // Used as a mutation (not query) so we can trigger on click without
    // caching the (time-limited) URL.
    getAttachmentSignedUrl: builder.mutation<
      { id: string; filename: string; mime_type: string; size_bytes: number; download_url: string; expires_in_seconds: number },
      { requestId: string; attachmentId: string }
    >({
      query: ({ requestId, attachmentId }) => ({
        url: `/requests/${requestId}/attachments/${attachmentId}`,
        method: 'GET',
      }),
    }),

    getPendingApprovals: builder.query<
      PaginatedResponse<RequestListItem>,
      | {
          page?: number
          page_size?: number
          /**
           * `awaiting_me` = rows the caller can act on right now (approver at
           * the ticket's CURRENT level, status pending_approval, not yet decided
           * at that level). `my_team` = the reporting-tree view. Omitted = the
           * union of both.
           *
           * Resolved in Mongo, so `total` and the page slice describe the same
           * set — an actionable ticket can't sit at position 240 of the union
           * and fall off the end.
           */
          scope?: 'awaiting_me' | 'my_team'
          q?: string
          category_id?: string
          request_type_id?: string
          priority?: string
          status?: string
          is_escalated?: boolean
          my_decision?: string
          created_from?: string
        }
      | void
    >({
      query: (params) => ({ url: '/requests/pending-approvals', params: params ?? {} }),
      providesTags: ['PendingApprovals'],
    }),

    // All six stat-card totals in one call. Unfiltered by design — the numbers
    // describe each queue and stay put while the user narrows the table.
    // Replaces one count-only request per card (7 round-trips per load), and
    // walks the reporting tree once rather than six times.
    getApprovalCounts: builder.query<ApprovalCounts, void>({
      query: () => '/requests/pending-approvals/counts',
      providesTags: ['PendingApprovals'],
    }),

    getDashboardSummary: builder.query<DashboardSummary, { my_requests?: boolean } | void>({
      query: (params) => ({ url: '/dashboard/summary', params: params ?? {} }),
      providesTags: ['Dashboard'],
    }),

    // ─── Analytics role dashboards ────────────────────────────
    getSrAnalyticsRoles: builder.query<AnalyticsAvailableRoles, void>({
      query: () => '/analytics/roles',
    }),

    getSrAnalyticsDashboard: builder.query<AnalyticsDashboard, { role: string; businessUnitId?: string }>({
      query: ({ role, businessUnitId }) => ({
        url: '/analytics/dashboard',
        params: { role, ...(businessUnitId ? { business_unit_id: businessUnitId } : {}) },
      }),
    }),

    // CXO business-unit selector (View BU / Compare BUs).
    getSrBusinessUnits: builder.query<BusinessUnitsResponse, void>({
      query: () => '/analytics/business-units',
    }),
    getSrBuComparison: builder.query<BuComparisonResponse, void>({
      query: () => '/analytics/bu-comparison',
    }),

    getRequestComments: builder.query<{ items: CommentItem[]; total: number }, string>({
      query: (id) => `/requests/${id}/comments`,
      providesTags: (_result, _error, id) => [{ type: 'Comment', id }],
    }),

    getRequestNotes: builder.query<{ items: CommentItem[]; total: number }, string>({
      query: (id) => `/requests/${id}/internal-notes`,
      providesTags: (_result, _error, id) => [{ type: 'Note', id }],
    }),

    addComment: builder.mutation<CommentItem, { id: string; body: string }>({
      query: ({ id, body }) => ({
        url: `/requests/${id}/comments`,
        method: 'POST',
        body: { body },
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: 'Comment', id }],
    }),

    addNote: builder.mutation<CommentItem, { id: string; body: string }>({
      query: ({ id, body }) => ({
        url: `/requests/${id}/internal-notes`,
        method: 'POST',
        body: { body },
      }),
      invalidatesTags: (_result, _error, { id }) => [{ type: 'Note', id }],
    }),

    approveRequest: builder.mutation<unknown, { id: string; remarks?: string }>({
      query: ({ id, remarks }) => ({
        url: `/requests/${id}/approve`,
        method: 'POST',
        body: { remarks: remarks ?? '' },
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', 'PendingApprovals', { type: 'Request', id }],
    }),

    rejectRequest: builder.mutation<unknown, { id: string; reason: string }>({
      query: ({ id, reason }) => ({
        url: `/requests/${id}/reject`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', 'PendingApprovals', { type: 'Request', id }],
    }),

    resolveRequest: builder.mutation<unknown, { id: string; resolution_notes: string }>({
      query: ({ id, resolution_notes }) => ({
        url: `/requests/${id}/resolve`,
        method: 'POST',
        body: { resolution_notes },
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', { type: 'Request', id }],
    }),

    closeRequest: builder.mutation<unknown, { id: string; closing_remarks: string }>({
      query: ({ id, closing_remarks }) => ({ url: `/requests/${id}/close`, method: 'POST', body: { closing_remarks } }),
      invalidatesTags: (_result, _error, { id }) => ['Request', { type: 'Request', id }],
    }),

    withdrawRequest: builder.mutation<unknown, { id: string; reason?: string }>({
      query: ({ id, reason }) => ({
        url: `/requests/${id}/withdraw`,
        method: 'POST',
        body: reason ? { reason } : {},
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', { type: 'Request', id }],
    }),

    firstResponse: builder.mutation<unknown, string>({
      query: (id) => ({ url: `/requests/${id}/first-response`, method: 'POST', body: {} }),
      invalidatesTags: (_result, _error, id) => [{ type: 'Request', id }],
    }),

    // Executor triggers L1 approval. L1 = requester's L1 manager (auto-
    // resolved server-side). No body needed.
    submitForApproval: builder.mutation<unknown, string>({
      query: (id) => ({
        url: `/requests/${id}/submit-for-approval`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: (_result, _error, id) => [
        'Request',
        { type: 'Request', id },
      ],
    }),

    // Executor triggers L2 approval after L1 approved. Body may carry an
    // override for the L2 approver (default = requester's L2 manager).
    triggerL2Approval: builder.mutation<
      unknown,
      { id: string; level_2_approver_user_id?: string }
    >({
      query: ({ id, level_2_approver_user_id }) => ({
        url: `/requests/${id}/trigger-l2-approval`,
        method: 'POST',
        body: level_2_approver_user_id ? { level_2_approver_user_id } : {},
      }),
      invalidatesTags: (_result, _error, { id }) => [
        'Request',
        { type: 'Request', id },
      ],
    }),

    // Drives the L2 picker on the trigger-L2 dialog.
    getEligibleL2Approvers: builder.query<
      {
        level_1_approver_user_id: string | null;
        default_l2_user_id: string | null;
        default_l2_name: string | null;
        default_l2_email: string | null;
        candidates: Array<{
          user_id: string;
          name: string;
          email: string;
          designation?: string | null;
          department?: string | null;
        }>;
      },
      string
    >({
      query: (id) => `/requests/${id}/eligible-l2-approvers`,
      providesTags: (_result, _error, id) => [{ type: 'Executor', id }],
    }),

    getEligibleExecutors: builder.query<
      {
        user_id: string
        name: string | null
        email: string | null
        /**
         * This person escalated the ticket away earlier. They are offered
         * again on purpose — the API used to hide them and reject them as a
         * "ping-pong guard", which was permanent, so an executor who escalated
         * once could never be given the ticket back. Handing it back is a
         * normal outcome once the primary has unblocked them; label the row so
         * the choice is informed.
         */
        previously_escalated_by?: boolean
        role?: string | null
        designation?: string | null
        availability?: string
        open_tickets?: number
      }[],
      string
    >({
      query: (id) => `/requests/${id}/eligible-executors`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transformResponse: (res: any) => res.items ?? res,
      providesTags: (_result, _error, id) => [{ type: 'Executor', id }],
    }),

    assignExecutor: builder.mutation<unknown, { id: string; executor_user_id: string; notes?: string }>({
      query: ({ id, executor_user_id, notes }) => ({
        url: `/requests/${id}/assign-executor`,
        method: 'POST',
        body: { executor_user_id, notes },
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', { type: 'Request', id }],
    }),

    selfAssign: builder.mutation<unknown, string>({
      query: (id) => ({ url: `/requests/${id}/self-assign`, method: 'POST', body: {} }),
      invalidatesTags: (_result, _error, id) => ['Request', { type: 'Request', id }],
    }),

    reassignExecutor: builder.mutation<unknown, { id: string; executor_user_id: string; notes?: string }>({
      query: ({ id, executor_user_id, notes }) => ({
        url: `/requests/${id}/reassign-executor`,
        method: 'POST',
        body: { executor_user_id, notes },
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', { type: 'Request', id }],
    }),

    // Returns `{items, reason}` rather than a bare array. The endpoint answers
    // 200-with-empty-items when nobody is eligible and puts the cause in
    // `reason` (backend `_no_target_reason`), which classifies it: no primary
    // configured, the only primary is the requester, the only primary already
    // holds the ticket, category deleted. The previous transform dropped
    // `reason` on the floor, so the dialog could only say "No escalation target
    // available" — the one sentence that tells the caller nothing about how to
    // fix it.
    getEligibleEscalationTargets: builder.query<
      {
        items: { user_id: string; name: string | null; email: string | null }[];
        reason?: string;
      },
      string
    >({
      query: (id) => `/requests/${id}/eligible-escalation-targets`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transformResponse: (res: any) =>
        Array.isArray(res)
          ? { items: res }
          : { items: res?.items ?? [], reason: res?.reason },
      providesTags: (_result, _error, id) => [{ type: 'EscalationTarget', id }],
    }),

    escalateRequest: builder.mutation<unknown, { id: string; escalate_to_user_id: string; reason: string }>({
      query: ({ id, escalate_to_user_id, reason }) => ({
        url: `/requests/${id}/escalate`,
        method: 'POST',
        body: { escalate_to_user_id, reason },
      }),
      invalidatesTags: (_result, _error, { id }) => ['Request', { type: 'Request', id }],
    }),

    raiseRequest: builder.mutation<unknown, { payload: RaiseRequestPayload; files?: File[] }>({
      queryFn: async ({ payload, files }, { getState }) => {
        const token = (getState() as RootState).auth.accessToken
        const formData = new FormData()
        formData.append('body', JSON.stringify(payload))
        if (files?.length) {
          for (const file of files) {
            formData.append('files', file)
          }
        }
        try {
          const res = await fetch(`${SRM_BASE_URL}/requests`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Idempotency-Key': crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36),
            },
            body: formData,
          })
          if (!res.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return { error: { status: res.status, error: res.statusText } as any }
          }
          const data = await res.json()
          return { data }
        } catch (err: unknown) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { error: { status: 'FETCH_ERROR', error: (err as any)?.message } as any }
        }
      },
      invalidatesTags: ['Request'],
    }),

    // ─── Departments ───────────────────────────────────────────
    getDepartments: builder.query<Department[], { organisation_id?: string; skip?: number; limit?: number } | undefined>({
      query: (params) => ({
        url: '/departments',
        params: {
          organisation_id: params?.organisation_id,
          skip: params?.skip ?? 0,
          limit: params?.limit ?? 20,
        },
      }),
      providesTags: ['Department'],
    }),

    // ─── Employees ─────────────────────────────────────────────
    getEmployees: builder.query<Employee[], { organisation_id?: string; department_id?: string; department_ids?: string[]; skip?: number; limit?: number; search?: string; has_policies?: boolean } | undefined>({
      query: (params) => ({
        url: '/employees',
        params: {
          organisation_id: params?.organisation_id,
          department_id: params?.department_id || undefined,
          // Comma-separated: the endpoint scope-checks each id and forwards the
          // list to IAM, which takes the plural form natively. Used by the
          // category roster, where the pool spans several departments.
          department_ids: params?.department_ids?.length
            ? params.department_ids.join(',')
            : undefined,
          skip: params?.skip ?? 0,
          limit: params?.limit ?? 100,
          search: params?.search || undefined,
          has_policies: params?.has_policies,
        },
      }),
      providesTags: ['Employee'],
    }),

    // ─── Me ────────────────────────────────────────────────────
    getMe: builder.query<MeResponse, void>({
      query: () => '/me',
      providesTags: ['Me'],
    }),
  }),
})

export const {
  // Categories
  useGetCategoriesQuery,
  useGetCategoryByIdQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  useToggleCategoryStatusMutation,
  // Request Types
  useGetRequestTypesQuery,
  useGetRequestTypeByIdQuery,
  useCreateRequestTypeMutation,
  useUpdateRequestTypeMutation,
  useDeleteRequestTypeMutation,
  // Workflows
  useGetWorkflowsQuery,
  useGetWorkflowByIdQuery,
  useCreateWorkflowMutation,
  useUpdateWorkflowMutation,
  useDeleteWorkflowMutation,
  useActivateWorkflowMutation,
  useDeactivateWorkflowMutation,
  // Requests
  useGetRequestsQuery,
  useGetRequestByIdQuery,
  useGetRequestActivityQuery,
  useGetAttachmentSignedUrlMutation,
  useGetPendingApprovalsQuery,
  useGetApprovalCountsQuery,
  useGetDashboardSummaryQuery,
  useGetSrAnalyticsRolesQuery,
  useGetSrAnalyticsDashboardQuery,
  useGetSrBusinessUnitsQuery,
  useGetSrBuComparisonQuery,
  useGetRequestCommentsQuery,
  useGetRequestNotesQuery,
  useAddCommentMutation,
  useAddNoteMutation,
  useApproveRequestMutation,
  useRejectRequestMutation,
  useResolveRequestMutation,
  useCloseRequestMutation,
  useWithdrawRequestMutation,
  useFirstResponseMutation,
  useSubmitForApprovalMutation,
  useTriggerL2ApprovalMutation,
  useGetEligibleL2ApproversQuery,
  useGetEligibleExecutorsQuery,
  useAssignExecutorMutation,
  useSelfAssignMutation,
  useReassignExecutorMutation,
  useGetEligibleEscalationTargetsQuery,
  useEscalateRequestMutation,
  useRaiseRequestMutation,
  // Departments & Employees
  useGetDepartmentsQuery,
  useGetEmployeesQuery,
  // Me
  useGetMeQuery,
} = srmApi
