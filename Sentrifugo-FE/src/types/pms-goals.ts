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
}

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
}

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
}

export interface PmsTargetRow {
  kpi_id: string
  weight: number
  target: number | null
}

/** Body of save draft, validate and send. */
export interface PmsTargetsRequest {
  employee_user_id: string
  financial_year: string
  targets: PmsTargetRow[]
}

export interface PmsTargetValidation {
  valid: boolean
  total_weightage: number
  errors: string[]
}

export interface PmsCopyPreview {
  found: number
  already_in_target: number
}

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
