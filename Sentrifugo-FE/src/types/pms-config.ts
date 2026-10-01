// ─── PMS Configuration — masters, rating scale, goal templates ───────────────
// Same conventions as `pms.ts`: ISO dates, session-scoped organisation,
// errors as `{ detail, code }`.

// ── KRA Master ───────────────────────────────────────────────────────────────

export interface PmsKra {
  id: string
  name: string
}

export interface PmsKraUpsert {
  name: string
}

// ── KPI Master ───────────────────────────────────────────────────────────────

export type PmsTargetType = 'individual' | 'common'

export interface PmsKpi {
  id: string
  kra_id: string
  /** Resolved server-side from `kra_id`. */
  kra_name: string
  name: string
  unit: string
  target_type: PmsTargetType
  expected_outcome: string
  evidence_required: string
}

export interface PmsKpiUpsert {
  kra_id: string
  name: string
  unit: string
  target_type: PmsTargetType
  expected_outcome: string
  evidence_required: string
}

// ── Competency Master ────────────────────────────────────────────────────────

export type PmsCompetencyCategory =
  | 'behavioural'
  | 'technical'
  | 'leadership'
  | 'functional'

export interface PmsCompetency {
  id: string
  name: string
  category: PmsCompetencyCategory
  is_active: boolean
}

export interface PmsCompetencyUpsert {
  name: string
  category: PmsCompetencyCategory
  is_active: boolean
}

// ── Rating Scale ─────────────────────────────────────────────────────────────

export interface PmsRatingLevelConfig {
  /** 1 = lowest. Fixed per scale — the BE does not let levels be added here. */
  rating: number
  label: string
  definition: string
  score_min: number
  score_max: number
  /** `#rrggbb` */
  color: string
}

export interface PmsRatingScaleConfig {
  id: string
  name: string
  /** Highest rating first. */
  levels: PmsRatingLevelConfig[]
  is_default: boolean
  show_definitions_to_employees: boolean
}

export type PmsRatingScaleUpdate = Pick<
  PmsRatingScaleConfig,
  'levels' | 'is_default' | 'show_definitions_to_employees'
>

// ── Goal Templates ───────────────────────────────────────────────────────────

export type PmsTemplateStatus = 'active' | 'inactive' | 'draft'

export interface PmsTemplateKpi {
  kpi_id: string
  /** Percent of the template's total KPI weightage. */
  weight: number
  target_type: PmsTargetType
  expected_outcome: string
  evidence_required: string
}

export interface PmsTemplateKra {
  kra_id: string
  kpis: PmsTemplateKpi[]
}

export interface PmsTemplateCompetency {
  competency_id: string
  weight: number
}

export interface PmsGoalTemplateBasic {
  /** Financial year start, e.g. 2026 → FY 2026-27. */
  financial_year: number
  name: string
  description: string
  department_id: string
  designation_id: string
  effective_from: string
  status: PmsTemplateStatus
}

/** Body of POST /pms/goal-templates and PUT /pms/goal-templates/{id}. */
export interface PmsGoalTemplateUpsert {
  basic: PmsGoalTemplateBasic
  /** Selected KRAs only, each with its selected KPIs only. */
  kras: PmsTemplateKra[]
  /** Selected competencies only. */
  competencies: PmsTemplateCompetency[]
}

export interface PmsGoalTemplate extends PmsGoalTemplateUpsert {
  id: string
  department_name: string
  /** Role / designation display name. */
  designation_name: string
  /** "All" or the plant name the designation belongs to — read-only. */
  plant: string
}

export interface PmsGoalTemplateListItem {
  id: string
  name: string
  financial_year: number
  designation_name: string
  department_id: string
  department_name: string
  plant_id: string | null
  plant: string
  status: PmsTemplateStatus
}

export interface PmsGoalTemplateListParams {
  financial_year?: number
  plant_id?: string
  department_id?: string
  /** Matches template name or role / designation. */
  search?: string
}

export interface PmsDesignationOption {
  id: string
  name: string
  department_id: string
}
