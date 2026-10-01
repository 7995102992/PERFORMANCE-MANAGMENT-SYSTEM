import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction } from '../fixtures/ui'
import { createBand, gotoBands } from './bands.helpers'
import {
  createPayGrade,
  gotoPayGrades,
  openCreatePayGrade,
  openEditPayGrade,
  searchPayGrades,
} from './pay-grades.helpers'

test.describe('IAM — Org Setup / Pay Grades @iam @org-setup', () => {
  // 1. Create → verify in the list. A pay grade needs an active band, so make
  //    one first, then create the pay grade selecting the first available band.
  test('org admin creates a pay grade (with a band) and it appears in the list', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const bandName = `_test_${runId}_PGBand`
    const name = `_test_${runId}_PayGrade`

    await login(page, personas.orgAdmin)
    await gotoBands(page)
    await createBand(page, bandName)

    await gotoPayGrades(page)
    await createPayGrade(page, name)

    await searchPayGrades(page, name)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  // 2. Validation — name + at least one band are required.
  test('pay grade form requires a name and a band', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoPayGrades(page)
    const sheet = await openCreatePayGrade(page)

    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(sheet.getByText('Pay grade name is required')).toBeVisible()
    await expect(sheet.getByText('Select at least one band')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Pay grade created successfully')).toHaveCount(0)
  })

  // 3. Edit — create a pay grade (with a band), then rename it and verify it
  //    persisted. Renames the test's own `_test_` pay grade only.
  test('org admin edits a pay grade name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const bandName = `_test_${runId}_PGEditBand`
    const original = `_test_${runId}_Before`
    const renamed = `_test_${runId}_After`

    await login(page, personas.orgAdmin)
    await gotoBands(page)
    await createBand(page, bandName)

    await gotoPayGrades(page)
    await createPayGrade(page, original)

    const edit = await openEditPayGrade(page, original)
    await edit.getByPlaceholder('Enter pay grade name').fill(renamed)
    await edit.getByRole('button', { name: 'Save Changes', exact: true }).click()
    await confirmAction(page, 'Update')
    await expect(page.getByText('Pay grade updated successfully')).toBeVisible()

    await searchPayGrades(page, renamed)
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
    await searchPayGrades(page, original)
    await expect(page.getByRole('cell', { name: original, exact: true })).toHaveCount(0)
  })
})
