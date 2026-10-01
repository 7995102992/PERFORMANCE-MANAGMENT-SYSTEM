import { createApi } from '@reduxjs/toolkit/query/react'
import { createBaseQuery } from './baseQuery'
import { setTokens, setUser, clearAuth } from '@/store/slices/authSlice'
import type {
  LoginRequest,
  TokenResponse,
  LogoutRequest,
  MeResponse,
  ActivateAccountRequest,
  ResendActivationRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  ChangePasswordRequest,
  ConfirmEmailChangeRequest,
  AzureLoginUrlResponse,
  AzureCallbackRequest,
  UserUpdate,
  MpinRegisterResponse,
  MpinLoginRequest,
} from '@/types/auth'
import type {
  BusinessUnitResponse,
  BusinessUnitListParams,
  DepartmentResponse,
  DepartmentListParams,
  DesignationResponse,
  DesignationListParams,
  EmployeeAccessResponse,
  EmployeeResponse,
  EmployeeListParams,
  DirectoryListParams,
  OrgStructureBusinessUnit,
  OrgTreeNode,
  GraphPerson,
  GraphChainEntry,
  DirectoryListResponse,
  CountryResponse,
  StateResponse,
  CityResponse,
  StateListParams,
  CityListParams,
  AssetResponse,
  MasterDataOption,
  MasterDataListParams,
  RoleResponse,
  EmployeeCreateDTO,
  EmployeeUpdateDTO,
  BulkValidateResult,
  BulkUploadResult,
} from '@/types/iam'

export interface EmployeeCompact {
  id: string
  user_id?: string | null
  emp_code?: string
  first_name: string
  last_name: string
  department_name?: string
  designation_name?: string
  work_email?: string
}

export interface HeadcountSnapshot {
  active_employees: number
  new_joiners_this_month: number
  in_progress_exits: number
}

export interface BirthdayItem {
  user_id: string
  name: string
  date: string
  days_until: number
  type: 'birthday' | 'anniversary'
  years: number | null
}

export interface BirthdaysResponse {
  today: BirthdayItem[]
  upcoming: BirthdayItem[]
}

const IAM_BASE_URL = import.meta.env.VITE_IAM_BASE_URL as string

export const iamApi = createApi({
  reducerPath: 'iamApi',
  baseQuery: createBaseQuery(IAM_BASE_URL),
  tagTypes: ['Me', 'BusinessUnit', 'Department', 'OrgGraph', 'Employee'],
  endpoints: (builder) => ({
    // ─── Auth ────────────────────────────────────────────────────

    login: builder.mutation<TokenResponse, LoginRequest>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          dispatch(setTokens(data))
          dispatch(iamApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }))
        // eslint-disable-next-line no-empty
        } catch { }
      },
    }),

    portalLogin: builder.mutation<TokenResponse, LoginRequest>({
      query: (body) => ({ url: '/auth/portal/login', method: 'POST', body }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          dispatch(setTokens(data))
          dispatch(iamApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }))
        // eslint-disable-next-line no-empty
        } catch { }
      },
    }),

    // Register this device for mPIN quick-login (Bearer; returns a device token).
    // Requires the caller's password as confirmation (401 if wrong).
    mpinRegister: builder.mutation<MpinRegisterResponse, { password: string }>({
      query: (body) => ({ url: '/auth/mpin/register', method: 'POST', body }),
    }),

    // Unauthenticated login with a device token + the Secure PIN.
    mpinLogin: builder.mutation<TokenResponse, MpinLoginRequest>({
      query: (body) => ({ url: '/auth/mpin/login', method: 'POST', body }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          dispatch(setTokens(data))
          dispatch(iamApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }))
        // eslint-disable-next-line no-empty
        } catch { }
      },
    }),

    logout: builder.mutation<void, LogoutRequest>({
      query: (body) => ({ url: '/auth/logout', method: 'POST', body }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled
        } finally {
          dispatch(clearAuth())
          dispatch(iamApi.util.resetApiState())
        }
      },
    }),

    getMe: builder.query<MeResponse, void>({
      query: () => '/auth/me',
      providesTags: ['Me'],
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          dispatch(setUser(data))
        // eslint-disable-next-line no-empty
        } catch { }
      },
    }),

    activateAccount: builder.mutation<{ message: string; password_reset_token: string }, ActivateAccountRequest>({
      query: (body) => ({ url: '/auth/activate', method: 'POST', body }),
    }),

    resendActivation: builder.mutation<Record<string, unknown>, ResendActivationRequest>({
      query: (body) => ({ url: '/auth/resend-activation', method: 'POST', body }),
    }),

    forgotPassword: builder.mutation<Record<string, unknown>, ForgotPasswordRequest>({
      query: (body) => ({ url: '/auth/forgot-password', method: 'POST', body }),
    }),

    resetPassword: builder.mutation<Record<string, unknown>, ResetPasswordRequest>({
      query: (body) => ({ url: '/auth/reset-password', method: 'POST', body }),
    }),

    changePassword: builder.mutation<Record<string, unknown>, ChangePasswordRequest>({
      query: (body) => ({ url: '/auth/change-password', method: 'POST', body }),
    }),

    confirmEmailChange: builder.mutation<Record<string, unknown>, ConfirmEmailChangeRequest>({
      query: (body) => ({ url: '/auth/confirm-email-change', method: 'POST', body }),
    }),

    getAzureLoginUrl: builder.query<AzureLoginUrlResponse, void>({
      // This is the user portal (5174), so request the user-portal redirect URI.
      query: () => ({ url: '/auth/azure/login', params: { portal: 'user' } }),
    }),

    updateUser: builder.mutation<MeResponse, { id: string; body: UserUpdate }>({
      query: ({ id, body }) => ({ url: `/users/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Me'],
    }),

    updateMe: builder.mutation<MeResponse, UserUpdate>({
      query: (body) => ({ url: '/auth/me', method: 'PUT', body }),
      invalidatesTags: ['Me'],
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          dispatch(setUser(data))
        // eslint-disable-next-line no-empty
        } catch { }
      },
    }),

    // ─── Business Units ──────────────────────────────────────────

    getBusinessUnits: builder.query<BusinessUnitResponse[], BusinessUnitListParams | undefined>({
      query: (params) => ({ url: '/business-units/', params: params ?? {} }),
      providesTags: ['BusinessUnit'],
      keepUnusedDataFor: 3600,
    }),

    getBusinessUnit: builder.query<BusinessUnitResponse, string>({
      query: (id) => `/business-units/${id}`,
      providesTags: ['BusinessUnit'],
    }),

    // ─── Departments ─────────────────────────────────────────────

    getDepartments: builder.query<DepartmentResponse[], DepartmentListParams | void>({
      query: (params) => ({
        url: '/departments/',
        params: params
          ? { ...params, business_unit_ids: params.business_unit_ids?.join(',') }
          : {},
      }),
      providesTags: ['Department'],
      keepUnusedDataFor: 3600,
    }),

    getDepartment: builder.query<DepartmentResponse, string>({
      query: (id) => `/departments/${id}`,
      providesTags: ['Department'],
    }),

    // ─── Master Data: Countries / States / Cities ─────────────────

    getCurrencies: builder.query<{ currency: string; currency_name?: string | null; currency_symbol?: string | null }[], { country_id?: string; country_name?: string } | void>({
      query: (params) => ({ url: '/master-data/currencies', params: params ?? {} }),
      keepUnusedDataFor: 3600,
    }),

    getCountries: builder.query<CountryResponse[], { search?: string; limit?: number } | void>({
      query: (params) => ({
        url: '/master-data/countries',
        params: { limit: 300, ...params },
      }),
      keepUnusedDataFor: 3600,
    }),

    getStates: builder.query<StateResponse[], StateListParams>({
      query: (params) => ({
        url: '/master-data/states',
        params: { limit: 300, ...params },
      }),
      keepUnusedDataFor: 3600,
    }),

    getCities: builder.query<CityResponse[], CityListParams>({
      query: (params) => ({
        url: '/master-data/cities',
        params: { limit: 300, ...params },
      }),
      keepUnusedDataFor: 3600,
    }),

    uploadAsset: builder.mutation<AssetResponse, { file: File; folder: string }>({
      query: ({ file, folder }) => {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('folder', folder)
        return { url: '/assets/upload', method: 'POST', body: formData }
      },
    }),

    // ─── Master Data (Generic) ─────────────────────────────────────

    getMasterData: builder.query<MasterDataOption[], MasterDataListParams>({
      // Trailing slash matters: the route is registered as `/master-data/`, so
      // `/master-data?...` costs a 307 round-trip before the real request.
      query: (params) => ({ url: '/master-data/', params }),
      keepUnusedDataFor: 3600,
    }),

    // ─── Designations ────────────────────────────────────────────

    getDesignations: builder.query<DesignationResponse[], DesignationListParams | void>({
      query: (params) => ({
        url: '/designations/',
        params: params
          ? {
              ...params,
              department_ids: params.department_ids?.join(','),
              ...(params.department_ids ? { department_id: undefined } : {}),
            }
          : {},
      }),
      keepUnusedDataFor: 3600,
    }),

    // ─── Roles ──────────────────────────────────────────────────

    getRoles: builder.query<RoleResponse[], void>({
      query: () => ({ url: '/policies/roles' }),
      transformResponse: (res: unknown) =>
        Array.isArray(res) ? res : ((res as Record<string, unknown>).results ?? (res as Record<string, unknown>).items ?? []) as RoleResponse[],
      keepUnusedDataFor: 3600,
    }),

    // ─── Employees ──────────────────────────────────────────────

    // Colleague-facing directory. Any authenticated user may read it and it's
    // org-scoped server-side, so it needs no permission gate. Returns a real
    // `total`, unlike GET /employees/ which hands back a bare array.
    getDirectory: builder.query<DirectoryListResponse, DirectoryListParams | void>({
      query: (params) => ({ url: '/directory', params: params ?? {} }),
    }),

    /**
     * The caller's own access on the `/employees` routes, resolved by the same
     * session grid the guards deny off — so this and the enforcement flip over
     * at the same moment, instead of the FE advertising a just-granted level
     * whose writes still 403 until the token refreshes.
     *
     * 403 here means ungranted (the route inherits the router's viewer guard),
     * which callers treat as read-only rather than an error worth surfacing.
     */
    getEmployeeAccess: builder.query<EmployeeAccessResponse, void>({
      query: () => '/employees/resources',
      // Re-resolves whenever the session does, e.g. after a token refresh.
      providesTags: ['Me'],
    }),

    /**
     * Full HR record, keyed by USER id. The graph endpoints need an EMPLOYEE
     * id, so this is how a logged-in user (who only knows their user id) is
     * resolved onto the org chart: `.id` here is the employee id.
     */
    getEmployeeByUserId: builder.query<EmployeeResponse, string>({
      query: (userId) => `/employees/${userId}`,
      providesTags: (_r, _e, id) => [{ type: 'Employee' as const, id }],
    }),

    // ─── Employee CRUD (HR) ─────────────────────────────────────
    // Behind the same `/employees/` routes the admin portal uses, so the two
    // portals write identical records. All of them are HR-gated server-side.

    createEmployee: builder.mutation<EmployeeResponse, EmployeeCreateDTO>({
      query: (body) => ({ url: '/employees/', method: 'POST', body }),
      invalidatesTags: ['Employee'],
    }),

    updateEmployee: builder.mutation<EmployeeResponse, { id: string; body: EmployeeUpdateDTO }>({
      query: ({ id, body }) => ({ url: `/employees/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Employee'],
    }),

    deleteEmployee: builder.mutation<void, string>({
      query: (id) => ({ url: `/employees/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Employee'],
    }),

    /** Resend the activation email for a pending employee, keyed by USER id. */
    resendUserActivation: builder.mutation<{ message: string }, string>({
      query: (userId) => ({ url: `/users/${userId}/resend-activation`, method: 'POST' }),
      invalidatesTags: ['Employee'],
    }),

    // ─── Employee bulk upload ───────────────────────────────────

    /** Streams an .xlsx file — `responseHandler` keeps it a Blob, not JSON. */
    downloadEmployeeTemplate: builder.mutation<Blob, void>({
      query: () => ({
        url: '/employees/bulk-template',
        responseHandler: (response) => response.blob(),
        cache: 'no-cache',
      }),
    }),

    bulkValidateEmployees: builder.mutation<BulkValidateResult, File>({
      query: (file) => {
        const formData = new FormData()
        formData.append('file', file)
        return { url: '/employees/bulk-validate', method: 'POST', body: formData }
      },
    }),

    bulkUploadEmployees: builder.mutation<BulkUploadResult, { file: File; selectedRowNums?: number[] }>({
      query: ({ file, selectedRowNums }) => {
        const formData = new FormData()
        formData.append('file', file)
        return {
          url: '/employees/bulk-upload',
          method: 'POST',
          body: formData,
          // The backend reads the row selection off the query string, not the body.
          params: selectedRowNums?.length
            ? { selected_row_nums: JSON.stringify(selectedRowNums) }
            : undefined,
        }
      },
      invalidatesTags: ['Employee'],
    }),

    // ─── Org graph (Neo4j projection) ────────────────────────────
    // All take an EMPLOYEE record id, not a user id. `keepUnusedDataFor` is
    // generous because the tree expands lazily: RTK's per-arg cache is what
    // stops a re-expanded node refetching its children.

    /** Whole active hierarchy, pre-nested — see OrgTreeNode. */
    getOrgTree: builder.query<OrgTreeNode[], void>({
      query: () => '/graph/org-tree',
      providesTags: ['OrgGraph'],
    }),

    getOrgStructure: builder.query<OrgStructureBusinessUnit[], void>({
      query: () => '/graph/org-structure',
      providesTags: ['OrgGraph'],
    }),

    getDirectReports: builder.query<GraphPerson[], string>({
      query: (employeeId) => `/graph/direct-reports/${employeeId}`,
      providesTags: (_r, _e, id) => [{ type: 'OrgGraph' as const, id }],
      keepUnusedDataFor: 300,
    }),

    /** Everyone below a person at any depth, as a FLAT list (no nesting). */
    getAllReports: builder.query<GraphPerson[], string>({
      query: (employeeId) => `/graph/all-reports/${employeeId}`,
      providesTags: (_r, _e, id) => [{ type: 'OrgGraph' as const, id }],
      keepUnusedDataFor: 300,
    }),

    /** Upward chain; level 0 is the person, increasing toward the top. */
    getReportingChain: builder.query<GraphChainEntry[], string>({
      query: (employeeId) => `/graph/reporting-chain/${employeeId}`,
      providesTags: (_r, _e, id) => [{ type: 'OrgGraph' as const, id }],
      keepUnusedDataFor: 300,
    }),

    getEmployees: builder.query<EmployeeResponse[], EmployeeListParams | void>({
      query: (params) => {
        const p: Record<string, unknown> = params ? { ...params } : {}
        // The IAM list-employees endpoint decides active vs inactive ONLY via
        // `employment_status` (it resolves "active"/"inactive" against the
        // EMPLOYMENT_STATUSES master-data `is_active` flag). There is no separate
        // `is_active` employee filter — passing one is silently ignored. Translate
        // the convenience `is_active` flag callers use into the canonical
        // `employment_status` param so activeness has a single source of truth
        // (the employment status) and the backend never sees a second concept.
        if (p.is_active !== undefined) {
          if (p.employment_status === undefined) {
            p.employment_status = p.is_active ? 'active' : 'inactive'
          }
          delete p.is_active
        }
        return {
          url: '/employees/',
          params: {
            ...p,
            business_unit_ids: (p.business_unit_ids as string[] | undefined)?.join(','),
            department_ids: (p.department_ids as string[] | undefined)?.join(','),
            designation_ids: (p.designation_ids as string[] | undefined)?.join(','),
            role_ids: (p.role_ids as string[] | undefined)?.join(','),
          },
        }
      },
      providesTags: ['Employee'],
      transformResponse: (response: unknown): EmployeeResponse[] => {
        const list = Array.isArray(response) ? response : []
        return list.map((raw: Record<string, unknown>) => {
          const firstName = (raw.firstName ?? raw.first_name ?? '') as string
          const lastName = (raw.lastName ?? raw.last_name ?? '') as string
          const empCode = (raw.empCode ?? raw.emp_code ?? '') as string
          const userId = (raw.userId ?? raw.user_id ?? null) as string | null
          const workEmail = (raw.workEmail ?? raw.work_email ?? '') as string
          const departmentName = (raw.departmentName ?? raw.department_name) as string | undefined
          const designationName = (raw.designationName ?? raw.designation_name) as string | undefined
          return {
            ...(raw as object),
            firstName,
            first_name: firstName,
            lastName,
            last_name: lastName,
            empCode,
            emp_code: empCode,
            userId,
            user_id: userId,
            workEmail,
            work_email: workEmail,
            departmentName,
            department_name: departmentName,
            designationName,
            designation_name: designationName,
          } as EmployeeResponse
        })
      },
    }),

    getMyManagers: builder.query<
      { l1: { id: string; name: string } | null; l2: { id: string; name: string } | null },
      { userId: string }
    >({
      async queryFn({ userId }, _queryApi, _extraOptions, baseQuery) {
        const result: { l1: { id: string; name: string } | null; l2: { id: string; name: string } | null } = { l1: null, l2: null };

        const empResult = await baseQuery({ url: '/employees/' });
        if (!empResult.data) return { data: result };

        const raw = empResult.data;
        const employees = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>).data ?? (raw as Record<string, unknown>).items ?? []) as Record<string, unknown>[];

        const findEmp = (id: string) => employees.find(
          (e) => e.userId === id || e.user_id === id || e.id === id || e._id === id
        );
        const empName = (e: Record<string, unknown>) =>
          `${e.firstName ?? e.first_name ?? ''} ${e.lastName ?? e.last_name ?? ''}`.trim();

        const me = findEmp(userId);
        if (!me) return { data: result };

        const l1Id = (me.l1ManagerId ?? me.l1_manager_id) as string | undefined;
        const l1Name = (me.l1ManagerName ?? me.l1_manager_name) as string | undefined;

        if (l1Id) {
          const l1Emp = findEmp(l1Id);
          const resolvedL1Name = l1Name || (l1Emp ? empName(l1Emp) : undefined);
          if (resolvedL1Name) {
            result.l1 = { id: l1Id, name: resolvedL1Name };
          }
        }

        const directL2Name = (me.l2ManagerName ?? me.l2_manager_name) as string | undefined;
        const directL2Id = (me.l2ManagerId ?? me.l2_manager_id) as string | undefined;

        if (directL2Name && directL2Name.trim()) {
          result.l2 = { id: directL2Id ?? '', name: directL2Name };
        } else if (l1Id) {
          const l1Emp = findEmp(l1Id);
          if (l1Emp) {
            const l2Id = (l1Emp.l1ManagerId ?? l1Emp.l1_manager_id) as string | undefined;
            const l2Name = (l1Emp.l1ManagerName ?? l1Emp.l1_manager_name) as string | undefined;
            if (l2Id) {
              const l2Emp = findEmp(l2Id);
              const resolvedL2Name = l2Name || (l2Emp ? empName(l2Emp) : undefined);
              if (resolvedL2Name) {
                result.l2 = { id: l2Id, name: resolvedL2Name };
              }
            }
          }
        }

        return { data: result };
      },
    }),

    getHeadcountSnapshot: builder.query<HeadcountSnapshot, void>({
      query: () => '/dashboard/headcount-snapshot',
    }),

    getOrgBirthdays: builder.query<BirthdaysResponse, void>({
      query: () => '/dashboard/birthdays',
    }),

    azureCallback: builder.mutation<TokenResponse, AzureCallbackRequest>({
      query: (body) => ({ url: '/auth/azure/callback', method: 'POST', body }),
      async onQueryStarted(_, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled
          dispatch(setTokens(data))
          dispatch(iamApi.endpoints.getMe.initiate(undefined, { forceRefetch: true }))
        // eslint-disable-next-line no-empty
        } catch { }
      },
    }),
  }),
})

export const {
  useGetCurrenciesQuery,
  useLoginMutation,
  usePortalLoginMutation,
  useMpinRegisterMutation,
  useMpinLoginMutation,
  useLogoutMutation,
  useGetMeQuery,
  useLazyGetMeQuery,
  useActivateAccountMutation,
  useResendActivationMutation,
  useForgotPasswordMutation,
  useResetPasswordMutation,
  useChangePasswordMutation,
  useConfirmEmailChangeMutation,
  useUpdateUserMutation,
  useUpdateMeMutation,
  useGetAzureLoginUrlQuery,
  useLazyGetAzureLoginUrlQuery,
  useAzureCallbackMutation,
  useGetBusinessUnitsQuery,
  useGetBusinessUnitQuery,
  useGetDepartmentsQuery,
  useGetDepartmentQuery,
  useGetCountriesQuery,
  useGetStatesQuery,
  useGetCitiesQuery,
  useUploadAssetMutation,
  useGetMasterDataQuery,
  useGetDesignationsQuery,
  useGetRolesQuery,
  useGetDirectoryQuery,
  useLazyGetDirectoryQuery,
  useGetEmployeeByUserIdQuery,
  useGetEmployeeAccessQuery,
  useGetOrgStructureQuery,
  useGetOrgTreeQuery,
  useGetDirectReportsQuery,
  useGetAllReportsQuery,
  useGetReportingChainQuery,
  useGetEmployeesQuery,
  useLazyGetEmployeesQuery,
  useCreateEmployeeMutation,
  useUpdateEmployeeMutation,
  useDeleteEmployeeMutation,
  useResendUserActivationMutation,
  useDownloadEmployeeTemplateMutation,
  useBulkValidateEmployeesMutation,
  useBulkUploadEmployeesMutation,
  useGetMyManagersQuery,
  useGetHeadcountSnapshotQuery,
  useGetOrgBirthdaysQuery,
} = iamApi
