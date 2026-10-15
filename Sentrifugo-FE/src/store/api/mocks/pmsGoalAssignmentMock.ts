// ─── STATIC MOCK DATA — manager goal assignment (screens 3.1 - 3.7) ──────────
// Answers the /pms-goal-assignment team and target calls without the PMS
// backend. `pmsApi.ts` puts this in front of the real base query; it is on by
// default and switched off with VITE_PMS_STATIC_DATA=false once the backend is
// reachable. State is in-memory, so sends and drafts survive navigation but not
// a page reload. Replies use the same `{ success, message, data }` envelope as
// the API, so the endpoints' transformResponse stays unchanged.
//
// Three rosters, matching the mockups:
//   - 3.1 "My Team"            -> `get/team`                (5 people)
//   - 3.2 "Select Employee"    -> `get/team?scope=role`     (the roles' employees)
//   - 3.6 "Goal Status"        -> `get/team?scope=status`   (returned sheets, a transfer)
// 3.1 and 3.2 share one set of goal sheets, so sending targets on 3.5 shows up
// on 3.1. 3.6 has its own sheets, because it shows a later point in the cycle.

import type { FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query'
import type {
  PmsEmployeeTargetKpi,
  PmsEmployeeTargets,
  PmsTargetHistoryRow,
  PmsTargetsRequest,
  PmsTargetValidation,
  PmsTeamMember,
} from '@/types/pms-goals'
import { mockLatency } from './pmsCycleMock'

/** Name of the mocked signed-in manager. */
const MANAGER = 'Ravi Teja K.'
/** The acknowledge-by date shown on every sent sheet. */
const ACK_DUE = '2026-05-25'

type RoleKey = 'kiln' | 'rawmill'

const ROLES: Record<RoleKey, { id: string; name: string; template: string }> = {
  kiln: { id: 'des-kiln-engineer', name: 'Engineer – Kiln Ops', template: 'Production Engineer' },
  rawmill: { id: 'des-raw-mill-sr', name: 'Sr. Engineer – Raw Mill', template: 'Raw Mill Engineer' },
}

interface Member {
  id: string
  code: string
  name: string
  role: RoleKey
  employment: 'Permanent' | 'Trainee'
}

/** Builds a team member for the 3.1 / 3.2 roster. */
const m = (slug: string, code: string, name: string, role: RoleKey = 'kiln', employment: Member['employment'] = 'Permanent'): Member => ({
  id: `pms-emp-${slug}`,
  code,
  name,
  role,
  employment,
})

const SURESH = m('suresh', 'SCL-10482', 'Suresh Babu N.')
const PRAKASH = m('prakash', 'SCL-10977', 'Prakash Rao M.')
const DIVYA = m('divya', 'SCL-11204', 'Divya Sree P.')
const NAVEEN = m('naveen', 'SCL-10390', 'Naveen Kumar G.', 'rawmill')
const SRINIVAS = m('srinivas', 'SCL-10120', 'Srinivas Y.', 'rawmill')
const RAMESH = m('ramesh', 'SCL-10655', 'Ramesh Goud K.')
const VENKATESH = m('venkatesh', 'SCL-10731', 'Venkatesh B.')
const LAKSHMI = m('lakshmi', 'SCL-10844', 'Lakshmi Narayana T.')
const HARISH = m('harish', 'SCL-11012', 'Harish Kumar S.')
const SANDEEP = m('sandeep', 'SCL-11087', 'Sandeep Reddy V.')
const ANUSHA = m('anusha', 'SCL-11139', 'Anusha M.')
const KIRAN = m('kiran', 'SCL-11256', 'Kiran Kumar P.', 'kiln', 'Trainee')

/** 3.1 */
const SUMMARY_ROSTER = [SURESH, PRAKASH, DIVYA, NAVEEN, SRINIVAS]
/** 3.2 */
const ROLE_ROSTER = [SURESH, PRAKASH, DIVYA, RAMESH, VENKATESH, LAKSHMI, HARISH, SANDEEP, ANUSHA, KIRAN, NAVEEN, SRINIVAS]

// 3.6 uses its own people ids (same names), except the transferred employee, who 3.8 looks up.
const st = (slug: string, code: string, name: string, role: RoleKey = 'kiln'): Member => ({
  id: `pms-st-${slug}`,
  code,
  name,
  role,
  employment: 'Permanent',
})
const ST_SURESH = st('suresh', 'SCL-10482', 'Suresh Babu N.')
const ST_RAMESH = st('ramesh', 'SCL-10655', 'Ramesh Goud K.')
const ST_PRAKASH = st('prakash', 'SCL-10977', 'Prakash Rao M.')
const ST_DIVYA = st('divya', 'SCL-11204', 'Divya Sree P.')
const ST_NAVEEN = st('naveen', 'SCL-10390', 'Naveen Kumar G.', 'rawmill')
const ST_LAKSHMI = st('lakshmi', 'SCL-10844', 'Lakshmi Narayana T.')
const ST_SRINIVAS = st('srinivas', 'SCL-10120', 'Srinivas Y.', 'rawmill')
/** 3.6, in the order the mockup lists them. The transferred employee is VENKATESH, whom 3.8 opens. */
const STATUS_ROSTER = [ST_SURESH, ST_RAMESH, VENKATESH, ST_PRAKASH, ST_DIVYA, ST_NAVEEN, ST_LAKSHMI, ST_SRINIVAS]

// ── Goal sheets ──────────────────────────────────────────────────────────────

interface KpiSeed extends Omit<PmsEmployeeTargetKpi, 'target' | 'history'> {
  default_target: number
}

const KILN_KPIS: KpiSeed[] = [
  { kpi_id: 'kpi-1', kra_name: 'Production', kpi_name: 'Clinker production', unit: 'TPD', expected_outcome: 'Sustain planned output', evidence_required: 'DCS report', weight: 25, default_target: 5800, target_type: 'common' },
  { kpi_id: 'kpi-2', kra_name: 'Energy', kpi_name: 'Specific heat consumption', unit: 'kcal/kg', expected_outcome: 'Reduce fuel use', evidence_required: 'Energy audit', weight: 20, default_target: 720, target_type: 'common' },
  { kpi_id: 'kpi-3', kra_name: 'Reliability', kpi_name: 'Kiln run factor', unit: '%', expected_outcome: 'Minimise stoppages', evidence_required: 'Stoppage log', weight: 20, default_target: 92, target_type: 'common' },
  { kpi_id: 'kpi-4', kra_name: 'Energy', kpi_name: 'Power consumption', unit: 'kWh/t', expected_outcome: 'Reduce power use', evidence_required: 'SCADA', weight: 15, default_target: 18.5, target_type: 'common' },
  { kpi_id: 'kpi-5', kra_name: 'Safety', kpi_name: 'Safety – LTI', unit: 'Count', expected_outcome: 'Zero LTI', evidence_required: 'Safety MIS', weight: 10, default_target: 0, target_type: 'individual' },
  { kpi_id: 'kpi-6', kra_name: 'Reliability', kpi_name: 'Refractory life', unit: 'Months', expected_outcome: 'Extend campaign', evidence_required: 'Refractory log', weight: 10, default_target: 10, target_type: 'individual' },
]

const RAW_MILL_KPIS: KpiSeed[] = [
  { kpi_id: 'kpi-r1', kra_name: 'Production', kpi_name: 'Raw mill output', unit: 'TPD', expected_outcome: 'Sustain planned output', evidence_required: 'DCS report', weight: 60, default_target: 4200, target_type: 'common' },
  { kpi_id: 'kpi-r2', kra_name: 'Quality', kpi_name: 'Raw meal residue', unit: '%', expected_outcome: 'Hold residue within limit', evidence_required: 'Lab report', weight: 40, default_target: 12, target_type: 'common' },
]

/** KPI set of a role. */
const kpisFor = (role: RoleKey) => (role === 'kiln' ? KILN_KPIS : RAW_MILL_KPIS)

/** Three previous years. The first KPI uses the mockup's figures; the rest scale from the default target. */
function historyFor(kpi: KpiSeed): PmsTargetHistoryRow[] {
  if (kpi.kpi_id === 'kpi-1') {
    return [
      { financial_year: '2025-26', target: 5600, actual: 5540 },
      { financial_year: '2024-25', target: 5400, actual: 5450 },
      { financial_year: '2023-24', target: 5200, actual: 5050 },
    ]
  }
  const round = (n: number) => Math.round(n * 100) / 100
  const years = ['2025-26', '2024-25', '2023-24']
  const targetFactor = [0.97, 0.94, 0.91]
  const actualFactor = [0.96, 0.95, 0.89]
  return years.map((financial_year, i) => ({
    financial_year,
    target: round(kpi.default_target * targetFactor[i]),
    actual: round(kpi.default_target * actualFactor[i]),
  }))
}

interface Sheet {
  goal_status: string
  targets: Record<string, number | null>
  weights: Record<string, number>
  change_reason: string | null
  change_kpi_id: string | null
  change_proposed_target: number | null
  hod_remarks: string | null
}

/** An empty goal sheet in the given status (with targets filled when `withTargets`). */
const blankSheet = (role: RoleKey, status: string, withTargets: boolean): Sheet => ({
  goal_status: status,
  targets: Object.fromEntries(kpisFor(role).map((k) => [k.kpi_id, withTargets ? k.default_target : null])),
  weights: Object.fromEntries(kpisFor(role).map((k) => [k.kpi_id, k.weight])),
  change_reason: null,
  change_kpi_id: null,
  change_proposed_target: null,
  hod_remarks: null,
})

const sheets = new Map<string, Sheet>()
const memberById = new Map<string, Member>()
/** Transferred employees whose period 2 KRAs have been sent (3.8), so 3.6 stops flagging them. */
const transferSent = new Set<string>()
/** Employees the manager has assigned the role template to ("Create & assign template", screen 3.2). */
const templateAssigned = new Set<string>()

/** True once the employee has a template: assigned here, or a goal sheet already started. */
const hasTemplate = (id: string) => templateAssigned.has(id) || (sheets.get(id)?.goal_status ?? 'not_started') !== 'not_started'

/** Called by the transfer mock when period 2 is sent, so 3.1 and 3.6 show the new status. */
export function markTransferSent(employeeUserId: string) {
  transferSent.add(employeeUserId)
}

/** Screen 3.6 "Send Selected to HOD": acknowledged sheets move on to the HOD. */
export function markSentToHod(employeeUserIds: string[]): string[] {
  seed()
  const sent: string[] = []
  for (const id of employeeUserIds) {
    const sheet = sheets.get(id)
    if (!sheet) return fail('This employee is not in your team', 403)
    if (sheet.goal_status !== 'acknowledged') {
      return fail(`Only acknowledged goal sheets can be sent to the HOD (${memberById.get(id)?.name ?? id}).`)
    }
  }
  for (const id of employeeUserIds) {
    sheets.get(id)!.goal_status = 'with_hod'
    sent.push(id)
  }
  return sent
}

/** Creates the goal sheets once, on first use. */
function seed() {
  if (sheets.size > 0) return
  ;[...ROLE_ROSTER, ...STATUS_ROSTER].forEach((p) => memberById.set(p.id, p))

  // 3.1 / 3.2 flow
  for (const p of ROLE_ROSTER) sheets.set(p.id, blankSheet(p.role, 'not_started', false))
  sheets.set(PRAKASH.id, blankSheet('kiln', 'draft', true))
  sheets.set(DIVYA.id, blankSheet('kiln', 'sent_to_employee', true))
  sheets.set(NAVEEN.id, {
    ...blankSheet('rawmill', 'change_requested', true),
    change_kpi_id: 'kpi-r1',
    change_proposed_target: 4000,
    change_reason: 'Raw mill 2 maintenance shutdown is planned in Q3; 4,200 may not hold.',
  })
  sheets.set(SRINIVAS.id, blankSheet('rawmill', 'acknowledged', true))

  // 3.6 goal status
  sheets.set(ST_SURESH.id, {
    ...blankSheet('kiln', 'change_requested', true),
    change_kpi_id: 'kpi-1',
    change_proposed_target: 5500,
    change_reason: 'Kiln-1 shutdown planned in Q3; 5,800 may not hold.',
  })
  sheets.set(ST_RAMESH.id, {
    ...blankSheet('kiln', 'returned_by_hod', true),
    hod_remarks: 'Clinker production target looks high for the planned shutdown. Please revise.',
  })
  sheets.set(VENKATESH.id, blankSheet('kiln', 'not_started', false))
  sheets.set(ST_PRAKASH.id, blankSheet('kiln', 'draft', true))
  sheets.set(ST_DIVYA.id, blankSheet('kiln', 'sent_to_employee', true))
  sheets.set(ST_NAVEEN.id, blankSheet('rawmill', 'acknowledged', true))
  sheets.set(ST_LAKSHMI.id, blankSheet('kiln', 'acknowledged', true))
  sheets.set(ST_SRINIVAS.id, blankSheet('rawmill', 'approved', true))
}

// ── Replies ──────────────────────────────────────────────────────────────────

/** Throws the `{ status, data }` shape the RTK error handlers read. */
const fail = (detail: string, status = 422): never => {
  throw { status, data: { detail } }
}

/** Roster to the API team-member shape, with each sheet current status. */
function listFor(roster: Member[], statusOverride?: Record<string, string>): PmsTeamMember[] {
  seed()
  return roster.map((p) => {
    const role = ROLES[p.role]
    return {
      user_id: p.id,
      emp_code: p.code,
      name: p.name,
      email: `${p.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/\.$/, '')}@sagarsoft.com`,
      designation_id: role.id,
      designation_name: role.name,
      template_id: `tpl-${role.template.toLowerCase().replace(/\s+/g, '-')}`,
      template_name: role.template,
      template_assigned: hasTemplate(p.id),
      employment_type: p.employment,
      goal_status: statusOverride?.[p.id] ?? sheets.get(p.id)?.goal_status ?? 'not_started',
    }
  })
}

/** The team for a scope: role (3.2), status (3.6) or the summary (3.1). */
function team(scope: string | undefined): PmsTeamMember[] {
  if (scope === 'role') return listFor(ROLE_ROSTER)
  if (scope === 'status') {
    // The transferred employee is marked as such here, whatever their sheet says on 3.2, until period 2 is sent.
    return listFor(STATUS_ROSTER, transferSent.has(VENKATESH.id) ? undefined : { [VENKATESH.id]: 'transferred_in' })
  }
  return listFor(SUMMARY_ROSTER)
}

/** One employee goal sheet in the API shape. */
function targetsFor(userId: string, financialYear: string): PmsEmployeeTargets {
  seed()
  const person = memberById.get(userId)
  const sheet = sheets.get(userId)
  if (!person || !sheet) return fail('This employee is not in your team', 404)
  const role = ROLES[person.role]
  return {
    employee_user_id: userId,
    financial_year: financialYear,
    goal_status: sheet.goal_status,
    template_id: `tpl-${role.template.toLowerCase().replace(/\s+/g, '-')}`,
    template_name: role.template,
    employee_name: person.name,
    emp_code: person.code,
    role_name: role.name,
    manager_name: MANAGER,
    acknowledge_by: ACK_DUE,
    kpis: kpisFor(person.role).map((k) => ({
      kpi_id: k.kpi_id,
      kra_name: k.kra_name,
      kpi_name: k.kpi_name,
      unit: k.unit,
      expected_outcome: k.expected_outcome,
      evidence_required: k.evidence_required,
      weight: sheet.weights[k.kpi_id],
      target: sheet.targets[k.kpi_id],
      target_type: k.target_type,
      history: historyFor(k),
    })),
    change_kpi_id: sheet.change_kpi_id,
    change_reason: sheet.change_reason,
    change_proposed_target: sheet.change_proposed_target,
    hod_remarks: sheet.hod_remarks,
  }
}

/** The same checks the API does: weights total 100 and every target set. */
function validate(body: PmsTargetsRequest): PmsTargetValidation {
  seed()
  const person = memberById.get(body.employee_user_id)
  const kpis = kpisFor(person?.role ?? 'kiln')
  const errors: string[] = []
  const total = body.targets.reduce((sum, t) => sum + (Number.isFinite(t.weight) ? t.weight : 0), 0)
  if (Math.abs(total - 100) > 0.01) errors.push(`Total weightage is ${Math.round(total * 100) / 100}% (must be 100%)`)
  for (const t of body.targets) {
    const name = kpis.find((k) => k.kpi_id === t.kpi_id)?.kpi_name ?? 'KPI'
    if (t.target === null || t.target === undefined) errors.push(`Target missing for ${name}`)
    else if (!Number.isFinite(t.target)) errors.push(`${name} target must be a number`)
  }
  return { valid: errors.length === 0, total_weightage: total, errors }
}

/** Stores weights and targets on a sheet and sets its status. A resend clears the change request. */
function store(body: PmsTargetsRequest, status: string) {
  seed()
  const sheet = sheets.get(body.employee_user_id)
  if (!sheet) return fail('This employee is not in your team', 404)
  if (!hasTemplate(body.employee_user_id)) {
    return fail('Create and assign the role template to this employee before setting targets.', 409)
  }
  for (const t of body.targets) {
    sheet.targets[t.kpi_id] = t.target
    sheet.weights[t.kpi_id] = t.weight
  }
  sheet.goal_status = status
  // A resend answers the change request, so the request and HOD remarks are cleared.
  if (status === 'sent_to_employee') {
    sheet.change_kpi_id = null
    sheet.change_reason = null
    sheet.change_proposed_target = null
    sheet.hod_remarks = null
  }
}

const ok = <T>(data: T) => ({ data: { success: true, message: 'OK', data } })

/**
 * Returns a base-query result for the goal-assignment calls this mock covers,
 * or `null` to let the request go to the real API.
 */
export async function staticGoalAssignment(
  args: string | FetchArgs,
): Promise<{ data: unknown } | { error: FetchBaseQueryError } | null> {
  const req = typeof args === 'string' ? { url: args } : args
  const url = req.url
  if (!url.startsWith('/pms-goal-assignment/')) return null
  const params = (req.params ?? {}) as Record<string, string>
  const body = req.body as PmsTargetsRequest | undefined

  try {
    switch (url) {
      case '/pms-goal-assignment/get/team':
        await mockLatency(250)
        return ok(team(params.scope))
      case '/pms-goal-assignment/assign-template': {
        await mockLatency(400)
        seed()
        const { designation_id, template_id } = req.body as { designation_id: string; template_id: string }
        const inRole = ROLE_ROSTER.filter((p) => ROLES[p.role].id === designation_id)
        if (inRole.length === 0) return fail('None of your team members has this role.')
        const roleTemplate = `tpl-${ROLES[inRole[0].role].template.toLowerCase().replace(/\s+/g, '-')}`
        if (template_id !== roleTemplate) {
          return fail('That template is not the active template of this role for the year.')
        }
        let assigned = 0
        for (const p of inRole) {
          if (hasTemplate(p.id)) continue
          templateAssigned.add(p.id)
          assigned += 1
        }
        const role = ROLES[inRole[0].role]
        return ok({
          designation_id,
          template_id: `tpl-${role.template.toLowerCase().replace(/\s+/g, '-')}`,
          template_name: role.template,
          assigned,
          already_assigned: inRole.length - assigned,
        })
      }
      case '/pms-goal-assignment/get/employee-targets':
        await mockLatency(250)
        return ok(targetsFor(params.employee_user_id, params.financial_year))
      case '/pms-goal-assignment/update/employee-targets':
        await mockLatency(350)
        store(body!, 'draft')
        return ok(targetsFor(body!.employee_user_id, body!.financial_year))
      case '/pms-goal-assignment/validate':
        await mockLatency(250)
        return ok(validate(body!))
      case '/pms-goal-assignment/send': {
        await mockLatency(450)
        const result = validate(body!)
        if (!result.valid) return fail(result.errors.join(' · '))
        store(body!, 'sent_to_employee')
        return ok(targetsFor(body!.employee_user_id, body!.financial_year))
      }
      default:
        return null
    }
  } catch (e) {
    return { error: e as FetchBaseQueryError }
  }
}
