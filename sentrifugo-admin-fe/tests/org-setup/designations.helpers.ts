import { expect, type Page, type Locator } from '@playwright/test'
import { confirmAction, goto, pickComboboxFirst } from '../fixtures/ui'

export const DESIGNATIONS_ROUTE = '/settings/designations'

/** The Designations route hosts a tab group (Bands | Pay Grades | Designations | Roles). */
export async function gotoDesignationsTab(
  page: Page,
  tab: 'Bands' | 'Pay Grades' | 'Designations' | 'Roles',
): Promise<void> {
  await goto(page, DESIGNATIONS_ROUTE)
  await page.getByRole('tab', { name: tab }).click()
}

/** Open the Designations tab and wait for its list. */
export async function gotoDesignations(page: Page): Promise<void> {
  await gotoDesignationsTab(page, 'Designations')
  await expect(page.getByRole('heading', { name: 'Designations', level: 1 })).toBeVisible()
}

/** Open the create sheet (FormSheet dialog) and return it. */
export async function openCreateDesignation(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add Designation' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'Add Designation' })).toBeVisible()
  return sheet
}

/**
 * Full create flow. A designation REQUIRES at least one Pay Grade, so this
 * assumes the org has pay grades seeded (true on DEV); the picker is disabled
 * otherwise and the create cannot proceed.
 */
export async function createDesignation(page: Page, name: string): Promise<void> {
  const sheet = await openCreateDesignation(page)
  await sheet.getByPlaceholder('Enter designation name').fill(name)
  await pickComboboxFirst(page, 'Select pay grades...')
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmAction(page, 'Save')
  await expect(page.getByText('Designation created successfully')).toBeVisible()
}

/** Type into the list search box (server-side; needs >= 2 chars, debounced). */
export async function searchDesignations(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search designations...').fill(term)
}

/** Open a designation's edit sheet by name (row click → View → Edit). */
export async function openEditDesignation(page: Page, name: string): Promise<Locator> {
  await searchDesignations(page, name)
  await page.getByRole('cell', { name, exact: true }).click()
  const view = page.getByRole('dialog')
  await expect(view.getByRole('heading', { name: 'View Designation' })).toBeVisible()
  await view.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await expect(edit.getByRole('heading', { name: 'Edit Designation' })).toBeVisible()
  return edit
}
