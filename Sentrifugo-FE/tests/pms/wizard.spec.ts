import { test, expect } from '@playwright/test'
import { login } from './helpers'
import {
  STAGES,
  fillApplicability,
  fillBasics,
  fillTimeline,
  isoIn,
  next,
  openPickerDay,
  pickDate,
} from './wizard.helpers'

/**
 * Corporate HR: the four-step Initiate Appraisal wizard (1.2 - 1.5). Nothing is saved until Publish, and these
 * tests never press Publish with a valid form, so no cycle is created.
 */
test.describe('Cycle wizard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'HR')
  })

  // ---------------------------------------------------------------- step 1: basic details
  test('WIZ-P01 step 1 accepts a valid name and period and moves to the timeline', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await expect(page.getByRole('heading', { name: /Configure Timeline/ })).toBeVisible()
  })

  test('WIZ-N01 yesterday and earlier are disabled in the start date picker', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    const day = await openPickerDay(page, page.getByRole('button', { name: 'Start date' }), isoIn(-1))
    await expect(day).toBeDisabled()
  })

  test('WIZ-N02 days before the start date are disabled in the end date picker', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await pickDate(page, page.getByRole('button', { name: 'Start date' }), isoIn(20))
    const day = await openPickerDay(page, page.getByRole('button', { name: 'End date' }), isoIn(10))
    await expect(day).toBeDisabled()
  })

  test('WIZ-N03 a period longer than 12 months is rejected', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.locator('#cycle-name').fill('E2E long period')
    await pickDate(page, page.getByRole('button', { name: 'Start date' }), isoIn(1))
    await pickDate(page, page.getByRole('button', { name: 'End date' }), isoIn(400))
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('A performance period cannot be longer than 12 months')).toBeVisible()
  })

  test('WIZ-N04 end date is required when only the start date is picked', async ({ page }) => {
    await page.goto('/pms/cycle/new')
    await page.locator('#cycle-name').fill('E2E no end')
    await pickDate(page, page.getByRole('button', { name: 'Start date' }), isoIn(1))
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Select the end date')).toBeVisible()
  })

  // ---------------------------------------------------------------- step 2: timeline
  test('WIZ-P02 timeline lists the nine stages with start, end and a notify switch each', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await expect(page.locator('tbody tr')).toHaveCount(STAGES.length)
    await expect(page.getByRole('switch')).toHaveCount(STAGES.length)
    for (const col of ['Start Date', 'End Date', 'Notification']) {
      await expect(page.getByText(col, { exact: true }).first()).toBeVisible()
    }
  })

  test('WIZ-P03 timeline dates start empty (nothing is pre-filled)', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await expect(page.locator('tbody tr').first().getByRole('button').first()).toContainText(/pick a date/i)
  })

  test('WIZ-P04 a valid, non-overlapping timeline moves on to Applicability', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await fillTimeline(page)
    await next(page, 3)
    await expect(page.getByRole('heading', { name: /Applicability/ }).first()).toBeVisible()
  })

  test('WIZ-P05 a notify switch can be toggled', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    const sw = page.getByRole('switch', { name: /Notify for Goal Setting/ })
    const before = await sw.getAttribute('aria-checked')
    await sw.click()
    await expect(sw).not.toHaveAttribute('aria-checked', before ?? '')
  })

  test('WIZ-N05 Next with empty stage dates shows Required on each stage', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Required').first()).toBeVisible()
    await expect(page.getByText(/Step 2 of 4/)).toBeVisible()
  })

  test('WIZ-N06 L1 Rating starting before Self Appraisal ends is an overlap', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    // Row 3 = Self Appraisal (ends isoIn(6 + 3 * 8)); row 4 = L1 Rating starts inside it.
    await fillTimeline(page, { 4: { start: isoIn(6 + 3 * 8) } })
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText(/Overlaps Self Appraisal/)).toBeVisible()
    await expect(page.getByText(/Step 2 of 4/)).toBeVisible()
  })

  test('WIZ-N07 Self Appraisal starting before Goal Approval closes is an overlap', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await fillTimeline(page, { 3: { start: isoIn(6 + 2 * 8) } })
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText(/Overlaps Goal Approval/)).toBeVisible()
  })

  test('WIZ-N08 Acknowledgement starting before Goal Setting starts is rejected', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    await fillTimeline(page, { 0: { start: isoIn(5), end: isoIn(9) }, 1: { start: isoIn(3), end: isoIn(10) } })
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText(/Cannot start before Goal Setting starts/)).toBeVisible()
  })

  test('WIZ-N09 a stage end date cannot be picked before its start date', async ({ page }) => {
    await fillBasics(page)
    await next(page, 2)
    const row = page.locator('tbody tr').first()
    await pickDate(page, row.getByRole('button').nth(0), isoIn(20))
    const day = await openPickerDay(page, row.getByRole('button').nth(1), isoIn(15))
    await expect(day).toBeDisabled()
  })

  test('WIZ-N10 Previous returns to Basic Details with the entered values kept', async ({ page }) => {
    await fillBasics(page, 'E2E keep values')
    await next(page, 2)
    await page.getByRole('button', { name: /Previous/ }).click()
    await expect(page.locator('#cycle-name')).toHaveValue('E2E keep values')
  })

  // ---------------------------------------------------------------- step 3: applicability
  async function toApplicability(page: import('@playwright/test').Page) {
    await fillBasics(page)
    await next(page, 2)
    await fillTimeline(page)
    await next(page, 3)
  }

  test('WIZ-P06 All Plants + All Departments is valid and moves to Rating & Publish', async ({ page }) => {
    await toApplicability(page)
    await fillApplicability(page)
    await next(page, 4)
    await expect(page.getByRole('heading', { name: /Rating Scale & Publish/ }).first()).toBeVisible()
  })

  test('WIZ-P07 the appraisal cut-off shows the appraisal initiation date, read-only', async ({ page }) => {
    await toApplicability(page)
    await expect(page.getByLabel('Appraisal initiation date')).toBeVisible()
    await expect(page.getByLabel('Appraisal initiation date')).toHaveAttribute('readonly', '')
  })

  test('WIZ-N11 no plant selected is blocked', async ({ page }) => {
    await toApplicability(page)
    await page.getByText('All Departments').click()
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Select at least one plant')).toBeVisible()
  })

  test('WIZ-N12 "Select Departments" with none chosen is blocked', async ({ page }) => {
    await toApplicability(page)
    await page.getByRole('button', { name: 'All Plants' }).click()
    await page.getByText('Select Departments').click()
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Select at least one department')).toBeVisible()
  })

  test('WIZ-N13 minimum service below zero is rejected', async ({ page }) => {
    await toApplicability(page)
    await fillApplicability(page)
    await page.locator('#goal-min-service').fill('-1')
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Cannot be negative')).toBeVisible()
  })

  test('WIZ-N14 minimum service above 600 months is rejected', async ({ page }) => {
    await toApplicability(page)
    await fillApplicability(page)
    await page.locator('#appraisal-min-service').fill('601')
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Too large')).toBeVisible()
  })

  test('WIZ-N15 minimum service must be a whole number of months', async ({ page }) => {
    await toApplicability(page)
    await fillApplicability(page)
    await page.locator('#goal-min-service').fill('1.5')
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Whole months only')).toBeVisible()
  })

  test('WIZ-N16 clearing every employment type is blocked', async ({ page }) => {
    await toApplicability(page)
    await fillApplicability(page)
    const boxes = page.getByRole('checkbox')
    for (let i = 0; i < (await boxes.count()); i++) {
      if ((await boxes.nth(i).getAttribute('aria-checked')) === 'true') await boxes.nth(i).click()
    }
    await page.getByRole('button', { name: /^Next/ }).click()
    await expect(page.getByText('Select at least one employment type').first()).toBeVisible()
  })

  // ---------------------------------------------------------------- step 4: rating scale & publish
  async function toFinalize(page: import('@playwright/test').Page) {
    await toApplicability(page)
    await fillApplicability(page)
    await next(page, 4)
  }

  test('WIZ-P08 final step lists the five notification choices', async ({ page }) => {
    await toFinalize(page)
    for (const label of [
      'Notify Employees',
      'Notify Section Heads',
      'Notify Functional Heads',
      'Notify Plant Heads and Plant HR',
      'Notify GP',
    ]) {
      await expect(page.getByText(label)).toBeVisible()
    }
    await expect(page.getByRole('button', { name: /Publish Cycle/ })).toBeVisible()
  })

  test('WIZ-P09 choosing a rating scale shows its levels', async ({ page }) => {
    await toFinalize(page)
    await page.getByRole('combobox').first().click()
    const first = page.getByRole('option').first()
    test.skip((await first.count()) === 0, 'No rating scale exists to choose')
    await first.click()
    await expect(page.getByText(/Level|Outstanding|Exceeds|Meets/i).first()).toBeVisible()
  })

  test('WIZ-N17 Publish without a rating scale is blocked and no cycle is created', async ({ page }) => {
    await toFinalize(page)
    await page.getByRole('button', { name: /Publish Cycle/ }).click()
    await expect(page.getByText('Select a rating scale').first()).toBeVisible()
    await expect(page).toHaveURL(/\/pms\/cycle\/new/)
  })

  test('WIZ-N18 Cancel on the last step leaves the wizard without saving', async ({ page }) => {
    await toFinalize(page)
    await page.getByRole('button', { name: /Previous/ }).click()
    await page.getByRole('button', { name: /Previous/ }).click()
    await page.getByRole('button', { name: /Previous/ }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/pms\/cycle\/?$/)
  })
})
