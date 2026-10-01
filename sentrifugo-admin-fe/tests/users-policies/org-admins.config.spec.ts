import { test, expect } from '@playwright/test'
import { randomUUID } from 'crypto'
import { login } from '../fixtures/auth'
import { personas } from '../fixtures/personas'
import { confirmAction, goto, testEmail } from '../fixtures/ui'

/**
 * Organisation Admins (Users & Policies). New admins are created via a Dialog
 * and receive an activation email; there is no delete UI (only activate/
 * deactivate), so `_test_` admins persist. The add form's name fields have no
 * associated <label>, so they are filled by order within the dialog.
 */
test.describe('IAM — Users & Policies / Org Admins @iam @users-policies', () => {
  async function gotoOrgAdmins(page: import('@playwright/test').Page) {
    await goto(page, '/settings/org-admins')
    await expect(
      page.getByRole('heading', { name: 'Organisation Admins' }),
    ).toBeVisible()
  }

  // 1. Create an org admin → activation toast + the new admin appears in the table.
  test('org admin adds a new organisation admin', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const email = testEmail(runId) // sethu_<runId>@yopmail.com → activation mail fires

    await login(page, personas.orgAdmin)
    await gotoOrgAdmins(page)

    await page.getByRole('button', { name: 'Add Admin' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Add Org Admin')).toBeVisible()

    const inputs = dialog.locator('input')
    await inputs.nth(0).fill('E2E') // First Name
    await inputs.nth(1).fill(`_test_${runId}`) // Last Name
    await dialog.getByPlaceholder('admin@example.com').fill(email)
    await dialog.getByRole('button', { name: 'Add Admin' }).click()

    await expect(
      page.getByText('Org admin added. Activation email sent.'),
    ).toBeVisible()
    await expect(page.getByText(email)).toBeVisible()
  })

  // 2. Validation — required fields are enforced and the dialog stays open.
  test('add org admin validates required fields', async ({ page }) => {
    await login(page, personas.orgAdmin)
    await gotoOrgAdmins(page)

    await page.getByRole('button', { name: 'Add Admin' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add Admin' }).click()

    await expect(page.getByText('First name is required.')).toBeVisible()
    await expect(page.getByText('Last name is required.')).toBeVisible()
    await expect(page.getByText('Email is required.')).toBeVisible()
    await expect(dialog.getByText('Add Org Admin')).toBeVisible()
  })

  // 3. Validation — a malformed email is rejected.
  test('add org admin rejects a malformed email', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    await login(page, personas.orgAdmin)
    await gotoOrgAdmins(page)

    await page.getByRole('button', { name: 'Add Admin' }).click()
    const dialog = page.getByRole('dialog')
    const inputs = dialog.locator('input')
    await inputs.nth(0).fill('E2E')
    await inputs.nth(1).fill(`_test_${runId}`)
    await dialog.getByPlaceholder('admin@example.com').fill('not-an-email')
    await dialog.getByRole('button', { name: 'Add Admin' }).click()

    await expect(page.getByText('Enter a valid email address.')).toBeVisible()
    await expect(dialog.getByText('Add Org Admin')).toBeVisible()
  })

  // 4. Resend the activation email for a freshly-added (pending) admin.
  test('org admin resends an admin activation email', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const email = testEmail(runId)

    await login(page, personas.orgAdmin)
    await gotoOrgAdmins(page)

    await page.getByRole('button', { name: 'Add Admin' }).click()
    const dialog = page.getByRole('dialog')
    const inputs = dialog.locator('input')
    await inputs.nth(0).fill('E2E')
    await inputs.nth(1).fill(`_test_${runId}`)
    await dialog.getByPlaceholder('admin@example.com').fill(email)
    await dialog.getByRole('button', { name: 'Add Admin' }).click()
    await expect(page.getByText('Org admin added. Activation email sent.')).toBeVisible()

    // The new (pending) admin's row shows a Resend control.
    const row = page.getByRole('row', { name: new RegExp(email) })
    await row.getByRole('button', { name: 'Resend' }).click()
    await confirmAction(page, 'Resend')
    await expect(page.getByText('Activation email resent.')).toBeVisible()
  })

  // 5. Adding an admin whose email already exists is rejected (backend 409) —
  //    the dialog stays open.
  test('rejects adding an org admin with a duplicate email', async ({ page }) => {
    const runId = randomUUID().slice(0, 8)
    const email = testEmail(runId)

    await login(page, personas.orgAdmin)
    await gotoOrgAdmins(page)

    // First add succeeds.
    await page.getByRole('button', { name: 'Add Admin' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.locator('input').nth(0).fill('E2E')
    await dialog.locator('input').nth(1).fill(`_test_${runId}`)
    await dialog.getByPlaceholder('admin@example.com').fill(email)
    await dialog.getByRole('button', { name: 'Add Admin' }).click()
    await expect(page.getByText('Org admin added. Activation email sent.')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0) // wait for the dialog to close

    // Second add with the same email is rejected; the dialog remains open.
    await page.getByRole('button', { name: 'Add Admin' }).click()
    dialog = page.getByRole('dialog')
    await dialog.locator('input').nth(0).fill('E2E')
    await dialog.locator('input').nth(1).fill(`_test_${runId}`)
    await dialog.getByPlaceholder('admin@example.com').fill(email)
    await dialog.getByRole('button', { name: 'Add Admin' }).click()

    await expect(dialog.getByText('Add Org Admin')).toBeVisible()
  })
})
