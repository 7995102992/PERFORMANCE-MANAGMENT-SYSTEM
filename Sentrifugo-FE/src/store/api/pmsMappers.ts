// ─── PMS API ⇄ FE mappers ────────────────────────────────────────────────────
// The backend (API_FRONTEND_GUIDE.md) and the screens use different shapes:
// financial year as "2025-26" vs 2025, `role_id` vs `designation_id`, `colour_code`
// vs `color`, lowercase competency categories, and so on. Pages keep the FE
// types from `@/types/pms*`; everything that crosses the wire goes through here.

import type {
  PmsAppraisalType,
  PmsCycle,
  PmsCycleActivation,
  PmsCycleApplicability,
  PmsCycleFinalize,
  PmsCycleStatus,
  PmsCycleUpsert,
  PmsEmploymentType,
  PmsLookupOption,
  PmsNotificationCount,
  PmsRatingScale,
  PmsStageKey,
} from '@/types/pms'
import type {
  PmsCompetency,
  PmsCompetencyCategory,
  PmsCompetencyUpsert,
  PmsDesignationOption,
  PmsGoalTemplate,
  PmsGoalTemplateBasic,
  PmsGoalTemplateListItem,
  PmsGoalTemplateUpsert,
  PmsKpi,
  PmsKra,
  PmsRatingScaleConfig,
  PmsRatingScaleUpdate,
  PmsStandardRatingLevel,
  PmsStandardRatingLevelUpsert,
  PmsTemplateStatus,
  PmsTargetType,
} from '@/types/pms-config'

// ── Envelope & lookups ───────────────────────────────────────────────────────

/** Every success response: `{ success, message, data }`. */
export interface ApiEnvelope<T> {
  success: boolean
  message: string
  data: T
}

export const unwrapEnvelope = <T>(res: { data?: unknown }): T => (res.data as ApiEnvelope<T>).data

/** Sentrifugo masters the PMS API refers to by id only. */
export interface PmsLookups {
  plants: PmsLookupOption[]
  departments: PmsLookupOption[]
  designations: PmsDesignationOption[]
}

// ── Financial year ───────────────────────────────────────────────────────────

/** FE keeps the start year (2026 → FY 2026-27); the API takes "2026-27". */
export const fyToApi = (year: number) => `${year}-${String((year + 1) % 100).padStart(2, '0')}`
export const fyFromApi = (fy: string) => Number(fy.slice(0, 4))

// ── Cycle DTOs (guide §3) ────────────────────────────────────────────────────

interface ApiCycleApplicability {
  all_plants: boolean
  plant_ids: string[]
  all_departments: boolean
  department_ids: string[]
  employment_types: PmsEmploymentType[]
  min_service_months: number | null
  service_as_on: string | null
  exclude_probation: boolean
  exclude_notice_period: boolean
}

interface ApiCycleFinalize {
  rating_scale_id: string | null
  notify_managers: boolean
  notify_employees: boolean
  notify_hod: boolean
  notify_hr: boolean
}

export interface ApiCycle {
  id: string
  cycle_code: string
  status: PmsCycleStatus
  created_on: string
  published_on: string | null
  applicable_to: string | null
  basic: { name: string; description: string | null; type: PmsAppraisalType; period_start: string; period_end: string }
  stages: { stage: PmsStageKey; start_date: string | null; end_date: string | null; notify: boolean }[]
  applicability: ApiCycleApplicability | null
  finalize: ApiCycleFinalize | null
}

export interface ApiCycleActivation {
  cycle: ApiCycle
  published_on: string
  notifications: { audience: PmsNotificationCount['audience']; sent: number }[]
}

const EMPTY_FINALIZE: PmsCycleFinalize = {
  rating_scale_id: '',
  notify_managers: false,
  notify_employees: false,
  notify_hod: false,
  notify_hr: false,
}

export function cycleFromApi(c: ApiCycle, lookups: PmsLookups): PmsCycle {
  const app = c.applicability
  const applicability: PmsCycleApplicability = {
    // `all_plants` means plant_ids is ignored by the server, so expand it for the form.
    plant_ids: app?.all_plants ? lookups.plants.map((p) => p.id) : (app?.plant_ids ?? []),
    all_departments: app?.all_departments ?? false,
    department_ids: app?.department_ids ?? [],
    employment_types: app?.employment_types ?? [],
    min_service_months: app?.min_service_months ?? 0,
    service_as_on: app?.service_as_on ?? '',
    exclude_probation: app?.exclude_probation ?? false,
    exclude_notice_period: app?.exclude_notice_period ?? false,
  }
  const f = c.finalize
  return {
    id: c.id,
    cycle_code: c.cycle_code,
    status: c.status,
    created_on: c.created_on,
    published_on: c.published_on,
    applicable_to: c.applicable_to ?? '',
    basic: {
      name: c.basic.name,
      description: c.basic.description ?? '',
      type: c.basic.type,
      period_start: c.basic.period_start,
      period_end: c.basic.period_end,
    },
    stages: c.stages.map((s) => ({
      stage: s.stage,
      start_date: s.start_date ?? '',
      end_date: s.end_date ?? '',
      notify: s.notify,
    })),
    applicability,
    finalize: f
      ? {
          rating_scale_id: f.rating_scale_id ?? '',
          notify_managers: f.notify_managers,
          notify_employees: f.notify_employees,
          notify_hod: f.notify_hod,
          notify_hr: f.notify_hr,
        }
      : EMPTY_FINALIZE,
  }
}

export function cycleActivationFromApi(a: ApiCycleActivation, lookups: PmsLookups): PmsCycleActivation {
  return {
    cycle: cycleFromApi(a.cycle, lookups),
    published_on: a.published_on,
    notifications: a.notifications.map((n) => ({ audience: n.audience, sent: n.sent })),
  }
}

/** FE body → API body. Empty dates and the rating scale go as null, not "". */
export function cycleToApi(body: PmsCycleUpsert, lookups: PmsLookups) {
  const { plant_ids, service_as_on, ...app } = body.applicability
  // Every plant ticked → all_plants, so new plants added later are picked up.
  const all_plants = lookups.plants.length > 0 && lookups.plants.every((p) => plant_ids.includes(p.id))
  return {
    basic: body.basic,
    stages: body.stages.map((s) => ({
      stage: s.stage,
      start_date: s.start_date || null,
      end_date: s.end_date || null,
      notify: s.notify,
    })),
    applicability: { ...app, all_plants, plant_ids, service_as_on: service_as_on || null },
    finalize: {
      rating_scale_id: body.finalize.rating_scale_id || null,
      notify_managers: body.finalize.notify_managers,
      notify_employees: body.finalize.notify_employees,
      notify_hod: body.finalize.notify_hod,
      notify_hr: body.finalize.notify_hr,
    },
  }
}

// ── Rating scale DTOs (guide §6) ─────────────────────────────────────────────

interface ApiRatingLevel {
  rating_value: number
  label: string
  definition: string | null
  minimum_score: number
  maximum_score: number
  colour_code: string | null
  display_order: number | null
}

export interface ApiRatingScale {
  id: string
  name: string
  description: string | null
  status: 'active' | 'inactive'
  is_default: boolean
  show_definitions_to_employees: boolean
  /** Highest rating first. */
  levels: ApiRatingLevel[]
}

/** Cycle wizard dropdown (`?status=active`). */
export const ratingScaleOptionFromApi = (s: ApiRatingScale): PmsRatingScale => ({
  id: s.id,
  name: s.name,
  levels: s.levels.map((l) => ({ value: l.rating_value, label: l.label, description: l.definition ?? '' })),
})

/** Rating Scale screen (2.10). */
export const ratingScaleConfigFromApi = (s: ApiRatingScale): PmsRatingScaleConfig => ({
  id: s.id,
  name: s.name,
  status: s.status,
  is_default: s.is_default,
  show_definitions_to_employees: s.show_definitions_to_employees,
  levels: s.levels.map((l) => ({
    rating: l.rating_value,
    label: l.label,
    definition: l.definition ?? '',
    score_min: l.minimum_score,
    score_max: l.maximum_score,
    color: l.colour_code ?? '#9ca3af',
  })),
})

/** Standard rating level (guide: master list used to build rating scales). */
export interface ApiStandardRatingLevel {
  id: string
  label: string
  definition: string | null
  colour_code: string | null
}

export const standardLevelFromApi = (l: ApiStandardRatingLevel): PmsStandardRatingLevel => ({
  id: l.id,
  label: l.label,
  definition: l.definition ?? '',
  color: l.colour_code ?? '#9CA3AF',
})

export const standardLevelToApi = (b: PmsStandardRatingLevelUpsert) => ({
  label: b.label.trim(),
  definition: b.definition.trim() || null,
  colour_code: b.color.toUpperCase(),
})

/** POST body for a new scale. Levels use the same mapping as the update. */
export function ratingScaleCreateToApi(name: string, body: PmsRatingScaleUpdate) {
  return { ...ratingScaleToApi({ name, description: null, status: 'active' } as ApiRatingScale, body) }
}

/** The PUT replaces name and status too, so they're carried over from the current scale. */
export function ratingScaleToApi(current: ApiRatingScale, body: PmsRatingScaleUpdate) {
  const levels = [...body.levels]
    .sort((a, b) => b.rating - a.rating)
    .map((l, i) => ({
      rating_value: l.rating,
      label: l.label,
      definition: l.definition || null,
      minimum_score: l.score_min,
      maximum_score: l.score_max,
      colour_code: l.color,
      display_order: i + 1,
    }))
  return {
    name: current.name,
    description: current.description,
    status: current.status,
    is_default: body.is_default,
    show_definitions_to_employees: body.show_definitions_to_employees,
    levels,
  }
}

// ── Masters (guide §5) ───────────────────────────────────────────────────────

export const kraFromApi = (k: { id: string; name: string }): PmsKra => ({ id: k.id, name: k.name })

export interface ApiKpi {
  id: string
  kra_id: string
  kra_name: string
  name: string
  unit: string
  target_type: PmsTargetType
  expected_outcome: string | null
  evidence_required: string | null
}

export const kpiFromApi = (k: ApiKpi): PmsKpi => ({
  id: k.id,
  kra_id: k.kra_id,
  kra_name: k.kra_name,
  name: k.name,
  unit: k.unit,
  target_type: k.target_type,
  expected_outcome: k.expected_outcome ?? '',
  evidence_required: k.evidence_required ?? '',
})

export interface ApiCompetency {
  id: string
  name: string
  /** Free text on the server, e.g. "Behavioural". */
  category: string
  status: 'active' | 'inactive'
}

export const competencyFromApi = (c: ApiCompetency): PmsCompetency => ({
  id: c.id,
  name: c.name,
  category: c.category.toLowerCase() as PmsCompetencyCategory,
  is_active: c.status === 'active',
})

export const competencyToApi = (b: PmsCompetencyUpsert) => ({
  name: b.name,
  category: b.category.charAt(0).toUpperCase() + b.category.slice(1),
  status: b.is_active ? 'active' : 'inactive',
})

// ── Goal templates (guide §4) ────────────────────────────────────────────────

interface ApiTemplateKpi {
  kpi_id: string
  kpi_name: string
  unit: string
  weightage: number
  target_type: PmsTargetType
  expected_outcome: string | null
  evidence_required: string | null
}

export interface ApiGoalTemplate {
  id: string
  financial_year: string
  template_name: string
  description: string | null
  department_id: string
  role_id: string
  plant_id: string | null
  effective_from: string
  status: PmsTemplateStatus
  kras: { kra_id: string; kra_name: string; kpis: ApiTemplateKpi[] }[]
  competencies: { competency_id: string; name: string; category: string; weightage: number }[]
}

export interface ApiGoalTemplateListItem {
  id: string
  template_name: string
  financial_year: string
  department_id: string
  role_id: string
  plant_id: string | null
  effective_from: string
  status: PmsTemplateStatus
}

const plantName = (lookups: PmsLookups, id: string | null) =>
  id ? (lookups.plants.find((p) => p.id === id)?.name ?? '') : 'All'
const departmentName = (lookups: PmsLookups, id: string) =>
  lookups.departments.find((d) => d.id === id)?.name ?? ''
const designationName = (lookups: PmsLookups, id: string) =>
  lookups.designations.find((d) => d.id === id)?.name ?? ''

export function templateFromApi(t: ApiGoalTemplate, lookups: PmsLookups): PmsGoalTemplate {
  return {
    id: t.id,
    basic: {
      financial_year: fyFromApi(t.financial_year),
      name: t.template_name,
      description: t.description ?? '',
      department_id: t.department_id,
      designation_id: t.role_id,
      effective_from: t.effective_from,
      status: t.status,
    },
    kras: t.kras.map((k) => ({
      kra_id: k.kra_id,
      kpis: k.kpis.map((p) => ({
        kpi_id: p.kpi_id,
        weight: p.weightage,
        target_type: p.target_type,
        expected_outcome: p.expected_outcome ?? '',
        evidence_required: p.evidence_required ?? '',
      })),
    })),
    competencies: t.competencies.map((c) => ({ competency_id: c.competency_id, weight: c.weightage })),
    department_name: departmentName(lookups, t.department_id),
    designation_name: designationName(lookups, t.role_id),
    plant: plantName(lookups, t.plant_id),
  }
}

export function templateListItemFromApi(t: ApiGoalTemplateListItem, lookups: PmsLookups): PmsGoalTemplateListItem {
  return {
    id: t.id,
    name: t.template_name,
    financial_year: fyFromApi(t.financial_year),
    designation_name: designationName(lookups, t.role_id),
    department_id: t.department_id,
    department_name: departmentName(lookups, t.department_id),
    plant_id: t.plant_id,
    plant: plantName(lookups, t.plant_id),
    status: t.status,
  }
}

/** Step 1 of a template save (create or basic-info update). */
export function templateBasicToApi(b: PmsGoalTemplateBasic) {
  return {
    financial_year: fyToApi(b.financial_year),
    template_name: b.name,
    description: b.description || null,
    department_id: b.department_id,
    role_id: b.designation_id,
    effective_from: b.effective_from,
    status: b.status,
  }
}

/**
 * Step 2 of a template save. The server's `save_as_draft` skips the 100% rule;
 * any status other than `active` is an interim save.
 */
export function templateKraKpiToApi(body: PmsGoalTemplateUpsert) {
  return {
    save_as_draft: body.basic.status !== 'active',
    kras: body.kras.map((k) => ({
      kra_id: k.kra_id,
      kpis: k.kpis.map((p) => ({ kpi_id: p.kpi_id, weightage: p.weight, target_type: p.target_type })),
    })),
  }
}

/** Step 3 of a template save. */
export const templateCompetenciesToApi = (body: PmsGoalTemplateUpsert) => ({
  competencies: body.competencies.map((c) => ({ competency_id: c.competency_id, weightage: c.weight })),
})
