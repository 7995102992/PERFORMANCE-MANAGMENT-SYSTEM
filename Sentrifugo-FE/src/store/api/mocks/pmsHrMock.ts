// ─── STATIC MOCK DATA — Corporate HR screens 1.7 - 1.9 ───────────────────────
// Answers the HR competency rating and calibration calls without the PMS backend.
// `pmsApi.ts` puts this in front of the real base query; it is on by default and
// switched off with VITE_PMS_STATIC_DATA=false when the screens should call PMS_Java
// (`/pms-hr-appraisal`, `/pms-calibration`). Replies use the same
// `{ success, message, data }` envelope as the API. State is in-memory, so
// submissions survive navigation but not a page reload.

import type { FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query'
import type {
  PmsCalibration,
  PmsCalibrationEmployee,
  PmsCalibrationSave,
  PmsHrAppraisal,
  PmsHrAppraisalSave,
  PmsHrManagerCompetency,
  PmsHrQueueRow,
  PmsHrRatingStatus,
  PmsSendToCalibration,
} from '@/types/pms-hr'
import { mockLatency } from './pmsCycleMock'

/** Throws the `{ status, data }` shape the RTK error handlers read. */
const fail = (detail: string, status = 422): never => {
  throw { status, data: { detail } }
}

/** Deep copy, so callers cannot change the stored mock state. */
const clone = <T>(value: T): T => structuredClone(value)

// ── Roster ───────────────────────────────────────────────────────────────────

/** One mocked employee in the HR queue. */
interface Person {
  id: string
  name: string
  code: string
  department: string
  head: string
  role: string
  hodRatedOn: string
  status: PmsHrRatingStatus
}

/** The five employees of screen 1.7. */
const PEOPLE: Person[] = [
  { id: 'hr-emp-anil', name: 'Anil Kumar V.', code: 'SCL-10302', department: 'Finance', head: 'Kiran Kumar D.', role: 'Sr. Executive – Finance', hodRatedOn: '2027-04-22', status: 'rated' },
  { id: 'hr-emp-meena', name: 'Meena Kumari R.', code: 'SCL-10566', department: 'Accounts', head: 'Kiran Kumar D.', role: 'Executive – Accounts', hodRatedOn: '2027-04-22', status: 'pending' },
  { id: 'hr-emp-sravan', name: 'Sravan Kumar T.', code: 'SCL-11420', department: 'IT', head: 'Prasad V. N.', role: 'Engineer – IT', hodRatedOn: '2027-04-23', status: 'rated' },
  { id: 'hr-emp-padmaja', name: 'Padmaja L.', code: 'SCL-10918', department: 'Legal', head: 'Prasad V. N.', role: 'Executive – Legal', hodRatedOn: '2027-04-23', status: 'pending' },
  { id: 'hr-emp-rama', name: 'Ramakrishna P.', code: 'SCL-10233', department: 'Purchase', head: 'Kiran Kumar D.', role: 'Sr. Executive – Purchase', hodRatedOn: '2027-04-23', status: 'pending' },
]

/** HR competencies with the employee self rating. */
const HR_COMPETENCIES = [
  { id: 'hrc-attendance', name: 'Attendance and Punctuality', self: 4 },
  { id: 'hrc-discipline', name: 'Discipline', self: 4 },
  { id: 'hrc-honesty', name: 'Honesty and Integrity', self: 5 },
  { id: 'hrc-teamwork', name: 'Co-employee relations at work (Teamwork)', self: 3 },
]

/** Manager competencies (self, manager and HOD ratings), view only on 1.8. */
const MANAGER_COMPETENCIES: PmsHrManagerCompetency[] = [
  ['Attitude towards work', 4, 4, 4],
  ['Attitude towards people', 3, 3, 3],
  ['Dependability', 4, 4, 4],
  ['Listening and communication skills', 4, 3, 3],
  ['Takes initiative at work', 4, 4, 4],
  ['Commitment at work', 4, 4, 4],
  ['Flexibility at work', 3, 3, 3],
  ['Cost consciousness', 3, 3, 3],
  ['Consistency at work', 4, 4, 4],
  ['Enthusiasm & Creativity at work', 3, 3, 3],
].map(([name, self, manager, hod], i) => ({
  id: `mgc-${i}`,
  name: name as string,
  self_rating: self as number,
  manager_rating: manager as number,
  hod_rating: hod as number,
}))

// ── State ────────────────────────────────────────────────────────────────────

/** HR rating state of one employee. */
interface HrState {
  status: PmsHrRatingStatus
  ratings: Record<string, number | null>
  comments: Record<string, string>
  remarks: string
  sent: boolean
}

/** HR rating state per employee id. */
const state = new Map<string, HrState>(
  PEOPLE.map((p) => [
    p.id,
    {
      status: p.status,
      ratings:
        p.status === 'rated'
          ? Object.fromEntries(HR_COMPETENCIES.map((c) => [c.id, c.self]))
          : Object.fromEntries(HR_COMPETENCIES.map((c) => [c.id, null])),
      comments: {},
      remarks: p.status === 'rated' ? 'Good attendance; no disciplinary cases.' : '',
      sent: false,
    },
  ]),
)

/** Employee by id (404 error when unknown). */
const person = (id: string): Person => PEOPLE.find((p) => p.id === id) ?? fail('Employee not found', 404)
const stateOf = (id: string): HrState => state.get(id) ?? fail('Employee not found', 404)

// ── 1.7 / 1.8 ────────────────────────────────────────────────────────────────

/** Screen 1.7 rows. */
export function mockHrQueue(): PmsHrQueueRow[] {
  return PEOPLE.map((p) => ({
    employee_user_id: p.id,
    employee_name: p.name,
    emp_code: p.code,
    department_id: null,
    department_name: p.department,
    functional_head: p.head,
    hod_rated_on: p.hodRatedOn,
    status: stateOf(p.id).status,
    sent_to_calibration: stateOf(p.id).sent,
  }))
}

/** Screen 1.8 sheet for one employee. */
export function mockHrAppraisal(employeeUserId: string): PmsHrAppraisal {
  const p = person(employeeUserId)
  const s = stateOf(employeeUserId)
  return {
    employee_user_id: p.id,
    employee_name: p.name,
    emp_code: p.code,
    role: p.role,
    department_id: null,
    department_name: p.department,
    reporting_manager: p.head,
    status: s.status,
    locked: s.sent,
    hr_competencies: HR_COMPETENCIES.map((c) => ({
      id: c.id,
      name: c.name,
      self_rating: c.self,
      hr_rating: s.ratings[c.id] ?? null,
      comment: s.comments[c.id] ?? '',
    })),
    manager_competencies: clone(MANAGER_COMPETENCIES),
    remarks: s.remarks,
  }
}

/** Validates and stores ratings, comments and remarks. */
function store(body: PmsHrAppraisalSave): HrState {
  const s = stateOf(body.employee_user_id)
  if (s.sent) fail('This employee is already with calibration.', 409)
  for (const line of body.competencies) {
    if (!HR_COMPETENCIES.some((c) => c.id === line.id)) fail('That is not an HR competency of this template')
    if (line.rating !== null && (line.rating < 1 || line.rating > 5)) fail('Ratings must be between 1 and 5')
    s.ratings[line.id] = line.rating
    s.comments[line.id] = line.comment
  }
  s.remarks = body.remarks
  return s
}

/** Saves HR ratings as a draft. */
export function mockSaveHrAppraisal(body: PmsHrAppraisalSave): PmsHrAppraisal {
  const s = store(body)
  s.status = 'draft'
  return mockHrAppraisal(body.employee_user_id)
}

/** Submits HR ratings (every competency rated). */
export function mockSubmitHrAppraisal(body: PmsHrAppraisalSave): PmsHrAppraisal {
  const s = store(body)
  if (HR_COMPETENCIES.some((c) => s.ratings[c.id] === null)) fail('Rate every HR competency before submitting')
  s.status = 'rated'
  return mockHrAppraisal(body.employee_user_id)
}

/** Sends rated employees to calibration (409 for anyone not rated). */
export function mockSendToCalibration(body: PmsSendToCalibration): { sent: number } {
  for (const id of body.employee_user_ids) {
    if (stateOf(id).status !== 'rated') fail(`${person(id).name} has not been rated yet.`, 409)
  }
  body.employee_user_ids.forEach((id) => {
    stateOf(id).sent = true
    seedCalibration(id)
  })
  return { sent: body.employee_user_ids.length }
}

// ── 1.9 ──────────────────────────────────────────────────────────────────────

/** Rating level labels. */
const LABELS: Record<number, string> = {
  5: 'Outstanding',
  4: 'Exceeds Expectations',
  3: 'Meets Expectations',
  2: 'Needs Improvement',
  1: 'Unsatisfactory',
}
/** The standard normalization guideline per rating (5 / 20 / 60 / 10 / 5). */
const GUIDELINE: Record<number, number> = { 5: 5, 4: 20, 3: 60, 2: 10, 1: 5 }

/** Employees already with calibration before HR sends anyone, so the screen has something to show. */
const CALIBRATION: PmsCalibrationEmployee[] = [
  ['hr-cal-suresh', 'Suresh Babu N.', 'SCL-10482', 4, 4, 4.0, 4],
  ['hr-cal-kavya', 'Kavya L. D.', 'SCL-10771', 5, 5, 4.25, 5],
  ['hr-cal-venu', 'Venu Gopal R.', 'SCL-10955', 4, 4, 3.5, 4],
  ['hr-cal-divya', 'Divya Sree P.', 'SCL-11204', 2, 3, 3.75, 3],
].map(([id, name, code, manager, hod, avg, current]) => ({
  employee_user_id: id as string,
  employee_name: name as string,
  emp_code: code as string,
  manager_rating: manager as number,
  hod_rating: hod as number,
  hr_competency_avg: avg as number,
  current_rating: current as number,
  calibrated_rating: current as number,
  reason: '',
}))

/** HR normalization targets per rating (start at the guideline). */
const hrPercent: Record<number, number> = { ...GUIDELINE }
let published = false

/** Adds an employee that was just sent to calibration. */
function seedCalibration(userId: string) {
  if (CALIBRATION.some((e) => e.employee_user_id === userId)) return
  const p = person(userId)
  const s = stateOf(userId)
  const given = HR_COMPETENCIES.map((c) => s.ratings[c.id]).filter((r): r is number => r !== null)
  const avg = given.length ? Math.round((given.reduce((a, b) => a + b, 0) / given.length) * 100) / 100 : null
  CALIBRATION.push({
    employee_user_id: userId,
    employee_name: p.name,
    emp_code: p.code,
    manager_rating: 3,
    hod_rating: 3,
    hr_competency_avg: avg,
    current_rating: 3,
    calibrated_rating: 3,
    reason: '',
  })
}

/** Whole percents of the employees at each rating, adding up to 100 (largest remainder). */
function currentDistribution(): Record<number, number> {
  const out: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
  const rated = CALIBRATION.filter((e) => e.calibrated_rating !== null)
  if (rated.length === 0) return out
  const exact = [5, 4, 3, 2, 1].map((r) => ({
    rating: r,
    value: (rated.filter((e) => e.calibrated_rating === r).length * 100) / rated.length,
  }))
  exact.forEach((e) => (out[e.rating] = Math.floor(e.value)))
  let left = 100 - Object.values(out).reduce((a, b) => a + b, 0)
  exact
    .sort((a, b) => b.value - Math.floor(b.value) - (a.value - Math.floor(a.value)))
    .forEach((e) => {
      if (left > 0) {
        out[e.rating] += 1
        left -= 1
      }
    })
  return out
}

/** Screen 1.9 data. */
export function mockCalibration(financialYear: string): PmsCalibration {
  const current = currentDistribution()
  return {
    financial_year: financialYear,
    published,
    distribution: [5, 4, 3, 2, 1].map((r) => ({
      rating: r,
      label: LABELS[r],
      current_percent: current[r],
      guideline_percent: GUIDELINE[r],
      hr_percent: hrPercent[r],
    })),
    employees: clone(CALIBRATION),
  }
}

/** Stores the targets and calibrated ratings. */
export function mockSaveCalibration(body: PmsCalibrationSave): PmsCalibration {
  if (published) fail('These ratings are already published.', 409)
  body.distribution.forEach((l) => (hrPercent[l.rating] = l.hr_percent))
  for (const e of body.employees) {
    const row = CALIBRATION.find((c) => c.employee_user_id === e.employee_user_id)
    if (!row) fail('That employee has not been sent to calibration')
    else {
      row.calibrated_rating = e.calibrated_rating
      row.reason = e.reason
    }
  }
  return mockCalibration(body.financial_year)
}

/** Publishes: targets must total 100 and changed ratings need a reason. */
export function mockPublishCalibration(financialYear: string): PmsCalibration {
  if (published) fail('These ratings are already published.', 409)
  const total = Object.values(hrPercent).reduce((a, b) => a + b, 0)
  if (total !== 100) fail(`HR normalization total is ${total}%. Ratings cannot be published until the total is 100%.`)
  for (const e of CALIBRATION) {
    if (e.calibrated_rating !== e.current_rating && e.reason.trim().length < 5) {
      fail(`Give a reason for changing the rating of ${e.employee_name}`)
    }
  }
  published = true
  return mockCalibration(financialYear)
}

// ── Base-query hook ──────────────────────────────────────────────────────────

const ok = <T>(data: T) => ({ data: { success: true, message: 'OK', data } })

/**
 * Returns a base-query result for the HR calls this mock covers, or `null` to let the request go on to
 * the real API.
 */
export async function staticHrScreens(
  args: string | FetchArgs,
): Promise<{ data: unknown } | { error: FetchBaseQueryError } | null> {
  const req = typeof args === 'string' ? { url: args } : args
  const params = (req.params ?? {}) as Record<string, string>
  const body = req.body as never

  try {
    switch (req.url) {
      case '/pms-hr-appraisal/get/queue':
        await mockLatency(250)
        return ok(mockHrQueue())
      case '/pms-hr-appraisal/get/employee':
        await mockLatency(250)
        return ok(mockHrAppraisal(params.employee_user_id))
      case '/pms-hr-appraisal/update/hr-ratings':
        await mockLatency(400)
        return ok(mockSaveHrAppraisal(body))
      case '/pms-hr-appraisal/submit/hr-ratings':
        await mockLatency(500)
        return ok(mockSubmitHrAppraisal(body))
      case '/pms-hr-appraisal/send/calibration':
        await mockLatency(450)
        return ok(mockSendToCalibration(body))
      case '/pms-calibration/get/calibration':
        await mockLatency(300)
        return ok(mockCalibration(params.financial_year))
      case '/pms-calibration/update/calibration':
        await mockLatency(400)
        return ok(mockSaveCalibration(body))
      case '/pms-calibration/publish/calibration': {
        await mockLatency(500)
        const request = body as { financial_year: string }
        return ok(mockPublishCalibration(request.financial_year))
      }
      default:
        return null
    }
  } catch (e) {
    return { error: e as FetchBaseQueryError }
  }
}
