import { expect, type Page, type Locator } from '@playwright/test'
import { confirmAction, goto } from '../fixtures/ui'

export const BANDS_ROUTE = '/settings/bands'

export async function gotoBands(page: Page): Promise<void> {
  await goto(page, BANDS_ROUTE)
  await expect(page.getByRole('heading', { name: 'Bands', level: 1 })).toBeVisible()
}

export async function openCreateBand(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add Band' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'Add Band' })).toBeVisible()
  return sheet
}

/** Create a band (name is the only required field). */
export async function createBand(page: Page, name: string): Promise<void> {
  const sheet = await openCreateBand(page)
  await sheet.getByPlaceholder('e.g. Senior Engineer Band').fill(name)
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmAction(page, 'Save')
  await expect(page.getByText('Band created successfully')).toBeVisible()
}

export async function searchBands(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search bands...').fill(term)
}

export async function openEditBand(page: Page, name: string): Promise<Locator> {
  await searchBands(page, name)
  await page.getByRole('cell', { name, exact: true }).click()
  const view = page.getByRole('dialog')
  await expect(view.getByRole('heading', { name: 'View Band' })).toBeVisible()
  await view.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await expect(edit.getByRole('heading', { name: 'Edit Band' })).toBeVisible()
  return edit
}
