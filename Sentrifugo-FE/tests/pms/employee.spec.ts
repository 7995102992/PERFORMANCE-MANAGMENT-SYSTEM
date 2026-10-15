import { test, expect, type Page } from '@playwright/test'
import { FY, failOnServerErrors, login, openPms } from './helpers'

/** Employee: My Goals (acknowledge / request change), Self Appraisal, menu gating. P = positive, N = negative. */

/** Opens My Goals; true when the sheet can be responded to (sent to the employee). */
async function openMyGoals(page: Page): Promise<boolean> {
  await openPms(page, `/pms/my-goals/${FY}`, 'My Goals')
  return (await page.getByRole('button', { name: /Request (for )?Change/ }).count()) > 0
}

test.describe('Employee', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'EMPLOYEE')
  })

  test('EMP-P01 My Goals loads without server errors', async ({ page }) => {
    const noErrors = failOnServerErrors(page)
    await openMyGoals(page)
    noErrors()
  })

  test('EMP-P02 My Goals shows the sheet table or a clear empty state', async ({ page }) => {
    await openMyGoals(page)
    const table = page.getByRole('table').first()
    const empty = page.getByText(/has not set goals|not.*(assigned|sent)|no goals|not started/i).first()
    await expect(table.or(empty)).toBeVisible({ timeout: 20_000 })
  })

  test('EMP-P03 Request Change dialog opens with KRA, Proposed Target and Reason', async ({ page }) => {
    test.skip(!(await openMyGoals(page)), 'Goal sheet is not awaiting acknowledgement')
    await page.getByRole('button', { name: /Request (for )?Change/ }).click()
    await expect(page.getByRole('dialog').getByText('Request Change').first()).toBeVisible()
    await expect(page.locator('#chg-target')).toBeVisible()
    await expect(page.locator('#chg-reason')).toBeVisible()
  })

  test('EMP-P04 Acknowledge dialog opens and Cancel closes it', async ({ page }) => {
    test.skip(!(await openMyGoals(page)), 'Goal sheet is not awaiting acknowledgement')
    await page.getByRole('button', { name: 'Acknowledge', exact: true }).click()
    await expect(page.getByRole('dialog').getByText('Acknowledge Goals')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('EMP-P05 Self Appraisal loads with its heading', async ({ page }) => {
    const noErrors = failOnServerErrors(page)
    await openPms(page, `/pms/self-appraisal/${FY}`, /Self Appraisal/)
    noErrors()
  })

  test('EMP-N01 Request Change without a reason is refused', async ({ page }) => {
    test.skip(!(await openMyGoals(page)), 'Goal sheet is not awaiting acknowledgement')
    await page.getByRole('button', { name: /Request (for )?Change/ }).click()
    await page.locator('#chg-target').fill('10')
    await page.getByRole('button', { name: 'Submit Request' }).click()
    await expect(page.getByText('Choose a KRA and give a reason')).toBeVisible()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('EMP-N02 a non-numeric proposed target is refused', async ({ page }) => {
    test.skip(!(await openMyGoals(page)), 'Goal sheet is not awaiting acknowledgement')
    await page.getByRole('button', { name: /Request (for )?Change/ }).click()
    await page.locator('#chg-target').fill('abc')
    await page.locator('#chg-reason').fill('E2E negative test')
    await page.getByRole('button', { name: 'Submit Request' }).click()
    await expect(page.getByText('Proposed target must be a number')).toBeVisible()
  })

  test('EMP-N03 a negative proposed target is refused', async ({ page }) => {
    test.skip(!(await openMyGoals(page)), 'Goal sheet is not awaiting acknowledgement')
    await page.getByRole('button', { name: /Request (for )?Change/ }).click()
    await page.locator('#chg-target').fill('-5')
    await page.locator('#chg-reason').fill('E2E negative test')
    await page.getByRole('button', { name: 'Submit Request' }).click()
    await expect(page.getByText('Proposed target must be a number')).toBeVisible()
  })

  test('EMP-N04 Acknowledge and Submit stays disabled until the checkbox is ticked', async ({ page }) => {
    test.skip(!(await openMyGoals(page)), 'Goal sheet is not awaiting acknowledgement')
    await page.getByRole('button', { name: 'Acknowledge', exact: true }).click()
    const submit = page.getByRole('button', { name: 'Acknowledge & Submit' })
    await expect(submit).toBeDisabled()
    await page.getByRole('checkbox', { name: 'Acknowledge' }).check()
    await expect(submit).toBeEnabled()
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('EMP-N05 employee does not see Initiate Appraisal, Goal Approvals or My Team Goals', async ({ page }) => {
    await openMyGoals(page)
    for (const name of ['Initiate Appraisal', 'Goal Approvals', 'My Team Goals']) {
      await expect(page.getByRole('link', { name })).toHaveCount(0)
    }
  })

  test('EMP-N06 opening the HOD approvals URL directly shows no reviewable goal sheets', async ({ page }) => {
    await page.goto(`/pms/goal-approvals/${FY}`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('button', { name: 'Review' })).toHaveCount(0)
  })
})
