import { expect, type Page } from '@playwright/test'
import { confirmAction, goto, pickFirstOptionOf } from '../fixtures/ui'

export const BUSINESS_UNITS_ROUTE = '/settings/business-units'

export async function gotoBusinessUnits(page: Page): Promise<void> {
  await goto(page, BUSINESS_UNITS_ROUTE)
  await expect(page.getByRole('heading', { name: 'Organisation Structure' })).toBeVisible()
}

/** Multi-BU mode shows a "Manage Business Units" view with this CTA. */
export function addBusinessUnitButton(page: Page) {
  return page.getByRole('button', { name: 'Add Business Unit' })
}

export async function searchBusinessUnits(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search business units...').fill(term)
}

/** Open a BU's edit form by name (the row's pencil opens edit directly). */
export async function openEditBusinessUnit(page: Page, name: string): Promise<void> {
  await searchBusinessUnits(page, name)
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button')
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Business Unit Details' })).toBeVisible()
}

/** On the BU edit form: rename and save (confirm "Update Business Unit?"). */
export async function editBusinessUnitName(page: Page, newName: string): Promise<void> {
  await page.getByPlaceholder('e.g., Acme Corporation LLC').fill(newName)
  await page.getByRole('button', { name: 'Update', exact: true }).click()
  await confirmAction(page, 'Update')
  await expect(page.getByText('Business unit updated successfully')).toBeVisible()
}

/** Open a searchable combobox by placeholder, type a query, and pick the exact match. */
async function pickComboboxExact(page: Page, placeholder: string, label: string): Promise<void> {
  const input = page.getByPlaceholder(placeholder)
  await input.click()
  await input.fill(label)
  const content = page.locator('[data-slot="combobox-content"]')
  await expect(content).toBeVisible()
  await content
    .locator('[data-slot="combobox-item"]')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .click()
  await page.keyboard.press('Escape').catch(() => {})
}

/** Pick the first option of a combobox by placeholder, but only if it's present
 *  and interactive (skips auto-filled selects, e.g. India's single currency). */
async function pickIfPresent(page: Page, placeholder: string): Promise<void> {
  const loc = page.getByPlaceholder(placeholder).first()
  if ((await loc.count()) === 0) return
  if (!(await loc.isEnabled().catch(() => false))) return
  await pickFirstOptionOf(page, loc)
}

/** Pick a valid past date via the DatePicker (Popover + calendar). Clicks the
 *  first enabled day — future days are disabled (maxDate = today). */
async function pickIncorporationDate(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Select an incorporation date' }).click()
  const cal = page.locator('[data-slot="calendar"]')
  await expect(cal).toBeVisible()
  await cal.locator('button[data-day]:not([disabled])').first().click()
  await page.keyboard.press('Escape').catch(() => {})
}

/**
 * Create a business unit in MULTIPLE mode through the full form. Uses India as
 * the country (it has states/cities and a single currency/timezone that the form
 * auto-fills). Requires seeded geo master data. `prefix` must be unique (letters/
 * digits, auto-uppercased).
 */
export async function createBusinessUnit(page: Page, name: string, prefix: string): Promise<void> {
  await addBusinessUnitButton(page).click()
  await expect(page.getByRole('heading', { name: 'Business Unit Details' })).toBeVisible()

  await page.getByPlaceholder('e.g., Acme Corporation LLC').fill(name)
  await pickComboboxExact(page, 'Select a country', 'India')
  await pickFirstOptionOf(page, page.getByPlaceholder('Select state'))
  await pickFirstOptionOf(page, page.getByPlaceholder('Select city'))
  // India auto-fills currency/time zone/fiscal year; pick them only if needed.
  await pickIfPresent(page, 'Select currency')
  await pickIfPresent(page, 'Select Time Zone')
  await pickIfPresent(page, 'Select financial year type')

  await page.getByPlaceholder('e.g., 123 Main St').fill('123 E2E Street')
  await page.getByPlaceholder('e.g., 10001 or 10001-1234').fill('500081')
  await page.getByPlaceholder('e.g., SIL').fill(prefix)

  await page.getByLabel('Full-Time Start From').fill('1')
  await page.getByLabel('Contract Start From').fill('1')
  await page.getByLabel('Internship Start From').fill('1')

  await pickIncorporationDate(page)

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmAction(page, 'Save')
  await expect(page.getByText('Business unit created successfully')).toBeVisible()
}
