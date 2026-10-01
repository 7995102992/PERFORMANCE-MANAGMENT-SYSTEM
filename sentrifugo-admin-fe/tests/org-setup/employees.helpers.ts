import { expect, type Page } from '@playwright/test'
import { closeComboboxPopups, confirmAction, goto, testEmail } from '../fixtures/ui'

export const EMPLOYEES_LIST = '/employees/list'

export async function gotoEmployeesList(page: Page): Promise<void> {
  await goto(page, EMPLOYEES_LIST)
  await expect(page.getByRole('heading', { name: 'Employees', level: 1 })).toBeVisible()
}

/** Open the create form (full page) and wait for it. */
export async function gotoCreateEmployee(page: Page): Promise<void> {
  await goto(page, EMPLOYEES_LIST)
  await page.getByRole('button', { name: 'Add Employee' }).click()
  await expect(page).toHaveURL(/\/employees\/create/)
  await expect(page.getByRole('heading', { name: 'Add Employee', level: 1 })).toBeVisible()
}

/** Pick the first option of a combobox identified by placeholder, but only if
 *  that combobox is present AND interactive. Returns false when it's absent
 *  (already auto-filled — e.g. a single-BU org) or disabled. */
/**
 * Pick the first option of a SearchableSelect identified by its placeholder.
 * `which` disambiguates a duplicated placeholder ("Select status" is used by
 * both Employment Status and Marital Status). Verifies the value actually got
 * set (reads inputValue) and retries — combobox opens can be flaky. Skips when
 * the field is absent (auto-filled / cascade not ready) or disabled.
 */
async function pickByPlaceholder(
  page: Page,
  placeholder: string,
  which: 'first' | 'last' = 'first',
): Promise<void> {
  const loc = () =>
    which === 'last'
      ? page.getByPlaceholder(placeholder).last()
      : page.getByPlaceholder(placeholder).first()
  if ((await loc().count()) === 0) return
  if (!(await loc().isEnabled().catch(() => false))) return

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await loc().inputValue().catch(() => '')) return // already set
    await loc().click()
    const content = page.locator('[data-slot="combobox-content"]').last()
    try {
      await expect(content).toBeVisible({ timeout: 3000 })
      await content.locator('[data-slot="combobox-item"]').first().click({ timeout: 3000 })
    } catch {
      await page.keyboard.press('Escape').catch(() => {})
    }
    await closeComboboxPopups(page).catch(() => {})
  }
}

/**
 * Fill the required fields of the employee form by picking the first option for
 * each select. Requires a seeded org (BUs, departments, designations, roles,
 * master data). Cascading: BU must be picked before Department becomes enabled.
 * Auto-filled selects (single-option orgs) are skipped gracefully.
 */
export async function fillRequiredEmployee(
  page: Page,
  { runId, firstName = 'Sethu', lastName }: { runId: string; firstName?: string; lastName?: string },
): Promise<void> {
  // Basic Details
  await page.getByPlaceholder('First name').fill(firstName)
  await page.getByPlaceholder('Last name').fill(lastName ?? `_test_${runId}`)
  await page.getByPlaceholder('e.g. john@company.com').fill(testEmail(runId))

  // Work Information (Business Unit → Department cascade)
  await pickByPlaceholder(page, 'Select business unit')
  await pickByPlaceholder(page, 'Select department')
  await pickByPlaceholder(page, 'Select designation')
  await pickByPlaceholder(page, 'Select role')
  await pickByPlaceholder(page, 'Select type') // Employment Type
  await pickByPlaceholder(page, 'Select status', 'first') // Employment Status
  await pickByPlaceholder(page, 'Select project status')

  // Personal Details
  await pickByPlaceholder(page, 'Select gender')
  await pickByPlaceholder(page, 'Select status', 'last') // Marital Status
}

/** Full create flow; asserts the success toast and redirect to the list. */
export async function createEmployee(page: Page, runId: string): Promise<void> {
  await gotoCreateEmployee(page)
  await fillRequiredEmployee(page, { runId })
  await page.getByRole('button', { name: 'Save Employee', exact: true }).click()
  await confirmAction(page, 'Save Employee')
  await expect(page.getByText('Employee created successfully')).toBeVisible()
  await expect(page).toHaveURL(/\/employees\/list/)
}

export async function searchEmployees(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search by name, email, emp code...').fill(term)
}
