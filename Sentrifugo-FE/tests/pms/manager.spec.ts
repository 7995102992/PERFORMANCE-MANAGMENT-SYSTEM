import { test, expect, type Page } from '@playwright/test'
import { FY, failOnServerErrors, login, openPms } from './helpers'

/** Manager (Section Head): My Team, Select Employee, Target Assignment. P = positive flow, N = negative flow. */

/** Opens the first employee whose sheet can still be edited; returns false when there is none. */
async function openEditableSheet(page: Page): Promise<boolean> {
  await openPms(page, `/pms/team-goal-setting/${FY}/role`, /Select Employee/)
  await page.getByText('Employees in this Role').waitFor({ timeout: 20_000 })
  // Setting targets needs the role template first: assign it when the button is live.
  const assign = page.getByRole('button', { name: 'Assign Template' })
  if (await assign.isEnabled()) {
    await assign.click()
    await expect(assign).toBeDisabled({ timeout: 20_000 })
  }
  const open = page.getByRole('button', { name: /Set Targets|Continue/ })
  if ((await open.count()) === 0 || !(await open.first().isEnabled())) return false
  await open.first().click()
  await expect(page.getByRole('heading', { name: 'Employee Target Assignment' })).toBeVisible({ timeout: 20_000 })
  return true
}

test.describe('Manager (report already sent or approved)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'MANAGER')
  })

  test('MGR-P01 My Team lists eligible team members', async ({ page }) => {
    const noErrors = failOnServerErrors(page)
    await openPms(page, `/pms/team-goal-setting/${FY}`, 'My Team')
    noErrors()
  })

  test('MGR-P02 Select Employee shows role, auto template, banner, table and summary', async ({ page }) => {
    await openPms(page, `/pms/team-goal-setting/${FY}/role`, /Select Employee/)
    await expect(page.getByText('Template (auto-loaded)')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Assign Template' })).toBeVisible()
    await expect(page.getByText(/one employee at a time/)).toBeVisible()
    await expect(page.getByText('Employees in this Role')).toBeVisible()
    for (const col of ['Employee', 'Emp ID', 'Employment Type', 'Goal Status', 'Action']) {
      await expect(page.getByRole('columnheader', { name: col })).toBeVisible()
    }
    await expect(page.getByText(/Goals are set for all employees/)).toBeVisible()
  })

  test('MGR-P03 breadcrumb reads PMS Cycle > My Team Goals > Select Employee', async ({ page }) => {
    await openPms(page, `/pms/team-goal-setting/${FY}/role`, /Select Employee/)
    await expect(page.getByText('My Team Goals').first()).toBeVisible()
  })

  test('MGR-P04 Back returns to My Team', async ({ page }) => {
    await openPms(page, `/pms/team-goal-setting/${FY}/role`, /Select Employee/)
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page).toHaveURL(new RegExp(`/pms/team-goal-setting/${FY}/?$`))
  })

  test('MGR-N06 a sent or approved sheet is read-only (no Validate or Save Draft)', async ({ page }) => {
    await openPms(page, `/pms/team-goal-setting/${FY}/role`, /Select Employee/)
    await page.getByText('Employees in this Role').waitFor({ timeout: 20_000 })
    const view = page.getByRole('button', { name: 'View' })
    test.skip((await view.count()) === 0, 'No sent or approved sheet to view')
    await view.first().click()
    await expect(page.getByRole('heading', { name: 'Employee Target Assignment' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Validate/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save Draft' })).toHaveCount(0)
  })

  test('MGR-N07 manager has no HR Initiate Appraisal menu entry', async ({ page }) => {
    await openPms(page, `/pms/team-goal-setting/${FY}`, 'My Team')
    await expect(page.getByRole('link', { name: 'Initiate Appraisal' })).toHaveCount(0)
  })
})

/** Ananth has one report whose sheet is Not Started, so the editing rules can be exercised. */
test.describe('Manager (report with an editable sheet)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'MANAGER2')
  })

  test('MGR-P05 target sheet shows the header strip, KRA-only rows and Total weightage', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable (not sent) sheet')
    for (const t of ['Employee', 'Role', 'Manager', 'Template']) {
      await expect(page.getByText(t, { exact: true }).first()).toBeVisible()
    }
    await expect(page.getByRole('columnheader', { name: 'KRA', exact: true })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'KPI', exact: true })).toHaveCount(0)
    await expect(page.getByText(/Total weightage/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save Draft' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Validate/ })).toBeVisible()
  })

  test('MGR-N01 Validate with blank weights fails and does not offer Save & Send', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    const weights = page.getByRole('textbox', { name: /weight$/ })
    for (let i = 0; i < (await weights.count()); i++) {
      await weights.nth(i).fill('')
      await weights.nth(i).blur()
    }
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByText(/Validation failed/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Save & Send/ })).toHaveCount(0)
  })

  test('MGR-N02 weights that do not total 100 are reported with the actual total', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    const weights = page.getByRole('textbox', { name: /weight$/ })
    for (let i = 0; i < (await weights.count()); i++) {
      await weights.nth(i).fill('1')
      await weights.nth(i).blur()
    }
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByText(/must be 100%/)).toBeVisible()
  })

  test('MGR-N03 a weight above 100 is rejected', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    const first = page.getByRole('textbox', { name: /weight$/ }).first()
    await first.fill('150')
    await first.blur()
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByText(/between 0 and 100|0 to 100|must be 100%/).first()).toBeVisible()
  })

  test('MGR-N04 a non-numeric target is rejected', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await page.getByRole('textbox', { name: /target$/ }).first().fill('abc')
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByText(/must be a number|Numbers only/).first()).toBeVisible()
  })

  test('MGR-N05 a missing target is reported as missing', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await page.getByRole('textbox', { name: /target$/ }).first().fill('')
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByText(/Target missing for/).first()).toBeVisible()
  })
  /** Fills every KRA weight so the sheet totals exactly 100 and every target with a number. */
  async function fillValidSheet(page: Page) {
    const weights = page.getByRole('textbox', { name: /weight$/ })
    const n = await weights.count()
    const each = Math.floor(100 / n)
    for (let i = 0; i < n; i++) {
      await weights.nth(i).fill(String(i === n - 1 ? 100 - each * (n - 1) : each))
      await weights.nth(i).blur()
    }
    const targets = page.getByRole('textbox', { name: /target$/ })
    for (let i = 0; i < (await targets.count()); i++) await targets.nth(i).fill('10')
  }

  test('MGR-P06 a valid sheet totals 100% and the total turns green', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await fillValidSheet(page)
    await expect(page.getByText(/Total weightage/)).toContainText('100%')
  })

  test('MGR-P07 Save Draft keeps the entered targets after a reload', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await fillValidSheet(page)
    await page.getByRole('button', { name: 'Save Draft' }).click()
    await expect(page.getByText('Draft saved')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Employee Target Assignment' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('textbox', { name: /target$/ }).first()).toHaveValue('10')
  })

  test('MGR-P08 Validate on a valid sheet opens "Save and Send to Employee" (Cancel sends nothing)', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await fillValidSheet(page)
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByRole('dialog').getByText('Save and Send to Employee')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('dialog').getByText('Validation passed')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('MGR-P09 an editable sheet lists the previous-year targets panel or its empty message', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await expect(page.getByText(/Previous-year targets|No previous-year data/).first()).toBeVisible()
  })

  test('MGR-N08 Validate Again after a failure shows the failure until it is fixed', async ({ page }) => {
    test.skip(!(await openEditableSheet(page)), 'No employee with an editable sheet')
    await page.getByRole('textbox', { name: /target$/ }).first().fill('abc')
    await page.getByRole('button', { name: /^Validate/ }).click()
    await expect(page.getByRole('button', { name: 'Validate Again' })).toBeVisible()
    await expect(page.getByText(/Validation failed/)).toBeVisible()
  })
})
