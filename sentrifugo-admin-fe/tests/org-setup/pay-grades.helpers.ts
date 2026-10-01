import { expect, type Page, type Locator } from '@playwright/test'
import { confirmAction, goto, pickComboboxFirst } from '../fixtures/ui'

export const PAYGRADES_ROUTE = '/settings/pay-grades'

export async function gotoPayGrades(page: Page): Promise<void> {
  await goto(page, PAYGRADES_ROUTE)
  await expect(page.getByRole('heading', { name: 'Pay Grades', level: 1 })).toBeVisible()
}

export async function openCreatePayGrade(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add Pay Grade' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'Add Pay Grade' })).toBeVisible()
  return sheet
}

/**
 * Create a pay grade. Requires at least one active band, so the caller should
 * ensure one exists first (the spec creates a band in the same run).
 */
export async function createPayGrade(page: Page, name: string): Promise<void> {
  const sheet = await openCreatePayGrade(page)
  await sheet.getByPlaceholder('Enter pay grade name').fill(name)
  await pickComboboxFirst(page, 'Select bands...')
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmAction(page, 'Save')
  await expect(page.getByText('Pay grade created successfully')).toBeVisible()
}

export async function searchPayGrades(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search pay grades...').fill(term)
}

export async function openEditPayGrade(page: Page, name: string): Promise<Locator> {
  await searchPayGrades(page, name)
  await page.getByRole('cell', { name, exact: true }).click()
  const view = page.getByRole('dialog')
  await expect(view.getByRole('heading', { name: 'View Pay Grade' })).toBeVisible()
  await view.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = page.getByRole('dialog')
  await expect(edit.getByRole('heading', { name: 'Edit Pay Grade' })).toBeVisible()
  return edit
}
