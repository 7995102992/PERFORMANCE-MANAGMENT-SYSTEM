import { createApi } from '@reduxjs/toolkit/query/react'
import type { FetchBaseQueryError, FetchBaseQueryMeta } from '@reduxjs/toolkit/query'
import { createBaseQuery } from './baseQuery'
import type {
  UploadedPayslip,
  UploadedPayslipListResponse,
  PayrollSummary,
  PayrollSummaryChart,
  PayrollChartRange,
  MyPayslipListResponse,
  MyPayslipListParams,
  PayslipListParams,
  PayslipUploadArgs,
  PayrollApiError,
  Payslip,
  PayslipQueryParams,
  PaginatedPayslips,
  PayslipValidationResult,
  PayslipUnlockResponse,
} from '@/types/payroll'

const PAYROLL_BASE_URL = import.meta.env.VITE_PAYROLL_BASE_URL as string

// The Secure PIN endpoints are served by the IAM backend, not the payroll
// service. Absolute URLs bypass this API's base while prepareHeaders still
// attaches the bearer token.
const IAM_BASE_URL = ((import.meta.env.VITE_IAM_BASE_URL as string) ?? '').replace(/\/+$/, '')

// Every payroll response carries an X-Correlation-ID — log it for tracing.
function logCorrelation(meta: FetchBaseQueryMeta | undefined): void {
  const id = meta?.response?.headers.get('X-Correlation-ID')
  if (id) console.debug('[payroll] X-Correlation-ID:', id)
}

// Build the multipart body. Do NOT set Content-Type — the browser adds the boundary.
function buildUploadForm({ file, month, year, reason }: PayslipUploadArgs): FormData {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('month', String(month))
  fd.append('year', String(year))
  if (reason != null && reason !== '') fd.append('reason', reason)
  return fd
}

export const payrollApi = createApi({
  reducerPath: 'payrollApi',
  baseQuery: createBaseQuery(PAYROLL_BASE_URL),
  tagTypes: ['Payslip'],
  endpoints: (builder) => ({
    // GET /payslips — paginated per-employee payslips for the selected period.
    listPayslips: builder.query<PaginatedPayslips, PayslipQueryParams | void>({
      query: (params) => ({
        url: '/payslips',
        params: params
          ? {
              ...(params.year != null && { year: params.year }),
              ...(params.month != null && { month: params.month }),
              ...(params.search ? { search: params.search } : {}),
              ...(params.page != null && { page: params.page }),
              ...(params.page_size != null && { page_size: params.page_size }),
            }
          : undefined,
      }),
      transformResponse: (data: PaginatedPayslips, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'EMPLOYEE_LIST' }],
    }),

    // GET /my-payroll — the signed-in user's own payslip (single object or null).
    // `unmasked` returns full PF/UAN/account (allowed only for self-service).
    getMyPayslip: builder.query<
      Payslip | null,
      { year?: number; month?: number; unmasked?: boolean } | void
    >({
      query: (params) => ({
        url: '/my-payroll',
        params: params
          ? {
              ...(params.year != null && { year: params.year }),
              ...(params.month != null && { month: params.month }),
              ...(params.unmasked ? { unmasked: true } : {}),
            }
          : undefined,
      }),
      transformResponse: (data: Payslip | null, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'MINE' }],
    }),

    // POST {IAM}/pin/regenerate — issues a new Secure PIN and emails it (PIN not
    // returned). Requires the caller's password as confirmation (401 if wrong).
    regeneratePayslipPin: builder.mutation<void, { password: string }>({
      query: (body) => ({ url: `${IAM_BASE_URL}/pin/regenerate`, method: 'POST', body }),
    }),

    // POST /my-payroll/unlock — verifies the caller's Secure PIN via payroll (which
    // delegates to IAM) and, on success, mints a 300 s payroll unlock in Valkey.
    // IAM verify alone does NOT open the payroll APIs — this endpoint must be used.
    unlockPayroll: builder.mutation<PayslipUnlockResponse, { pin: string }>({
      query: (body) => ({ url: '/my-payroll/unlock', method: 'POST', body }),
      transformResponse: (data: PayslipUnlockResponse, meta) => {
        logCorrelation(meta)
        return data
      },
    }),

    // GET /payslips/uploads/summary — aggregates for the most recent period (org-scoped).
    getPayrollSummary: builder.query<PayrollSummary, void>({
      query: () => '/payslips/uploads/summary',
      transformResponse: (data: PayrollSummary, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'LIST' }],
    }),

    // GET /payslips/uploads/summary-chart — trailing-window monthly aggregates (org-scoped).
    getPayrollSummaryChart: builder.query<PayrollSummaryChart, PayrollChartRange | void>({
      query: (range) => ({
        url: '/payslips/uploads/summary-chart',
        params: range ? { range } : undefined,
      }),
      transformResponse: (data: PayrollSummaryChart, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'LIST' }],
    }),

    // GET /my-payroll/summary — caller's own latest-period aggregates (same shape as org).
    getMyPayrollSummary: builder.query<PayrollSummary, void>({
      query: () => '/my-payroll/summary',
      transformResponse: (data: PayrollSummary, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'MINE' }],
    }),

    // GET /my-payroll/summary-chart — caller's own trailing-window monthly aggregates.
    getMyPayrollSummaryChart: builder.query<PayrollSummaryChart, PayrollChartRange | void>({
      query: (range) => ({
        url: '/my-payroll/summary-chart',
        params: range ? { range } : undefined,
      }),
      transformResponse: (data: PayrollSummaryChart, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'MINE' }],
    }),

    // GET /my-payroll/view — caller's payslip as a standalone HTML document (no PIN).
    getMyPayslipView: builder.query<string, { year: number; month: number }>({
      query: ({ year, month }) => ({
        url: '/my-payroll/view',
        params: { year, month },
        responseHandler: (response) => response.text(),
      }),
      transformResponse: (data: string, meta) => {
        logCorrelation(meta)
        return data
      },
    }),

    // GET /my-payroll/list — caller's own payslip history (paginated, year/search filters).
    getMyPayslipList: builder.query<MyPayslipListResponse, MyPayslipListParams | void>({
      query: (params) => ({
        url: '/my-payroll/list',
        params: params
          ? {
              ...(params.year != null && { year: params.year }),
              ...(params.month != null && { month: params.month }),
              ...(params.search ? { search: params.search } : {}),
              ...(params.page != null && { page: params.page }),
              ...(params.page_size != null && { page_size: params.page_size }),
            }
          : undefined,
      }),
      transformResponse: (data: MyPayslipListResponse, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: [{ type: 'Payslip', id: 'MINE' }],
    }),

    // GET /payslips/uploads — paginated; newest first, with period/status/search filters.
    listPayslipUploads: builder.query<UploadedPayslipListResponse, PayslipListParams | void>({
      query: (params) => ({
        url: '/payslips/uploads',
        params: params
          ? {
              ...(params.year != null && { year: params.year }),
              ...(params.month != null && { month: params.month }),
              ...(params.status ? { status: params.status } : {}),
              ...(params.search ? { search: params.search } : {}),
              ...(params.page != null && { page: params.page }),
              ...(params.page_size != null && { page_size: params.page_size }),
            }
          : undefined,
      }),
      transformResponse: (data: UploadedPayslipListResponse, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: (result) =>
        result
          ? [
              ...result.items.map((u) => ({ type: 'Payslip' as const, id: u.id })),
              { type: 'Payslip' as const, id: 'LIST' },
            ]
          : [{ type: 'Payslip' as const, id: 'LIST' }],
    }),

    // GET /payslips/uploads/{id} — single record with a fresh presigned download_url.
    getPayslipUpload: builder.query<UploadedPayslip, string>({
      query: (id) => `/payslips/uploads/${id}`,
      transformResponse: (data: UploadedPayslip, meta) => {
        logCorrelation(meta)
        return data
      },
      providesTags: (_r, _e, id) => [{ type: 'Payslip', id }],
    }),

    // POST /payslips/uploads/validate — dry-run; stores nothing, returns per-row status.
    // Period-aware: optional month/year so validation matches the target period's template.
    validatePayslipUpload: builder.mutation<
      PayslipValidationResult,
      { file: File; month?: number; year?: number }
    >({
      query: ({ file, month, year }) => {
        const fd = new FormData()
        fd.append('file', file)
        if (month != null) fd.append('month', String(month))
        if (year != null) fd.append('year', String(year))
        return { url: '/payslips/uploads/validate', method: 'POST', body: fd }
      },
      transformResponse: (data: PayslipValidationResult, meta) => {
        logCorrelation(meta)
        return data
      },
    }),

    // POST /payslips/uploads — creates version 1 (reason optional). 409 if period exists.
    createPayslipUpload: builder.mutation<UploadedPayslip, PayslipUploadArgs>({
      query: (args) => ({
        url: '/payslips/uploads',
        method: 'POST',
        body: buildUploadForm(args),
      }),
      transformResponse: (data: UploadedPayslip, meta) => {
        logCorrelation(meta)
        return data
      },
      invalidatesTags: [{ type: 'Payslip', id: 'LIST' }],
    }),

    // PUT /payslips/uploads — stores a new version for an existing period (reason required).
    replacePayslipUpload: builder.mutation<UploadedPayslip, PayslipUploadArgs>({
      query: (args) => ({
        url: '/payslips/uploads',
        method: 'PUT',
        body: buildUploadForm(args),
      }),
      transformResponse: (data: UploadedPayslip, meta) => {
        logCorrelation(meta)
        return data
      },
      invalidatesTags: [{ type: 'Payslip', id: 'LIST' }],
    }),
  }),
})

export const {
  useGetPayrollSummaryQuery,
  useGetPayrollSummaryChartQuery,
  useGetMyPayrollSummaryQuery,
  useGetMyPayrollSummaryChartQuery,
  useGetMyPayslipListQuery,
  useGetMyPayslipViewQuery,
  useListPayslipsQuery,
  useGetMyPayslipQuery,
  useRegeneratePayslipPinMutation,
  useUnlockPayrollMutation,
  useValidatePayslipUploadMutation,
  useListPayslipUploadsQuery,
  useGetPayslipUploadQuery,
  useLazyGetPayslipUploadQuery,
  useCreatePayslipUploadMutation,
  useReplacePayslipUploadMutation,
} = payrollApi

// ─── Error helpers ────────────────────────────────────────────────────────────

/** Extract the structured `{ detail, code, correlation_id }` body from an RTK error. */
export function getPayrollError(error: unknown): PayrollApiError | null {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as FetchBaseQueryError).data
    if (data && typeof data === 'object' && 'code' in data) {
      return data as PayrollApiError
    }
  }
  return null
}

const ERROR_MESSAGES: Record<string, string> = {
  UNSUPPORTED_FILE_TYPE: 'Unsupported file type. Allowed: .csv, .xls, .xlsx.',
  FILE_TOO_LARGE: 'File is too large. Maximum size is 10 MB.',
  INVALID_UPLOAD: 'The file is missing or empty.',
  REASON_REQUIRED: 'A reason is required to upload a new version.',
  MISSING_PERIOD: 'Select both a month and a year.',
  INVALID_ID: 'Invalid upload reference.',
  UNAUTHORIZED: 'Your session has expired. Please sign in again.',
  FORBIDDEN: 'Your session is missing organisation context.',
  NOT_FOUND: 'No payroll record found for this period.',
  PAYSLIP_UPLOAD_CONFLICT:
    'A payroll file already exists for this period. Upload a new version instead.',
  VALIDATION_ERROR: 'Please check the month, year and file, then try again.',
  STORAGE_ERROR: 'File storage is temporarily unavailable. Please retry.',
}

/** Map an RTK error to a friendly, code-aware message (logs correlation id). */
export function getPayrollErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const e = getPayrollError(error)
  if (!e) return fallback
  if (e.correlation_id) console.debug('[payroll] error correlation_id:', e.correlation_id)
  return ERROR_MESSAGES[e.code] ?? e.detail ?? fallback
}
