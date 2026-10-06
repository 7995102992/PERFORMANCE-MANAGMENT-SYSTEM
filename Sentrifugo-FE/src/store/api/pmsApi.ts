import { createApi } from '@reduxjs/toolkit/query/react'
import type { FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query'
import { createBaseQuery } from './baseQuery'
import { mockEligibilityPreview, mockLatency, MOCK_DEPARTMENTS, MOCK_PLANTS } from './mocks/pmsCycleMock'
import {
  mockDeleteTemplate,
  mockDuplicateTemplate,
  mockListDesignations,
  mockSetTemplateStatus,
} from './mocks/pmsConfigMock'
import type {
  PmsCycle,
  PmsCycleActivation,
  PmsCycleApplicability,
  PmsCycleListParams,
  PmsCycleListResponse,
  PmsCycleUpsert,
  PmsEligibilityPreview,
  PmsLookupOption,
  PmsRatingScale,
} from '@/types/pms'
import type {
  PmsApprovalItem,
  PmsEmployeeTargets,
  PmsTargetValidation,
  PmsTargetsRequest,
  PmsTeamMember,
} from '@/types/pms-goals'
import type {
  PmsCompetency,
  PmsCompetencyUpsert,
  PmsDesignationOption,
  PmsGoalTemplate,
  PmsGoalTemplateListItem,
  PmsGoalTemplateListParams,
  PmsGoalTemplateUpsert,
  PmsKpi,
  PmsKpiUpsert,
  PmsKra,
  PmsKraUpsert,
  PmsRatingScaleConfig,
  PmsRatingScaleUpdate,
  PmsStandardRatingLevel,
  PmsStandardRatingLevelUpsert,
  PmsTemplateStatus,
} from '@/types/pms-config'
import {
  type ApiCompetency,
  type ApiCycle,
  type ApiCycleActivation,
  type ApiEnvelope,
  type ApiGoalTemplate,
  type ApiGoalTemplateListItem,
  type ApiKpi,
  type ApiRatingScale,
  type PmsLookups,
  competencyFromApi,
  competencyToApi,
  cycleActivationFromApi,
  cycleFromApi,
  cycleToApi,
  fyToApi,
  kpiFromApi,
  kraFromApi,
  ratingScaleConfigFromApi,
  ratingScaleOptionFromApi,
  ratingScaleCreateToApi,
  type ApiStandardRatingLevel,
  standardLevelFromApi,
  standardLevelToApi,
  ratingScaleToApi,
  templateBasicToApi,
  templateCompetenciesToApi,
  templateFromApi,
  templateKraKpiToApi,
  templateListItemFromApi,
  unwrapEnvelope,
} from './pmsMappers'

/**
 * PMS REST base: `${VITE_PMS_API_BASE_URL}/api/v1/pms`. Endpoint contract:
 * `API_FRONTEND_GUIDE.md` at the repo root.
 *
 * Still mock-backed (no endpoint in the guide yet): plant / department /
 * designation lookups, eligibility preview, and goal-template status,
 * duplicate and delete. Everything else calls the API.
 */
const PMS_BASE_URL = `${(import.meta.env.VITE_PMS_API_BASE_URL as string | undefined) ?? ''}/api/v1/pms`

/** Path templates, relative to PMS_BASE_URL. */
export const PMS_ENDPOINTS = {
  // -- Appraisal cycles (1.1 – 1.6) --
  listCycles: { method: 'GET', path: '/pms-cycle/get/cycles' },
  exportCycles: { method: 'GET', path: '/pms-cycle/get/cycles/export' },
  getCycle: { method: 'GET', path: '/pms-cycle/get/cycle/{cycleId}' },
  createCycle: { method: 'POST', path: '/pms-cycle/create/cycle' },
  updateCycle: { method: 'PUT', path: '/pms-cycle/update/cycle/{cycleId}' },
  publishCycle: { method: 'POST', path: '/pms-cycle/publish/cycle/{cycleId}' },
  getActivation: { method: 'GET', path: '/pms-cycle/get/cycle/{cycleId}/activation' },
  cancelCycle: { method: 'POST', path: '/pms-cycle/cancel/cycle/{cycleId}' },

  // -- Goal templates (2.1 – 2.4) --
  listTemplates: { method: 'GET', path: '/pms-goal-template/get/goal-templates' },
  getTemplate: { method: 'GET', path: '/pms-goal-template/get/goal-template/{templateId}' },
  createTemplate: { method: 'POST', path: '/pms-goal-template/create/goal-template' },
  updateTemplate: { method: 'PUT', path: '/pms-goal-template/update/goal-template/{templateId}' },
  updateTemplateKraKpi: { method: 'PUT', path: '/pms-goal-template/update/goal-template/{templateId}/kra-kpi' },
  updateTemplateCompetencies: { method: 'PUT', path: '/pms-goal-template/update/goal-template/{templateId}/competencies' },

  // -- Masters (2.5 – 2.10) --
  listKras: { method: 'GET', path: '/pms-master/get/kras' },
  createKra: { method: 'POST', path: '/pms-master/create/kra' },
  updateKra: { method: 'PUT', path: '/pms-master/update/kra/{kraId}' },
  deleteKra: { method: 'DELETE', path: '/pms-master/delete/kra/{kraId}' },
  listKpis: { method: 'GET', path: '/pms-master/get/kpis' },
  kpiUnits: { method: 'GET', path: '/pms-master/get/kpi-units' },
  createKpi: { method: 'POST', path: '/pms-master/create/kpi' },
  updateKpi: { method: 'PUT', path: '/pms-master/update/kpi/{kpiId}' },
  deleteKpi: { method: 'DELETE', path: '/pms-master/delete/kpi/{kpiId}' },
  listCompetencies: { method: 'GET', path: '/pms-master/get/competencies' },
  createCompetency: { method: 'POST', path: '/pms-master/create/competency' },
  updateCompetency: { method: 'PUT', path: '/pms-master/update/competency/{competencyId}' },
  deleteCompetency: { method: 'DELETE', path: '/pms-master/delete/competency/{competencyId}' },
  listRatingScales: { method: 'GET', path: '/pms-rating-scale/get/rating-scales' },
  getRatingScale: { method: 'GET', path: '/pms-rating-scale/get/rating-scale/{scaleId}' },
  updateRatingScale: { method: 'PUT', path: '/pms-rating-scale/update/rating-scale/{scaleId}' },
} as const

/** Runs a mock resolver and maps a thrown `{status, data}` onto an RTK error. */
async function mock<T>(run: () => T, ms?: number) {
  await mockLatency(ms)
  try {
    return { data: run() }
  } catch (e) {
    return { error: e as FetchBaseQueryError }
  }
}

/**
 * Lookups the API refers to by id. Still from the mock Sentrifugo data;
 * swap for real calls when the plant / department / designation endpoints land.
 */
async function fetchLookups(): Promise<PmsLookups> {
  await mockLatency(150)
  return { plants: MOCK_PLANTS, departments: MOCK_DEPARTMENTS, designations: mockListDesignations() }
}

/** The RTK base query, as handed to a `queryFn` (sync or async; each result is checked where used). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Send = (args: string | FetchArgs) => any

// Two cache buckets under one tag: LIST → the cycles table, id → one cycle.
const LIST_TAG = { type: 'PmsCycle' as const, id: 'LIST' }

export const pmsApi = createApi({
  reducerPath: 'pmsApi',
  baseQuery: createBaseQuery(PMS_BASE_URL),
  tagTypes: ['PmsCycle', 'PmsKra', 'PmsKpi', 'PmsCompetency', 'PmsRatingScale', 'PmsTemplate'],
  endpoints: (builder) => ({
    getPmsCycles: builder.query<PmsCycleListResponse, PmsCycleListParams | void>({
      query: (params) => ({ url: PMS_ENDPOINTS.listCycles.path, params: params ?? undefined }),
      transformResponse: (r: ApiEnvelope<PmsCycleListResponse>) => r.data,
      providesTags: [LIST_TAG],
    }),

    getPmsCycle: builder.query<PmsCycle, string>({
      queryFn: async (id, _api, _x, send: Send) => {
        const res = await send(`/pms-cycle/get/cycle/${id}`)
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), await fetchLookups()) }
      },
      providesTags: (_r, _e, id) => [{ type: 'PmsCycle', id }],
    }),

    /** Creates the cycle as `draft`. Publishing is a separate call. */
    createPmsCycle: builder.mutation<PmsCycle, PmsCycleUpsert>({
      queryFn: async (body, _api, _x, send: Send) => {
        const lookups = await fetchLookups()
        const res = await send({ url: '/pms-cycle/create/cycle', method: 'POST', body: cycleToApi(body, lookups) })
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), lookups) }
      },
      invalidatesTags: [LIST_TAG],
    }),

    updatePmsCycle: builder.mutation<PmsCycle, { id: string; body: PmsCycleUpsert }>({
      queryFn: async ({ id, body }, _api, _x, send: Send) => {
        const lookups = await fetchLookups()
        const res = await send({ url: `/pms-cycle/update/cycle/${id}`, method: 'PUT', body: cycleToApi(body, lookups) })
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), lookups) }
      },
      invalidatesTags: (_r, _e, { id }) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** draft → active. Eligibility run and notifications happen server-side. */
    publishPmsCycle: builder.mutation<PmsCycleActivation, string>({
      queryFn: async (id, _api, _x, send: Send) => {
        const res = await send({ url: `/pms-cycle/publish/cycle/${id}`, method: 'POST' })
        if (res.error) return { error: res.error }
        return { data: cycleActivationFromApi(unwrapEnvelope<ApiCycleActivation>(res), await fetchLookups()) }
      },
      invalidatesTags: (_r, _e, id) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** What publishing did — the notification counts behind screen 1.6. */
    getPmsCycleActivation: builder.query<PmsCycleActivation, string>({
      queryFn: async (id, _api, _x, send: Send) => {
        const res = await send(`/pms-cycle/get/cycle/${id}/activation`)
        if (res.error) return { error: res.error }
        return { data: cycleActivationFromApi(unwrapEnvelope<ApiCycleActivation>(res), await fetchLookups()) }
      },
      providesTags: (_r, _e, id) => [{ type: 'PmsCycle', id }],
    }),

    cancelPmsCycle: builder.mutation<PmsCycle, string>({
      queryFn: async (id, _api, _x, send: Send) => {
        const res = await send({ url: `/pms-cycle/cancel/cycle/${id}`, method: 'POST' })
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), await fetchLookups()) }
      },
      invalidatesTags: (_r, _e, id) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** Same filters as the list (no paging); the response is the CSV file, not the JSON envelope. */
    exportPmsCycles: builder.mutation<Blob, PmsCycleListParams | void>({
      query: (params) => ({
        url: PMS_ENDPOINTS.exportCycles.path,
        params: params ? { ...params, skip: undefined, limit: undefined } : undefined,
        responseHandler: (r: Response) => r.blob(),
      }),
    }),

    previewEligibleEmployees: builder.mutation<PmsEligibilityPreview, PmsCycleApplicability>({
      // Not in the API guide yet — mock.
      queryFn: (body) => mock(() => mockEligibilityPreview(body), 500),
    }),

    getPmsPlants: builder.query<PmsLookupOption[], void>({
      // Sentrifugo lookup, not in the guide yet — mock.
      queryFn: () => mock(() => MOCK_PLANTS, 150),
    }),

    getPmsDepartments: builder.query<PmsLookupOption[], void>({
      // Sentrifugo lookup, not in the guide yet — mock.
      queryFn: () => mock(() => MOCK_DEPARTMENTS, 150),
    }),

    /** Cycle wizard dropdown — active scales only. */
    getPmsRatingScales: builder.query<PmsRatingScale[], void>({
      query: () => ({ url: PMS_ENDPOINTS.listRatingScales.path, params: { status: 'active' } }),
      transformResponse: (r: ApiEnvelope<ApiRatingScale[]>) => r.data.map(ratingScaleOptionFromApi),
      providesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),

    // -- KRA Master --
    getPmsKras: builder.query<PmsKra[], void>({
      query: () => PMS_ENDPOINTS.listKras.path,
      transformResponse: (r: ApiEnvelope<{ id: string; name: string }[]>) => r.data.map(kraFromApi),
      providesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),
    createPmsKra: builder.mutation<PmsKra, PmsKraUpsert>({
      query: (body) => ({ url: PMS_ENDPOINTS.createKra.path, method: 'POST', body: { name: body.name } }),
      transformResponse: (r: ApiEnvelope<{ id: string; name: string }>) => kraFromApi(r.data),
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),
    updatePmsKra: builder.mutation<PmsKra, { id: string; body: PmsKraUpsert }>({
      // Omitting `status` leaves it as is on the server.
      query: ({ id, body }) => ({ url: `/pms-master/update/kra/${id}`, method: 'PUT', body: { name: body.name } }),
      transformResponse: (r: ApiEnvelope<{ id: string; name: string }>) => kraFromApi(r.data),
      // KPI rows carry the KRA name, so they go stale too.
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }, { type: 'PmsKpi', id: 'LIST' }],
    }),
    deletePmsKra: builder.mutation<void, string>({
      query: (id) => ({ url: `/pms-master/delete/kra/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }, { type: 'PmsKpi', id: 'LIST' }],
    }),

    // -- KPI Master --
    getPmsKpis: builder.query<PmsKpi[], void>({
      query: () => PMS_ENDPOINTS.listKpis.path,
      transformResponse: (r: ApiEnvelope<ApiKpi[]>) => r.data.map(kpiFromApi),
      providesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    createPmsKpi: builder.mutation<PmsKpi, PmsKpiUpsert>({
      query: (body) => ({ url: PMS_ENDPOINTS.createKpi.path, method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<ApiKpi>) => kpiFromApi(r.data),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    updatePmsKpi: builder.mutation<PmsKpi, { id: string; body: PmsKpiUpsert }>({
      query: ({ id, body }) => ({ url: `/pms-master/update/kpi/${id}`, method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<ApiKpi>) => kpiFromApi(r.data),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    deletePmsKpi: builder.mutation<void, string>({
      query: (id) => ({ url: `/pms-master/delete/kpi/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    getPmsKpiUnits: builder.query<string[], void>({
      query: () => PMS_ENDPOINTS.kpiUnits.path,
      transformResponse: (r: ApiEnvelope<string[]>) => r.data,
    }),

    // -- Competency Master --
    getPmsCompetencies: builder.query<PmsCompetency[], void>({
      query: () => PMS_ENDPOINTS.listCompetencies.path,
      transformResponse: (r: ApiEnvelope<ApiCompetency[]>) => r.data.map(competencyFromApi),
      providesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    createPmsCompetency: builder.mutation<PmsCompetency, PmsCompetencyUpsert>({
      query: (body) => ({ url: PMS_ENDPOINTS.createCompetency.path, method: 'POST', body: competencyToApi(body) }),
      transformResponse: (r: ApiEnvelope<ApiCompetency>) => competencyFromApi(r.data),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    updatePmsCompetency: builder.mutation<PmsCompetency, { id: string; body: PmsCompetencyUpsert }>({
      query: ({ id, body }) => ({ url: `/pms-master/update/competency/${id}`, method: 'PUT', body: competencyToApi(body) }),
      transformResponse: (r: ApiEnvelope<ApiCompetency>) => competencyFromApi(r.data),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    deletePmsCompetency: builder.mutation<void, string>({
      query: (id) => ({ url: `/pms-master/delete/competency/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),

    // -- Rating Scale (full config) --
    getPmsRatingScaleConfigs: builder.query<PmsRatingScaleConfig[], void>({
      query: () => PMS_ENDPOINTS.listRatingScales.path,
      transformResponse: (r: ApiEnvelope<ApiRatingScale[]>) => r.data.map(ratingScaleConfigFromApi),
      providesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),
    getPmsStandardRatingLevels: builder.query<PmsStandardRatingLevel[], void>({
      query: () => '/pms-master/get/standard-rating-levels',
      transformResponse: (r: ApiEnvelope<ApiStandardRatingLevel[]>) => r.data.map(standardLevelFromApi),
      providesTags: [{ type: 'PmsRatingScale', id: 'STANDARDS' }],
    }),
    createPmsStandardRatingLevel: builder.mutation<PmsStandardRatingLevel, PmsStandardRatingLevelUpsert>({
      query: (body) => ({ url: '/pms-master/create/standard-rating-level', method: 'POST', body: standardLevelToApi(body) }),
      transformResponse: (r: ApiEnvelope<ApiStandardRatingLevel>) => standardLevelFromApi(r.data),
      invalidatesTags: [{ type: 'PmsRatingScale', id: 'STANDARDS' }],
    }),
    // -- Goal assignment by the manager (3.1 - 3.5) --
    getPmsTeam: builder.query<PmsTeamMember[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/team',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsTeamMember[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'TEAM' }],
    }),
    getPmsEmployeeTargets: builder.query<PmsEmployeeTargets, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-goal-assignment/get/employee-targets',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsTemplate', id: `TARGETS-${employeeUserId}` }],
    }),
    saveEmployeeTargets: builder.mutation<PmsEmployeeTargets, PmsTargetsRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/update/employee-targets', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: (_r, _e, body) => [{ type: 'PmsTemplate', id: 'TEAM' }, { type: 'PmsTemplate', id: `TARGETS-${body.employee_user_id}` }],
    }),
    validateEmployeeTargets: builder.mutation<PmsTargetValidation, PmsTargetsRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/validate', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsTargetValidation>) => r.data,
    }),
    sendEmployeeTargets: builder.mutation<PmsEmployeeTargets, PmsTargetsRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/send', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: (_r, _e, body) => [{ type: 'PmsTemplate', id: 'TEAM' }, { type: 'PmsTemplate', id: `TARGETS-${body.employee_user_id}` }],
    }),
    // -- Employee goals and HOD approval (4.1 - 4.3, 5.1 - 5.2) --
    getPmsMyGoals: builder.query<PmsEmployeeTargets, string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/my-goals',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    acknowledgeMyGoals: builder.mutation<PmsEmployeeTargets, { financial_year: string; comment?: string }>({
      query: (body) => ({ url: '/pms-goal-assignment/acknowledge', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    requestGoalChange: builder.mutation<
      PmsEmployeeTargets,
      { financial_year: string; kpi_id: string; proposed_target: number | null; reason: string }
    >({
      query: (body) => ({ url: '/pms-goal-assignment/request-change', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    getPmsApprovals: builder.query<PmsApprovalItem[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/approvals',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsApprovalItem[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    approveGoals: builder.mutation<PmsEmployeeTargets, { employee_user_id: string; financial_year: string; remarks?: string }>({
      query: (body) => ({ url: '/pms-goal-assignment/approve', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    returnGoals: builder.mutation<PmsEmployeeTargets, { employee_user_id: string; financial_year: string; remarks?: string }>({
      query: (body) => ({ url: '/pms-goal-assignment/return', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    createPmsRatingScale: builder.mutation<PmsRatingScaleConfig, { name: string; body: PmsRatingScaleUpdate }>({
      query: ({ name, body }) => ({
        url: PMS_ENDPOINTS.listRatingScales.path.replace('/get/rating-scales', '/create/rating-scale'),
        method: 'POST',
        body: ratingScaleCreateToApi(name, body),
      }),
      transformResponse: (r: ApiEnvelope<ApiRatingScale>) => ratingScaleConfigFromApi(r.data),
      invalidatesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),
    updatePmsRatingScale: builder.mutation<PmsRatingScaleConfig, { id: string; body: PmsRatingScaleUpdate }>({
      queryFn: async ({ id, body }, _api, _x, send: Send) => {
        // The PUT replaces name and status as well, so read the current scale first.
        const current = await send(`/pms-rating-scale/get/rating-scale/${id}`)
        if (current.error) return { error: current.error }
        const scale = unwrapEnvelope<ApiRatingScale>(current)
        const res = await send({
          url: `/pms-rating-scale/update/rating-scale/${id}`,
          method: 'PUT',
          body: ratingScaleToApi(scale, body),
        })
        if (res.error) return { error: res.error }
        return { data: ratingScaleConfigFromApi(unwrapEnvelope<ApiRatingScale>(res)) }
      },
      invalidatesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),

    // -- Goal Templates --
    getPmsTemplates: builder.query<PmsGoalTemplateListItem[], PmsGoalTemplateListParams | void>({
      queryFn: async (params, _api, _x, send: Send) => {
        const p = params ?? {}
        const res = await send({
          url: PMS_ENDPOINTS.listTemplates.path,
          params: {
            financial_year: p.financial_year ? fyToApi(p.financial_year) : undefined,
            plant_id: p.plant_id,
            department_id: p.department_id,
            search: p.search,
          },
        })
        if (res.error) return { error: res.error }
        const lookups = await fetchLookups()
        const rows = unwrapEnvelope<ApiGoalTemplateListItem[]>(res)
        return { data: rows.map((t) => templateListItemFromApi(t, lookups)) }
      },
      providesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    getPmsTemplate: builder.query<PmsGoalTemplate, string>({
      queryFn: async (id, _api, _x, send: Send) => {
        const res = await send(`/pms-goal-template/get/goal-template/${id}`)
        if (res.error) return { error: res.error }
        return { data: templateFromApi(unwrapEnvelope<ApiGoalTemplate>(res), await fetchLookups()) }
      },
      providesTags: (_r, _e, id) => [{ type: 'PmsTemplate', id }],
    }),
    /**
     * The FE saves a template in one call, the API in three: basic info, then
     * KRA/KPI, then competencies. A failure after the first step leaves the
     * basic info saved; retrying from the wizard will create a second template.
     */
    createPmsTemplate: builder.mutation<PmsGoalTemplate, PmsGoalTemplateUpsert>({
      queryFn: async (body, _api, _x, send: Send) => {
        const created = await send({
          url: PMS_ENDPOINTS.createTemplate.path,
          method: 'POST',
          body: templateBasicToApi(body.basic),
        })
        if (created.error) return { error: created.error }
        const id = unwrapEnvelope<ApiGoalTemplate>(created).id
        return saveTemplateChildren(send, id, body)
      },
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    updatePmsTemplate: builder.mutation<PmsGoalTemplate, { id: string; body: PmsGoalTemplateUpsert }>({
      queryFn: async ({ id, body }, _api, _x, send: Send) => {
        const basic = await send({
          url: `/pms-goal-template/update/goal-template/${id}`,
          method: 'PUT',
          body: templateBasicToApi(body.basic),
        })
        if (basic.error) return { error: basic.error }
        return saveTemplateChildren(send, id, body)
      },
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PmsTemplate', id: 'LIST' }, { type: 'PmsTemplate', id }],
    }),
    // Not in the API guide yet — mock.
    setPmsTemplateStatus: builder.mutation<PmsGoalTemplate, { id: string; status: PmsTemplateStatus }>({
      queryFn: ({ id, status }) => mock(() => mockSetTemplateStatus(id, status)),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PmsTemplate', id: 'LIST' }, { type: 'PmsTemplate', id }],
    }),
    duplicatePmsTemplate: builder.mutation<PmsGoalTemplate, string>({
      queryFn: (id) => mock(() => mockDuplicateTemplate(id)),
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    deletePmsTemplate: builder.mutation<void, string>({
      queryFn: (id) => mock(() => mockDeleteTemplate(id)),
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    getPmsDesignations: builder.query<PmsDesignationOption[], string | void>({
      // Sentrifugo lookup, not in the guide yet — mock.
      queryFn: (departmentId) => mock(() => mockListDesignations(departmentId || undefined), 120),
    }),
  }),
})

/** Steps 2 and 3 of a template save, against an id that already exists. */
async function saveTemplateChildren(send: Send, id: string, body: PmsGoalTemplateUpsert) {
  const kraKpi = await send({
    url: `/pms-goal-template/update/goal-template/${id}/kra-kpi`,
    method: 'PUT',
    body: templateKraKpiToApi(body),
  })
  if (kraKpi.error) return { error: kraKpi.error }

  const comps = await send({
    url: `/pms-goal-template/update/goal-template/${id}/competencies`,
    method: 'PUT',
    body: templateCompetenciesToApi(body),
  })
  if (comps.error) return { error: comps.error }

  return { data: templateFromApi(unwrapEnvelope<ApiGoalTemplate>(comps), await fetchLookups()) }
}

export const {
  useGetPmsCyclesQuery,
  useGetPmsCycleQuery,
  useCreatePmsCycleMutation,
  useUpdatePmsCycleMutation,
  usePublishPmsCycleMutation,
  useGetPmsCycleActivationQuery,
  useCancelPmsCycleMutation,
  useExportPmsCyclesMutation,
  usePreviewEligibleEmployeesMutation,
  useGetPmsPlantsQuery,
  useGetPmsDepartmentsQuery,
  useGetPmsRatingScalesQuery,
  useGetPmsKrasQuery,
  useCreatePmsKraMutation,
  useUpdatePmsKraMutation,
  useDeletePmsKraMutation,
  useGetPmsKpisQuery,
  useCreatePmsKpiMutation,
  useUpdatePmsKpiMutation,
  useDeletePmsKpiMutation,
  useGetPmsKpiUnitsQuery,
  useGetPmsCompetenciesQuery,
  useCreatePmsCompetencyMutation,
  useUpdatePmsCompetencyMutation,
  useDeletePmsCompetencyMutation,
  useGetPmsRatingScaleConfigsQuery,
  useUpdatePmsRatingScaleMutation,
  useCreatePmsRatingScaleMutation,
  useGetPmsStandardRatingLevelsQuery,
  useCreatePmsStandardRatingLevelMutation,
  useGetPmsTemplatesQuery,
  useGetPmsTemplateQuery,
  useCreatePmsTemplateMutation,
  useUpdatePmsTemplateMutation,
  useSetPmsTemplateStatusMutation,
  useDuplicatePmsTemplateMutation,
  useDeletePmsTemplateMutation,
  useGetPmsDesignationsQuery,
  useGetPmsTeamQuery,
  useGetPmsEmployeeTargetsQuery,
  useSaveEmployeeTargetsMutation,
  useValidateEmployeeTargetsMutation,
  useSendEmployeeTargetsMutation,
  useGetPmsMyGoalsQuery,
  useAcknowledgeMyGoalsMutation,
  useRequestGoalChangeMutation,
  useGetPmsApprovalsQuery,
  useApproveGoalsMutation,
  useReturnGoalsMutation,
} = pmsApi
