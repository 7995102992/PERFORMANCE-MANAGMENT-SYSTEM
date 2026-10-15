import { expect, type Locator, type Page } from '@playwright/test'

/** `YYYY-MM-DD` for today plus `days` (local time, as the app's date pickers use). */
export function isoIn(days: number): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Picks `iso` in the date picker opened from `trigger`: year, month, then the day. */
export async function pickDate(page: Page, trigger: Locator, iso: string) {
  await trigger.click()
  const pop = page.locator('[data-slot="popover-content"]').last()
  const [y, m] = iso.split('-').map(Number)
  const selects = pop.locator('select')
  await selects.nth(1).selectOption(String(y))
  await selects.nth(0).selectOption(String(m - 1))
  await pop.locator(`[data-day="${iso}"] button`).click()
}

/** The day button of `iso` in the open picker (to assert it is disabled). */
export async function openPickerDay(page: Page, trigger: Locator, iso: string): Promise<Locator> {
  await trigger.click()
  const pop = page.locator('[data-slot="popover-content"]').last()
  const [y, m] = iso.split('-').map(Number)
  const selects = pop.locator('select')
  await selects.nth(1).selectOption(String(y))
  await selects.nth(0).selectOption(String(m - 1))
  return pop.locator(`[data-day="${iso}"] button`)
}

/** The stage keys in the order the timeline table lists them. */
export const STAGES = [
  'Goal Setting',
  'Employee Acknowledgement',
  'Goal Approval',
  'Self Appraisal',
  'L1 Rating',
  'L2 Rating',
  'HR Competency Rating',
  'Calibration',
  'Approval & Publish',
] as const

/** Fills the Basic Details step with a valid period (start tomorrow, 150 days long). */
export async function fillBasics(page: Page, name = `E2E Cycle ${Date.now()}`) {
  await page.goto('/pms/cycle/new')
  await page.locator('#cycle-name').fill(name)
  await pickDate(page, page.getByRole('button', { name: 'Start date' }), isoIn(1))
  await pickDate(page, page.getByRole('button', { name: 'End date' }), isoIn(151))
}

/** Presses Next and waits for the step counter to show `n` of 4. */
export async function next(page: Page, toStep: number) {
  await page.getByRole('button', { name: /^Next/ }).click()
  await expect(page.getByText(new RegExp(`Step ${toStep} of 4`))).toBeVisible()
}

/**
 * Fills the nine stages one after another (6 days each, no overlap). `overrides` replaces the dates of a
 * stage by its row index: `{ 4: { start: isoIn(30) } }`.
 */
export async function fillTimeline(
  page: Page,
  overrides: Record<number, { start?: string; end?: string }> = {},
) {
  const rows = page.locator('tbody tr')
  for (let i = 0; i < STAGES.length; i++) {
    const startIso = overrides[i]?.start ?? isoIn(2 + i * 8)
    const endIso = overrides[i]?.end ?? isoIn(6 + i * 8)
    const buttons = rows.nth(i).getByRole('button')
    await pickDate(page, buttons.nth(0), startIso)
    await pickDate(page, rows.nth(i).getByRole('button').nth(1), endIso)
  }
}

/** Fills Applicability with every plant and every department, which is valid. */
export async function fillApplicability(page: Page) {
  await page.getByRole('button', { name: 'All Plants' }).click()
  await page.getByText('All Departments').click()
}
