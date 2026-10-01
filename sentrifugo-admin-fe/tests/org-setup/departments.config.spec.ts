import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction } from '../fixtures/ui'
import {
  createDepartment,
  gotoDepartments,
  openCreateDepartment,
  openEditDepartment,
  searchDepartments,
} from './departments.helpers'

test.describe('IAM — Org Setup / Departments @iam @org-setup', () => {
  // 1. Create → verify it appears in the list.
  //    NOTE: departments have no delete UI, so `_test_` rows persist (they can
  //    be deactivated via edit, exercised in test 3).
  test('org admin creates a department and it appears in the list', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Dept`
    const code = `T${runId.slice(0, 6)}`

    await login(page, personas.orgAdmin)
    await gotoDepartments(page)
    await createDepartment(page, name, code)

    await searchDepartments(page, name)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  // 2. Validation — submitting an empty form does not create anything: no
  //    confirm dialog, no success toast, and the sheet stays open.
  test('department form blocks an empty submit', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoDepartments(page)
    const sheet = await openCreateDepartment(page)

    await sheet.getByRole('button', { name: 'Save', exact: true }).click()

    // No confirm step was reached and nothing was created.
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Department created successfully')).toHaveCount(0)
    // The create sheet is still open.
    await expect(sheet.getByText('Add New Department')).toBeVisible()
  })

  // 3. Edit — rename a department and verify the change persisted.
  test('org admin edits a department name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    // Distinct suffixes so neither name is a substring of the other.
    const original = `_test_${runId}_Before`
    const renamed = `_test_${runId}_After`
    const code = `E${runId.slice(0, 6)}`

    await login(page, personas.orgAdmin)
    await gotoDepartments(page)
    await createDepartment(page, original, code)

    const edit = await openEditDepartment(page, original)
    const nameInput = edit.getByPlaceholder('Enter department name')
    await expect(nameInput).toHaveValue(original)
    await nameInput.fill(renamed)
    await edit.getByRole('button', { name: 'Update', exact: true }).click()
    await confirmAction(page, 'Update')
    await expect(page.getByText('Department updated successfully')).toBeVisible()

    // The rename persisted; the old name is gone from the list.
    await searchDepartments(page, renamed)
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
    await searchDepartments(page, original)
    await expect(page.getByRole('cell', { name: original, exact: true })).toHaveCount(0)
  })

  // 4. A created department is associated with a business unit — reopening it
  //    for edit shows at least one selected business-unit chip. (In a single-BU
  //    org the sole BU is auto-filled; in a multi-BU org createDepartment picks
  //    the first.)
  test('a department is associated with a business unit', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_BUAssoc`
    const code = `B${runId.slice(0, 6)}`

    await login(page, personas.orgAdmin)
    await gotoDepartments(page)
    await createDepartment(page, name, code)

    const edit = await openEditDepartment(page, name)
    await expect(edit.locator('[data-slot="combobox-chip"]').first()).toBeVisible()
  })
})
