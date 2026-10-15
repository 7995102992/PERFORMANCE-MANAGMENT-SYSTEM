// ─── PMS manager screens 3.6 - 3.14 ──────────────────────────────────────────
// Transfers, team progress, mid-year review, target revision and manager
// appraisal.
// from PMS_Java (/pms-goal-transfer, /pms-progress, /pms-mid-year, /pms-appraisal);
// shapes follow the wire format (snake_case).

/** Red / amber / green status of a KRA or an employee. */
export type PmsRag = 'on_track' | 'at_risk' | 'off_track'

// ── 3.6 My Team - Goal Status & Send to HOD ──────────────────────────────────

/** A mid-year transfer into the manager's team (banner on 3.6). */
export interface PmsTransferNotice {
  employee_user_id: string
  employee_name: string
  joined_on: string
  from_department: string
  previous_manager: string
  recorded_by: string
}

export interface PmsSendToHodRequest {
  financial_year: string
  employee_user_ids: string[]
  /** The manager's note to the HOD (up to 500 characters). */
  remarks?: string
}

// ── 3.8 Set Period 2 KRAs - transferred employee ─────────────────────────────

export interface PmsTransferKra {
  id: string
  kra_name: string
  /** `template` rows come from a role template; `manager` rows were added by the manager. */
  source: 'template' | 'manager'
  source_label: string
  period: 1 | 2
  period_label: string
  weight: number
  target: number | null
  unit: string
  /** Period 1 rows are frozen at the transfer date. */
  locked: boolean
}

export interface PmsTransferGoalSheet {
  employee_user_id: string
  employee_name: string
  emp_code: string
  previous: { department: string; manager: string; period_label: string }
  current: { department: string; manager: string; period_label: string }
  recorded_by: string
  recorded_on: string
  kras: PmsTransferKra[]
  reason: string
  remarks: string
  /** `pending`, `draft` or `sent`. */
  status?: string
}

export interface PmsTransferGoalSheetRequest {
  employee_user_id: string
  financial_year: string
  /** Only the editable period 2 rows are sent. */
  kras: Array<{
    kra_name: string
    weight: number
    target: number | null
    unit: string
    source: 'template' | 'manager'
    source_label: string
  }>
  reason: string
  remarks: string
}

// ── 3.9 Team Progress Dashboard ──────────────────────────────────────────────

export interface PmsProgressKra {
  kra_name: string
  rag: PmsRag
}

export interface PmsTeamProgressRow {
  employee_user_id: string
  employee_name: string
  /** Goals are not approved by the HOD yet, so progress tracking has not opened. */
  locked: boolean
  kras_on_track: number
  kras_total: number
  attention: PmsProgressKra[]
  achievement: number | null
  comment: string | null
  overall_rag: PmsRag | null
}

// ── 3.10 - 3.12 Mid-year review ──────────────────────────────────────────────

export type PmsMidYearStatus = 'not_started' | 'completed_no_revision' | 'revision_requested'

export interface PmsMidYearRow {
  employee_user_id: string
  employee_name: string
  role: string
  /** Null until the employee has reported an actual. */
  h1_achievement: number | null
  rag: PmsRag | null
  status: PmsMidYearStatus
}

export interface PmsMidYearKra {
  kpi_id: string
  kra_name: string
  target: number
  unit: string
  h1_actual: number | null
  rag: PmsRag | null
}

export interface PmsMidYearReview {
  employee_user_id: string
  employee_name: string
  emp_code: string
  role: string
  manager: string
  template: string
  status: PmsMidYearStatus
  kras: PmsMidYearKra[]
  discussion_notes: string
  revision_required: boolean | null
}

export interface PmsMidYearSubmit {
  employee_user_id: string
  financial_year: string
  discussion_notes: string
  revision_required: boolean
}

export interface PmsRevisionKra {
  kpi_id: string
  kra_name: string
  weight: number
  current_target: number
  unit: string
  revised_target: number | null
  reason: string
}

export interface PmsRevisionRequest {
  employee_user_id: string
  employee_name: string
  emp_code: string
  role: string
  manager: string
  template: string
  kras: PmsRevisionKra[]
  attachment_name: string | null
  /** `pending_hod` once a request has been sent. */
  status?: string | null
}

export interface PmsRevisionSubmit {
  employee_user_id: string
  financial_year: string
  rows: Array<{ kpi_id: string; revised_target: number; reason: string }>
  attachment_name: string | null
}

// ── 3.13 / 3.14 Team appraisal ───────────────────────────────────────────────

export type PmsSelfAppraisalStatus = 'submitted' | 'not_submitted' | 'not_applicable'

export type PmsManagerRatingStatus =
  | 'pending'
  | 'draft'
  | 'submitted_to_hod'
  | 'period_1_rated'
  | 'waiting'
  | 'not_applicable'

export interface PmsTeamAppraisalRow {
  employee_user_id: string
  employee_name: string
  role: string
  self_status: PmsSelfAppraisalStatus
  self_score: number | null
  manager_status: PmsManagerRatingStatus
  /** Free text shown beside the status, e.g. who rated the earlier period. */
  manager_note: string | null
}

export interface PmsAppraisalKra {
  kpi_id: string
  kra_name: string
  target: number
  unit: string
  actual: number | null
  self_rating: number | null
  manager_rating: number | null
  attachment_name: string | null
  comment: string
}

export interface PmsAppraisalCompetency {
  id: string
  name: string
  self_rating: number | null
  manager_rating: number | null
  comment: string
}

export interface PmsManagerAppraisal {
  employee_user_id: string
  employee_name: string
  emp_code: string
  /** Set for a transferred employee: which period this manager rates. */
  period_label: string | null
  status: PmsManagerRatingStatus
  kras: PmsAppraisalKra[]
  competencies: PmsAppraisalCompetency[]
  hr_competencies: Array<{ id: string; name: string; self_rating: number | null }>
  recommended_rating: number | null
  comments: string
}

export interface PmsManagerAppraisalSave {
  employee_user_id: string
  financial_year: string
  kras: Array<{ kpi_id: string; rating: number | null; comment: string }>
  competencies: Array<{ id: string; rating: number | null; comment: string }>
  recommended_rating: number | null
  comments: string
}
