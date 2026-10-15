import { test, expect, type Page } from '@playwright/test'
import { FY, failOnServerErrors, login, type PmsRole } from './helpers'

/** Side menu per login and every remaining PMS screen opening without an error. */

const PMS_ITEMS = [
  'Initiate Appraisal',
  'Goal Templates',
  'KRA Master',
  'KPI Master',
  'Competency Master',
  'Rating Scale',
  'Approval Workflow',
  'My Goals',
  'Progress Update',
  'Self Appraisal',
  'My Team Goals',
  'Team Progress',
  'Mid-Year Review',
  'Goal Approvals',
  'Target Revisions',
  'Team Appraisal',
  'Approve Appraisal',
] as const

/** Names of the PMS menu entries currently visible in the sidebar. */
async function visibleItems(page: Page): Promise<string[]> {
  const found: string[] = []
  for (const name of PMS_ITEMS) {
    if ((await page.getByRole('link', { name, exact: true }).count()) > 0) found.push(name)
  }
  return found
}

/** Expected PMS menu per login (what the role's permission grants show). */
const EXPECTED: Array<{ id: string; role: PmsRole; has: string[]; lacks: string[] }> = [
  {
    id: 'MENU-01 employee',
    role: 'EMPLOYEE',
    has: ['My Goals', 'Progress Update', 'Self Appraisal'],
    lacks: ['Initiate Appraisal', 'KRA Master', 'My Team Goals', 'Goal Approvals', 'Approve Appraisal'],
  },
  {
    id: 'MENU-02 manager',
    role: 'MANAGER3',
    has: ['My Goals', 'Self Appraisal', 'My Team Goals', 'Team Progress', 'Mid-Year Review', 'Team Appraisal'],
    lacks: ['Initiate Appraisal', 'KRA Master', 'Goal Approvals', 'Approve Appraisal'],
  },
  {
    id: 'MENU-03 HOD',
    role: 'HOD',
    has: ['My Goals', 'My Team Goals', 'Goal Approvals', 'Target Revisions', 'Approve Appraisal'],
    lacks: ['Initiate Appraisal', 'KRA Master', 'Rating Scale'],
  },
  {
    id: 'MENU-04 corporate HR',
    role: 'HR',
    has: ['Initiate Appraisal', 'My Goals'],
    lacks: ['Goal Approvals', 'Approve Appraisal'],
  },
]

test.describe('Side menu per role', () => {
  for (const c of EXPECTED) {
    test(`${c.id} sees exactly its PMS entries`, async ({ page }) => {
      await login(page, c.role)
      await page.goto(c.role === 'HR' ? '/pms/cycle' : `/pms/my-goals/${FY}`)
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
      const items = await visibleItems(page)
      for (const name of c.has) expect(items, `${name} should be in the menu`).toContain(name)
      for (const name of c.lacks) expect(items, `${name} should NOT be in the menu`).not.toContain(name)
    })
  }
})

test('MENU-05 corporate HR sees the Configuration masters', async ({ page }) => {
  await login(page, 'HR')
  await page.goto('/pms/configuration/kra-master')
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
  const items = await visibleItems(page)
  for (const name of ['KRA Master', 'KPI Master', 'Goal Templates', 'Rating Scale', 'Competency Master']) {
    expect(items, `${name} should be in the menu`).toContain(name)
  }
})

/** Screens that must open for a role without a 5xx from the API or a crash. */
const SCREENS: Array<{ id: string; role: PmsRole; path: string }> = [
  { id: 'SCR-01', role: 'EMPLOYEE', path: `/pms/my-progress/${FY}` },
  { id: 'SCR-02', role: 'MANAGER3', path: `/pms/team-progress/${FY}` },
  { id: 'SCR-03', role: 'MANAGER3', path: `/pms/mid-year-review/${FY}` },
  { id: 'SCR-04', role: 'MANAGER3', path: `/pms/team-appraisal/${FY}` },
  { id: 'SCR-05', role: 'HOD', path: '/pms/target-revisions' },
  { id: 'SCR-06', role: 'HOD', path: '/pms/approve-appraisal' },
  { id: 'SCR-07', role: 'HOD', path: `/pms/goal-approvals/${FY}` },
  { id: 'SCR-08', role: 'HR', path: `/pms/hr-competency-rating/${FY}` },
  { id: 'SCR-09', role: 'HR', path: `/pms/calibration/${FY}` },
  { id: 'SCR-10', role: 'HR', path: '/pms/status-tracker' },
  { id: 'SCR-11', role: 'HR', path: '/pms/appraisal-history' },
  { id: 'SCR-12', role: 'HR', path: '/pms/cycle-closure' },
]

test.describe('Screens open without errors', () => {
  for (const s of SCREENS) {
    test(`${s.id} ${s.role} opens ${s.path}`, async ({ page }) => {
      const noErrors = failOnServerErrors(page)
      await login(page, s.role)
      await page.goto(s.path)
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(/something went wrong|unexpected error|404/i)).toHaveCount(0)
      noErrors()
    })
  }
})

test.describe('Stage-window banners', () => {
  test('BAN-01 employee sees the Employee Acknowledgement window on My Goals', async ({ page }) => {
    await login(page, 'EMPLOYEE')
    await page.goto(`/pms/my-goals/${FY}`)
    await expect(page.getByText(/Employee Acknowledgement (opens|ends|closed)/i).first()).toBeVisible({ timeout: 20_000 })
  })

  test('BAN-02 HOD sees the HOD Approval window on Goal Approvals', async ({ page }) => {
    await login(page, 'HOD')
    await page.goto(`/pms/goal-approvals/${FY}`)
    await expect(page.getByText(/HOD Approval (opens|ends|closed)/i).first()).toBeVisible({ timeout: 20_000 })
  })
})
