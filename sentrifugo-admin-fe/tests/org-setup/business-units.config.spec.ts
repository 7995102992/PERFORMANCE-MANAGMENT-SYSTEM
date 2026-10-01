import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { goto } from '../fixtures/ui'
import {
  addBusinessUnitButton,
  createBusinessUnit,
  editBusinessUnitName,
  gotoBusinessUnits,
  openEditBusinessUnit,
  searchBusinessUnits,
} from './business-units.helpers'

/**
 * Business Units coverage is intentionally light: the only mutating entry point
 * is a large full-page form, and the structure toggle (single ↔ multiple) is
 * destructive (it bulk-deletes BUs). These tests assert the structure chooser
 * renders and, when the org is in multi-BU mode, that the manage view exposes
 * its create CTA — without performing destructive switches. Full BU CRUD is a
 * future increment.
 */
test.describe('IAM — Org Setup / Business Units @iam @org-setup', () => {
  // 1. The structure chooser is always present with both options.
  test('business units page shows the structure chooser', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await goto(page, '/settings/business-units')

    await expect(
      page.getByRole('heading', { name: 'Organisation Structure' }),
    ).toBeVisible()
    await expect(page.getByText('No Business Unit / Subsidiary')).toBeVisible()
    await expect(
      page.getByText('Multiple Business Units / Subsidiaries'),
    ).toBeVisible()
  })

  // 2. In multi-BU mode the manage view exposes the create CTA and search.
  //    (Skips cleanly on single-BU orgs, where this view isn't rendered.)
  test('multi-BU orgs expose the manage view', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await goto(page, '/settings/business-units')

    const manageHeading = page.getByRole('heading', { name: 'Manage Business Units' })
    if ((await manageHeading.count()) === 0) {
      test.skip(true, 'org is in single-BU mode — manage view not shown')
    }
    await expect(manageHeading).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Business Unit' })).toBeVisible()
    await expect(page.getByPlaceholder('Search business units...')).toBeVisible()
  })

  // 3. Create-form validation — an empty submit surfaces the required-field
  //    errors and does NOT reach the "Save Business Unit?" confirm. (Multi-BU
  //    mode only — the create form is opened from the manage view.)
  test('business unit create form validates required fields', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await goto(page, '/settings/business-units')

    const addBtn = page.getByRole('button', { name: 'Add Business Unit' })
    if ((await addBtn.count()) === 0) {
      test.skip(true, 'org is in single-BU mode — multi-BU create form not shown')
    }
    await addBtn.click()
    await expect(page.getByRole('heading', { name: 'Business Unit Details' })).toBeVisible()

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Business Unit Name is required')).toBeVisible()
    await expect(page.getByText('Country is required')).toBeVisible()
    // No confirm dialog was reached (nothing valid to save).
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  })

  // 4. Full create — fills every required field (India geo + auto-filled
  //    currency/timezone/fiscal, a past incorporation date) and verifies the new
  //    BU lands in the manage list. Multi-BU mode + seeded geo data required.
  test('org admin creates a business unit', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const name = `_test_${runId}_BU`
    const prefix = `T${runId.slice(0, 4)}` // unique, letters/digits, auto-uppercased

    await login(page, personas.orgAdmin)
    await gotoBusinessUnits(page)

    if ((await addBusinessUnitButton(page).count()) === 0) {
      test.skip(true, 'org is in single-BU mode — multi-BU create not available')
    }
    await createBusinessUnit(page, name, prefix)

    // Back on the manage list, the new BU is searchable.
    await searchBusinessUnits(page, name)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  // 5. Edit — create a BU, then rename it and verify the change persisted.
  //    Edits the test's own `_test_` BU only (never a real one).
  test('org admin edits a business unit', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const original = `_test_${runId}_BUedit`
    const renamed = `_test_${runId}_BUrenamed`
    const prefix = `E${runId.slice(0, 4)}`

    await login(page, personas.orgAdmin)
    await gotoBusinessUnits(page)
    if ((await addBusinessUnitButton(page).count()) === 0) {
      test.skip(true, 'org is in single-BU mode — multi-BU create/edit not available')
    }
    await createBusinessUnit(page, original, prefix)

    await openEditBusinessUnit(page, original)
    await editBusinessUnitName(page, renamed)

    await searchBusinessUnits(page, renamed)
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible()
  })
})
