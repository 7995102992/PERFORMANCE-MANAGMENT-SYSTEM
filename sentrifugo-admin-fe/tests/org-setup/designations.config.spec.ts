import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction } from '../fixtures/ui'
import {
  createDesignation,
  gotoDesignations,
  openCreateDesignation,
  openEditDesignation,
  searchDesignations,
} from './designations.helpers'

test.describe('IAM — Org Setup / Designations @iam @org-setup', () => {
  // 1. Create → verify it appears in the list. (Requires seeded pay grades.)
  test('org admin creates a designation and it appears in the list', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Desg`

    await login(page, personas.orgAdmin)
    await gotoDesignations(page)
    await createDesignation(page, name)

    await searchDesignations(page, name)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  // 2. Validation — name + at least one pay grade are required; an empty submit
  //    creates nothing (no confirm step, no toast) and the sheet stays open.
  test('designation form blocks an empty submit', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoDesignations(page)
    const sheet = await openCreateDesignation(page)

    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(sheet.getByText('Designation name is required')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Designation created successfully')).toHaveCount(0)
    await expect(sheet.getByRole('heading', { name: 'Add Designation' })).toBeVisible()
  })

  // 3. Edit — rename a designation and verify the change persisted.
  test('org admin edits a designation name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const original = `_test_${runId}_Before`
    const renamed = `_test_${runId}_After`

    await login(page, personas.orgAdmin)
    await gotoDesignations(page)
    await createDesignation(page, original)

    const edit = await openEditDesignation(page, original)
    const nameInput = edit.getByPlaceholder('Enter designation name')
    await expect(nameInput).toHaveValue(original)
    await nameInput.fill(renamed)
    await edit.getByRole('button', { name: 'Update', exact: true }).click()
    await confirmAction(page, 'Update')
    await expect(page.getByText('Designation updated successfully')).toBeVisible()

    await searchDesignations(page, renamed)
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
    await searchDesignations(page, original)
    await expect(page.getByRole('cell', { name: original, exact: true })).toHaveCount(0)
  })
})
