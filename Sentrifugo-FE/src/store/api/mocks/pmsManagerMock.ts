// ─── STATIC MOCK DATA — PMS manager screens 3.6 - 3.14 ───────────────────────
// Answers the manager calls (transfers, progress, mid-year review, target
// revision, appraisal, send to HOD) without the PMS backend. `pmsApi.ts` puts
// this in front of the real base query; it is on by default and switched off
// with VITE_PMS_STATIC_DATA=false when the screens should call PMS_Java
// (`/pms-goal-transfer`, `/pms-progress`, `/pms-mid-year`, `/pms-appraisal`).
// Replies use the same `{ success, message, data }` envelope as the API, so the
// endpoints' transformResponse stays unchanged. State is in-memory, so
// submissions survive navigation but not a page reload.

import type { FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query'
import type {
  PmsAppraisalCompetency,
  PmsAppraisalKra,
  PmsManagerAppraisal,
  PmsManagerAppraisalSave,
  PmsManagerRatingStatus,
  PmsMidYearKra,
  PmsMidYearReview,
  PmsMidYearRow,
  PmsMidYearStatus,
  PmsMidYearSubmit,
  PmsProgressKra,
  PmsRag,
  PmsRevisionRequest,
  PmsRevisionSubmit,
  PmsSendToHodRequest,
  PmsTeamAppraisalRow,
  PmsTeamProgressRow,
  PmsTransferGoalSheet,
  PmsTransferGoalSheetRequest,
  PmsTransferNotice,
} from '@/types/pms-manager'
import { mockLatency } from './pmsCycleMock'
import { markSentToHod, markTransferSent } from './pmsGoalAssignmentMock'

/** Throws the `{ status, data }` shape the RTK error handlers already read. */
const fail = (detail: string, status = 422): never => {
  throw { status, data: { detail } }
}

/** Deep copy, so callers cannot change the stored mock state. */
const clone = <T>(value: T): T => structuredClone(value)

// ── Roster ───────────────────────────────────────────────────────────────────

/** Name of the mocked signed-in manager. */
const MANAGER = 'Ravi Teja K.'

/** One mocked team member. */
interface Person {
  id: string
  name: string
  code: string
  role: string
  template: string
}

const KILN = 'Engineer – Kiln Ops'
const KILN_TEMPLATE = 'Production Engineer'

/** The mocked team by key. */
const TEAM: Record<string, Person> = {
  suresh: { id: 'pms-emp-suresh', name: 'Suresh Babu N.', code: 'SCL-10482', role: KILN, template: KILN_TEMPLATE },
  prakash: { id: 'pms-emp-prakash', name: 'Prakash Rao M.', code: 'SCL-10977', role: KILN, template: KILN_TEMPLATE },
  divya: { id: 'pms-emp-divya', name: 'Divya Sree P.', code: 'SCL-11204', role: KILN, template: KILN_TEMPLATE },
  naveen: { id: 'pms-emp-naveen', name: 'Naveen Kumar G.', code: 'SCL-10390', role: 'Sr. Engineer – Raw Mill', template: 'Raw Mill Engineer' },
  venkatesh: { id: 'pms-emp-venkatesh', name: 'Venkatesh B.', code: 'SCL-10731', role: KILN, template: KILN_TEMPLATE },
  kiran: { id: 'pms-emp-kiran', name: 'Kiran Kumar P.', code: 'SCL-11256', role: `${KILN} (Trainee)`, template: KILN_TEMPLATE },
}

const personById = (id: string): Person | undefined => Object.values(TEAM).find((p) => p.id === id)

// ── 3.6 Send to HOD / transfer banner ────────────────────────────────────────

/** Employees transferred into the team (banner on 3.6). */
export function mockTransferNotices(): PmsTransferNotice[] {
  if (transferStatus.get(TEAM.venkatesh.id) === 'sent') return []
  return [
    {
      employee_user_id: TEAM.venkatesh.id,
      employee_name: TEAM.venkatesh.name,
      joined_on: '2026-10-01',
      from_department: 'Raw Mill',
      previous_manager: 'Srinivasa Rao B.',
      recorded_by: 'Plant HR (Sunitha Rao)',
    },
  ]
}

// ── 3.8 Transferred employee: period 2 KRAs ──────────────────────────────────

const transferSheets = new Map<string, PmsTransferGoalSheet>()
const transferStatus = new Map<string, 'draft' | 'sent'>()

function seedTransferSheet(): PmsTransferGoalSheet {
  const p1 = 'Period 1 · Apr – Sep 2026'
  const p2 = 'Period 2 · Oct 2026 – Mar 2027'
  const tpl = (id: string, name: string, weight: number, target: number, unit: string) => ({
    id,
    kra_name: name,
    source: 'template' as const,
    source_label: 'Template · Kiln Ops',
    period: 2 as const,
    period_label: p2,
    weight,
    target,
    unit,
    locked: false,
  })
  return {
    employee_user_id: TEAM.venkatesh.id,
    employee_name: TEAM.venkatesh.name,
    emp_code: TEAM.venkatesh.code,
    previous: { department: 'Raw Mill', manager: 'Srinivasa Rao B.', period_label: 'Apr – Sep 2026' },
    current: { department: 'Kiln Ops', manager: MANAGER, period_label: 'from 01 Oct 2026' },
    recorded_by: 'Sunitha Rao (Plant HR)',
    recorded_on: '2026-10-01',
    kras: [
      { id: 'p1-1', kra_name: 'Raw mill output', source: 'template', source_label: 'Template · Raw Mill', period: 1, period_label: p1, weight: 60, target: 4200, unit: 'TPD', locked: true },
      { id: 'p1-2', kra_name: 'Raw meal residue', source: 'template', source_label: 'Template · Raw Mill', period: 1, period_label: p1, weight: 40, target: 12, unit: '%', locked: true },
      tpl('p2-1', 'Clinker production', 30, 5650, 'TPD'),
      tpl('p2-2', 'Specific heat consumption', 20, 720, 'kcal/kg'),
      tpl('p2-3', 'Kiln run factor', 20, 92, '%'),
      tpl('p2-4', 'Safety – LTI', 15, 0, 'Count'),
      {
        id: 'p2-5',
        kra_name: 'Kiln-2 commissioning support',
        source: 'manager',
        source_label: 'Added by manager',
        period: 2,
        period_label: p2,
        weight: 15,
        target: 100,
        unit: '% complete',
        locked: false,
      },
    ],
    reason: '',
    remarks: '',
    status: 'pending',
  }
}

/** The period 1 / period 2 goal sheet of a transferred employee. */
export function mockGetTransferSheet(employeeUserId: string): PmsTransferGoalSheet {
  if (employeeUserId !== TEAM.venkatesh.id) fail('This employee has no transfer recorded for the year', 404)
  if (!transferSheets.has(employeeUserId)) transferSheets.set(employeeUserId, seedTransferSheet())
  return clone(transferSheets.get(employeeUserId)!)
}

/** Replaces the period 2 rows; the frozen period 1 rows stay as they are. */
function applyTransferSheet(body: PmsTransferGoalSheetRequest, status: 'draft' | 'sent') {
  const current = mockGetTransferSheet(body.employee_user_id)
  const p2 = 'Period 2 · Oct 2026 – Mar 2027'
  const locked = current.kras.filter((k) => k.locked)
  const editable = body.kras.map((k, i) => ({
    id: `p2-${i + 1}`,
    kra_name: k.kra_name,
    source: k.source,
    source_label: k.source_label,
    period: 2 as const,
    period_label: p2,
    weight: k.weight,
    target: k.target,
    unit: k.unit,
    locked: false,
  }))
  const next: PmsTransferGoalSheet = {
    ...current,
    kras: [...locked, ...editable],
    reason: body.reason,
    remarks: body.remarks,
    status,
  }
  transferSheets.set(body.employee_user_id, next)
  transferStatus.set(body.employee_user_id, status)
  return next
}

/** Saves the period 2 rows as a draft. */
export function mockSaveTransferSheet(body: PmsTransferGoalSheetRequest): PmsTransferGoalSheet {
  return clone(applyTransferSheet(body, 'draft'))
}

/** Validates and sends the period 2 rows; updates the goal status mock. */
export function mockSendTransferSheet(body: PmsTransferGoalSheetRequest): PmsTransferGoalSheet {
  const total = body.kras.reduce((sum, k) => sum + k.weight, 0)
  if (body.kras.length === 0) fail('Add at least one period 2 KRA')
  if (Math.abs(total - 100) > 0.01) fail(`Period 2 weightage is ${total}% (must be 100%)`)
  if (body.kras.some((k) => k.target === null)) fail('Every Period 2 KRA needs a target')
  if (!body.reason.trim()) fail('Select a reason for the change')
  if (body.remarks.trim().length < 10) fail('Add at least 10 characters of remarks')
  const sheet = applyTransferSheet(body, 'sent')
  markTransferSent(body.employee_user_id)
  return clone(sheet)
}

// ── 3.9 Team progress ────────────────────────────────────────────────────────

const attention = (...items: Array<[string, PmsRag]>): PmsProgressKra[] =>
  items.map(([kra_name, rag]) => ({ kra_name, rag }))

/** Employee-level status from the achievement %, so the stat cards and rows agree. */
const ragFromAchievement = (pct: number): PmsRag => (pct >= 95 ? 'on_track' : pct >= 90 ? 'at_risk' : 'off_track')

/** Team progress rows (3.9): locked for employees whose goals are not approved. */
export function mockTeamProgress(): PmsTeamProgressRow[] {
  const row = (
    p: Person,
    on: number,
    att: PmsProgressKra[],
    achievement: number,
    comment: string | null,
  ): PmsTeamProgressRow => ({
    employee_user_id: p.id,
    employee_name: p.name,
    locked: false,
    kras_on_track: on,
    kras_total: 6,
    attention: att,
    achievement,
    comment,
    overall_rag: ragFromAchievement(achievement),
  })
  return [
    row(TEAM.suresh, 5, attention(['Specific heat consumption', 'at_risk']), 96.8, 'Coal feed issue 12–14 Jul; burner trial planned in Aug.'),
    row(TEAM.prakash, 5, attention(['Kiln run factor', 'at_risk']), 94.1, null),
    row(
      TEAM.divya,
      3,
      attention(['Clinker production', 'off_track'], ['Kiln run factor', 'at_risk'], ['Power consumption', 'at_risk']),
      88.4,
      'Mill-2 breakdown; waiting on spares.',
    ),
    row(TEAM.naveen, 6, [], 101.2, 'All KRAs on plan.'),
    {
      employee_user_id: 'pms-emp-ramesh',
      employee_name: 'Ramesh Goud K.',
      locked: true,
      kras_on_track: 0,
      kras_total: 6,
      attention: [],
      achievement: null,
      comment: null,
      overall_rag: null,
    },
  ]
}

// ── 3.10 - 3.12 Mid-year review ──────────────────────────────────────────────

const midYearStatus = new Map<string, PmsMidYearStatus>([
  [TEAM.suresh.id, 'not_started'],
  [TEAM.prakash.id, 'completed_no_revision'],
  [TEAM.divya.id, 'revision_requested'],
  [TEAM.naveen.id, 'not_started'],
])

const MID_YEAR_ACHIEVEMENT: Record<string, number> = {
  [TEAM.suresh.id]: 96.8,
  [TEAM.prakash.id]: 94.1,
  [TEAM.divya.id]: 88.4,
  [TEAM.naveen.id]: 101.2,
}

const midYearNotes = new Map<string, { notes: string; revision: boolean | null }>()

/** Mid-year team rows (3.10). */
export function mockMidYearTeam(): PmsMidYearRow[] {
  return [...midYearStatus.entries()].map(([id, status]) => {
    const p = personById(id)!
    const pct = MID_YEAR_ACHIEVEMENT[id]
    return {
      employee_user_id: id,
      employee_name: p.name,
      role: p.role,
      h1_achievement: pct,
      rag: ragFromAchievement(pct),
      status,
    }
  })
}

const KILN_KRAS: Array<Omit<PmsMidYearKra, 'kpi_id'>> = [
  { kra_name: 'Clinker production', target: 5650, unit: 'TPD', h1_actual: 5180, rag: 'at_risk' },
  { kra_name: 'Specific heat consumption', target: 720, unit: 'kcal/kg', h1_actual: 728, rag: 'at_risk' },
  { kra_name: 'Kiln run factor', target: 92, unit: '%', h1_actual: 93.1, rag: 'on_track' },
  { kra_name: 'Power consumption', target: 18.5, unit: 'kWh/t', h1_actual: 18.2, rag: 'on_track' },
  { kra_name: 'Safety – LTI', target: 0, unit: 'Count', h1_actual: 0, rag: 'on_track' },
  { kra_name: 'Refractory life', target: 10, unit: 'Months', h1_actual: 11, rag: 'on_track' },
]

const midYearKras = (): PmsMidYearKra[] => KILN_KRAS.map((k, i) => ({ ...k, kpi_id: `kpi-${i + 1}` }))

/** One mid-year review sheet (3.11). */
export function mockMidYearReview(employeeUserId: string): PmsMidYearReview {
  const p = personById(employeeUserId)
  const status = midYearStatus.get(employeeUserId)
  if (!p || !status) fail('This employee is not in your team for the mid-year review', 404)
  const saved = midYearNotes.get(employeeUserId)
  return {
    employee_user_id: employeeUserId,
    employee_name: p!.name,
    emp_code: p!.code,
    role: p!.role,
    manager: MANAGER,
    template: p!.template,
    status: status!,
    kras: midYearKras(),
    discussion_notes: saved?.notes ?? '',
    revision_required: saved?.revision ?? null,
  }
}

/** Saves the discussion notes and the revision decision. */
export function mockSubmitMidYear(body: PmsMidYearSubmit): PmsMidYearReview {
  const current = mockMidYearReview(body.employee_user_id)
  if (current.status === 'revision_requested') fail('A target revision is already with the HOD for this employee')
  if (body.revision_required && body.discussion_notes.trim().length < 10) {
    fail('Add discussion notes (at least 10 characters) to justify a target revision')
  }
  midYearNotes.set(body.employee_user_id, { notes: body.discussion_notes, revision: body.revision_required })
  // "Yes" leaves the review open: it completes when the revision request is sent (3.12).
  if (!body.revision_required) midYearStatus.set(body.employee_user_id, 'completed_no_revision')
  return mockMidYearReview(body.employee_user_id)
}

const revisionAttachments = new Map<string, string | null>()

/** The revision request sheet (3.12). */
export function mockRevisionRequest(employeeUserId: string): PmsRevisionRequest {
  const review = mockMidYearReview(employeeUserId)
  const weights = [25, 20, 20, 15, 10, 10]
  return {
    employee_user_id: employeeUserId,
    employee_name: review.employee_name,
    emp_code: review.emp_code,
    role: review.role,
    manager: review.manager,
    template: review.template,
    kras: review.kras.map((k, i) => ({
      kpi_id: k.kpi_id,
      kra_name: k.kra_name,
      weight: weights[i] ?? 0,
      current_target: k.target,
      unit: k.unit,
      revised_target: null,
      reason: '',
    })),
    attachment_name: revisionAttachments.get(employeeUserId) ?? null,
    status: review.status === 'revision_requested' ? 'pending_hod' : null,
  }
}

/** Validates and sends the revised targets to the HOD. */
export function mockSubmitRevision(body: PmsRevisionSubmit): PmsRevisionRequest {
  if (body.rows.length === 0) fail('Revise at least one target before sending to the HOD')
  if (body.rows.some((r) => r.reason.trim().length < 5)) fail('Give a reason for every revised target')
  revisionAttachments.set(body.employee_user_id, body.attachment_name)
  midYearStatus.set(body.employee_user_id, 'revision_requested')
  return mockRevisionRequest(body.employee_user_id)
}

// ── 3.13 / 3.14 Team appraisal ───────────────────────────────────────────────

const managerStatus = new Map<string, PmsManagerRatingStatus>([
  [TEAM.suresh.id, 'pending'],
  [TEAM.prakash.id, 'submitted_to_hod'],
  [TEAM.venkatesh.id, 'period_1_rated'],
  [TEAM.divya.id, 'waiting'],
  [TEAM.naveen.id, 'draft'],
  [TEAM.kiran.id, 'not_applicable'],
])

const SELF_SCORE: Record<string, number | null> = {
  [TEAM.suresh.id]: 3.87,
  [TEAM.prakash.id]: 3.6,
  [TEAM.venkatesh.id]: 3.9,
  [TEAM.divya.id]: null,
  [TEAM.naveen.id]: 4.0,
  [TEAM.kiran.id]: null,
}

/** Team appraisal rows (3.13). */
export function mockTeamAppraisal(): PmsTeamAppraisalRow[] {
  return [...managerStatus.entries()].map(([id, status]) => {
    const p = personById(id)!
    const self = SELF_SCORE[id]
    const transferred = id === TEAM.venkatesh.id
    return {
      employee_user_id: id,
      employee_name: p.name,
      role: transferred ? `${p.role} (transferred)` : p.role,
      self_status: status === 'not_applicable' ? 'not_applicable' : self === null ? 'not_submitted' : 'submitted',
      self_score: self,
      manager_status: status,
      manager_note: transferred ? 'Period 1 rated by Srinivasa Rao B.' : null,
    }
  })
}

const KRA_SELF_RATINGS = [4, 4, 3, 4, 5, 4]
const KRA_ACTUALS = [5540, 726, 90.8, 18.2, 0, 11]
const KRA_TARGETS = [5450, 720, 92, 18.5, 0, 10]
const KRA_ATTACHMENTS = ['DCS_Report_FY27.pdf', 'Energy_Audit.pdf', null, 'SCADA_Log.xlsx', 'Safety_MIS.pdf', null]
const COMPETENCY_NAMES = [
  'Attitude towards work',
  'Attitude towards people',
  'Dependability',
  'Listening and communication skills',
  'Takes initiative at work',
  'Commitment at work',
  'Flexibility at work',
  'Cost consciousness',
  'Consistency at work',
  'Enthusiasm & Creativity at work',
]
const COMPETENCY_SELF = [4, 3, 4, 4, 4, 4, 3, 3, 4, 3]
const HR_COMPETENCIES = [
  { id: 'hr-1', name: 'Attendance and Punctuality', self_rating: 4 },
  { id: 'hr-2', name: 'Discipline', self_rating: 4 },
  { id: 'hr-3', name: 'Honesty and Integrity', self_rating: 5 },
  { id: 'hr-4', name: 'Co-employee relations at work (Teamwork)', self_rating: 3 },
]

const appraisalDrafts = new Map<string, PmsManagerAppraisalSave>()

/** One manager appraisal sheet (3.14). */
export function mockManagerAppraisal(employeeUserId: string): PmsManagerAppraisal {
  const p = personById(employeeUserId)
  const status = managerStatus.get(employeeUserId)
  if (!p || !status) fail('This employee is not in your team for the appraisal', 404)
  if (status === 'waiting') fail('Waiting for the employee to submit the self appraisal', 409)
  if (status === 'not_applicable') fail('Appraisal is not applicable for this employee', 409)

  const draft = appraisalDrafts.get(employeeUserId)
  const kras: PmsAppraisalKra[] = KILN_KRAS.map((k, i) => {
    const d = draft?.kras.find((r) => r.kpi_id === `kpi-${i + 1}`)
    return {
      kpi_id: `kpi-${i + 1}`,
      kra_name: k.kra_name,
      target: KRA_TARGETS[i],
      unit: k.unit,
      actual: KRA_ACTUALS[i],
      self_rating: KRA_SELF_RATINGS[i],
      manager_rating: d?.rating ?? null,
      attachment_name: KRA_ATTACHMENTS[i],
      comment: d?.comment ?? '',
    }
  })
  const competencies: PmsAppraisalCompetency[] = COMPETENCY_NAMES.map((name, i) => {
    const d = draft?.competencies.find((r) => r.id === `comp-${i + 1}`)
    return {
      id: `comp-${i + 1}`,
      name,
      self_rating: COMPETENCY_SELF[i],
      manager_rating: d?.rating ?? null,
      comment: d?.comment ?? '',
    }
  })
  return {
    employee_user_id: employeeUserId,
    employee_name: p!.name,
    emp_code: p!.code,
    period_label: employeeUserId === TEAM.venkatesh.id ? 'Period 2 · Oct 2026 – Mar 2027' : null,
    status: status!,
    kras,
    competencies,
    hr_competencies: clone(HR_COMPETENCIES),
    recommended_rating: draft?.recommended_rating ?? null,
    comments: draft?.comments ?? '',
  }
}

/** Saves the manager ratings as a draft. */
export function mockSaveAppraisal(body: PmsManagerAppraisalSave): PmsManagerAppraisal {
  const current = mockManagerAppraisal(body.employee_user_id)
  if (current.status === 'submitted_to_hod') fail('This appraisal is already with the HOD')
  appraisalDrafts.set(body.employee_user_id, clone(body))
  if (current.status === 'pending') managerStatus.set(body.employee_user_id, 'draft')
  return mockManagerAppraisal(body.employee_user_id)
}

/** Validates every rating and submits to the HOD. */
export function mockSubmitAppraisal(body: PmsManagerAppraisalSave): PmsManagerAppraisal {
  if (body.kras.some((k) => k.rating === null) || body.competencies.some((c) => c.rating === null)) {
    fail('Rate every KRA and competency before submitting to the HOD')
  }
  if (body.recommended_rating === null) fail('Choose a recommended rating')
  mockSaveAppraisal(body)
  managerStatus.set(body.employee_user_id, 'submitted_to_hod')
  return mockManagerAppraisal(body.employee_user_id)
}

// ── Base-query hook ──────────────────────────────────────────────────────────

const ok = <T>(data: T) => ({ data: { success: true, message: 'OK', data } })

/**
 * Returns a base-query result for the manager calls this mock covers, or
 * `null` to let the request go on to the real API.
 */
export async function staticManagerScreens(
  args: string | FetchArgs,
): Promise<{ data: unknown } | { error: FetchBaseQueryError } | null> {
  const req = typeof args === 'string' ? { url: args } : args
  const params = (req.params ?? {}) as Record<string, string>
  const employee = params.employee_user_id
  const body = req.body as never

  try {
    switch (req.url) {
      case '/pms-goal-transfer/get/notices':
        await mockLatency(150)
        return ok(mockTransferNotices())
      case '/pms-goal-transfer/get/transfer-sheet':
        await mockLatency(250)
        return ok(mockGetTransferSheet(employee))
      case '/pms-goal-transfer/update/transfer-sheet':
        await mockLatency(400)
        return ok(mockSaveTransferSheet(body))
      case '/pms-goal-transfer/send/transfer-sheet':
        await mockLatency(500)
        return ok(mockSendTransferSheet(body))
      case '/pms-goal-assignment/send-to-hod': {
        await mockLatency(450)
        const request = body as PmsSendToHodRequest
        return ok(markSentToHod(request.employee_user_ids))
      }
      case '/pms-progress/get/team':
        await mockLatency(300)
        return ok(mockTeamProgress())
      case '/pms-mid-year/get/team':
        await mockLatency(300)
        return ok(mockMidYearTeam())
      case '/pms-mid-year/get/review':
        await mockLatency(250)
        return ok(mockMidYearReview(employee))
      case '/pms-mid-year/submit/review':
        await mockLatency(450)
        return ok(mockSubmitMidYear(body))
      case '/pms-mid-year/get/revision-request':
        await mockLatency(250)
        return ok(mockRevisionRequest(employee))
      case '/pms-mid-year/submit/revision-request':
        await mockLatency(500)
        return ok(mockSubmitRevision(body))
      case '/pms-appraisal/get/team':
        await mockLatency(300)
        return ok(mockTeamAppraisal())
      case '/pms-appraisal/get/manager-appraisal':
        await mockLatency(300)
        return ok(mockManagerAppraisal(employee))
      case '/pms-appraisal/update/manager-appraisal':
        await mockLatency(400)
        return ok(mockSaveAppraisal(body))
      case '/pms-appraisal/submit/manager-appraisal':
        await mockLatency(500)
        return ok(mockSubmitAppraisal(body))
      default:
        return null
    }
  } catch (e) {
    return { error: e as FetchBaseQueryError }
  }
}
