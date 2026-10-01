import { createApi } from '@reduxjs/toolkit/query/react'
import type { FetchBaseQueryError } from '@reduxjs/toolkit/query'
import { createBaseQuery } from './baseQuery'
import {
  mockCancelCycle,
  mockCreateCycle,
  mockEligibilityPreview,
  mockExportCyclesCsv,
  mockGetActivation,
  mockGetCycle,
  mockLatency,
  mockListCycles,
  mockPublishCycle,
  mockUpdateCycle,
  MOCK_DEPARTMENTS,
  MOCK_PLANTS,
} from './mocks/pmsCycleMock'
import {
  mockCreateCompetency,
  mockCreateKpi,
  mockCreateKra,
  mockCreateTemplate,
  mockDeleteCompetency,
  mockDeleteKpi,
  mockDeleteKra,
  mockDeleteTemplate,
  mockDuplicateTemplate,
  mockGetTemplate,
  mockListCompetencies,
  mockListDesignations,
  mockListKpis,
  mockListKras,
  mockListRatingScales,
  mockListTemplates,
  mockSetTemplateStatus,
  mockUpdateCompetency,
  mockUpdateKpi,
  mockUpdateKra,
  mockUpdateRatingScale,
  mockUpdateTemplate,
  MOCK_KPI_UNITS,
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
  PmsTemplateStatus,
} from '@/types/pms-config'

const PMS_BASE_URL = (import.meta.env.VITE_PMS_API_BASE_URL as string | undefined) ?? ''

/**
 * PMS REST contract — hand this to the backend. Full request / response
 * shapes live in `src/types/pms.ts`; the narrative is in
 * `docs/pms/PMS_CYCLE_API_CONTRACT.md`.
 *
 * Every endpoint below currently resolves from static mock data (`queryFn`).
 * To go live, replace an endpoint's `queryFn` with the commented `query`
 * line — hooks, tags and the pages stay untouched.
 */
export const PMS_ENDPOINTS = {
  listCycles: { method: 'GET', path: '/pms/cycles' },
  getCycle: { method: 'GET', path: '/pms/cycles/{cycle_id}' },
  createCycle: { method: 'POST', path: '/pms/cycles' },
  updateCycle: { method: 'PUT', path: '/pms/cycles/{cycle_id}' },
  publishCycle: { method: 'POST', path: '/pms/cycles/{cycle_id}/publish' },
  getActivation: { method: 'GET', path: '/pms/cycles/{cycle_id}/activation' },
  cancelCycle: { method: 'POST', path: '/pms/cycles/{cycle_id}/cancel' },
  exportCycles: { method: 'GET', path: '/pms/cycles/export' },
  eligibilityPreview: { method: 'POST', path: '/pms/cycles/eligible-employees/preview' },
  plants: { method: 'GET', path: '/pms/lookups/plants' },
  departments: { method: 'GET', path: '/pms/lookups/departments' },
  ratingScales: { method: 'GET', path: '/pms/rating-scales' },

  // -- Configuration --
  listKras: { method: 'GET', path: '/pms/kras' },
  createKra: { method: 'POST', path: '/pms/kras' },
  updateKra: { method: 'PUT', path: '/pms/kras/{kra_id}' },
  deleteKra: { method: 'DELETE', path: '/pms/kras/{kra_id}' },
  listKpis: { method: 'GET', path: '/pms/kpis' },
  createKpi: { method: 'POST', path: '/pms/kpis' },
  updateKpi: { method: 'PUT', path: '/pms/kpis/{kpi_id}' },
  deleteKpi: { method: 'DELETE', path: '/pms/kpis/{kpi_id}' },
  listCompetencies: { method: 'GET', path: '/pms/competencies' },
  createCompetency: { method: 'POST', path: '/pms/competencies' },
  updateCompetency: { method: 'PUT', path: '/pms/competencies/{competency_id}' },
  deleteCompetency: { method: 'DELETE', path: '/pms/competencies/{competency_id}' },
  listRatingScales: { method: 'GET', path: '/pms/rating-scales/config' },
  updateRatingScale: { method: 'PUT', path: '/pms/rating-scales/{scale_id}' },
  listTemplates: { method: 'GET', path: '/pms/goal-templates' },
  getTemplate: { method: 'GET', path: '/pms/goal-templates/{template_id}' },
  createTemplate: { method: 'POST', path: '/pms/goal-templates' },
  updateTemplate: { method: 'PUT', path: '/pms/goal-templates/{template_id}' },
  setTemplateStatus: { method: 'PATCH', path: '/pms/goal-templates/{template_id}/status' },
  duplicateTemplate: { method: 'POST', path: '/pms/goal-templates/{template_id}/duplicate' },
  deleteTemplate: { method: 'DELETE', path: '/pms/goal-templates/{template_id}' },
  designations: { method: 'GET', path: '/pms/lookups/designations' },
  kpiUnits: { method: 'GET', path: '/pms/lookups/kpi-units' },
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

// Two cache buckets under one tag: LIST → the cycles table, id → one cycle.
const LIST_TAG = { type: 'PmsCycle' as const, id: 'LIST' }

export const pmsApi = createApi({
  reducerPath: 'pmsApi',
  baseQuery: createBaseQuery(PMS_BASE_URL),
  tagTypes: ['PmsCycle', 'PmsKra', 'PmsKpi', 'PmsCompetency', 'PmsRatingScale', 'PmsTemplate'],
  endpoints: (builder) => ({
    getPmsCycles: builder.query<PmsCycleListResponse, PmsCycleListParams | void>({
      // query: (params) => ({ url: PMS_ENDPOINTS.listCycles.path, params }),
      queryFn: (params) => mock(() => mockListCycles(params ?? {})),
      providesTags: [LIST_TAG],
    }),

    getPmsCycle: builder.query<PmsCycle, string>({
      // query: (id) => `/pms/cycles/${id}`,
      queryFn: (id) => mock(() => mockGetCycle(id)),
      providesTags: (_r, _e, id) => [{ type: 'PmsCycle', id }],
    }),

    /** Creates the cycle as `draft`. Publishing is a separate call. */
    createPmsCycle: builder.mutation<PmsCycle, PmsCycleUpsert>({
      // query: (body) => ({ url: '/pms/cycles', method: 'POST', body }),
      queryFn: (body) => mock(() => mockCreateCycle(body)),
      invalidatesTags: [LIST_TAG],
    }),

    updatePmsCycle: builder.mutation<PmsCycle, { id: string; body: PmsCycleUpsert }>({
      // query: ({ id, body }) => ({ url: `/pms/cycles/${id}`, method: 'PUT', body }),
      queryFn: ({ id, body }) => mock(() => mockUpdateCycle(id, body)),
      invalidatesTags: (_r, _e, { id }) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** draft → active. Triggers the eligibility run and the notifications. */
    publishPmsCycle: builder.mutation<PmsCycleActivation, string>({
      // query: (id) => ({ url: `/pms/cycles/${id}/publish`, method: 'POST' }),
      queryFn: (id) => mock(() => mockPublishCycle(id), 900),
      invalidatesTags: (_r, _e, id) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** What publishing did — the notification counts behind screen 1.6. */
    getPmsCycleActivation: builder.query<PmsCycleActivation, string>({
      // query: (id) => `/pms/cycles/${id}/activation`,
      queryFn: (id) => mock(() => mockGetActivation(id)),
      providesTags: (_r, _e, id) => [{ type: 'PmsCycle', id }],
    }),

    cancelPmsCycle: builder.mutation<PmsCycle, string>({
      // query: (id) => ({ url: `/pms/cycles/${id}/cancel`, method: 'POST' }),
      queryFn: (id) => mock(() => mockCancelCycle(id)),
      invalidatesTags: (_r, _e, id) => [LIST_TAG, { type: 'PmsCycle', id }],
    }),

    /** Honours the same filters as the list; returns the file as a blob. */
    exportPmsCycles: builder.mutation<Blob, PmsCycleListParams | void>({
      // query: (params) => ({ url: '/pms/cycles/export', params, responseHandler: (r) => r.blob() }),
      queryFn: (params) => mock(() => mockExportCyclesCsv(params ?? {})),
    }),

    previewEligibleEmployees: builder.mutation<PmsEligibilityPreview, PmsCycleApplicability>({
      // query: (body) => ({ url: '/pms/cycles/eligible-employees/preview', method: 'POST', body }),
      queryFn: (body) => mock(() => mockEligibilityPreview(body), 500),
    }),

    getPmsPlants: builder.query<PmsLookupOption[], void>({
      // query: () => '/pms/lookups/plants',
      queryFn: () => mock(() => MOCK_PLANTS, 150),
    }),

    getPmsDepartments: builder.query<PmsLookupOption[], void>({
      // query: () => '/pms/lookups/departments',
      queryFn: () => mock(() => MOCK_DEPARTMENTS, 150),
    }),

    /** Lookup for the cycle wizard - the same scales as the Rating Scale screen, trimmed. */
    getPmsRatingScales: builder.query<PmsRatingScale[], void>({
      // query: () => '/pms/rating-scales',
      queryFn: () =>
        mock(
          () =>
            mockListRatingScales().map((sc) => ({
              id: sc.id,
              name: sc.name,
              levels: sc.levels.map((l) => ({ value: l.rating, label: l.label, description: l.definition })),
            })),
          150,
        ),
      providesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),

    // -- KRA Master --
    getPmsKras: builder.query<PmsKra[], void>({
      // query: () => '/pms/kras',
      queryFn: () => mock(() => mockListKras()),
      providesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),
    createPmsKra: builder.mutation<PmsKra, PmsKraUpsert>({
      // query: (body) => ({ url: '/pms/kras', method: 'POST', body }),
      queryFn: (body) => mock(() => mockCreateKra(body)),
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),
    updatePmsKra: builder.mutation<PmsKra, { id: string; body: PmsKraUpsert }>({
      // query: ({ id, body }) => ({ url: `/pms/kras/${id}`, method: 'PUT', body }),
      queryFn: ({ id, body }) => mock(() => mockUpdateKra(id, body)),
      // KPI rows carry the KRA name, so they go stale too.
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }, { type: 'PmsKpi', id: 'LIST' }],
    }),
    deletePmsKra: builder.mutation<void, string>({
      // query: (id) => ({ url: `/pms/kras/${id}`, method: 'DELETE' }),
      queryFn: (id) => mock(() => mockDeleteKra(id)),
      invalidatesTags: [{ type: 'PmsKra', id: 'LIST' }],
    }),

    // -- KPI Master --
    getPmsKpis: builder.query<PmsKpi[], void>({
      // query: () => '/pms/kpis',
      queryFn: () => mock(() => mockListKpis()),
      providesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    createPmsKpi: builder.mutation<PmsKpi, PmsKpiUpsert>({
      // query: (body) => ({ url: '/pms/kpis', method: 'POST', body }),
      queryFn: (body) => mock(() => mockCreateKpi(body)),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    updatePmsKpi: builder.mutation<PmsKpi, { id: string; body: PmsKpiUpsert }>({
      // query: ({ id, body }) => ({ url: `/pms/kpis/${id}`, method: 'PUT', body }),
      queryFn: ({ id, body }) => mock(() => mockUpdateKpi(id, body)),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    deletePmsKpi: builder.mutation<void, string>({
      // query: (id) => ({ url: `/pms/kpis/${id}`, method: 'DELETE' }),
      queryFn: (id) => mock(() => mockDeleteKpi(id)),
      invalidatesTags: [{ type: 'PmsKpi', id: 'LIST' }],
    }),
    getPmsKpiUnits: builder.query<string[], void>({
      // query: () => '/pms/lookups/kpi-units',
      queryFn: () => mock(() => MOCK_KPI_UNITS, 100),
    }),

    // -- Competency Master --
    getPmsCompetencies: builder.query<PmsCompetency[], void>({
      // query: () => '/pms/competencies',
      queryFn: () => mock(() => mockListCompetencies()),
      providesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    createPmsCompetency: builder.mutation<PmsCompetency, PmsCompetencyUpsert>({
      // query: (body) => ({ url: '/pms/competencies', method: 'POST', body }),
      queryFn: (body) => mock(() => mockCreateCompetency(body)),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    updatePmsCompetency: builder.mutation<PmsCompetency, { id: string; body: PmsCompetencyUpsert }>({
      // query: ({ id, body }) => ({ url: `/pms/competencies/${id}`, method: 'PUT', body }),
      queryFn: ({ id, body }) => mock(() => mockUpdateCompetency(id, body)),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),
    deletePmsCompetency: builder.mutation<void, string>({
      // query: (id) => ({ url: `/pms/competencies/${id}`, method: 'DELETE' }),
      queryFn: (id) => mock(() => mockDeleteCompetency(id)),
      invalidatesTags: [{ type: 'PmsCompetency', id: 'LIST' }],
    }),

    // -- Rating Scale (full config) --
    getPmsRatingScaleConfigs: builder.query<PmsRatingScaleConfig[], void>({
      // query: () => '/pms/rating-scales/config',
      queryFn: () => mock(() => mockListRatingScales()),
      providesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),
    updatePmsRatingScale: builder.mutation<PmsRatingScaleConfig, { id: string; body: PmsRatingScaleUpdate }>({
      // query: ({ id, body }) => ({ url: `/pms/rating-scales/${id}`, method: 'PUT', body }),
      queryFn: ({ id, body }) => mock(() => mockUpdateRatingScale(id, body)),
      invalidatesTags: [{ type: 'PmsRatingScale', id: 'LIST' }],
    }),

    // -- Goal Templates --
    getPmsTemplates: builder.query<PmsGoalTemplateListItem[], PmsGoalTemplateListParams | void>({
      // query: (params) => ({ url: '/pms/goal-templates', params }),
      queryFn: (params) => mock(() => mockListTemplates(params ?? {})),
      providesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    getPmsTemplate: builder.query<PmsGoalTemplate, string>({
      // query: (id) => `/pms/goal-templates/${id}`,
      queryFn: (id) => mock(() => mockGetTemplate(id)),
      providesTags: (_r, _e, id) => [{ type: 'PmsTemplate', id }],
    }),
    createPmsTemplate: builder.mutation<PmsGoalTemplate, PmsGoalTemplateUpsert>({
      // query: (body) => ({ url: '/pms/goal-templates', method: 'POST', body }),
      queryFn: (body) => mock(() => mockCreateTemplate(body)),
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    updatePmsTemplate: builder.mutation<PmsGoalTemplate, { id: string; body: PmsGoalTemplateUpsert }>({
      // query: ({ id, body }) => ({ url: `/pms/goal-templates/${id}`, method: 'PUT', body }),
      queryFn: ({ id, body }) => mock(() => mockUpdateTemplate(id, body)),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PmsTemplate', id: 'LIST' }, { type: 'PmsTemplate', id }],
    }),
    setPmsTemplateStatus: builder.mutation<PmsGoalTemplate, { id: string; status: PmsTemplateStatus }>({
      // query: ({ id, status }) => ({ url: `/pms/goal-templates/${id}/status`, method: 'PATCH', body: { status } }),
      queryFn: ({ id, status }) => mock(() => mockSetTemplateStatus(id, status)),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PmsTemplate', id: 'LIST' }, { type: 'PmsTemplate', id }],
    }),
    duplicatePmsTemplate: builder.mutation<PmsGoalTemplate, string>({
      // query: (id) => ({ url: `/pms/goal-templates/${id}/duplicate`, method: 'POST' }),
      queryFn: (id) => mock(() => mockDuplicateTemplate(id)),
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    deletePmsTemplate: builder.mutation<void, string>({
      // query: (id) => ({ url: `/pms/goal-templates/${id}`, method: 'DELETE' }),
      queryFn: (id) => mock(() => mockDeleteTemplate(id)),
      invalidatesTags: [{ type: 'PmsTemplate', id: 'LIST' }],
    }),
    getPmsDesignations: builder.query<PmsDesignationOption[], string | void>({
      // query: (departmentId) => ({ url: '/pms/lookups/designations', params: { department_id: departmentId } }),
      queryFn: (departmentId) => mock(() => mockListDesignations(departmentId || undefined), 120),
    }),
  }),
})

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
  useGetPmsTemplatesQuery,
  useGetPmsTemplateQuery,
  useCreatePmsTemplateMutation,
  useUpdatePmsTemplateMutation,
  useSetPmsTemplateStatusMutation,
  useDuplicatePmsTemplateMutation,
  useDeletePmsTemplateMutation,
  useGetPmsDesignationsQuery,
} = pmsApi
