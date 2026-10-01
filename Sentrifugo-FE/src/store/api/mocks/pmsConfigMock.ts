// ─── STATIC MOCK DATA — PMS Configuration ────────────────────────────────────
// Same contract as `pmsCycleMock.ts`: `pmsApi.ts` routes each endpoint through
// here via `queryFn`; delete the matching function when the real endpoint ships.
// In-memory state — survives navigation, not a page reload.

import type {
  PmsCompetency,
  PmsCompetencyUpsert,
  PmsDesignationOption,
  PmsGoalTemplate,
  PmsGoalTemplateListItem,
  PmsGoalTemplateListParams,
  PmsGoalTemplateUpsert,
  PmsKpi,
  PmsKpiUpsert,
  PmsKra,
  PmsKraUpsert,
  PmsRatingScaleConfig,
  PmsRatingScaleUpdate,
  PmsTemplateStatus,
} from '@/types/pms-config'
import { MOCK_DEPARTMENTS } from './pmsCycleMock'

const fail = (status: number, code: string, detail: string): never => {
  throw { status, data: { detail, code } }
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// ── KRA ──────────────────────────────────────────────────────────────────────

let kras: PmsKra[] = [
  'Production Efficiency',
  'Energy Management',
  'Safety',
  'Equipment Reliability',
  'Quality',
  'Cost Control',
  'People Development',
].map((name, i) => ({ id: `kra-${i + 1}`, name }))

export const mockListKras = (): PmsKra[] => kras

export function mockCreateKra(body: PmsKraUpsert): PmsKra {
  if (kras.some((k) => sameName(k.name, body.name))) {
    fail(409, 'PMS_KRA_DUPLICATE', 'A KRA with this name already exists')
  }
  const kra = { id: uid('kra'), name: body.name.trim() }
  kras = [...kras, kra]
  return kra
}

export function mockUpdateKra(id: string, body: PmsKraUpsert): PmsKra {
  if (kras.some((k) => k.id !== id && sameName(k.name, body.name))) {
    fail(409, 'PMS_KRA_DUPLICATE', 'A KRA with this name already exists')
  }
  const updated = { id, name: body.name.trim() }
  kras = kras.map((k) => (k.id === id ? updated : k))
  kpis = kpis.map((k) => (k.kra_id === id ? { ...k, kra_name: updated.name } : k))
  return updated
}

export function mockDeleteKra(id: string): void {
  if (kpis.some((k) => k.kra_id === id)) {
    fail(409, 'PMS_KRA_IN_USE', 'This KRA has KPIs mapped to it. Remove or move those KPIs first')
  }
  kras = kras.filter((k) => k.id !== id)
}

// ── KPI ──────────────────────────────────────────────────────────────────────

export const MOCK_KPI_UNITS = ['TPD', 'kcal/kg', '%', 'kWh/t', 'Count', 'Months', 'MPa', 'MT', 'Days', 'INR Lakhs']

const seedKpi = (
  n: number,
  kra: string,
  name: string,
  unit: string,
  target_type: PmsKpi['target_type'],
  expected_outcome: string,
  evidence_required: string,
): PmsKpi => {
  const k = kras.find((x) => x.name === kra) as PmsKra
  return { id: `kpi-${n}`, kra_id: k.id, kra_name: k.name, name, unit, target_type, expected_outcome, evidence_required }
}

let kpis: PmsKpi[] = [
  seedKpi(1, 'Production Efficiency', 'Clinker production', 'TPD', 'common', 'Sustain planned output', 'DCS report'),
  seedKpi(2, 'Energy Management', 'Specific heat consumption', 'kcal/kg', 'common', 'Reduce fuel use', 'Energy audit'),
  seedKpi(3, 'Production Efficiency', 'Kiln run factor', '%', 'common', 'Minimise stoppages', 'Stoppage log'),
  seedKpi(4, 'Energy Management', 'Power consumption', 'kWh/t', 'common', 'Reduce power use', 'SCADA'),
  seedKpi(5, 'Safety', 'Safety – LTI', 'Count', 'individual', 'Zero LTI', 'Safety MIS'),
  seedKpi(6, 'Equipment Reliability', 'Refractory life', 'Months', 'common', 'Extend campaign', 'Refractory log'),
  seedKpi(7, 'Quality', 'Cement strength consistency', 'MPa', 'common', 'Consistent 28-day strength', 'QC lab report'),
]

export const mockListKpis = (): PmsKpi[] => kpis

function toKpi(id: string, body: PmsKpiUpsert): PmsKpi {
  const kra = kras.find((k) => k.id === body.kra_id)
  if (!kra) fail(422, 'PMS_KRA_NOT_FOUND', 'Selected KRA does not exist')
  return {
    id,
    kra_id: body.kra_id,
    kra_name: (kra as PmsKra).name,
    name: body.name.trim(),
    unit: body.unit,
    target_type: body.target_type,
    expected_outcome: body.expected_outcome.trim(),
    evidence_required: body.evidence_required.trim(),
  }
}

export function mockCreateKpi(body: PmsKpiUpsert): PmsKpi {
  if (kpis.some((k) => k.kra_id === body.kra_id && sameName(k.name, body.name))) {
    fail(409, 'PMS_KPI_DUPLICATE', 'This KRA already has a KPI with that name')
  }
  const kpi = toKpi(uid('kpi'), body)
  kpis = [...kpis, kpi]
  return kpi
}

export function mockUpdateKpi(id: string, body: PmsKpiUpsert): PmsKpi {
  if (kpis.some((k) => k.id !== id && k.kra_id === body.kra_id && sameName(k.name, body.name))) {
    fail(409, 'PMS_KPI_DUPLICATE', 'This KRA already has a KPI with that name')
  }
  const kpi = toKpi(id, body)
  kpis = kpis.map((k) => (k.id === id ? kpi : k))
  return kpi
}

export function mockDeleteKpi(id: string): void {
  if (templates.some((t) => t.kras.some((k) => k.kpis.some((p) => p.kpi_id === id)))) {
    fail(409, 'PMS_KPI_IN_USE', 'This KPI is used in a goal template and cannot be deleted')
  }
  kpis = kpis.filter((k) => k.id !== id)
}

// ── Competency ───────────────────────────────────────────────────────────────

let competencies: PmsCompetency[] = [
  'Attendance and Punctuality',
  'Discipline',
  'Attitude towards work',
  'Attitude towards people',
  'Dependability',
  'Listening and communication skills',
  'Honesty and Integrity',
  'Co-employee relations at work (Teamwork)',
  'Takes initiative at work',
  'Commitment at work',
  'Flexibility at work',
  'Cost consciousness',
  'Consistency at work',
  'Enthusiasm & Creativity at work',
].map((name, i) => ({ id: `comp-${i + 1}`, name, category: 'behavioural', is_active: true }))

export const mockListCompetencies = (): PmsCompetency[] => competencies

export function mockCreateCompetency(body: PmsCompetencyUpsert): PmsCompetency {
  if (competencies.some((c) => sameName(c.name, body.name))) {
    fail(409, 'PMS_COMPETENCY_DUPLICATE', 'A competency with this name already exists')
  }
  const comp = { id: uid('comp'), ...body, name: body.name.trim() }
  competencies = [...competencies, comp]
  return comp
}

export function mockUpdateCompetency(id: string, body: PmsCompetencyUpsert): PmsCompetency {
  if (competencies.some((c) => c.id !== id && sameName(c.name, body.name))) {
    fail(409, 'PMS_COMPETENCY_DUPLICATE', 'A competency with this name already exists')
  }
  const comp = { id, ...body, name: body.name.trim() }
  competencies = competencies.map((c) => (c.id === id ? comp : c))
  return comp
}

export function mockDeleteCompetency(id: string): void {
  if (templates.some((t) => t.competencies.some((c) => c.competency_id === id))) {
    fail(409, 'PMS_COMPETENCY_IN_USE', 'This competency is used in a goal template and cannot be deleted')
  }
  competencies = competencies.filter((c) => c.id !== id)
}

// ── Rating scales ────────────────────────────────────────────────────────────

const level = (
  rating: number,
  label: string,
  definition: string,
  score_min: number,
  score_max: number,
  color: string,
) => ({ rating, label, definition, score_min, score_max, color })

let ratingScales: PmsRatingScaleConfig[] = [
  {
    id: 'scale-5',
    name: 'Standard 5-Point Scale',
    is_default: true,
    show_definitions_to_employees: true,
    levels: [
      level(5, 'Outstanding', 'Exceptional performance, consistently exceeds all targets', 4.5, 5, '#16a34a'),
      level(4, 'Exceeds Expectations', 'Consistently above expectations', 3.5, 4.49, '#4169e1'),
      level(3, 'Meets Expectations', 'Fully meets expectations', 2.5, 3.49, '#6f5cff'),
      level(2, 'Needs Improvement', 'Partially meets expectations', 1.5, 2.49, '#d97706'),
      level(1, 'Unsatisfactory', 'Does not meet expectations', 1, 1.49, '#dc2626'),
    ],
  },
  {
    id: 'scale-4',
    name: '4-Point Scale',
    is_default: false,
    show_definitions_to_employees: true,
    levels: [
      level(4, 'Outstanding', 'Exceptional performance', 3.5, 4, '#16a34a'),
      level(3, 'Exceeds Expectations', 'Above expectations', 2.5, 3.49, '#4169e1'),
      level(2, 'Meets Expectations', 'Meets expectations', 1.5, 2.49, '#d97706'),
      level(1, 'Below Expectations', 'Does not meet expectations', 1, 1.49, '#dc2626'),
    ],
  },
  {
    id: 'scale-3',
    name: '3-Point Scale',
    is_default: false,
    show_definitions_to_employees: false,
    levels: [
      level(3, 'Exceeds Expectations', 'Above expectations', 2.5, 3, '#16a34a'),
      level(2, 'Meets Expectations', 'Meets expectations', 1.5, 2.49, '#6f5cff'),
      level(1, 'Needs Improvement', 'Below expectations', 1, 1.49, '#dc2626'),
    ],
  },
]

export const mockListRatingScales = (): PmsRatingScaleConfig[] => ratingScales

export function mockUpdateRatingScale(id: string, body: PmsRatingScaleUpdate): PmsRatingScaleConfig {
  const existing = ratingScales.find((s) => s.id === id)
  if (!existing) fail(404, 'PMS_RATING_SCALE_NOT_FOUND', 'Rating scale not found')
  const updated = { ...(existing as PmsRatingScaleConfig), ...body }
  // Only one scale is the default for new cycles.
  ratingScales = ratingScales.map((s) =>
    s.id === id ? updated : body.is_default ? { ...s, is_default: false } : s,
  )
  return updated
}

// ── Designations ─────────────────────────────────────────────────────────────

const dept = (name: string) => (MOCK_DEPARTMENTS.find((d) => d.name === name) as { id: string }).id

export const MOCK_DESIGNATIONS: PmsDesignationOption[] = [
  ['Production', 'Engineer – Kiln Ops'],
  ['Production', 'Shift Supervisor'],
  ['Maintenance', 'Maintenance Engineer'],
  ['Maintenance', 'Technician'],
  ['Safety', 'Safety Officer'],
  ['Finance', 'Finance Manager'],
  ['Finance', 'Accountant'],
  ['Quality', 'QC Chemist'],
  ['Human Resources', 'HR Executive'],
  ['IT', 'IT Executive'],
  ['Logistics', 'Logistics Executive'],
  ['Sales & Marketing', 'Sales Manager'],
  ['Stores', 'Store Keeper'],
].map(([d, name], i) => ({ id: `desig-${i + 1}`, name, department_id: dept(d) }))

export const mockListDesignations = (departmentId?: string) =>
  departmentId ? MOCK_DESIGNATIONS.filter((d) => d.department_id === departmentId) : MOCK_DESIGNATIONS

// ── Goal templates ───────────────────────────────────────────────────────────

const PLANT_OF_DESIGNATION: Record<string, { id: string; name: string }> = {
  'Engineer – Kiln Ops': { id: 'plant-mattampally', name: 'Mattampally' },
}

const plantFor = (designationName: string) => PLANT_OF_DESIGNATION[designationName] ?? null

const seedDetail = (): Pick<PmsGoalTemplateUpsert, 'kras' | 'competencies'> => {
  const tk = (kpi_id: string, weight: number) => {
    const k = kpis.find((x) => x.id === kpi_id) as PmsKpi
    return { kpi_id, weight, target_type: k.target_type, expected_outcome: k.expected_outcome, evidence_required: k.evidence_required }
  }
  return {
    kras: [
      { kra_id: 'kra-1', kpis: [tk('kpi-1', 25), tk('kpi-3', 20)] },
      { kra_id: 'kra-2', kpis: [tk('kpi-2', 20), tk('kpi-4', 15)] },
      { kra_id: 'kra-3', kpis: [tk('kpi-5', 20)] },
    ],
    competencies: competencies.map((c, i) => ({ competency_id: c.id, weight: i < 2 ? 8 : 7 })),
  }
}

const designationName = (id: string) => MOCK_DESIGNATIONS.find((d) => d.id === id)?.name ?? ''
const departmentName = (id: string) => MOCK_DEPARTMENTS.find((d) => d.id === id)?.name ?? ''

function seedTemplate(
  n: number,
  name: string,
  description: string,
  desig: string,
  status: PmsTemplateStatus,
  withDetail = true,
): PmsGoalTemplate {
  const d = MOCK_DESIGNATIONS.find((x) => x.name === desig) as PmsDesignationOption
  return {
    id: `tpl-${n}`,
    department_name: departmentName(d.department_id),
    designation_name: d.name,
    plant: plantFor(d.name)?.name ?? 'All',
    basic: {
      financial_year: 2026,
      name,
      description,
      department_id: d.department_id,
      designation_id: d.id,
      effective_from: '2026-04-01',
      status,
    },
    ...(withDetail ? seedDetail() : { kras: [], competencies: [] }),
  }
}

let templates: PmsGoalTemplate[] = [
  seedTemplate(1, 'Production Engineer', 'Annual goal template for Production Engineers', 'Engineer – Kiln Ops', 'active'),
  seedTemplate(2, 'Maintenance Engineer', 'Annual goal template for Maintenance Engineers', 'Maintenance Engineer', 'active'),
  seedTemplate(3, 'Safety Officer', 'Annual goal template for Safety Officers', 'Safety Officer', 'active'),
  seedTemplate(4, 'Finance Manager', 'Annual goal template for Finance Managers', 'Finance Manager', 'draft', false),
]

const toListItem = (t: PmsGoalTemplate): PmsGoalTemplateListItem => ({
  id: t.id,
  name: t.basic.name,
  financial_year: t.basic.financial_year,
  designation_name: t.designation_name,
  department_id: t.basic.department_id,
  department_name: t.department_name,
  plant_id: plantFor(t.designation_name)?.id ?? null,
  plant: t.plant,
  status: t.basic.status,
})

export function mockListTemplates(params: PmsGoalTemplateListParams = {}): PmsGoalTemplateListItem[] {
  const q = params.search?.trim().toLowerCase()
  return templates
    .map(toListItem)
    .filter((t) => {
      if (params.financial_year && t.financial_year !== params.financial_year) return false
      if (params.department_id && t.department_id !== params.department_id) return false
      // A template with plant "All" applies to every plant, so it matches any plant filter.
      if (params.plant_id && t.plant_id && t.plant_id !== params.plant_id) return false
      if (q && !`${t.name} ${t.designation_name}`.toLowerCase().includes(q)) return false
      return true
    })
}

export function mockGetTemplate(id: string): PmsGoalTemplate {
  return templates.find((t) => t.id === id) ?? fail(404, 'PMS_TEMPLATE_NOT_FOUND', 'Goal template not found')
}

function assertTemplateUnique(body: PmsGoalTemplateUpsert, ignoreId?: string) {
  const b = body.basic
  const clash = templates.some(
    (t) =>
      t.id !== ignoreId &&
      t.basic.financial_year === b.financial_year &&
      t.basic.designation_id === b.designation_id &&
      t.basic.status !== 'inactive' &&
      b.status !== 'inactive' &&
      sameName(t.basic.name, b.name),
  )
  if (clash) fail(409, 'PMS_TEMPLATE_DUPLICATE', 'A template with this name already exists for this role and year')
}

function build(id: string, body: PmsGoalTemplateUpsert): PmsGoalTemplate {
  const name = designationName(body.basic.designation_id)
  return {
    ...body,
    id,
    department_name: departmentName(body.basic.department_id),
    designation_name: name,
    plant: plantFor(name)?.name ?? 'All',
  }
}

export function mockCreateTemplate(body: PmsGoalTemplateUpsert): PmsGoalTemplate {
  assertTemplateUnique(body)
  const t = build(uid('tpl'), body)
  templates = [t, ...templates]
  return t
}

export function mockUpdateTemplate(id: string, body: PmsGoalTemplateUpsert): PmsGoalTemplate {
  mockGetTemplate(id)
  assertTemplateUnique(body, id)
  const t = build(id, body)
  templates = templates.map((x) => (x.id === id ? t : x))
  return t
}

export function mockSetTemplateStatus(id: string, status: PmsTemplateStatus): PmsGoalTemplate {
  const t = mockGetTemplate(id)
  if (status === 'active' && (t.kras.length === 0 || t.competencies.length === 0)) {
    fail(409, 'PMS_TEMPLATE_INCOMPLETE', 'Finish the KRA & KPI and competency steps before activating')
  }
  const updated = { ...t, basic: { ...t.basic, status } }
  templates = templates.map((x) => (x.id === id ? updated : x))
  return updated
}

export function mockDuplicateTemplate(id: string): PmsGoalTemplate {
  const t = mockGetTemplate(id)
  const copy = build(uid('tpl'), {
    basic: { ...t.basic, name: `${t.basic.name} (Copy)`, status: 'draft' },
    kras: t.kras,
    competencies: t.competencies,
  })
  templates = [copy, ...templates]
  return copy
}

export function mockDeleteTemplate(id: string): void {
  mockGetTemplate(id)
  templates = templates.filter((t) => t.id !== id)
}
