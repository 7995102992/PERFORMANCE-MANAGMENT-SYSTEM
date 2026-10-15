// ─── PMS employee screens 4.4 and 4.6 ────────────────────────────────────────
// Progress update and self appraisal. Shapes follow the wire format (snake_case).
// Goal review (4.1 - 4.3) and the revised-target view (4.5) use `PmsEmployeeTargets`.

import type { PmsRag } from './pms-manager'

// ── 4.4 Update Progress ──────────────────────────────────────────────────────

export interface PmsMyProgressKra {
  kpi_id: string
  /** The KRA the KPI sits under; the table lists the KPI name. */
  kra_name: string | null
  kpi_name: string
  weight: number
  /** The target the manager first assigned (never overwritten by a revision). */
  target: number
  /** The final target after a revision; shown only in the Revised target column, null if never revised. */
  revised_target: number | null
  unit: string
  actual: number | null
  status: PmsRag | null
  evidence_name: string | null
}

export interface PmsMyProgress {
  financial_year: string
  /** `frozen` once submitted for the period: shown read-only. */
  state: 'open' | 'frozen'
  period?: string
  submitted_on?: string | null
  kras: PmsMyProgressKra[]
  comment: string
}

export interface PmsMyProgressSave {
  financial_year: string
  period: string
  comment: string
  submit: boolean
  /** Only KPIs with an actual are sent; `attachment_name` is the evidence file name. */
  entries: Array<{ kpi_id: string; actual: number; status: PmsRag | null; attachment_name: string | null }>
}

// ── 4.6 Self Appraisal ───────────────────────────────────────────────────────

export interface PmsSelfKra {
  kpi_id: string
  /** The KRA the KPI sits under; the table lists the KPI name. */
  kra_name: string | null
  kpi_name: string
  weight: number
  /** The target the manager first assigned (never overwritten by a revision). */
  target: number
  /** The final target after a revision; shown only in the Revised target column, null if never revised. */
  revised_target: number | null
  unit: string
  actual: number | null
  self_rating: number | null
  evidence: string
  attachment_name: string | null
}

export interface PmsSelfCompetency {
  id: string
  name: string
  /** HR competencies are rated by Corporate HR later; the employee still self-rates them. */
  type: 'hr' | 'manager'
  self_rating: number | null
  comment: string
}

export interface PmsMySelfAppraisal {
  financial_year: string
  submitted_on?: string | null
  self_score?: number | null
  status: 'draft' | 'submitted'
  kras: PmsSelfKra[]
  competencies: PmsSelfCompetency[]
}

export interface PmsMySelfAppraisalSave {
  financial_year: string
  submit: boolean
  kras: Array<{
    kpi_id: string
    actual: number | null
    rating: number | null
    evidence: string
    attachment_name: string | null
  }>
  competencies: Array<{ competency_id: string; rating: number | null; comment: string }>
}
