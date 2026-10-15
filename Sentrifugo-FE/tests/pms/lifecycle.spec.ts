import { test, expect } from '@playwright/test'
import { FY, login } from './helpers'
import { fillApplicability, fillBasics, fillTimeline, next } from './wizard.helpers'

/**
 * Flows that CHANGE shared data and notify real users. They are off by default:
 *   E2E_PMS_SEND=1     manager sends a goal sheet to the employee
 *   E2E_PMS_PUBLISH=1  HR publishes a new cycle (notifies everyone the cycle covers)
 * Run them only against a test environment you are happy to change.
 */
test.describe.configure({ mode: 'serial' })

test.describe('Lifecycle: manager sends goals', () => {
  test.skip(!process.env.E2E_PMS_SEND, 'Set E2E_PMS_SEND=1 to run (sends a goal sheet to an employee)')

  test('LIFE-01 manager assigns the template, fills a valid sheet, validates and sends it', async ({ page }) => {
    await login(page, 'MANAGER2')
    await page.goto(`/pms/team-goal-setting/${FY}/role`)
    await page.getByText('Employees in this Role').waitFor({ timeout: 20_000 })
    const assign = page.getByRole('button', { name: 'Assign Template' })
    if (await assign.isEnabled()) await assign.click()
    await page.getByRole('button', { name: /Set Targets|Continue/ }).first().click()
    await expect(page.getByRole('heading', { name: 'Employee Target Assignment' })).toBeVisible({ timeout: 20_000 })

    const weights = page.getByRole('textbox', { name: /weight$/ })
    const n = await weights.count()
    const each = Math.floor(100 / n)
    for (let i = 0; i < n; i++) {
      await weights.nth(i).fill(String(i === n - 1 ? 100 - each * (n - 1) : each))
      await weights.nth(i).blur()
    }
    const targets = page.getByRole('textbox', { name: /target$/ })
    for (let i = 0; i < (await targets.count()); i++) await targets.nth(i).fill('10')

    await page.getByRole('button', { name: /^Validate/ }).click()
    await page.getByRole('button', { name: 'Save & Send' }).click()
    await expect(page.getByText('Goals sent to the employee for acknowledgement')).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveURL(/team-goal-setting\/\d+\/role/)
    await expect(page.getByText('Sent to Employee').first()).toBeVisible({ timeout: 20_000 })
  })
})

test.describe('Lifecycle: HR publishes a cycle', () => {
  test.skip(!process.env.E2E_PMS_PUBLISH, 'Set E2E_PMS_PUBLISH=1 to run (publishes a cycle and notifies users)')

  test('LIFE-02 HR fills all four steps and publishes; the activated page and list show it', async ({ page }) => {
    const name = `E2E Cycle ${Date.now()}`
    await login(page, 'HR')
    await fillBasics(page, name)
    await next(page, 2)
    await fillTimeline(page)
    await next(page, 3)
    await fillApplicability(page)
    await next(page, 4)
    await page.getByRole('combobox').first().click()
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: /Publish Cycle/ }).click()
    await expect(page).toHaveURL(/\/pms\/cycle\/.+\/activated/, { timeout: 30_000 })
    await page.goto('/pms/cycle')
    await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 })
  })
})
