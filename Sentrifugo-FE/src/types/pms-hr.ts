// ─── PMS Corporate HR screens 1.7 - 1.9 ──────────────────────────────────────
// HR competency rating and calibration, from PMS_Java (/pms-hr-appraisal, /pms-calibration);
// shapes follow the wire format (snake_case).

/** `rated` once HR has submitted the ratings. */
export type PmsHrRatingStatus = 'pending' | 'draft' | 'rated'

// ── 1.7 HR Competency Rating – list ──────────────────────────────────────────

export interface PmsHrQueueRow {
  employee_user_id: string
  employee_name: string
  emp_code: string
  department_id: string | null
  /** Static-data mode only: the real API sends ids, which the page resolves through IAM. */
  department_name?: string
  functional_head: string | null
  hod_rated_on: string | null
  status: PmsHrRatingStatus
  /** Already with calibration, so it can no longer be changed here. */
  sent_to_calibration: boolean
}

export interface PmsSendToCalibration {
  financial_year: string
  employee_user_ids: string[]
}

// ── 1.8 HR Competency Rating – employee ──────────────────────────────────────

export interface PmsHrCompetency {
  id: string
  name: string
  self_rating: number | null
  hr_rating: number | null
  comment: string
}

export interface PmsHrManagerCompetency {
  id: string
  name: string
  self_rating: number | null
  manager_rating: number | null
  hod_rating: number | null
}

export interface PmsHrAppraisal {
  employee_user_id: string
  employee_name: string
  emp_code: string
  role: string | null
  department_id: string | null
  /** Static-data mode only; see `PmsHrQueueRow`. */
  department_name?: string
  reporting_manager: string | null
  status: PmsHrRatingStatus
  /** With calibration: view only. */
  locked: boolean
  hr_competencies: PmsHrCompetency[]
  manager_competencies: PmsHrManagerCompetency[]
  remarks: string
}

export interface PmsHrAppraisalSave {
  employee_user_id: string
  financial_year: string
  competencies: Array<{ id: string; rating: number | null; comment: string }>
  remarks: string
}

// ── 1.9 Calibration & Publish ────────────────────────────────────────────────

export interface PmsCalibrationLevel {
  rating: number
  label: string
  current_percent: number
  guideline_percent: number
  hr_percent: number
}

export interface PmsCalibrationEmployee {
  employee_user_id: string
  employee_name: string
  emp_code: string
  manager_rating: number | null
  hod_rating: number | null
  hr_competency_avg: number | null
  /** The rating before calibration: the HOD's, else the manager's recommendation. */
  current_rating: number | null
  calibrated_rating: number | null
  reason: string
}

export interface PmsCalibration {
  financial_year: string
  published: boolean
  distribution: PmsCalibrationLevel[]
  employees: PmsCalibrationEmployee[]
}

export interface PmsCalibrationSave {
  financial_year: string
  distribution: Array<{ rating: number; hr_percent: number }>
  employees: Array<{ employee_user_id: string; calibrated_rating: number | null; reason: string }>
}
