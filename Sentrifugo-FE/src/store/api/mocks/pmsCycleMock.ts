// ─── STATIC MOCK DATA — PMS Cycle ────────────────────────────────────────────
// Stand-in for the PMS backend until it exists. `pmsApi.ts` routes every
// endpoint through here via `queryFn`; when the real endpoint ships, replace
// that endpoint's `queryFn` with `query` and delete the matching function.
// State is in-memory, so created / published cycles survive navigation but not
// a page reload.

import type {
  PmsCycle,
  PmsCycleActivation,
  PmsCycleApplicability,
  PmsCycleListItem,
  PmsCycleListParams,
  PmsCycleListResponse,
  PmsCycleStage,
  PmsCycleStatus,
  PmsCycleUpsert,
  PmsEligibilityPreview,
  PmsEligibleEmployee,
  PmsLookupOption,
  PmsRatingScale,
} from '@/types/pms'

export const mockLatency = (ms = 350) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

// ── Lookups ──────────────────────────────────────────────────────────────────

export const MOCK_PLANTS: PmsLookupOption[] = [
  { id: 'plant-mattampally', name: 'Mattampally' },
  { id: 'plant-gudipadu', name: 'Gudipadu' },
  { id: 'plant-bayyavaram', name: 'Bayyavaram' },
  { id: 'plant-jajpur', name: 'Jajpur' },
  { id: 'plant-dachepalli', name: 'Dachepalli' },
]

export const MOCK_DEPARTMENTS: PmsLookupOption[] = [
  { id: 'dept-production', name: 'Production' },
  { id: 'dept-quality', name: 'Quality' },
  { id: 'dept-maintenance', name: 'Maintenance' },
  { id: 'dept-finance', name: 'Finance' },
  { id: 'dept-hr', name: 'Human Resources' },
  { id: 'dept-it', name: 'IT' },
  { id: 'dept-logistics', name: 'Logistics' },
  { id: 'dept-sales', name: 'Sales & Marketing' },
  { id: 'dept-safety', name: 'Safety' },
  { id: 'dept-stores', name: 'Stores' },
]

export const MOCK_RATING_SCALES: PmsRatingScale[] = [
  {
    id: 'scale-5',
    name: 'Standard 5-Point Scale',
    levels: [
      { value: 5, label: 'Outstanding', description: 'Exceptional performance' },
      { value: 4, label: 'Exceeds Expectations' },
      { value: 3, label: 'Meets Expectations' },
      { value: 2, label: 'Needs Improvement' },
      { value: 1, label: 'Unsatisfactory' },
    ],
  },
  {
    id: 'scale-4',
    name: '4-Point Scale',
    levels: [
      { value: 4, label: 'Outstanding', description: 'Exceptional performance' },
      { value: 3, label: 'Exceeds Expectations' },
      { value: 2, label: 'Meets Expectations' },
      { value: 1, label: 'Below Expectations' },
    ],
  },
  {
    id: 'scale-3',
    name: '3-Point Scale',
    levels: [
      { value: 3, label: 'Exceeds Expectations' },
      { value: 2, label: 'Meets Expectations' },
      { value: 1, label: 'Needs Improvement' },
    ],
  },
]

// ── Cycles ───────────────────────────────────────────────────────────────────

const ALL_PLANT_IDS = MOCK_PLANTS.map((p) => p.id)

const plantNames = (ids: string[]) =>
  ids.length === ALL_PLANT_IDS.length
    ? 'All Plants'
    : ids
        .map((id) => MOCK_PLANTS.find((p) => p.id === id)?.name)
        .filter(Boolean)
        .join(', ')

const stagesFor = (fy: number): PmsCycleStage[] => {
  const row = (
    stage: PmsCycleStage['stage'],
    start: string,
    end: string,
  ): PmsCycleStage => ({ stage, start_date: start, end_date: end, notify: true })
  return [
    row('goal_setting', `${fy}-05-01`, `${fy}-05-20`),
    row('employee_acknowledgement', `${fy}-05-01`, `${fy}-05-25`),
    row('hod_approval', `${fy}-05-21`, `${fy}-05-31`),
    row('progress_tracking', `${fy}-06-01`, `${fy + 1}-03-31`),
    row('mid_year_review', `${fy}-10-01`, `${fy}-10-31`),
    row('self_appraisal', `${fy + 1}-04-01`, `${fy + 1}-04-10`),
    row('manager_appraisal', `${fy + 1}-04-11`, `${fy + 1}-04-20`),
    row('hod_review', `${fy + 1}-04-21`, `${fy + 1}-04-27`),
    row('calibration_final_approval', `${fy + 1}-04-28`, `${fy + 1}-05-15`),
  ]
}

const applicabilityFor = (plantIds: string[]): PmsCycleApplicability => ({
  plant_ids: plantIds,
  all_departments: true,
  department_ids: [],
  employment_types: ['permanent'],
  min_service_months: 12,
  service_as_on: '2026-04-01',
  exclude_probation: true,
  exclude_notice_period: true,
})

const seedCycle = (
  id: string,
  code: string,
  name: string,
  type: PmsCycle['basic']['type'],
  start: string,
  end: string,
  plantIds: string[],
  status: PmsCycleStatus,
  createdOn: string,
): PmsCycle => ({
  id,
  cycle_code: code,
  status,
  created_on: createdOn,
  published_on: status === 'draft' ? null : createdOn,
  applicable_to: plantNames(plantIds),
  basic: { name, description: name, type, period_start: start, period_end: end },
  stages: stagesFor(Number(start.slice(0, 4))),
  applicability: applicabilityFor(plantIds),
  finalize: {
    rating_scale_id: 'scale-5',
    notify_managers: true,
    notify_employees: true,
    notify_hod: true,
    notify_hr: true,
  },
})

let cycles: PmsCycle[] = [
  seedCycle('cyc-2627-a', 'PMS-2627-A', 'FY 2026-27 Annual Appraisal', 'annual', '2026-04-01', '2027-03-31', ALL_PLANT_IDS, 'draft', '2026-04-18'),
  seedCycle('cyc-2627-m', 'PMS-2627-M', 'FY 2026-27 Mid-Year Review', 'mid_year', '2026-04-01', '2026-09-30', ['plant-mattampally'], 'active', '2026-04-02'),
  seedCycle('cyc-2526-a', 'PMS-2526-A', 'FY 2025-26 Annual Appraisal', 'annual', '2025-04-01', '2026-03-31', ALL_PLANT_IDS, 'closed', '2025-04-15'),
  seedCycle('cyc-2526-p', 'PMS-2526-P', 'FY 2025-26 Probation Review', 'custom', '2025-07-01', '2025-12-31', ['plant-gudipadu'], 'cancelled', '2025-06-20'),
  seedCycle('cyc-2425-a', 'PMS-2425-A', 'FY 2024-25 Annual Appraisal', 'annual', '2024-04-01', '2025-03-31', ALL_PLANT_IDS, 'closed', '2024-04-10'),
  seedCycle('cyc-2324-a', 'PMS-2324-A', 'FY 2023-24 Annual Appraisal', 'annual', '2023-04-01', '2024-03-31', ALL_PLANT_IDS, 'closed', '2023-04-12'),
]

const toListItem = (c: PmsCycle): PmsCycleListItem => ({
  id: c.id,
  cycle_code: c.cycle_code,
  name: c.basic.name,
  type: c.basic.type,
  period_start: c.basic.period_start,
  period_end: c.basic.period_end,
  applicable_to: c.applicable_to,
  status: c.status,
  created_on: c.created_on,
})

const TYPE_SUFFIX = { annual: 'A', mid_year: 'M', custom: 'C' } as const

const nextCode = (type: PmsCycle['basic']['type'], periodStart: string) => {
  const fy = Number(periodStart.slice(0, 4))
  const base = `PMS-${String(fy).slice(2)}${String(fy + 1).slice(2)}-${TYPE_SUFFIX[type]}`
  const taken = cycles.filter((c) => c.cycle_code.startsWith(base)).length
  return taken === 0 ? base : `${base}${taken + 1}`
}

const today = () => new Date().toISOString().slice(0, 10)

export function mockListCycles(params: PmsCycleListParams = {}): PmsCycleListResponse {
  const { search, year, type, plant_id, status, skip = 0, limit = 10 } = params
  const q = search?.trim().toLowerCase()

  const base = cycles.filter((c) => {
    if (q && !`${c.cycle_code} ${c.basic.name}`.toLowerCase().includes(q)) return false
    if (year && Number(c.basic.period_start.slice(0, 4)) !== year) return false
    if (type && c.basic.type !== type) return false
    if (plant_id && !c.applicability.plant_ids.includes(plant_id)) return false
    return true
  })

  const count = (s: PmsCycleStatus) => base.filter((c) => c.status === s).length
  const filtered = status ? base.filter((c) => c.status === status) : base
  const sorted = [...filtered].sort((a, b) => b.created_on.localeCompare(a.created_on))

  return {
    items: sorted.slice(skip, skip + limit).map(toListItem),
    total: sorted.length,
    summary: {
      all: base.length,
      draft: count('draft'),
      active: count('active'),
      closed: count('closed'),
      cancelled: count('cancelled'),
    },
  }
}

export function mockGetCycle(id: string): PmsCycle {
  const found = cycles.find((c) => c.id === id)
  if (!found) throw { status: 404, data: { detail: 'PMS cycle not found', code: 'PMS_CYCLE_NOT_FOUND' } }
  return found
}

export function mockCreateCycle(body: PmsCycleUpsert): PmsCycle {
  const cycle: PmsCycle = {
    ...body,
    id: `cyc-${Date.now()}`,
    cycle_code: nextCode(body.basic.type, body.basic.period_start),
    status: 'draft',
    created_on: today(),
    published_on: null,
    applicable_to: plantNames(body.applicability.plant_ids),
  }
  cycles = [cycle, ...cycles]
  return cycle
}

export function mockUpdateCycle(id: string, body: PmsCycleUpsert): PmsCycle {
  const existing = mockGetCycle(id)
  const updated: PmsCycle = {
    ...existing,
    ...body,
    applicable_to: plantNames(body.applicability.plant_ids),
  }
  cycles = cycles.map((c) => (c.id === id ? updated : c))
  return updated
}

const ACTIVATION_NOTIFICATIONS: PmsCycleActivation['notifications'] = [
  { audience: 'hod_reviewers', sent: 14 },
  { audience: 'reporting_managers', sent: 68 },
  { audience: 'employees', sent: 1102 },
]

export function mockPublishCycle(id: string): PmsCycleActivation {
  const existing = mockGetCycle(id)
  const published: PmsCycle = { ...existing, status: 'active', published_on: today() }
  cycles = cycles.map((c) => (c.id === id ? published : c))
  return {
    cycle: published,
    published_on: published.published_on as string,
    notifications: ACTIVATION_NOTIFICATIONS,
  }
}

export function mockGetActivation(id: string): PmsCycleActivation {
  const cycle = mockGetCycle(id)
  if (cycle.status === 'draft') {
    throw { status: 409, data: { detail: 'Cycle has not been published', code: 'PMS_CYCLE_NOT_PUBLISHED' } }
  }
  return {
    cycle,
    published_on: cycle.published_on ?? cycle.created_on,
    notifications: ACTIVATION_NOTIFICATIONS,
  }
}

export function mockCancelCycle(id: string): PmsCycle {
  const existing = mockGetCycle(id)
  const cancelled: PmsCycle = { ...existing, status: 'cancelled' }
  cycles = cycles.map((c) => (c.id === id ? cancelled : c))
  return cancelled
}

export function mockExportCyclesCsv(params: PmsCycleListParams = {}): Blob {
  const { items } = mockListCycles({ ...params, skip: 0, limit: 10_000 })
  const header = ['Cycle ID', 'Cycle Name', 'Type', 'Period Start', 'Period End', 'Applicable To', 'Created On', 'Status']
  const rows = items.map((c) => [
    c.cycle_code, c.name, c.type, c.period_start, c.period_end, c.applicable_to, c.created_on, c.status,
  ])
  const csv = [header, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  return new Blob([csv], { type: 'text/csv;charset=utf-8' })
}

// ── Eligibility preview ──────────────────────────────────────────────────────

const FIRST_NAMES = ['Ravi', 'Anitha', 'Suresh', 'Lakshmi', 'Venkat', 'Priya', 'Kiran', 'Meena', 'Srinivas', 'Divya', 'Harish', 'Sunitha', 'Naresh', 'Padma', 'Rajesh']
const LAST_NAMES = ['Reddy', 'Kumar', 'Rao', 'Naidu', 'Sharma', 'Varma', 'Chowdary', 'Patel']
const EMP_TYPES: PmsEligibleEmployee['employment_type'][] = ['permanent', 'permanent', 'permanent', 'contract', 'trainee']

const ROSTER: (PmsEligibleEmployee & { plant_id: string; department_id: string })[] =
  Array.from({ length: 120 }, (_, i) => {
    const plant = MOCK_PLANTS[i % MOCK_PLANTS.length]
    const dept = MOCK_DEPARTMENTS[(i * 3) % MOCK_DEPARTMENTS.length]
    return {
      employee_id: `emp-${i + 1}`,
      employee_code: `SC${String(1001 + i)}`,
      name: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 5) % LAST_NAMES.length]}`,
      department: dept.name,
      department_id: dept.id,
      plant: plant.name,
      plant_id: plant.id,
      employment_type: EMP_TYPES[i % EMP_TYPES.length],
      service_months: 3 + ((i * 7) % 96),
    }
  })

export function mockEligibilityPreview(a: PmsCycleApplicability): PmsEligibilityPreview {
  const scoped = ROSTER.filter(
    (e) =>
      a.plant_ids.includes(e.plant_id) &&
      (a.all_departments || a.department_ids.includes(e.department_id)) &&
      a.employment_types.includes(e.employment_type),
  )
  const underService = scoped.filter((e) => e.service_months < a.min_service_months)
  const eligible = scoped.filter((e) => e.service_months >= a.min_service_months)
  const strip = (e: (typeof ROSTER)[number]): PmsEligibleEmployee => ({
    employee_id: e.employee_id,
    employee_code: e.employee_code,
    name: e.name,
    department: e.department,
    plant: e.plant,
    employment_type: e.employment_type,
    service_months: e.service_months,
  })
  return {
    total_eligible: eligible.length,
    excluded_probation: a.exclude_probation ? Math.round(scoped.length * 0.06) : 0,
    excluded_notice_period: a.exclude_notice_period ? Math.round(scoped.length * 0.03) : 0,
    excluded_min_service: underService.length,
    items: eligible.slice(0, 25).map(strip),
  }
}
