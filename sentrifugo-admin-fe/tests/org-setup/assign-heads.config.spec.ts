import { test, expect } from '@playwright/test'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction, goto, pickFirstOptionOf } from '../fixtures/ui'

/**
 * Assign Heads (/settings/assign-heads) has three cards — Organisation Head,
 * Business Unit Head, Department Head — each with a SearchableSelect employee
 * picker, and a single "Save All" CTA.
 */
test.describe('IAM — Org Setup / Assign Heads @iam @org-setup', () => {
  async function gotoAssignHeads(page: import('@playwright/test').Page) {
    await goto(page, '/settings/assign-heads')
    await expect(page.getByRole('heading', { name: 'Assign Heads', level: 1 })).toBeVisible()
  }

  // 1. The page renders the three head-assignment cards and the Save All CTA.
  test('assign heads page renders its sections', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoAssignHeads(page)

    await expect(page.getByText('Assigned Head')).toBeVisible() // Organisation Head card
    await expect(page.getByRole('button', { name: /Save All/ })).toBeVisible()
    // Nothing changed yet → Save All is disabled.
    await expect(page.getByRole('button', { name: /Save All/ })).toBeDisabled()
  })

  // 2. Assign an organisation head and persist. Skips if selecting the first
  //    employee produces no change (e.g. it's already the head) or no employees.
  test('org admin assigns an organisation head', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoAssignHeads(page)

    // The Organisation Head picker is the first "Select employee" combobox.
    await pickFirstOptionOf(page, page.getByPlaceholder('Select employee').first())

    // After a change a second "Save All (N)" button appears; target the last.
    const saveAll = page.getByRole('button', { name: /Save All/ }).last()
    if (!(await saveAll.isEnabled())) {
      test.skip(true, 'no head change registered (already assigned, or no employees seeded)')
    }
    await saveAll.click()
    await confirmAction(page, 'Save 1 change')
    await expect(page.getByText(/head[s]? updated successfully/)).toBeVisible()
  })
})
