import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

export interface ExitRequestResponse {
  id: string
  organisationId: string
  employeeId: string
  requestCode: string
  lastWorkingDay: string
  reason: string
  otherReason: string | null
  additionalDetails: string | null
  status: 'pending_approval' | 'hr_initiated' | 'under_review' | 'awaiting_clearances' | 'completed' | 'approved' | 'rejected' | 'withdrawn' | 'archived' | 'deactivated'
  exitType: string
  hrInitiated: boolean
  immediateExit: boolean
  deactivatedOn: string | null
  deactivatedBy: string | null
  rejectionReason: string | null
  approvedBy: string | null
  approvedOn: string | null
  requestedLastWorkingDay: string | null
  parentRequestId: string | null
  documentIds: string[]
  createdOn: string | null
  employeeName: string | null
  employeeEmail: string | null
  empCode: string | null
  employeeStatus: 'active' | 'inactive' | 'notice_period' | 'exit' | null
  itClearanceStatus?: string | null
  adminClearanceStatus?: string | null
  financeClearanceStatus?: string | null
  managerCompletedChecklist?: string[]
  hrCompletedChecklist?: string[]
}

export interface ExitInterviewResponse {
  submittedOn: string | null
  id: string
  exitRequestId: string
  employeeId: string
  reasonForLeaving: string | null
  otherReason: string | null
  overallRating: number | null
  likedMost: string | null
  improvements: string | null
  createdOn: string | null
}

export interface CreateExitRequest {
  employeeId: string
  reason: string
  otherReason?: string
  additionalDetails?: string
  documentIds?: string[]
  exitType?: string
  hrInitiated?: boolean
  immediateExit?: boolean
  lastWorkingDay?: string
}

export interface UpdateExitRequest {
  reason?: string
  otherReason?: string
  additionalDetails?: string
  documentIds?: string[]
}

export interface CreateExitInterview {
  reasonForLeaving?: string
  otherReason?: string
  overallRating?: number
  likedMost?: string
  improvements?: string
  managerFeedback?: string
}

export interface EmployeeOption {
  id: string
  userId: string | null
  firstName: string | null
  lastName: string | null
  empCode: string | null
  workEmail: string | null
}

export interface TeamExitRequestResponse extends ExitRequestResponse {
  employeeRole: string | null
  department: string | null
  dateOfJoining: string | null
  currentLocation: string | null
  reportingManagerName: string | null
  noticePeriodDays: number | null
}

export interface TeamExitSummary {
  total: number
  pendingApproval: number
  underReview: number
  approved: number
  rejected: number
  withdrawn: number
}

export interface ManagerApproveRequest {
  comments?: string
  finalLastWorkingDay: string
  completedChecklist?: string[]
}

export interface ManagerRejectRequest {
  actionType: 'standard' | 'retention'
  comments: string
  completedChecklist?: string[]
}

export interface HRExitRequestResponse extends ExitRequestResponse {
  employeeRole: string | null
  department: string | null
  subDept: string | null
  dateOfJoining: string | null
  currentLocation: string | null
  reportingManagerName: string | null
  noticePeriodDays: number | null
  empType: string | null
  grade: string | null
  phone: string | null
}

export interface HRExitSummary {
  total: number
  inProgress: number
  pendingTasks: number
  awaitingClearances: number
  completed: number
}

// --- IT Admin Clearance ---
export interface ITAssetReturnResponse {
  id: string
  organisationId: string
  exitRequestId: string
  requestCode: string | null
  employeeId: string
  assetType: string
  assetId: string
  serialNumber: string
  model: string
  issuedDate: string | null
  returnedDate: string | null
  status: 'pending' | 'returned' | 'verified' | 'not_cleared'
  condition: string | null
  verificationNotes: string | null
  verifiedBy: string | null
  verifiedOn: string | null
  employeeName: string | null
  empCode: string | null
  department: string | null
  lastWorkingDay: string | null
  createdOn: string | null
  completedChecklist: string[]
  itClearanceStatus?: string | null
  adminClearanceStatus?: string | null
  financeClearanceStatus?: string | null
}

export interface ITAssetSummary {
  total: number
  pending: number
  returned: number
  verified: number
  notCleared: number
}

export interface ITAssetVerifyRequest {
  condition: string
  verificationNotes: string
  completedChecklist: string[]
  status?: string
}

// --- Admin Flow Clearance ---
export interface AdminTaskResponse {
  id: string
  organisationId: string
  exitRequestId: string
  requestCode: string | null
  employeeId: string
  taskType: string
  details: string
  deskNumber: string | null
  lockerNumber: string | null
  issuedDate: string | null
  submittedDate: string | null
  status: 'pending' | 'returned' | 'completed' | 'not_cleared'
  completedChecklist: string[]
  notes: string | null
  completedBy: string | null
  completedOn: string | null
  employeeName: string | null
  empCode: string | null
  department: string | null
  lastWorkingDay: string | null
  createdOn: string | null
  itClearanceStatus?: string | null
  adminClearanceStatus?: string | null
  financeClearanceStatus?: string | null
}

export interface AdminTaskSummary {
  total: number
  pending: number
  returned: number
  completed: number
  notCleared: number
}

export interface AdminTaskCompleteRequest {
  completedChecklist: string[]
  notes: string
  status?: string
}

// --- Finance Flow Clearance ---
export interface FinanceClearanceResponse {
  id: string
  organisationId: string
  exitRequestId: string
  requestCode: string | null
  employeeId: string
  amountDue: number
  settlementDate: string | null
  noticePeriodDays: number
  status: 'pending' | 'under_review' | 'approved' | 'sent_to_payroll' | 'paid' | 'not_cleared'
  clearanceReason: string | null
  remarks: string | null
  clearedBy: string | null
  clearedOn: string | null
  employeeName: string | null
  empCode: string | null
  department: string | null
  designation: string | null
  reportingManagerName: string | null
  lastWorkingDay: string | null
  createdOn: string | null
  itClearanceStatus?: string | null
  adminClearanceStatus?: string | null
  financeClearanceStatus?: string | null
  completedChecklist: string[]
}

export interface FinanceSummary {
  total: number
  pending: number
  underReview: number
  approved: number
  sentToPayroll: number
  paid: number
  notCleared: number
}

export interface FinanceClearanceStatusRequest {
  status: string
  clearanceReason?: string
  remarks?: string
  completedChecklist: string[]
}

// --- Checklists ---
export interface DepartmentChecklist {
  id: string
  organisationId: string
  deptId: string
  deptName: string
  items: string[]
}

export interface DepartmentChecklistUpdate {
  deptId: string
  deptName: string
  items: string[]
}

export interface AssetResponse {
  id: string
  file_name: string
  file_size: number
  mime_type: string
  file_url: string
  folder: string
  is_active: boolean
}

export const exitManagementApi = createApi({
  reducerPath: 'exitManagementApi',
  baseQuery: createBaseQuery(IAM_BASE_URL),
  tagTypes: ['ExitRequests', 'ExitInterview', 'ITAssets', 'AdminTasks', 'FinanceClearance', 'Checklists'],
  endpoints: (builder) => ({
    uploadAsset: builder.mutation<AssetResponse, { file: File; folder?: string }>({
      query: ({ file, folder = 'exit-documents' }) => {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('folder', folder)
        return { url: '/assets/upload', method: 'POST', body: formData }
      },
    }),

    getAsset: builder.query<AssetResponse, string>({
      query: (id) => `/assets/${id}`,
    }),

    getEmployees: builder.query<EmployeeOption[], { search?: string; limit?: number }>({
      query: (params) => ({ url: '/employees/', params: { limit: 100, ...params } }),
    }),

    getExitRequests: builder.query<ExitRequestResponse[], { skip?: number; limit?: number; search?: string; status?: string }>({
      query: (params) => ({ url: '/exit-management/requests', params }),
      providesTags: ['ExitRequests'],
    }),

    getExitRequest: builder.query<ExitRequestResponse, string>({
      query: (id) => `/exit-management/requests/${id}`,
      providesTags: ['ExitRequests'],
    }),

    createExitRequest: builder.mutation<ExitRequestResponse, CreateExitRequest>({
      query: (body) => ({ url: '/exit-management/requests', method: 'POST', body }),
      invalidatesTags: ['ExitRequests'],
    }),

    updateExitRequest: builder.mutation<ExitRequestResponse, { id: string; body: UpdateExitRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/requests/${id}`, method: 'PUT', body }),
      invalidatesTags: ['ExitRequests'],
    }),

    withdrawExitRequest: builder.mutation<ExitRequestResponse, string>({
      query: (id) => ({ url: `/exit-management/requests/${id}/withdraw`, method: 'PUT' }),
      invalidatesTags: ['ExitRequests'],
    }),

    revokeExitRequest: builder.mutation<ExitRequestResponse, string>({
      query: (id) => ({ url: `/exit-management/requests/${id}/revoke`, method: 'PUT' }),
      invalidatesTags: ['ExitRequests'],
    }),

    approveExitRequest: builder.mutation<ExitRequestResponse, { id: string; body: { status: string; rejectionReason?: string } }>({
      query: ({ id, body }) => ({ url: `/exit-management/requests/${id}/approve`, method: 'POST', body }),
      invalidatesTags: ['ExitRequests'],
    }),

    reapplyExitRequest: builder.mutation<ExitRequestResponse, { id: string; body: CreateExitRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/requests/${id}/reapply`, method: 'POST', body }),
      invalidatesTags: ['ExitRequests'],
    }),

    submitExitInterview: builder.mutation<ExitInterviewResponse, { requestId: string; body: CreateExitInterview }>({
      query: ({ requestId, body }) => ({ url: `/exit-management/requests/${requestId}/interview`, method: 'POST', body }),
      invalidatesTags: ['ExitInterview'],
    }),

    getExitInterview: builder.query<ExitInterviewResponse | null, string>({
      query: (requestId) => `/exit-management/requests/${requestId}/interview`,
      providesTags: ['ExitInterview'],
      transformErrorResponse: (response) => {
        if (response.status === 404) return null
        return response
      },
    }),

    getTeamExitRequests: builder.query<TeamExitRequestResponse[], { skip?: number; limit?: number; search?: string; status?: string; department?: string; businessUnit?: string; fromDate?: string; toDate?: string }>({
      query: (params) => ({ url: '/exit-management/team-requests', params }),
      providesTags: ['ExitRequests'],
    }),

    getTeamExitSummary: builder.query<TeamExitSummary, void>({
      query: () => '/exit-management/team-requests/summary',
      providesTags: ['ExitRequests'],
    }),

    getHRExitRequests: builder.query<HRExitRequestResponse[], { skip?: number; limit?: number; search?: string; status?: string; department?: string; businessUnit?: string; fromDate?: string; toDate?: string }>({
      query: (params) => ({ url: '/exit-management/hr-requests', params }),
      providesTags: ['ExitRequests'],
    }),

    getHRExitSummary: builder.query<HRExitSummary, void>({
      query: () => '/exit-management/hr-requests/summary',
      providesTags: ['ExitRequests'],
    }),

    managerApproveRequest: builder.mutation<TeamExitRequestResponse, { id: string; body: ManagerApproveRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/requests/${id}/manager-approve`, method: 'POST', body }),
      invalidatesTags: ['ExitRequests'],
    }),

    managerRejectRequest: builder.mutation<TeamExitRequestResponse, { id: string; body: ManagerRejectRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/requests/${id}/manager-reject`, method: 'POST', body }),
      invalidatesTags: ['ExitRequests'],
    }),

    initiateClearances: builder.mutation<{ status: string; message: string }, string | { id: string; body: { completedChecklist: string[] } }>({
      query: (arg) => {
        const id = typeof arg === 'string' ? arg : arg.id
        const body = typeof arg === 'string' ? undefined : arg.body
        return { url: `/exit-management/requests/${id}/initiate-clearances`, method: 'POST', body }
      },
      invalidatesTags: ['ExitRequests', 'ITAssets', 'AdminTasks', 'FinanceClearance'],
    }),

    deactivateEmployee: builder.mutation<{ status: string; message: string }, string | { id: string; body: { completedChecklist: string[] } }>({
      query: (arg) => {
        const id = typeof arg === 'string' ? arg : arg.id
        const body = typeof arg === 'string' ? undefined : arg.body
        return { url: `/exit-management/requests/${id}/deactivate`, method: 'POST', body }
      },
      invalidatesTags: ['ExitRequests'],
    }),

    sendClearanceReminder: builder.mutation<{ status: string; message: string }, string>({
      query: (id) => ({ url: `/exit-management/requests/${id}/remind`, method: 'POST' }),
    }),

    // IT Admin Endpoints
    getITAssets: builder.query<ITAssetReturnResponse[], { skip?: number; limit?: number; search?: string; status?: string; assetType?: string; department?: string; businessUnit?: string; fromDate?: string; toDate?: string }>({
      query: (params) => ({ url: '/exit-management/it/assets', params }),
      providesTags: ['ITAssets'],
    }),

    getITAssetsSummary: builder.query<ITAssetSummary, void>({
      query: () => '/exit-management/it/assets/summary',
      providesTags: ['ITAssets'],
    }),

    verifyITAsset: builder.mutation<{ status: string; message: string }, { id: string; body: ITAssetVerifyRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/it/assets/${id}/verify`, method: 'POST', body }),
      invalidatesTags: ['ITAssets'],
    }),

    // Admin Flow Endpoints
    getAdminTasks: builder.query<AdminTaskResponse[], { skip?: number; limit?: number; search?: string; status?: string; taskType?: string; department?: string; businessUnit?: string; fromDate?: string; toDate?: string }>({
      query: (params) => ({ url: '/exit-management/admin/tasks', params }),
      providesTags: ['AdminTasks'],
    }),

    getAdminTasksSummary: builder.query<AdminTaskSummary, void>({
      query: () => '/exit-management/admin/tasks/summary',
      providesTags: ['AdminTasks'],
    }),

    completeAdminTask: builder.mutation<{ status: string; message: string }, { id: string; body: AdminTaskCompleteRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/admin/tasks/${id}/complete`, method: 'POST', body }),
      invalidatesTags: ['AdminTasks'],
    }),

    // Finance Flow Endpoints
    getFinanceClearanceRequests: builder.query<FinanceClearanceResponse[], { skip?: number; limit?: number; search?: string; status?: string; department?: string; businessUnit?: string; fromDate?: string; toDate?: string }>({
      query: (params) => ({ url: '/exit-management/finance/requests', params }),
      providesTags: ['FinanceClearance'],
    }),

    getFinanceSummary: builder.query<FinanceSummary, void>({
      query: () => '/exit-management/finance/requests/summary',
      providesTags: ['FinanceClearance'],
    }),

    updateFinanceStatus: builder.mutation<{ status: string; message: string }, { id: string; body: FinanceClearanceStatusRequest }>({
      query: ({ id, body }) => ({ url: `/exit-management/finance/requests/${id}/status`, method: 'POST', body }),
      invalidatesTags: ['FinanceClearance'],
    }),

    // --- Checklists ---
    getChecklists: builder.query<DepartmentChecklist[], { deptId?: string } | void>({
      query: (arg) => {
        let url = '/exit-management/checklists'
        if (arg?.deptId) url += `?deptId=${arg.deptId}`
        return url
      },
      providesTags: ['Checklists'],
    }),

    updateChecklist: builder.mutation<DepartmentChecklist, DepartmentChecklistUpdate>({
      query: (body) => ({
        url: '/exit-management/checklists',
        method: 'PUT',
        body,
      }),
      invalidatesTags: ['Checklists'],
    }),

  }),
})

export const {
  useUploadAssetMutation,
  useGetAssetQuery,
  useGetEmployeesQuery,
  useGetExitRequestsQuery,
  useGetExitRequestQuery,
  useCreateExitRequestMutation,
  useUpdateExitRequestMutation,
  useWithdrawExitRequestMutation,
  useRevokeExitRequestMutation,
  useApproveExitRequestMutation,
  useReapplyExitRequestMutation,
  useSubmitExitInterviewMutation,
  useGetExitInterviewQuery,
  useGetTeamExitRequestsQuery,
  useGetTeamExitSummaryQuery,
  useManagerApproveRequestMutation,
  useManagerRejectRequestMutation,
  useInitiateClearancesMutation,
  useDeactivateEmployeeMutation,
  useSendClearanceReminderMutation,
  useGetHRExitRequestsQuery,
  useGetHRExitSummaryQuery,
  useGetITAssetsQuery,
  useGetITAssetsSummaryQuery,
  useVerifyITAssetMutation,
  useGetAdminTasksQuery,
  useGetAdminTasksSummaryQuery,
  useCompleteAdminTaskMutation,
  useGetFinanceClearanceRequestsQuery,
  useGetFinanceSummaryQuery,
  useUpdateFinanceStatusMutation,
  useGetChecklistsQuery,
  useUpdateChecklistMutation,
} = exitManagementApi
