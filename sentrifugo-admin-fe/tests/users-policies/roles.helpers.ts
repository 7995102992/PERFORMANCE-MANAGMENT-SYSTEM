import { expect, type Page } from '@playwright/test'
import { API_BASE, authHeader, confirmAction, goto } from '../fixtures/ui'

/** Roles live under the Designations route as a tab. The form renders inline
 *  (full page within the tab), not in a sheet. */
export async function gotoRoles(page: Page): Promise<void> {
  await goto(page, '/settings/designations')
  await page.getByRole('tab', { name: 'Roles' }).click()
  await expect(page.getByRole('heading', { name: 'Roles', level: 1 })).toBeVisible()
}

/** Open the inline Add-Role form (replaces the list). */
export async function openAddRole(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add Role' }).click()
  await expect(page.getByRole('heading', { name: 'Add Role' })).toBeVisible()
}

/**
 * Create a role with just a name (permissions default to none). Asserts the
 * success toast; the form then returns to the list.
 */
export async function createRole(page: Page, name: string): Promise<void> {
  await openAddRole(page)
  await page.getByPlaceholder('Enter role name').fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await confirmAction(page, 'Save')
  await expect(page.getByText('Role created successfully')).toBeVisible()
}

/** Type into the list search box (server-side; needs >= 2 chars, debounced). */
export async function searchRoles(page: Page, term: string): Promise<void> {
  await page.getByPlaceholder('Search roles...').fill(term)
}

/** Open a role's inline edit form by name (row click → View → Edit). */
export async function openEditRole(page: Page, name: string): Promise<void> {
  await searchRoles(page, name)
  await page.getByRole('cell', { name, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'View Role' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit Role' })).toBeVisible()
}

/**
 * Grant all VIEWER permissions for the currently-active module in the grid.
 * Viewer is allowed for every module (incl. reports_and_analytics), so this
 * "Select all for Viewer" checkbox is always enabled. Marks the role's grid
 * non-empty → module_count >= 1.
 */
export async function grantAllViewer(page: Page): Promise<void> {
  // Wait for the active module's permission rows to load first — otherwise the
  // "Select all" toggle no-ops (the grid has no permission codes yet).
  await expect(page.locator('tbody').getByRole('checkbox').first()).toBeVisible()
  await page.getByRole('checkbox', { name: 'Select all for Viewer' }).click()
}

/** Use the "Copy all permissions from" picker to copy from an EXISTING role.
 *  Types to filter (the org may have many roles), then picks the exact match.
 *  Add mode / empty grid → applies immediately (no replace confirm). */
export async function copyPermissionsFrom(page: Page, sourceRoleName: string): Promise<void> {
  const input = page.getByPlaceholder('Select a role…')
  await input.click()
  await input.fill(sourceRoleName) // filter the (searchable) picker
  const content = page.locator('[data-slot="combobox-content"]').last()
  await expect(content).toBeVisible()
  await content
    .locator('[data-slot="combobox-item"]')
    .filter({ hasText: sourceRoleName })
    .first()
    .click()
  await expect(page.getByText(`Permissions copied from "${sourceRoleName}"`)).toBeVisible()
}

/** Fetch a role's permission matrix via the IAM API (super/org-admin token). */
export async function fetchRolePermissions(
  page: Page,
  roleName: string,
): Promise<Record<string, Record<string, Record<string, boolean>>>> {
  const list = await page.request.get(`${API_BASE}/policies/roles`, {
    params: { search: roleName, limit: 100 },
    headers: await authHeader(page.context()),
  })
  expect(list.status()).toBe(200)
  const body = await list.json()
  const items: Array<{ id: string; name: string }> = body.items ?? body
  const role = items.find((r) => r.name === roleName)
  if (!role) throw new Error(`Role not found via API: ${roleName}`)
  const perms = await page.request.get(`${API_BASE}/policies/${role.id}/permissions`, {
    headers: await authHeader(page.context()),
  })
  expect(perms.status()).toBe(200)
  return (await perms.json()).permissions ?? {}
}

/** True if the permission matrix grants at least one permission anywhere. */
export function hasAnyPermission(
  grid: Record<string, Record<string, Record<string, boolean>>>,
): boolean {
  return Object.values(grid).some((acls) =>
    Object.values(acls).some((codes) => Object.values(codes).some(Boolean)),
  )
}
