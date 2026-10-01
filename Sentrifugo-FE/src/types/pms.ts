// ─── PMS (Performance Management System) — shared DTOs ───────────────────────
// Dates are ISO `YYYY-MM-DD` strings; timestamps are ISO-8601 date-times.
// `organisation_id` is never sent from the client — the BE takes it from the
// session, same as the other services.

// ── PMS Cycle ────────────────────────────────────────────────────────────────

export type PmsCycleStatus = 'draft' | 'active' | 'closed' | 'cancelled'

export type PmsAppraisalType = 'annual' | 'mid_year' | 'custom'

export type PmsEmploymentType = 'permanent' | 'contract' | 'trainee'

/** Stages of a cycle, in process-flow order. Fixed set — the BE owns the keys. */
export type PmsStageKey =
  | 'goal_setting'
  | 'employee_acknowledgement'
  | 'hod_approval'
  | 'progress_tracking'
  | 'mid_year_review'
  | 'self_appraisal'
  | 'manager_appraisal'
  | 'hod_review'
  | 'calibration_final_approval'

export interface PmsCycleBasicDetails {
  name: string
  description: string
  type: PmsAppraisalType
  period_start: string
  period_end: string
}

export interface PmsCycleStage {
  stage: PmsStageKey
  start_date: string
  end_date: string
  /** Send stage-start / due-date reminders for this stage. */
  notify: boolean
}

export interface PmsCycleApplicability {
  plant_ids: string[]
  /** true → every department; `department_ids` is then ignored. */
  all_departments: boolean
  department_ids: string[]
  employment_types: PmsEmploymentType[]
  min_service_months: number
  /** Date the minimum-service rule is evaluated against. */
  service_as_on: string
  exclude_probation: boolean
  exclude_notice_period: boolean
}

export interface PmsCycleFinalize {
  rating_scale_id: string
  notify_managers: boolean
  notify_employees: boolean
  notify_hod: boolean
  notify_hr: boolean
}

/** Body of POST /pms/cycles and PUT /pms/cycles/{id}. */
export interface PmsCycleUpsert {
  basic: PmsCycleBasicDetails
  stages: PmsCycleStage[]
  applicability: PmsCycleApplicability
  finalize: PmsCycleFinalize
}

/** Row of the PMS Cycle list (screen 1.1). */
export interface PmsCycleListItem {
  id: string
  /** Human cycle code, e.g. `PMS-2627-A`. */
  cycle_code: string
  name: string
  type: PmsAppraisalType
  period_start: string
  period_end: string
  /** Resolved server-side, e.g. "All Plants" / "Mattampally". */
  applicable_to: string
  status: PmsCycleStatus
  created_on: string
}

/** Full cycle (view / edit / activated screens). */
export interface PmsCycle extends PmsCycleUpsert {
  id: string
  cycle_code: string
  status: PmsCycleStatus
  created_on: string
  published_on?: string | null
  /** Resolved server-side, e.g. "All Plants" / "Mattampally, Gudipadu". */
  applicable_to: string
}

export interface PmsCycleSummary {
  all: number
  draft: number
  active: number
  closed: number
  cancelled: number
}

export interface PmsCycleListParams {
  search?: string
  /** Financial year start, e.g. 2026 → FY 2026-27. */
  year?: number
  type?: PmsAppraisalType
  plant_id?: string
  status?: PmsCycleStatus
  skip?: number
  limit?: number
}

/** `summary` counts ignore `status` (so the stat cards stay stable per tab). */
export interface PmsCycleListResponse {
  items: PmsCycleListItem[]
  total: number
  summary: PmsCycleSummary
}

export interface PmsNotificationCount {
  audience: 'hod_reviewers' | 'reporting_managers' | 'employees' | 'hr'
  sent: number
}

/** Response of POST /pms/cycles/{id}/publish (screen 1.6). */
export interface PmsCycleActivation {
  cycle: PmsCycle
  published_on: string
  notifications: PmsNotificationCount[]
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export interface PmsLookupOption {
  id: string
  name: string
}

export interface PmsRatingLevel {
  value: number
  label: string
  description?: string
}

export interface PmsRatingScale {
  id: string
  name: string
  levels: PmsRatingLevel[]
}

// ── Eligibility preview (Applicability step) ─────────────────────────────────

export interface PmsEligibleEmployee {
  employee_id: string
  employee_code: string
  name: string
  department: string
  plant: string
  employment_type: PmsEmploymentType
  service_months: number
}

export interface PmsEligibilityPreview {
  total_eligible: number
  excluded_probation: number
  excluded_notice_period: number
  excluded_min_service: number
  /** First page only — the dialog is a preview, not a roster. */
  items: PmsEligibleEmployee[]
}
