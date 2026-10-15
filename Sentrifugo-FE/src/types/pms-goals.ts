// ─── PMS goal assignment (screens 3.1 - 3.5) and approvals (4.x, 5.x) ────────
// Shapes match the PMS responses as they come over the wire (snake_case).

/** One row of "My Team" (3.1). `goal_status` is not_started | draft | sent_to_employee | acknowledged | change_requested | with_hod | approved. */
export interface PmsTeamMember {
  user_id: string
  emp_code: string
  name: string
  email: string
  designation_id: string
  designation_name: string
  goal_status: string
  /** The template that applies: the one assigned, else the role's active template (null when the role has none). */
  template_id?: string | null
  /** Name of that template. */
  template_name?: string | null
  /** True once the template is assigned to this employee ("Create & assign template", or goals started). */
  template_assigned?: boolean
  employment_type?: string | null
}

/** One KPI row of an employee goal sheet. */
export interface PmsEmployeeTargetKpi {
  kpi_id: string
  kra_name: string
  kpi_name: string
  unit: string
  expected_outcome: string
  evidence_required: string
  /** Percent of the total KPI weightage. */
  weight: number
  target: number | null
  /** The target the manager first assigned. Revisions never change it. */
  original_target?: number | null
  /** How many change requests the employee has made for this KPI on this sheet. */
  revision_count?: number
  /** The manager's revised target (waiting to be acknowledged, or acknowledged); null when not revised. */
  revised_target?: number | null
  /** The target before that revision, shown beside the revised one. */
  previous_target?: number | null
  /** The actual the employee reported in Update Progress; view only for the manager. */
  employee_actual?: number | null
  /** The status the employee gave it. */
  progress_status?: 'on_track' | 'at_risk' | 'off_track' | null
  /** Common: the same target for every employee in the role. Individual: this employee's own. */
  target_type?: 'common' | 'individual' | null
  /** Previous financial years, newest first (the history panel on 3.3). */
  history?: PmsTargetHistoryRow[] | null
}

/** One previous year of target and actual for a KPI. */
export interface PmsTargetHistoryRow {
  financial_year: string
  target: number
  /** Null when no actual was reported for that year. */
  actual: number | null
}

/** An employee goal sheet: status, KPI rows, change request and HOD remarks. */
export interface PmsEmployeeTargets {
  employee_user_id: string
  financial_year: string
  goal_status: string
  template_id: string
  template_name: string
  kpis: PmsEmployeeTargetKpi[]
  change_kpi_id: string | null
  change_reason: string | null
  change_proposed_target: number | null
  hod_remarks: string | null
  /** Context for the header card on 3.3 - 3.5 and 3.7; absent from older API versions. */
  employee_name?: string | null
  emp_code?: string | null
  role_name?: string | null
  manager_name?: string | null
  /** ISO date by which the employee has to acknowledge a sent sheet. */
  acknowledge_by?: string | null
  /** ISO date the manager sent the sheet. */
  sent_on?: string | null
  /** The comment the employee left when acknowledging; null when none. */
  acknowledge_comment?: string | null
  /** A target revision waiting for the employee's acknowledgement (4.5). */
  revision?: {
    /** `hod_approved` (a mid-year revision) or `manager_revised` (resent after a change request). */
    source?: 'hod_approved' | 'manager_revised'
    kpi_id: string
    revised_target: number
    reason: string
    approved_by: string
    approved_on: string
    acknowledge_by: string
  } | null
}

/** One weight / target pair sent to the API. */
/** One employee change request with the manager's answer; kept permanently. */
export interface PmsChangeRequestRecord {
  kpi_id: string
  kra_name: string | null
  kpi_name: string
  /** 1 for the first request on this KPI, then 2, 3 ... */
  revision_no: number
  requested_on: string
  reason: string
  proposed_target: number | null
  target_at_request: number | null
  status: 'requested' | 'responded'
  decision: 'revised' | 'unchanged' | null
  final_target: number | null
  manager_remarks: string | null
  responded_on: string | null
  acknowledged_on: string | null
}

/** Body of "Create & assign template" (screen 3.2). */
export interface PmsAssignTemplateRequest {
  financial_year: string
  /** The role (designation) whose employees get the template. */
  designation_id: string
  /** The template to assign: the role's active template (`template_id` of the team rows). */
  template_id: string
}

/** Result of assigning a role template to the manager's reports. */
export interface PmsTemplateAssignment {
  designation_id: string
  template_id: string
  template_name: string
  /** Employees who got the template just now. */
  assigned: number
  /** Employees in the role who already had a template and keep it. */
  already_assigned: number
}

export interface PmsTargetRow {
  kpi_id: string
  weight: number
  target: number | null
  /** Why the target changed; sent when a returned sheet is revised and resent. */
  remarks?: string
}

/** Body of save draft, validate and send. */
export interface PmsTargetsRequest {
  employee_user_id: string
  financial_year: string
  targets: PmsTargetRow[]
}

/** Result of validating a sheet. */
export interface PmsTargetValidation {
  valid: boolean
  total_weightage: number
  errors: string[]
}

/** How many templates a copy would add or skip. */
export interface PmsCopyPreview {
  found: number
  already_in_target: number
}

/** Result of a template copy. */
export interface PmsCopyResult {
  copied: number
  skipped: number
}

/** One row of the HOD approval queue (5.1). */
export interface PmsApprovalItem {
  employee_user_id: string
  employee_name: string
  emp_code: string
  designation_name: string
  manager_user_id: string
  goal_status: string
}

// ── HOD approvals: goal sheets and mid-year target revisions ────────────────

/** Which kind of request an HOD row is. */
export type PmsHodRequestType = 'goal_sheet' | 'target_revision'

/** One row of the HOD Goal Approvals list (`GET /get/hod-queue`). */
export interface PmsHodQueueItem {
  employee_user_id: string
  employee_name: string
  emp_code: string
  designation_name: string | null
  manager_name: string | null
  request_type: PmsHodRequestType
  goal_status: string
  /** False for a goal sheet whose targets did not move after the employee review. */
  changed: boolean
  first_change: { kpi_name: string; unit: string | null; from: number | null; to: number | null } | null
  more_changes: number
  asked_by_name: string | null
  asked_by_role: 'manager' | 'employee' | 'hod'
  asked_on: string | null
  revision_rounds: number
}

/** One KRA/KPI row on the HOD review screen. */
export interface PmsHodReviewRow {
  kpi_id: string
  kra_name: string | null
  kpi_name: string
  weight: number
  unit: string | null
  expected_outcome?: string | null
  evidence_required?: string | null
  /** What the employee asked for on this KPI (their latest change request); null when none. */
  employee_requested?: number | null
  approved_now: number | null
  requested: number | null
  change: number
  change_percent: number
  reason: string | null
  changed: boolean
  decision: 'pending' | 'approved' | 'returned' | 'none'
}

/** The HOD review screen (`GET /get/hod-review`). */
export interface PmsHodReview {
  employee_user_id: string
  employee_name: string
  emp_code: string
  designation_name: string | null
  manager_name: string | null
  template_name: string | null
  financial_year: string
  request_type: PmsHodRequestType
  goal_status: string
  asked_by_name: string | null
  asked_by_role: 'manager' | 'employee' | 'hod'
  asked_on: string | null
  employee_request: string | null
  manager_reply: string | null
  revision_rounds: number
  total_weight: number
  /** When the employee acknowledged the sheet, when the manager sent it to the HOD, and who sent it. */
  acknowledged_on?: string | null
  sent_for_approval_on?: string | null
  sent_for_approval_by?: string | null
  rows: PmsHodReviewRow[]
}

/** Body of `POST /hod/approve` and `POST /hod/return`. */
export interface PmsHodActionRequest {
  employee_user_id: string
  financial_year: string
  request_type: PmsHodRequestType
  /** KPIs of a target revision to act on; leave out for every KPI still waiting. */
  kpi_ids?: string[]
  remarks?: string
}

/** Body of `POST /hod/approve-selected`. */
export interface PmsHodBulkApproveRequest {
  financial_year: string
  items: { employee_user_id: string; request_type: PmsHodRequestType }[]
}

/** Per-request outcome of a bulk approve. */
export interface PmsHodBulkApproveResult {
  approved: number
  failed: number
  results: {
    employee_user_id: string
    employee_name: string
    request_type: PmsHodRequestType
    success: boolean
    message: string
  }[]
}

/** One decision in Approval History (`GET /get/hod-history`). */
export interface PmsHodHistoryItem {
  decided_on: string
  employee_user_id: string
  employee_name: string
  manager_name: string | null
  request_type: PmsHodRequestType
  kpi_name: string | null
  unit: string | null
  from: number | null
  to: number | null
  more_changes: number
  decision: 'approved' | 'returned'
  remarks: string | null
}

/** The trail of one employee year (`GET /get/hod-trail`). */
export interface PmsHodTrail {
  employee_user_id: string
  employee_name: string
  emp_code: string
  designation_name: string | null
  manager_name: string | null
  financial_year: string
  moves: {
    kpi_name: string
    unit: string | null
    steps: { date: string; value: number | null; actor_role: 'manager' | 'employee' | 'hod'; label: string }[]
  }[]
  requests: {
    request_no: number
    request_type: PmsHodRequestType
    title: string
    subtitle: string
    status: 'approved' | 'returned' | 'waiting'
    status_date: string
    events: {
      date: string
      actor_name: string | null
      actor_role: 'manager' | 'employee' | 'hod'
      action: string
      summary: string | null
    }[]
  }[]
}

// ── Stage windows from the cycle timeline (bell and banner) ─────────────────

/** One stage window that concerns the signed-in user (`GET /get/stage-notices`). */
export interface PmsStageNotice {
  stage: 'goal_setting' | 'employee_acknowledgement' | 'hod_approval'
  title: string
  audience: 'manager' | 'employee' | 'hod'
  cycle_name: string
  start_date: string
  end_date: string
  state: 'upcoming' | 'open' | 'closed'
  /** Days left including today while open; days until the start while upcoming; null once closed. */
  days_left: number | null
  /** True when the bell should announce it (stage switch and audience switch are on). */
  notify: boolean
}

// ── Bell notifications (written when a cycle is published) ──────────────────

/** One PMS notification for the signed-in user. */
export interface PmsNotificationItem {
  id: string
  title: string
  message: string
  /** Screen it opens, e.g. `/pms/my-goals/2026`. */
  link_path: string | null
  created_on: string
  read: boolean
}

/** The bell: latest notifications and the unread count. */
export interface PmsNotifications {
  unread: number
  items: PmsNotificationItem[]
}
