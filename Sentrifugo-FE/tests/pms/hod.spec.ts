import { test, expect } from '@playwright/test'
import { FY, failOnServerErrors, login, openPms } from './helpers'

/** HOD: Goal Approvals list, review, return/approve rules. P = positive, N = negative. Never approves for real. */
test.describe('HOD', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'HOD')
  })

  test('HOD-P01 Goal Approvals loads with its toolbar and without server errors', async ({ page }) => {
    const noErrors = failOnServerErrors(page)
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    await expect(page.getByRole('button', { name: 'Approval History' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Approve Selected/ })).toBeVisible()
    noErrors()
  })

  test('HOD-P02 list shows Employee, Role, Section Head, Request Type and Status columns', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    for (const col of ['Employee', 'Role', 'Section Head', 'Request Type', 'Status']) {
      await expect(page.getByRole('columnheader', { name: col })).toBeVisible()
    }
  })

  test('HOD-P03 Approval History opens and loads', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    await page.getByRole('button', { name: 'Approval History' }).click()
    await expect(page.getByRole('heading', { name: 'Approval History' })).toBeVisible({ timeout: 20_000 })
  })

  test('HOD-P04 Review shows the goal sheet with Return and Approve actions', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    const review = page.getByRole('button', { name: 'Review' })
    test.skip((await review.count()) === 0, 'No goal sheet waiting for the HOD')
    await review.first().click()
    await expect(page.getByRole('button', { name: /Return to Section Head/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /Weight/ })).toBeVisible()
  })

  test('HOD-N01 Approve Selected is disabled until a row is ticked', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    await expect(page.getByRole('button', { name: /Approve Selected/ })).toBeDisabled()
  })

  test('HOD-N02 returning without remarks is refused', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    const review = page.getByRole('button', { name: 'Review' })
    test.skip((await review.count()) === 0, 'No goal sheet waiting for the HOD')
    await review.first().click()
    await page.getByRole('button', { name: /Return to Section Head/ }).click()
    await page.getByRole('button', { name: 'Return to Manager' }).click()
    await expect(page.getByText('Remarks are required to return to the manager')).toBeVisible()
  })

  test('HOD-N03 remarks are capped at 500 characters', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    const review = page.getByRole('button', { name: 'Review' })
    test.skip((await review.count()) === 0, 'No goal sheet waiting for the HOD')
    await review.first().click()
    await page.getByRole('button', { name: /Return to Section Head/ }).click()
    await page.locator('#return-remarks').fill('r'.repeat(600))
    expect((await page.locator('#return-remarks').inputValue()).length).toBeLessThanOrEqual(500)
  })

  test('HOD-N04 Cancel on the return dialog closes it and leaves the sheet pending', async ({ page }) => {
    await openPms(page, `/pms/goal-approvals/${FY}`, 'Goal Approvals')
    const review = page.getByRole('button', { name: 'Review' })
    test.skip((await review.count()) === 0, 'No goal sheet waiting for the HOD')
    await review.first().click()
    await page.getByRole('button', { name: /Return to Section Head/ }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  })
})
