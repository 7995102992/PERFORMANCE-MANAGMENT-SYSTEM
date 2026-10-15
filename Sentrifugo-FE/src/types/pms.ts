// ─── PMS (Performance Management System) — shared DTOs ───────────────────────
// Dates are ISO `YYYY-MM-DD` strings; timestamps are ISO-8601 date-times.
// `organisation_id` is never sent from the client — the BE takes it from the
// session, same as the other services.

// ── PMS Cycle ────────────────────────────────────────────────────────────────

export type PmsCycleStatus = 'draft' | 'active' | 'closed' | 'cancelled'

/** annual, mid_year or custom: what the cycle covers. */
export type PmsAppraisalType = 'annual' | 'mid_year' | 'custom'

/** Employment types the rules can include. The wizard offers permanent, probationary and trainee. */
export type PmsEmploymentType = 'permanent' | 'contract' | 'probationary' | 'trainee'

/** Stages of a cycle, in process-flow order. Fixed set — the BE owns the keys. */
export type PmsStageKey =
  | 'goal_setting'
  | 'employee_acknowledgement'
  | 'hod_approval'
  | 'self_appraisal'
  | 'manager_appraisal'
  | 'hod_review'
  | 'hr_competency_rating'
  | 'calibration_final_approval'
  | 'approval_publish'

/** Step 1 of the cycle wizard. */
export interface PmsCycleBasicDetails {
  name: string
  description: string
  type: PmsAppraisalType
  period_start: string
  period_end: string
}

/** One row of the timeline (step 2). */
export interface PmsCycleStage {
  stage: PmsStageKey
  start_date: string
  end_date: string
  /** Send stage-start / due-date reminders for this stage. */
  notify: boolean
}

/** "Goal Setting – who gets goals". */
export interface PmsGoalSettingApplicability {
  employment_types: PmsEmploymentType[]
  min_service_months: number
}

/** "Appraisal – who is rated". Self rating, manager rating and final rating. */
export interface PmsAppraisalApplicability {
  employment_types: PmsEmploymentType[]
  min_service_months: number
  /** The minimum service must be complete on or before this date. */
  service_as_on: string
}

/** Step 3: plants, departments and the two rule halves (who gets goals, who is rated). */
export interface PmsCycleApplicability {
  plant_ids: string[]
  /** true → every department; `department_ids` is then ignored. */
  all_departments: boolean
  department_ids: string[]
  goal_setting: PmsGoalSettingApplicability
  appraisal: PmsAppraisalApplicability
  exclude_notice_period: boolean
}

/** Step 4: the rating scale and who is notified on publish. */
export interface PmsCycleFinalize {
  rating_scale_id: string
  notify_managers: boolean
  notify_employees: boolean
  notify_hod: boolean
  notify_hr: boolean
  /** "Notify GP" (screen 1.5). */
  notify_gp: boolean
  /** The approval workflow picked on screen 1.5; "" when none. */
  approval_workflow_id: string
}

/** Body to add / edit an approval workflow. */
export interface PmsApprovalWorkflowUpsert {
  name: string
  description: string
  steps: string[]
  status: 'active' | 'inactive'
}

/** An approval workflow of the Approval Workflow master. */
export interface PmsApprovalWorkflow {
  id: string
  name: string
  description: string | null
  /** Approver labels in order. */
  steps: string[]
  status: 'active' | 'inactive'
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

/** Counts per status for the list stat cards. */
export interface PmsCycleSummary {
  all: number
  draft: number
  active: number
  closed: number
  cancelled: number
}

/** Filters and paging of the cycle list. */
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

/** How many notifications went to one audience on publish. */
export interface PmsNotificationCount {
  audience: 'hod_reviewers' | 'reporting_managers' | 'employees' | 'hr'
  sent: number
}

/** Response of POST /pms/cycles/{id}/publish (screen 1.6). */
export interface PmsCycleActivation {
  cycle: PmsCycle
  published_on: string
  notifications: PmsNotificationCount[]
  /** Employees found eligible for appraisal; null until the eligibility run has recorded a result. */
  eligible: number | null
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export interface PmsLookupOption {
  id: string
  name: string
}

/** One level of a rating scale (value, label, description). */
export interface PmsRatingLevel {
  value: number
  label: string
  description?: string
}

/** A rating scale as offered in the cycle wizard. */
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
  /** Names (filled by the preview dialog from the lookups, or by the static mock). */
  department?: string
  plant?: string
  /** Ids as the API sends them. */
  department_id?: string
  plant_id?: string
  employment_type: PmsEmploymentType
  service_months: number
  /** false → gets goals, but the self-rating section stays closed. */
  is_rated: boolean
}

/** Result of the eligibility preview (step 3). */
export interface PmsEligibilityPreview {
  /** Employees who get goals. */
  total_eligible: number
  /** Of those, how many are also rated. */
  total_rated: number
  excluded_notice_period: number
  excluded_min_service: number
  /** First page only — the dialog is a preview, not a roster. */
  items: PmsEligibleEmployee[]
}
