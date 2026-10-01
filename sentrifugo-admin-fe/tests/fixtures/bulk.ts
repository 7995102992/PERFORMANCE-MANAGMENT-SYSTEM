import { expect, type Page } from '@playwright/test'
import * as XLSX from 'xlsx'
import { API_BASE, authHeader } from './ui'

/**
 * Employee bulk-upload helpers.
 *
 * The template is generated server-side (GET /employees/bulk-template) and the
 * importer matches columns by HEADER NAME. We download the real template, read
 * its headers, and append rows — filling the 12 required columns with valid
 * values sourced from the org via the API (so they pass server-side validation).
 *
 * Required columns (exact header text, from IAM bulk.py PRETTY_LABELS):
 */
const H = {
  firstName: 'First Name',
  lastName: 'Last Name',
  email: 'Email Address',
  businessUnit: 'Business Unit',
  department: 'Department',
  designation: 'Designation',
  role: 'Role',
  employmentType: 'Employment Type',
  employeeStatus: 'Employee Status',
  projectStatus: 'Project Status',
  gender: 'Gender',
  maritalStatus: 'Marital Status',
} as const

export interface BulkRefs {
  businessUnit: string
  department: string
  designation: string
  role: string
  employmentType: string
  employeeStatus: string
  projectStatus: string
  gender: string
  maritalStatus: string
}

export interface BulkUser {
  firstName: string
  lastName: string
  email: string
}

async function getJson(page: Page, path: string, params?: Record<string, unknown>) {
  const res = await page.request.get(`${API_BASE}${path}`, {
    params,
    headers: await authHeader(page.context()),
  })
  expect(res.ok(), `${path} should succeed`).toBeTruthy()
  return res.json()
}

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * Resolve a valid set of reference values for the org under test:
 *  - a real BU/department/designation combo from an EXISTING employee (so the
 *    combination is guaranteed valid),
 *  - the first role, and the first active master-data option per category.
 */
export async function resolveBulkRefs(page: Page): Promise<BulkRefs> {
  const me = await getJson(page, '/auth/me')
  const orgId = (me as { organisation_id?: string }).organisation_id

  const empsResp = await getJson(page, '/employees/', { limit: 1 })
  const emp = (Array.isArray(empsResp) ? empsResp : empsResp.items ?? [])[0]
  if (!emp) throw new Error('No existing employee to source valid bulk references from')

  const rolesResp = await getJson(page, '/policies/roles', { limit: 1 })
  const role = ((rolesResp.items ?? rolesResp)[0] as { name?: string })?.name

  const md = async (category: string): Promise<string | undefined> => {
    const list = await getJson(page, '/master-data/', { category, organisation_id: orgId })
    return (list as Array<{ value?: string }>)[0]?.value
  }

  const refs: BulkRefs = {
    businessUnit: pick(emp, 'businessUnitName', 'business_unit_name') ?? '',
    department: pick(emp, 'departmentName', 'department_name') ?? '',
    designation: pick(emp, 'designationName', 'designation_name') ?? '',
    role: role ?? '',
    employmentType: (await md('EMPLOYMENT_TYPES')) ?? '',
    employeeStatus: (await md('EMPLOYMENT_STATUSES')) ?? '',
    projectStatus: (await md('PROJECT_STATUSES')) ?? '',
    gender: (await md('GENDERS')) ?? '',
    maritalStatus: (await md('MARITAL_STATUSES')) ?? '',
  }
  for (const [k, v] of Object.entries(refs)) {
    if (!v) throw new Error(`Could not resolve a valid bulk reference value for "${k}"`)
  }
  return refs
}

/**
 * Build an xlsx in-memory with exactly the required columns + one row per user
 * (the importer matches columns by header NAME, so a minimal sheet validates).
 * Returns a Playwright setInputFiles payload with an explicit xlsx mimeType —
 * the FileUploader rejects files whose `type` isn't an accepted MIME.
 */
export function buildBulkWorkbook(
  users: BulkUser[],
  refs: BulkRefs,
): { name: string; mimeType: string; buffer: Buffer } {
  const headers = [
    H.firstName, H.lastName, H.email,
    H.businessUnit, H.department, H.designation, H.role,
    H.employmentType, H.employeeStatus, H.projectStatus,
    H.gender, H.maritalStatus,
  ]
  const aoa: string[][] = [headers]
  for (const u of users) {
    aoa.push([
      u.firstName, u.lastName, u.email,
      refs.businessUnit, refs.department, refs.designation, refs.role,
      refs.employmentType, refs.employeeStatus, refs.projectStatus,
      refs.gender, refs.maritalStatus,
    ])
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Employees')
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return {
    name: 'bulk_test_employees.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  }
}
