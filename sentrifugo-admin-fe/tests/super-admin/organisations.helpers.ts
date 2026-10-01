import { expect, type Page } from '@playwright/test'
import { confirmAction, goto, testEmail } from '../fixtures/ui'

export const ORG_LIST = '/super-admin/organisations'

/** Navigate to the organisations list and wait for it to render. */
export async function gotoOrgList(page: Page): Promise<void> {
  await goto(page, ORG_LIST)
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible()
}

/** Open the "Add New Organisation" page via the list CTA. */
export async function openAddOrg(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add Organisation' }).click()
  await expect(
    page.getByRole('heading', { name: 'Add New Organisation' }),
  ).toBeVisible()
}

interface CreateOrgInput {
  /** Organisation legal name (unique). */
  name: string
  /** Unique run id; the primary admin email becomes sethu_<runId>@yopmail.com. */
  runId: string
  /** Primary admin full name. */
  adminName?: string
}

/**
 * Create an organisation through the UI and assert we return to the list.
 * Leaves the default module (Core HR) selected; the backend sends an activation
 * link to the (yopmail) admin email so it can be opened manually.
 */
export async function createOrganisation(
  page: Page,
  { name, runId, adminName }: CreateOrgInput,
): Promise<void> {
  await gotoOrgList(page)
  await openAddOrg(page)
  await page.getByLabel('Organisation Name').fill(name)
  await page.getByLabel('Full Name').fill(adminName ?? `_test_${runId}`)
  await page.getByLabel('Email Address').fill(testEmail(runId))
  await page
    .getByRole('button', { name: 'Create & Send Activation Link' })
    .click()
  // Success navigates back to the list.
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible()
}

/** Type into the list search box (server-side; needs >= 2 chars, debounced). */
export async function searchOrgs(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search organisations...').fill(term)
}

/** Open an organisation's edit page by name (row click navigates to /edit). */
export async function openEditOrg(page: Page, name: string): Promise<void> {
  await gotoOrgList(page)
  await searchOrgs(page, name)
  await page.getByRole('cell', { name, exact: true }).first().click()
  // The edit page heading is the org's legal name.
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
}

/**
 * Ensure the organisation is ACTIVE on its edit page, then persist.
 * The status switch is the first switch on the page (the header sits above the
 * embedded Org-Admins table, which has its own per-row switches). Turning it ON
 * has no confirm step; we never turn it off here.
 */
export async function activateOrganisation(page: Page): Promise<void> {
  const statusSwitch = page.getByRole('switch').first()
  if ((await statusSwitch.getAttribute('aria-checked')) !== 'true') {
    await statusSwitch.click()
  }
  await expect(statusSwitch).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(page.getByText('Organisation updated successfully')).toBeVisible()
  // Saving navigates back to the list.
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible()
}

/** On the edit page: rename the organisation and save. */
export async function editOrganisationName(page: Page, newName: string): Promise<void> {
  await page.getByLabel('Organisation Name').fill(newName)
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(page.getByText('Organisation updated successfully')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible()
}

/**
 * On the edit page: turn the status switch OFF (confirming the destructive
 * "Deactivate Organisation" dialog) and save. Assumes the org is currently
 * active (the status switch is the first switch on the page — the embedded
 * Org-Admins table has its own per-row switches below it).
 */
export async function deactivateOrganisation(page: Page): Promise<void> {
  const statusSwitch = page.getByRole('switch').first()
  if ((await statusSwitch.getAttribute('aria-checked')) === 'true') {
    await statusSwitch.click() // OFF → opens the deactivate confirm
    await confirmAction(page, 'Deactivate')
  }
  await expect(statusSwitch).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  await expect(page.getByText('Organisation updated successfully')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Organisations' })).toBeVisible()
}
