import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryApi, FetchArgs } from '@reduxjs/toolkit/query'
import { createBaseQuery } from './baseQuery'
import { staticGoalAssignment } from './mocks/pmsGoalAssignmentMock'
import { staticManagerScreens } from './mocks/pmsManagerMock'
import { staticHrScreens } from './mocks/pmsHrMock'
import { staticEmployeeScreens } from './mocks/pmsEmployeeMock'
import type { 
  PmsMyProgress,
  PmsMyProgressSave,
  PmsMySelfAppraisal,
  PmsMySelfAppraisalSave,
} from '@/types/pms-employee'
import { fetchLookups } from './pmsLookups'
/*
 * RTK Query endpoints for the PMS module. Every call goes through createBaseQuery to /api/v1/pms and
 * unwraps the { success, message, data } envelope. Endpoints still backed by mocks are listed in
 * docs/PMS-FRONTEND.md, section 5.
 */
import type {
  PmsCalibration,
  PmsCalibrationSave,
  PmsHrAppraisal,
  PmsHrAppraisalSave,
  PmsHrQueueRow,
  PmsSendToCalibration,
} from '@/types/pms-hr'
import type {
  PmsAppraisalHodQueueRow,
  PmsAppraisalHodReview,
  PmsAppraisalHodSave,
} from '@/types/pms-appraisal-hod'
import type {
  PmsManagerAppraisal,
  PmsManagerAppraisalSave,
  PmsMidYearReview,
  PmsMidYearRow,
  PmsMidYearSubmit,
  PmsRevisionRequest,
  PmsRevisionSubmit,
  PmsSendToHodRequest,
  PmsTeamAppraisalRow,
  PmsTeamProgressRow,
  PmsTransferGoalSheet,
  PmsTransferGoalSheetRequest,
  PmsTransferNotice,
} from '@/types/pms-manager'
import type {
  PmsApprovalWorkflow,
  PmsApprovalWorkflowUpsert,
  PmsCycle,
  PmsCycleActivation,
  PmsCycleListParams,
  PmsCycleListResponse,
  PmsCycleUpsert,
  PmsRatingScale,
} from '@/types/pms'
import type {
  PmsNotifications,
  PmsStageNotice,
  PmsHodActionRequest,
  PmsHodBulkApproveRequest,
  PmsHodBulkApproveResult,
  PmsHodHistoryItem,
  PmsHodQueueItem,
  PmsHodReview,
  PmsHodRequestType,
  PmsHodTrail,
  PmsCopyPreview,
  PmsCopyResult,
  PmsApprovalItem,
  PmsChangeRequestRecord,
  PmsAssignTemplateRequest,
  PmsEmployeeTargets,
  PmsTargetValidation,
  PmsTargetsRequest,
  PmsTemplateAssignment,
  PmsTeamMember,
} from '@/types/pms-goals'
import type {
  PmsCompetency,
  PmsCompetencyUpsert,
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

/** The RTK base query, as handed to a `queryFn` (sync or async; each result is checked where used). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Send = (args: string | FetchArgs) => any

// Two cache buckets under one tag: LIST → the cycles table, id → one cycle.
const LIST_TAG = { type: 'PmsCycle' as const, id: 'LIST' }

/**
 * Static data, per group of screens:
 *  - Manager screens (3.1 - 3.14, goal assignment, transfers, progress, mid-year, appraisal) call PMS_Java.
 *    Set VITE_PMS_STATIC_MANAGER=true to answer them from `mocks/pmsManagerMock.ts` instead.
 *  - Corporate HR (1.7 - 1.9) and employee progress / self appraisal (4.4, 4.6) still answer from static
 *    data by default; VITE_PMS_STATIC_DATA=false sends those to the API too.
 */
const STATIC_OFF = import.meta.env.VITE_PMS_STATIC_DATA === 'false'
// Switches (see the comment above): which groups of screens answer from static mock data.
const USE_STATIC_MANAGER = !STATIC_OFF && import.meta.env.VITE_PMS_STATIC_MANAGER === 'true'
const USE_STATIC_OTHER = !STATIC_OFF

// Base query with auth headers and the PMS base URL; the static layers sit in front of it.
const realBaseQuery = createBaseQuery(PMS_BASE_URL)
/** Tries the static mocks that are switched on first; anything they do not handle goes to PMS_Java. */
const pmsBaseQuery: typeof realBaseQuery = async (args, api, extra) => {
  const handled =
    (USE_STATIC_MANAGER ? ((await staticGoalAssignment(args)) ?? (await staticManagerScreens(args))) : null) ??
    (USE_STATIC_OTHER ? ((await staticHrScreens(args)) ?? (await staticEmployeeScreens(args))) : null)
  if (handled) return handled
  return realBaseQuery(args, api, extra)
}

// The PMS RTK Query API. Hooks are exported at the bottom of the file.
export const pmsApi = createApi({
  reducerPath: 'pmsApi',
  baseQuery: pmsBaseQuery,
  // Cache tags: a mutation invalidates the tag of the data it changes, and queries providing it refetch.
  tagTypes: [
    'PmsCycle',
    'PmsKra',
    'PmsKpi',
    'PmsCompetency',
    'PmsRatingScale',
    'PmsTemplate',
    'PmsManager',
    'PmsWorkflow',
  ],
  endpoints: (builder) => ({
    // Screens 1.1: list cycles. GET /pms-cycle/get/cycles with search, year, type, plant, status and paging.
    getPmsCycles: builder.query<PmsCycleListResponse, PmsCycleListParams | void>({
      query: (params) => ({ url: PMS_ENDPOINTS.listCycles.path, params: params ?? undefined }),
      transformResponse: (r: ApiEnvelope<PmsCycleListResponse>) => r.data,
      providesTags: [LIST_TAG],
    }),

    // Screens 1.2-1.5: one cycle. GET /pms-cycle/get/cycle/{id}; ids are resolved to names with the IAM lookups.
    getPmsCycle: builder.query<PmsCycle, string>({
      queryFn: async (id, api, _x, send: Send) => {
        const res = await send(`/pms-cycle/get/cycle/${id}`)
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), await fetchLookups(api)) }
      },
      providesTags: (_r, _e, id) => [{ type: 'PmsCycle', id }],
    }),

    /** Creates the cycle as `draft`. Publishing is a separate call. */
    createPmsCycle: builder.mutation<PmsCycle, PmsCycleUpsert>({
      queryFn: async (body, api, _x, send: Send) => {
        const lookups = await fetchLookups(api)
        const res = await send({ url: '/pms-cycle/create/cycle', method: 'POST', body: cycleToApi(body, lookups) })
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), lookups) }
      },
      invalidatesTags: [LIST_TAG],
    }),

    // PUT /pms-cycle/update/cycle/{id}: replaces the sections that are sent. Invalidates the list and the cycle.
    updatePmsCycle: builder.mutation<PmsCycle, { id: string; body: PmsCycleUpsert }>({
      queryFn: async ({ id, body }, api, _x, send: Send) => {
        const lookups = await fetchLookups(api)
        const res = await send({ url: `/pms-cycle/update/cycle/${id}`, method: 'PUT', body: cycleToApi(body, lookups) })
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), lookups) }
      },
      invalidatesTags: (_r, _e, { id }) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** draft → active. Eligibility run and notifications happen server-side. */
    publishPmsCycle: builder.mutation<PmsCycleActivation, string>({
      queryFn: async (id, api, _x, send: Send) => {
        const res = await send({ url: `/pms-cycle/publish/cycle/${id}`, method: 'POST' })
        if (res.error) return { error: res.error }
        return { data: cycleActivationFromApi(unwrapEnvelope<ApiCycleActivation>(res), await fetchLookups(api)) }
      },
      invalidatesTags: (_r, _e, id) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** What publishing did — the notification counts behind screen 1.6. */
    getPmsCycleActivation: builder.query<PmsCycleActivation, string>({
      queryFn: async (id, api, _x, send: Send) => {
        const res = await send(`/pms-cycle/get/cycle/${id}/activation`)
        if (res.error) return { error: res.error }
        return { data: cycleActivationFromApi(unwrapEnvelope<ApiCycleActivation>(res), await fetchLookups(api)) }
      },
      providesTags: (_r, _e, id) => [{ type: 'PmsCycle', id }],
    }),

    // POST /pms-cycle/cancel/cycle/{id}: cancels a draft or active cycle.
    cancelPmsCycle: builder.mutation<PmsCycle, string>({
      queryFn: async (id, api, _x, send: Send) => {
        const res = await send({ url: `/pms-cycle/cancel/cycle/${id}`, method: 'POST' })
        if (res.error) return { error: res.error }
        return { data: cycleFromApi(unwrapEnvelope<ApiCycle>(res), await fetchLookups(api)) }
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

    /** Cycle wizard dropdown — active scales only. */
    getPmsRatingScales: builder.query<PmsRatingScale[], void>({
      query: () => ({ url: PMS_ENDPOINTS.listRatingScales.path, params: { status: 'active' } }),
      transformResponse: (r: ApiEnvelope<ApiRatingScale[]>) => r.data.map(ratingScaleOptionFromApi),
      providesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),

    // -- Approval Workflow master (Configuration; screen 1.5 picks one) --
    getPmsApprovalWorkflows: builder.query<PmsApprovalWorkflow[], void>({
      query: () => '/pms-approval-workflow/get/workflows',
      transformResponse: (r: ApiEnvelope<PmsApprovalWorkflow[]>) => r.data,
      providesTags: [{ type: 'PmsWorkflow', id: 'LIST' }],
    }),
    createPmsApprovalWorkflow: builder.mutation<PmsApprovalWorkflow, PmsApprovalWorkflowUpsert>({
      query: (body) => ({ url: '/pms-approval-workflow/create/workflow', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsApprovalWorkflow>) => r.data,
      invalidatesTags: [{ type: 'PmsWorkflow', id: 'LIST' }],
    }),
    updatePmsApprovalWorkflow: builder.mutation<
      PmsApprovalWorkflow,
      { id: string; body: PmsApprovalWorkflowUpsert }
    >({
      query: ({ id, body }) => ({ url: `/pms-approval-workflow/update/workflow/${id}`, method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsApprovalWorkflow>) => r.data,
      invalidatesTags: [{ type: 'PmsWorkflow', id: 'LIST' }],
    }),
    deletePmsApprovalWorkflow: builder.mutation<void, string>({
      query: (id) => ({ url: `/pms-approval-workflow/delete/workflow/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'PmsWorkflow', id: 'LIST' }],
    }),

    // -- KRA Master --
    getPmsKras: builder.query<PmsKra[], void>({
      query: () => PMS_ENDPOINTS.listKras.path,
      transformResponse: (r: ApiEnvelope<{ id: string; name: string }[]>) => r.data.map(kraFromApi),
      providesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),
    // POST /pms-master/create/kra. 409 when the name already exists.
    createPmsKra: builder.mutation<PmsKra, PmsKraUpsert>({
      query: (body) => ({ url: PMS_ENDPOINTS.createKra.path, method: 'POST', body: { name: body.name } }),
      transformResponse: (r: ApiEnvelope<{ id: string; name: string }>) => kraFromApi(r.data),
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),
    // PUT /pms-master/update/kra/{id}.
    updatePmsKra: builder.mutation<PmsKra, { id: string; body: PmsKraUpsert }>({
      // Omitting `status` leaves it as is on the server.
      query: ({ id, body }) => ({ url: `/pms-master/update/kra/${id}`, method: 'PUT', body: { name: body.name } }),
      transformResponse: (r: ApiEnvelope<{ id: string; name: string }>) => kraFromApi(r.data),
      // KPI rows carry the KRA name, so they go stale too.
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }, { type: 'PmsKpi', id: 'LIST' }],
    }),
    // DELETE /pms-master/delete/kra/{id}. 409 when KPIs are still mapped to it.
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
    // POST /pms-master/create/kpi.
    createPmsKpi: builder.mutation<PmsKpi, PmsKpiUpsert>({
      query: (body) => ({ url: PMS_ENDPOINTS.createKpi.path, method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<ApiKpi>) => kpiFromApi(r.data),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    // PUT /pms-master/update/kpi/{id}.
    updatePmsKpi: builder.mutation<PmsKpi, { id: string; body: PmsKpiUpsert }>({
      query: ({ id, body }) => ({ url: `/pms-master/update/kpi/${id}`, method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<ApiKpi>) => kpiFromApi(r.data),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    // DELETE /pms-master/delete/kpi/{id}. 409 when a goal template uses it.
    deletePmsKpi: builder.mutation<void, string>({
      query: (id) => ({ url: `/pms-master/delete/kpi/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    // GET /pms-master/get/kpi-units: the units offered in the KPI form.
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
    // POST /pms-master/create/competency.
    createPmsCompetency: builder.mutation<PmsCompetency, PmsCompetencyUpsert>({
      query: (body) => ({ url: PMS_ENDPOINTS.createCompetency.path, method: 'POST', body: competencyToApi(body) }),
      transformResponse: (r: ApiEnvelope<ApiCompetency>) => competencyFromApi(r.data),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    // PUT /pms-master/update/competency/{id}.
    updatePmsCompetency: builder.mutation<PmsCompetency, { id: string; body: PmsCompetencyUpsert }>({
      query: ({ id, body }) => ({ url: `/pms-master/update/competency/${id}`, method: 'PUT', body: competencyToApi(body) }),
      transformResponse: (r: ApiEnvelope<ApiCompetency>) => competencyFromApi(r.data),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    // DELETE /pms-master/delete/competency/{id}. 409 when a goal template uses it.
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
    // GET /pms-master/get/standard-rating-levels: the standard levels offered when building a scale.
    getPmsStandardRatingLevels: builder.query<PmsStandardRatingLevel[], void>({
      query: () => '/pms-master/get/standard-rating-levels',
      transformResponse: (r: ApiEnvelope<ApiStandardRatingLevel[]>) => r.data.map(standardLevelFromApi),
      providesTags: [{ type: 'PmsRatingScale', id: 'STANDARDS' }],
    }),
    // POST /pms-master/create/standard-rating-level.
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
    /** Every employee under the manager's roles, for the role picker (3.2). `scope` is ignored by the real API. */
    getPmsRoleEmployees: builder.query<PmsTeamMember[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/team',
        params: { financial_year: financialYear, scope: 'role' },
      }),
      transformResponse: (r: ApiEnvelope<PmsTeamMember[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'TEAM' }],
    }),
    /**
     * "Create & assign template" (3.2): gives the role's active template to every report in the role who has
     * none. The employees' goal sheets then exist, so targets can be set one employee at a time.
     */
    assignRoleTemplate: builder.mutation<PmsTemplateAssignment, PmsAssignTemplateRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/assign-template', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsTemplateAssignment>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'TEAM' }],
    }),
    /** The team with the goal-status detail used by 3.6 (returned sheets, transfers). */
    getPmsTeamStatus: builder.query<PmsTeamMember[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/team',
        params: { financial_year: financialYear, scope: 'status' },
      }),
      transformResponse: (r: ApiEnvelope<PmsTeamMember[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'TEAM' }],
    }),
    // Screens 3.3-3.5, 3.7: GET /pms-goal-assignment/get/employee-targets (template KPIs with weights and targets).
    getPmsEmployeeTargets: builder.query<PmsEmployeeTargets, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-goal-assignment/get/employee-targets',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsTemplate', id: `TARGETS-${employeeUserId}` }],
    }),
    // PUT /pms-goal-assignment/update/employee-targets: saves a draft. Incomplete sheets are allowed.
    saveEmployeeTargets: builder.mutation<PmsEmployeeTargets, PmsTargetsRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/update/employee-targets', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: (_r, _e, body) => [{ type: 'PmsTemplate', id: 'TEAM' }, { type: 'PmsTemplate', id: `TARGETS-${body.employee_user_id}` }],
    }),
    // POST /pms-goal-assignment/validate: checks weights total 100 and targets are set.
    validateEmployeeTargets: builder.mutation<PmsTargetValidation, PmsTargetsRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/validate', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsTargetValidation>) => r.data,
    }),
    // POST /pms-goal-assignment/send: validates and sends the sheet to the employee.
    sendEmployeeTargets: builder.mutation<PmsEmployeeTargets, PmsTargetsRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/send', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: (_r, _e, body) => [{ type: 'PmsTemplate', id: 'TEAM' }, { type: 'PmsTemplate', id: `TARGETS-${body.employee_user_id}` }],
    }),
    // -- Employee goals and HOD approval (4.1 - 4.3, 5.1 - 5.2) --
    getPmsCopyPreview: builder.query<PmsCopyPreview, { previousYear: string; targetYear: string }>({
      query: ({ previousYear, targetYear }) => ({
        url: '/pms-goal-template/get/copy-preview',
        params: { previous_year: previousYear, target_year: targetYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsCopyPreview>) => r.data,
    }),
    // POST /pms-goal-template/copy: copies a previous year templates into the target year as drafts.
    copyPmsTemplates: builder.mutation<PmsCopyResult, { previous_year: string; target_year: string }>({
      query: (body) => ({ url: '/pms-goal-template/copy', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsCopyResult>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    // Screens 4.1, 4.5: GET /pms-goal-assignment/get/my-goals (the signed-in employee sheet).
    getPmsMyGoals: builder.query<PmsEmployeeTargets, string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/my-goals',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    // Screen 4.2: GET /pms-goal-assignment/get/my-change-requests. Every change request the employee made, with the
    // manager's answer (kept permanently).
    getPmsMyChangeRequests: builder.query<PmsChangeRequestRecord[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/my-change-requests',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsChangeRequestRecord[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    // Screen 3.7: GET /pms-goal-assignment/get/change-requests. One report's change requests for the manager.
    getPmsChangeRequests: builder.query<PmsChangeRequestRecord[], { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-goal-assignment/get/change-requests',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsChangeRequestRecord[]>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsTemplate', id: `TARGETS-${employeeUserId}` }],
    }),
    // Screen 4.3: POST /pms-goal-assignment/acknowledge (also used to acknowledge a revised target).
    acknowledgeMyGoals: builder.mutation<PmsEmployeeTargets, { financial_year: string; comment?: string }>({
      query: (body) => ({ url: '/pms-goal-assignment/acknowledge', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    // Screen 4.2: POST /pms-goal-assignment/request-change (KRA, proposed target, reason).
    requestGoalChange: builder.mutation<
      PmsEmployeeTargets,
      { financial_year: string; kpi_id: string; proposed_target: number | null; reason: string }
    >({
      query: (body) => ({ url: '/pms-goal-assignment/request-change', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'MY-GOALS' }],
    }),
    // Screen 5.1: GET /pms-goal-assignment/get/approvals (HOD queue).
    getPmsApprovals: builder.query<PmsApprovalItem[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/approvals',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsApprovalItem[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    // The bell: GET /pms-notification/get/my (written when a cycle is published) and POST /read.
    getPmsNotifications: builder.query<PmsNotifications, void>({
      query: () => '/pms-notification/get/my',
      transformResponse: (r: ApiEnvelope<PmsNotifications>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'BELL' }],
    }),
    markPmsNotificationsRead: builder.mutation<PmsNotifications, { ids?: string[] } | void>({
      query: (body) => ({ url: '/pms-notification/read', method: 'POST', body: body ?? {} }),
      transformResponse: (r: ApiEnvelope<PmsNotifications>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'BELL' }],
    }),
    // Stage windows (goal setting, acknowledgement, HOD approval) that concern me: GET /get/stage-notices.
    getPmsStageNotices: builder.query<PmsStageNotice[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/stage-notices',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsStageNotice[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'NOTICES' }],
    }),
    // HOD Goal Approvals list: GET /pms-goal-assignment/get/hod-queue (goal sheets and target revisions).
    getPmsHodQueue: builder.query<PmsHodQueueItem[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-assignment/get/hod-queue',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsHodQueueItem[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    // HOD review screen: GET /pms-goal-assignment/get/hod-review.
    getPmsHodReview: builder.query<
      PmsHodReview,
      { employeeUserId: string; financialYear: string; requestType: PmsHodRequestType }
    >({
      query: ({ employeeUserId, financialYear, requestType }) => ({
        url: '/pms-goal-assignment/get/hod-review',
        params: { employee_user_id: employeeUserId, financial_year: financialYear, request_type: requestType },
      }),
      transformResponse: (r: ApiEnvelope<PmsHodReview>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsTemplate', id: `HOD-${employeeUserId}` }],
    }),
    // POST /pms-goal-assignment/hod/approve: a whole goal sheet, or the selected KPIs of a target revision.
    hodApprove: builder.mutation<PmsHodReview, PmsHodActionRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/hod/approve', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsHodReview>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsTemplate', id: 'APPROVALS' },
        { type: 'PmsTemplate', id: 'HISTORY' },
        { type: 'PmsTemplate', id: `HOD-${b.employee_user_id}` },
      ],
    }),
    // POST /pms-goal-assignment/hod/return: remarks are required.
    hodReturn: builder.mutation<PmsHodReview, PmsHodActionRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/hod/return', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsHodReview>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsTemplate', id: 'APPROVALS' },
        { type: 'PmsTemplate', id: 'HISTORY' },
        { type: 'PmsTemplate', id: `HOD-${b.employee_user_id}` },
      ],
    }),
    // POST /pms-goal-assignment/hod/approve-selected: per-request results, a failure does not stop the rest.
    hodApproveSelected: builder.mutation<PmsHodBulkApproveResult, PmsHodBulkApproveRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/hod/approve-selected', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsHodBulkApproveResult>) => r.data,
      invalidatesTags: [
        { type: 'PmsTemplate', id: 'APPROVALS' },
        { type: 'PmsTemplate', id: 'HISTORY' },
      ],
    }),
    // Approval History: GET /pms-goal-assignment/get/hod-history.
    getPmsHodHistory: builder.query<
      PmsHodHistoryItem[],
      { financialYear: string; requestType?: string; decision?: string; search?: string }
    >({
      query: ({ financialYear, requestType, decision, search }) => ({
        url: '/pms-goal-assignment/get/hod-history',
        params: {
          financial_year: financialYear,
          ...(requestType ? { request_type: requestType } : {}),
          ...(decision ? { decision } : {}),
          ...(search ? { search } : {}),
        },
      }),
      transformResponse: (r: ApiEnvelope<PmsHodHistoryItem[]>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'HISTORY' }],
    }),
    // Trail: GET /pms-goal-assignment/get/hod-trail (every request and step of one employee).
    getPmsHodTrail: builder.query<PmsHodTrail, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-goal-assignment/get/hod-trail',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsHodTrail>) => r.data,
      providesTags: [{ type: 'PmsTemplate', id: 'HISTORY' }],
    }),
    // Screen 5.2: POST /pms-goal-assignment/approve.
    approveGoals: builder.mutation<PmsEmployeeTargets, { employee_user_id: string; financial_year: string; remarks?: string }>({
      query: (body) => ({ url: '/pms-goal-assignment/approve', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    // Screen 5.2: POST /pms-goal-assignment/return (a remark is required).
    returnGoals: builder.mutation<PmsEmployeeTargets, { employee_user_id: string; financial_year: string; remarks?: string }>({
      query: (body) => ({ url: '/pms-goal-assignment/return', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsEmployeeTargets>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'APPROVALS' }],
    }),
    // POST /pms-rating-scale/create/rating-scale.
    createPmsRatingScale: builder.mutation<PmsRatingScaleConfig, { name: string; body: PmsRatingScaleUpdate }>({
      query: ({ name, body }) => ({
        url: PMS_ENDPOINTS.listRatingScales.path.replace('/get/rating-scales', '/create/rating-scale'),
        method: 'POST',
        body: ratingScaleCreateToApi(name, body),
      }),
      transformResponse: (r: ApiEnvelope<ApiRatingScale>) => ratingScaleConfigFromApi(r.data),
      invalidatesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),
    // PUT /pms-rating-scale/update/rating-scale/{id}: the PUT replaces name and status too, so the current ones are carried over.
    updatePmsRatingScale: builder.mutation<PmsRatingScaleConfig, { id: string; body: PmsRatingScaleUpdate }>({
      queryFn: async ({ id, body }, api, _x, send: Send) => {
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
      queryFn: async (params, api, _x, send: Send) => {
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
        const lookups = await fetchLookups(api)
        const rows = unwrapEnvelope<ApiGoalTemplateListItem[]>(res)
        return { data: rows.map((t) => templateListItemFromApi(t, lookups)) }
      },
      providesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    // Screens 2.2-2.4: GET /pms-goal-template/get/goal-template/{id}.
    getPmsTemplate: builder.query<PmsGoalTemplate, string>({
      queryFn: async (id, api, _x, send: Send) => {
        const res = await send(`/pms-goal-template/get/goal-template/${id}`)
        if (res.error) return { error: res.error }
        return { data: templateFromApi(unwrapEnvelope<ApiGoalTemplate>(res), await fetchLookups(api)) }
      },
      providesTags: (_r, _e, id) => [{ type: 'PmsTemplate', id }],
    }),
    /**
     * The FE saves a template in one call, the API in three: basic info, then
     * KRA/KPI, then competencies. A failure after the first step leaves the
     * basic info saved; retrying from the wizard will create a second template.
     */
    createPmsTemplate: builder.mutation<PmsGoalTemplate, PmsGoalTemplateUpsert>({
      queryFn: async (body, api, _x, send: Send) => {
        const created = await send({
          url: PMS_ENDPOINTS.createTemplate.path,
          method: 'POST',
          body: templateBasicToApi(body.basic),
        })
        if (created.error) return { error: created.error }
        const id = unwrapEnvelope<ApiGoalTemplate>(created).id
        return saveTemplateChildren(send, api, id, body)
      },
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    // Updates a template with the same three calls: basic info, KRA/KPI, competencies.
    updatePmsTemplate: builder.mutation<PmsGoalTemplate, { id: string; body: PmsGoalTemplateUpsert }>({
      queryFn: async ({ id, body }, api, _x, send: Send) => {
        const basic = await send({
          url: `/pms-goal-template/update/goal-template/${id}`,
          method: 'PUT',
          body: templateBasicToApi(body.basic),
        })
        if (basic.error) return { error: basic.error }
        return saveTemplateChildren(send, api, id, body)
      },
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PmsTemplate', id: 'LIST' }, { type: 'PmsTemplate', id }],
    }),
    // PUT /pms-goal-template/update/goal-template/{id}/status: activate or deactivate.
    setPmsTemplateStatus: builder.mutation<PmsGoalTemplate, { id: string; status: PmsTemplateStatus }>({
      queryFn: async ({ id, status }, api, _x, send: Send) => {
        const res = await send({
          url: `/pms-goal-template/update/goal-template/${id}/status`,
          method: 'PUT',
          body: { status },
        })
        if (res.error) return { error: res.error }
        return { data: templateFromApi(unwrapEnvelope<ApiGoalTemplate>(res), await fetchLookups(api)) }
      },
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PmsTemplate', id: 'LIST' }, { type: 'PmsTemplate', id }],
    }),
    // POST /pms-goal-template/duplicate/goal-template/{id}: a draft copy.
    duplicatePmsTemplate: builder.mutation<PmsGoalTemplate, string>({
      queryFn: async (id, api, _x, send: Send) => {
        const res = await send({ url: `/pms-goal-template/duplicate/goal-template/${id}`, method: 'POST' })
        if (res.error) return { error: res.error }
        return { data: templateFromApi(unwrapEnvelope<ApiGoalTemplate>(res), await fetchLookups(api)) }
      },
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    // DELETE /pms-goal-template/delete/goal-template/{id}.
    deletePmsTemplate: builder.mutation<void, string>({
      query: (id) => ({ url: `/pms-goal-template/delete/goal-template/${id}`, method: 'DELETE' }),
      transformResponse: () => undefined,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    // -- Manager screens 3.6 - 3.14: transfers, progress, mid-year, appraisal --
    getPmsTransferNotices: builder.query<PmsTransferNotice[], string>({
      query: (financialYear) => ({
        url: '/pms-goal-transfer/get/notices',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsTransferNotice[]>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'TRANSFERS' }],
    }),
    // Screen 3.6: POST /pms-goal-assignment/send-to-hod (acknowledged sheets only).
    sendGoalsToHod: builder.mutation<string[], PmsSendToHodRequest>({
      query: (body) => ({ url: '/pms-goal-assignment/send-to-hod', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<string[]>) => r.data,
      invalidatesTags: [{ type: 'PmsTemplate', id: 'TEAM' }],
    }),
    // Screen 3.8: GET /pms-goal-transfer/get/transfer-sheet (frozen period 1 and editable period 2 KRAs).
    getPmsTransferGoalSheet: builder.query<PmsTransferGoalSheet, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-goal-transfer/get/transfer-sheet',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsTransferGoalSheet>) => ({
        ...r.data,
        reason: r.data.reason ?? '',
        remarks: r.data.remarks ?? '',
      }),
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsManager', id: `TRANSFER-${employeeUserId}` }],
    }),
    // PUT /pms-goal-transfer/update/transfer-sheet: saves a draft.
    saveTransferGoalSheet: builder.mutation<PmsTransferGoalSheet, PmsTransferGoalSheetRequest>({
      query: (body) => ({ url: '/pms-goal-transfer/update/transfer-sheet', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsTransferGoalSheet>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: `TRANSFER-${b.employee_user_id}` },
        { type: 'PmsManager', id: 'TRANSFERS' },
      ],
    }),
    // POST /pms-goal-transfer/send/transfer-sheet: validates and sends to the employee.
    sendTransferGoalSheet: builder.mutation<PmsTransferGoalSheet, PmsTransferGoalSheetRequest>({
      query: (body) => ({ url: '/pms-goal-transfer/send/transfer-sheet', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsTransferGoalSheet>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: `TRANSFER-${b.employee_user_id}` },
        { type: 'PmsManager', id: 'TRANSFERS' },
        { type: 'PmsTemplate', id: 'TEAM' },
      ],
    }),
    // Screen 3.9: GET /pms-progress/get/team.
    getPmsTeamProgress: builder.query<PmsTeamProgressRow[], string>({
      query: (financialYear) => ({ url: '/pms-progress/get/team', params: { financial_year: financialYear } }),
      transformResponse: (r: ApiEnvelope<PmsTeamProgressRow[]>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'PROGRESS' }],
    }),
    // Screen 3.10: GET /pms-mid-year/get/team.
    getPmsMidYearTeam: builder.query<PmsMidYearRow[], string>({
      query: (financialYear) => ({ url: '/pms-mid-year/get/team', params: { financial_year: financialYear } }),
      transformResponse: (r: ApiEnvelope<PmsMidYearRow[]>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'MID-YEAR' }],
    }),
    // Screen 3.11: GET /pms-mid-year/get/review.
    getPmsMidYearReview: builder.query<PmsMidYearReview, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-mid-year/get/review',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsMidYearReview>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsManager', id: `MID-YEAR-${employeeUserId}` }],
    }),
    // Screen 3.11: POST /pms-mid-year/submit/review (discussion notes and the revision decision).
    submitPmsMidYearReview: builder.mutation<PmsMidYearReview, PmsMidYearSubmit>({
      query: (body) => ({ url: '/pms-mid-year/submit/review', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsMidYearReview>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'MID-YEAR' },
        { type: 'PmsManager', id: `MID-YEAR-${b.employee_user_id}` },
      ],
    }),
    // Screen 3.12: GET /pms-mid-year/get/revision-request.
    getPmsRevisionRequest: builder.query<PmsRevisionRequest, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-mid-year/get/revision-request',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsRevisionRequest>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsManager', id: `MID-YEAR-${employeeUserId}` }],
    }),
    // Screen 3.12: POST /pms-mid-year/submit/revision-request (changed targets only).
    submitPmsRevisionRequest: builder.mutation<PmsRevisionRequest, PmsRevisionSubmit>({
      query: (body) => ({ url: '/pms-mid-year/submit/revision-request', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsRevisionRequest>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'MID-YEAR' },
        { type: 'PmsManager', id: `MID-YEAR-${b.employee_user_id}` },
      ],
    }),
    // Screen 3.13: GET /pms-appraisal/get/team.
    getPmsTeamAppraisal: builder.query<PmsTeamAppraisalRow[], string>({
      query: (financialYear) => ({ url: '/pms-appraisal/get/team', params: { financial_year: financialYear } }),
      transformResponse: (r: ApiEnvelope<PmsTeamAppraisalRow[]>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'APPRAISAL' }],
    }),
    // Screen 3.14: GET /pms-appraisal/get/manager-appraisal (409 until the employee submits).
    getPmsManagerAppraisal: builder.query<PmsManagerAppraisal, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-appraisal/get/manager-appraisal',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsManagerAppraisal>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsManager', id: `APPRAISAL-${employeeUserId}` }],
    }),
    // Screen 3.14: PUT /pms-appraisal/update/manager-appraisal (draft).
    savePmsManagerAppraisal: builder.mutation<PmsManagerAppraisal, PmsManagerAppraisalSave>({
      query: (body) => ({ url: '/pms-appraisal/update/manager-appraisal', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsManagerAppraisal>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'APPRAISAL' },
        { type: 'PmsManager', id: `APPRAISAL-${b.employee_user_id}` },
      ],
    }),
    // Screen 3.14: POST /pms-appraisal/submit/manager-appraisal (to the HOD; 422 when incomplete).
    submitPmsManagerAppraisal: builder.mutation<PmsManagerAppraisal, PmsManagerAppraisalSave>({
      query: (body) => ({ url: '/pms-appraisal/submit/manager-appraisal', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsManagerAppraisal>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'APPRAISAL' },
        { type: 'PmsManager', id: `APPRAISAL-${b.employee_user_id}` },
      ],
    }),

    // -- Employee: progress update (4.4) and self appraisal (4.6) --
    getPmsMyProgress: builder.query<PmsMyProgress, string>({
      query: (financialYear) => ({
        url: '/pms-progress/get/my-progress',
        params: { financial_year: financialYear, period: 'current' },
      }),
      transformResponse: (r: ApiEnvelope<PmsMyProgress>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'MY-PROGRESS' }],
    }),
    // Screen 4.4: PUT /pms-progress/update/my-progress (draft or submit).
    savePmsMyProgress: builder.mutation<{ updated: number }, PmsMyProgressSave>({
      query: (body) => ({ url: '/pms-progress/update/my-progress', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<{ updated: number }>) => r.data,
      invalidatesTags: [
        { type: 'PmsManager', id: 'MY-PROGRESS' },
        { type: 'PmsTemplate', id: 'MY-GOALS' },
      ],
    }),
    // Screen 4.6: GET /pms-appraisal/get/self-appraisal (KRAs and competencies with the ratings given so far).
    getPmsMySelfAppraisal: builder.query<PmsMySelfAppraisal, string>({
      query: (financialYear) => ({ url: '/pms-appraisal/get/self-appraisal', params: { financial_year: financialYear } }),
      // The API sends null for text the employee has not typed yet; the form wants strings.
      transformResponse: (r: ApiEnvelope<PmsMySelfAppraisal>) => ({
        ...r.data,
        kras: r.data.kras.map((k) => ({ ...k, evidence: k.evidence ?? '' })),
        competencies: r.data.competencies.map((c) => ({ ...c, comment: c.comment ?? '' })),
      }),
      providesTags: [{ type: 'PmsManager', id: 'MY-SELF' }],
    }),
    // Screen 4.6: PUT /pms-appraisal/update/self-appraisal (draft or submit).
    savePmsMySelfAppraisal: builder.mutation<{ status: string; self_score: number | null }, PmsMySelfAppraisalSave>({
      query: (body) => ({ url: '/pms-appraisal/update/self-appraisal', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<{ status: string; self_score: number | null }>) => r.data,
      invalidatesTags: [{ type: 'PmsManager', id: 'MY-SELF' }],
    }),

    // -- Corporate HR: HR competency rating and calibration (1.7 - 1.9) --
    getPmsHrQueue: builder.query<PmsHrQueueRow[], string>({
      query: (financialYear) => ({ url: '/pms-hr-appraisal/get/queue', params: { financial_year: financialYear } }),
      transformResponse: (r: ApiEnvelope<PmsHrQueueRow[]>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'HR-QUEUE' }],
    }),
    // Screen 1.8: GET /pms-hr-appraisal/get/employee.
    getPmsHrAppraisal: builder.query<PmsHrAppraisal, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-hr-appraisal/get/employee',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsHrAppraisal>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsManager', id: `HR-${employeeUserId}` }],
    }),
    // Screen 1.8: PUT /pms-hr-appraisal/update/hr-ratings (draft).
    savePmsHrAppraisal: builder.mutation<PmsHrAppraisal, PmsHrAppraisalSave>({
      query: (body) => ({ url: '/pms-hr-appraisal/update/hr-ratings', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsHrAppraisal>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'HR-QUEUE' },
        { type: 'PmsManager', id: `HR-${b.employee_user_id}` },
      ],
    }),
    // Screen 1.8: POST /pms-hr-appraisal/submit/hr-ratings (every HR competency rated).
    submitPmsHrAppraisal: builder.mutation<PmsHrAppraisal, PmsHrAppraisalSave>({
      query: (body) => ({ url: '/pms-hr-appraisal/submit/hr-ratings', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsHrAppraisal>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'HR-QUEUE' },
        { type: 'PmsManager', id: `HR-${b.employee_user_id}` },
      ],
    }),
    // Screen 1.7: POST /pms-hr-appraisal/send/calibration (rated employees only).
    sendPmsToCalibration: builder.mutation<{ sent: number }, PmsSendToCalibration>({
      query: (body) => ({ url: '/pms-hr-appraisal/send/calibration', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<{ sent: number }>) => r.data,
      invalidatesTags: [
        { type: 'PmsManager', id: 'HR-QUEUE' },
        { type: 'PmsManager', id: 'CALIBRATION' },
      ],
    }),
    // -- Functional Head: L2 appraisal rating (5.6 - 5.7) --
    // Screen 5.7: GET /pms-appraisal-hod/get/queue.
    getPmsAppraisalHodQueue: builder.query<PmsAppraisalHodQueueRow[], string>({
      query: (financialYear) => ({
        url: '/pms-appraisal-hod/get/queue',
        params: { financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsAppraisalHodQueueRow[]>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'HOD-APPRAISAL-QUEUE' }],
    }),
    // Screen 5.6: GET /pms-appraisal-hod/get/employee.
    getPmsAppraisalHodReview: builder.query<PmsAppraisalHodReview, { employeeUserId: string; financialYear: string }>({
      query: ({ employeeUserId, financialYear }) => ({
        url: '/pms-appraisal-hod/get/employee',
        params: { employee_user_id: employeeUserId, financial_year: financialYear },
      }),
      transformResponse: (r: ApiEnvelope<PmsAppraisalHodReview>) => r.data,
      providesTags: (_r, _e, { employeeUserId }) => [{ type: 'PmsManager', id: `HOD-APPRAISAL-${employeeUserId}` }],
    }),
    // Screen 5.6: PUT /pms-appraisal-hod/update/hod-ratings (draft).
    savePmsAppraisalHod: builder.mutation<PmsAppraisalHodReview, PmsAppraisalHodSave>({
      query: (body) => ({ url: '/pms-appraisal-hod/update/hod-ratings', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsAppraisalHodReview>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'HOD-APPRAISAL-QUEUE' },
        { type: 'PmsManager', id: `HOD-APPRAISAL-${b.employee_user_id}` },
      ],
    }),
    // Screen 5.6: POST /pms-appraisal-hod/submit/hod-ratings (every KRA and manager competency rated).
    submitPmsAppraisalHod: builder.mutation<PmsAppraisalHodReview, PmsAppraisalHodSave>({
      query: (body) => ({ url: '/pms-appraisal-hod/submit/hod-ratings', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsAppraisalHodReview>) => r.data,
      invalidatesTags: (_r, _e, b) => [
        { type: 'PmsManager', id: 'HOD-APPRAISAL-QUEUE' },
        { type: 'PmsManager', id: `HOD-APPRAISAL-${b.employee_user_id}` },
        { type: 'PmsManager', id: 'HR-QUEUE' },
      ],
    }),

    // Screen 1.9: GET /pms-calibration/get/calibration.
    getPmsCalibration: builder.query<PmsCalibration, string>({
      query: (financialYear) => ({ url: '/pms-calibration/get/calibration', params: { financial_year: financialYear } }),
      transformResponse: (r: ApiEnvelope<PmsCalibration>) => r.data,
      providesTags: [{ type: 'PmsManager', id: 'CALIBRATION' }],
    }),
    // Screen 1.9: PUT /pms-calibration/update/calibration (targets and calibrated ratings).
    savePmsCalibration: builder.mutation<PmsCalibration, PmsCalibrationSave>({
      query: (body) => ({ url: '/pms-calibration/update/calibration', method: 'PUT', body }),
      transformResponse: (r: ApiEnvelope<PmsCalibration>) => r.data,
      invalidatesTags: [{ type: 'PmsManager', id: 'CALIBRATION' }],
    }),
    // Screen 1.9: POST /pms-calibration/publish/calibration (422 unless HR targets total 100%).
    publishPmsCalibration: builder.mutation<PmsCalibration, { financial_year: string }>({
      query: (body) => ({ url: '/pms-calibration/publish/calibration', method: 'POST', body }),
      transformResponse: (r: ApiEnvelope<PmsCalibration>) => r.data,
      invalidatesTags: [
        { type: 'PmsManager', id: 'CALIBRATION' },
        { type: 'PmsManager', id: 'HR-QUEUE' },
      ],
    }),
  }),
})

/** Steps 2 and 3 of a template save, against an id that already exists. */
async function saveTemplateChildren(send: Send, api: BaseQueryApi, id: string, body: PmsGoalTemplateUpsert) {
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

  return { data: templateFromApi(unwrapEnvelope<ApiGoalTemplate>(comps), await fetchLookups(api)) }
}

// One generated hook per endpoint above: useXxxQuery for queries, useXxxMutation for mutations.
export const {
  useGetPmsCyclesQuery,
  useGetPmsCycleQuery,
  useCreatePmsCycleMutation,
  useUpdatePmsCycleMutation,
  usePublishPmsCycleMutation,
  useGetPmsCycleActivationQuery,
  useCancelPmsCycleMutation,
  useExportPmsCyclesMutation,
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
  useGetPmsTeamQuery,
  useGetPmsRoleEmployeesQuery,
  useAssignRoleTemplateMutation,
  useGetPmsTeamStatusQuery,
  useGetPmsEmployeeTargetsQuery,
  useSaveEmployeeTargetsMutation,
  useValidateEmployeeTargetsMutation,
  useSendEmployeeTargetsMutation,
  useGetPmsCopyPreviewQuery,
  useCopyPmsTemplatesMutation,
  useGetPmsMyGoalsQuery,
  useGetPmsMyChangeRequestsQuery,
  useGetPmsChangeRequestsQuery,
  useAcknowledgeMyGoalsMutation,
  useRequestGoalChangeMutation,
  useGetPmsApprovalsQuery,
  useApproveGoalsMutation,
  useReturnGoalsMutation,
  useGetPmsTransferNoticesQuery,
  useSendGoalsToHodMutation,
  useGetPmsStageNoticesQuery,
  useGetPmsNotificationsQuery,
  useMarkPmsNotificationsReadMutation,
  useGetPmsApprovalWorkflowsQuery,
  useCreatePmsApprovalWorkflowMutation,
  useUpdatePmsApprovalWorkflowMutation,
  useDeletePmsApprovalWorkflowMutation,
  useGetPmsHodQueueQuery,
  useGetPmsHodReviewQuery,
  useHodApproveMutation,
  useHodReturnMutation,
  useHodApproveSelectedMutation,
  useGetPmsHodHistoryQuery,
  useGetPmsHodTrailQuery,
  useGetPmsTransferGoalSheetQuery,
  useSaveTransferGoalSheetMutation,
  useSendTransferGoalSheetMutation,
  useGetPmsTeamProgressQuery,
  useGetPmsMidYearTeamQuery,
  useGetPmsMidYearReviewQuery,
  useSubmitPmsMidYearReviewMutation,
  useGetPmsRevisionRequestQuery,
  useSubmitPmsRevisionRequestMutation,
  useGetPmsTeamAppraisalQuery,
  useGetPmsManagerAppraisalQuery,
  useSavePmsManagerAppraisalMutation,
  useSubmitPmsManagerAppraisalMutation,
  useGetPmsMyProgressQuery,
  useSavePmsMyProgressMutation,
  useGetPmsMySelfAppraisalQuery,
  useSavePmsMySelfAppraisalMutation,
  useGetPmsHrQueueQuery,
  useGetPmsHrAppraisalQuery,
  useSavePmsHrAppraisalMutation,
  useSubmitPmsHrAppraisalMutation,
  useSendPmsToCalibrationMutation,
  useGetPmsAppraisalHodQueueQuery,
  useGetPmsAppraisalHodReviewQuery,
  useSavePmsAppraisalHodMutation,
  useSubmitPmsAppraisalHodMutation,
  useGetPmsCalibrationQuery,
  useSavePmsCalibrationMutation,
  usePublishPmsCalibrationMutation,
} = pmsApi
