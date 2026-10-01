import { expect, type Page, type Locator } from '@playwright/test'
import { confirmAction, goto } from '../fixtures/ui'

export const DEPARTMENTS_LIST = '/settings/departments'

/** Navigate to the Departments list and wait for it to render. */
export async function gotoDepartments(page: Page): Promise<void> {
  await goto(page, DEPARTMENTS_LIST)
  await expect(page.getByRole('heading', { name: 'Departments', level: 1 })).toBeVisible()
}

/** Open the create sheet (Base-UI dialog) and return it. */
export async function openCreateDepartment(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add Department' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('Add New Department')).toBeVisible()
  return sheet
}

/**
 * Select at least one Business Unit if the picker is interactive. In a
 * single-business-unit org the picker is disabled and pre-filled with the sole
 * BU, so there is nothing to do; in a multi-BU org we pick the first option.
 */
async function selectBusinessUnitsIfNeeded(page: Page): Promise<void> {
  const buInput = page.getByPlaceholder('Select business units...')
  if ((await buInput.count()) === 0) return // disabled / single-BU → pre-filled
  if (!(await buInput.isEnabled().catch(() => false))) return
  await buInput.click()
  const content = page.locator('[data-slot="combobox-content"]')
  await expect(content).toBeVisible()
  await content.locator('[data-slot="combobox-item"]').first().click()
  await page.keyboard.press('Escape').catch(() => {})
}

/**
 * Full create flow through the UI; asserts the success toast.
 * `code` is required by the form (max 20 chars); keep it unique per run.
 */
export async function createDepartment(
  page: Page,
  name: string,
  code: string,
): Promise<void> {
  const sheet = await openCreateDepartment(page)
  await selectBusinessUnitsIfNeeded(page)
  await sheet.getByPlaceholder('Enter department name').fill(name)
  await sheet.getByPlaceholder('e.g. HR, ENG, FIN').fill(code)
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  // Save routes through the confirm AlertDialog.
  await confirmAction(page, 'Save')
  await expect(page.getByText('Department created successfully')).toBeVisible()
}

/** Type into the list search box (server-side; needs >= 2 chars, debounced). */
export async function searchDepartments(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search departments...').fill(term)
}

/**
 * Open a department's edit sheet by name. The row click opens a read-only View
 * sheet; its "Edit" button escalates to the editable sheet.
 */
export async function openEditDepartment(page: Page, name: string): Promise<Locator> {
  await searchDepartments(page, name)
  await page.getByRole('cell', { name, exact: true }).click()
  const view = page.getByRole('dialog')
  await expect(view.getByText('View Department')).toBeVisible()
  await view.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await expect(edit.getByText('Edit Department')).toBeVisible()
  return edit
}
