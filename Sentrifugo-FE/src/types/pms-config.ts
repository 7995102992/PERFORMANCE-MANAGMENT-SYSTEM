// ─── PMS Configuration — masters, rating scale, goal templates ───────────────
// Same conventions as `pms.ts`: ISO dates, session-scoped organisation,
// errors as `{ detail, code }`.

// ── KRA Master ───────────────────────────────────────────────────────────────

export interface PmsKra {
  id: string
  name: string
}

/** Body of add / edit KRA. */
export interface PmsKraUpsert {
  name: string
}

// ── KPI Master ───────────────────────────────────────────────────────────────

export type PmsTargetType = 'individual' | 'common'

/** A KPI under a KRA. */
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

/** Body of add / edit KPI. */
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

/** Who rates the competency: Corporate HR, or the manager and HOD. */
export type PmsCompetencyType = 'hr' | 'manager'

/** A competency with its category and who rates it. */
export interface PmsCompetency {
  id: string
  name: string
  category: PmsCompetencyCategory
  type: PmsCompetencyType
  is_active: boolean
}

/** Body of add / edit competency. */
export interface PmsCompetencyUpsert {
  name: string
  category: PmsCompetencyCategory
  type: PmsCompetencyType
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

/** A rating scale as the Rating Scale screen edits it. */
export interface PmsRatingScaleConfig {
  id: string
  name: string
  status?: 'active' | 'inactive'
  /** Highest rating first. */
  levels: PmsRatingLevelConfig[]
  is_default: boolean
  show_definitions_to_employees: boolean
}

/** A reusable rating level in the master list the create screen picks from. */
export interface PmsStandardRatingLevel {
  id: string
  label: string
  definition: string
  /** `#rrggbb` */
  color: string
}

/** Body of "add standard rating level". */
export interface PmsStandardRatingLevelUpsert {
  label: string
  definition: string
  color: string
}

/** Body of save / create rating scale (levels and the two switches). */
export type PmsRatingScaleUpdate = Pick<
  PmsRatingScaleConfig,
  'levels' | 'is_default' | 'show_definitions_to_employees'
>

// ── Goal Templates ───────────────────────────────────────────────────────────

export type PmsTemplateStatus = 'active' | 'inactive' | 'draft'

/** One KPI selected in a template, with its weight and target type. */
export interface PmsTemplateKpi {
  kpi_id: string
  /** Percent of the template's total KPI weightage. */
  weight: number
  target_type: PmsTargetType
  expected_outcome: string
  evidence_required: string
}

/** One KRA selected in a template with its KPIs. */
export interface PmsTemplateKra {
  kra_id: string
  kpis: PmsTemplateKpi[]
}

/** One competency selected in a template, with its weight. */
export interface PmsTemplateCompetency {
  competency_id: string
  weight: number
}

/** Step 1 of the template wizard. */
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

/** A saved template, with the names resolved for display. */
export interface PmsGoalTemplate extends PmsGoalTemplateUpsert {
  id: string
  department_name: string
  /** Role / designation display name. */
  designation_name: string
  /** "All" or the plant name the designation belongs to — read-only. */
  plant: string
}

/** A row of the template list. */
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

/** Filters of the template list. */
export interface PmsGoalTemplateListParams {
  financial_year?: number
  plant_id?: string
  department_id?: string
  /** Matches template name or role / designation. */
  search?: string
}

/** A role (designation) and the department it belongs to. */
export interface PmsDesignationOption {
  id: string
  name: string
  department_id: string
}
