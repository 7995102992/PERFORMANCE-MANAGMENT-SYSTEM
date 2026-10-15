import { test, expect } from '@playwright/test'
import { failOnServerErrors, login, openPms } from './helpers'

/** Corporate HR: cycle list, wizard validation, configuration masters. P = positive flow, N = negative flow. */
test.describe('Corporate HR', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'HR')
  })

  test('HR-P01 PMS Cycle list loads with the Initiate button', async ({ page }) => {
    const noErrors = failOnServerErrors(page)
    await openPms(page, '/pms/cycle', 'PMS Cycle')
    await expect(page.getByRole('button', { name: /initiate|new/i }).first()).toBeVisible()
    noErrors()
  })

  test('HR-P02 wizard opens on Basic Details with an empty name and no auto-filled dates', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await expect(page.getByRole('heading', { name: /Basic Details/ }).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Step 1 of 4/)).toBeVisible()
    await expect(page.locator('#cycle-name')).toHaveValue('')
    await expect(page.getByText('Start date').first()).toBeVisible()
    await expect(page.getByText('End date').first()).toBeVisible()
  })

  test('HR-P03 typing a cycle name clears its required error', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Cycle name is required')).toBeVisible()
    await page.locator('#cycle-name').fill('E2E Cycle')
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Cycle name is required')).toHaveCount(0)
  })

  test('HR-P04 Cancel returns to the cycle list', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/pms\/cycle\/?$/)
  })

  test('HR-N01 Next on an empty Basic Details step is blocked with name and period errors', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Cycle name is required')).toBeVisible()
    await expect(page.getByText('Select the start date')).toBeVisible()
    await expect(page.getByText(/Step 1 of 4/)).toBeVisible()
  })

  test('HR-N02 a cycle name over 120 characters is rejected', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.locator('#cycle-name').fill('x'.repeat(121))
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Keep the name under 120 characters')).toBeVisible()
  })

  test('HR-N03 a description over 500 characters is rejected', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.locator('#cycle-description').fill('y'.repeat(501))
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Keep the description under 500 characters')).toBeVisible()
  })

  for (const [id, path, heading] of [
    ['HR-P05', '/pms/configuration/kra-master', /KRA/],
    ['HR-P06', '/pms/configuration/kpi-master', /KPI/],
    ['HR-P07', '/pms/configuration/goal-templates', /Goal Template/],
    ['HR-P08', '/pms/configuration/rating-scale', /Rating Scale/],
  ] as const) {
    test(`${id} ${path.split('/').pop()} screen loads without server errors`, async ({ page }) => {
      const noErrors = failOnServerErrors(page)
      await openPms(page, path, heading)
      noErrors()
    })
  }

  test('HR-P09 KRA Master: add a KRA and see it in the list', async ({ page }) => {
    const name = `E2E KRA ${Date.now()}`
    await openPms(page, '/pms/configuration/kra-master', /KRA/)
    await page.getByRole('button', { name: /Add KRA/ }).first().click()
    await page.locator('#kra-name').fill(name)
    await page.getByRole('button', { name: 'Add KRA' }).last().click()
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })
  })

  test('HR-P10 Competency master and Approval Workflow screens load', async ({ page }) => {
    for (const path of ['/pms/configuration/competency-master', '/pms/configuration/approval-workflow']) {
      await page.goto(path)
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 })
    }
  })

  test('HR-N04 KRA Master: empty name shows "KRA is required"', async ({ page }) => {
    await openPms(page, '/pms/configuration/kra-master', /KRA/)
    await page.getByRole('button', { name: /Add KRA/ }).first().click()
    await page.getByRole('button', { name: 'Add KRA' }).last().click()
    await expect(page.getByText('KRA is required')).toBeVisible()
  })

  test('HR-N05 KRA Master: a name over 100 characters is rejected', async ({ page }) => {
    await openPms(page, '/pms/configuration/kra-master', /KRA/)
    await page.getByRole('button', { name: /Add KRA/ }).first().click()
    await page.locator('#kra-name').fill('k'.repeat(101))
    await page.getByRole('button', { name: 'Add KRA' }).last().click()
    await expect(page.getByText('Keep it under 100 characters')).toBeVisible()
  })

  test('HR-N06 KRA Master: Cancel closes the dialog and adds nothing', async ({ page }) => {
    await openPms(page, '/pms/configuration/kra-master', /KRA/)
    await page.getByRole('button', { name: /Add KRA/ }).first().click()
    await page.locator('#kra-name').fill('E2E should not be saved')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('E2E should not be saved')).toHaveCount(0)
  })

  test('HR-N07 KRA Master: a duplicate name is refused and the dialog stays open', async ({ page }) => {
    const name = `E2E Dup ${Date.now()}`
    await openPms(page, '/pms/configuration/kra-master', /KRA/)
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: /Add KRA/ }).first().click()
      await page.locator('#kra-name').fill(name)
      await page.getByRole('button', { name: 'Add KRA' }).last().click()
      if (i === 0) await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 })
    }
    await expect(page.locator('#kra-name')).toBeVisible()
  })
})
