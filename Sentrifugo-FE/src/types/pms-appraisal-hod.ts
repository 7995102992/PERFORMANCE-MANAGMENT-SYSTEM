// ─── PMS Functional Head screens 5.6 - 5.7 ───────────────────────────────────
// The L2 appraisal rating, between the Section Head's L1 rating and Corporate HR, from PMS_Java
// (/pms-appraisal-hod); shapes follow the wire format (snake_case).

/** `rated` once the Functional Head has submitted the L2 rating. */
export type PmsHodAppraisalStatus = 'pending' | 'draft' | 'rated'

// ── 5.7 Approve Appraisal – list ─────────────────────────────────────────────

export interface PmsAppraisalHodQueueRow {
  employee_user_id: string
  employee_name: string
  emp_code: string
  /** The Section Head who submitted the L1 rating. */
  section_head: string | null
  self_score: number | null
  /** Mean of the Section Head's ratings across every KRA and manager competency. */
  l1_score: number | null
  submitted_on: string | null
  status: PmsHodAppraisalStatus
}

// ── 5.6 L1/L2 Rating – employee ──────────────────────────────────────────────

export interface PmsAppraisalHodKra {
  kpi_id: string
  kra_name: string
  target: number | null
  unit: string
  actual: number | null
  self_rating: number | null
  manager_rating: number | null
  hod_rating: number | null
  attachment_name: string | null
}

export interface PmsAppraisalHodCompetency {
  id: string
  name: string
  self_rating: number | null
  manager_rating: number | null
  hod_rating: number | null
}

export interface PmsAppraisalHodHrCompetency {
  id: string
  name: string
  self_rating: number | null
}

export interface PmsAppraisalHodReview {
  employee_user_id: string
  employee_name: string
  emp_code: string
  designation_name: string | null
  section_head: string | null
  status: PmsHodAppraisalStatus
  kras: PmsAppraisalHodKra[]
  competencies: PmsAppraisalHodCompetency[]
  hr_competencies: PmsAppraisalHodHrCompetency[]
  /** The Section Head's own recommended rating and comments, shown for context. */
  l1_recommended_rating: number | null
  l1_comments: string
  hod_rating: number | null
  hod_remarks: string
}

export interface PmsAppraisalHodSave {
  employee_user_id: string
  financial_year: string
  kras: Array<{ id: string; rating: number | null }>
  competencies: Array<{ id: string; rating: number | null }>
  hod_rating: number | null
  remarks: string
}
