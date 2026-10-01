import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction } from '../fixtures/ui'
import {
  copyPermissionsFrom,
  createRole,
  fetchRolePermissions,
  gotoRoles,
  hasAnyPermission,
  openAddRole,
  openEditRole,
  searchRoles,
} from './roles.helpers'

// Real roles already seeded in the target org (DEV Zenith). The permission tests
// build `_test_` roles by COPYING these existing roles' grids. Override per env.
const EXISTING_ROLE = {
  admin: process.env.E2E_ROLE_ADMIN ?? 'Administrator',
  manager: process.env.E2E_ROLE_MANAGER ?? 'Manager',
  employee: process.env.E2E_ROLE_EMPLOYEE ?? 'Employee',
}

test.describe('IAM — Users & Policies / Roles @iam @users-policies', () => {
  // 1. Create a role (name only) → verify it appears in the list.
  test('org admin creates a role and it appears in the list', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Role`

    await login(page, personas.orgAdmin)
    await gotoRoles(page)
    await createRole(page, name)

    await searchRoles(page, name)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  // 2. Validation — the role name is required; an empty submit creates nothing
  //    (no confirm step, no toast) and stays on the form.
  test('role form requires a name', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoRoles(page)
    await openAddRole(page)

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Role name is required')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Role created successfully')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Add Role' })).toBeVisible()
  })

  // 3. Edit — rename a role and verify the change persisted.
  test('org admin edits a role name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const original = `_test_${runId}_Before`
    const renamed = `_test_${runId}_After`

    await login(page, personas.orgAdmin)
    await gotoRoles(page)
    await createRole(page, original)

    await openEditRole(page, original)
    const nameInput = page.getByPlaceholder('Enter role name')
    await expect(nameInput).toHaveValue(original)
    await nameInput.fill(renamed)
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await confirmAction(page, 'Update')
    await expect(page.getByText('Role updated successfully')).toBeVisible()

    await searchRoles(page, renamed)
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
    await searchRoles(page, original)
    await expect(page.getByRole('cell', { name: original, exact: true })).toHaveCount(0)
  })

  // 4. Create a `_test_` role WITH permissions by copying an EXISTING role
  //    (Administrator), then verify the matrix persisted via the API.
  test('org admin creates a role by copying an existing role', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_AdminCopy`

    await login(page, personas.orgAdmin)
    await gotoRoles(page)
    await openAddRole(page)
    await page.getByPlaceholder('Enter role name').fill(name)
    await copyPermissionsFrom(page, EXISTING_ROLE.admin)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await confirmAction(page, 'Save')
    await expect(page.getByText('Role created successfully')).toBeVisible()

    const grid = await fetchRolePermissions(page, name)
    expect(hasAnyPermission(grid), 'role should have at least one permission').toBe(true)
  })

  // 5. Update a `_test_` role's permissions by copying an EXISTING role
  //    (Manager) → "Permissions updated successfully".
  test("org admin updates a role's permissions from an existing role", async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_RoleEditPerms`

    await login(page, personas.orgAdmin)
    await gotoRoles(page)
    await createRole(page, name) // name-only (empty grid)

    await openEditRole(page, name)
    await copyPermissionsFrom(page, EXISTING_ROLE.manager) // empty grid → applies immediately
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await confirmAction(page, 'Update')
    await expect(page.getByText('Permissions updated successfully')).toBeVisible()

    const grid = await fetchRolePermissions(page, name)
    expect(hasAnyPermission(grid)).toBe(true)
  })

  // 6. Copy permissions from a different EXISTING role (Employee) into a new
  //    `_test_` role.
  test('org admin copies permissions from an existing role', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_EmpCopy`

    await login(page, personas.orgAdmin)
    await gotoRoles(page)
    await openAddRole(page)
    await page.getByPlaceholder('Enter role name').fill(name)
    await copyPermissionsFrom(page, EXISTING_ROLE.employee)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await confirmAction(page, 'Save')
    await expect(page.getByText('Role created successfully')).toBeVisible()

    const grid = await fetchRolePermissions(page, name)
    expect(hasAnyPermission(grid), 'copied role should have permissions').toBe(true)
  })
})
