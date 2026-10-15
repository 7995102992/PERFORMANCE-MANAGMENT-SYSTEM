import { expect, type Page } from '@playwright/test'

export type PmsRole = 'HR' | 'MANAGER' | 'MANAGER2' | 'MANAGER3' | 'EMPLOYEE' | 'HOD'

/** Financial year the PMS routes are opened for (start year, as in `/pms/my-goals/2026`). */
export const FY = process.env.E2E_PMS_FY || '2026'

/** Reads the login for a role from E2E_PMS_<ROLE>_EMAIL / _PASSWORD. */
export function credentials(role: PmsRole) {
  const email = process.env[`E2E_PMS_${role}_EMAIL`]
  const password = process.env[`E2E_PMS_${role}_PASSWORD`]
  if (!email || !password) throw new Error(`Set E2E_PMS_${role}_EMAIL and E2E_PMS_${role}_PASSWORD in .env`)
  return { email, password }
}

/** Signs in through the login form and waits until the app has left /login. */
export async function login(page: Page, role: PmsRole) {
  const { email, password } = credentials(role)
  await page.goto('/login')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /sign in|log in|login/i }).first().click()
  // An MPIN enrolment prompt may appear after login; decline it if it does.
  const later = page.getByRole('button', { name: /don.?t ask again|not now|skip/i })
  if (await later.first().isVisible({ timeout: 3000 }).catch(() => false)) await later.first().click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 })
}

/** Opens a PMS route and asserts its page heading is visible. */
export async function openPms(page: Page, path: string, heading: string | RegExp) {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 20_000 })
}

/** Fails the test on any unexpected 5xx from the PMS API while it runs. */
export function failOnServerErrors(page: Page) {
  const errors: string[] = []
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().includes('/pms')) errors.push(`${r.status()} ${r.url()}`)
  })
  return () => expect(errors, `PMS API 5xx: ${errors.join(', ')}`).toEqual([])
}
