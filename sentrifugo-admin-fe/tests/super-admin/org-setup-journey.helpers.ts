import { expect, type Page } from '@playwright/test'
import {
  API_BASE,
  authHeader,
  confirmAction,
  escapeRegex,
  goto,
  pickFirstOptionOf,
} from '../fixtures/ui'
import { uploadLogo } from '../fixtures/upload'
import { gotoBusinessUnits } from '../org-setup/business-units.helpers'

/**
 * Helpers for the full new-org SETUP WIZARD journey, driven as the freshly
 * onboarded org admin (setup_status !== 'active' → OrgSetupLayout). Navigation
 * reuses `goto()` per step — the wizard serves the same /settings/* (and
 * /employees/*) pages the post-setup app does; only the surrounding chrome and
 * the dependency-gated sidebar differ. These helpers cover the two pieces the
 * per-feature suites don't: the Organisation profile step and the wizard's
 * structure chooser / finish controls.
 */

const DOC_FILE = 'tests/fixtures/files/test_org_policy.pdf' // relative to repo root

/** Click whichever of the given confirm-dialog action buttons is present. */
async function confirmAnyOf(page: Page, names: string[]): Promise<void> {
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  for (const name of names) {
    const btn = dialog.getByRole('button', { name, exact: true })
    if (await btn.count()) {
      await btn.click()
      return
    }
  }
  throw new Error(`No confirm button matched any of: ${names.join(', ')}`)
}

/** Open a SearchableSelect by placeholder, type the label to filter, pick the exact match.
 *  Matches the placeholder EXACTLY — "Select country" is otherwise a substring of the
 *  "Select country first" placeholder on the (pre-country) currency/timezone selects. */
async function pickComboboxExact(
  page: Page,
  placeholder: string,
  label: string,
): Promise<void> {
  const input = page.getByPlaceholder(placeholder, { exact: true })
  await input.click()
  await input.fill(label)
  const content = page.locator('[data-slot="combobox-content"]').last()
  await expect(content).toBeVisible()
  await content
    .locator('[data-slot="combobox-item"]')
    .filter({ hasText: new RegExp(`^${escapeRegex(label)}$`) })
    .first()
    .click()
  await page.keyboard.press('Escape').catch(() => {})
}

/** Pick the first option of a combobox by placeholder — but only if it is
 *  present, enabled, still empty, and actually has options. Used for fields the
 *  org form auto-fills for some countries (currency / timezone / fiscal year). */
async function pickFirstIfNeeded(page: Page, placeholder: string): Promise<void> {
  const loc = page.getByPlaceholder(placeholder).first()
  if ((await loc.count()) === 0) return
  if (!(await loc.isEnabled().catch(() => false))) return
  if (await loc.inputValue().catch(() => '')) return // already auto-filled
  await loc.click()
  const content = page.locator('[data-slot="combobox-content"]').last()
  if (!(await content.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {})
    return
  }
  const items = content.locator('[data-slot="combobox-item"]')
  if ((await items.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {})
    return
  }
  await items.first().click()
  await page.keyboard.press('Escape').catch(() => {})
}

/** Pick a valid past incorporation date via the DatePicker (first enabled day). */
async function pickIncorporationDate(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Select an incorporation date' }).click()
  const cal = page.locator('[data-slot="calendar"]')
  await expect(cal).toBeVisible()
  await cal.locator('button[data-day]:not([disabled])').first().click()
  await page.keyboard.press('Escape').catch(() => {})
}

/**
 * STEP 1 — complete the Organisation profile (Details tab).
 *
 * A super-admin-created org opens this form read-only with an "Edit" button and
 * the legal name pre-filled; everything else (logo, country, address, dates) is
 * empty and mandatory. Uses India as the country so currency/timezone/fiscal
 * auto-fill (requires seeded geo master data). Asserts the save toast.
 */
export async function completeOrganisationProfile(page: Page): Promise<void> {
  await goto(page, '/settings/organisation')
  // "Organisation Details" is the (selected) tab — the CardTitle is plain text,
  // not a heading. Assert the tab to confirm the org-profile step rendered.
  await expect(
    page.getByRole('tab', { name: 'Organisation Details' }),
  ).toBeVisible()

  // Wait for the org to hydrate (legal name pre-fills), then leave read-only.
  const legal = page.getByPlaceholder('Enter legal name')
  await expect(legal).not.toHaveValue('', { timeout: 15_000 })
  const editBtn = page.getByRole('button', { name: 'Edit', exact: true })
  if (await editBtn.count()) await editBtn.first().click()

  // Logo is required — drives the ImageUploader crop dialog.
  await uploadLogo(page)

  // Location — India loads states/cities and auto-fills currency/timezone/fiscal.
  await pickComboboxExact(page, 'Select country', 'India')
  await pickFirstOptionOf(page, page.getByPlaceholder('Select state'))
  await pickFirstOptionOf(page, page.getByPlaceholder('Select city'))

  await page.getByPlaceholder('Street address, P.O. box, c/o').fill('123 E2E Street')
  await page.getByPlaceholder('Enter zip code').fill('500081')
  await pickIncorporationDate(page)

  // Auto-filled for India; set only if still empty.
  await pickFirstIfNeeded(page, 'Select financial year type')
  await pickFirstIfNeeded(page, 'Select currency')
  await pickFirstIfNeeded(page, 'Select timezone')

  // Submit (existing org → "Update"; defensive "Save" fallback) + confirm.
  await page.getByRole('button', { name: /^(Update|Save)$/ }).last().click()
  await confirmAnyOf(page, ['Update', 'Save'])
  await expect(page.getByText('Organisation saved successfully')).toBeVisible()
}

/**
 * STEP 2a — pick the organisation structure on a fresh org's Business Units step.
 * For a never-set org the change routes through a confirm dialog whose label
 * differs by direction ("Yes, Switch" for → multiple, "Yes, Continue" for the
 * generic first-time path), so accept either. Multi-BU lands on the manage view.
 */
export async function chooseBusinessStructure(
  page: Page,
  structure: 'single' | 'multiple',
): Promise<void> {
  await gotoBusinessUnits(page) // asserts the "Organisation Structure" chooser
  const label =
    structure === 'multiple'
      ? 'Multiple Business Units / Subsidiaries'
      : 'No Business Unit / Subsidiary'
  await page.getByText(label).click()
  await confirmAnyOf(page, ['Yes, Switch', 'Yes, Continue'])
  if (structure === 'multiple') {
    await expect(
      page.getByRole('heading', { name: 'Manage Business Units' }),
    ).toBeVisible()
  }
}

/**
 * OPTIONAL — create a document folder and upload the seed PDF into it.
 * Mirrors org-documents.config.spec; folders-first, document lives in a folder.
 */
export async function uploadOrgDocument(page: Page, folder: string): Promise<void> {
  await goto(page, '/settings/org-documents')
  await expect(
    page.getByRole('heading', { name: 'Organisation Documents' }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'New Folder' }).click()
  const folderSheet = page.getByRole('dialog')
  await folderSheet.getByPlaceholder('e.g. Company Policies').fill(folder)
  await folderSheet.getByRole('button', { name: 'Create Folder' }).click()

  await page.getByRole('button', { name: 'Add Document' }).first().click()
  const docSheet = page.getByRole('dialog')
  await expect(docSheet.getByText('Add Documents')).toBeVisible()
  await docSheet.locator('input[type="file"]').setInputFiles(DOC_FILE)
  await docSheet.getByRole('button', { name: /Upload 1 File/ }).click()
  await expect(
    page.getByText(/uploaded successfully|added successfully/i),
  ).toBeVisible({ timeout: 20_000 })
}

/**
 * OPTIONAL — assign the first available employee as Organisation Head.
 * No-op (returns) if selecting the first employee registers no change (already
 * assigned, or no employees exist).
 */
export async function assignOrganisationHead(page: Page): Promise<void> {
  await goto(page, '/settings/assign-heads')
  await expect(
    page.getByRole('heading', { name: 'Assign Heads', level: 1 }),
  ).toBeVisible()

  await pickFirstOptionOf(page, page.getByPlaceholder('Select employee').first())
  const saveAll = page.getByRole('button', { name: /Save All/ }).last()
  if (!(await saveAll.isEnabled())) return
  await saveAll.click()
  await confirmAction(page, 'Save 1 change')
  await expect(page.getByText(/head[s]? updated successfully/)).toBeVisible()
}

/**
 * FINISH — click the wizard's finish control (in the desktop sidebar) and
 * confirm. The label/confirm differ by completeness: all steps done →
 * "Finish Setup" / "Complete Setup"; mandatory-only → "Skip & Finish" /
 * "Skip and Complete". Asserts the completion toast.
 */
export async function finishSetup(page: Page): Promise<void> {
  const sidebar = page.locator('aside:visible')
  const finishBtn = sidebar.getByRole('button', {
    name: /Finish Setup|Skip & Finish/,
  })
  await expect(finishBtn).toBeVisible()
  await finishBtn.click()
  await confirmAnyOf(page, ['Complete Setup', 'Skip and Complete'])
  await expect(page.getByText('Organisation setup completed')).toBeVisible()
}

/** Read the logged-in org admin's own organisation setup_status via the IAM API. */
export async function fetchOrgSetupStatus(page: Page): Promise<string> {
  const res = await page.request.get(`${API_BASE}/organisations/`, {
    headers: await authHeader(page.context()),
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  return body.setup_status
}
