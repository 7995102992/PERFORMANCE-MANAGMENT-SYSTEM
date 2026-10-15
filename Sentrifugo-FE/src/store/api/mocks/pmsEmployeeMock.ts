// ─── STATIC MOCK DATA — PMS employee screens 4.1 - 4.6 ───────────────────────
// Answers My Goals (review, acknowledge, request change, revised target),
// progress update and self appraisal without the PMS backend. `pmsApi.ts` puts
// this in front of the real base query; it is on by default and switched off
// with VITE_PMS_STATIC_DATA=false. Replies use the `{ success, message, data }`
// envelope. State is in-memory: it survives navigation, not a page reload.
// Note: the real API has no GET for the progress or self-appraisal sheets yet.
// My Goals (get/my-goals, acknowledge, request-change) calls PMS_Java; set VITE_PMS_STATIC_GOALS=true to use
// the static sheet below instead.

import type { FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query'
import type { PmsEmployeeTargets } from '@/types/pms-goals'
import type {
  PmsMyProgress,
  PmsMyProgressSave,
  PmsMySelfAppraisal,
  PmsMySelfAppraisalSave,
} from '@/types/pms-employee'
import { mockLatency } from './pmsCycleMock'

/** Throws the `{ status, data }` shape the RTK error handlers read. */
/** My Goals answers from the static sheet only when asked for; otherwise those calls reach PMS_Java. */
const STATIC_GOALS = import.meta.env.VITE_PMS_STATIC_GOALS === 'true'

const fail = (detail: string, status = 422): never => {
  throw { status, data: { detail } }
}
/** Deep copy, so callers cannot change the stored mock state. */
const clone = <T>(v: T): T => structuredClone(v)

// ── Goal sheet (4.1 - 4.3, 4.5) ──────────────────────────────────────────────

/** The six KRAs of the mocked employee goal sheet. */
const KRAS = [
  { id: 'emp-kpi-clinker', kra: 'Production', name: 'Clinker production', weight: 25, target: 5800, unit: 'TPD', evidence: 'DCS report' },
  { id: 'emp-kpi-shc', kra: 'Energy', name: 'Specific heat consumption', weight: 20, target: 720, unit: 'kcal/kg', evidence: 'Energy audit' },
  { id: 'emp-kpi-krf', kra: 'Production', name: 'Kiln run factor', weight: 20, target: 92, unit: '%', evidence: 'Stoppage log' },
  { id: 'emp-kpi-power', kra: 'Energy', name: 'Power consumption', weight: 15, target: 18.5, unit: 'kWh/t', evidence: 'SCADA' },
  { id: 'emp-kpi-lti', kra: 'Safety', name: 'Safety – LTI', weight: 10, target: 0, unit: 'Count', evidence: 'Safety MIS' },
  { id: 'emp-kpi-refr', kra: 'Maintenance', name: 'Refractory life', weight: 10, target: 10, unit: 'Months', evidence: 'Refractory log' },
]

/** Mutable state of the employee goal sheet (status, change request, pending revision). */
interface GoalState {
  status: string
  changeKpiId: string | null
  changeReason: string | null
  changeProposed: number | null
  /** A HOD-approved target revision the employee still has to acknowledge. */
  revision: { kpi_id: string; revised_target: number; reason: string; approved_by: string; approved_on: string; acknowledge_by: string } | null
}

/** The employee goal sheet state: starts as "sent to employee", with a revision ready for step 4.5. */
const goal: GoalState = {
  status: 'sent_to_employee',
  changeKpiId: null,
  changeReason: null,
  changeProposed: null,
  revision: {
    kpi_id: 'emp-kpi-clinker',
    revised_target: 5450,
    reason: 'shutdown extended to 45 days',
    approved_by: 'K. Venkata Ramana (HOD)',
    approved_on: '2026-10-11',
    acknowledge_by: '2026-10-20',
  },
}

/** The sheet in the API shape; the revision only shows once the original goals are approved. */
function myGoals(financialYear: string): PmsEmployeeTargets & Record<string, unknown> {
  // The revision only reaches the employee after the original goals are through (4.5).
  const revision = goal.status === 'approved' ? goal.revision : null
  return {
    employee_user_id: 'emp-self',
    financial_year: financialYear,
    goal_status: goal.status,
    template_id: 'tpl-kiln',
    template_name: 'Production Engineer',
    employee_name: 'Suresh Babu N.',
    emp_code: 'SCL-10482',
    role_name: 'Engineer – Kiln Ops',
    manager_name: 'Ravi Teja K.',
    sent_on: '2026-05-06',
    acknowledge_by: '2026-05-25',
    kpis: KRAS.map((k) => ({
      kpi_id: k.id,
      kra_name: k.kra,
      kpi_name: k.name,
      unit: k.unit,
      expected_outcome: '',
      evidence_required: k.evidence,
      weight: k.weight,
      target: k.target,
      target_type: 'common' as const,
      history: null,
      revised_target: revision && revision.kpi_id === k.id ? revision.revised_target : null,
    })),
    change_kpi_id: goal.changeKpiId,
    change_reason: goal.changeReason,
    change_proposed_target: goal.changeProposed,
    hod_remarks: null,
    revision,
  }
}

// ── Progress (4.4) ───────────────────────────────────────────────────────────

/** The employee progress sheet (4.4). */
const progress: PmsMyProgress = {
  financial_year: '',
  state: 'open',
  comment: 'Coal feed issue 12–14 Jul; burner trial in Aug.',
  kras: [
    { actual: 5540, status: 'on_track' },
    { actual: 731, status: 'at_risk' },
    { actual: 93.4, status: 'on_track' },
    { actual: 18.3, status: 'on_track' },
    { actual: 0, status: 'on_track' },
    { actual: 11, status: 'on_track' },
  ].map((p, i) => ({
    kpi_id: KRAS[i].id,
    kra_name: KRAS[i].kra,
    kpi_name: KRAS[i].name,
    weight: KRAS[i].weight,
    target: KRAS[i].target,
    revised_target: i === 0 ? 5450 : null,
    unit: KRAS[i].unit,
    actual: p.actual,
    status: p.status as 'on_track' | 'at_risk',
    evidence_name: null,
  })),
}

/** Saves actuals, status and evidence; a submit needs every actual and status, and freezes the sheet. */
function saveProgress(body: PmsMyProgressSave): PmsMyProgress {
  if (progress.state === 'frozen') fail('This period is frozen.', 409)
  if (body.submit && (body.entries.length < progress.kras.length || body.entries.some((e) => e.status === null))) {
    fail('Enter the actual and status for every KRA before submitting')
  }
  for (const e of body.entries) {
    const row = progress.kras.find((k) => k.kpi_id === e.kpi_id)
    if (!row) fail('That KRA is not on your goal sheet')
    else {
      row.actual = e.actual
      row.status = e.status
      row.evidence_name = e.attachment_name
    }
  }
  progress.comment = body.comment
  if (body.submit) progress.state = 'frozen'
  return { ...clone(progress), financial_year: body.financial_year }
}

// ── Self appraisal (4.6) ─────────────────────────────────────────────────────

/** Mocked KRA self-appraisal values: [target, actual, rating, evidence, attachment]. */
const SELF_KRAS: Array<[number, number, number, string, string | null]> = [
  // target, actual, rating, evidence, attachment
  [5450, 5540, 4, 'Achieved despite shutdown', 'DCS_Report_FY27.pdf'],
  [720, 726, 4, 'Burner change', 'Energy_Audit.pdf'],
  [92, 90.8, 3, '2 long stoppages', null],
  [18.5, 18.2, 4, 'VFD tuning', 'SCADA_Log.xlsx'],
  [0, 0, 5, 'Zero LTI', 'Safety_MIS.pdf'],
  [10, 11, 4, '11 months', null],
]

/** Mocked competencies: [name, HR or manager, self rating]. */
const COMPETENCIES: Array<[string, 'hr' | 'manager', number]> = [
  ['Attendance and Punctuality', 'hr', 4],
  ['Discipline', 'hr', 4],
  ['Attitude towards work', 'manager', 4],
  ['Attitude towards people', 'manager', 3],
  ['Dependability', 'manager', 4],
  ['Listening and communication skills', 'manager', 4],
  ['Honesty and Integrity', 'hr', 5],
  ['Co-employee relations at work (Teamwork)', 'hr', 3],
  ['Takes initiative at work', 'manager', 4],
  ['Commitment at work', 'manager', 4],
  ['Flexibility at work', 'manager', 3],
  ['Cost consciousness', 'manager', 3],
  ['Consistency at work', 'manager', 4],
  ['Enthusiasm & Creativity at work', 'manager', 3],
]

/** The self appraisal sheet (4.6). */
const selfAppraisal: PmsMySelfAppraisal = {
  financial_year: '',
  status: 'draft',
  kras: SELF_KRAS.map(([target, actual, rating, evidence, attachment], i) => ({
    kpi_id: KRAS[i].id,
    kra_name: KRAS[i].kra,
    kpi_name: KRAS[i].name,
    weight: KRAS[i].weight,
    target: KRAS[i].target,
    revised_target: target !== KRAS[i].target ? target : null,
    unit: KRAS[i].unit,
    actual,
    self_rating: rating,
    evidence,
    attachment_name: attachment,
  })),
  competencies: COMPETENCIES.map(([name, type, rating], i) => ({
    id: `emp-comp-${i}`,
    name,
    type,
    self_rating: rating,
    comment: '',
  })),
}

/** Saves ratings and texts; a submit needs every KRA and competency rated. */
function saveSelf(body: PmsMySelfAppraisalSave): PmsMySelfAppraisal {
  if (selfAppraisal.status === 'submitted') fail('Your self appraisal was already submitted.', 409)
  for (const l of body.kras) {
    const row = selfAppraisal.kras.find((k) => k.kpi_id === l.kpi_id)
    if (!row) fail('That KRA is not on your goal sheet')
    else {
      if (l.rating !== null && (l.rating < 1 || l.rating > 5)) fail('Ratings must be between 1 and 5')
      row.actual = l.actual
      row.self_rating = l.rating
      row.evidence = l.evidence
      row.attachment_name = l.attachment_name
    }
  }
  for (const c of body.competencies) {
    const row = selfAppraisal.competencies.find((x) => x.id === c.competency_id)
    if (row) {
      row.self_rating = c.rating
      row.comment = c.comment
    }
  }
  if (body.submit) {
    const missing =
      selfAppraisal.kras.some((k) => k.self_rating === null) ||
      selfAppraisal.competencies.some((c) => c.self_rating === null)
    if (missing) fail('Rate every KRA and competency before submitting')
    selfAppraisal.status = 'submitted'
  }
  return { ...clone(selfAppraisal), financial_year: body.financial_year }
}

// ── Base-query hook ──────────────────────────────────────────────────────────

const ok = <T>(data: T) => ({ data: { success: true, message: 'OK', data } })

/** Returns a base-query result for the employee calls this mock covers, or `null` for the real API. */
export async function staticEmployeeScreens(
  args: string | FetchArgs,
): Promise<{ data: unknown } | { error: FetchBaseQueryError } | null> {
  const req = typeof args === 'string' ? { url: args } : args
  const params = (req.params ?? {}) as Record<string, string>
  const body = (req.body ?? {}) as Record<string, unknown>

  try {
    switch (req.url) {
      case '/pms-goal-assignment/get/my-goals':
        if (!STATIC_GOALS) return null
        await mockLatency(250)
        return ok(myGoals(params.financial_year))
      case '/pms-goal-assignment/get/my-change-requests':
        if (!STATIC_GOALS) return null
        return ok([])
      case '/pms-goal-assignment/acknowledge':
        if (!STATIC_GOALS) return null
        await mockLatency(400)
        if (goal.status !== 'sent_to_employee' && !(goal.status === 'approved' && goal.revision)) {
          fail('There is nothing to acknowledge.', 409)
        }
        // First acknowledgement takes the sheet through HOD approval (so 4.5 shows); the second clears the revision.
        if (goal.status === 'approved') goal.revision = null
        else goal.status = 'approved'
        return ok(myGoals(String(body.financial_year)))
      case '/pms-goal-assignment/request-change':
        if (!STATIC_GOALS) return null
        await mockLatency(400)
        goal.status = 'change_requested'
        goal.changeKpiId = String(body.kpi_id)
        goal.changeReason = String(body.reason)
        goal.changeProposed = (body.proposed_target as number | null) ?? null
        return ok(myGoals(String(body.financial_year)))
      case '/pms-progress/get/my-progress':
        if (!STATIC_GOALS) return null
        await mockLatency(250)
        return ok({ ...clone(progress), financial_year: params.financial_year })
      case '/pms-progress/update/my-progress':
        if (!STATIC_GOALS) return null
        await mockLatency(400)
        saveProgress(body as unknown as PmsMyProgressSave)
        return ok({ updated: (body as unknown as PmsMyProgressSave).entries.length })
      case '/pms-appraisal/get/self-appraisal':
        if (!STATIC_GOALS) return null
        await mockLatency(250)
        return ok({ ...clone(selfAppraisal), financial_year: params.financial_year })
      case '/pms-appraisal/update/self-appraisal': {
        if (!STATIC_GOALS) return null
        await mockLatency(450)
        const saved = saveSelf(body as unknown as PmsMySelfAppraisalSave)
        return ok({ status: saved.status, self_score: null })
      }
      default:
        return null
    }
  } catch (e) {
    return { error: e as FetchBaseQueryError }
  }
}
