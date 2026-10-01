import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction } from '../fixtures/ui'
import {
  createBand,
  gotoBands,
  openCreateBand,
  openEditBand,
  searchBands,
} from './bands.helpers'

test.describe('IAM — Org Setup / Bands @iam @org-setup', () => {
  // 1. Create → verify in the list.
  test('org admin creates a band and it appears in the list', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_Band`

    await login(page, personas.orgAdmin)
    await gotoBands(page)
    await createBand(page, name)

    await searchBands(page, name)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  // 2. Validation — name required; empty submit creates nothing.
  test('band form requires a name', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoBands(page)
    const sheet = await openCreateBand(page)

    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(sheet.getByText('Band name is required')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByText('Band created successfully')).toHaveCount(0)
  })

  // 3. Edit — rename and verify it persisted.
  test('org admin edits a band name', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const original = `_test_${runId}_Before`
    const renamed = `_test_${runId}_After`

    await login(page, personas.orgAdmin)
    await gotoBands(page)
    await createBand(page, original)

    const edit = await openEditBand(page, original)
    await edit.getByPlaceholder('e.g. Senior Engineer Band').fill(renamed)
    await edit.getByRole('button', { name: 'Save Changes', exact: true }).click()
    await confirmAction(page, 'Update')
    await expect(page.getByText('Band updated successfully')).toBeVisible()

    await searchBands(page, renamed)
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
    await searchBands(page, original)
    await expect(page.getByRole('cell', { name: original, exact: true })).toHaveCount(0)
  })
})
